'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handleDesktopPrompt } = require('../src/desktop/hooks.cjs');
const { handleControlEvent } = require('../src/controller.cjs');
const { PROTOCOL_VERSION } = require('../src/control-protocol.cjs');
const { sessionKey } = require('../src/state.cjs');
const { readJsonl } = require('../src/runtime-storage.cjs');
const { sessionContext, tempDataDir } = require('./desktop-support.cjs');

// Mode changes live in their own file so the decision schema stays stable.
// Nothing pinned this record's host family before, which is how the desktop
// host was written as `other` in real data.
function modeChangeFile(dataDir, sessionId) {
  return path.join(dataDir, 'runtime', 'mode-changes', `${sessionKey(sessionId)}.jsonl`);
}

test('a desktop mode change records the desktop host family', (t) => {
  const dataDir = tempDataDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const sessionId = 'desktop-family';
  handleDesktopPrompt({ text: '$stop-that-shit review -- inspect the diff' }, sessionContext(sessionId), { dataDir });
  const { records, damaged } = readJsonl(modeChangeFile(dataDir, sessionId));
  assert.equal(damaged, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].previousMode, 'unconfirmed');
  assert.equal(records[0].nextMode, 'review');
  assert.equal(records[0].hostFamily, 'desktop');
});

test('an unknown host family stays other and the record keeps no prompt text', (t) => {
  const dataDir = tempDataDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const sessionId = 'unknown-family';
  const prompt = '$stop-that-shit change files=src/secret.cjs -- rename the hidden token';
  handleControlEvent({
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind: 'prompt.submit',
    sessionId,
    prompt,
    host: { family: 'some-new-host' }
  }, { dataDir });
  const { records } = readJsonl(modeChangeFile(dataDir, sessionId));
  assert.equal(records.length, 1);
  assert.equal(records[0].hostFamily, 'other');
  const raw = fs.readFileSync(modeChangeFile(dataDir, sessionId), 'utf8');
  assert.equal(raw.includes('secret.cjs'), false);
  assert.equal(raw.includes('hidden token'), false);
});
