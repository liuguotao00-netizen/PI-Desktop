"use strict";

/**
 * Test helpers for Test Warden. No dependencies: main.js is compiled as a fresh CommonJS module
 * per test with its own fake `pi` global, and internal functions are re-exported under `__t`.
 * The fake host keeps the workspace and HOME in a temporary folder.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const MAIN = path.join(ROOT, "main.js");

const INTERNALS = [
  "relPath", "q", "runPath", "groupOf", "globRe", "isTestFile", "isHelperFile", "testStem", "sourceStems", "nameMatch",
  "refersTo", "extractGlobs", "generalize", "declaredCommands", "detectProfile", "ensureProfile", "unitOf", "unitsOf",
  "buildScript", "parseTsv", "excerpt", "undoCommand", "suggestPaths", "variantPath", "jaccard", "installAgents",
  "removeAgents", "TOOLS", "AGENTS", "MARKER", "LESSON_CAP", "CONVENTIONS",
];

/** Compile a fresh copy of main.js bound to `pi`. Returns `{ ...exports, __t }`. */
function loadMain(pi) {
  const src = fs.readFileSync(MAIN, "utf8");
  const exportsLine =
    "\nmodule.exports.__t = {" +
    INTERNALS.map((n) => `${n}: typeof ${n} === "undefined" ? undefined : ${n}`).join(", ") +
    " };\n";
  const bind = "const pi = module.__pi;";
  const m = new module.constructor(MAIN, module);
  m.filename = MAIN;
  m.paths = module.paths;
  m.__pi = pi;
  const directive = /^\s*(["'])use strict\1;?/;
  const body = directive.test(src) ? src.replace(directive, (d) => `${d} ${bind}`) : `${bind}\n${src}`;
  m._compile(body + exportsLine, MAIN);
  return m.exports;
}

/** A temporary sandbox: workspace and HOME. */
function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-warden-test-")));
  const dirs = { base, workspace: path.join(base, "workspace"), home: path.join(base, "home") };
  for (const d of [dirs.workspace, dirs.home]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

/** A fake `pi` over `dirs.workspace` (root-relative paths that may not escape it). */
function fakePi(dirs, { settings = {} } = {}) {
  const abs = (p) => {
    const full = path.resolve(dirs.workspace, p || ".");
    if (path.relative(dirs.workspace, full).startsWith("..")) throw new Error(`outside the workspace: ${p}`);
    return full;
  };
  const writes = [];
  const tools = new Map();
  const store = { ...settings };
  const pi = {
    writes, tools, store,
    fs: {
      readText: async (p) => fs.readFileSync(abs(p), "utf8"),
      writeText: async (p, content) => {
        if (!String(p).startsWith(".test-warden/")) throw new Error(`write outside scope: ${p}`);
        writes.push(p);
        fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
        fs.writeFileSync(abs(p), content);
      },
      list: async (p) => fs.readdirSync(abs(p), { withFileTypes: true }).map((e) => ({
        name: e.name,
        path: p && p !== "." ? path.posix.join(p, e.name) : e.name,
        isDirectory: e.isDirectory(),
      })),
      stat: async (p) => {
        const s = fs.statSync(abs(p));
        return { size: s.size, isDirectory: s.isDirectory() };
      },
      remove: async (p) => {
        if (!String(p).startsWith(".test-warden/")) throw new Error(`remove outside scope: ${p}`);
        fs.rmSync(abs(p));
      },
    },
    plugin: {
      getSettings: async () => JSON.parse(JSON.stringify(store)),
      setSettings: async (partial) => { Object.assign(store, partial); },
    },
    agent: {
      registerTool: async (tool) => { tools.set(tool.name, tool); },
      unregisterTool: async (name) => { tools.delete(name); },
    },
    call: (name, args) => tools.get(name).execute(args, { sessionId: "s1", log: () => {} }),
  };
  return pi;
}

/** Load main.js against a sandbox and register its tools. */
async function setup(opts = {}) {
  const dirs = sandbox();
  const restoreHome = withHome(dirs.home);
  const pi = fakePi(dirs, opts);
  const main = loadMain(pi);
  await main.onLoad();
  return { dirs, pi, main, t: main.__t, done: async () => { await main.onUnload(); restoreHome(); } };
}

function put(dirs, rel, content) {
  const full = path.join(dirs.workspace, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function get(dirs, rel) {
  try {
    return fs.readFileSync(path.join(dirs.workspace, rel), "utf8");
  } catch {
    return null;
  }
}

function withHome(home) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  return () => {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  };
}

/** Run git in the workspace with a fixed identity. */
function git(dirs, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dirs.workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Run bash on a workspace-relative script; returns { code, out }. */
function bash(dirs, script) {
  try {
    const out = execFileSync("bash", [script], { cwd: dirs.workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

/** Save a verified command for a stack, as the agent does after step 1 of the skill. */
function verify(pi, stack, suite, file) {
  return pi.call("warden_profile", { action: "set", stack, suite, file, verified: true });
}

module.exports = { ROOT, MAIN, loadMain, sandbox, fakePi, setup, put, get, withHome, git, bash, verify };
