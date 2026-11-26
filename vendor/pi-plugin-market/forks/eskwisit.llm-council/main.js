"use strict";

/**
 * LLM Council — PI-Desktop plugin main process.
 *
 * The orchestrating agent follows skills/llm-council.md and calls four agent tools registered
 * here. They do the deterministic work an LLM does badly (an unbiased shuffle, a hidden label
 * map, ranking parsing and averaging, copying long texts into prompts and reports), so the
 * answers and reviews never have to pass through the orchestrator's context.
 *
 *   council, one tool with an action:
 *     get / set    saved cast, model exclusions and notes (plugin settings); persona status
 *     start / next the model each seat launches on, and the failover bookkeeping (failovers.json)
 *     anonymize    Stage 1 answers -> Response A, B, … in stage2_prompt.md; hides authorship
 *     tally        Stage 2 reviews -> aggregate.json and the chairman's stage3_prompt.md
 *     report       report.md and transcript.json
 *
 * Run files live in the workspace under .llm-council/runs/<id>/ and are read and written through
 * the host's scoped pi.fs API (manifest.fs). Two things the host API cannot reach use node:fs:
 *   - the six persona sub-agents are copied to ~/.agents/subagents on load (the only place
 *     PI-Desktop loads sub-agents from) and removed on unload;
 *   - the label map and the hidden Stage 1 answers of a run are kept in memory and in the
 *     plugin's private data directory (pi.plugin.getDataPath()).
 * No network access, no process execution.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// ---------- the council ----------
const ADVISORS = [
  ["contrarian", "council-contrarian", "The Contrarian"],
  ["first-principles", "council-first-principles", "The First Principles Thinker"],
  ["expansionist", "council-expansionist", "The Expansionist"],
  ["outsider", "council-outsider", "The Outsider"],
  ["executor", "council-executor", "The Executor"],
];
const ADVISOR_SEATS = ADVISORS.map(([seat]) => seat);
const SEAT_AGENT = Object.fromEntries([
  ...ADVISORS.map(([seat, agent]) => [seat, agent]),
  ["chairman", "council-chairman"],
]);
const SEATS = Object.keys(SEAT_AGENT);
const DISPLAY = Object.fromEntries([
  ...ADVISORS.map(([seat, , name]) => [seat, name]),
  ["chairman", "The Chairman"],
]);
const MARKER = "Use only from the llm-council skill.";
const RUN_RE = /^\.llm-council\/runs\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROMPT_LINE_WARN = 1800; // the Read tool returns 2000 lines per call by default
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // run state older than this is pruned on load

const states = new Map(); // run -> { labels, stage1, models, seed, reviewers, at }
let personaStatus = "not installed yet";
let registered = [];

// ---------- small helpers ----------
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
const lineCount = (text) => text.split("\n").length;
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function fail(message) {
  const e = new Error(message);
  e.code = "INVALID_ARGUMENT";
  throw e;
}

/** ".llm-council/runs/<id>", given that path (optionally "./"-prefixed or with a trailing slash) or a bare id. */
function runPath(run) {
  let r = str(run).trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (r && !r.includes("/")) r = `.llm-council/runs/${r}`;
  if (!RUN_RE.test(r)) fail(`run must be a workspace-relative path like .llm-council/runs/20260101-120000, got ${JSON.stringify(run)}`);
  return r;
}

// ---------- model ids and exclusions ----------
/** Shell-style glob (* ? [..]) matched case-insensitively against the whole id. */
function globMatch(pattern, value) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        let set = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (set.startsWith("!")) set = "^" + set.slice(1);
        re += `[${set}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(value);
}
const isExcluded = (id, exclude) => exclude.some((p) => globMatch(p, id));
const tail = (id) => id.split("/").pop().toLowerCase();
const family = (id) => tail(id).split(/[-_.:]/)[0];

/**
 * Validate a cast { seat: [model, fallback, …] } against the delegation catalog (model ids) and
 * the exclusions. The same model through another account is inserted right after it.
 * Returns { cast, warnings } or throws with every problem listed.
 */
function buildCast(requested, catalog, exclude) {
  if (!isObj(requested)) fail("cast must be an object: { seat: [model, fallback, …] }");
  const known = new Set(catalog);
  const usable = catalog.filter((id) => !isExcluded(id, exclude));
  const errors = [];
  const cast = {};
  for (const seat of SEATS) {
    const req = typeof requested[seat] === "string" ? [requested[seat]] : strList(requested[seat]);
    if (!req.length) {
      errors.push(`${seat}: no model given`);
      continue;
    }
    const chain = [];
    for (const id of req) {
      if (id === "inherit" && !catalog.length) {
        if (!chain.includes(id)) chain.push(id);
        continue;
      }
      if (!known.has(id)) errors.push(`${seat}: ${id} is not in the delegation catalog`);
      else if (isExcluded(id, exclude)) errors.push(`${seat}: ${id} is excluded`);
      else for (const alt of [id, ...usable.filter((m) => m !== id && tail(m) === tail(id))]) {
        if (!chain.includes(alt)) chain.push(alt);
      }
    }
    cast[seat] = chain;
  }
  const unknown = Object.keys(requested).filter((s) => !SEATS.includes(s));
  if (unknown.length) errors.push(`unknown seat(s): ${unknown.join(", ")}; seats are ${SEATS.join(", ")}`);
  if (errors.length) fail(`invalid cast:\n  ${errors.join("\n  ")}`);
  const warnings = [];
  if (catalog.length) {
    const used = new Set(ADVISOR_SEATS.map((s) => family(cast[s][0])));
    const avail = new Set(usable.map(family));
    if (used.size === 1 && avail.size > 1) {
      warnings.push(`all advisors are on one model family (${[...used][0]}) although ${[...avail].sort().join(", ")} are available: the review loses model diversity`);
    }
    for (const seat of SEATS) {
      if (cast[seat].length === 1) warnings.push(`${seat} has no fallback model`);
    }
  }
  return { cast, warnings };
}

/** Which seats of a saved cast can no longer use their primary model. */
function staleSeats(cast, catalog, exclude) {
  if (!isObj(cast) || !Object.keys(cast).length) return SEATS.slice();
  const ok = (id) => (catalog.length ? catalog.includes(id) : id === "inherit") && !isExcluded(id, exclude);
  return SEATS.filter((s) => !Array.isArray(cast[s]) || !cast[s].length || !ok(cast[s][0]));
}

// ---------- prompts (our own wording) ----------
function buildReviewPrompt(question, labeled) {
  const responses = labeled.map(([label, text]) => `### ${label}\n\n${text}`).join("\n\n");
  return `Several advisors answered the question below, each from a different angle. You see their answers anonymously, as Response A, Response B and so on, and you do not know who wrote which.

## Question

${question}

## Responses

${responses}

## Your review

1. For each response, say in a sentence or two what it gets right and what it gets wrong.
2. Then answer these three questions, citing responses by their letter:
   - Strongest: which response helps the user most, and why?
   - Biggest blind spot: which response misses the most important point, and what is it?
   - All missed: what did every response overlook that the council should weigh?
3. End with your ranking of all the responses, best first.

Keep everything before the ranking under 400 words, and be direct.

The ranking must be the last thing you write, in exactly this form: a line that says FINAL RANKING: and then one numbered line per response holding only its label. For example:

FINAL RANKING:
1. Response C
2. Response A
3. Response B

Write nothing after the ranking.`;
}

function buildChairmanPrompt(question, stage1, stage2, aggregate) {
  const answers = stage1.map((r) => `### ${r.label}: ${r.advisor} (model: ${r.model})\n\n${r.response}`).join("\n\n");
  const reviews = stage2.length
    ? stage2.map((r) => `### Review by ${r.advisor} (model: ${r.model})\n\n${r.ranking}`).join("\n\n")
    : "(no reviews)";
  const table = aggregate.length
    ? aggregate.map((a, i) => `${i + 1}. ${a.label}, ${a.advisor}: average rank ${a.average_rank} (${a.rankings_count} votes)`).join("\n")
    : "(no valid rankings)";
  return `You chair an LLM Council. Several advisors, each reasoning from a deliberately different angle, answered the user's question. Then each of them reviewed and ranked all the answers without knowing who wrote which. Only you see which advisor and model wrote each response.

## Question

${question}

## Stage 1: the answers

${answers}

## Stage 2: the reviews

${reviews}

## Stage 2: average rank (lower is better)

${table}

## Your verdict

Write the council's verdict for the user. Draw on the answers, on what the reviews reveal about them, and on where the advisors converge or split. The majority is not automatically right: if one advisor's reasoning is stronger than the consensus, side with that advisor and say why.

Use exactly these sections:

## Where the Council Agrees
Points that several advisors reached on their own. These are the most reliable signals.

## Where the Council Clashes
Real disagreements: give each side, explain why sensible advisors differ, then decide.

## Blind Spots the Council Caught
What surfaced only in the reviews, or what one advisor raised and the others missed.

## The Recommendation
One clear recommendation and the reasoning behind it. Not "it depends".

## The One Thing to Do First
One concrete next step, not a list.

Be direct and commit to a view: the user convened the council for clarity that a single answer could not give.`;
}

/** Tidy the run title: trim, drop wrapping quotes, cap at 50 characters. */
function cleanTitle(title) {
  const t = str(title).trim().replace(/^["']+|["']+$/g, "").trim();
  if (!t) return "LLM Council";
  return t.length > 50 ? `${t.slice(0, 47)}...` : t;
}

// ---------- ranking parser and aggregate ----------
/**
 * The labels of a review's ranking, best first. Reads after the LAST "FINAL RANKING" header
 * (any case, colon optional), so a reviewer who mentions the phrase earlier does not break it;
 * prefers numbered lines, falls back to any "Response X"; drops duplicates and, when `valid`
 * is given, labels that are not in it.
 */
function parseRanking(text, valid) {
  const s = str(text);
  let start = 0;
  for (const m of s.matchAll(/final\s+ranking\s*:?/gi)) start = m.index + m[0].length;
  const section = s.slice(start);
  let found = [...section.matchAll(/\d+\.\s*[*_]*\s*Response ([A-Z])\b/g)].map((m) => m[1]);
  if (!found.length) found = [...section.matchAll(/\bResponse ([A-Z])\b/g)].map((m) => m[1]);
  const out = [];
  for (const letter of found) {
    const label = `Response ${letter}`;
    if (!out.includes(label) && (!valid || Object.prototype.hasOwnProperty.call(valid, label))) out.push(label);
  }
  return out;
}

/** Average rank per label (i.e. per advisor seat), best first. */
function aggregateRankings(reviews, labels) {
  const positions = {};
  for (const r of reviews) {
    parseRanking(r.ranking, labels).forEach((label, i) => {
      (positions[label] ||= []).push(i + 1);
    });
  }
  return Object.entries(positions)
    .map(([label, p]) => ({
      label,
      seat: labels[label].seat,
      advisor: labels[label].advisor,
      model: labels[label].model,
      average_rank: Math.round((p.reduce((a, b) => a + b, 0) / p.length) * 100) / 100,
      rankings_count: p.length,
    }))
    .sort((a, b) => a.average_rank - b.average_rank || a.label.localeCompare(b.label));
}

// ---------- shuffling ----------
function seededRandom(seed) {
  let a = seed >>> 0; // mulberry32
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed) {
  const out = items.slice();
  const rand = seed == null ? null : seededRandom(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand ? Math.floor(rand() * (i + 1)) : crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------- run files (workspace, through pi.fs) ----------
async function readFile(p) {
  try {
    return await pi.fs.readText(p);
  } catch {
    return null;
  }
}

/** The non-empty <seat>.md files of a stage directory, as [[seat, text]] sorted by seat. */
async function readSeatFiles(dir, seats) {
  let entries = [];
  try {
    entries = await pi.fs.list(dir);
  } catch {
    return { files: [], ignored: [] };
  }
  const files = [];
  const ignored = [];
  for (const e of entries) {
    if (e.isDirectory || !e.name.endsWith(".md")) continue;
    const seat = e.name.slice(0, -3);
    if (!seats.includes(seat)) {
      ignored.push(e.name);
      continue;
    }
    const text = str(await readFile(e.path || `${dir}/${e.name}`)).trim();
    if (text) files.push([seat, text]);
  }
  files.sort((a, b) => a[0].localeCompare(b[0]));
  return { files, ignored };
}

async function readQuestion(run, name = "question.md") {
  const q = str(await readFile(`${run}/${name}`)).trim();
  if (q) return q;
  if (name !== "question.md") return readQuestion(run);
  fail(`${run}/question.md is missing or empty: write the framed question first`);
}

// ---------- run state (memory + plugin data directory, through node:fs) ----------
let dataDir = null;
async function stateDir() {
  if (!dataDir) dataDir = path.join(await pi.plugin.getDataPath(), "runs");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return dataDir;
}
const stateKey = (run) => crypto.createHash("sha256").update(run).digest("hex").slice(0, 16);

async function saveState(run, state) {
  states.set(run, state);
  const file = path.join(await stateDir(), `${stateKey(run)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ run, ...state }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function loadState(run) {
  if (states.has(run)) return states.get(run);
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(await stateDir(), `${stateKey(run)}.json`), "utf8"));
    if (saved.run !== run) return null;
    delete saved.run;
    states.set(run, saved);
    return saved;
  } catch {
    return null;
  }
}

async function pruneStates() {
  try {
    const dir = await stateDir();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > STATE_TTL_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    // best effort
  }
}

// ---------- personas (~/.agents/subagents, through node:fs) ----------
const personaSource = () => path.join(__dirname, "subagents");
const personaTarget = () => path.join(os.homedir(), ".agents", "subagents");

/** Copy missing or outdated personas and remove council personas this version no longer ships. */
function installPersonas() {
  const src = personaSource();
  const dst = personaTarget();
  const wanted = new Set(SEATS.map((s) => `${SEAT_AGENT[s]}.md`));
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
    if (!/^council-.*\.md$/.test(name) || wanted.has(name)) continue;
    const file = path.join(dst, name);
    if (fs.readFileSync(file, "utf8").includes(MARKER)) {
      fs.rmSync(file, { force: true });
      changed.push(`-${name}`);
    }
  }
  return changed;
}

/** Remove the personas this plugin installed, unless the user edited them. */
function removePersonas() {
  const src = personaSource();
  const dst = personaTarget();
  for (const seat of SEATS) {
    const name = `${SEAT_AGENT[seat]}.md`;
    try {
      if (fs.readFileSync(path.join(dst, name)).equals(fs.readFileSync(path.join(src, name)))) {
        fs.rmSync(path.join(dst, name), { force: true });
      }
    } catch {
      // already gone, or never installed
    }
  }
}

// ---------- tools ----------
async function settings() {
  const s = (await pi.plugin.getSettings()) || {};
  return {
    cast: isObj(s.cast) ? s.cast : {},
    exclude: strList(s.excludeModels),
    notes: strList(s.modelNotes),
  };
}

async function councilConfig(args) {
  const a = isObj(args) ? args : {};
  const action = a.action || "get";
  if (action !== "get" && action !== "set") fail(ACTION_ERROR);
  const catalog = strList(a.models);
  let cfg = await settings();
  const warnings = [];
  if (action === "set") {
    const patch = {};
    if (a.clear === true) {
      cfg = { cast: {}, exclude: [], notes: [] };
      Object.assign(patch, { cast: {}, excludeModels: [], modelNotes: [] });
    }
    const exclude = [...cfg.exclude];
    for (const p of strList(a.exclude)) if (!exclude.includes(p)) exclude.push(p);
    const include = strList(a.include);
    cfg.exclude = exclude.filter((p) => !include.includes(p));
    for (const n of strList(a.notes)) if (!cfg.notes.includes(n)) cfg.notes.push(n);
    patch.excludeModels = cfg.exclude;
    patch.modelNotes = cfg.notes;
    if (a.cast !== undefined) {
      const built = buildCast(a.cast, catalog, cfg.exclude);
      cfg.cast = built.cast;
      warnings.push(...built.warnings);
      patch.cast = cfg.cast;
    }
    await pi.plugin.setSettings(patch);
  }
  const stale = staleSeats(cfg.cast, catalog, cfg.exclude);
  // a reused cast keeps only the models that are still available and allowed
  const cast = Object.fromEntries(
    Object.entries(cfg.cast).map(([seat, chain]) => [
      seat,
      strList(chain).filter((id) => (catalog.length ? catalog.includes(id) : id === "inherit") && !isExcluded(id, cfg.exclude)),
    ]),
  );
  return {
    cast,
    castUsable: stale.length === 0,
    staleSeats: stale,
    exclude: cfg.exclude,
    excludedModels: catalog.filter((id) => isExcluded(id, cfg.exclude)),
    notes: cfg.notes,
    warnings,
    seats: SEAT_AGENT,
    personas: personaStatus,
  };
}

async function councilAnonymize(args) {
  const a = isObj(args) ? args : {};
  const run = runPath(a.run);
  const models = isObj(a.stage1) ? a.stage1 : {};
  const prior = await loadState(run);
  if (prior && a.force !== true) fail("this run is already anonymized (reviews may be under way); pass force: true to redo it");
  const question = await readQuestion(run);
  const { files, ignored } = await readSeatFiles(`${run}/stage1`, ADVISOR_SEATS);
  let answers = files;
  if (!answers.length && prior) answers = Object.entries(prior.stage1); // redo after the files were hidden
  if (!answers.length) fail("no Stage 1 answers: every advisor failed to respond");
  const seed = Number.isInteger(a.seed) ? a.seed : null;
  const order = a.shuffle === false ? answers : shuffle(answers, seed);
  const labels = {};
  const labeled = order.map(([seat, text], i) => {
    const label = `Response ${String.fromCharCode(65 + i)}`;
    labels[label] = { seat, advisor: DISPLAY[seat], model: str(models[seat] || prior?.models?.[seat]) || "unknown" };
    return [label, text];
  });
  const prompt = buildReviewPrompt(question, labeled);
  await pi.fs.writeText(`${run}/stage2_prompt.md`, prompt);
  await saveState(run, {
    at: now(),
    seed,
    shuffled: a.shuffle !== false,
    labels,
    stage1: Object.fromEntries(answers),
    models: Object.fromEntries(answers.map(([seat]) => [seat, labels[Object.keys(labels).find((l) => labels[l].seat === seat)].model])),
    reviewers: {},
  });
  // keep authorship out of the reviewers' reach: the stage1 files are emptied, not trashed
  for (const [seat] of files) await pi.fs.writeText(`${run}/stage1/${seat}.md`, "");
  const lines = lineCount(prompt);
  return {
    responses: labeled.length,
    prompt: `${run}/stage2_prompt.md`,
    lines,
    warnings: [
      ...(lines > PROMPT_LINE_WARN ? [`stage2_prompt.md has ${lines} lines: reviewers must page through it with offset`] : []),
      ...ignored.map((n) => `ignored ${run}/stage1/${n}: not an advisor seat`),
    ],
    summary: `wrote stage2_prompt.md with ${labeled.length} anonymized responses; the Stage 1 files were emptied and the label map is held by the plugin`,
  };
}

async function readReviews(run, state, reviewers) {
  const { files } = await readSeatFiles(`${run}/stage2`, ADVISOR_SEATS);
  return files.map(([seat, text]) => ({
    seat,
    advisor: DISPLAY[seat],
    model: str(reviewers[seat] || state.reviewers?.[seat] || state.models?.[seat]) || "unknown",
    ranking: text,
    parsed_ranking: parseRanking(text, state.labels),
  }));
}

async function councilTally(args) {
  const a = isObj(args) ? args : {};
  const run = runPath(a.run);
  const state = await loadState(run);
  if (!state) fail("this run has not been anonymized: run anonymize first");
  const reviewers = { ...state.reviewers, ...(isObj(a.reviewers) ? a.reviewers : {}) };
  const reviews = await readReviews(run, state, reviewers);
  const aggregate = aggregateRankings(reviews, state.labels);
  await pi.fs.writeText(`${run}/aggregate.json`, JSON.stringify({
    stage2: reviews.map(({ seat, model, parsed_ranking }) => ({ seat, model, parsed_ranking })),
    aggregate_rankings: aggregate,
  }, null, 2));
  const stage1 = Object.entries(state.labels)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([label, info]) => ({ label, ...info, response: str(state.stage1[info.seat]) }));
  const prompt = buildChairmanPrompt(await readQuestion(run), stage1, reviews, aggregate);
  await pi.fs.writeText(`${run}/stage3_prompt.md`, prompt);
  await saveState(run, { ...state, reviewers });
  const all = Object.keys(state.labels).sort();
  const parseWarnings = reviews
    .filter((r) => r.parsed_ranking.slice().sort().join() !== all.join())
    .map((r) => ({ seat: r.seat, parsed: r.parsed_ranking, text: r.ranking.slice(-600) }));
  const lines = lineCount(prompt);
  return {
    reviews: reviews.map(({ seat, parsed_ranking }) => ({ seat, ranking: parsed_ranking })),
    streetCred: aggregate.map(({ label, advisor, model, average_rank, rankings_count }) => ({ label, advisor, model, average_rank, votes: rankings_count })),
    parseWarnings,
    prompt: `${run}/stage3_prompt.md`,
    lines,
    warnings: [
      ...(reviews.length ? [] : ["no Stage 2 reviews: the aggregate is empty"]),
      ...(lines > PROMPT_LINE_WARN ? [`stage3_prompt.md has ${lines} lines: the chairman must page through it with offset`] : []),
    ],
  };
}

// ---------- failover (run/failovers.json) ----------
const STAGES = ["stage1", "stage2", "stage3"];
const failoverRecord = (f) => ({ stage: str(f.stage), seat: str(f.seat), failed: str(f.failed), reason: str(f.reason), next: str(f.next) });

/**
 * The first model of `chain` that is not in `failed`; with `after`, only the models behind that
 * one count. Empty string when none is left (the seat is dropped).
 */
function nextModel(chain, failed, after) {
  const models = strList(chain);
  const from = after == null ? 0 : models.indexOf(after) + 1;
  return models.slice(from).find((m) => !failed.includes(m)) || "";
}

/** { failed: [model…], failovers: [{ stage, seat, failed, reason, next }] } of a run; empty when the file is missing. */
async function readFailovers(run) {
  let data = null;
  try {
    data = JSON.parse(str(await readFile(`${run}/failovers.json`)));
  } catch {
    // missing or unreadable: start empty
  }
  if (!isObj(data)) data = {};
  return {
    failed: strList(data.failed),
    failovers: (Array.isArray(data.failovers) ? data.failovers : []).filter(isObj).map(failoverRecord),
  };
}

function checkStage(stage) {
  if (!STAGES.includes(stage)) fail(`stage must be one of ${STAGES.join(", ")}, got ${JSON.stringify(stage)}`);
  return stage;
}

/** The saved chain of each seat, from the plugin settings. */
async function seatChains(seats) {
  const { cast } = await settings();
  const chains = {};
  for (const seat of seats) {
    if (!SEATS.includes(seat)) fail(`unknown seat ${JSON.stringify(seat)}; seats are ${SEATS.join(", ")}`);
    chains[seat] = strList(cast[seat]);
    if (!chains[seat].length) fail(`no cast saved for ${seat}: call council set first`);
  }
  return chains;
}

async function councilStart(args) {
  const a = isObj(args) ? args : {};
  const run = runPath(a.run);
  if (a.stage !== undefined) checkStage(str(a.stage));
  const seats = [...new Set([...strList(a.seats), ...(typeof a.seat === "string" ? [a.seat.trim()] : strList(a.seat))])].filter(Boolean);
  if (!seats.length) fail("seats must list the seats to launch");
  const chains = await seatChains(seats);
  const { failed } = await readFailovers(run);
  const models = Object.fromEntries(seats.map((s) => [s, nextModel(chains[s], failed)]));
  return { models, dropped: seats.filter((s) => !models[s]), failed };
}

async function councilNext(args) {
  const a = isObj(args) ? args : {};
  const run = runPath(a.run);
  const stage = checkStage(str(a.stage));
  const seat = str(a.seat).trim();
  const chain = (await seatChains([seat]))[seat];
  const failed = str(a.failed).trim();
  if (!failed) fail("failed must be the id of the model that failed");
  const log = await readFailovers(run);
  if (!log.failed.includes(failed)) log.failed.push(failed);
  const next = nextModel(chain, log.failed, failed);
  log.failovers.push({ stage, seat, failed, reason: str(a.reason).trim() || "error", next });
  await pi.fs.writeText(`${run}/failovers.json`, JSON.stringify(log, null, 2));
  return { next, dropped: !next, failed: log.failed, failovers: log.failovers };
}

function reportMarkdown({ title, question, chairman, verdict, aggregate, failovers, reviews, stage1 }) {
  const out = [`# ${title}`, "", `**Question:** ${question}`, "", "## Stage 3: council verdict", `_Chairman: ${chairman}_`, "", verdict, "",
    "## Stage 2: street cred", "", "| # | Response | Advisor | Model | Avg rank | Votes |", "|---|---|---|---|---|---|"];
  aggregate.forEach((a, i) => out.push(`| ${i + 1} | ${a.label.split(" ").pop()} | ${a.advisor} | ${a.model} | ${a.average_rank} | ${a.rankings_count} |`));
  if (failovers.length) {
    out.push("", "### Failovers", "");
    for (const f of failovers) out.push(`- ${f.stage}/${f.seat}: ${f.failed} failed (${f.reason || "error"}) -> ${f.next || "no model left, seat dropped"}`);
  }
  out.push("");
  for (const r of reviews) {
    out.push(`### Review by ${r.advisor} (${r.model})`, "", r.ranking, "", `_Extracted ranking: ${r.parsed_ranking.join(", ") || "(none)"}_`, "");
  }
  out.push("## Stage 1: advisor answers", "");
  for (const r of stage1) out.push(`### ${r.label}: ${r.advisor} (${r.model})`, "", r.response, "");
  return out.join("\n");
}

async function councilReport(args) {
  const a = isObj(args) ? args : {};
  const run = runPath(a.run);
  const question = await readQuestion(run);
  const state = await loadState(run);
  // failovers recorded by `next`, plus any the orchestrator still passes by hand (older skill)
  const log = await readFailovers(run);
  const key = (f) => `${f.stage}/${f.seat}/${f.failed}`;
  const given = (Array.isArray(a.failovers) ? a.failovers : []).filter(isObj).map(failoverRecord);
  const failovers = [...log.failovers, ...given.filter((g) => !log.failovers.some((f) => key(f) === key(g)))]
    .map((f) => ({ ...f, next: f.next || null }));
  const reviews = state ? await readReviews(run, state, state.reviewers || {}) : [];
  const aggregate = state ? aggregateRankings(reviews, state.labels) : [];
  const stage1 = state
    ? Object.entries(state.labels).sort(([x], [y]) => x.localeCompare(y)).map(([label, info]) => ({ label, ...info, response: str(state.stage1[info.seat]) }))
    : [];
  const chairman = str(a.chairman) || "(not cast)";
  let verdict = str(await readFile(`${run}/stage3/chairman.md`)).trim();
  if (!stage1.length) verdict = "All models failed to respond. Please try again.";
  if (!verdict) verdict = "Error: the chairman could not write the verdict.";
  const title = cleanTitle(str(a.title) || (await readFile(`${run}/title.txt`)));
  const transcript = {
    title,
    user_question: await readQuestion(run, "user_question.md"),
    question,
    stage1,
    stage2: reviews,
    stage3: { model: chairman, response: verdict },
    metadata: {
      label_map: state ? state.labels : {},
      aggregate_rankings: aggregate,
      cast: isObj(a.cast) ? a.cast : undefined,
      failovers,
    },
  };
  await pi.fs.writeText(`${run}/transcript.json`, JSON.stringify(transcript, null, 2));
  await pi.fs.writeText(`${run}/report.md`, reportMarkdown({ title, question, chairman, verdict, aggregate, failovers, reviews, stage1 }));
  return { title, report: `${run}/report.md`, transcript: `${run}/transcript.json` };
}

// ---------- registration ----------
const RUN_ARG = { type: "string", description: "The run directory, e.g. .llm-council/runs/20260101-120000" };
const SEAT_MODELS = (what) => ({
  type: "object",
  description: `${what}: { seat: model id } for ${ADVISOR_SEATS.join(", ")}`,
  additionalProperties: { type: "string" },
});

const ACTIONS = { get: councilConfig, set: councilConfig, start: councilStart, next: councilNext, anonymize: councilAnonymize, tally: councilTally, report: councilReport };
const ACTION_ERROR = 'action must be "get", "set", "start", "next", "anonymize", "tally" or "report"';

const TOOLS = [
  {
    name: "council",
    description: "LLM Council: get/set the cast, exclusions and notes; start/next pick each seat's model and record failovers; anonymize the Stage 1 answers; tally the Stage 2 rankings; write the report. Use only from the llm-council skill.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set", "start", "next", "anonymize", "tally", "report"], description: "get (default): read the config; set: save it; start, next, anonymize, tally, report: run steps, need run" },
        models: { type: "array", items: { type: "string" }, description: "get/set: model ids from your 'Available models for delegation' list" },
        cast: { type: "object", description: "set: { seat: [model, fallback, …] } for every seat; report: the cast used", additionalProperties: { type: "array", items: { type: "string" } } },
        exclude: { type: "array", items: { type: "string" }, description: "set: glob patterns to exclude, e.g. google/*" },
        include: { type: "array", items: { type: "string" }, description: "set: exclusion patterns to remove" },
        notes: { type: "array", items: { type: "string" }, description: "set: notes to keep, e.g. why a model is excluded" },
        clear: { type: "boolean", description: "set: forget the cast, exclusions and notes first" },
        run: RUN_ARG,
        stage: { type: "string", enum: STAGES, description: "start/next: the stage being launched" },
        seats: { type: "array", items: { type: "string" }, description: "start: the seats to launch; returns the model each one starts on (empty: seat dropped)" },
        seat: { type: "string", description: "next: the seat whose model failed (start: one seat)" },
        failed: { type: "string", description: "next: the model that failed; never used again in this run" },
        reason: { type: "string", description: "next: why, in a few words (503, no first response, stall, no output)" },
        stage1: SEAT_MODELS("anonymize: model each advisor answered on"),
        reviewers: SEAT_MODELS("tally: model each advisor reviewed on"),
        force: { type: "boolean", description: "anonymize: redo one that already ran" },
        seed: { type: "integer", description: "anonymize: fixed shuffle seed (tests only)" },
        shuffle: { type: "boolean", description: "anonymize: false keeps the seat order (tests only)" },
        title: { type: "string", description: "report: the run title, 3 to 5 words" },
        chairman: { type: "string", description: "report: model the chairman ran on" },
        failovers: {
          type: "array",
          description: "report: failovers not recorded with next (the plugin reads the run's failovers.json itself)",
          items: { type: "object", properties: { stage: { type: "string" }, seat: { type: "string" }, failed: { type: "string" }, reason: { type: "string" }, next: { type: "string" } } },
        },
      },
    },
    execute: async (args, ctx) => {
      const a = isObj(args) ? args : {};
      const fn = ACTIONS[a.action || "get"];
      if (!fn) fail(ACTION_ERROR);
      return fn(a, ctx);
    },
  },
];

async function onLoad() {
  try {
    const changed = installPersonas();
    personaStatus = changed.length ? `installed or updated: ${changed.join(", ")}` : "installed and up to date";
  } catch (e) {
    personaStatus = `could not install to ${personaTarget()}: ${e && e.message}`;
  }
  pruneStates();
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
    removePersonas();
  } catch {
    // best effort
  }
  states.clear();
}

module.exports = { onLoad, onUnload };
