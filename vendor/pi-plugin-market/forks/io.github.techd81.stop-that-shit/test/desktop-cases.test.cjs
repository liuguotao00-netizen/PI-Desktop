'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

// The case catalogue is the upstream behavioural contract. Running it through
// `npm run eval:desktop` proves the Desktop adapter reaches the same decisions
// as the reference evaluator, not merely that the decision core is unchanged.
test('the upstream Bad/Good catalogue passes through the Desktop adapter', () => {
  const result = spawnSync(process.execPath, ['scripts/eval-desktop-cases.cjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /24\/24 Desktop case arms passed/);
  assert.doesNotMatch(result.stdout, /^FAIL/m);
});
