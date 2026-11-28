"use strict";

// The four agent tools end to end on a fake host: config, anonymize, tally, report.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadMain, sandbox, fakePi, put, get, withHome } = require("./helpers.js");

const RUN = ".llm-council/runs/20260101-120000";
const CATALOG = ["anthropic/big-1", "anthropic/mid-1", "work/big-1", "xai/grok-x", "google/free-1", "openrouter/fast-1"];
const CAST = {
  contrarian: ["anthropic/big-1", "anthropic/mid-1"],
  "first-principles": ["anthropic/big-1", "xai/grok-x"],
  expansionist: ["xai/grok-x", "anthropic/mid-1"],
  outsider: ["xai/grok-x", "anthropic/mid-1"],
  executor: ["anthropic/mid-1", "anthropic/big-1"],
  chairman: ["anthropic/big-1", "anthropic/mid-1"],
};
const ANSWERS = {
  contrarian: "The fatal flaw is the timeline.",
  "first-principles": "What problem are we solving?",
  expansionist: "There is a much bigger market.",
  outsider: "I do not understand the jargon.",
  executor: "Start on Monday with step one.",
};
const MODELS = { contrarian: "anthropic/big-1", "first-principles": "anthropic/big-1", expansionist: "xai/grok-x", outsider: "xai/grok-x", executor: "anthropic/mid-1" };

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function fresh(options) {
  const dirs = sandbox();
  const restore = withHome(dirs.home);
  const pi = fakePi(dirs, options);
  const main = loadMain(pi);
  await main.onLoad();
  cleanups.push(async () => {
    await main.onUnload();
    restore();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  });
  return { dirs, pi, main, t: main.__t };
}

function seedRun(dirs, answers = ANSWERS) {
  put(dirs, `${RUN}/user_question.md`, "Should we port it?");
  put(dirs, `${RUN}/question.md`, "Framed: should the helper move to JavaScript?");
  for (const [seat, text] of Object.entries(answers)) put(dirs, `${RUN}/stage1/${seat}.md`, text);
}

function review(order) {
  return `Some analysis.\n\nFINAL RANKING:\n${order.map((l, i) => `${i + 1}. Response ${l}`).join("\n")}`;
}

describe("council get/set", () => {
  it("saves a validated cast, exclusions and notes in the plugin settings", async () => {
    const { pi } = await fresh();
    const out = await pi.call("council", { action: "set", models: CATALOG, exclude: ["google/*"], notes: ["Gemini is free tier"], cast: CAST });
    assert.deepEqual(out.cast.contrarian, ["anthropic/big-1", "work/big-1", "anthropic/mid-1"]);
    assert.equal(out.castUsable, true);
    assert.deepEqual(out.excludedModels, ["google/free-1"]);
    assert.deepEqual(pi.store.excludeModels, ["google/*"]);
    assert.deepEqual(pi.store.modelNotes, ["Gemini is free tier"]);
    assert.deepEqual(pi.store.cast.contrarian, ["anthropic/big-1", "work/big-1", "anthropic/mid-1"]);
    assert.match(out.personas, /installed/);
  });

  it("reports a saved cast as stale when a primary model leaves the catalog", async () => {
    const { pi } = await fresh();
    await pi.call("council", { action: "set", models: CATALOG, cast: CAST });
    const gone = await pi.call("council", { models: CATALOG.filter((m) => m !== "xai/grok-x") });
    assert.equal(gone.castUsable, false);
    assert.deepEqual(gone.staleSeats, ["expansionist", "outsider"]);
    assert.deepEqual(gone.cast["first-principles"], ["anthropic/big-1", "work/big-1"]); // the gone fallback is dropped
    const back = await pi.call("council", { models: CATALOG });
    assert.equal(back.castUsable, true);
  });

  it("rejects an invalid cast without saving it, and include/clear undo exclusions", async () => {
    const { pi } = await fresh();
    await pi.call("council", { action: "set", exclude: ["google/*", "xai/*"] });
    await assert.rejects(pi.call("council", { action: "set", models: CATALOG, cast: CAST }), /expansionist: xai\/grok-x is excluded/);
    assert.equal(pi.store.cast, undefined);
    const inc = await pi.call("council", { action: "set", include: ["xai/*"] });
    assert.deepEqual(inc.exclude, ["google/*"]);
    const cleared = await pi.call("council", { action: "set", clear: true });
    assert.deepEqual([cleared.exclude, cleared.notes, cleared.cast], [[], [], {}]);
    await assert.rejects(pi.call("council", { action: "drop" }), /action must be/);
  });
});

describe("council anonymize", () => {
  it("writes an anonymous review prompt, empties the Stage 1 files and refuses to run twice", async () => {
    const { dirs, pi } = await fresh();
    seedRun(dirs);
    const out = await pi.call("council", { action: "anonymize", run: RUN, stage1: MODELS, seed: 3 });
    assert.equal(out.responses, 5);
    const prompt = get(dirs, `${RUN}/stage2_prompt.md`);
    for (const text of Object.values(ANSWERS)) assert.ok(prompt.includes(text), text);
    for (const name of ["Contrarian", "First Principles", "Expansionist", "Outsider", "Executor", "anthropic/", "xai/"]) {
      assert.ok(!prompt.includes(name), `the review prompt leaks ${name}`);
    }
    for (const seat of Object.keys(ANSWERS)) assert.equal(get(dirs, `${RUN}/stage1/${seat}.md`), "");
    // nothing in the workspace maps labels to seats
    const all = fs.readdirSync(path.join(dirs.workspace, RUN), { recursive: true }).join(" ");
    assert.ok(!/label|map|cast/.test(all), all);
    await assert.rejects(pi.call("council", { action: "anonymize", run: RUN }), /already anonymized/);
    // force redoes it from the hidden answers
    const again = await pi.call("council", { action: "anonymize", run: RUN, force: true, seed: 4 });
    assert.equal(again.responses, 5);
  });

  it("skips empty answers and files that are not advisor seats, and fails with no answers", async () => {
    const { dirs, pi } = await fresh();
    seedRun(dirs, { contrarian: "only one", executor: "   " });
    put(dirs, `${RUN}/stage1/notes.md`, "stray");
    const out = await pi.call("council", { action: "anonymize", run: RUN, stage1: MODELS });
    assert.equal(out.responses, 1);
    assert.ok(out.warnings.some((w) => w.includes("notes.md")));
    const { dirs: d2, pi: p2 } = await fresh();
    put(d2, `${RUN}/question.md`, "Q");
    await assert.rejects(p2.call("council", { action: "anonymize", run: RUN }), /no Stage 1 answers/);
    const { pi: p3 } = await fresh();
    await assert.rejects(p3.call("council", { action: "anonymize", run: "../../etc" }), /run must be/);
  });
});

describe("council tally and report", () => {
  it("scores the reviews per advisor, writes the chairman prompt, then the report", async () => {
    const { dirs, pi, t } = await fresh();
    seedRun(dirs);
    await pi.call("council", { action: "anonymize", run: RUN, stage1: MODELS, shuffle: false });
    // without shuffling, labels follow the seat files sorted by name:
    // A contrarian, B executor, C expansionist, D first-principles, E outsider
    put(dirs, `${RUN}/stage2/contrarian.md`, review(["D", "A", "B", "C", "E"]));
    put(dirs, `${RUN}/stage2/executor.md`, review(["D", "B", "A", "C", "E"]));
    put(dirs, `${RUN}/stage2/outsider.md`, "I liked Response D best. No formal ranking.");
    const tally = await pi.call("council", { action: "tally", run: RUN, reviewers: { contrarian: "anthropic/mid-1" } });
    assert.equal(tally.streetCred[0].advisor, "The First Principles Thinker");
    assert.equal(tally.streetCred[0].average_rank, 1);
    assert.deepEqual(tally.parseWarnings.map((w) => w.seat), ["outsider"]);
    const agg = JSON.parse(get(dirs, `${RUN}/aggregate.json`));
    assert.equal(agg.stage2.find((r) => r.seat === "contrarian").model, "anthropic/mid-1");
    const chair = get(dirs, `${RUN}/stage3_prompt.md`);
    assert.match(chair, /### Response A: The Contrarian \(model: anthropic\/big-1\)/);
    assert.match(chair, /### Review by The Executor \(model: anthropic\/mid-1\)/);
    assert.ok(chair.includes(ANSWERS.contrarian));

    put(dirs, `${RUN}/stage3/chairman.md`, "## Where the Council Agrees\n- port it");
    put(dirs, `${RUN}/title.txt`, '"Port The Helper"\n');
    const rep = await pi.call("council", { action: "report",
      run: RUN,
      chairman: "anthropic/big-1",
      failovers: [{ stage: "stage1", seat: "outsider", failed: "xai/grok-x", reason: "503", next: "anthropic/mid-1" }],
    });
    assert.equal(rep.title, "Port The Helper");
    const md = get(dirs, `${RUN}/report.md`);
    assert.match(md, /^# Port The Helper/);
    assert.match(md, /_Chairman: anthropic\/big-1_/);
    assert.match(md, /- stage1\/outsider: xai\/grok-x failed \(503\) -> anthropic\/mid-1/);
    assert.match(md, /\| 1 \| D \| The First Principles Thinker \|/);
    assert.ok(md.includes(ANSWERS.outsider));
    const tr = JSON.parse(get(dirs, `${RUN}/transcript.json`));
    assert.equal(tr.user_question, "Should we port it?");
    assert.equal(tr.metadata.label_map["Response A"].seat, "contrarian");
    assert.equal(tr.stage1.length, 5);
    assert.ok(t.states.has(RUN));
  });

  it("keeps the run state across a plugin restart", async () => {
    const { dirs, pi, main } = await fresh();
    seedRun(dirs);
    await pi.call("council", { action: "anonymize", run: RUN, stage1: MODELS });
    put(dirs, `${RUN}/stage2/executor.md`, review(["A", "B", "C", "D", "E"]));
    await main.onUnload();
    const pi2 = fakePi(dirs);
    const main2 = loadMain(pi2);
    await main2.onLoad();
    cleanups.push(() => main2.onUnload());
    const tally = await pi2.call("council", { action: "tally", run: RUN });
    assert.equal(tally.streetCred.length, 5);
    assert.ok(get(dirs, `${RUN}/stage3_prompt.md`).includes(ANSWERS.executor));
  });

  it("refuses to tally before anonymizing, and reports a run where every advisor failed", async () => {
    const { dirs, pi } = await fresh();
    put(dirs, `${RUN}/question.md`, "Q");
    await assert.rejects(pi.call("council", { action: "tally", run: RUN }), /anonymize first/);
    const rep = await pi.call("council", { action: "report", run: RUN });
    assert.equal(rep.title, "LLM Council");
    assert.match(get(dirs, `${RUN}/report.md`), /All models failed to respond/);
  });
});
