'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildDoctorReport } = require('../src/desktop/doctor.cjs');
const { createPanelBackend } = require('../src/desktop/panel.cjs');
const { readRuntime } = require('../src/runtime-audit.cjs');

// A data directory someone replaced with files is damage the panel reports, not
// a reason for every channel to reject. The doctor is the screen you open when
// the directory is already broken.
function damagedDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-damaged-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'sessions'), 'not a directory');
  fs.writeFileSync(path.join(dataDir, 'runtime'), 'not a directory');
  return dataDir;
}

test('a sessions path that is not a directory is reported, not thrown', (t) => {
  const dataDir = damagedDataDir(t);
  const report = buildDoctorReport({ dataDir });
  assert.equal(report.ok, false);
  const stateFiles = report.checks.find((check) => check.id === 'stateFiles');
  assert.equal(stateFiles.ok, false);
  assert.match(stateFiles.detail, /1 damaged \(ENOTDIR\)/);
});

test('the panel still answers every channel while the data directory is damaged', async (t) => {
  const dataDir = damagedDataDir(t);
  const previous = process.env.STS_DESKTOP_DATA;
  process.env.STS_DESKTOP_DATA = dataDir;
  t.after(() => {
    if (previous === undefined) delete process.env.STS_DESKTOP_DATA;
    else process.env.STS_DESKTOP_DATA = previous;
  });
  const backend = createPanelBackend({ pi: null });

  const overview = await backend.invoke('sts.overview', {});
  assert.equal(overview.ok, true);
  assert.equal(overview.runtime.summary.checkedActions, 0);

  const events = await backend.invoke('sts.events', {});
  assert.equal(events.ok, true);
  assert.deepEqual(events.events, []);

  const doctor = await backend.invoke('sts.doctor', {});
  assert.equal(doctor.ok, true);
  assert.equal(doctor.report.ok, false);
});

test('runtime reads return no records instead of failing on an unlistable directory', (t) => {
  const dataDir = damagedDataDir(t);
  const runtime = readRuntime({}, { dataDir });
  assert.deepEqual(runtime.events, []);
  assert.equal(runtime.summary.damagedRecords, 0);
});
