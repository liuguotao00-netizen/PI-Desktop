'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleDesktopPrompt,
  handleDesktopTool,
  isDesktopDoctorPrompt,
  normalizeDesktopPrompt,
  toActionAfterEvent,
  toActionEvent,
  toPromptEvent
} = require('../src/desktop/hooks.cjs');
const { seedContract, sessionContext, tempDataDir } = require('./desktop-support.cjs');

test('prompt events carry the shared protocol and the normalized directive', () => {
  const event = toPromptEvent({ text: '/skill:stop-that-shit review -- look only' }, sessionContext('s1'));
  assert.equal(event.protocolVersion, 2);
  assert.equal(event.lifecycleVersion, 2);
  assert.equal(event.kind, 'prompt.submit');
  assert.equal(event.prompt, '$stop-that-shit review -- look only');
  assert.equal(event.host.family, 'desktop');
  assert.equal(normalizeDesktopPrompt('plain text'), 'plain text');
});

test('the composer slash forms are accepted as directive heads', () => {
  assert.equal(normalizeDesktopPrompt('/stop-that-shit review -- x'), '$stop-that-shit review -- x');
  assert.equal(normalizeDesktopPrompt('/sts status'), '$stop-that-shit status');
  // A bare head is how `/sts` arrives once the template expands an empty
  // $ARGUMENTS; it asks for the current state instead of arming nothing.
  assert.equal(normalizeDesktopPrompt('/sts'), '$stop-that-shit status');
  assert.equal(normalizeDesktopPrompt('$sts status'), '$stop-that-shit status');
  assert.equal(normalizeDesktopPrompt('/sts:status'), '$stop-that-shit status');
  assert.equal(normalizeDesktopPrompt('/skill:sts status'), '$stop-that-shit status');
  assert.equal(normalizeDesktopPrompt('  /sts doctor  '), '$stop-that-shit doctor');
  // A query verb takes no task text, so a tail is dropped rather than parsed as
  // an unknown directive field.
  assert.equal(normalizeDesktopPrompt('/sts status -- and more'), '$stop-that-shit status');
  assert.equal(normalizeDesktopPrompt('/sts doctor now'), '$stop-that-shit doctor');
  assert.equal(normalizeDesktopPrompt('/stss audit -- x'), '/stss audit -- x');
  assert.equal(normalizeDesktopPrompt('see /sts status inline'), 'see /sts status inline');
  assert.equal(isDesktopDoctorPrompt('/sts doctor'), true);
  assert.equal(isDesktopDoctorPrompt('$stop-that-shit doctor'), true);
  assert.equal(isDesktopDoctorPrompt('  /sts doctor'), true);
  assert.equal(isDesktopDoctorPrompt('/sts status'), false);
});

test('query verbs keep runtime all, and indented or quoted samples stay samples', () => {
  assert.equal(normalizeDesktopPrompt('/sts runtime all'), '$stop-that-shit runtime all');
  assert.equal(normalizeDesktopPrompt('$stop-that-shit runtime all'), '$stop-that-shit runtime all');
  assert.equal(normalizeDesktopPrompt('$stop-that-shit runtime'), '$stop-that-shit runtime');
  // contracts.cjs reads four spaces or a tab as an indented sample, not a head.
  assert.equal(normalizeDesktopPrompt('    $stop-that-shit status'), '    $stop-that-shit status');
  assert.equal(isDesktopDoctorPrompt('    $stop-that-shit doctor'), false);
  // A quoted example on a later line is lifted only when it carries contract
  // wording; a plain query example stays quoted and injects no warning.
  assert.equal(
    normalizeDesktopPrompt('Reply with exactly this line:\n/sts status\n'),
    'Reply with exactly this line:\n/sts status\n'
  );
  assert.match(normalizeDesktopPrompt('Context.\n/sts review -- Report only.'), /\$stop-that-shit review/);
});

test('tool calls become action events with host tool names and paths', () => {
  const event = toActionEvent({ toolName: 'write', toolCallId: 'c1', input: { path: 'src/a.cjs', content: 'x' } }, sessionContext('s1'));
  assert.equal(event.kind, 'action.before');
  assert.equal(event.action.id, 'c1');
  assert.equal(event.action.name, 'write');
  assert.equal(event.action.mutability, 'write');
  assert.deepEqual(event.action.affectedPaths, ['src/a.cjs']);
  assert.equal(event.action.cwd, 'D:/work');
  assert.equal(event.action.completionScope, 'call');
  assert.equal('asyncLaunched' in event.action, false);
});

test('a delegation without a call identity is not turned into an event', () => {
  assert.equal(toActionEvent({ toolName: 'Task', input: { agent: 'fixer', task: 'x' } }, sessionContext('s1')), null);
  const event = toActionEvent({ toolName: 'Task', toolCallId: 't1', input: { agent: 'fixer', task: 'x' } }, sessionContext('s1'));
  assert.equal(event.action.mutability, 'delegate');
  assert.equal(event.action.delegationCount, 1);
  assert.equal(event.action.asyncLaunched, false);
});

test('a settled Task joins, a detached one keeps running', () => {
  const settled = toActionAfterEvent({ toolName: 'Task', toolCallId: 't1', content: [] }, sessionContext('s1'));
  assert.equal(settled.kind, 'action.after');
  assert.equal(settled.action.lifecycle, 'joined');
  const detached = toActionAfterEvent({ toolName: 'Task', toolCallId: 't2', content: [], background: true }, sessionContext('s1'));
  assert.equal(detached.action.lifecycle, 'running');
  assert.equal(toActionAfterEvent({ toolName: 'read', toolCallId: 'r1' }, sessionContext('s1')), null);
});

test('a remembered contract blocks a write without touching the repository', () => {
  const dataDir = tempDataDir();
  const context = sessionContext('adapter-block');
  seedContract(dataDir, context.sessionId, { mode: 'review', level: 'guard', source: 'directive' });
  const result = handleDesktopTool(
    { toolName: 'write', toolCallId: 'w1', input: { path: 'src/a.cjs', content: 'x' } },
    context,
    { dataDir }
  );
  assert.equal(result.kind, 'deny');
  assert.equal(result.decision.reasonCode, 'MODE_FORBIDS_MUTATION');
  assert.match(result.message, /MODE_FORBIDS_MUTATION|does not authorize repository mutation/);
});

test('a change contract lets the same write through', () => {
  const dataDir = tempDataDir();
  const context = sessionContext('adapter-allow');
  seedContract(dataDir, context.sessionId, { mode: 'change', level: 'guard', source: 'directive' });
  const result = handleDesktopTool(
    { toolName: 'write', toolCallId: 'w2', input: { path: 'src/a.cjs', content: 'x' } },
    context,
    { dataDir }
  );
  assert.equal(result.kind, 'none');
});

test('a first-line directive arms the contract and returns context', () => {
  const dataDir = tempDataDir();
  const context = sessionContext('adapter-directive');
  const result = handleDesktopPrompt({ text: '$stop-that-shit review -- Report findings; do not edit.' }, context, { dataDir });
  assert.equal(result.kind, 'context');
  assert.match(result.text, /review/);
  const block = handleDesktopTool(
    { toolName: 'edit', toolCallId: 'e1', input: { path: 'src/a.cjs', oldText: 'a', newText: 'b' } },
    context,
    { dataDir }
  );
  assert.equal(block.kind, 'deny');
  assert.equal(block.decision.reasonCode, 'MODE_FORBIDS_MUTATION');
});

test('a directive that does not start the prompt is reported, not honored', () => {
  const dataDir = tempDataDir();
  const context = sessionContext('adapter-late');
  const result = handleDesktopPrompt({ text: 'Here is context.\n$stop-that-shit review -- Report only.' }, context, { dataDir });
  assert.equal(result.kind, 'context');
  assert.equal(result.warning.code, 'DIRECTIVE_NOT_ARMED');
  const write = handleDesktopTool(
    { toolName: 'write', toolCallId: 'w3', input: { path: 'src/a.cjs', content: 'x' } },
    context,
    { dataDir }
  );
  assert.equal(write.kind, 'none');
});

test('the composer slash forms arm a contract end to end', () => {
  const dataDir = tempDataDir();
  const review = sessionContext('adapter-slash-review');
  const armed = handleDesktopPrompt({ text: '/sts:review -- Report findings; do not edit.' }, review, { dataDir });
  assert.equal(armed.kind, 'context');
  const blocked = handleDesktopTool(
    { toolName: 'write', toolCallId: 'w4', input: { path: 'src/a.cjs', content: 'x' } },
    review,
    { dataDir }
  );
  assert.equal(blocked.kind, 'deny');
  assert.equal(blocked.decision.reasonCode, 'MODE_FORBIDS_MUTATION');

  const change = sessionContext('adapter-slash-change');
  handleDesktopPrompt({ text: '/skill:sts change -- Fix the failing test.' }, change, { dataDir });
  const allowed = handleDesktopTool(
    { toolName: 'write', toolCallId: 'w5', input: { path: 'src/a.cjs', content: 'x' } },
    change,
    { dataDir }
  );
  assert.equal(allowed.kind, 'none');
});

test('a leading BOM does not swallow the directive', () => {
  const dataDir = tempDataDir();
  const context = sessionContext('adapter-bom');
  const result = handleDesktopPrompt({ text: '\uFEFF/sts review -- Report findings.' }, context, { dataDir });
  assert.equal(result.kind, 'context');
  assert.equal(result.warning, undefined);
  const write = handleDesktopTool(
    { toolName: 'write', toolCallId: 'w6', input: { path: 'src/a.cjs', content: 'x' } },
    context,
    { dataDir }
  );
  assert.equal(write.kind, 'deny');
  assert.equal(write.decision.reasonCode, 'MODE_FORBIDS_MUTATION');
});
