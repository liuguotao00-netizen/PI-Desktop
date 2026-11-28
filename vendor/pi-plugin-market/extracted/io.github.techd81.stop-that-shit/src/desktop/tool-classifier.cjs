'use strict';

// PI-Desktop tool classification.
//
// The host reports its own tool names, so this module maps them onto the
// shared mutability vocabulary instead of translating them into another
// host's names. Shell analysis, hash recognition, and manifest dependency
// detection stay in the shared core.

const { manifestDependencyIntent, manifestEditDependencyIntent } = require('../manifest-dependencies.cjs');
const path = require('node:path');
const { analyzeShell, classifyShell } = require('../shell-analysis.cjs');
const { fileHashIntent } = require('../hash-intent.cjs');

// Host paths arrive in whatever shape the tool used; report them relative to
// the working directory in the shared vocabulary (forward slashes, no "./").
function normalizePath(value, cwd) {
  const original = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!original) return '';
  const windowsPath = /^[A-Za-z]:[\\/]|^\\\\/.test(original);
  const windowsCwd = /^[A-Za-z]:[\\/]|^\\\\/.test(String(cwd || ''));
  let normalized = original;
  if (cwd && windowsPath && windowsCwd) {
    normalized = path.win32.relative(String(cwd), original);
  } else if (cwd && path.posix.isAbsolute(original) && path.posix.isAbsolute(String(cwd))) {
    normalized = path.posix.relative(String(cwd), original);
  }
  return normalized.replace(/\\/g, '/').replace(/^\.\//, '');
}

// Read-only tools. `skill` only loads instruction text; `glob` lists paths.
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'glob', 'skill']);
const WRITE_TOOLS = new Set(['write', 'edit']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);
// The host's Task family runs subagents. Waiting, listing, and stopping are
// bookkeeping calls; only Task itself reserves capacity.
const DELEGATION_TOOLS = new Set(['task', 'agent', 'subagent', 'delegate']);
const CONTROL_TOOLS = new Set([
  'taskwait', 'tasklist', 'taskstop',
  'todowrite', 'todo',
  'asktool', 'ask',
  'submitgoal', 'enterplanmode', 'entergoalmode', 'new_context'
]);

function toolKey(toolName) {
  return String(toolName || '').trim().toLowerCase();
}

function isDelegationTool(toolName) {
  return DELEGATION_TOOLS.has(toolKey(toolName));
}

function isControlTool(toolName) {
  return CONTROL_TOOLS.has(toolKey(toolName));
}

function classifyMutability(toolName, toolInput) {
  const name = toolKey(toolName);
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (SHELL_TOOLS.has(name)) return classifyShell(toolInput && toolInput.command);
  if (DELEGATION_TOOLS.has(name)) return 'delegate';
  if (CONTROL_TOOLS.has(name)) return 'control';
  return 'unknown';
}

// A Task call starts exactly one child unless it explicitly fans out.
// Request text cannot be bounded here, so an unrecognized fan-out shape is
// reported as unbounded instead of being counted as one.
function desktopDelegationShape(toolName, toolInput) {
  if (!isDelegationTool(toolName)) return { count: 0, unbounded: false };
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (Array.isArray(input.tasks)) {
    return input.tasks.length > 0 ? { count: input.tasks.length, unbounded: false } : { count: 0, unbounded: true };
  }
  if (input.tasks !== undefined) return { count: 0, unbounded: true };
  if (input.count === 'unbounded' || input.unbounded === true) return { count: 0, unbounded: true };
  return { count: 1, unbounded: false };
}

// A Task call settles its own child unless it declares detached work.
function isBackgroundDelegation(toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  return input.background === true || input.run_in_background === true
    || input.async === true || input.detached === true;
}

function extractAffectedPaths(toolName, toolInput, cwd) {
  if (!WRITE_TOOLS.has(toolKey(toolName))) return [];
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  return [normalizePath(input.path ?? input.file_path, cwd)].filter(Boolean);
}

function editAddedText(toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (Array.isArray(input.edits)) {
    return input.edits.map((edit) => (edit && typeof edit === 'object' ? edit.newText : ''))
      .filter((text) => typeof text === 'string').join('\n');
  }
  return String(input.newText ?? input.content ?? '');
}

function detectDependencyIntent(toolName, toolInput) {
  const name = toolKey(toolName);
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (SHELL_TOOLS.has(name)) return analyzeShell(input.command).dependencyIntent;
  if (name === 'write') return manifestDependencyIntent(input.path, input.content);
  if (name === 'edit') {
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    return edits.some((edit) => edit && manifestEditDependencyIntent(input.path, edit.oldText, edit.newText));
  }
  return false;
}

function detectHashIntent(toolName, toolInput) {
  const name = toolKey(toolName);
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (SHELL_TOOLS.has(name)) return analyzeShell(input.command).hashIntent;
  if (name === 'write') return fileHashIntent(input.path, input.content);
  if (name === 'edit') return fileHashIntent(input.path, editAddedText(input));
  return false;
}

function analyzeDesktopTool(toolName, toolInput, cwd) {
  const name = toolKey(toolName);
  if (SHELL_TOOLS.has(name)) {
    return {
      ...analyzeShell(toolInput && toolInput.command),
      affectedPaths: []
    };
  }
  return {
    mutability: classifyMutability(toolName, toolInput),
    hashIntent: detectHashIntent(toolName, toolInput),
    dependencyIntent: detectDependencyIntent(toolName, toolInput),
    affectedPaths: extractAffectedPaths(toolName, toolInput, cwd)
  };
}

module.exports = {
  CONTROL_TOOLS,
  DELEGATION_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
  analyzeDesktopTool,
  classifyMutability,
  desktopDelegationShape,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths,
  isBackgroundDelegation,
  isControlTool,
  isDelegationTool,
  toolKey
};
