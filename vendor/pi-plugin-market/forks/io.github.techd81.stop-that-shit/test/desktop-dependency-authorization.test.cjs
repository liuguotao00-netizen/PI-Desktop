'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { analyzeShell } = require('../src/shell-analysis.cjs');
const { handleDesktopPrompt, handleDesktopTool } = require('../src/desktop/hooks.cjs');
const { sessionContext, tempDataDir } = require('./desktop-support.cjs');

// Managers spell install several ways. `deps=deny` only holds if each spelling
// is recognized as a dependency operation.
const installs = [
  'npm install left-pad',
  'npm i left-pad',
  'npm ci',
  'npm add left-pad',
  'pnpm install left-pad',
  'pnpm i left-pad',
  'yarn add left-pad',
  'yarn i left-pad',
  'bun add left-pad',
  'bun install',
  'uv add requests',
  'pip install requests',
  'cargo add serde'
];

for (const command of installs) {
  test(`dependency intent is recognized: ${command}`, () => {
    assert.equal(analyzeShell(command).dependencyIntent, true);
  });
}

const nonInstalls = [
  'npm init -y',
  'npm test',
  'yarn info react',
  'bun run build',
  "rg --fixed-strings 'npm i' README.md"
];

for (const command of nonInstalls) {
  test(`a non-install command is not dependency intent: ${command}`, () => {
    assert.equal(analyzeShell(command).dependencyIntent, false);
  });
}

function decide(prompt, toolName, input) {
  const dataDir = tempDataDir();
  const context = sessionContext('deps');
  handleDesktopPrompt({ text: prompt }, context, { dataDir });
  const result = handleDesktopTool({ toolName, toolCallId: 'c1', input }, context, { dataDir });
  fs.rmSync(dataDir, { recursive: true, force: true });
  return result;
}

test('deps=deny blocks an aliased install command end to end', () => {
  for (const command of ['npm i left-pad', 'pnpm i left-pad', 'bun add left-pad', 'npm ci']) {
    const result = decide('$stop-that-shit change deps=deny -- refactor', 'bash', { command });
    assert.equal(result.kind, 'deny', command);
    assert.equal(result.decision.reasonCode, 'DEPENDENCY_NOT_AUTHORIZED', command);
  }
});

test('deps=allow lets the same aliased install through', () => {
  const result = decide('$stop-that-shit change deps=allow -- add the parser', 'bash', { command: 'npm i left-pad' });
  assert.equal(result.kind, 'none');
});
