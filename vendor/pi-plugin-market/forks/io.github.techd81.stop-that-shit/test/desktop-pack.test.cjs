'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const archive = path.join(root, 'dist', `${manifest.id}-${manifest.version}.piplug`);

function readCentralDirectory(buffer) {
  const eocd = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(eocd), 0x06054b50, 'missing end-of-central-directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, `bad central header at ${cursor}`);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    entries.push({ name, method, compressedSize, size });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('pack:desktop builds a store-only package with the declared files', () => {
  const result = spawnSync(process.execPath, ['scripts/pack-desktop.cjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^packed \d+ files -> dist[\\/]/);
  assert.equal(fs.existsSync(archive), true);

  const buffer = fs.readFileSync(archive);
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, 'not a zip archive');
  const entries = readCentralDirectory(buffer);
  const names = new Set(entries.map((entry) => entry.name));
  for (const entry of entries) {
    assert.equal(entry.method, 0, `${entry.name} is compressed`);
    assert.equal(entry.compressedSize, entry.size, `${entry.name} sizes differ`);
  }
  for (const required of [
    'manifest.json',
    'package.json',
    'main.js',
    'src/desktop/extension.mjs',
    'src/desktop/extension.cjs',
    'src/decision.cjs',
    'views/index.html',
    'views/app.js',
    'views/lib/view-model.js',
    'skills/stop-that-shit/SKILL.md',
    'skills/stss/SKILL.md'
  ]) {
    assert.equal(names.has(required), true, required);
  }
  for (const name of names) {
    assert.equal(name.startsWith('.'), false, name);
    assert.equal(name.includes('/.git/'), false, name);
    assert.equal(name.startsWith('node_modules/'), false, name);
  }
});
