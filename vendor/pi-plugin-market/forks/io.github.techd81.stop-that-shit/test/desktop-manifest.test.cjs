'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('the manifest describes a local PI-Desktop plugin', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'io.github.techd81.stop-that-shit');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.main, 'main.js');
  assert.deepEqual(manifest.permissions.sort(), ['agent.extension', 'agent.prompt.inject', 'ui.panel', 'ui.view'].sort());
  assert.deepEqual(manifest.contributes.agentExtensions, ['src/desktop/extension.mjs']);
  assert.deepEqual(manifest.contributes.skills, [
    { id: 'stop-that-shit', path: 'skills/stop-that-shit/SKILL.md' },
    { id: 'stss', path: 'skills/stss/SKILL.md' }
  ]);
  for (const key of ['en', 'zh-CN']) {
    assert.ok(manifest.i18n[key].name);
    assert.ok(manifest.i18n[key].description);
    assert.ok(manifest.i18n[key].safetyNotes);
    assert.ok(manifest.ui.title[key]);
  }
});

test('the manifest check passes with only the documented skill-length warning', () => {
  const result = spawnSync(process.execPath, ['scripts/desktop-plugin-check.cjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS PI-Desktop manifest/);
  assert.match(result.stdout, /WARN skill skills\/stop-that-shit\/SKILL\.md description is \d+ chars/);
});

test('every declared runtime file exists in the checkout', () => {
  const files = [
    'main.js',
    'src/desktop/extension.mjs',
    'src/desktop/extension.cjs',
    'views/index.html',
    'skills/stop-that-shit/SKILL.md',
    'skills/stss/SKILL.md'
  ];
  for (const file of files) assert.equal(fs.existsSync(path.join(root, file)), true, file);
});

// The icon must come from the host's view-icon vocabulary; an unknown name is
// dropped at load time rather than rejected, so pin the list here.
const VIEW_ICONS = [
  'bell', 'book', 'bot', 'branch', 'browser', 'chat', 'clock', 'diff', 'files',
  'folder', 'image', 'key', 'link', 'list-checks', 'palette', 'plug',
  'pull-request', 'search', 'server', 'shield', 'sparkles', 'target',
  'terminal', 'workflow', 'wrench'
];

test('the manifest declares one loadable work-panel view', () => {
  const views = manifest.contributes.views;
  assert.equal(Array.isArray(views), true);
  assert.equal(views.length, 1);
  const [view] = views;
  assert.equal(view.id, 'sts');
  // The same page serves the work-panel tab and the standalone window.
  assert.equal(view.entry, manifest.ui.panel);
  assert.equal(fs.existsSync(path.join(root, view.entry)), true);
  assert.ok(VIEW_ICONS.includes(view.icon), view.icon);
  assert.equal(Number.isInteger(view.order), true);
  for (const key of ['en', 'zh-CN']) assert.ok(view.title[key], key);
  assert.ok(manifest.permissions.includes('ui.view'));
});
