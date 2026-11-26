'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { handleDesktopPrompt, handleDesktopTool } = require('../src/desktop/hooks.cjs');
const { readState } = require('../src/state.cjs');
const { sessionContext, tempDataDir } = require('./desktop-support.cjs');

// A mistyped query is an ordinary thing a user does. It must not persist a
// directive error: the contract is unchanged and later tool calls stay governed
// by it.
function setup(t) {
  const dataDir = tempDataDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const context = sessionContext('query-typo');
  handleDesktopPrompt({ text: '$stop-that-shit review -- audit' }, context, { dataDir });
  return { dataDir, context };
}

test('a malformed explain answers with the expected form and keeps the contract', (t) => {
  const { dataDir, context } = setup(t);
  const reply = handleDesktopPrompt({ text: '/sts explain evt_zzz' }, context, { dataDir });
  assert.equal(reply.kind, 'context');
  assert.match(reply.text, /explain evt_<uuid>/);
  const state = readState(context.sessionId, dataDir);
  assert.equal(state.directiveError, null);
  assert.equal(state.contract.mode, 'review');
});

test('a query typo does not block the delegation that follows it', (t) => {
  const { dataDir, context } = setup(t);
  handleDesktopPrompt({ text: '/sts explain evt_zzz' }, context, { dataDir });
  const task = handleDesktopTool(
    { toolName: 'Task', toolCallId: 'task-1', input: { agent: 'reviewer', task: 'read the diff' } },
    context,
    { dataDir }
  );
  assert.equal(task.kind, 'none');
});

test('a bare explain is a query, not a directive error', (t) => {
  const { dataDir, context } = setup(t);
  const reply = handleDesktopPrompt({ text: '$stop-that-shit explain' }, context, { dataDir });
  assert.equal(reply.kind, 'context');
  assert.match(reply.text, /could not read that query/);
  assert.equal(readState(context.sessionId, dataDir).directiveError, null);
});
