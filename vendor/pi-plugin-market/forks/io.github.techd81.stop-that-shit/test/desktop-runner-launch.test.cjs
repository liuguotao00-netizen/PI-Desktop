'use strict';

// An approved dependency install is handed to the host as a shell command that
// runs the ticket runner. The host executes that string through CMD, PowerShell,
// or a POSIX shell, so the command carries the runner path plus base64
// arguments: no inline `-e` script and no require() of a computed path.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { buildRunnerCommand } = require('../src/runner-command.cjs');
const { parseRunnerArgs } = require('../src/dependency-runner.cjs');

const runnerPath = path.join(__dirname, '..', 'src', 'dependency-runner.cjs');
const encode = (value) => Buffer.from(String(value), 'utf8').toString('base64');
const dataDir = 'C:\\Users\\a b\\.pi-desktop\\plugins\\data\\plugin';

function command(platform, overrides = {}) {
  return buildRunnerCommand({
    executable: process.execPath,
    runnerPath,
    sessionId: 'session-1',
    dataDir,
    ticket: 'a'.repeat(64),
    agentId: 'agent-1',
    platform,
    ...overrides
  });
}

test('the runner command launches the runner script with encoded arguments', () => {
  const posix = command('linux');
  assert.ok(posix.includes(process.execPath));
  assert.ok(posix.includes(runnerPath));
  assert.ok(posix.includes(encode('session-1')));
  assert.ok(posix.includes(encode(dataDir)));
  assert.ok(posix.includes('a'.repeat(64)));
  assert.equal(/require\s*\(/.test(posix), false);
  assert.equal(/(^|\s)-e\s/.test(posix), false);
});

test('the windows command keeps the process-tree guard and encodes the script', () => {
  const windows = command('win32', {
    windowsPowerShellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  });
  assert.ok(windows.startsWith('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
  assert.ok(windows.includes('-EncodedCommand'));
  assert.equal(/require\s*\(/.test(windows), false);
});

test('the job guard source ships next to the runner command', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'windows-job-guard.cs')));
});

test('the runner decodes the arguments the command hands it', () => {
  assert.deepEqual(
    parseRunnerArgs([encode('session-1'), encode(dataDir), 'b'.repeat(64), encode('agent-1')]),
    ['session-1', dataDir, 'b'.repeat(64), 'agent-1']
  );
  assert.deepEqual(
    parseRunnerArgs([encode('s'), encode('d'), 'c'.repeat(64)]),
    ['s', 'd', 'c'.repeat(64), '']
  );
});

test('the runner entry point rejects a ticket it did not issue', () => {
  const result = spawnSync(
    process.execPath,
    [runnerPath, encode('session-1'), encode(dataDir), 'not-a-ticket', encode('')],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid approval ticket/);
});
