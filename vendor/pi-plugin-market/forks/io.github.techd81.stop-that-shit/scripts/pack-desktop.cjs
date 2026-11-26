#!/usr/bin/env node

'use strict';

// Builds the installable `.piplug`.
//
// A `.piplug` is a store-only (uncompressed) zip; the installer rejects
// deflated entries, so this writer never compresses and never uses `zip`.
// Output: dist/<id>-<version>.piplug

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const outputDir = path.join(root, 'dist');
const outputFile = path.join(outputDir, `${manifest.id}-${manifest.version}.piplug`);

// Everything the plugin needs at runtime, and nothing else.
const INCLUDE = ['manifest.json', 'package.json', 'main.js', 'LICENSE', 'src', 'views', 'skills', 'scripts/install-desktop-prompts.cjs', 'PI-DESKTOP.md'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '__pycache__']);
const SKIP_EXT = new Set(['.pyc']);
const FORBIDDEN = [/(^|\/)\.env(\.|$)/i, /(^|\/)\.npmrc$/i, /\.pem$/i, /\.key$/i, /token/i];

function walk(target, collected = []) {
  // lstat, not stat: stat follows the link and would never see a symlink here.
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`refusing to package a symlink: ${target}`);
  if (stat.isFile()) {
    collected.push(target);
    return collected;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing to package a symlink: ${child}`);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(child, collected);
      continue;
    }
    if (SKIP_EXT.has(path.extname(entry.name))) continue;
    collected.push(child);
  }
  return collected;
}

const files = [];
for (const entry of INCLUDE) {
  const absolute = path.join(root, entry);
  if (!fs.existsSync(absolute)) throw new Error(`missing packaged entry: ${entry}`);
  walk(absolute, files);
}
const entries = files
  .map((file) => ({ absolute: file, name: path.relative(root, file).split(path.sep).join('/') }))
  .sort((left, right) => left.name.localeCompare(right.name));

for (const entry of entries) {
  if (entry.name.startsWith('..') || path.isAbsolute(entry.name)) throw new Error(`path escapes the package: ${entry.name}`);
  if (FORBIDDEN.some((pattern) => pattern.test(entry.name))) throw new Error(`forbidden entry: ${entry.name}`);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Fixed 2020-01-01 timestamp keeps the package byte-identical across builds.
const DOS_TIME = 0;
const DOS_DATE = 20513;

function localHeader(name, size, crc) {
  const buffer = Buffer.alloc(30);
  buffer.writeUInt32LE(0x04034b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt16LE(0, 8);
  buffer.writeUInt16LE(DOS_TIME, 10);
  buffer.writeUInt16LE(DOS_DATE, 12);
  buffer.writeUInt32LE(crc, 14);
  buffer.writeUInt32LE(size, 18);
  buffer.writeUInt32LE(size, 22);
  buffer.writeUInt16LE(Buffer.byteLength(name), 26);
  buffer.writeUInt16LE(0, 28);
  return buffer;
}

function centralHeader(name, size, crc, offset) {
  const buffer = Buffer.alloc(46);
  buffer.writeUInt32LE(0x02014b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(20, 6);
  buffer.writeUInt16LE(0, 8);
  buffer.writeUInt16LE(0, 10);
  buffer.writeUInt16LE(DOS_TIME, 12);
  buffer.writeUInt16LE(DOS_DATE, 14);
  buffer.writeUInt32LE(crc, 16);
  buffer.writeUInt32LE(size, 20);
  buffer.writeUInt32LE(size, 24);
  buffer.writeUInt16LE(Buffer.byteLength(name), 28);
  buffer.writeUInt16LE(0, 30);
  buffer.writeUInt16LE(0, 32);
  buffer.writeUInt16LE(0, 34);
  buffer.writeUInt16LE(0, 36);
  buffer.writeUInt32LE(0, 38);
  buffer.writeUInt32LE(offset, 42);
  return buffer;
}

// The packaged copy is regenerated rather than copied: `scripts` would point at
// files this artifact does not ship, and `private`/`engines` describe the
// repository, not the installed plugin.
function packagedContents(entry) {
  if (entry.name !== 'package.json') return fs.readFileSync(entry.absolute);
  const source = JSON.parse(fs.readFileSync(entry.absolute, 'utf8'));
  const trimmed = {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license
  };
  return Buffer.from(`${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
}

const chunks = [];
let offset = 0;
const directory = [];
for (const entry of entries) {
  const data = packagedContents(entry);
  const name = Buffer.from(entry.name, 'utf8');
  const crc = crc32(data);
  const header = localHeader(entry.name, data.length, crc);
  chunks.push(header, name, data);
  directory.push(centralHeader(entry.name, data.length, crc, offset).valueOf());
  directory.push(name);
  offset += header.length + name.length + data.length;
}

const centralSize = directory.reduce((total, chunk) => total + chunk.length, 0);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputFile, Buffer.concat([...chunks, ...directory, eocd]));

// Self check: store-only, complete, and free of forbidden paths.
const written = fs.readFileSync(outputFile);
if (written.readUInt32LE(0) !== 0x04034b50) throw new Error('output is not a zip archive');
const eocdOffset = written.length - 22;
if (written.readUInt32LE(eocdOffset) !== 0x06054b50) throw new Error('output has no end-of-central-directory record');
const entryCount = written.readUInt16LE(eocdOffset + 10);
if (entryCount !== entries.length) throw new Error(`entry count mismatch: ${entryCount} != ${entries.length}`);
let cursor = written.readUInt32LE(eocdOffset + 16);
const names = new Set();
for (let index = 0; index < entryCount; index += 1) {
  if (written.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`bad central directory header at ${cursor}`);
  const method = written.readUInt16LE(cursor + 10);
  if (method !== 0) throw new Error('a packaged entry is compressed; .piplug must be store-only');
  const nameLength = written.readUInt16LE(cursor + 28);
  const extraLength = written.readUInt16LE(cursor + 30);
  const commentLength = written.readUInt16LE(cursor + 32);
  const name = written.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
  names.add(name);
  cursor += 46 + nameLength + extraLength + commentLength;
}
const required = ['manifest.json', 'package.json', 'main.js', 'views/index.html', 'views/app.js',
  'views/lib/view-model.js', 'skills/stop-that-shit/SKILL.md', 'skills/stss/SKILL.md',
  ...(manifest.contributes.agentExtensions || [])];
for (const entry of required) {
  if (!names.has(entry)) throw new Error(`package is missing ${entry}`);
}
for (const name of names) {
  if (name.startsWith('.') || name.includes('/.git/') || name.startsWith('node_modules/')) {
    throw new Error(`package contains an excluded path: ${name}`);
  }
}

const bytes = fs.statSync(outputFile).size;
const hash = require('node:crypto').createHash('sha256').update(written).digest('hex');
process.stdout.write(`packed ${entries.length} files -> ${path.relative(root, outputFile)}\n`);
process.stdout.write(`size ${bytes} bytes\nsha256 ${hash}\n`);
