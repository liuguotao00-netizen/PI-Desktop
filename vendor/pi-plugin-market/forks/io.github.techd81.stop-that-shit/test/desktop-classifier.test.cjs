'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeDesktopTool,
  classifyMutability,
  desktopDelegationShape,
  isBackgroundDelegation,
  isControlTool
} = require('../src/desktop/tool-classifier.cjs');

test('read-only tools stay read', () => {
  for (const name of ['read', 'grep', 'find', 'ls', 'glob', 'Skill']) {
    assert.equal(classifyMutability(name, { path: 'a' }), 'read', name);
  }
});

test('write tools are write and expose their target path', () => {
  for (const name of ['write', 'edit']) {
    const analysis = analyzeDesktopTool(name, { path: 'src/a.cjs' }, 'D:/work');
    assert.equal(analysis.mutability, 'write');
    assert.deepEqual(analysis.affectedPaths, ['src/a.cjs']);
  }
});

test('shell calls reuse the shared static analysis', () => {
  assert.equal(classifyMutability('bash', { command: 'rg -n pattern src' }), 'read');
  assert.equal(classifyMutability('powershell', { command: 'Get-Content README.md' }), 'read');
  assert.equal(classifyMutability('bash', { command: 'npm install lodash' }), 'write');
  assert.equal(analyzeDesktopTool('bash', { command: 'sha256sum report.csv' }, 'D:/w').hashIntent, true);
  assert.equal(analyzeDesktopTool('bash', { command: 'npm install lodash' }, 'D:/w').dependencyIntent, true);
});

test('the Task family splits delegation from bookkeeping', () => {
  assert.equal(classifyMutability('Task', { agent: 'fixer', task: 'x' }), 'delegate');
  for (const name of ['TaskWait', 'TaskList', 'TaskStop']) {
    assert.equal(classifyMutability(name, {}), 'control', name);
    assert.equal(isControlTool(name), true);
  }
  assert.equal(classifyMutability('TodoWrite', { todos: [] }), 'control');
  assert.equal(classifyMutability('BrowserPreview', {}), 'unknown');
});

test('a Task call counts one child unless it fans out', () => {
  assert.deepEqual(desktopDelegationShape('Task', { agent: 'fixer', task: 'x' }), { count: 1, unbounded: false });
  assert.deepEqual(desktopDelegationShape('Task', { tasks: [{ a: 1 }, { b: 2 }] }), { count: 2, unbounded: false });
  assert.deepEqual(desktopDelegationShape('Task', { tasks: 'all' }), { count: 0, unbounded: true });
  assert.deepEqual(desktopDelegationShape('Task', { count: 'unbounded' }), { count: 0, unbounded: true });
  assert.deepEqual(desktopDelegationShape('read', {}), { count: 0, unbounded: false });
});

test('only an explicit detach marker keeps a Task reservation open', () => {
  assert.equal(isBackgroundDelegation({ agent: 'fixer' }), false);
  assert.equal(isBackgroundDelegation({ background: true }), true);
  assert.equal(isBackgroundDelegation({ run_in_background: true }), true);
});
