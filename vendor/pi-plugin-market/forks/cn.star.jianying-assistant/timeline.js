'use strict';

const path = require('node:path');
const { directory, mediaPath } = require('./path-safety');

function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown field ${label}.${key}`);
  }
}

function number(value, fallback, min, max, label) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max) {
    throw new Error(`${label} must be a finite number in ${min}..${max}`);
  }
  return result;
}

function title(value = 'Untitled') {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\\/<>:"|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || /^\.+$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error('title must be a safe nonempty filename (maximum 100 characters)');
  }
  return value;
}

function times(item, label) {
  const start = number(item.start, undefined, 0, Number.MAX_VALUE, `${label}.start`);
  const duration = number(item.duration, undefined, Number.MIN_VALUE, Number.MAX_VALUE, `${label}.duration`);
  if (!Number.isFinite(start + duration)) throw new Error(`${label} time range overflows`);
  return { start, duration };
}

async function normalizeTimeline(input, workspace) {
  // A string workspace is the public API; an options object is convenient for callers.
  if (workspace && typeof workspace === 'object') workspace = workspace.workspace;
  if (typeof workspace !== 'string' || !workspace) throw new Error('workspace is required');
  workspace = path.resolve(workspace);
  await directory(workspace);
  object(input, ['title', 'width', 'height', 'fps', 'clips', 'audio', 'texts'], 'timeline');
  const output = {
    title: title(input.title),
    width: number(input.width, 1080, 16, 7680, 'width'),
    height: number(input.height, 1920, 16, 7680, 'height'),
    fps: number(input.fps, 30, 24, 60, 'fps'),
    clips: [], audio: [], texts: [],
  };
  if (output.width % 2 || output.height % 2) throw new Error('width and height must be even integers');
  if (![24, 25, 30, 50, 60].includes(output.fps)) throw new Error('fps must be 24, 25, 30, 50 or 60');
  const arrays = { clips: input.clips, audio: input.audio === undefined ? [] : input.audio, texts: input.texts === undefined ? [] : input.texts };
  for (const [key, value] of Object.entries(arrays)) {
    if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  }
  if (!arrays.clips.length) throw new Error('At least one clip is required');
  if (Object.values(arrays).reduce((sum, items) => sum + items.length, 0) > 500) throw new Error('Maximum 500 timeline entries');
  let outputDuration = 0;
  for (const [i, clip] of arrays.clips.entries()) {
    const label = `clips[${i}]`;
    object(clip, ['path', 'start', 'duration', 'speed', 'volume'], label);
    const timing = times(clip, label);
    const speed = number(clip.speed, 1, 0.1, 10, `${label}.speed`);
    outputDuration += timing.duration / speed;
    if (!Number.isFinite(outputDuration)) throw new Error('Timeline duration overflows');
    output.clips.push({ path: await mediaPath(clip.path, workspace), ...timing, speed, volume: number(clip.volume, 1, 0, 4, `${label}.volume`) });
  }
  for (const [i, audio] of arrays.audio.entries()) {
    const label = `audio[${i}]`;
    object(audio, ['path', 'start', 'duration', 'at', 'volume'], label);
    const timing = times(audio, label);
    const at = number(audio.at, 0, 0, Number.MAX_VALUE, `${label}.at`);
    if (!Number.isFinite(at + timing.duration)) throw new Error(`${label} time range overflows`);
    output.audio.push({ path: await mediaPath(audio.path, workspace), ...timing, at, volume: number(audio.volume, 1, 0, 4, `${label}.volume`) });
  }
  let textLength = 0;
  for (const [i, text] of arrays.texts.entries()) {
    const label = `texts[${i}]`;
    object(text, ['text', 'start', 'duration', 'fontSize', 'color'], label);
    if (typeof text.text !== 'string' || !text.text.length || text.text.length > 5000) throw new Error(`${label}.text must contain 1..5000 characters`);
    textLength += text.text.length;
    if (textLength > 100000) throw new Error('Maximum 100000 text characters');
    const color = text.color === undefined ? '#FFFFFF' : text.color;
    if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) throw new Error(`${label}.color must be #RRGGBB`);
    output.texts.push({ text: text.text, ...times(text, label), fontSize: number(text.fontSize, 8, 1, 200, `${label}.fontSize`), color });
  }
  return output;
}

module.exports = { normalizeTimeline, validateTitle: title };
