"use strict";
// Explicit opt-in, read-only local verification. Never start the plugin, write
// settings, copy a transcript/database, or expose session titles/message bodies.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
async function readRealReport(hostRoot, sessionId) {
  assert.ok(hostRoot && sessionId, "USAGE_REAL_HOST_ROOT and USAGE_REAL_SESSION_ID are required");
  const context = vm.createContext({ require, module: { exports: {} }, pi: {
    plugin: { getDataPath: async () => path.join(path.resolve(hostRoot), "plugins/data/io.github.new-beginner.session-usage") },
    app: { getLocale: async () => "zh-CN", getAppearance: async () => ({ locale: "zh-CN", base: "light" }) },
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../main.js"), "utf8") + "\nglobalThis.readReport = buildReport;", context);
  const original = await context.readReport(sessionId, { status: "active" });
  assert.equal(original.ok, true); assert.equal(original.session.id, sessionId);
  const operationId = process.env.USAGE_REAL_OPERATION_ID;
  assert.ok(operationId, "USAGE_REAL_OPERATION_ID is required to verify the exact fault operation");
  const matching = original.history.filter(row => row.operationId === operationId);
  assert.equal(matching.length, 1, "the fault operation is present exactly once");
  const target = matching[0];
  assert.equal(target.tokens.input, 23423); assert.equal(target.tokens.output, 34); assert.equal(target.tokens.total, 23457);
  assert.equal(target.agentId, "unknown");
  for (const kind of ["main", "subagents"]) assert.equal(original.scopes.find(s => s.id === kind).history.some(row => row.operationId === operationId), false);
  const report = JSON.parse(JSON.stringify(original));
  const alias = "read-only-sample";
  report.session = { ...report.session, id: alias, shortId: "sample", title: "真实故障用量（仅脱敏元数据）" };
  report.recentSessions = [{ id: alias, shortId: "sample", title: report.session.title, modelId: report.session.modelId, running: false }];
  report.context = { revision: 1, mode: "fixed", sessionId: alias, activeSessionId: alias, status: "active" };
  const aliases = new Map(report.history.map((row, index) => [row.key, `redacted-operation-${index + 1}`]));
  report.verification = { targetKey: aliases.get(target.key), input: 23423, output: 34, total: 23457, ownership: target.agentId };
  for (const history of [report.history, ...report.scopes.map(s => s.history)]) for (const row of history) {
    row.id = ""; row.key = aliases.get(row.key); row.operationId = row.key; row.providerId = "local-provider";
  }
  report.last = report.history.at(-1);
  for (const s of report.scopes) s.last = s.history.at(-1) || null;
  return report;
}
function evidence(report) {
  return { records: report.replies, input: report.totals.input, output: report.totals.output, total: report.totals.total,
    models: report.byModel.map(m => m.modelId), faultOperation: report.verification, sourceCoverage: report.sourceCoverage };
}
module.exports = { readRealReport, evidence };
if (require.main === module) readRealReport(process.env.USAGE_REAL_HOST_ROOT, process.env.USAGE_REAL_SESSION_ID)
  .then(report => console.log("PASS read-only actual sample", JSON.stringify(evidence(report))))
  .catch(error => { console.error(error); process.exitCode = 1; });
