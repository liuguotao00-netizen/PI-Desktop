"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const scope = (report, id) => report.scopes.find(s => s.id === id);
const op = (operationId, inputTokens = 10, outputTokens = 2) => ({ operationId, modelId: "same-model", providerId: "same-provider", inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
const reply = (id, usage, parent) => ({ type: "message", role: "assistant", id, createdAt: "2026-10-11T10:00:00Z",
  blocks: [{ type: "text", text: "PRIVATE_MESSAGE" }], meta: { status: "complete", modelId: "same-model", usage,
    ...(parent ? { parentToolCallId: parent, agentName: "fixer" } : {}), responseDurationMs: 321 } });
function setup(t, journal = "wal", watchDisabled = false) {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "usage-sources-"));
  const sessions = path.join(dir, "sessions"), dbFile = path.join(dir, "pi.sqlite");
  fs.mkdirSync(sessions);
  const db = new DatabaseSync(dbFile);
  db.exec(`pragma journal_mode=${journal}; pragma wal_autocheckpoint=0;
    create table sessions (id text primary key, title text, model_id text, provider_id text, thinking_level text, updated_at text, created_at text, deleted_at text);
    create table turns (id text primary key, session_id text, status text, input_tokens integer, output_tokens integer, usage_json text);`);
  let settings = {}, publications = 0, sequence = 0, readGate = null, failDatabase = false;
  const context = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout,
    require: name => name === "node:fs" && watchDisabled ? { ...fs, watch: () => { throw new Error("synthetic watcher unavailable"); } } : name === "node:sqlite" ? { DatabaseSync: function(file, options) {
      if (failDatabase && options?.readOnly) throw new Error("synthetic source unavailable");
      return new DatabaseSync(file, options);
    } } : require(name),
    pi: { app: { getLocale: async () => "zh-CN", getAppearance: async () => ({ locale: "zh-CN" }) },
      plugin: { getDataPath: async () => {
        if (readGate) { const gate = readGate; readGate = null; gate.enter(); await gate.promise; }
        return path.join(dir, "plugins/data/io.github.new-beginner.session-usage");
      }, getSettings: async () => settings,
        setSettings: async value => { settings = JSON.parse(JSON.stringify(value)); publications++; } },
      commands: { register: async () => {}, unregister: async () => {} }, ui: { showToast: async () => {} } } });
  vm.runInContext(source + "\nglobalThis.build = buildReport;", context);
  const plugin = context.module.exports;
  t.after(async () => { await plugin.onUnload(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const write = (id, rows = []) => {
    db.prepare("insert or ignore into sessions values (?, 'Synthetic', 'same-model', 'same-provider', '', '', '', null)").run(id);
    fs.writeFileSync(path.join(sessions, id + ".jsonl"), [JSON.stringify({ type: "session", sessionId: id }), ...rows.map(r => typeof r === "string" ? r : JSON.stringify(r))].join("\n") + "\n");
  };
  const put = (id, operations, extra = {}, status = "completed", turnId = id + "-turn") => {
    const usage = { aggregation: "aggregate", inputTokens: operations.reduce((n, op) => n + op.inputTokens, 0),
      outputTokens: operations.reduce((n, op) => n + op.outputTokens, 0), totalTokens: operations.reduce((n, op) => n + op.totalTokens, 0), operations, ...extra };
    db.prepare("insert into turns values (?, ?, ?, ?, ?, ?) on conflict(id) do update set status=excluded.status, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, usage_json=excluded.usage_json")
      .run(turnId, id, status, usage.inputTokens, usage.outputTokens, JSON.stringify(usage));
  };
  const switchTo = id => plugin.onRendererCall("usage.setContext", { instance: "source-tests", sequence: ++sequence, status: "active", sessionId: id });
  const queueFile = path.join(dir, "session-message-outbox.json");
  const queue = (entries, atomic = false) => {
    const file = atomic ? queueFile + ".tmp" : queueFile;
    fs.writeFileSync(file, typeof entries === "string" ? entries : JSON.stringify(entries));
    if (atomic) fs.renameSync(file, queueFile);
  };
  const checkpoint = (id, message, changes = {}) => {
    const file = path.join(sessions, id + ".inflight.json");
    fs.writeFileSync(file + ".tmp", JSON.stringify({ schema: 1, sessionId: id, turnId: id + "-turn",
      savedAt: "2026-10-12T00:00:00Z", message: { ...message, type: undefined }, ...changes }));
    fs.renameSync(file + ".tmp", file);
  };
  return { plugin, db, dbFile, sessions, queueFile, queue, write, put, switchTo, checkpoint,
    settings: () => settings, publications: () => publications,
    report: id => context.build(id, {}), current: () => settings.lastReport,
    start: async id => { await plugin.onLoad(); switchTo(id); return plugin.onPanelInvoke("usage.get"); },
    failDatabase: value => { failDatabase = value; },
    holdRead: () => {
      let release, enter;
      const promise = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
      return (readGate = { promise, entered, release, enter });
    } };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitReport(h, predicate) {
  const start = performance.now();
  while (!predicate(h.current()) && performance.now() - start < 950) await pause(5);
  assert.ok(predicate(h.current()), "database-only usage update within one second");
  return Math.round(performance.now() - start);
}

test("missing JSONL assistants: actual-shape operation is visible in Total with unknown ownership", async t => {
  const h = setup(t); h.write("A"); h.put("A", [op("physical", 23423, 34)]);
  const r = await h.report("A");
  assert.equal(r.replies, 1); assert.equal(r.totals.input, 23423); assert.equal(r.totals.output, 34); assert.equal(r.totals.total, 23457);
  assert.equal(r.history.length, 1); assert.equal(r.last.agentId, "unknown"); assert.equal(r.last.createdAt, null); assert.equal(r.last.durationMs, null);
  assert.equal(r.byModel[0].modelId, "same-model"); assert.equal(r.byModel[0].tokens.total, 23457);
  assert.equal(scope(r, "main").replies, 0); assert.equal(scope(r, "subagents").replies, 0);
  assert.equal(r.sourceCoverage.unknownRecords, 1); assert.ok(r.issues.includes("unknown_usage_identity"));
  assert.ok(scope(r, "main").issues.includes("partition_incomplete"));
});

test("singleton operation at usage root is not mistaken for a legacy aggregate", async t => {
  const h = setup(t); h.write("A"); h.put("A", [], { ...op("singleton"), operations: undefined, aggregation: "operation" });
  const r = await h.report("A"); assert.equal(r.replies, 1); assert.equal(r.totals.total, 12); assert.equal(r.summaryOnly, false);
});

test("partial JSONL, duplicate operations within/across turns and later snapshots form one canonical union", async t => {
  const h = setup(t), main = op("main", 20, 3), child = op("child", 30, 4), unknown = op("unknown", 40, 5);
  h.write("A", [reply("m", main)]); h.put("A", [main, child, child, unknown]); h.put("A", [main], {}, "completed", "duplicate-turn");
  let r = await h.report("A"); assert.equal(r.replies, 3); assert.equal(r.totals.input, 90); assert.equal(r.totals.total, 102);
  assert.equal(scope(r, "main").totals.input, 20); assert.equal(scope(r, "subagents").replies, 0);
  const keys = r.history.map(row => row.key);
  h.write("A", [reply("m", main), reply("c", child, "call-child"), reply("alias", child, "call-child")]);
  r = await h.report("A"); assert.equal(r.replies, 3); assert.equal(r.totals.input, 90);
  assert.equal(scope(r, "subagents").totals.input, 30); assert.equal(r.sourceCoverage.unknownRecords, 1);
  assert.deepEqual(r.history.map(row => row.key), keys); assert.doesNotMatch(JSON.stringify(r), /PRIVATE_MESSAGE|blocks|"cost"/);
});

test("stale JSONL cannot lower newer database counters for the same operation", async t => {
  const h = setup(t); h.write("A", [reply("a", op("op", 10, 2), "child")]); h.put("A", [op("op", 50, 5)]);
  const r = await h.report("A"); assert.equal(r.replies, 1); assert.equal(r.totals.total, 55); assert.equal(scope(r, "subagents").totals.total, 55);
});

test("host legacy message identity and desktopUsage retained identity both deduplicate exactly", async t => {
  const h = setup(t); h.write("A", [reply("legacy", { inputTokens: 10, outputTokens: 2 }),
    reply("native", { input: 20, output: 3, desktopUsage: op("native-uuid", 20, 3) }, "child")]);
  h.put("A", [op("message:A:legacy"), op("native-uuid", 20, 3)]);
  const r = await h.report("A"); assert.equal(r.replies, 2); assert.equal(r.totals.total, 35);
  assert.equal(scope(r, "main").replies, 1); assert.equal(scope(r, "subagents").replies, 1); assert.equal(r.sourceCoverage.unknownRecords, 0);
});

test("unverified database lineage, matching models and timestamps never infer ownership", async t => {
  const h = setup(t); h.write("A", [reply("main", op("main"))]);
  h.put("A", [op("main"), { ...op("other", 90, 9), parentToolCallId: "invented", agentName: "fixer", createdAt: "2026-10-11T10:00:00Z" }]);
  const r = await h.report("A"); assert.equal(r.totals.input, 100); assert.equal(scope(r, "main").totals.input, 10);
  assert.equal(scope(r, "subagents").replies, 0); assert.equal(r.sourceCoverage.unknownRecords, 1);
  assert.equal(r.history[1].createdAt, null);
});

test("conflicting lineage for one operation counts once in Total, neither known partition", async t => {
  const h = setup(t); h.write("A", [reply("a", op("shared"), "child-A"), reply("b", op("shared"), "child-B")]); h.put("A", [op("shared")]);
  const r = await h.report("A"); assert.equal(r.replies, 1); assert.equal(r.totals.total, 12);
  assert.equal(scope(r, "main").replies, 0); assert.equal(scope(r, "subagents").replies, 0);
  assert.ok(r.issues.includes("conflicting_agent_identity")); assert.equal(r.last.agentId, "unknown");
});

test("aggregate only: cumulative tokens are available without fabricated reply history, detail or model", async t => {
  const h = setup(t); h.write("A"); h.put("A", [], { inputTokens: 80, outputTokens: 9, totalTokens: 89 });
  const r = await h.report("A"); assert.equal(r.replies, 0); assert.equal(r.totals.total, 89); assert.equal(r.hasTotals, true);
  assert.equal(r.summaryOnly, true); assert.equal(r.unavailable, false); assert.equal(r.history.length, 0); assert.equal(r.last, null); assert.equal(r.byModel.length, 0);
  assert.ok(r.issues.includes("aggregate_only_usage")); assert.equal(scope(r, "main").hasTotals, false);
});

test("aggregate and identified records are not stacked; remainder and legacy coverage are explicit", async t => {
  const h = setup(t); h.write("A", [reply("m", op("m"))]); h.put("A", [op("m")], { inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  h.put("A", [], { inputTokens: 500, outputTokens: 50, totalTokens: 550 }, "completed", "legacy-turn");
  const r = await h.report("A"); assert.equal(r.totals.total, 12); assert.equal(r.replies, 1);
  assert.ok(r.issues.includes("aggregate_remainder")); assert.ok(r.issues.includes("aggregate_only_usage")); assert.equal(r.complete, false);
});

test("readable operations survive missing/unreadable/mismatched JSONL; no cross-session leakage", async t => {
  const h = setup(t); h.write("A"); h.write("B", [reply("same", op("op", 9999, 5))]); h.put("A", [op("op")]); h.put("B", [op("op", 9999, 5)]);
  fs.unlinkSync(path.join(h.sessions, "A.jsonl"));
  let r = await h.report("A"); assert.equal(r.totals.total, 12); assert.ok(r.issues.includes("missing_transcript"));
  fs.mkdirSync(path.join(h.sessions, "A.jsonl")); r = await h.report("A"); assert.equal(r.replies, 1); assert.ok(r.issues.includes("unreadable_transcript"));
  fs.rmdirSync(path.join(h.sessions, "A.jsonl")); fs.copyFileSync(path.join(h.sessions, "B.jsonl"), path.join(h.sessions, "A.jsonl"));
  r = await h.report("A"); assert.equal(r.replies, 1); assert.equal(r.totals.input, 10); assert.ok(r.issues.includes("session_identity_mismatch"));
});

test("database failures and invalid operation data distinguish partial availability from measured zero", async t => {
  const h = setup(t); h.write("A", [reply("known", op("known"))]); h.failDatabase(true);
  let r = await h.report("A"); assert.equal(r.replies, 1); assert.equal(r.complete, false); assert.ok(r.issues.includes("unreadable_database"));
  h.write("A"); r = await h.report("A"); assert.equal(r.replies, 0); assert.equal(scope(r, "all").availability, "failed");
  h.failDatabase(false); h.put("A", [op("good"), { ...op("bad"), operationId: "" }]);
  r = await h.report("A"); assert.equal(r.replies, 1); assert.ok(r.issues.includes("malformed_database_usage"));
});

for (const journal of ["wal", "delete"]) test(`${journal}: database-only continuous updates wake usage.watch without JSONL changes or manual refresh`, async t => {
  const h = setup(t, journal); h.write("A"); h.put("A", [op("one")], {}, "running"); await h.start("A");
  const jsonl = fs.readFileSync(path.join(h.sessions, "A.jsonl"), "utf8"), mtime = fs.statSync(path.join(h.sessions, "A.jsonl")).mtimeMs;
  const dbMtime = fs.statSync(h.dbFile).mtimeMs, operations = [op("one")], delays = [];
  for (let i = 2; i <= 4; i++) {
    const notice = await h.plugin.onPanelInvoke("usage.watch", { after: 0 });
    const waiting = h.plugin.onPanelInvoke("usage.watch", { after: notice.version });
    operations.push(op("op" + i, i * 10, i)); h.put("A", operations, {}, "running");
    delays.push(await waitReport(h, r => r?.replies === i)); assert.equal((await waiting).changed, true);
    assert.equal(h.current().session.running, true); assert.equal(h.current().unavailable, false);
  }
  assert.ok(delays.every(delay => delay < 1000));
  assert.equal(fs.readFileSync(path.join(h.sessions, "A.jsonl"), "utf8"), jsonl); assert.equal(fs.statSync(path.join(h.sessions, "A.jsonl")).mtimeMs, mtime);
  if (journal === "wal") assert.equal(fs.statSync(h.dbFile).mtimeMs, dbMtime, "only the WAL changed, not the main DB");
  const count = h.publications(); h.put("A", [...operations, operations[0]]);
  await waitReport(h, r => r?.session.running === false); const published = h.publications();
  h.put("A", [...operations, operations[0]]); await pause(120);
  assert.equal(h.current().replies, 4); assert.equal(h.publications(), published); assert.ok(published >= count);
  t.diagnostic(`database-only updates ${delays.join("/")}ms`);
});

test("database-triggered late scan cannot publish old session usage after switching", async t => {
  const h = setup(t); h.write("A"); h.write("B"); h.put("A", [op("A")]); h.put("B", [op("B", 777, 3)]); await h.start("A");
  const gate = h.holdRead(); h.put("A", [op("A"), op("late", 9999, 999)]);
  await gate.entered; h.switchTo("B"); gate.release();
  await waitReport(h, r => r?.session.id === "B"); assert.equal(h.current().totals.input, 777); assert.equal(h.current().replies, 1);
});

test("fixed selection and known running usage survive source failures, recover, and never leak on switch", async t => {
  const h = setup(t); h.write("A", [reply("a", op("a"))]); h.write("B"); h.put("A", [op("a"), op("db-only", 20, 3)], {}, "running"); await h.start("A");
  await h.plugin.onPanelInvoke("usage.refresh", { sessionId: "A" }); h.switchTo("B");
  h.failDatabase(true); fs.unlinkSync(path.join(h.sessions, "A.jsonl"));
  await waitReport(h, r => r?.issues.includes("retained_usage"));
  assert.equal(h.current().session.id, "A"); assert.equal(h.current().context.mode, "fixed"); assert.equal(h.current().totals.input, 30); assert.equal(h.current().session.running, true);
  h.failDatabase(false); h.write("A", [reply("a", op("a"))]); await waitReport(h, r => !r?.issues.includes("retained_usage"));
  await h.plugin.onPanelInvoke("usage.refresh", { follow: true }); assert.equal(h.current().session.id, "B"); assert.equal(h.current().replies, 0);
});

const queuedMessage = (sessionId, id, usage, parent) => ({ key: `message:${sessionId}:${id}`, sessionId, turnId: `${sessionId}-turn`,
  message: { id, role: "assistant", status: "complete", content: "PRIVATE_MESSAGE", thinking: "PRIVATE_THINKING",
    modelId: "same-model", providerId: "same-provider", createdAt: "2026-10-11T10:00:00Z", responseDurationMs: 321,
    usage, ...(parent ? { parentToolCallId: parent, agentName: "fixer" } : {}) } });
const queuedOperation = (sessionId, usage) => ({ key: "PRIVATE_QUEUE_KEY", sessionId, turnId: `${sessionId}-turn`, usage });

test("queued real operations and verified main/child messages appear before any durable usage", async t => {
  const h = setup(t); h.write("A"); h.write("B");
  const main = op("main", 20, 3), child = op("child", 30, 4), unknown = op("unknown", 40, 5);
  h.queue([queuedOperation("A", main), queuedOperation("A", child), queuedOperation("A", unknown),
    queuedMessage("A", "m", main), queuedMessage("A", "c", child, "call-child"), queuedMessage("B", "other", op("foreign", 9999, 99)),
    { sessionId: "A", key: "tool", message: { role: "tool", toolName: "Task", toolCallId: "call-child", toolArgs: "PRIVATE_ARGS",
      toolResult: { content: "PRIVATE_RESULT", details: { delegationId: "delegate-child", agent: "fixer", status: "running", secret: "PRIVATE_SECRET" } } } }]);
  const r = await h.report("A");
  assert.equal(r.replies, 3); assert.equal(r.totals.input, 90); assert.equal(r.totals.total, 102);
  assert.equal(scope(r, "main").totals.input, 20); assert.equal(scope(r, "subagents").totals.input, 30);
  assert.equal(r.sourceCoverage.queueOperations, 3); assert.equal(r.sourceCoverage.databaseOperations, 0);
  assert.equal(r.sourceCoverage.unknownRecords, 1); assert.equal(scope(r, "agent:call-child").delegationId, "delegate-child");
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_|foreign|content|thinking"|toolArgs|toolResult|secret|queueFile/);
});

test("queue directory watch handles continuous atomic writes and later disk duplicates without resetting history", async t => {
  const h = setup(t); h.write("A"); h.put("A", [], {}, "running"); await h.start("A");
  const jsonl = fs.readFileSync(path.join(h.sessions, "A.jsonl"), "utf8"), entries = [], operations = [], delays = [];
  for (let i = 1; i <= 4; i++) {
    const notice = await h.plugin.onPanelInvoke("usage.watch", { after: 0 });
    const waiting = h.plugin.onPanelInvoke("usage.watch", { after: notice.version });
    const usage = op("queue-" + i, i * 10, i); operations.push(usage);
    entries.push(queuedOperation("A", usage), queuedMessage("A", "m" + i, usage, i % 2 ? undefined : "child"));
    h.queue(entries, true); delays.push(await waitReport(h, r => r?.replies === i));
    assert.equal((await waiting).changed, true); assert.equal(h.current().session.running, true);
  }
  assert.equal(fs.readFileSync(path.join(h.sessions, "A.jsonl"), "utf8"), jsonl);
  assert.equal(scope(h.current(), "main").replies, 2); assert.equal(scope(h.current(), "subagents").replies, 2);
  const keys = h.current().history.map(row => row.key), total = h.current().totals.total;
  // Persist in a different order: the same measured operations must not jump.
  h.put("A", [...operations].reverse(), {}, "running");
  await waitReport(h, r => r?.sourceCoverage.databaseOperations === 4);
  assert.deepEqual(h.current().history.map(row => row.key), keys); assert.equal(h.current().totals.total, total);
  h.queue([], true); await pause(100); assert.equal(h.current().replies, 4); assert.equal(h.current().totals.total, total);
  h.write("A", operations.map((usage, i) => reply("m" + (i + 1), usage, i % 2 ? "child" : undefined)));
  await waitReport(h, r => r?.history.every(row => row.source.includes("jsonl")));
  assert.equal(h.current().replies, 4); assert.equal(h.current().totals.total, total);
  assert.deepEqual(h.current().history.map(row => row.key), keys);
  t.diagnostic(`queue-only updates ${delays.join("/")}ms`);
});

test("queued measurements survive drain/failure and never leak across selected sessions", async t => {
  const h = setup(t); h.write("A"); h.write("B"); h.queue([queuedMessage("A", "m", op("same", 10, 2))]); await h.start("A");
  h.queue([], true); await pause(80); assert.equal(h.current().totals.total, 12);
  h.queue("{broken"); await waitReport(h, r => r?.issues.includes("unreadable_usage_queue"));
  assert.equal(h.current().totals.total, 12);
  h.queue([queuedMessage("A", "m", op("same", 10, 2)), queuedMessage("B", "m", op("same", 777, 3))], true);
  const gate = h.holdRead(); h.queue([queuedMessage("A", "late", op("late", 9999, 99)), queuedMessage("B", "m", op("same", 777, 3))], true);
  await gate.entered; h.switchTo("B"); gate.release(); await waitReport(h, r => r?.session.id === "B");
  assert.equal(h.current().replies, 1); assert.equal(h.current().totals.input, 777);
  assert.equal(scope(h.current(), "main").totals.input, 777);
});

test("queue identity conflicts remain unknown and legacy message identities deduplicate exactly", async t => {
  const h = setup(t); h.write("A", [reply("legacy", { inputTokens: 10, outputTokens: 2 })]);
  h.put("A", [op("message:A:legacy"), op("shared", 20, 3)]);
  h.queue([queuedMessage("A", "legacy", { inputTokens: 10, outputTokens: 2 }), queuedMessage("A", "a", op("shared", 20, 3), "child-A"),
    queuedMessage("A", "b", op("shared", 20, 3), "child-B")]);
  const r = await h.report("A"); assert.equal(r.replies, 2); assert.equal(r.totals.total, 35);
  assert.equal(scope(r, "main").replies, 1); assert.equal(scope(r, "subagents").replies, 0);
  assert.ok(r.issues.includes("conflicting_agent_identity"));
});

test("later queue counters update the same operation once and desktopUsage identity stays canonical", async t => {
  const h = setup(t); h.write("A"); h.queue([queuedOperation("A", op("growing")),
    queuedMessage("A", "native", { input: 10, output: 2, desktopUsage: op("growing") }, "child")]); await h.start("A");
  const key = h.current().last.key;
  h.queue([queuedOperation("A", { aggregation: "aggregate", operations: [op("growing", 50, 5), op("growing", 50, 5)] }),
    queuedMessage("A", "native", { input: 10, output: 2, desktopUsage: op("growing") }, "child")], true);
  await waitReport(h, r => r?.totals.total === 55);
  assert.equal(h.current().replies, 1); assert.equal(h.current().last.key, key); assert.equal(scope(h.current(), "subagents").totals.total, 55);
  assert.equal(h.current().sourceCoverage.unknownRecords, 0);
});

test("stat fallback detects new queue/SQLite/JSONL data when OS watchers are unavailable", async t => {
  const h = setup(t, "wal", true); h.write("A"); await h.start("A");
  h.queue([queuedMessage("A", "m", op("queued", 20, 3))], true);
  const delay = await waitReport(h, r => r?.replies === 1);
  assert.equal(h.current().updateError, "watch_unavailable"); assert.equal(scope(h.current(), "main").totals.total, 23);
  h.put("A", [op("queued", 20, 3), op("db-only", 30, 4)]); await waitReport(h, r => r?.replies === 2);
  h.write("A", [reply("c", op("db-only", 30, 4), "child")]); await waitReport(h, r => scope(r, "subagents").replies === 1);
  assert.equal(h.current().totals.total, 57);
  t.diagnostic(`watch unavailable fallback ${delay}ms`);
});

test("completed checkpoints update during a running turn with full unchanged outbox and no durable operations", async t => {
  const h = setup(t); h.write("A"); h.put("A", [], {}, "running");
  h.queue(Array.from({ length: 1024 }, (_, i) => ({ sessionId: "other", key: "full-" + i })));
  await h.start("A");
  const queueBefore = fs.readFileSync(h.queueFile, "utf8"), transcriptBefore = fs.readFileSync(path.join(h.sessions, "A.jsonl"), "utf8");
  const delays = [];
  for (let i = 1; i <= 4; i++) {
    h.checkpoint("A", reply("main-" + i, op("checkpoint-" + i, 10 * i, i)));
    delays.push(await waitReport(h, r => r?.replies === i));
    const r = h.current(); assert.equal(r.session.running, true); assert.equal(scope(r, "main").replies, i);
    assert.equal(r.last.source, "checkpoint"); assert.equal(r.sourceCoverage.checkpointOperations, i);
    assert.equal(r.totals.total, 11 * i * (i + 1) / 2);
  }
  assert.equal(fs.readFileSync(h.queueFile, "utf8"), queueBefore);
  assert.equal(fs.readFileSync(path.join(h.sessions, "A.jsonl"), "utf8"), transcriptBefore);
  assert.equal(h.db.prepare("select usage_json from turns where id='A-turn'").get().usage_json.includes('checkpoint'), false);
  assert.doesNotMatch(JSON.stringify(h.settings()), /PRIVATE_MESSAGE|blocks|content|thinking"|toolArgs/);
  t.diagnostic(`checkpoint-only running updates ${delays.join("/")}ms`);
});

test("streaming, missing status/usage, mismatched session and unsupported schema checkpoints cannot fabricate tokens", async t => {
  const h = setup(t); h.write("A"); await h.start("A");
  for (const [message, changes] of [
    [{ ...reply("stream", op("stream")), meta: { status: "streaming", usage: op("stream") } }, {}],
    [{ ...reply("no-status", op("no-status")), meta: { usage: op("no-status") } }, {}],
    [{ ...reply("no-usage", null), meta: { status: "complete" } }, {}],
    [reply("wrong-session", op("wrong-session")), { sessionId: "B" }],
    [reply("wrong-schema", op("wrong-schema")), { schema: 2 }],
  ]) {
    h.checkpoint("A", message, changes); const r = await h.plugin.onPanelInvoke("usage.refresh");
    assert.equal(r.replies, 0); assert.equal(r.totals.total, 0);
  }
});

test("checkpoint replacement/removal/read failure preserves completed operations, later sources deduplicate exactly", async t => {
  const h = setup(t); h.write("A"); await h.start("A"); const usage = op("exact", 123, 7);
  h.checkpoint("A", reply("measured", usage)); await waitReport(h, r => r?.replies === 1);
  const file = path.join(h.sessions, "A.inflight.json");
  h.checkpoint("A", { ...reply("next", op("next")), meta: { status: "streaming" } });
  let r = await h.plugin.onPanelInvoke("usage.refresh"); assert.equal(r.totals.total, 130);
  fs.writeFileSync(file, "{bad"); r = await h.plugin.onPanelInvoke("usage.refresh"); assert.equal(r.replies, 1);
  fs.unlinkSync(file); r = await h.plugin.onPanelInvoke("usage.refresh"); assert.equal(r.totals.total, 130);
  h.queue([queuedMessage("A", "measured", usage), queuedOperation("A", usage)]); h.put("A", [usage], {}, "running");
  h.write("A", [reply("measured", usage)]); r = await h.plugin.onPanelInvoke("usage.refresh");
  assert.equal(r.replies, 1); assert.equal(r.totals.total, 130); assert.equal(r.last.source, "jsonl+checkpoint+outbox+database");
  h.checkpoint("A", reply("measured", op("exact", 123, 8))); r = await h.plugin.onPanelInvoke("usage.refresh");
  assert.equal(r.replies, 1); assert.equal(r.totals.total, 131);
});

test("checkpoint cache survives A/B/A switching and unload/reload without trusting an old visible session", async t => {
  const h = setup(t); h.write("A"); h.write("B"); await h.start("A");
  h.checkpoint("A", reply("first", op("first", 10, 1))); await waitReport(h, r => r?.replies === 1);
  h.checkpoint("A", reply("second", op("second", 20, 2))); await waitReport(h, r => r?.replies === 2);
  h.checkpoint("B", reply("foreign", op("foreign", 777, 3))); h.switchTo("B");
  let r = await h.plugin.onPanelInvoke("usage.get"); assert.equal(r.totals.total, 780);
  h.switchTo("A"); r = await h.plugin.onPanelInvoke("usage.get"); assert.equal(r.replies, 2); assert.equal(r.totals.total, 33);
  const waiting = h.plugin.onPanelInvoke("usage.watch", { after: (await h.plugin.onPanelInvoke("usage.watch", { after: 0 })).version });
  await h.plugin.onUnload(); assert.equal((await waiting).changed, true);
  const publications = h.publications(); h.checkpoint("A", reply("after-unload", op("after-unload", 9999, 99)));
  await pause(100); assert.equal(h.publications(), publications);
  fs.unlinkSync(path.join(h.sessions, "A.inflight.json"));
  await h.plugin.onLoad(); r = await h.plugin.onPanelInvoke("usage.get"); assert.equal(r.ok, false);
  h.switchTo("B"); r = await h.plugin.onPanelInvoke("usage.get"); assert.equal(r.totals.total, 780);
  h.switchTo("A"); r = await h.plugin.onPanelInvoke("usage.get"); assert.equal(r.replies, 2); assert.equal(r.totals.total, 33);
  assert.equal(r.history.some(row => row.operationId === "foreign" || row.operationId === "after-unload"), false);
});

test("checkpoint atomically replaced files are discovered by stat fallback when OS watches are unavailable", async t => {
  const h = setup(t, "wal", true); h.write("A"); await h.start("A");
  h.checkpoint("A", reply("fallback", op("fallback"))); const delay = await waitReport(h, r => r?.replies === 1);
  assert.equal(scope(h.current(), "main").replies, 1); t.diagnostic(`checkpoint fallback ${delay}ms`);
});
