'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeTimeline } = require('../timeline');

async function fixture(t) {
  assert.ok(process.env.PI_SCRATCH_DIR, 'PI_SCRATCH_DIR is required; never use os.tmpdir');
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'jianying-timeline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'video.mp4'), 'local media fixture');
  return root;
}
const base = () => ({ title: '测试工程', clips: [{ path: 'video.mp4', start: 0, duration: 4 }] });

test('normalizes defaults, local paths, speed and separate audio/text times without mutating input', async (t) => {
  const root = await fixture(t);
  const input = base();
  input.clips[0].speed = 2;
  input.audio = [{ path: 'video.mp4', start: 1, duration: 2, at: 0.5, volume: 0 }];
  input.texts = [{ text: '字幕', start: 0, duration: 1, color: '#aAbBcC' }];
  const result = await normalizeTimeline(input, root);
  assert.deepEqual([result.width, result.height, result.fps], [1080, 1920, 30]);
  assert.equal(result.clips[0].path, path.join(root, 'video.mp4'));
  assert.equal(result.clips[0].duration / result.clips[0].speed, 2);
  assert.equal(result.clips[0].volume, 1);
  assert.equal(result.audio[0].at, 0.5);
  assert.equal(result.audio[0].volume, 0);
  assert.equal(result.texts[0].fontSize, 8);
  assert.equal(input.width, undefined);
  assert.equal(input.clips[0].path, 'video.mp4');
});

test('rejects bad root types, unknown fields, canvas, titles and arrays', async (t) => {
  const root = await fixture(t);
  for (const input of [null, [], 'x', { ...base(), extra: 1 }, { ...base(), title: '../bad' }, { ...base(), title: 'a\\b' }, { ...base(), title: 'CON' }, { ...base(), title: 'x'.repeat(101) }, { ...base(), title: 42 }, { ...base(), title: '' }, { ...base(), width: 17 }, { ...base(), height: 7682 }, { ...base(), width: '1080' }, { ...base(), fps: 29.97 }, { ...base(), clips: [] }, { ...base(), audio: null }, { ...base(), texts: {} }]) {
    await assert.rejects(normalizeTimeline(input, root));
  }
  for (const fps of [24, 25, 30, 50, 60]) assert.equal((await normalizeTimeline({ ...base(), fps }, root)).fps, fps);
});

test('rejects invalid finite ranges and unknown entry fields', async (t) => {
  const root = await fixture(t);
  for (const overrides of [{ start: -1 }, { start: NaN }, { start: Infinity }, { duration: 0 }, { duration: -1 }, { duration: '1' }, { duration: null }, { speed: 0.09 }, { speed: 11 }, { speed: NaN }, { volume: -0.1 }, { volume: 4.1 }, { extra: true }, { start: Number.MAX_VALUE, duration: Number.MAX_VALUE }]) {
    const input = base(); Object.assign(input.clips[0], overrides);
    await assert.rejects(normalizeTimeline(input, root));
  }
  for (const overrides of [{ at: -1 }, { volume: Infinity }, { speed: 2 }]) {
    await assert.rejects(normalizeTimeline({ ...base(), audio: [{ path: 'video.mp4', start: 0, duration: 1, ...overrides }] }, root));
  }
  for (const overrides of [{ text: 1 }, { text: '' }, { text: 'x'.repeat(5001) }, { color: '#abc' }, { color: 'red' }, { fontSize: 0 }, { fontSize: 201 }, { start: -1 }, { duration: 0 }, { position: 5 }]) {
    await assert.rejects(normalizeTimeline({ ...base(), texts: [{ text: 'x', start: 0, duration: 1, ...overrides }] }, root));
  }
});

test('enforces aggregate 500 entries and 100k text limits', async (t) => {
  const root = await fixture(t);
  await assert.rejects(normalizeTimeline({ ...base(), texts: Array.from({ length: 500 }, () => ({ text: 'x', start: 0, duration: 1 })) }, root), /500/);
  await assert.rejects(normalizeTimeline({ ...base(), texts: Array.from({ length: 21 }, () => ({ text: 'x'.repeat(5000), start: 0, duration: 1 })) }, root), /100000/);
  const result = await normalizeTimeline({ ...base(), texts: Array.from({ length: 20 }, () => ({ text: 'x'.repeat(5000), start: 0, duration: 1 })) }, root);
  assert.equal(result.texts.length, 20);
});

test('rejects missing media, directories, URLs, UNC, device paths and ADS', async (t) => {
  const root = await fixture(t);
  for (const source of ['missing.mp4', '.', 'https://example.com/v.mp4', 'file:///video.mp4', '\\\\server\\share\\v.mp4', '//server/share/v.mp4', '\\\\?\\C:\\v.mp4', 'video.mp4:stream', 123]) {
    const input = base(); input.clips[0].path = source;
    await assert.rejects(normalizeTimeline(input, root));
  }
  await assert.rejects(normalizeTimeline(base(), path.join(root, 'missing-workspace')));
});

test('rejects symlink/junction media traversal', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'real');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'media.mp4'), 'x');
  await fs.symlink(target, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const input = base(); input.clips[0].path = 'linked/media.mp4';
  await assert.rejects(normalizeTimeline(input, root), /Symbolic links/);
});
