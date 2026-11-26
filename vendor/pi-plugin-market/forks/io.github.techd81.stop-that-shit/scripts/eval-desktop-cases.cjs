#!/usr/bin/env node

'use strict';

// Runs the upstream Bad/Good case catalogue through the PI-Desktop adapter.
//
// Each case supplies the task contract and the semantic fields a host cannot
// infer from a tool call (authorization, reachability, delegation fan-out).
// The tool call itself is built as a real PI-Desktop payload, so classification
// and event construction run for every case instead of being bypassed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshState } = require('../src/state-schema.cjs');
const { statePath, writeState } = require('../src/state.cjs');
const { handleControlEvent } = require('../src/controller.cjs');
const { toActionEvent } = require('../src/desktop/hooks.cjs');
const { readRuntime } = require('../src/runtime-audit.cjs');

const root = path.resolve(__dirname, '..', 'cases', '0.0.1');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-desktop-eval-'));
const files = fs.readdirSync(root).filter((name) => name.endsWith('.json')).sort();
const SEMANTIC_FIELDS = ['authorization', 'reachability', 'analysisReason', 'unboundedDelegation', 'delegationCount'];

function toolCallFor(action) {
  if (action.hashIntent) {
    return { toolName: 'bash', toolCallId: 'call-hash', input: { command: 'sha256sum report.csv' } };
  }
  if (action.dependencyIntent) {
    return { toolName: 'bash', toolCallId: 'call-deps', input: { command: 'npm install lodash' } };
  }
  if (action.mutability === 'write') {
    const target = Array.isArray(action.affectedPaths) && action.affectedPaths.length ? action.affectedPaths[0] : 'src/case.cjs';
    return { toolName: 'write', toolCallId: 'call-write', input: { path: target, content: 'module.exports = 1;\n' } };
  }
  if (action.mutability === 'read') return { toolName: 'read', toolCallId: 'call-read', input: { path: 'src/case.cjs' } };
  if (action.mutability === 'control') return { toolName: 'TodoWrite', toolCallId: 'call-control', input: { todos: [] } };
  if (action.mutability === 'delegate') {
    return {
      toolName: 'Task',
      toolCallId: 'call-task',
      input: action.unboundedDelegation ? { count: 'unbounded' } : { agent: 'fixer', task: 'Run the case.' }
    };
  }
  return { toolName: 'asktool', toolCallId: 'call-unknown', input: {} };
}

function seed(sessionId, contract) {
  const state = freshState();
  state.contract = { ...state.contract, ...contract };
  writeState(sessionId, state, dataDir);
}

function runCase(testCase) {
  const sessionId = `case:${testCase.id}`;
  const contract = testCase.input.contract || {};
  seed(sessionId, contract);
  if (testCase.input.state && testCase.input.state.storageError) {
    fs.writeFileSync(statePath(sessionId, dataDir), '{ "schemaVersion": 1, "contract": { "mode": ');
  }
  const context = { sessionId, cwd: 'D:/case-workspace', hasUI: false };
  const call = toolCallFor(testCase.input.action || {});
  const build = () => {
    const event = toActionEvent(call, context);
    if (!event) return null;
    event.action = { ...event.action };
    for (const field of SEMANTIC_FIELDS) {
      if (Object.hasOwn(testCase.input.action, field)) event.action[field] = testCase.input.action[field];
    }
    return event;
  };
  const options = { dataDir, denialResponseOutcome: 'permission_deny_returned' };

  let result = null;
  if (testCase.input.action.duplicateActionId) {
    handleControlEvent(build(), options);
    result = handleControlEvent(build(), options);
  } else {
    result = handleControlEvent(build(), options);
  }

  // The audit record is what the Guard actually committed, which is also how a
  // `report_and_defer` or read-only-recovery outcome becomes visible: those
  // return context, not a denial.
  const runtime = readRuntime({ sessionId }, { dataDir });
  const recorded = [...runtime.events].reverse().find((entry) => entry.decision);
  if (recorded) {
    return {
      outcome: recorded.decision.policyOutcome,
      family: recorded.decision.family || null,
      reasonCode: recorded.decision.reasonCode
    };
  }
  if (result && result.kind === 'deny') {
    const decision = result.decision || {};
    return { outcome: decision.outcome, family: decision.family || null, reasonCode: decision.reasonCode };
  }
  return { outcome: 'allow', family: null, reasonCode: 'WITHIN_CONTRACT' };
}

let failures = 0;
for (const file of files) {
  const testCase = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const actual = runCase(testCase);
  const pass = Object.entries(testCase.expected).every(([key, value]) => (actual[key] ?? null) === value);
  if (!pass) {
    failures += 1;
    process.stdout.write(`FAIL ${testCase.id} ${JSON.stringify(actual)} != ${JSON.stringify(testCase.expected)}\n`);
  } else {
    process.stdout.write(`PASS ${testCase.id} ${actual.outcome} ${actual.family || '-'}\n`);
  }
}

fs.rmSync(dataDir, { recursive: true, force: true });
process.stdout.write(`\n${files.length - failures}/${files.length} Desktop case arms passed.\n`);
process.exitCode = failures ? 1 : 0;
