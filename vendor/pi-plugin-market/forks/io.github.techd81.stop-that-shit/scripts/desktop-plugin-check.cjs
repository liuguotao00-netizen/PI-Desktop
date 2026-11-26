#!/usr/bin/env node

'use strict';

// Validates the PI-Desktop manifest and the files it points at.
// Rules come from docs/spec/07-plugins/02-plugin-manifest-schema.md and
// 16-trusted-extensions.md in the host repository (v0.22.0).

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const failures = [];
const warnings = [];

function fail(message) { failures.push(message); }
function warn(message) { warnings.push(message); }

function rel(target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function inside(target) {
  const absolute = path.resolve(root, target);
  return absolute === root || absolute.startsWith(`${root}${path.sep}`);
}

function existsFile(entry, label) {
  if (typeof entry !== 'string' || !entry.trim()) {
    fail(`${label} must be a non-empty string`);
    return null;
  }
  if (path.isAbsolute(entry)) {
    fail(`${label} must be relative: ${entry}`);
    return null;
  }
  if (!inside(entry)) {
    fail(`${label} escapes the plugin directory: ${entry}`);
    return null;
  }
  const absolute = path.join(root, entry);
  if (!fs.existsSync(absolute)) {
    fail(`${label} does not exist: ${entry}`);
    return null;
  }
  return absolute;
}

function checkFrontMatter(file, label) {
  const text = fs.readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) {
    fail(`${label} has no front matter`);
    return;
  }
  const name = /^name:\s*(.+)$/m.exec(match[1]);
  const description = /^description:\s*(.+)$/m.exec(match[1]);
  if (!name) fail(`${label} front matter has no name`);
  if (!description) {
    fail(`${label} front matter has no description`);
    return;
  }
  if (description[1].trim().length > 240) {
    warn(`${label} description is ${description[1].trim().length} chars; the host caps skill descriptions at 240`);
  }
}

// Mirrors the host's own derivation: file stem, lowercased, non-alphanumerics
// collapsed to '-', falling back to "skill".
function skillIdFromPath(relative) {
  const base = String(relative).split(/[\\/]/).pop() || String(relative);
  return base.replace(/\.[^.]+$/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

const manifestPath = path.join(root, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  fail('manifest.json is missing');
} else {
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`manifest.json is not valid JSON: ${error.message}`);
  }
  if (manifest) {
    if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1');
    if (typeof manifest.id !== 'string' || !/^[a-z0-9]+(\.[a-z0-9_-]+)+$/.test(manifest.id)) {
      fail(`id is not a valid plugin id: ${manifest.id}`);
    }
    if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
      fail(`version is not semver: ${manifest.version}`);
    }
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) fail('name is required');
    if (typeof manifest.description !== 'string' || !manifest.description.trim()) fail('description is required');

    const mainFile = existsFile(manifest.main, 'main');
    if (mainFile && path.extname(mainFile) !== '.js') fail('main must point at a .js module');
    if (mainFile) {
      try {
        // Parse only: the module needs the host global to run.
        new Function(fs.readFileSync(mainFile, 'utf8').replace(/^#!.*\n/, ''));
      } catch (error) {
        fail(`main.js does not parse: ${error.message}`);
      }
    }

    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    if (permissions.length === 0) fail('permissions must list what the plugin uses');
    const contributes = manifest.contributes || {};

    const extensions = contributes.agentExtensions;
    if (extensions !== undefined) {
      if (!Array.isArray(extensions) || extensions.length === 0) fail('contributes.agentExtensions must be a non-empty array');
      else if (extensions.length > 8) fail('contributes.agentExtensions allows at most 8 entries');
      if (!permissions.includes('agent.extension')) fail('contributes.agentExtensions requires the agent.extension permission');
      for (const [index, entry] of (extensions || []).entries()) {
        const file = existsFile(entry, `contributes.agentExtensions[${index}]`);
        if (file && !['.ts', '.mts', '.js', '.mjs'].includes(path.extname(file))) {
          fail(`agent extension must be .ts, .mts, .js, or .mjs: ${entry}`);
        }
      }
    }

    const skills = contributes.skills;
    if (skills !== undefined) {
      if (!Array.isArray(skills) || skills.length === 0) fail('contributes.skills must be a non-empty array');
      else if (skills.length > 32) fail('contributes.skills allows at most 32 entries');
      if (!permissions.includes('agent.prompt.inject')) fail('contributes.skills requires the agent.prompt.inject permission');
      // The host accepts `{ id, path }` or a bare path, and derives the id from
      // the file stem slugged to [a-z0-9-] when no id is given. Two SKILL.md
      // entries therefore collide and the second is dropped as DUPLICATE at load
      // time, so a repeated stem needs an explicit id.
      const declaredIds = new Map();
      for (const [index, raw] of (skills || []).entries()) {
        const entry = typeof raw === 'string' ? { path: raw } : (raw || {});
        const relative = String(entry.path ?? '').trim();
        if (!relative) {
          fail(`contributes.skills[${index}] has no path`);
          continue;
        }
        const hasId = typeof entry.id === 'string' && entry.id.trim().length > 0;
        if (hasId && !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(entry.id.trim())) {
          fail(`contributes.skills[${index}].id must be a lowercase slug: ${entry.id}`);
        }
        const skillId = hasId ? entry.id.trim() : skillIdFromPath(relative);
        if (declaredIds.has(skillId)) {
          fail(`contributes.skills[${index}] reuses the host skill id "${skillId}" from ${declaredIds.get(skillId)}; the host keeps only the first entry`);
        } else {
          declaredIds.set(skillId, relative);
        }
        const label = `skill ${relative}`;
        const target = existsFile(relative, `contributes.skills[${index}]`);
        if (!target) continue;
        const stat = fs.statSync(target);
        if (stat.isFile()) {
          if (path.extname(target) !== '.md') fail(`skill entry must be .md or a directory: ${relative}`);
          else checkFrontMatter(target, label);
        } else {
          const skillFile = path.join(target, 'SKILL.md');
          if (!fs.existsSync(skillFile)) fail(`skill directory has no SKILL.md: ${relative}`);
          else checkFrontMatter(skillFile, label);
        }
      }
    }

    const commands = contributes.commands;
    if (commands !== undefined) {
      if (!Array.isArray(commands)) fail('contributes.commands must be an array');
      for (const [index, command] of (commands || []).entries()) {
        if (!command || typeof command.id !== 'string' || !/^[a-z0-9]+(\.[a-z0-9_-]+)+$/.test(command.id)) {
          fail(`contributes.commands[${index}].id is not a valid command id`);
        }
        if (!command || typeof command.title !== 'string' || !command.title.trim()) {
          fail(`contributes.commands[${index}].title is required`);
        }
      }
    }

    const ui = manifest.ui || {};
    const panel = existsFile(ui.panel, 'ui.panel');
    if (panel) {
      const html = fs.readFileSync(panel, 'utf8');
      if (!/<meta\s+name="pi-plugin-chrome"\s+content="v2"/.test(html)) {
        warn('ui.panel does not declare <meta name="pi-plugin-chrome" content="v2">');
      }
      for (const [, asset] of html.matchAll(/(?:src|href)="([^":]+)"/g)) {
        const target = path.join(path.dirname(panel), asset);
        if (!fs.existsSync(target)) fail(`ui.panel references a missing asset: ${rel(target)}`);
      }
    }
    for (const key of ['en', 'zh-CN']) {
      const title = ui.title && ui.title[key];
      if (typeof title !== 'string' || !title.trim()) fail(`ui.title.${key} is required for the marketplace gate`);
    }

    const i18n = manifest.i18n || {};
    for (const key of ['en', 'zh-CN']) {
      const block = i18n[key] || {};
      for (const field of ['name', 'description', 'safetyNotes']) {
        if (typeof block[field] !== 'string' || !block[field].trim()) fail(`i18n.${key}.${field} is required`);
      }
    }
    if (typeof manifest.safetyNotes !== 'string' || !manifest.safetyNotes.trim()) fail('top-level safetyNotes is required');
    if (manifest.activationEvents && !Array.isArray(manifest.activationEvents)) fail('activationEvents must be an array');
  }
}

for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
for (const warning of warnings) process.stdout.write(`WARN ${warning}\n`);
if (failures.length === 0) {
  process.stdout.write(`PASS PI-Desktop manifest and ${warnings.length} warning(s)\n`);
  process.exitCode = 0;
} else {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exitCode = 1;
}
