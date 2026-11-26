'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeShell } = require('../src/shell-analysis.cjs');
const { analyzeDesktopTool } = require('../src/desktop/tool-classifier.cjs');

// Upstream Pi cases, kept as the cross-host policy table: a paired read and
// operation must report the same mutability, hash intent, and dependency intent
// through this host's classifier as through the shared shell analysis.
const cases = [
  ['git branch --list -- -D', 'read', false, false],
  ['git branch -D scratch', 'write', false, false],
  ['git status --short && git diff --stat', 'read', false, false],
  ['git status --short > status.txt', 'write', false, false, 'shell_redirection'],
  ["rg --fixed-strings 'npm install sha256sum' README.md", 'read', false, false],
  ['npm install example-package', 'write', false, true],
  ['sha256sum artifact.zip', 'unknown', true, false, 'shell_command_unproven'],
  ["rg -- '--pre' README.md", 'read', false, false],
  ['rg --pre helper pattern README.md', 'unknown', false, false, 'shell_execution_option'],
  ['git diff --output', 'write', false, false, 'git_output_file'],
  ['git diff --word-diff-regex', 'unknown', false, false, 'option_value_missing'],
  ['git status; custom-build', 'unknown', false, false, 'shell_command_unproven']
];

for (const [command, mutability, hashIntent, dependencyIntent, analysisReason] of cases) {
  test(`desktop shell policy facts match the shared analysis: ${command}`, () => {
    const expected = { mutability, hashIntent, dependencyIntent };
    assert.deepEqual(analyzeShell(command), {
      ...expected,
      ...(analysisReason ? { analysisReason } : {})
    });
    // The host reports its own shell tools; both must inherit the shared facts.
    for (const toolName of ['bash', 'powershell']) {
      const result = analyzeDesktopTool(toolName, { command }, 'D:/work');
      assert.deepEqual({
        mutability: result.mutability,
        hashIntent: result.hashIntent,
        dependencyIntent: result.dependencyIntent
      }, expected, toolName);
      assert.deepEqual(result.affectedPaths, [], toolName);
    }
  });
}
