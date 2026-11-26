'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function inside(root, target, allowRoot = false) {
  const relative = path.relative(root, target);
  return (allowRoot && relative === '') || (relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function localPath(value, label = 'path') {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^[\\/]{2}/.test(value) || /^file:/i.test(value)) {
    throw new Error(`${label} must be a local filesystem path (no URLs or UNC paths)`);
  }
  // NTFS alternate data streams and device namespaces are not media/directory paths.
  if (value.replace(/^[a-z]:[\\/]/i, '').includes(':')) throw new Error(`${label} contains an invalid colon`);
  for (const component of value.replace(/^[a-z]:[\\/]/i, '').split(/[\\/]/)) {
    if (component && component !== '.' && component !== '..' && (/[. ]$/.test(component) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component))) {
      throw new Error(`${label} contains a Windows alias/device path component`);
    }
  }
  return value;
}

async function noLinks(target, { allowMissing = false } = {}) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links/junctions are not allowed: ${current}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
  }
}

async function directory(target, allowMissing = false) {
  await noLinks(target, { allowMissing });
  try {
    if (!(await fs.lstat(target)).isDirectory()) throw new Error(`Not a directory: ${target}`);
  } catch (error) {
    if (!(allowMissing && error.code === 'ENOENT')) throw error;
  }
}

async function mkdirSafe(target) {
  await directory(target, true);
  await fs.mkdir(target, { recursive: true });
  await directory(target);
}

async function regularFile(target) {
  await noLinks(target);
  const stat = await fs.lstat(target);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${target}`);
  return stat;
}

async function mediaPath(value, workspace) {
  localPath(value, 'media path');
  const absolute = path.resolve(workspace, value);
  await regularFile(absolute);
  return absolute;
}

async function treeNoLinks(root) {
  await directory(root);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${target}`);
    if (entry.isDirectory()) await treeNoLinks(target);
    else {
      const stat = await regularFile(target);
      if (stat.nlink > 1) throw new Error(`Hard links are not allowed in managed trees: ${target}`);
    }
  }
}

module.exports = { inside, localPath, noLinks, directory, mkdirSafe, regularFile, mediaPath, treeNoLinks };
