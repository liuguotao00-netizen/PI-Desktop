'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { installPromptTemplates, STATUS_TEMPLATE, STOP_TEMPLATE } = require('../src/desktop/prompt-templates.cjs');
const { tempDataDir } = require('./desktop-support.cjs');

test('both templates expand the composer arguments into the Guard head', () => {
  for (const [name, body] of [['stop-that-shit', STOP_TEMPLATE], ['sts', STATUS_TEMPLATE]]) {
    assert.match(body, /^---\n[\s\S]*description: .+\n/, `${name} has front matter`);
    assert.match(body, /argument-hint: .+/, `${name} hints its arguments`);
    assert.match(body, /\n---\n\$stop-that-shit \$ARGUMENTS\n?$/, `${name} forwards $ARGUMENTS`);
  }
});

test('installing the templates is idempotent and writes plain Markdown', () => {
  const dir = path.join(tempDataDir(), 'prompts');
  const first = installPromptTemplates(dir);
  assert.deepEqual(first.map((entry) => entry.changed), [true, true]);
  assert.deepEqual(first.map((entry) => path.basename(entry.file)), ['stop-that-shit.md', 'sts.md']);
  for (const entry of first) {
    assert.equal(fs.existsSync(entry.file), true);
    assert.equal(fs.readFileSync(entry.file, 'utf8'), entry.file.endsWith('sts.md') ? STATUS_TEMPLATE : STOP_TEMPLATE);
  }
  const second = installPromptTemplates(dir);
  assert.deepEqual(second.map((entry) => entry.changed), [false, false]);
});

test('a hand-edited template is kept as a backup instead of being overwritten', () => {
  const dir = path.join(tempDataDir(), 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sts.md');
  fs.writeFileSync(file, 'my own notes\n', 'utf8');
  const sts = installPromptTemplates(dir).find((entry) => path.basename(entry.file) === 'sts.md');
  assert.equal(sts.status, 'updated');
  assert.equal(sts.error, undefined);
  assert.equal(sts.backup, `${file}.bak`);
  assert.equal(fs.readFileSync(sts.backup, 'utf8'), 'my own notes\n');
  assert.equal(fs.readFileSync(file, 'utf8'), STATUS_TEMPLATE);

  // A second change must not clobber the first backup: it holds the user's text.
  fs.writeFileSync(file, 'second edit\n', 'utf8');
  installPromptTemplates(dir);
  assert.equal(fs.readFileSync(sts.backup, 'utf8'), 'my own notes\n');
  assert.equal(fs.readFileSync(file, 'utf8'), STATUS_TEMPLATE);
});

test('one blocked target reports its reason and does not hide the other result', () => {
  const dir = path.join(tempDataDir(), 'prompts');
  // A directory where the template file belongs: reading it fails, writing it
  // would fail too, and the other template must still be installed.
  fs.mkdirSync(path.join(dir, 'sts.md'), { recursive: true });
  const results = installPromptTemplates(dir);
  const sts = results.find((entry) => path.basename(entry.file) === 'sts.md');
  const other = results.find((entry) => path.basename(entry.file) === 'stop-that-shit.md');
  assert.match(sts.error, /EISDIR|EPERM|EACCES/);
  assert.equal(sts.changed, false);
  assert.equal(other.status, 'created');
  assert.equal(fs.readFileSync(other.file, 'utf8'), STOP_TEMPLATE);
});

test('loading the plugin installs both templates without a manual step', async () => {
  const dir = path.join(tempDataDir(), 'prompts');
  const registered = [];
  globalThis.pi = {
    commands: { register: async (command) => { registered.push(command.id); }, unregister: async () => {} },
    ui: { revealView: async () => {} }
  };
  const previous = process.env.STS_DESKTOP_PROMPTS_DIR;
  process.env.STS_DESKTOP_PROMPTS_DIR = dir;
  try {
    const plugin = require('../main.js');
    assert.equal(typeof plugin.installComposerTemplates, 'function');
    await plugin.onLoad();
    await plugin.onUnload();
  } finally {
    if (previous === undefined) delete process.env.STS_DESKTOP_PROMPTS_DIR;
    else process.env.STS_DESKTOP_PROMPTS_DIR = previous;
    delete globalThis.pi;
  }
  assert.equal(fs.readFileSync(path.join(dir, 'stop-that-shit.md'), 'utf8'), STOP_TEMPLATE);
  assert.equal(fs.readFileSync(path.join(dir, 'sts.md'), 'utf8'), STATUS_TEMPLATE);
  assert.deepEqual(registered, ['sts.openpanel']);
});
