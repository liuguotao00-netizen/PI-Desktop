"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "usage-scopes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "sessions"));
  const db = new DatabaseSync(path.join(dir, "pi.sqlite"));
  db.exec(`create table sessions (id text, title text, model_id text, provider_id text, thinking_level text, updated_at text, created_at text, deleted_at text);
    create table turns (session_id text, status text, input_tokens integer, output_tokens integer, usage_json text);`);
  db.close();
  const context = vm.createContext({ require, module: { exports: {} }, pi: {
    plugin: { getDataPath: async () => path.join(dir, "plugins/data/io.github.new-beginner.session-usage") },
    app: { getLocale: async () => "zh-CN", getAppearance: async () => ({ locale: "zh-CN" }) },
  } });
  vm.runInContext(source + "\nglobalThis.api = { parseJsonlUsage, buildUsageScopes, buildReport, mergeUsageSources };", context);
  const write = (id, rows) => {
    const file = path.join(dir, "sessions", id + ".jsonl");
    fs.writeFileSync(file, [JSON.stringify({ type: "session", sessionId: id }),
      ...rows.map(row => typeof row === "string" ? row : JSON.stringify(row))].join("\n") + "\n");
    return file;
  };
  return { ...context.api, write, dir, report: id => context.api.buildReport(id, {}) };
}
function reply(id, parent, usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 200, reasoningTokens: 8 }, extra = {}) {
  return { type: "message", role: "assistant", id, blocks: [{ type: "text", text: "PRIVATE_CHAT_BODY" }],
    createdAt: "2026-10-11T00:00:00Z", meta: { usage, modelId: "same-model", providerId: "same-provider", status: "complete",
      ...(parent ? { parentToolCallId: parent, agentName: "fixer" } : {}), ...extra } };
}
function task(callId, delegationId, status = "completed") {
  return { type: "message", role: "tool", toolName: "Task", blocks: [{ type: "tool_call", name: "Task", callId,
    args: { task: "PRIVATE_TASK_BODY" }, result: { content: [{ type: "text", text: "PRIVATE_RESULT_BODY" }],
      details: { delegationId, agent: "fixer", status, modelId: "same-model" } } }] };
}
const scope = (r, id) => r.scopes.find(row => row.id === id);

test("same model and agent name do not merge identities; report totals are a disjoint union", async t => {
  const h = setup(t);
  h.write("A", [task("call-A", "delegate-A"), task("call-B", "delegate-B"), reply("m", null), reply("a", "call-A"), reply("b", "call-B")]);
  const r = await h.report("A");
  assert.equal(r.scopes.length, 5);
  for (const id of ["main", "agent:call-A", "agent:call-B"]) {
    const s = scope(r, id); assert.equal(s.replies, 1); assert.equal(s.totals.total, 328);
    assert.equal(s.history[0].agentId, id); assert.equal(s.complete, true);
  }
  assert.equal(scope(r, "subagents").replies, 2);
  assert.equal(r.totals.total, 984); assert.equal(r.byModel.length, 1); assert.equal(r.byModel[0].replies, 3);
  assert.equal(scope(r, "agent:call-A").delegationId, "delegate-A");
  assert.equal(scope(r, "agent:call-B").delegationId, "delegate-B");
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_|blocks|toolArguments/);
});

test("only the selected transcript is counted even if model, name, time and call IDs coincide", async t => {
  const h = setup(t);
  h.write("A", [task("shared-call", "A-child"), reply("m", null), reply("a", "shared-call")]);
  h.write("B", [task("shared-call", "B-child"), reply("b", "shared-call", { inputTokens: 9000 })]);
  const a = await h.report("A"), b = await h.report("B");
  assert.equal(a.totals.input, 200); assert.equal(b.totals.input, 9000);
  assert.equal(scope(a, "agent:shared-call").delegationId, "A-child");
  assert.equal(scope(b, "agent:shared-call").delegationId, "B-child");
  assert.equal((await h.report("A")).totals.input, 200);
});

test("duplicate snapshots and operation aliases count once; identical IDs in distinct agents remain distinct", async t => {
  const h = setup(t);
  const one = reply("same-id", "call-A", { inputTokens: 10, operationId: "op" });
  const updated = reply("same-id", "call-A", { inputTokens: 20, operationId: "op" });
  const alias = reply("new-id", "call-A", { inputTokens: 20, operationId: "op" });
  h.write("A", [task("call-A", "a"), task("call-A", "a"), task("call-B", "b"), one, one, updated, alias,
    reply("same-id", "call-B", { inputTokens: 30, operationId: "op-B" }), reply("same-id", null, { inputTokens: 40, operationId: "op-main" })]);
  const r = await h.report("A");
  assert.equal(r.replies, 3); assert.equal(r.totals.input, 90);
  assert.equal(r.scopes.length, 5); assert.equal(scope(r, "agent:call-A").replies, 1);
  assert.equal(scope(r, "agent:call-A").totals.input, 20);
  assert.equal(new Set(r.history.map(row => row.key)).size, 3);
  assert.ok(r.history.every(row => !row.key.includes("\0")));
  assert.equal((await h.report("A")).totals.input, 90);
});

test("hit rate is recomputed from summed cache and prompt, never average of percentages", async t => {
  const h = setup(t);
  h.write("A", [task("a", "a"), reply("m", null, { inputTokens: 10, cacheReadTokens: 90 }),
    reply("a", "a", { inputTokens: 900, cacheReadTokens: 100, cacheWriteTokens: 100, reasoningTokens: 12 })]);
  const r = await h.report("A");
  assert.equal(r.totals.hitRate, 190 / 1200); assert.equal(r.totals.prompt, 1200);
  assert.equal(r.totals.reasoning, 12); assert.equal(r.totals.cacheWrite, 100);
  assert.equal(r.byModel[0].tokens.hitRate, 190 / 1200);
});

test("empty session and no children are known empty, not stale usage", async t => {
  const h = setup(t); h.write("A", []);
  const r = await h.report("A");
  assert.equal(r.scopes.length, 3); assert.equal(r.replies, 0); assert.equal(r.complete, true);
  assert.equal(scope(r, "subagents").unavailable, false); assert.equal(scope(r, "subagents").last, null);
});

test("a declared child without usage is unavailable and makes total incomplete, never complete zero", async t => {
  const h = setup(t); h.write("A", [reply("m", null), task("a", "a")]);
  const r = await h.report("A");
  assert.equal(scope(r, "main").complete, true); assert.equal(r.complete, false); assert.equal(r.unavailable, false);
  assert.equal(scope(r, "agent:a").unavailable, true); assert.equal(scope(r, "subagents").unavailable, true);
  assert.ok(r.issues.includes("missing_agent_usage")); assert.equal(r.totals.input, 100);
});

test("child metadata establishes identity and known usage without needing whole-task settlement", async t => {
  const h = setup(t); h.write("A", [reply("a", "a")]);
  const r = await h.report("A");
  assert.equal(scope(r, "main").replies, 0); assert.equal(scope(r, "agent:a").replies, 1);
  assert.equal(scope(r, "agent:a").complete, true); assert.equal(scope(r, "agent:a").availability, "available");
});

test("missing identity never charged to main; bad lines and missing/invalid usage flag incompleteness", async t => {
  const h = setup(t); h.write("A", [reply("m", null), reply("orphan", null, { inputTokens: 9999 }, { agentName: "fixer" }),
    task("a", "a"), reply("a", "a", {}), "{broken"]);
  const r = await h.report("A");
  assert.equal(r.totals.input, 10099); assert.equal(scope(r, "main").totals.input, 100);
  assert.equal(scope(r, "subagents").replies, 0); assert.equal(r.history.find(row => row.id === "orphan").agentId, "unknown");
  assert.equal(r.malformed, 1); assert.equal(r.complete, false);
  assert.ok(r.issues.includes("unconfirmed_agent_identity")); assert.ok(r.issues.includes("missing_usage"));
  assert.ok(r.issues.includes("malformed_records"));
});

test("explicit zero is observed zero; running and partially recorded children are clearly incomplete", async t => {
  const h = setup(t); h.write("A", [task("a", "a", "running"), reply("a0", "a", { inputTokens: 0, outputTokens: 0 }),
    reply("pending", "a", undefined, { usage: undefined, status: "streaming" })]);
  let r = await h.report("A");
  assert.equal(scope(r, "agent:a").replies, 1); assert.equal(scope(r, "agent:a").unavailable, false);
  assert.equal(scope(r, "agent:a").running, true); assert.equal(r.complete, false);
  assert.ok(r.issues.includes("pending_usage"));
  h.write("A", [task("a", "a"), reply("a0", "a", { inputTokens: 0, outputTokens: 0 })]);
  r = await h.report("A"); assert.equal(r.complete, true); assert.equal(r.totals.total, 0);
});

test("missing transcript and mismatched session header cannot produce a complete total", t => {
  const h = setup(t);
  const missing = h.buildUsageScopes(h.parseJsonlUsage(path.join(h.dir, "missing"), "A"));
  assert.equal(missing[0].unavailable, true); assert.ok(missing[0].issues.includes("missing_transcript"));
  const file = h.write("B", [reply("b", null)]);
  const mismatch = h.buildUsageScopes(h.parseJsonlUsage(file, "A"));
  assert.equal(mismatch[0].replies, 0); assert.equal(mismatch[0].unavailable, true);
  assert.ok(mismatch[0].issues.includes("session_identity_mismatch"));
});

test("Task result JSON strings are supported without using result prose as metadata", async t => {
  const h = setup(t), row = task("a", "delegated");
  row.blocks[0].result = JSON.stringify(row.blocks[0].result);
  h.write("A", [row, reply("a", "a")]);
  assert.equal(scope(await h.report("A"), "agent:a").delegationId, "delegated");
});

test("later wait/list/stop metadata settles only matching delegation, without double counting", async t => {
  const h = setup(t);
  const snapshot = (name, details) => ({ type: "message", role: "tool", toolName: name,
    blocks: [{ type: "tool_call", name, callId: name, result: { details } }] });
  h.write("A", [task("a", "a", "running"), task("b", "b", "running"), reply("a", "a"), reply("b", "b"),
    snapshot("TaskWait", { delegations: [{ delegationId: "a", status: "completed" }] }),
    snapshot("TaskStop", { stopped: [{ delegationId: "b", status: "stopped" }] }),
    snapshot("TaskList", { delegations: [{ delegationId: "a", status: "completed" }, { delegationId: "b", status: "stopped" }] })]);
  const r = await h.report("A");
  assert.equal(r.complete, true); assert.equal(r.replies, 2);
  assert.equal(scope(r, "agent:a").running, false); assert.equal(scope(r, "agent:b").status, "stopped");
});

test("delegation-only metadata without a call mapping is visible but unavailable, never guessed by name", async t => {
  const h = setup(t);
  h.write("A", [{ type: "message", role: "tool", toolName: "TaskWait", blocks: [{ type: "tool_call", name: "TaskWait",
    result: { details: { delegations: [{ delegationId: "unmapped", agent: "fixer", status: "completed" }] } } }] }]);
  const r = await h.report("A");
  assert.equal(r.scopes.length, 4); assert.equal(r.scopes[3].delegationId, "unmapped");
  assert.equal(r.scopes[3].unavailable, true); assert.equal(r.complete, false);
});

test("running parent never hides known main or child usage", t => {
  const h = setup(t), file = h.write("A", [reply("m", null), task("a", "a", "running"), reply("a", "a")]);
  const scopes = h.buildUsageScopes(h.parseJsonlUsage(file, "A"), true);
  assert.equal(scopes[0].complete, true); assert.equal(scopes[0].unavailable, false); assert.equal(scopes[0].replies, 2);
  assert.equal(scopes[1].running, true); assert.equal(scopes[2].running, true);
});

test("pending usage and real read failure have different availability", t => {
  const h = setup(t);
  const pending = h.buildUsageScopes(h.parseJsonlUsage(h.write("A", [reply("m", null, {}, { status: "streaming" })]), "A"), true);
  assert.equal(pending[0].availability, "pending"); assert.equal(pending[0].unavailable, true);
  const failed = h.buildUsageScopes(h.parseJsonlUsage(h.dir, "A"));
  assert.equal(failed[0].availability, "failed"); assert.ok(failed[0].issues.includes("unreadable_transcript"));
});

test("streaming counters are never counted as completed model usage", async t => {
  const h = setup(t); h.write("A", [reply("known", null, { inputTokens: 12, outputTokens: 3 }),
    reply("streaming", "a", { inputTokens: 999, outputTokens: 123 }, { status: "streaming" })]);
  const r = await h.report("A"); assert.equal(r.replies, 1); assert.equal(r.totals.input, 12);
  assert.equal(scope(r, "subagents").replies, 0); assert.equal(scope(r, "subagents").availability, 'pending');
  assert.ok(r.issues.includes('pending_usage'));
});

test("resume calls retain one numbered child, status, history and exact totals", async t => {
  const h = setup(t);
  h.write("A", [task("first", "same", "running"), reply("a", "first"), task("second", "same", "running"), reply("b", "second"),
    task("third", "other"), reply("c", "third"), task("second", "same", "completed")]);
  const r = await h.report("A"), children = r.scopes.filter(s => s.kind === "agent");
  assert.equal(children.length, 2); assert.equal(children[0].ordinal, 1); assert.equal(children[1].ordinal, 2);
  assert.equal(children[0].delegationId, "same"); assert.equal(children[0].replies, 2); assert.equal(children[0].running, false);
  assert.deepEqual(Array.from(children[0].callIds), ["first", "second"]);
  assert.ok(children[0].history.every(row => row.agentOrdinal === 1 && row.delegationId === "same"));
  assert.equal(r.replies, 3); assert.equal(r.byModel.length, 1); assert.equal(r.byModel[0].replies, 3);
  assert.equal(children.reduce((n, s) => n + s.totals.total, 0), r.totals.total);
});

test("a repeated operation under resume aliases is not an ownership conflict", async t => {
  const h = setup(t);
  h.write("A", [task("first", "same"), task("second", "same"),
    reply("a", "first", { operationId: "one", inputTokens: 10 }), reply("b", "second", { operationId: "one", inputTokens: 10 })]);
  const r = await h.report("A");
  assert.equal(r.replies, 1); assert.equal(r.scopes.filter(s => s.kind === "agent").length, 1);
  assert.equal(scope(r, "agent:first").replies, 1); assert.equal(r.reconciliation.unknown.replies, 0);
});

test("model aggregation combines main and distinct children while preserving unknown models", async t => {
  const h = setup(t);
  h.write("A", [task("a", "a"), task("b", "b"), reply("m", null, { inputTokens: 10 }),
    reply("a", "a", { inputTokens: 20 }), reply("b", "b", { inputTokens: 30 }, { modelId: "other-model" }),
    reply("unknown-model", null, { inputTokens: 40 }, { modelId: "" })]);
  const r = await h.report("A");
  assert.equal(r.byModel.length, 3);
  const shared = r.byModel.find(row => row.modelId === "same-model");
  assert.equal(shared.replies, 2); assert.equal(shared.tokens.input, 30);
  assert.equal(r.byModel.find(row => row.modelId === "unknown").tokens.input, 40);
  assert.equal(r.byModel.reduce((n, row) => n + row.tokens.input, 0), r.totals.input);
});

test("cross-source resume aliases with delayed tool metadata do not create a duplicate child", t => {
  const h = setup(t);
  const parsed = h.parseJsonlUsage(h.write("A", [task("first", "same"), task("second", "same"), reply("one", "first")]), "A");
  const queued = h.parseJsonlUsage(null, "A", [reply("two", "second")], "outbox");
  const merged = h.mergeUsageSources(parsed, { replies: [], issues: [] }, queued);
  const children = h.buildUsageScopes(merged).filter(s => s.kind === "agent");
  assert.equal(children.length, 1); assert.equal(children[0].replies, 2); assert.equal(children[0].delegationId, "same");
});
