"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");

function setup(t, operations, messages = []) {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "usage-reconciliation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "sessions"));
  const db = new DatabaseSync(path.join(dir, "pi.sqlite"));
  db.exec(`create table sessions (id text, title text, model_id text, provider_id text, thinking_level text, updated_at text, created_at text, deleted_at text);
    create table turns (session_id text, status text, input_tokens integer, output_tokens integer, usage_json text);`);
  db.prepare("insert into turns values (?, ?, ?, ?, ?)").run("A", "completed", 0, 0, JSON.stringify(operations));
  db.close();
  const write = rows => fs.writeFileSync(path.join(dir, "sessions/A.jsonl"),
    [JSON.stringify({ type: "session", sessionId: "A" }), ...rows.map(JSON.stringify)].join("\n") + "\n");
  write(messages);
  const context = vm.createContext({ require, module: { exports: {} }, pi: {
    plugin: { getDataPath: async () => path.join(dir, "plugins/data/io.github.new-beginner.session-usage") },
    app: { getLocale: async () => "zh-CN", getAppearance: async () => ({ locale: "zh-CN" }) },
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../main.js"), "utf8") + "\nglobalThis.report = buildReport;", context);
  return { write, report: () => context.report("A", {}) };
}
const usage = (operationId, n) => ({ operationId, inputTokens: n, outputTokens: 3, cacheReadTokens: 7,
  cacheWriteTokens: 2, reasoningTokens: 1, totalTokens: n + 12 });
const message = (id, part, parent = "") => ({ type: "message", id, role: "assistant",
  meta: { status: "complete", usage: part, parentToolCallId: parent } });
function assertBalanced(r) {
  const p = r.reconciliation;
  assert.ok(p, "report must expose its unassigned usage, not hide the difference");
  assert.equal(p.summaryOnly, false);
  assert.equal(p.all.replies, p.main.replies + p.subagents.replies + p.unknown.replies);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h", "reasoning", "total", "prompt"])
    assert.equal(p.all.totals[key], p.main.totals[key] + p.subagents.totals[key] + p.unknown.totals[key], key);
  assert.equal(p.all.replies, r.replies);
  assert.equal(p.all.totals.total, r.totals.total);
}

test("database-only operations are an explicit residual, never fabricated main/child rounds", async t => {
  const m = usage("main", 10), s = usage("child", 20), u = usage("unassigned", 47023);
  const h = setup(t, { operations: [m, s, u] }, [message("m", m), message("s", s, "call")]);
  const r = await h.report(); assertBalanced(r);
  assert.equal(r.reconciliation.unknown.replies, 1);
  assert.equal(r.reconciliation.unknown.totals.total, 47035);
  assert.equal(r.reconciliation.main.replies, 1); assert.equal(r.reconciliation.subagents.replies, 1);
  assert.equal(r.reconciliation.unknown.totals.hitRate, 7 / 47032);
});
test("late exact lineage reclassifies the residual without changing totals or request count", async t => {
  const part = usage("late", 100);
  const h = setup(t, { operations: [part, part] });
  const before = await h.report(); assertBalanced(before); assert.equal(before.reconciliation.unknown.replies, 1);
  h.write([message("late", part, "call")]);
  const after = await h.report(); assertBalanced(after);
  assert.equal(after.reconciliation.unknown.replies, 0); assert.equal(after.reconciliation.subagents.replies, 1);
  assert.equal(after.totals.total, before.totals.total); assert.equal(after.replies, before.replies);
});
test("conflicting lineage remains in the visible residual and counts only once", async t => {
  const part = usage("conflict", 100);
  const h = setup(t, { operations: [part] }, [message("m", part), message("s", part, "call")]);
  const r = await h.report(); assertBalanced(r);
  assert.equal(r.reconciliation.unknown.replies, 1); assert.equal(r.replies, 1);
  assert.equal(r.reconciliation.main.replies, 0); assert.equal(r.reconciliation.subagents.replies, 0);
});
test("zero-token unknown requests are still reconciled by count", async t => {
  const h = setup(t, { operations: [{ operationId: "zero", inputTokens: 0, outputTokens: 0 }] });
  const r = await h.report(); assertBalanced(r);
  assert.equal(r.reconciliation.unknown.replies, 1); assert.equal(r.reconciliation.unknown.totals.total, 0);
});
test("aggregate-only usage never invents a model request count or balanced partition", async t => {
  const h = setup(t, { inputTokens: 100, outputTokens: 20, aggregation: "aggregate" });
  const r = await h.report(); assert.ok(r.reconciliation);
  assert.equal(r.reconciliation.summaryOnly, true); assert.equal(r.reconciliation.all.totals.total, 120);
  assert.equal(r.reconciliation.all.replies, null); assert.equal(r.reconciliation.unknown.replies, null);
});
