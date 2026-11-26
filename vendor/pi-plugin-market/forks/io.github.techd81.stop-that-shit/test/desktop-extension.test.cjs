'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerDesktopExtension } = require('../src/desktop/extension.cjs');
const { statePath } = require('../src/state.cjs');
const { createFakePi, emit, tempDataDir } = require('./desktop-support.cjs');

function setup() {
  const dataDir = tempDataDir();
  const pi = createFakePi();
  registerDesktopExtension(pi, { dataDir });
  const context = (sessionId = 'sess-1') => ({
    cwd: 'D:/work',
    mode: 'desktop',
    hasUI: false,
    sessionManager: { getSessionId: () => sessionId }
  });
  return { dataDir, pi, context };
}

function prompt(text, systemPrompt = 'BASE PROMPT') {
  return { type: 'before_agent_start', messageType: 'user', prompt: text, systemPrompt, systemPromptOptions: {} };
}

test('the extension registers the host surface and the /sts command', () => {
  const { pi } = setup();
  for (const event of ['session_start', 'before_agent_start', 'tool_call', 'tool_result', 'session_shutdown']) {
    assert.equal(typeof pi.handlers.get(event), 'function', event);
  }
  assert.equal(pi.commands.length, 1);
  assert.equal(pi.commands[0].name, 'sts');
  assert.equal(typeof pi.commands[0].handler, 'function');
  assert.equal(typeof pi.commands[0].run, 'function');
});

test('before_agent_start appends to the incoming system prompt instead of replacing it', () => {
  const { pi, context } = setup();
  const first = emit(pi, 'before_agent_start', prompt('$stop-that-shit review -- Report findings; do not edit.', 'BASE PROMPT'), context());
  assert.equal(typeof first.systemPrompt, 'string');
  assert.ok(first.systemPrompt.startsWith('BASE PROMPT\n\n'), first.systemPrompt);
  assert.match(first.systemPrompt, /review/);

  const chained = emit(pi, 'before_agent_start', prompt('hello', 'BASE PROMPT\n\nEARLIER HANDLER'), context('sess-2'));
  assert.ok(chained.systemPrompt.startsWith('BASE PROMPT\n\nEARLIER HANDLER'), chained.systemPrompt);
});

test('review blocks a write and change lets the same write run', () => {
  const { pi, context } = setup();
  emit(pi, 'before_agent_start', prompt('$stop-that-shit review -- Report findings; do not edit.'), context('review'));
  const blocked = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'w1', input: { path: 'src/a.cjs', content: 'x' } }, context('review'));
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /MODE_FORBIDS_MUTATION/);

  emit(pi, 'before_agent_start', prompt('$stop-that-shit change -- Fix the failing test.'), context('change'));
  const allowed = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'w2', input: { path: 'src/a.cjs', content: 'x' } }, context('change'));
  assert.equal(allowed, undefined);
});

test('an unarmed directive is reported and grants nothing', () => {
  const { pi, context } = setup();
  const result = emit(pi, 'before_agent_start', prompt('Context first.\n$stop-that-shit review -- Report only.'), context());
  assert.match(result.systemPrompt, /DIRECTIVE_NOT_ARMED|Stop That Shit/);
  const write = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'w1', input: { path: 'src/a.cjs', content: 'x' } }, context());
  assert.equal(write, undefined);
});

test('watch mode reports through the tool result without blocking', () => {
  const { pi, context } = setup();
  emit(pi, 'before_agent_start', prompt('$stop-that-shit review watch -- Report findings.'), context('watch'));
  const call = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'w1', input: { path: 'src/a.cjs', content: 'x' } }, context('watch'));
  assert.equal(call, undefined);
  const result = emit(pi, 'tool_result', {
    type: 'tool_result',
    toolName: 'write',
    toolCallId: 'w1',
    isError: false,
    content: [{ type: 'text', text: 'written' }]
  }, context('watch'));
  assert.equal(result.content.length, 2);
  assert.match(result.content[1].text, /<stop_that_shit_context>[\s\S]*MODE_FORBIDS_MUTATION/);
});

test('the Task budget reserves, blocks a second child, then releases on completion', () => {
  const { pi, context } = setup();
  emit(pi, 'before_agent_start', prompt('$stop-that-shit change agents=1 -- Run one subagent.'), context('tasks'));
  const first = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'Task', toolCallId: 't1', input: { agent: 'fixer', task: 'one' } }, context('tasks'));
  assert.equal(first, undefined);
  const second = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'Task', toolCallId: 't2', input: { agent: 'fixer', task: 'two' } }, context('tasks'));
  assert.equal(second.block, true);
  assert.match(second.reason, /AGENT_BUDGET_EXHAUSTED/);

  emit(pi, 'tool_result', { type: 'tool_result', toolName: 'Task', toolCallId: 't1', isError: false, content: [{ type: 'text', text: 'done' }] }, context('tasks'));
  const third = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'Task', toolCallId: 't3', input: { agent: 'fixer', task: 'three' } }, context('tasks'));
  assert.equal(third, undefined);
});

test('hash, dependency, and file boundaries keep their own reasons', () => {
  const { pi, context } = setup();
  emit(pi, 'before_agent_start', prompt('$stop-that-shit change -- Do the task.'), context('hash'));
  const hash = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: 'h1', input: { command: 'sha256sum report.csv' } }, context('hash'));
  assert.match(hash.reason, /HASH_NOT_AUTHORIZED/);

  const deps = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: 'd1', input: { command: 'npm install lodash' } }, context('hash'));
  assert.match(deps.reason, /DEPENDENCY_NOT_AUTHORIZED/);

  emit(pi, 'before_agent_start', prompt('$stop-that-shit lock change files=src/a.cjs -- Fix this file.'), context('files'));
  const outside = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'f1', input: { path: 'README.md', content: 'x' } }, context('files'));
  assert.match(outside.reason, /PATH_OUTSIDE_CONTRACT/);
  const inside = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'f2', input: { path: 'src/a.cjs', content: 'x' } }, context('files'));
  assert.equal(inside, undefined);
});

test('a damaged state file denies mutations and says why', () => {
  const { dataDir, pi, context } = setup();
  fs.mkdirSync(`${dataDir}/sessions`, { recursive: true });
  fs.writeFileSync(statePath('damaged', dataDir), '{ not json');
  emit(pi, 'before_agent_start', prompt('$stop-that-shit change -- Do the task.'), context('damaged'));
  const blocked = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'w1', input: { path: 'src/a.cjs', content: 'x' } }, context('damaged'));
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /STATE_DAMAGED/);
  const read = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'read', toolCallId: 'r1', input: { path: 'src/a.cjs' } }, context('damaged'));
  assert.equal(read, undefined);
});

test('a failing host context fails open instead of breaking the turn', () => {
  const { pi } = setup();
  const exploding = {
    hasUI: true,
    ui: { notify() { throw new Error('ui down'); } },
    sessionManager: { getSessionId() { return 'boom'; } },
    get cwd() { throw new Error('no cwd'); }
  };
  const result = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'w1', input: { path: 'src/a.cjs' } }, exploding);
  assert.equal(result, undefined);
  const promptResult = emit(pi, 'before_agent_start', prompt('$stop-that-shit change -- x'), exploding);
  assert.equal(promptResult, undefined);
});

test('/sts commands answer from the shared controller', async () => {
  const { dataDir, pi, context } = setup();
  const { readRuntime } = require('../src/runtime-audit.cjs');
  emit(pi, 'before_agent_start', prompt('$stop-that-shit review -- Report findings.'), context('cmd'));
  emit(pi, 'tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'w1', input: { path: 'src/a.cjs', content: 'x' } }, context('cmd'));
  const text = await pi.commands[0].handler('status', context('cmd'));
  assert.match(text, /Stop That Shit status/);
  assert.match(text, /review/);

  const doctor = await pi.commands[0].handler('doctor', context('cmd'));
  assert.match(doctor, /Stop That Shit doctor/);

  const runtime = await pi.commands[0].handler('runtime', context('cmd'));
  assert.match(runtime, /Execution-denial responses: 1/);
  assert.equal(/Permission-deny responses: 1/.test(runtime), false);

  const events = readRuntime({ sessionId: 'cmd' }, { dataDir });
  const eventId = events.events[0].eventId;
  const explain = await pi.commands[0].handler(`explain ${eventId}`, context('cmd'));
  assert.match(explain, /MODE_FORBIDS_MUTATION/);
  const label = await pi.commands[0].handler(`label ${eventId} correct`, context('cmd'));
  assert.match(label, /label recorded: evt_.* = correct/);
});

test('registration records which host API is available', () => {
  const dataDir = tempDataDir();
  const pi = createFakePi();
  registerDesktopExtension(pi, { dataDir });
  const probe = JSON.parse(fs.readFileSync(`${dataDir}/runtime/extension.json`, 'utf8'));
  assert.equal(probe.schemaVersion, 1);
  assert.equal(probe.host.commandApi, 'registerCommand');
  assert.equal(probe.host.on, true);
  assert.ok(probe.host.members.includes('on:function'));
  assert.equal(probe.pluginVersion, require('../package.json').version);
});

test('a host without a command API is reported, not assumed', () => {
  const dataDir = tempDataDir();
  const pi = {
    on() {},
    publishCommands() {}
  };
  registerDesktopExtension(pi, { dataDir });
  const probe = JSON.parse(fs.readFileSync(`${dataDir}/runtime/extension.json`, 'utf8'));
  assert.equal(probe.host.registerCommand, false);
  assert.equal(probe.host.commandApi, 'publishCommands');
});

test('the composer /sts and /stop-that-shit forms drive the same Guard', async () => {
  const { pi, context } = setup();
  const armed = emit(pi, 'before_agent_start', prompt('/stop-that-shit review -- Report findings; do not edit.'), context('slash'));
  assert.match(armed.systemPrompt, /review/);
  const blocked = emit(pi, 'tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'w1', input: { path: 'src/a.cjs', content: 'x' } }, context('slash'));
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /MODE_FORBIDS_MUTATION/);

  const status = emit(pi, 'before_agent_start', prompt('/sts status'), context('slash'));
  assert.match(status.systemPrompt, /Stop That Shit status/);
  assert.match(status.systemPrompt, /review/);

  const doctor = emit(pi, 'before_agent_start', prompt('/sts doctor'), context('slash'));
  assert.match(doctor.systemPrompt, /Stop That Shit doctor/);
});

test('the packaged ESM entry loads and registers against a host API', () => {
  const entry = pathToFileURL(path.resolve(__dirname, '..', 'src', 'desktop', 'extension.mjs')).href;
  const script = `
    const handlers = [];
    const pi = { on: (name) => handlers.push(name), registerCommand: (name) => handlers.push('cmd:' + name) };
    const mod = await import(${JSON.stringify(entry)});
    const result = mod.default(pi);
    console.log(JSON.stringify({ handlers, hasDataDir: Boolean(result && result.dataDir) }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, STS_DESKTOP_DATA: tempDataDir() }
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.deepEqual(parsed.handlers, ['session_start', 'before_agent_start', 'tool_call', 'tool_result', 'session_shutdown', 'cmd:sts']);
  assert.equal(parsed.hasDataDir, true);
});

test('a host without extension events is reported instead of throwing', () => {
  const dataDir = tempDataDir();
  const pi = { registerCommand() {} };
  const result = registerDesktopExtension(pi, { dataDir });
  assert.equal(result.registered, false);
  assert.equal(result.error, 'NO_EXTENSION_API');
  const probe = JSON.parse(fs.readFileSync(`${dataDir}/runtime/extension.json`, 'utf8'));
  assert.equal(probe.host.on, false);
});

test('a bridge object that throws on access still registers and is reported', () => {
  const dataDir = tempDataDir();
  const pi = new Proxy({}, {
    getPrototypeOf() { throw new Error('no prototype'); },
    getOwnPropertyNames() { throw new Error('no keys'); },
    get() { throw new Error('no members'); },
    has() { throw new Error('no members'); }
  });
  const result = registerDesktopExtension(pi, { dataDir });
  assert.equal(result.registered, false);
  assert.equal(Boolean(result.dataDir), true);
});

test('an unwritable state directory does not turn a /sts command into a rejection', async () => {
  const dataDir = tempDataDir();
  const pi = createFakePi();
  registerDesktopExtension(pi, { dataDir });
  // A directory where the session state file belongs makes the shared reader
  // throw; the command must answer text instead of rejecting.
  fs.mkdirSync(`${dataDir}/sessions`, { recursive: true });
  fs.mkdirSync(statePath('broken', dataDir));
  const text = await pi.commands[0].handler('status', {
    cwd: 'D:/work',
    hasUI: false,
    sessionManager: { getSessionId: () => 'broken' }
  });
  assert.match(text, /Stop That Shit (status|could not answer)/);
});

test('a bare /sts answers status and the watch note survives a string result', () => {
  const { pi, context } = setup();
  const bare = emit(pi, 'before_agent_start', prompt('/sts'), context('bare'));
  assert.match(bare.systemPrompt, /Stop That Shit status/);

  emit(pi, 'before_agent_start', prompt('$stop-that-shit review watch -- Report findings.'), context('watch2'));
  emit(pi, 'tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'w9', input: { path: 'src/a.cjs', content: 'x' } }, context('watch2'));
  const result = emit(pi, 'tool_result', {
    type: 'tool_result',
    toolName: 'write',
    toolCallId: 'w9',
    isError: false,
    content: 'written'
  }, context('watch2'));
  assert.match(result.content, /<stop_that_shit_context>[\s\S]*MODE_FORBIDS_MUTATION/);
  assert.match(result.content, /^written/);
});

test('an unrecognised result shape keeps the watch note for the next delivery', () => {
  const { pi, context } = setup();
  emit(pi, 'before_agent_start', prompt('$stop-that-shit review watch -- Report findings.'), context('keep'));
  emit(pi, 'tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'k1', input: { path: 'src/a.cjs', content: 'x' } }, context('keep'));
  const unknown = emit(pi, 'tool_result', { type: 'tool_result', toolName: 'write', toolCallId: 'k1', isError: false }, context('keep'));
  assert.equal(unknown, undefined);
  // The note is only dropped once it has actually been delivered.
  const delivered = emit(pi, 'tool_result', {
    type: 'tool_result', toolName: 'write', toolCallId: 'k1', isError: false, content: []
  }, context('keep'));
  assert.match(delivered.content[0].text, /<stop_that_shit_context>[\s\S]*MODE_FORBIDS_MUTATION/);
});
