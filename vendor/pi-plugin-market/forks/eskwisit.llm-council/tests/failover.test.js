"use strict";

// Failover bookkeeping in the plugin: council start / next and the report reading failovers.json.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { loadMain, sandbox, fakePi, put, get, withHome } = require("./helpers.js");

const RUN = ".llm-council/runs/20260101-120000";
const CATALOG = ["anthropic/big-1", "anthropic/mid-1", "work/big-1", "xai/grok-x"];
const CAST = {
  contrarian: ["anthropic/big-1", "anthropic/mid-1"],
  "first-principles": ["anthropic/big-1", "xai/grok-x"],
  expansionist: ["xai/grok-x", "anthropic/mid-1"],
  outsider: ["xai/grok-x", "anthropic/mid-1"],
  executor: ["anthropic/mid-1", "anthropic/big-1"],
  chairman: ["anthropic/big-1", "anthropic/mid-1"],
};

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function fresh() {
  const dirs = sandbox();
  const restore = withHome(dirs.home);
  const pi = fakePi(dirs);
  const main = loadMain(pi);
  await main.onLoad();
  cleanups.push(async () => {
    await main.onUnload();
    restore();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  });
  await pi.call("council", { action: "set", models: CATALOG, cast: CAST });
  return { dirs, pi, t: main.__t };
}

describe("nextModel", () => {
  it("picks the first model that has not failed, optionally after a given one", async () => {
    const { t } = await fresh();
    const chain = ["a", "b", "c"];
    assert.equal(t.nextModel(chain, []), "a");
    assert.equal(t.nextModel(chain, ["a"]), "b");
    assert.equal(t.nextModel(chain, ["a"], "a"), "b");
    assert.equal(t.nextModel(chain, ["a", "b"], "a"), "c");
    assert.equal(t.nextModel(chain, ["b"], "b"), "c");
    assert.equal(t.nextModel(chain, ["a", "b", "c"], "c"), "");
    assert.equal(t.nextModel(chain, ["c"], "c"), "");
    assert.equal(t.nextModel(chain, ["zzz"], "zzz"), "a"); // a failed model outside the chain: start over
  });
});

describe("council start and next", () => {
  it("start gives every seat its first usable model; next records the failure and skips it everywhere", async () => {
    const { dirs, pi, t } = await fresh();
    put(dirs, `${RUN}/question.md`, "Q");
    const s1 = await pi.call("council", { action: "start", run: RUN, stage: "stage1", seats: Object.keys(CAST) });
    // the saved chain inserts the same model through another account after it
    assert.deepEqual(s1.models.contrarian, "anthropic/big-1");
    assert.deepEqual(s1.models.expansionist, "xai/grok-x");
    assert.deepEqual(s1.dropped, []);
    assert.equal(get(dirs, `${RUN}/failovers.json`), null);

    const n1 = await pi.call("council", { action: "next", run: RUN, stage: "stage1", seat: "contrarian", failed: "anthropic/big-1", reason: "503" });
    assert.deepEqual(n1, {
      next: "work/big-1",
      dropped: false,
      failed: ["anthropic/big-1"],
      failovers: [{ stage: "stage1", seat: "contrarian", failed: "anthropic/big-1", reason: "503", next: "work/big-1" }],
    });
    const file = JSON.parse(get(dirs, `${RUN}/failovers.json`));
    assert.deepEqual(file.failed, ["anthropic/big-1"]);
    assert.equal(file.failovers.length, 1);
    assert.deepEqual(await t.readFailovers(RUN), file);

    // a failed model is skipped by every later seat and stage
    const s2 = await pi.call("council", { action: "start", run: RUN, stage: "stage2", seats: ["first-principles", "chairman"] });
    assert.equal(s2.models["first-principles"], "work/big-1");
    assert.equal(s2.models.chairman, "work/big-1");

    const n2 = await pi.call("council", { action: "next", run: RUN, stage: "stage1", seat: "contrarian", failed: "work/big-1", reason: "stall" });
    assert.equal(n2.next, "anthropic/mid-1");
    const n3 = await pi.call("council", { action: "next", run: RUN, stage: "stage1", seat: "contrarian", failed: "anthropic/mid-1" });
    assert.deepEqual([n3.next, n3.dropped], ["", true]);
    assert.equal(n3.failovers[2].reason, "error");
    // all three failed: the chairman has nothing left
    const s3 = await pi.call("council", { action: "start", run: RUN, stage: "stage3", seat: "chairman" });
    assert.deepEqual(s3, { models: { chairman: "" }, dropped: ["chairman"], failed: ["anthropic/big-1", "work/big-1", "anthropic/mid-1"] });
  });

  it("validates run, stage, seat and model", async () => {
    const { pi } = await fresh();
    await assert.rejects(pi.call("council", { action: "next", run: "../x", stage: "stage1", seat: "contrarian", failed: "m" }), /run must be/);
    await assert.rejects(pi.call("council", { action: "next", run: RUN, stage: "stage9", seat: "contrarian", failed: "m" }), /stage must be/);
    await assert.rejects(pi.call("council", { action: "next", run: RUN, stage: "stage1", seat: "clerk", failed: "m" }), /unknown seat/);
    await assert.rejects(pi.call("council", { action: "next", run: RUN, stage: "stage1", seat: "contrarian" }), /failed must be/);
    await assert.rejects(pi.call("council", { action: "start", run: RUN, stage: "stage1" }), /seats must/);
    await assert.rejects(pi.call("council", { action: "start", run: RUN, stage: "stage1", seats: ["clerk"] }), /unknown seat/);
    await pi.call("council", { action: "set", clear: true });
    await assert.rejects(pi.call("council", { action: "start", run: RUN, seats: ["contrarian"] }), /no cast saved/);
  });
});

describe("council report and failovers.json", () => {
  it("lists the recorded failovers and merges any passed by hand", async () => {
    const { dirs, pi } = await fresh();
    put(dirs, `${RUN}/question.md`, "Q");
    await pi.call("council", { action: "next", run: RUN, stage: "stage1", seat: "outsider", failed: "xai/grok-x", reason: "503" });
    await pi.call("council", { action: "report", run: RUN, failovers: [
      { stage: "stage1", seat: "outsider", failed: "xai/grok-x", reason: "dup", next: "anthropic/mid-1" }, // same failover, dropped
      { stage: "stage3", seat: "chairman", failed: "anthropic/big-1", reason: "stall" },
    ] });
    const md = get(dirs, `${RUN}/report.md`);
    assert.match(md, /- stage1\/outsider: xai\/grok-x failed \(503\) -> anthropic\/mid-1/);
    assert.match(md, /- stage3\/chairman: anthropic\/big-1 failed \(stall\) -> no model left, seat dropped/);
    assert.ok(!md.includes("(dup)"));
    const tr = JSON.parse(get(dirs, `${RUN}/transcript.json`));
    assert.equal(tr.metadata.failovers.length, 2);
    assert.equal(tr.metadata.failovers[1].next, null);
  });

  it("tolerates a missing or broken failovers.json", async () => {
    const { dirs, pi, t } = await fresh();
    put(dirs, `${RUN}/question.md`, "Q");
    assert.deepEqual(await t.readFailovers(RUN), { failed: [], failovers: [] });
    put(dirs, `${RUN}/failovers.json`, "{ not json");
    assert.deepEqual(await t.readFailovers(RUN), { failed: [], failovers: [] });
    const s = await pi.call("council", { action: "start", run: RUN, seats: ["executor"] });
    assert.equal(s.models.executor, "anthropic/mid-1");
    await pi.call("council", { action: "report", run: RUN });
    assert.ok(!get(dirs, `${RUN}/report.md`).includes("### Failovers"));
  });
});
