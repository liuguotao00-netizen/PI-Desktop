'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPanelBackend } = require('../src/desktop/panel.cjs');
const { buildDoctorReport } = require('../src/desktop/doctor.cjs');
const { handleControlEvent } = require('../src/controller.cjs');
const { toActionEvent } = require('../src/desktop/hooks.cjs');
const { seedContract, sessionContext, tempDataDir } = require('./desktop-support.cjs');

function recordBlockedWrite(dataDir) {
  const context = sessionContext('panel-session');
  seedContract(dataDir, context.sessionId, { mode: 'review', level: 'guard', source: 'directive' });
  const event = toActionEvent(
    { toolName: 'write', toolCallId: 'w1', input: { path: 'src/a.cjs', content: 'x' } },
    context
  );
  handleControlEvent(event, { dataDir, denialResponseOutcome: 'permission_deny_returned' });
  return context;
}

test('an empty data directory answers with empty, healthy structures', async () => {
  const dataDir = tempDataDir();
  const backend = createPanelBackend({ pi: { plugin: { getDataPath: async () => dataDir } }, fallbackDataDir: dataDir });
  const overview = await backend.invoke('sts.overview');
  assert.equal(overview.ok, true);
  assert.equal(overview.dataDir, dataDir);
  assert.equal(overview.sessions.total, 0);
  assert.equal(overview.runtime.summary.checkedActions, 0);
  const events = await backend.invoke('sts.events', {});
  assert.equal(events.ok, true);
  assert.deepEqual(events.events, []);
  const doctor = await backend.invoke('sts.doctor');
  assert.equal(doctor.ok, true);
  assert.equal(doctor.report.ok, true);
});

test('overview, events, explain, and label read back the same record', async () => {
  const dataDir = tempDataDir();
  const context = recordBlockedWrite(dataDir);
  const backend = createPanelBackend({ pi: { plugin: { getDataPath: async () => dataDir } } });

  const overview = await backend.invoke('sts.overview');
  assert.equal(overview.sessions.total, 1);
  assert.equal(overview.sessions.list[0].contract.mode, 'review');
  assert.equal(overview.runtime.summary.permissionDenyResponses, 1);

  const events = await backend.invoke('sts.events', { sessionId: context.sessionId });
  assert.equal(events.events.length, 1);
  const event = events.events[0];
  assert.equal(event.decision.reasonCode, 'MODE_FORBIDS_MUTATION');
  assert.equal(event.action.toolName, 'write');

  const explain = await backend.invoke('sts.explain', { eventId: event.eventId });
  assert.equal(explain.ok, true);
  assert.equal(explain.event.eventId, event.eventId);
  const missing = await backend.invoke('sts.explain', { eventId: 'evt_00000000-0000-0000-0000-000000000000' });
  assert.equal(missing.ok, false);

  const label = await backend.invoke('sts.label', { eventId: event.eventId, label: 'correct' });
  assert.equal(label.ok, true);
  const labeled = await backend.invoke('sts.events', { sessionId: context.sessionId });
  assert.equal(labeled.events[0].label, 'correct');

  const invalid = await backend.invoke('sts.label', { eventId: 'nope', label: 'correct' });
  assert.equal(invalid.ok, false);
  const unknown = await backend.invoke('sts.unknown');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_CHANNEL');
});

test('the plugin entry answers panel channels through the host bridge', async () => {
  const dataDir = tempDataDir();
  recordBlockedWrite(dataDir);
  const registered = [];
  globalThis.pi = {
    plugin: { getDataPath: async () => dataDir },
    commands: {
      register: async (command) => { registered.push(command); },
      unregister: async () => {}
    },
    ui: { openPanel: async () => {} }
  };
  const plugin = require('../main.js');
  try {
    await plugin.onLoad();
    assert.equal(registered.length, 1);
    assert.equal(registered[0].id, 'sts.openpanel');
    const overview = await plugin.onPanelInvoke('sts.overview', {});
    assert.equal(overview.ok, true);
    assert.equal(overview.sessions.total, 1);
    const events = await plugin.onPanelInvoke('sts.events', { limit: 5 });
    assert.equal(events.ok, true);
    assert.equal(events.events.length, 1);
  } finally {
    await plugin.onUnload();
    delete globalThis.pi;
  }
});

test('the palette command opens the work-panel view when the host can reveal one', async () => {
  const calls = [];
  let command = null;
  globalThis.pi = {
    plugin: { getDataPath: async () => tempDataDir() },
    commands: {
      register: async (registered) => { command = registered; },
      unregister: async () => {}
    },
    ui: {
      revealView: async (input) => { calls.push(`revealView:${input.viewId}`); },
      openPanel: async (input) => { calls.push(`openPanel:${input.title}`); }
    }
  };
  const plugin = require('../main.js');
  try {
    await plugin.onLoad();
    await command.run();
    assert.deepEqual(calls, ['revealView:sts']);
  } finally {
    await plugin.onUnload();
    delete globalThis.pi;
  }
});

test('the palette command falls back to the panel window when reveal fails', async () => {
  const calls = [];
  let command = null;
  globalThis.pi = {
    plugin: { getDataPath: async () => tempDataDir() },
    commands: {
      register: async (registered) => { command = registered; },
      unregister: async () => {}
    },
    ui: {
      revealView: async () => { throw new Error('plugin is not active in this project'); },
      openPanel: async (input) => { calls.push(`openPanel:${input.title}`); }
    }
  };
  const plugin = require('../main.js');
  try {
    await plugin.onLoad();
    await command.run();
    assert.deepEqual(calls, ['openPanel:Stop That Shit']);
  } finally {
    await plugin.onUnload();
    delete globalThis.pi;
  }
});

test('the panel page ships every asset it references', () => {
  const views = path.resolve(__dirname, '..', 'views');
  const html = fs.readFileSync(path.join(views, 'index.html'), 'utf8');
  assert.match(html, /<meta name="pi-plugin-chrome" content="v2">/);
  for (const [, asset] of html.matchAll(/(?:src|href)="([^":]+)"/g)) {
    assert.equal(fs.existsSync(path.join(views, asset)), true, asset);
  }
  const css = fs.readFileSync(path.join(views, 'styles.css'), 'utf8');
  assert.match(css, /var\(--pi-plugin-titlebar-height/);
  // The language switch is part of the page, and every marked label must exist
  // in both tables (each key appears once under zh and once under en).
  assert.match(html, /id="locale"/);
  const app = fs.readFileSync(path.join(views, 'app.js'), 'utf8');
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(([, key]) => key);
  assert.ok(keys.includes('table.session'));
  assert.ok(keys.includes('label.correct'));
  for (const key of keys) {
    assert.equal(app.split(`"${key}"`).length - 1 >= 2, true, `${key} must exist in both languages`);
  }
});

test('an extension registered in another directory is reported, not hidden', () => {
  const panelDir = tempDataDir();
  const extensionDir = tempDataDir();
  fs.mkdirSync(path.join(extensionDir, 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(extensionDir, 'runtime', 'extension.json'),
    JSON.stringify({ schemaVersion: 1, dataDir: extensionDir, host: { commandApi: 'registerCommand' } }),
    'utf8'
  );

  const mismatch = buildDoctorReport({ dataDir: panelDir, fallbackDataDir: extensionDir });
  const check = mismatch.checks.find((entry) => entry.id === 'extensionDataDir');
  assert.equal(check.ok, false);
  assert.match(check.detail, /the extension registered in/);

  const same = buildDoctorReport({ dataDir: extensionDir });
  assert.equal(same.checks.find((entry) => entry.id === 'extensionDataDir').ok, true);
});
