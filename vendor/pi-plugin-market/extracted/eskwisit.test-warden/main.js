"use strict";

/**
 * Test Warden — PI-Desktop plugin main process.
 *
 * The orchestrating agent follows skills/test-warden.md. These tools do the deterministic work an
 * LLM does badly or expensively, so the agent's context only sees short, structured results.
 *
 * Framework-agnostic by construction: nothing here maps a framework name to a command. The
 * profile collects what the project itself declares (test scripts, Makefile target, CI steps, test
 * config globs, existing test files); the agent verifies the command once and pins it.
 *
 *   warden_profile  get: stacks (per language group) with candidate and verified test commands,
 *                   test-file patterns, helpers, example tests, CI hints. set: save a verified
 *                   command or patterns and pin the profile
 *   warden_check    plan (change): map changed files to their tests, snapshot them, write a script
 *                   that runs the tests on the old code (temporary git worktree) and the working
 *                   tree. plan (suite): map target files to their tests, suggest where a suite
 *                   goes. verdict: regressions / pre-existing failures / uncovered sources
 *   warden_gate     plan: detect any change to the protected sources (content hash against the
 *                   snapshot), check writes are in tests, write a script that proves new tests can
 *                   fail: on the old code (fix/feature), on the code with the targets emptied
 *                   (suite), or not at all (refactor: must pass on both); bug-reproducing tests
 *                   must fail 3/3. verdict: keep / reject / confirmed bugs, exact undo commands
 *   warden_lessons  a capped, deduplicated list of evidence-backed one-line project lessons
 *
 * The plugin never executes a process. Tests are run by the agent through its own Bash tool with
 * the generated scripts, which keep every old-code run in a temporary git worktree and never write
 * to the working tree. Workspace files go through the host's scoped pi.fs API (read: workspace,
 * write: .test-warden/**). node:fs is used only to install the writer sub-agent into
 * ~/.agents/subagents (the only place PI-Desktop loads sub-agents from) and remove it on unload.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// ---------- constants ----------
const DIR = ".test-warden";
const RUNS = `${DIR}/runs`;
const PROFILE = `${DIR}/profile.json`;
const LESSONS = `${DIR}/lessons.json`;
const PROFILE_V = 2;
const AGENTS = ["test-warden-writer"];
const MARKER = "Use only from the test-warden skill.";
const RUN_RE = /^\.test-warden\/runs\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KINDS = ["fix", "feature", "refactor", "suite"];
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", "target", "vendor", "venv", "__pycache__",
  "bower_components", "site-packages", "htmlcov", "tmp", "temp", "bin", "obj",
]);
const MAX_ENTRIES = 10000; // walk budget
const MAX_TEST_READS = 400; // test files read for import mapping
const HEAD_RUNS = 3; // gate: runs on the current code, for flakiness
const LESSON_CAP = 30;
const LESSON_MIN = 10;
const LESSON_MAX = 200;
const LOG_LINES = 15;
const SNAP_FILE_MAX = 512 * 1024;
const SNAP_TOTAL_MAX = 4 * 1024 * 1024;
const SNAP_FILES_MAX = 80;
const GENERIC_STEMS = new Set(["index", "__init__", "mod", "lib", "main", "init", "types", "utils", "util"]);
const DEFAULT_SETTINGS = { maxWriters: 3, writerModel: "", runTimeout: 600, guardMinutes: 120 };
const RUN_TIMEOUT_MIN = 30; // seconds, per test run of a script
const RUN_TIMEOUT_MAX = 7200;
const GUARD = `${DIR}/guard.json`; // read by extension/warden-guard.js: the sources no tool may write during a run
const GUARD_MINUTES_MAX = 1440;

const JS_EXTS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"];
const CODE_EXTS = new Set([
  ...JS_EXTS, ".py", ".go", ".rs", ".rb", ".php", ".java", ".kt", ".kts", ".scala", ".groovy", ".cs",
  ".fs", ".vb", ".swift", ".m", ".mm", ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".ex", ".exs", ".erl",
  ".dart", ".lua", ".pl", ".pm", ".r", ".jl", ".clj", ".hs", ".ml", ".zig", ".nim", ".elm", ".sh",
]);
const GROUP_ALIAS = { h: "c", cc: "cpp", cxx: "cpp", hpp: "cpp", kts: "kt", exs: "ex", pm: "pl", mm: "m" };
/** Root files that describe how a project builds or tests. Read for evidence and hashed for the cache. */
const ROOT_FILE_RE = /^(?:package\.json|deno\.jsonc?|composer\.json|go\.mod|Cargo\.toml|pyproject\.toml|setup\.cfg|tox\.ini|noxfile\.py|pytest\.ini|Makefile|GNUmakefile|Justfile|justfile|Taskfile\.ya?ml|Rakefile|Gemfile|pom\.xml|build\.gradle(?:\.kts)?|mix\.exs|pubspec\.yaml|angular\.json|project\.json|nx\.json|[^/]*\.csproj|\.?[^/]*(?:test|spec|karma|jasmine|jest|vitest|mocha|ava|playwright|cypress|wtr|phpunit|rspec)[^/]*)$/i;
const MANIFEST_GROUPS = {
  "package.json": "js", "deno.json": "js", "deno.jsonc": "js", "composer.json": "php", "go.mod": "go",
  "Cargo.toml": "rs", "pyproject.toml": "py", "setup.cfg": "py", "tox.ini": "py", "pytest.ini": "py",
  "Gemfile": "rb", "pom.xml": "java", "build.gradle": "java", "build.gradle.kts": "kt", "mix.exs": "ex",
  "pubspec.yaml": "dart",
};
const LOCK_MARKERS = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json", ".venv"];
const CI_FILES = [".gitlab-ci.yml", ".circleci/config.yml", "azure-pipelines.yml", "Jenkinsfile", "bitbucket-pipelines.yml", ".travis.yml"];
/** Naming and layout conventions for test files across ecosystems (not frameworks). */
const CONVENTIONS = [
  "**/*.test.*", "**/*.spec.*", "**/*-test.*", "**/*-spec.*", "**/*_test.*", "**/*_spec.*", "**/test_*.py",
  "**/*Test.*", "**/*Tests.*", "**/*Spec.*", "**/__tests__/**", "**/test/**", "**/tests/**", "**/spec/**",
];

let agentStatus = "not installed yet";
let registered = [];

// ---------- small helpers ----------
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
const uniq = (xs) => [...new Set(xs)];
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const posixDir = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fail(message) {
  const e = new Error(message);
  e.code = "INVALID_ARGUMENT";
  throw e;
}

/** Workspace-relative POSIX path, or "" when it is absolute, escapes the workspace or is empty. */
function relPath(p) {
  let r = str(p).trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  r = r.replace(/:\d+(:\d+)?$/, ""); // drop a :line[:col] suffix
  if (!r || r.startsWith("/") || /^[A-Za-z]:/.test(r)) return "";
  const parts = [];
  for (const seg of r.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return "";
    parts.push(seg);
  }
  return parts.join("/");
}

/** Single-quote a string for POSIX sh. */
const q = (s) => `'${str(s).replace(/'/g, `'\\''`)}'`;

function runPath(run) {
  let r = str(run).trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (r && !r.includes("/")) r = `${RUNS}/${r}`;
  if (!RUN_RE.test(r)) fail(`run must look like ${RUNS}/<id>, got ${JSON.stringify(run)}`);
  return r;
}

function newRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

function checkRef(base) {
  if (/[\s;&|`$<>'"\\]/.test(base) || base.startsWith("-")) fail(`base must be a git ref, got ${JSON.stringify(base)}`);
  return base;
}

// ---------- workspace access (pi.fs) ----------
async function readFile(p) {
  try {
    const t = await pi.fs.readText(p);
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    if (pi.fs.stat) {
      const s = await pi.fs.stat(p);
      return !!s && s.exists !== false;
    }
  } catch {
    // fall through
  }
  try {
    await pi.fs.list(p);
    return true;
  } catch {
    return (await readFile(p)) !== null;
  }
}

async function writeFile(p, content) {
  await pi.fs.writeText(p, content);
}

async function readJson(p) {
  const t = await readFile(p);
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function list(p) {
  for (const candidate of p ? [p] : [".", ""]) {
    try {
      const entries = await pi.fs.list(candidate);
      if (Array.isArray(entries)) return entries;
    } catch {
      // try the next form of the root
    }
  }
  return [];
}

/** Every file of the workspace outside skipped and hidden directories, bounded by MAX_ENTRIES. */
async function walk() {
  const files = [];
  const queue = [""];
  let seen = 0;
  let truncated = false;
  while (queue.length) {
    const dir = queue.shift();
    for (const e of await list(dir)) {
      if (++seen > MAX_ENTRIES) {
        truncated = true;
        queue.length = 0;
        break;
      }
      const name = str(e && e.name);
      if (!name) continue;
      const p = relPath(e.path || (dir ? `${dir}/${name}` : name));
      if (!p) continue;
      if (e.isDirectory) {
        if (!name.startsWith(".") && !SKIP_DIRS.has(name)) queue.push(p);
      } else files.push(p);
    }
  }
  files.sort();
  return { files, truncated };
}

async function ensureGitignore() {
  const p = `${DIR}/.gitignore`;
  const cur = await readFile(p);
  if (cur == null) await writeFile(p, "# Test Warden: run artifacts are local; profile.json and lessons.json are meant to be committed.\nruns/\nguard.json\n");
  else if (!/^guard\.json$/m.test(cur)) await writeFile(p, `${cur.replace(/\n?$/, "\n")}guard.json\n`);
}

// ---------- classification (conventions and the project's own patterns, no frameworks) ----------
const HELPER_RE = /(?:^|\/)(?:helpers?|fixtures?|mocks?|__mocks__|__fixtures__|testdata|test-?utils?|testing|support|setup[^/]*|conftest\.py)(?:\/|\.[a-z]+$|$)/i;
const TEST_DIR_RE = /(?:^|\/)(?:tests?|__tests__|spec|specs)\//i;
const CONFIG_RE = /(?:^|\/)[^/]*\.(?:config|conf)\.[cm]?[jt]s$|(?:^|\/)\.[^/]*rc(?:\.[a-z]+)?$|(?:^|\/)(?:setup|noxfile)\.py$/i;
/** A file name that marks itself as a test: foo.test.ts, foo-spec.js, foo_test.go, test_foo.py, FooTest.java. */
const MARKED_RE = /^test_.+\.py$|[._-](?:test|spec)s?\.[^.]+$|(?:Tests?|Spec)\.[^.]+$/;

function extOf(p) {
  const n = baseName(p);
  const i = n.lastIndexOf(".");
  return i > 0 ? n.slice(i).toLowerCase() : "";
}

/** The language group of a file: "js" for the JS/TS family, else the extension; null for non-code. */
function groupOf(p) {
  const e = extOf(p);
  if (JS_EXTS.includes(e)) return "js";
  if (!CODE_EXTS.has(e)) return null;
  const g = e.slice(1);
  return GROUP_ALIAS[g] || g;
}

const globCache = new Map();
/** Glob (**, *, ?, {a,b}) to an anchored regex. A pattern without "/" matches at any depth. */
function globRe(pattern) {
  let g = str(pattern).trim().replace(/^\.\//, "");
  if (!g.includes("/")) g = `**/${g}`;
  if (globCache.has(g)) return globCache.get(g);
  const lit = (s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:[^/]*/)*";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${g.slice(i + 1, end).split(",").map((x) => lit(x).replace(/\*/g, "[^/]*")).join("|")})`;
        i = end;
      }
    } else re += lit(c);
  }
  const r = new RegExp(`^${re}$`);
  globCache.set(g, r);
  return r;
}

function patternsOf(profile) {
  const ps = profile && profile.tests && Array.isArray(profile.tests.patterns) ? profile.tests.patterns : [];
  return ps.length ? ps : CONVENTIONS;
}

/** Is `p` a test file by these patterns? Unmarked matches (dir-based patterns) exclude helpers. */
function isTestFile(p, patterns = CONVENTIONS) {
  if (!groupOf(p)) return false;
  if (!patterns.some((g) => globRe(g).test(p))) return false;
  const name = baseName(p);
  if (MARKED_RE.test(name)) return true;
  return !HELPER_RE.test(p) && !/^(?:index|__init__|mod)\.[^.]+$/.test(name);
}

/** Test helpers, fixtures and shared setup: code a writer may touch that is not run alone. */
function isHelperFile(p, patterns = CONVENTIONS) {
  if (!groupOf(p) || isTestFile(p, patterns)) return false;
  if (baseName(p) === "conftest.py") return true;
  if (/(?:^|\/)(?:__mocks__|__fixtures__|testdata|fixtures?|mocks?)\//.test(p)) return true;
  return TEST_DIR_RE.test(p);
}

/** The stem a test is named after: foo.test.ts, foo-spec.js, test_foo.py, foo_test.go, FooTest.java -> foo. */
function testStem(p) {
  const n = baseName(p).replace(/\.[^.]+$/, "");
  const s = n.replace(/^test_/, "").replace(/[._-](?:test|spec)s?$/i, "").replace(/(?:Tests?|Spec)$/, "");
  return s || n;
}

/** The names a source file can be referred to by: its stem, plus its directory for generic stems. */
function sourceStems(p) {
  const stem = baseName(p).replace(/\.[^.]+$/, "");
  const out = [stem];
  if (GENERIC_STEMS.has(stem)) {
    const parent = baseName(posixDir(p));
    if (parent && parent !== ".") out.push(parent);
  }
  return out;
}

const normStem = (s) => str(s).toLowerCase().replace(/[^a-z0-9]/g, "");

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** "same" when names agree ignoring case and separators (my-component ~ my.component), "similar" for one typo. */
function nameMatch(testName, stem) {
  const a = normStem(testName);
  const b = normStem(stem);
  if (!a || !b) return null;
  if (a === b) return "same";
  if (Math.min(a.length, b.length) >= 6 && lev(a, b) <= 1) return "similar";
  return null;
}

/** Does a test file's text refer to `stem` as a module (import, require, use, include, quoted path)? */
function refersTo(text, stem, group) {
  const s = esc(stem);
  if (group === "py") return new RegExp(`\\b(?:from|import)\\s+[\\w.]*\\b${s}\\b`).test(text);
  if (new RegExp(`["'\`](?:[^"'\`\\n]*/)?${s}(?:\\.\\w+)?["'\`]`).test(text)) return true;
  if (group === "js") return false;
  return new RegExp(`^\\s*(?:import|use|using|require|require_relative|include|#include|from|alias)\\b[^\\n]*\\b${s}\\b`, "m").test(text);
}

/** Globs mentioning test/spec inside config text: the project's own test-file patterns. */
function extractGlobs(text) {
  const out = [];
  for (const m of str(text).matchAll(/(["'`])((?:(?!\1)[^\n]){1,240})\1/g)) {
    for (let tok of m[2].split(/\s+/)) {
      tok = tok.replace(/^["'`]+|["'`,]+$/g, "").replace(/^\.\//, "").replace(/^<rootDir>\//, "").replace(/^\$\{?\w+\}?\//, "");
      if (!tok.includes("*") || tok.startsWith("!") || /[<>|;&()$=]/.test(tok)) continue;
      if (!/test|spec/i.test(tok) || /node_modules|(?:^|\/)(?:dist|coverage)\//.test(tok)) continue;
      out.push(tok);
    }
  }
  return uniq(out);
}

/** The glob a test file's name follows, or null. */
function generalize(t) {
  const n = baseName(t);
  let m;
  if ((m = n.match(/([._-](?:test|spec)s?)(\.[^.]+)$/i))) return `**/*${m[1]}${m[2]}`;
  if (/^test_.+\.py$/.test(n)) return "**/test_*.py";
  if ((m = n.match(/((?:Tests?|Spec))(\.[^.]+)$/))) return `**/*${m[1]}${m[2]}`;
  return null;
}
const testRoot = (t) => {
  const m = t.match(/^(.*?(?:^|\/)(?:__tests__|tests?|specs?))\//i);
  return m ? m[1] : null;
};

function mostCommon(xs) {
  const counts = new Map();
  for (const x of xs) if (x) counts.set(x, (counts.get(x) || 0) + 1);
  let best = null;
  for (const [x, n] of counts) if (!best || n > best[1]) best = [x, n];
  return best ? best[0] : null;
}

// ---------- profile ----------
/** Root build/test files, CI files and lockfile markers; returns { texts, ci, markers, hash }. No walk. */
async function rootConfig() {
  const texts = {};
  const markers = new Set();
  for (const e of await list("")) {
    const n = str(e && e.name);
    if (!n) continue;
    if (LOCK_MARKERS.includes(n)) {
      markers.add(n);
      continue;
    }
    if (e.isDirectory || !ROOT_FILE_RE.test(n)) continue;
    const t = await readFile(n);
    if (t != null && t.length <= 200000) texts[n] = t;
  }
  const ci = {};
  for (const e of await list(".github/workflows")) {
    if (!e.isDirectory && /\.ya?ml$/.test(str(e.name))) {
      const t = await readFile(`.github/workflows/${e.name}`);
      if (t != null) ci[`.github/workflows/${e.name}`] = t;
    }
  }
  for (const f of CI_FILES) {
    const t = await readFile(f);
    if (t != null) ci[f] = t;
  }
  const sorted = (o) => Object.entries(o).sort((a, b) => a[0].localeCompare(b[0]));
  const hash = sha(JSON.stringify([sorted(texts), sorted(ci), [...markers].sort()])).slice(0, 16);
  return { texts, ci, markers, hash };
}

/** Test commands the project declares for a language group, most specific first. */
function declaredCommands(id, texts, markers) {
  const out = [];
  const evidence = [];
  const json = (n) => {
    try {
      return texts[n] ? JSON.parse(texts[n]) : null;
    } catch {
      return null;
    }
  };
  if (id === "js") {
    const pkg = json("package.json");
    const scripts = (pkg && isObj(pkg.scripts) && pkg.scripts) || {};
    const pm = markers.has("pnpm-lock.yaml") ? "pnpm" : markers.has("yarn.lock") ? "yarn" : markers.has("bun.lockb") || markers.has("bun.lock") ? "bun" : "npm";
    for (const key of Object.keys(scripts).filter((k) => /^(?:test|unit|spec)(?::[\w-]+)?$/.test(k)).sort((a, b) => a.length - b.length)) {
      if (/\bwatch\b/.test(key)) continue;
      out.push(`${pm} run ${key}`);
      evidence.push(`package.json scripts.${key}: ${str(scripts[key]).slice(0, 120)}`);
    }
    const deno = json("deno.json") || json("deno.jsonc");
    if (deno && isObj(deno.tasks) && deno.tasks.test) {
      out.push("deno task test");
      evidence.push(`deno.json tasks.test: ${str(deno.tasks.test).slice(0, 120)}`);
    }
  }
  if (id === "php") {
    const c = json("composer.json");
    if (c && isObj(c.scripts) && c.scripts.test) {
      out.push("composer test");
      evidence.push("composer.json scripts.test");
    }
  }
  if (id === "go" && texts["go.mod"]) out.push("go test ./...");
  if (id === "rs" && texts["Cargo.toml"]) out.push("cargo test");
  if (id === "py") {
    if (texts["tox.ini"]) out.push("tox");
    if (texts["noxfile.py"]) out.push("nox");
  }
  const make = texts.Makefile || texts.GNUmakefile;
  if (make && /^test\s*:/m.test(make)) out.push("make test");
  const just = texts.Justfile || texts.justfile;
  if (just && /^test\b[^\n]*:/m.test(just)) out.push("just test");
  return { candidates: uniq(out).slice(0, 4), evidence: evidence.slice(0, 4) };
}

/** CI steps that run tests: a command mentioning test/spec, or any command under a job or step named so. */
function ciHints(ci) {
  const out = [];
  for (const [file, text] of Object.entries(ci)) {
    let context = "";
    for (const raw of text.split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const named = trimmed.match(/^-?\s*name\s*:\s*(.+)$/);
      if (named) {
        context = named[1];
        continue;
      }
      if (/^-?\s*[\w .-]+:\s*$/.test(trimmed) && !/^-?\s*(?:run|script|steps|commands?)\s*:\s*$/.test(trimmed)) {
        context = trimmed;
        continue;
      }
      const line = trimmed.replace(/^-?\s*(?:run|script|command)?\s*:?\s*/, "").trim();
      if (!line || /^(?:uses|with|on|if|image|stage|needs|runs-on|env)\b/.test(trimmed.replace(/^-\s*/, ""))) continue;
      if (/\b(?:npm|pnpm|yarn|bun) (?:ci|install)\b|\bcheckout\b|\bsetup-/.test(line)) continue;
      if (!/test|spec/i.test(line) && !/test|spec/i.test(context)) continue;
      out.push(`${baseName(file)}: ${line.slice(0, 160)}`);
      if (out.length >= 6) return out;
    }
  }
  return out;
}

async function detectProfile(cfg) {
  const { texts, ci, markers, hash } = cfg;
  const { files, truncated } = await walk();
  const warnings = [];

  // test-file patterns: the project's config globs, then the patterns its existing tests follow
  const configs = Object.keys(texts).filter((n) => !MANIFEST_GROUPS[n] && !/^(?:Makefile|GNUmakefile|Justfile|justfile|Rakefile)$/.test(n));
  const configGlobs = uniq(Object.entries(texts).flatMap(([n, t]) => (n === "Makefile" || n === "GNUmakefile" ? [] : extractGlobs(t))));
  const found = files.filter((f) => isTestFile(f, configGlobs.length ? [...configGlobs, ...CONVENTIONS] : CONVENTIONS));
  const marked = found.filter((t) => MARKED_RE.test(baseName(t)));
  const markedRoots = new Set(marked.map(testRoot).filter(Boolean));
  const learned = [];
  for (const t of found) {
    const g = generalize(t);
    if (g) learned.push(g);
    else {
      const root = testRoot(t);
      if (root && !markedRoots.has(root)) learned.push(`${root}/**/*${extOf(t)}`);
    }
  }
  let patterns = uniq([...configGlobs, ...learned]).slice(0, 16);
  const learnedPatterns = patterns.length > 0;
  if (!learnedPatterns) patterns = CONVENTIONS.slice();
  const tests = files.filter((f) => isTestFile(f, patterns));
  const helpers = files.filter((f) => isHelperFile(f, patterns));

  // stacks: language groups that have tests or a manifest; else the dominant source group
  const testGroups = uniq(tests.map(groupOf));
  const manifestGroups = uniq(Object.keys(texts).map((n) => MANIFEST_GROUPS[n] || (/\.csproj$/i.test(n) ? "cs" : null)).filter(Boolean));
  let ids = uniq([...testGroups, ...manifestGroups]).filter(Boolean);
  if (!ids.length) {
    const dominant = mostCommon(files.map(groupOf).filter(Boolean));
    if (dominant) ids = [dominant];
  }
  const stacks = ids.map((id) => {
    const { candidates, evidence } = declaredCommands(id, texts, markers);
    const own = tests.filter((t) => groupOf(t) === id);
    const s = {
      id,
      suite: candidates[0] || null,
      file: id === "go" && texts["go.mod"] ? "go test ./{dir}" : null,
      verified: false,
      candidates,
      evidence,
      naming: mostCommon(own.map(generalize)) || (own.length ? mostCommon(own.map((t) => (testRoot(t) ? `${testRoot(t)}/**/*${extOf(t)}` : null))) : null),
      tests: own.length,
    };
    if (!s.suite) warnings.push(`${id}: the project declares no test command; find it (CI hints, configs, README) or ask the user`);
    return s;
  });

  const testDirs = uniq(tests.map((t) => testRoot(t) || posixDir(t))).sort().slice(0, 12);
  const separate = tests.filter((t) => TEST_DIR_RE.test(t)).length;
  const examples = [];
  const usedDirs = new Set();
  for (const t of tests) {
    if (examples.length >= 3) break;
    if (usedDirs.has(posixDir(t))) continue;
    usedDirs.add(posixDir(t));
    examples.push(t);
  }
  for (const t of tests) if (examples.length < 3 && !examples.includes(t)) examples.push(t);

  const nested = files.filter((f) => f.includes("/") && Object.keys(MANIFEST_GROUPS).includes(baseName(f)));
  if (nested.length) warnings.push(`monorepo: ${nested.length} nested manifest(s) (e.g. ${nested[0]}); the profile covers the root only`);
  if (truncated) warnings.push(`large tree: scanned the first ${MAX_ENTRIES} entries only`);
  if (!stacks.length) warnings.push("no source code found");
  if (stacks.length && !tests.length) warnings.push("no existing tests: cold start, default naming conventions, no project style to imitate");
  if (stacks.length) warnings.push("test commands are unverified: verify them and save with warden_profile {action:\"set\"} before warden_check");

  return {
    v: PROFILE_V,
    hash,
    pinned: false,
    detectedAt: now(),
    stacks,
    tests: {
      count: tests.length,
      patterns,
      learned: learnedPatterns,
      layout: !tests.length ? "none" : separate * 2 >= tests.length ? "separate" : "colocated",
      dirs: testDirs,
    },
    helpers: helpers.slice(0, 8),
    examples,
    configs: configs.slice(0, 8),
    ci: ciHints(ci),
    warnings,
  };
}

/** The cached profile: re-detected when the root config hash changed, unless pinned. */
async function ensureProfile(refresh = false) {
  const saved = await readJson(PROFILE);
  const usable = saved && saved.v === PROFILE_V && Array.isArray(saved.stacks);
  if (usable && saved.pinned === true && !refresh) return { profile: saved, cached: true };
  const cfg = await rootConfig();
  if (!refresh && usable && saved.hash === cfg.hash) return { profile: saved, cached: true };
  const profile = await detectProfile(cfg);
  await writeFile(PROFILE, JSON.stringify(profile, null, 2) + "\n");
  await ensureGitignore();
  return { profile, cached: false };
}

async function settings() {
  const s = (await pi.plugin.getSettings()) || {};
  const max = Number.isInteger(s.maxWriters) && s.maxWriters >= 1 ? Math.min(s.maxWriters, 8) : DEFAULT_SETTINGS.maxWriters;
  const t = Number(s.runTimeout);
  const runTimeout = Number.isFinite(t) && t > 0 ? Math.round(Math.min(Math.max(t, RUN_TIMEOUT_MIN), RUN_TIMEOUT_MAX)) : DEFAULT_SETTINGS.runTimeout;
  const g = Number(s.guardMinutes);
  const guardMinutes = Number.isFinite(g) && g > 0 ? Math.round(Math.min(g, GUARD_MINUTES_MAX)) : DEFAULT_SETTINGS.guardMinutes;
  return { maxWriters: max, writerModel: str(s.writerModel).trim(), runTimeout, guardMinutes };
}

// ---------- guard: the code under test is read-only (enforced by extension/warden-guard.js) ----------
async function writeGuard(run, sources, minutes) {
  const since = new Date();
  const until = new Date(since.getTime() + minutes * 60000);
  await writeFile(GUARD, JSON.stringify({ run, sources, since: since.toISOString(), until: until.toISOString() }, null, 2) + "\n");
}

/** Remove the guard; when the host cannot delete, leave an expired guard behind. */
async function clearGuard() {
  if (!(await exists(GUARD))) return false;
  try {
    if (typeof pi.fs.remove === "function") {
      await pi.fs.remove(GUARD);
      return true;
    }
  } catch {
    // fall through
  }
  const t = now();
  await writeFile(GUARD, JSON.stringify({ run: null, sources: [], since: t, until: t }) + "\n");
  return true;
}

function cmdArg(v, name) {
  const s = str(v).trim();
  if (!s || s.length > 400 || /[\r\n]/.test(s)) fail(`${name}: one line, 1-400 characters`);
  return s;
}

async function profileSet(a) {
  const { profile } = await ensureProfile(false);
  profile.tests = isObj(profile.tests) ? profile.tests : { count: 0, patterns: [], learned: false, layout: "none", dirs: [] };
  profile.examples = Array.isArray(profile.examples) ? profile.examples : [];
  profile.warnings = Array.isArray(profile.warnings) ? profile.warnings : [];
  const ids = profile.stacks.map((s) => s.id);
  let id = str(a.stack).trim();
  if (!id && profile.stacks.length === 1) id = profile.stacks[0].id;
  if (!id && (a.suite !== undefined || a.file !== undefined || a.verified !== undefined)) fail(`stack: one of ${ids.join(", ") || "(none yet: give a language group such as js, py, go)"}`);
  if (id) {
    if (!/^[a-z0-9]{1,12}$/.test(id)) fail("stack: a language group id such as js, py, go, rs, java");
    let st = profile.stacks.find((s) => s.id === id);
    if (!st) {
      st = { id, suite: null, file: null, verified: false, candidates: [], evidence: [], naming: null, tests: 0 };
      profile.stacks.push(st);
    }
    const before = `${st.suite}\u0000${st.file}`;
    if (a.suite !== undefined) st.suite = a.suite === null || a.suite === "" ? null : cmdArg(a.suite, "suite");
    if (a.file !== undefined) {
      if (a.file === null || a.file === "") st.file = null;
      else {
        const f = cmdArg(a.file, "file");
        if (!/\{(?:file|dir)\}/.test(f)) fail("file: the per-file command must contain {file} (or {dir} for per-directory runners)");
        st.file = f;
      }
    }
    if (a.verified !== undefined) st.verified = a.verified === true;
    else if (`${st.suite}\u0000${st.file}` !== before) st.verified = false; // a changed command must be verified again
    if (st.verified && !st.suite && !st.file) fail("a verified stack needs a suite or a file command");
  }
  if (a.patterns !== undefined) {
    const ps = uniq(strList(a.patterns).map((p) => p.replace(/^\.\//, "")).filter((p) => !p.startsWith("!")));
    if (!ps.length) fail("patterns: give at least one glob, e.g. **/*.spec.ts");
    profile.tests.patterns = ps;
    profile.tests.learned = true;
    const { files } = await walk();
    const tests = files.filter((f) => isTestFile(f, ps));
    profile.tests.count = tests.length;
    if (!tests.some((t) => profile.examples.includes(t))) profile.examples = tests.slice(0, 3);
  }
  profile.pinned = true;
  if (profile.stacks.every((s) => s.verified)) profile.warnings = profile.warnings.filter((w) => !/unverified/.test(w));
  profile.warnings = profile.warnings.filter((w) => !/declares no test command/.test(w) || profile.stacks.some((s) => w.startsWith(`${s.id}:`) && !s.suite && !s.file));
  await writeFile(PROFILE, JSON.stringify(profile, null, 2) + "\n");
  await ensureGitignore();
  return { saved: PROFILE, pinned: true, profile };
}

async function wardenProfile(args) {
  const a = isObj(args) ? args : {};
  if ((a.action || "get") === "set") return profileSet(a);
  if ((a.action || "get") !== "get") fail('action must be "get" or "set"');
  const { profile, cached } = await ensureProfile(a.refresh === true);
  return { cached, path: PROFILE, profile, settings: await settings(), lessons: (await loadLessons(true)).length };
}

// ---------- units and scripts ----------
function stackFor(profile, p) {
  const g = groupOf(p);
  return (profile.stacks || []).find((s) => s.id === g) || null;
}

/**
 * The runnable unit of a test file: { key, path, cmd, stack }. `path` must exist for the unit to
 * run; `key` names it in results. Per file with {file}, per directory with {dir}, else the suite.
 */
function unitOf(profile, testFile) {
  const s = stackFor(profile, testFile);
  if (!s) return null;
  const dir = posixDir(testFile);
  if (s.file && s.file.includes("{file}")) {
    return { key: testFile, path: testFile, cmd: s.file.replace(/\{file\}/g, () => q(testFile)).replace(/\{dir\}/g, () => q(dir)), stack: s.id };
  }
  if (s.file && s.file.includes("{dir}")) {
    return { key: dir, path: dir, cmd: s.file.replace(/\.\/\{dir\}/g, () => q(dir === "." ? "./" : `./${dir}`)).replace(/\{dir\}/g, () => q(dir)), stack: s.id };
  }
  if (s.suite) return { key: `<${s.id} suite>`, path: ".", cmd: s.suite, stack: s.id };
  return null;
}

function unitsOf(profile, testFiles, role) {
  const byKey = new Map();
  for (const t of testFiles) {
    const u = unitOf(profile, t);
    if (!u) continue;
    const id = `${role || ""}|${u.key}`;
    if (!byKey.has(id)) byKey.set(id, { ...u, files: [], ...(role ? { role } : {}) });
    byKey.get(id).files.push(t);
  }
  return [...byKey.values()];
}

/** Fail unless every language group in `files` has a verified command. */
function requireVerified(profile, files) {
  const groups = uniq(files.map(groupOf).filter(Boolean));
  const bad = groups.filter((g) => {
    const s = (profile.stacks || []).find((x) => x.id === g);
    return !s || !s.verified || (!s.suite && !s.file);
  });
  if (bad.length) {
    fail(`no verified test command for ${bad.join(", ")}: verify it first, then warden_profile {action:"set", stack, suite, file, verified:true} (skill step 1)`);
  }
}

/**
 * A bash script that runs `units` on the current code `headRuns` times and, when `base` is set,
 * once more in a temporary git worktree of `base` (side `oldSide`): after copying `copies` into it,
 * or, with `overlay`, every uncommitted file of the working tree, and then emptying `sabotage`.
 * With `exclude`, non-bug units run their current-code runs in a second worktree: the working tree
 * without the excluded files (used when one suite-level command would otherwise run the bug
 * reproductions too). Units with role "bug" run on the current code only. Results go to
 * <run>/<name>.tsv as `side<TAB>n<TAB>rc|absent|timeout<TAB>key`, failure output to <run>/logs/.
 * Each run is killed (its whole process group) after `timeout` seconds and recorded as `timeout`.
 * Package managers must not install anything before a run: pnpm 10+ does by default, which hangs
 * offline and, in a worktree whose node_modules is a link, fails the run for a reason unrelated to
 * the test (a false "fails on the old code").
 * The working tree is only read.
 */
function buildScript({ run, name, base = null, overlay = false, sabotage = [], copies = [], exclude = [], units, headRuns = 1, oldSide = "base", title, timeout = DEFAULT_SETTINGS.runTimeout }) {
  const repo = !!base || exclude.length > 0;
  const L = [];
  L.push("#!/usr/bin/env bash");
  L.push(`# Test Warden ${title}. Generated; safe to delete.`);
  L.push(repo ? "# Old or altered code runs in temporary git worktrees; the working tree is only read." : "# Runs the tests on the current code; the working tree is only read.");
  L.push("set -u");
  L.push('WS="$(cd "$(dirname "$0")/../../.." && pwd)" || exit 2');
  L.push('cd "$WS" || exit 2');
  L.push(`OUT="$WS/${run}"`);
  L.push(`TSV="$OUT/${name}.tsv"`);
  L.push('mkdir -p "$OUT/logs" && : > "$TSV"');
  L.push("export CI=1 NO_COLOR=1 FORCE_COLOR=0; unset NODE_TEST_CONTEXT");
  L.push("# a test run never installs packages (pnpm verifies, and installs, before `pnpm <script>`)");
  L.push("export pnpm_config_verify_deps_before_run=false npm_config_verify_deps_before_run=false");
  L.push(`LIMIT=${Math.max(1, Math.round(Number(timeout) || DEFAULT_SETTINGS.runTimeout))} # seconds per test run`);
  L.push("PID= DOG=");
  L.push("trap 'kill -TERM -$PID -$DOG 2>/dev/null; exit 143' TERM INT HUP");
  if (repo) {
    L.push('REPO="$(git -C "$WS" rev-parse --show-toplevel 2>/dev/null)" || { echo "test-warden: not a git repository" >&2; exit 2; }');
    L.push('PREFIX="$(git -C "$WS" rev-parse --show-prefix)"');
    L.push('TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-warden.XXXXXX")" || exit 2');
    L.push('cleanup() { cd "$WS"; for t in "$TMP/tree" "$TMP/head"; do [ -d "$t" ] && git -C "$REPO" worktree remove --force "$t" >/dev/null 2>&1; done; rm -rf "$TMP"; git -C "$REPO" worktree prune >/dev/null 2>&1; }');
    L.push("trap cleanup EXIT");
    L.push('links() { for d in node_modules .venv venv vendor; do [ -e "$WS/$d" ] && [ ! -e "$1/$d" ] && ln -s "$WS/$d" "$1/$d"; done; return 0; }');
    L.push("overlay() { # copy every uncommitted change of the working tree into worktree $1");
    L.push('  { git -C "$REPO" diff --no-renames --name-only -z HEAD 2>/dev/null; git -C "$REPO" ls-files -o --exclude-standard -z; } |');
    L.push("    while IFS= read -r -d '' f; do");
    L.push('      case "$f" in "${PREFIX}.test-warden/"*) continue ;; esac');
    L.push('      if [ -e "$REPO/$f" ]; then mkdir -p "$1/$(dirname "$f")" && cp -p "$REPO/$f" "$1/$f"; else rm -f "$1/$f"; fi');
    L.push("    done");
    L.push("}");
  }
  if (base) {
    L.push(`BASE=${q(base)}`);
    L.push('WT="$TMP/tree"; WTW="$WT/$PREFIX"');
    L.push('git -C "$REPO" worktree add --detach --quiet "$WT" "$BASE" >/dev/null 2>&1 || { echo "test-warden: cannot check out $BASE in a worktree" >&2; exit 2; }');
    L.push('links "$WTW"');
    if (overlay) L.push('overlay "$WT"');
    for (const c of copies) L.push(`mkdir -p "$WTW/$(dirname ${q(c)})" && cp -p "$WS/"${q(c)} "$WTW/"${q(c)}`);
    for (const x of exclude) L.push(`rm -f "$WTW/"${q(x)}`);
    for (const t of sabotage) L.push(`: > "$WTW/"${q(t)}`);
  }
  if (exclude.length) {
    L.push("# the working tree without the bug reproductions, for the other units' current-code runs");
    L.push('HT="$TMP/head"; HTW="$HT/$PREFIX"');
    L.push('git -C "$REPO" worktree add --detach --quiet "$HT" HEAD >/dev/null 2>&1 || { echo "test-warden: cannot check out HEAD in a worktree" >&2; exit 2; }');
    L.push('links "$HTW"');
    L.push('overlay "$HT"');
    for (const x of exclude) L.push(`rm -f "$HTW/"${q(x)}`);
  }
  L.push("run() { # side dir path key n cmd");
  L.push(`  local side="$1" dir="$2" path="$3" key="$4" n="$5" cmd="$6" rc log="$OUT/logs/${name}-$1-$5.log" mark="$OUT/logs/.timeout"`);
  L.push('  if [ ! -e "$dir/$path" ]; then printf \'%s\\t%s\\tabsent\\t%s\\n\' "$side" "$n" "$key" >> "$TSV"; return 0; fi');
  L.push('  echo "test-warden: $side $n $key"');
  L.push('  rm -f "$mark"');
  L.push("  set -m # own process group, so a timeout stops the whole tree");
  L.push('  ( cd "$dir" && export PYTHONPATH="$dir/src:$dir${PYTHONPATH:+:$PYTHONPATH}" && eval "$cmd" ) > "$log" 2>&1 < /dev/null &');
  L.push("  PID=$!");
  L.push('  ( sleep "$LIMIT"; : > "$mark"; kill -TERM -"$PID"; sleep 5; kill -KILL -"$PID" ) > /dev/null 2>&1 &');
  L.push("  DOG=$!");
  L.push("  set +m");
  L.push('  { wait "$PID"; rc=$?; kill -TERM -"$DOG"; wait "$DOG"; } 2> /dev/null');
  L.push("  PID= DOG=");
  L.push('  if [ -e "$mark" ]; then rc=timeout; rm -f "$mark"; echo "test-warden: $side $n timed out after ${LIMIT}s" >> "$log"; fi');
  L.push('  printf \'%s\\t%s\\t%s\\t%s\\n\' "$side" "$n" "$rc" "$key" >> "$TSV"');
  L.push('  echo "test-warden: $side $n -> $rc"');
  L.push('  [ "$rc" = 0 ] && rm -f "$log"');
  L.push("  return 0");
  L.push("}");
  units.forEach((u, i) => {
    const n = i + 1;
    const args = `${q(u.path)} ${q(u.key)} ${n} ${q(u.cmd)}`;
    const headDir = exclude.length && u.role !== "bug" ? '"$HTW"' : '"$WS"';
    if (base && u.role !== "bug") L.push(`run ${oldSide} "$WTW" ${args}`);
    for (let h = 1; h <= headRuns; h++) L.push(`run ${headRuns > 1 ? `head${h}` : "head"} ${headDir} ${args}`);
  });
  L.push(`echo "test-warden: ${units.length} unit(s) done -> ${run}/${name}.tsv"`);
  return L.join("\n") + "\n";
}

/** Parse a results tsv into Map(n -> { key, sides: { side: rc|"absent"|"timeout" } }). */
function parseTsv(text) {
  const units = new Map();
  for (const line of str(text).split("\n")) {
    const [side, n, rc, ...rest] = line.split("\t");
    const key = rest.join("\t");
    if (!side || !key || !/^\d+$/.test(n || "")) continue;
    if (!units.has(n)) units.set(n, { key, sides: {} });
    units.get(n).sides[side] = rc === "absent" || rc === "timeout" ? rc : Number(rc);
  }
  return { units };
}

/** Keys of the units with at least one run killed by the per-run timeout. */
function timedOutKeys(units) {
  return uniq([...units.values()].filter((u) => Object.values(u.sides).includes("timeout")).map((u) => u.key));
}

const TIMEOUT_NOTE = "timedOut: a run exceeded the runTimeout setting and was killed (its log in <run>/logs/ ends with \"timed out\"); a run that hangs usually waits on the network or an install step in the test command: fix that, or raise the setting for a slow suite, then re-run";

/** The interesting lines of a failure log: assertion/error lines first, else the tail. */
function excerpt(text) {
  const lines = str(text).split("\n").map((l) => l.replace(/\s+$/, "")).filter(Boolean);
  const hit = lines.filter((l) => /(fail|error|assert|expected|received|actual|✖|✗|not ok|panic|traceback|exception|\.\w{1,5}:\d+)/i.test(l));
  const pick = (hit.length ? hit : lines).slice(-LOG_LINES);
  return pick.map((l) => (l.length > 200 ? `${l.slice(0, 197)}...` : l)).join("\n");
}

async function logExcerpt(run, name, side, n) {
  const t = await readFile(`${run}/logs/${name}-${side}-${n}.log`);
  return t == null ? "" : excerpt(t);
}

// ---------- snapshots: exact pre-run copies of the files a run must not lose ----------
async function snapshotFiles(run, paths) {
  const index = {};
  let total = 0;
  for (const p of uniq(paths).slice(0, SNAP_FILES_MAX)) {
    const text = await readFile(p);
    if (text == null) {
      index[p] = (await exists(p)) ? { skipped: true, unreadable: true } : { absent: true };
      continue;
    }
    if (text.length > SNAP_FILE_MAX || total + text.length > SNAP_TOTAL_MAX) {
      index[p] = { skipped: true, sha: sha(text) };
      continue;
    }
    total += text.length;
    await writeFile(`${run}/snapshot/${p}`, text);
    index[p] = { sha: sha(text) };
  }
  await writeFile(`${run}/snapshot.json`, JSON.stringify(index, null, 2) + "\n");
  return index;
}

/**
 * Commands that undo changes to `paths`. A snapshotted file is copied back from its snapshot (exact,
 * keeps the user's uncommitted work; nothing happens if the snapshot is missing); a file that did not
 * exist is removed. A file with no usable snapshot is removed only if git does not track it; a
 * tracked one is never touched and is reported for review by hand.
 */
function undoCommand(paths, snap = {}, run = "") {
  return paths
    .map((p) => {
      const s = snap[p];
      if (s && s.absent) return `rm -f -- ${q(p)}`;
      if (s && !s.skipped && run) {
        const from = q(`${run}/snapshot/${p}`);
        return `if [ -f ${from} ]; then cp -- ${from} ${q(p)}; else printf 'test-warden: snapshot missing, not restored: %s\\n' ${q(p)} >&2; fi`;
      }
      return `if git ls-files --error-unmatch -- ${q(p)} >/dev/null 2>&1; then printf 'test-warden: no snapshot, review by hand: %s\\n' ${q(p)} >&2; else rm -f -- ${q(p)}; fi`;
    })
    .join("; ");
}

/** Paths whose undo cannot be exact (no usable snapshot): the agent reviews them if git tracks them. */
const unsnapshotted = (paths, snap) => paths.filter((p) => !snap[p] || (snap[p].skipped && !snap[p].absent));

// ---------- warden_check ----------
async function testIndex(profile) {
  const { files } = await walk();
  const patterns = patternsOf(profile);
  const groups = new Set((profile.stacks || []).map((s) => s.id));
  return {
    files: new Set(files),
    patterns,
    groups,
    tests: files.filter((f) => groups.has(groupOf(f)) && isTestFile(f, patterns)),
    helpers: files.filter((f) => groups.has(groupOf(f)) && isHelperFile(f, patterns)),
  };
}

/** Where a new suite for `target` goes, following the project's naming; never a path in `taken`. */
function suggestPaths(profile, target, patterns, taken = new Set()) {
  const st = stackFor(profile, target);
  const stem = baseName(target).replace(/\.[^.]+$/, "");
  const ext = extOf(target);
  const naming = (st && st.naming) || patterns.find((p) => /^\*\*\/\*[._-](?:test|spec)\./.test(p)) || "**/*.test.*";
  const layoutSeparate = profile.tests && profile.tests.layout === "separate";
  const testDir = profile.tests && Array.isArray(profile.tests.dirs) && profile.tests.dirs.find((d) => TEST_DIR_RE.test(`${d}/`));
  const join = (d, n) => (d === "." ? n : `${d}/${n}`);
  const named = (st_) => {
    let m;
    if ((m = naming.match(/^\*\*\/\*(.+)$/))) return { dir: layoutSeparate && testDir ? testDir : posixDir(target), name: st_ + m[1].replace(/\.\*$/, ext) };
    if (naming === "**/test_*.py") return { dir: layoutSeparate && testDir ? testDir : posixDir(target), name: `test_${st_}.py` };
    if ((m = naming.match(/^(.+)\/\*\*\/\*(\.[^/]+)$/))) return { dir: m[1], name: `${st_}${m[2]}` };
    return { dir: posixDir(target), name: `${st_}.test${ext}` };
  };
  const parent = baseName(posixDir(target));
  const stems = uniq([stem, parent && parent !== "." ? `${parent}-${stem}` : null, `${stem}-2`].filter(Boolean));
  const tries = stems.map((s_) => join(named(s_).dir, named(s_).name));
  for (const s_ of stems) {
    const n = named(s_);
    for (const alt of [`${s_}.test${ext}`, `${s_}_test${ext}`, `test_${s_}${ext}`, `${s_}Test${ext}`]) tries.push(join(n.dir, alt), join(posixDir(target), alt));
  }
  const own = tries.find((t) => !taken.has(t) && t !== target && isTestFile(t, patterns)) || null;
  return { own, bugs: own ? variantPath(own, "bugs", patterns) : null };
}

/** A sibling of test file `own` with `tag` in its name that still matches the test patterns. */
function variantPath(own, tag, patterns) {
  const dir = posixDir(own);
  const n = baseName(own);
  const tries = [];
  let m;
  if ((m = n.match(/^(.*?)([._-](?:test|spec)s?\.[^.]+)$/i))) tries.push(`${m[1]}.${tag}${m[2]}`, `${m[1]}-${tag}${m[2]}`, `${m[1]}_${tag}${m[2]}`);
  if ((m = n.match(/^test_(.+)(\.py)$/))) tries.push(`test_${m[1]}_${tag}${m[2]}`);
  if ((m = n.match(/^(.*?)((?:Tests?|Spec)\.[^.]+)$/))) tries.push(`${m[1]}${tag[0].toUpperCase()}${tag.slice(1)}${m[2]}`);
  const e = extOf(n);
  tries.push(`${n.slice(0, n.length - e.length)}.${tag}${e}`, `${tag}_${n}`);
  for (const t of tries) {
    const p = dir === "." ? t : `${dir}/${t}`;
    if (p !== own && isTestFile(p, patterns)) return p;
  }
  return null;
}

async function checkPlan(a) {
  const { profile } = await ensureProfile(false);
  const { runTimeout, guardMinutes } = await settings();
  const mode = a.mode === "suite" ? "suite" : "change";
  const base = mode === "suite" ? "HEAD" : checkRef(str(a.base).trim() || "HEAD");
  const changed = uniq(strList(a.changed).map(relPath).filter((p) => p && !p.startsWith(`${DIR}/`)));
  if (!changed.length) return { nothing: true, reason: mode === "suite" ? "no target files given" : "no changed files given" };

  const idx = await testIndex(profile);
  const changedTests = [];
  const helpers = [];
  const uncoveredHelpers = [];
  const sources = [];
  const ignored = [];
  for (const p of changed) {
    const g = groupOf(p);
    if (!g || !idx.groups.has(g) || CONFIG_RE.test(p) || p.endsWith(".d.ts")) ignored.push(p);
    else if (isTestFile(p, idx.patterns)) changedTests.push(p);
    else if (isHelperFile(p, idx.patterns)) helpers.push(p);
    else sources.push(p);
  }
  if (mode === "suite") {
    if (changedTests.length || helpers.length) fail(`suite targets must be source files, not tests or helpers: ${[...changedTests, ...helpers].join(", ")}`);
    if (!sources.length) fail(`no source file among the targets (${ignored.join(", ")}): the profile knows the language groups ${[...idx.groups].join(", ") || "(none)"}`);
    const missing = [];
    for (const s of sources) if (!idx.files.has(s) && !(await exists(s))) missing.push(s);
    if (missing.length) fail(`target(s) not found: ${missing.join(", ")}`);
  }
  if (!sources.length && !changedTests.length && !helpers.length) return { nothing: true, reason: "no source or test changes", ignored };
  requireVerified(profile, [...sources, ...changedTests, ...helpers]);

  const texts = new Map();
  let reads = 0;
  const textOf = async (t) => {
    if (texts.has(t)) return texts.get(t);
    if (reads >= MAX_TEST_READS) return "";
    reads++;
    const text = str(await readFile(t));
    texts.set(t, text);
    return text;
  };
  const similar = [];
  /** Tests of `group` that refer to one of `stems`: same name (separators ignored), one-typo name, or import. */
  const referring = async (group, stems, owner) => {
    const candidates = idx.tests.filter((t) => groupOf(t) === group);
    const found = [];
    for (const t of candidates) {
      const how = stems.map((s) => nameMatch(testStem(t), s)).find(Boolean);
      if (how) {
        found.push(t);
        if (how === "similar" && owner) similar.push(`${owner} ~ ${t}`);
      }
    }
    for (const t of candidates) {
      if (found.includes(t)) continue;
      const text = await textOf(t);
      if (stems.some((s) => refersTo(text, s, group))) found.push(t);
    }
    return found;
  };

  // a changed helper re-runs the tests that use it; unreferenced helpers re-run their test directory
  for (const h of helpers) {
    const g = groupOf(h);
    let users = baseName(h) === "conftest.py" ? [] : await referring(g, sourceStems(h));
    if (!users.length) {
      const dir = testRoot(h) || posixDir(h);
      const root = dir === "." ? "" : `${dir}/`;
      users = idx.tests.filter((t) => groupOf(t) === g && t.startsWith(root));
    }
    if (users.length) changedTests.push(...users);
    else uncoveredHelpers.push(h);
  }

  // map sources to tests: per-directory runners by directory, else by name, import, or one helper hop
  const map = [];
  const uncovered = [...uncoveredHelpers];
  for (const src of sources) {
    const g = groupOf(src);
    const st = stackFor(profile, src);
    const stems = sourceStems(src);
    let found;
    if (st && st.file && st.file.includes("{dir}") && !st.file.includes("{file}")) {
      found = idx.tests.filter((t) => groupOf(t) === g && posixDir(t) === posixDir(src));
    } else {
      found = await referring(g, stems, src);
      for (const h of idx.helpers.filter((x) => groupOf(x) === g)) {
        const text = await textOf(h);
        if (!stems.some((s) => refersTo(text, s, g))) continue;
        for (const t of await referring(g, sourceStems(h))) if (!found.includes(t)) found.push(t);
      }
    }
    if (found.length) map.push({ file: src, tests: found.slice(0, 12) });
    else uncovered.push(src);
  }
  const testFiles = uniq([...changedTests, ...map.flatMap((m) => m.tests)]);
  const units = unitsOf(profile, testFiles);

  // where new tests go: an existing same-name test is extended, else a new file by the project's naming
  const suggest = [];
  const taken = new Set(idx.tests);
  for (const src of mode === "suite" ? sources : uncovered.filter((u) => sources.includes(u))) {
    const existing = (map.find((m) => m.file === src) || { tests: [] }).tests.find((t) => sourceStems(src).some((s) => nameMatch(testStem(t), s)));
    let own = existing || suggestPaths(profile, src, idx.patterns, taken).own;
    if (own && !existing) taken.add(own);
    const bugs = own ? variantPath(own, "bugs", idx.patterns) : null;
    if (bugs) taken.add(bugs);
    suggest.push({ target: src, own, existing: !!existing, bugs });
  }

  const id = newRunId();
  const run = `${RUNS}/${id}`;
  await ensureGitignore();
  // exact copies of everything the run must be able to restore: the sources, and the tests a writer may edit
  const snap = await snapshotFiles(run, [...sources, ...changedTests, ...helpers, ...suggest.filter((s) => s.existing).map((s) => s.own), ...map.flatMap((m) => m.tests)]);
  const skipped = Object.entries(snap).filter(([, s]) => s.skipped).map(([p]) => p);
  await writeFile(`${run}/plan.json`, JSON.stringify({ mode, base, changed, sources, changedTests, helpers, map, uncovered, suggest, units, at: now() }, null, 2) + "\n");
  await writeGuard(run, sources, guardMinutes);

  const out = { run, mode, base: mode === "suite" ? undefined : base, units: units.length, map: map.map((m) => `${m.file} <- ${m.tests.join(", ")}`), uncovered };
  if (similar.length) out.similar = similar;
  if (suggest.length) out.suggest = suggest;
  if (ignored.length) out.ignored = ignored;
  if (skipped.length) out.warning = `too large to snapshot, changes cannot be undone exactly: ${skipped.join(", ")}`;
  if (!units.length) {
    out.command = null;
    out.note = mode === "suite" ? "no existing test reaches the targets: write the suite (skill step 3)" : "no existing test covers the change: nothing to run; the gaps are in uncovered";
    return out;
  }
  const script = mode === "suite"
    ? buildScript({ run, name: "check", units, timeout: runTimeout, title: "check (suite): the targets' existing tests on the current code" })
    : buildScript({ run, name: "check", base, units, timeout: runTimeout, title: "check: base vs working tree" });
  await writeFile(`${run}/check.sh`, script);
  out.command = `bash ${run}/check.sh`;
  out.next = "run the command with Bash, then warden_check {action:\"verdict\", run}";
  return out;
}

async function checkVerdict(a) {
  const run = runPath(a.run);
  const plan = await readJson(`${run}/plan.json`);
  if (!plan) fail(`${run}/plan.json is missing: call warden_check {action:"plan"} first`);
  const tsv = await readFile(`${run}/check.tsv`);
  if (tsv == null || !tsv.trim()) fail(`${run}/check.tsv is missing or empty: run bash ${run}/check.sh first`);
  const { units } = parseTsv(tsv);
  const incomplete = (plan.units || []).filter((_, i) => !units.has(String(i + 1))).map((u) => u.key);
  let verdict;
  if (plan.mode === "suite") {
    const out = { passed: 0, failing: [] };
    for (const [n, u] of units) {
      const h = u.sides.head;
      if (h === undefined || h === "timeout") incomplete.push(u.key);
      else if (h === 0) out.passed++;
      else if (h !== "absent") out.failing.push({ test: u.key, log: await logExcerpt(run, "check", "head", n) });
    }
    verdict = { run, mode: "suite", ...out, uncovered: plan.uncovered || [], suggest: plan.suggest || [] };
    if (out.failing.length) verdict.note = "failing existing tests of the targets: report them (possible bugs); never edit the targets";
  } else {
    const out = { regressions: [], newFailing: [], stillFailing: [], fixed: [], removed: [], passed: 0 };
    for (const [n, u] of units) {
      const b = u.sides.base;
      const h = u.sides.head;
      if (b === undefined || h === undefined || b === "timeout" || h === "timeout") incomplete.push(u.key);
      else if (h === "absent") out.removed.push(u.key);
      else if (h === 0) {
        out.passed++;
        if (typeof b === "number" && b !== 0) out.fixed.push(u.key);
      } else if (b === 0) out.regressions.push({ test: u.key, log: await logExcerpt(run, "check", "head", n) });
      else if (b === "absent") out.newFailing.push({ test: u.key, log: await logExcerpt(run, "check", "head", n) });
      else out.stillFailing.push(u.key);
    }
    verdict = { run, mode: "change", base: plan.base, ...out, uncovered: plan.uncovered || [] };
    if (plan.suggest && plan.suggest.length) verdict.suggest = plan.suggest;
    for (const k of ["fixed", "removed", "stillFailing", "newFailing"]) if (!verdict[k].length) delete verdict[k];
  }
  const timedOut = timedOutKeys(units);
  if (timedOut.length) verdict.timedOut = timedOut;
  if (incomplete.length) {
    verdict.incomplete = uniq(incomplete);
    verdict.note = `${verdict.note ? `${verdict.note}. ` : ""}incomplete units did not finish: the script was interrupted or timed out; re-run it`;
    if (timedOut.length) verdict.note += `. ${TIMEOUT_NOTE}`;
  }
  await writeFile(`${run}/verdict.json`, JSON.stringify(verdict, null, 2) + "\n");
  return verdict;
}

async function wardenCheck(args) {
  const a = isObj(args) ? args : {};
  const action = a.action || "plan";
  if (action === "plan") return checkPlan(a);
  if (action === "verdict") return checkVerdict(a);
  if (action === "release") return { released: await clearGuard(), note: "the code under test is writable again; use this only when the user explicitly asked for the fix" };
  fail('action must be "plan", "verdict" or "release"');
}

// ---------- warden_gate ----------
async function gatePlan(a) {
  const run = runPath(a.run);
  const plan = await readJson(`${run}/plan.json`);
  if (!plan) fail(`${run}/plan.json is missing: the gate needs the run of a warden_check plan (it holds the snapshot of the protected files)`);
  const snap = (await readJson(`${run}/snapshot.json`)) || {};
  const { profile } = await ensureProfile(false);
  const { runTimeout } = await settings();
  const patterns = patternsOf(profile);
  const kind = str(a.kind).trim() || (plan.mode === "suite" ? "suite" : "");
  if (!KINDS.includes(kind)) fail(`kind must be one of ${KINDS.join(", ")}`);
  const targets = uniq(strList(plan.sources));
  if (kind === "suite" && !targets.length) fail("kind suite needs a run whose plan has source targets");
  const base = kind === "suite" ? "HEAD" : checkRef(str(a.base).trim() || plan.base || "HEAD");
  const tests = uniq(strList(a.tests).map(relPath).filter(Boolean));
  const bugs = uniq(strList(a.bugs).map(relPath).filter(Boolean)).filter((b) => !tests.includes(b));
  const written = uniq([...strList(a.written).map(relPath).filter(Boolean), ...tests, ...bugs]);
  if (!tests.length && !bugs.length) fail("tests: list the test files the writers created or changed (bug reproductions go in bugs)");
  const missing = [];
  for (const t of [...tests, ...bugs]) if (!(await exists(t))) missing.push(t);
  if (missing.length) fail(`test file(s) not found: ${missing.join(", ")}`);
  const nonTests = [...tests, ...bugs].filter((t) => !isTestFile(t, patterns));
  if (nonTests.length) fail(`not test files by this project's patterns (${patterns.slice(0, 4).join(", ")}): ${nonTests.join(", ")}`);
  requireVerified(profile, [...tests, ...bugs]);

  // 1. the protected sources must be exactly as they were when the run started, whoever reported what
  const changedProtected = [];
  const unchecked = [];
  for (const p of targets) {
    const s = snap[p];
    if (!s) {
      unchecked.push(p);
      continue;
    }
    const cur = await readFile(p);
    const now_ = cur == null ? "absent" : sha(cur);
    const was = s.absent ? "absent" : s.sha;
    if (now_ !== was) {
      if (s.skipped) unchecked.push(p);
      else changedProtected.push(p);
    }
  }
  // 2. every other reported write must be a test or a helper
  const inScope = (p) => isTestFile(p, patterns) || isHelperFile(p, patterns);
  const violations = written.filter((p) => !inScope(p) && !changedProtected.includes(p) && !targets.includes(p));
  const manual = [...violations.filter((p) => (snap[p] && snap[p].skipped) || ((plan.changed || []).includes(p) && !snap[p])), ...unchecked];
  const restorable = violations.filter((p) => !manual.includes(p));

  const testUnits = unitsOf(profile, tests);
  const bugUnits = unitsOf(profile, bugs, "bug");
  const units = [...testUnits, ...bugUnits];
  // a test unit that would also run a bug reproduction (suite or directory runs) runs without the bug files
  const covers = (u, b) => u.path === "." || b === u.path || b.startsWith(`${u.path}/`);
  const exclude = bugs.filter((b) => testUnits.some((u) => covers(u, b)));
  const copies = written.filter(inScope).filter((c) => !exclude.includes(c));
  await ensureGitignore();
  await writeFile(`${run}/gate.json`, JSON.stringify({ base, kind, tests, bugs, written, targets, exclude, headRuns: HEAD_RUNS, units, at: now() }, null, 2) + "\n");
  const script = kind === "suite"
    ? buildScript({ run, name: "gate", base: "HEAD", overlay: true, sabotage: targets, exclude, units, headRuns: HEAD_RUNS, oldSide: "sabotage", timeout: runTimeout, title: `gate (suite): ${HEAD_RUNS}x on the current code, once with the targets emptied` })
    : buildScript({ run, name: "gate", base, copies, exclude, units, headRuns: HEAD_RUNS, timeout: runTimeout, title: `gate (${kind}): new tests on the old code, ${HEAD_RUNS}x on the new code` });
  await writeFile(`${run}/gate.sh`, script);

  const res = { run, command: `bash ${run}/gate.sh`, kind, units: units.length };
  if (changedProtected.length || restorable.length) {
    if (changedProtected.length) res.protectedChanged = changedProtected;
    if (restorable.length) res.violations = restorable;
    res.restoreCommand = undoCommand([...changedProtected, ...restorable], snap, run);
    res.note = "a writer changed files it must not touch: run restoreCommand BEFORE the gate, and report it";
    manual.push(...unsnapshotted(restorable, snap));
  }
  if (manual.length) {
    res.manualReview = uniq(manual);
    res.manualNote = "no exact snapshot for these files: if git tracks them, show `git diff` and undo only the writer's hunks (never git checkout them); untracked ones are removed by restoreCommand";
  }
  res.next = "run the command with Bash, then warden_gate {action:\"verdict\", run}";
  return res;
}

async function gateVerdict(a) {
  const run = runPath(a.run);
  const gate = await readJson(`${run}/gate.json`);
  if (!gate) fail(`${run}/gate.json is missing: call warden_gate {action:"plan"} first`);
  const tsv = await readFile(`${run}/gate.tsv`);
  if (tsv == null || !tsv.trim()) fail(`${run}/gate.tsv is missing or empty: run bash ${run}/gate.sh first`);
  const snap = (await readJson(`${run}/snapshot.json`)) || {};
  const { units } = parseTsv(tsv);
  const headRuns = Number.isInteger(gate.headRuns) ? gate.headRuns : HEAD_RUNS;
  const planned = gate.units || [];
  const oldSide = gate.kind === "suite" ? "sabotage" : "base";
  const keep = [];
  const reject = [];
  const confirmed = [];
  const notReproduced = [];
  const incomplete = [];
  for (const [n, u] of units) {
    const role = (planned[Number(n) - 1] || {}).role;
    const heads = Object.entries(u.sides).filter(([s]) => s.startsWith("head"));
    const passes = heads.filter(([, rc]) => rc === 0).length;
    const firstFail = heads.find(([, rc]) => rc !== 0);
    const o = u.sides[oldSide];
    if (heads.length !== headRuns || heads.some(([, rc]) => rc === "absent") || Object.values(u.sides).includes("timeout") || (role !== "bug" && (o === undefined || o === "absent"))) {
      incomplete.push(u.key);
      continue;
    }
    if (role === "bug") {
      if (passes === 0) confirmed.push({ test: u.key, log: (await logExcerpt(run, "gate", firstFail[0], n)) || undefined });
      else notReproduced.push({ test: u.key, reason: passes === heads.length ? "passes on the current code: no bug reproduced" : `flaky: passed ${passes}/${heads.length}` });
      continue;
    }
    let reason = null;
    let log = "";
    if (passes === 0) {
      reason = gate.kind === "suite"
        ? "fails on the current code: a test that reveals a bug belongs in the bugs file; otherwise the test is wrong"
        : "fails on the new code";
      log = await logExcerpt(run, "gate", firstFail[0], n);
    } else if (passes < heads.length) {
      reason = `flaky: passed ${passes}/${heads.length} on the current code`;
      log = await logExcerpt(run, "gate", firstFail[0], n);
    } else if (gate.kind === "suite" && o === 0) {
      reason = `passes with ${(gate.targets || []).join(", ")} emptied: it does not exercise the target`;
    } else if (gate.kind === "refactor" && o !== 0) {
      reason = "fails on the old code: a refactor must not change behaviour, so the test is tied to the new structure";
      log = await logExcerpt(run, "gate", "base", n);
    } else if ((gate.kind === "fix" || gate.kind === "feature") && o === 0) {
      reason = "passes on the old code: it cannot catch this change";
    }
    if (reason) reject.push({ test: u.key, reason, log: log || undefined });
    else keep.push(u.key);
  }
  planned.forEach((u, i) => {
    if (!units.has(String(i + 1))) incomplete.push(u.key);
  });
  // a suite- or directory-level bug run fails for any failing test in it: it proves the bug only if
  // the same stack's test units passed without the bug files
  const unsure = new Set(planned.filter((u) => u.role !== "bug" && (reject.some((r) => r.test === u.key && /fails on|flaky/.test(r.reason)) || incomplete.includes(u.key))).map((u) => u.stack));
  for (let i = confirmed.length - 1; i >= 0; i--) {
    const u = planned.find((x) => x.role === "bug" && x.key === confirmed[i].test);
    if (u && u.files.length && u.path !== u.files[0] && unsure.has(u.stack)) {
      notReproduced.push({ test: confirmed[i].test, reason: "cannot attribute: this run covers more than the bug file and other tests fail too" });
      confirmed.splice(i, 1);
    }
  }

  const filesOf = (key, role) => {
    const u = planned.find((x) => x.key === key && (x.role || null) === (role || null));
    return u && Array.isArray(u.files) ? u.files : [key];
  };
  const own = new Set([...(gate.tests || []), ...(gate.bugs || [])]);
  const undoFiles = uniq([
    ...reject.flatMap((r) => filesOf(r.test)),
    ...notReproduced.filter((r) => !/^cannot attribute/.test(r.reason)).flatMap((r) => filesOf(r.test, "bug")),
  ]).filter((f) => own.has(f));
  const verdict = { run, kind: gate.kind, keep, reject };
  if (confirmed.length || notReproduced.length) verdict.bugs = { confirmed, notReproduced };
  if (undoFiles.length) {
    verdict.undoCommand = undoCommand(undoFiles, snap, run);
    const manual = unsnapshotted(undoFiles, snap).filter((f) => !(gate.written || []).includes(f) || (snap[f] && snap[f].skipped));
    if (manual.length) verdict.manualReview = manual;
  }
  const timedOut = timedOutKeys(units);
  if (timedOut.length) verdict.timedOut = timedOut;
  if (incomplete.length) {
    verdict.incomplete = uniq(incomplete);
    verdict.note = "incomplete units did not finish every run: the script was interrupted or a unit timed out; re-run it";
    if (timedOut.length) verdict.note += `. ${TIMEOUT_NOTE}`;
  }
  await writeFile(`${run}/gate-verdict.json`, JSON.stringify(verdict, null, 2) + "\n");
  return verdict;
}

async function wardenGate(args) {
  const a = isObj(args) ? args : {};
  const action = a.action || "plan";
  if (action === "plan") return gatePlan(a);
  if (action === "verdict") return gateVerdict(a);
  fail('action must be "plan" or "verdict"');
}

// ---------- warden_lessons ----------
const norm = (t) => str(t).toLowerCase().replace(/[^a-z0-9_ ]+/g, " ").replace(/\s+/g, " ").trim();
const words = (t) => new Set(norm(t).split(" ").filter((w) => w.length > 2 || /\d/.test(w)));
function jaccard(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
const lessonId = (text) => sha(norm(text)).slice(0, 8);
const evidenceFile = (e) => relPath(str(e).replace(/#.*$/, ""));

async function loadLessons(prune) {
  const data = await readJson(LESSONS);
  let lessons = data && Array.isArray(data.lessons) ? data.lessons.filter((l) => isObj(l) && l.text && l.evidence) : [];
  if (prune) {
    const kept = [];
    for (const l of lessons) if (await exists(evidenceFile(l.evidence))) kept.push(l);
    if (kept.length !== lessons.length) await saveLessons(kept);
    lessons = kept;
  }
  return lessons;
}

async function saveLessons(lessons) {
  await writeFile(LESSONS, JSON.stringify({ v: 1, lessons }, null, 2) + "\n");
}

async function wardenLessons(args) {
  const a = isObj(args) ? args : {};
  const action = a.action || "get";
  let lessons = await loadLessons(true);
  if (action === "get") {
    return { count: lessons.length, cap: LESSON_CAP, lessons: lessons.map((l) => `${l.id} ${l.text} (${l.evidence})`) };
  }
  if (action === "remove") {
    const ids = new Set(strList(a.ids));
    const before = lessons.length;
    lessons = lessons.filter((l) => !ids.has(l.id));
    await saveLessons(lessons);
    return { removed: before - lessons.length, count: lessons.length };
  }
  if (action !== "add") fail('action must be "get", "add" or "remove"');
  const input = Array.isArray(a.lessons) ? a.lessons : [];
  if (!input.length) fail("lessons: give [{ text, evidence }]");
  const added = [];
  const merged = [];
  const rejected = [];
  for (const raw of input) {
    const text = str(raw && raw.text).replace(/\s+/g, " ").trim();
    const evidence = str(raw && raw.evidence).trim();
    const file = evidenceFile(evidence);
    if (text.length < LESSON_MIN || text.length > LESSON_MAX) {
      rejected.push({ text, reason: `text must be ${LESSON_MIN}-${LESSON_MAX} characters, one line` });
      continue;
    }
    if (!file || !(await exists(file))) {
      rejected.push({ text, reason: `evidence must be an existing workspace path (got ${JSON.stringify(evidence)})` });
      continue;
    }
    const id = lessonId(text);
    const same = lessons.findIndex((l) => l.id === id || (evidenceFile(l.evidence) === file && jaccard(l.text, text) >= 0.6) || jaccard(l.text, text) >= 0.85);
    const entry = { id, text, evidence, at: now() };
    if (same >= 0) {
      lessons[same] = entry;
      merged.push(id);
    } else {
      lessons.push(entry);
      added.push(id);
    }
  }
  let dropped = 0;
  if (lessons.length > LESSON_CAP) {
    lessons.sort((x, y) => str(x.at).localeCompare(str(y.at)));
    dropped = lessons.length - LESSON_CAP;
    lessons = lessons.slice(dropped);
  }
  await saveLessons(lessons);
  await clearGuard(); // step 6 ends every run
  return { added, merged, rejected: rejected.length ? rejected : undefined, dropped: dropped || undefined, count: lessons.length };
}

// ---------- the writer sub-agent (~/.agents/subagents, through node:fs) ----------
const agentSource = () => path.join(__dirname, "subagents");
const agentTarget = () => path.join(os.homedir(), ".agents", "subagents");

/** Copy missing or outdated agents and remove test-warden agents this version no longer ships. */
function installAgents() {
  const src = agentSource();
  const dst = agentTarget();
  const wanted = new Set(AGENTS.map((n) => `${n}.md`));
  fs.mkdirSync(dst, { recursive: true });
  const changed = [];
  for (const name of wanted) {
    const body = fs.readFileSync(path.join(src, name));
    const target = path.join(dst, name);
    let current = null;
    try {
      current = fs.readFileSync(target);
    } catch {
      // missing
    }
    if (!current || !current.equals(body)) {
      fs.writeFileSync(target, body);
      changed.push(name);
    }
  }
  for (const name of fs.readdirSync(dst)) {
    if (!/^test-warden-.*\.md$/.test(name) || wanted.has(name)) continue;
    const file = path.join(dst, name);
    if (fs.readFileSync(file, "utf8").includes(MARKER)) {
      fs.rmSync(file, { force: true });
      changed.push(`-${name}`);
    }
  }
  return changed;
}

/** Remove the agents this plugin installed, unless the user edited them. */
function removeAgents() {
  for (const n of AGENTS) {
    const name = `${n}.md`;
    try {
      if (fs.readFileSync(path.join(agentTarget(), name)).equals(fs.readFileSync(path.join(agentSource(), name)))) {
        fs.rmSync(path.join(agentTarget(), name), { force: true });
      }
    } catch {
      // already gone, or never installed
    }
  }
}

// ---------- tool table ----------
const RUN_ARG = { type: "string", description: "The run directory returned by warden_check plan, e.g. .test-warden/runs/20260101-120000-ab12" };
const TOOLS = [
  {
    name: "warden_profile",
    description: "Test Warden: get the project's test profile (per language: declared and verified test commands, test-file patterns, helpers, examples, CI hints), or set a verified command or patterns and pin it. Use only from the test-warden skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"], description: "get (default) or set" },
        refresh: { type: "boolean", description: "get: re-detect even when the cached profile is current" },
        stack: { type: "string", description: "set: language group id from the profile, e.g. js, py, go" },
        suite: { type: "string", description: "set: command that runs the whole test suite" },
        file: { type: "string", description: "set: command that runs one test file, with {file} (or {dir} for per-directory runners); empty for none" },
        verified: { type: "boolean", description: "set: true once you ran the command and it ran tests" },
        patterns: { type: "array", items: { type: "string" }, description: "set: globs that match the project's test files" },
      },
    },
    execute: async (args) => ({ ...(await wardenProfile(args)), agent: agentStatus }),
  },
  {
    name: "warden_check",
    description: "Test Warden: plan maps changed files (mode change) or target files (mode suite) to their tests, snapshots them and writes the script that runs those tests; verdict reports regressions, failing tests, uncovered sources and where new tests go. Use only from the test-warden skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["plan", "verdict", "release"], description: "plan (default), verdict, or release (lift the read-only guard on the sources: only when the user explicitly asks for a source fix)" },
        mode: { type: "string", enum: ["change", "suite"], description: "plan: change (default) checks a change against base; suite prepares a test suite for unchanged target files" },
        changed: { type: "array", items: { type: "string" }, description: "plan: workspace-relative paths, changed since base (change) or the files to build a suite for (suite)" },
        base: { type: "string", description: "plan, change mode: git ref of the old code; default HEAD (uncommitted changes)" },
        run: RUN_ARG,
      },
    },
    execute: wardenCheck,
  },
  {
    name: "warden_gate",
    description: "Test Warden: plan detects any change to the protected sources, checks writers touched only tests, and writes the script that proves new tests can fail and bug reproductions do fail; verdict keeps, rejects and confirms bugs with exact undo commands. Use only from the test-warden skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["plan", "verdict"], description: "plan (default) or verdict" },
        run: RUN_ARG,
        kind: { type: "string", enum: KINDS, description: "plan: fix/feature (must fail on the old code), refactor (must pass on both), suite (must pass now and fail with the targets emptied)" },
        tests: { type: "array", items: { type: "string" }, description: "plan: test files the writers created or changed that must pass" },
        bugs: { type: "array", items: { type: "string" }, description: "plan: test files that reproduce suspected source bugs and must fail" },
        written: { type: "array", items: { type: "string" }, description: "plan: every file the writers reported writing" },
        base: { type: "string", description: "plan: git ref of the old code; default the check run's base" },
      },
      required: ["run"],
    },
    execute: wardenGate,
  },
  {
    name: "warden_lessons",
    description: "Test Warden: the project's capped, deduplicated list of one-line testing lessons, each backed by an existing evidence path; get, add or remove. Use only from the test-warden skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "add", "remove"], description: "get (default), add or remove" },
        lessons: {
          type: "array",
          description: "add: [{ text, evidence }]; text is one line, evidence a workspace path (optionally :line)",
          items: { type: "object", properties: { text: { type: "string" }, evidence: { type: "string" } }, required: ["text", "evidence"] },
        },
        ids: { type: "array", items: { type: "string" }, description: "remove: lesson ids" },
      },
    },
    execute: wardenLessons,
  },
];

async function onLoad() {
  try {
    const changed = installAgents();
    agentStatus = changed.length ? `installed or updated: ${changed.join(", ")}` : "installed and up to date";
  } catch (e) {
    agentStatus = `could not install to ${agentTarget()}: ${e && e.message}`;
  }
  for (const tool of TOOLS) {
    await pi.agent.registerTool({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      schema: tool.schema,
      execute: (args, ctx) => {
        if (ctx && typeof ctx.log === "function") ctx.log(`${tool.name} called`);
        return tool.execute(args, ctx);
      },
    });
    registered.push(tool.name);
  }
}

async function onUnload() {
  for (const name of registered.splice(0)) {
    try {
      await pi.agent.unregisterTool(name);
    } catch {
      // the host drops plugin tools on unload anyway
    }
  }
  try {
    removeAgents();
  } catch {
    // best effort
  }
}

module.exports = { onLoad, onUnload };
