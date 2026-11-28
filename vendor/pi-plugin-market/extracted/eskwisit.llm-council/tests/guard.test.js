"use strict";

// The council guard extension: Task calls that break the council's rules are blocked while a run
// is active; everything else, and every error, passes.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const url = require("node:url");
const { ROOT } = require("./helpers.js");

const HOUR = 60 * 60 * 1000;
let ext;
let base;

before(async () => {
  ext = await import(url.pathToFileURL(path.join(ROOT, "extension", "council-guard.js")).href);
  base = fs.mkdtempSync(path.join(os.tmpdir(), "llm-council-guard-"));
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

/** A workspace with the given run directories: { name: { files: {...}, ageMs } }. */
function workspace(runs = {}) {
  const cwd = fs.mkdtempSync(path.join(base, "ws-"));
  for (const [name, spec] of Object.entries(runs)) {
    const dir = path.join(cwd, ".llm-council", "runs", name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(spec.files || {})) fs.writeFileSync(path.join(dir, file), text);
    if (spec.ageMs) {
      const t = new Date(Date.now() - spec.ageMs);
      fs.utimesSync(dir, t, t);
    }
  }
  return cwd;
}

function guard() {
  const handlers = new Map();
  ext.default({ on: (name, fn) => handlers.set(name, fn) });
  return (toolName, input, cwd) => handlers.get("tool_call")({ toolName, input, toolCallId: "t1" }, { cwd });
}

const ACTIVE = { files: { "question.md": "Q" } };

describe("activeRun", () => {
  it("is the newest started, unreported, fresh run; none otherwise", () => {
    const cwd = workspace({
      "20260101-100000": { files: { "user_question.md": "old", "report.md": "done" } },
      "20260101-110000": ACTIVE,
      "20260101-120000": { files: { "notes.md": "no question yet" } },
    });
    assert.equal(path.basename(ext.activeRun(cwd)), "20260101-110000");
    assert.equal(ext.activeRun(workspace()), null);
    assert.equal(ext.activeRun(path.join(base, "missing")), null);
    assert.equal(ext.activeRun(workspace({ "20260101-110000": { files: { "question.md": "Q", "report.md": "R" } } })), null);
    assert.equal(ext.activeRun(workspace({ "20260101-110000": { ...ACTIVE, ageMs: 4 * HOUR } })), null);
    assert.ok(ext.activeRun(workspace({ "20260101-110000": { ...ACTIVE, ageMs: 2 * HOUR } })));
  });
});

describe("tool_call guard", () => {
  it("allows everything when no run is active", async () => {
    const call = guard();
    const cwd = workspace({ "20260101-110000": { files: { "question.md": "Q", "report.md": "R" } } });
    assert.equal(await call("Task", { agent: "fixer", prompt: "x" }, cwd), undefined);
    assert.equal(await call("Task", { agent: "council-contrarian", resume: "abc" }, cwd), undefined);
  });

  it("blocks generic sub-agents, resumed seats and failed models while a run is active", async () => {
    const call = guard();
    const cwd = workspace({
      "20260101-110000": { files: { "question.md": "Q", "failovers.json": JSON.stringify({ failed: ["xai/grok-x"], failovers: [] }) } },
    });
    for (const agent of ["explorer", "fixer", "code-reviewer", "test-runner", "ui-designer"]) {
      const r = await call("Task", { agent, prompt: "x" }, cwd);
      assert.equal(r.block, true, agent);
      assert.equal(r.reason, "LLM Council: seats run only on council-* personas (run .llm-council/runs/20260101-110000)");
    }
    const resumed = await call("Task", { agent: "council-contrarian", resume: "abc" }, cwd);
    assert.deepEqual(resumed, { block: true, reason: "LLM Council: every stage is a fresh delegation; never resume a seat" });
    const failed = await call("Task", { agent: "council-outsider", model: "xai/grok-x", prompt: "x" }, cwd);
    assert.deepEqual(failed, { block: true, reason: "LLM Council: model xai/grok-x failed earlier in this run; call council next / start for the replacement" });
    // allowed: a fresh seat on a live model, other agents, other tools
    assert.equal(await call("Task", { agent: "council-outsider", model: "anthropic/mid-1", prompt: "x" }, cwd), undefined);
    assert.equal(await call("Task", { agent: "council-chairman", prompt: "x" }, cwd), undefined);
    assert.equal(await call("Task", { agent: "my-own-agent", resume: "abc" }, cwd), undefined);
    assert.equal(await call("Read", { path: "x" }, cwd), undefined);
    assert.equal(await call("TaskStop", { id: "x" }, cwd), undefined);
  });

  it("fails open", async () => {
    const call = guard();
    assert.equal(await call("Task", { agent: "fixer" }, undefined), undefined);
    assert.equal(await call("Task", null, workspace({ "20260101-110000": ACTIVE })), undefined);
    const cwd = workspace({ "20260101-110000": { files: { "question.md": "Q", "failovers.json": "{ broken" } } });
    assert.equal(await call("Task", { agent: "council-outsider", model: "xai/grok-x" }, cwd), undefined);
    assert.equal(ext.failedModels(path.join(cwd, ".llm-council", "runs", "20260101-110000")).length, 0);
  });
});
