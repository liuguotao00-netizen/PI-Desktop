'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { contractContext } = require('../src/controller.cjs');
const { freshState } = require('../src/state-schema.cjs');

function contract(patch = {}) {
  return {
    mode: 'review',
    level: 'guard',
    agentBudget: Number.MAX_SAFE_INTEGER,
    hashPolicy: 'deny',
    dependencyPolicy: 'ask',
    allowedPaths: null,
    source: 'directive',
    ...patch
  };
}

test('the default agent budget reads as unbounded in the model-facing contract', () => {
  const text = contractContext(contract(), freshState().delegation);
  assert.match(text, /agents=0\/unbounded reserved/);
  assert.equal(text.includes(String(Number.MAX_SAFE_INTEGER)), false);
});

test('a finite agent budget keeps its number', () => {
  const text = contractContext(contract({ agentBudget: 3 }), freshState().delegation);
  assert.match(text, /agents=0\/3 reserved/);
});
