'use strict';

// PI-Desktop resolves `/name` in the composer from prompt templates stored in
// <workspace>/.pi/prompts and ~/.pi/agent/prompts. A template is Markdown with
// front matter and `$ARGUMENTS` expansion, so it is the host-native way to
// hand the Guard its own directive head.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STOP_TEMPLATE = `---
description: Stop That Shit 契约 — review/change/answer/monitor/watch，可加 agents=N、hash=allow、deps=allow、files=a|b
argument-hint: review|change|answer|monitor|watch [agents=N] [hash=allow] [deps=allow] [files=a|b] -- 任务描述
---
$stop-that-shit $ARGUMENTS
`;

const STATUS_TEMPLATE = `---
description: Stop That Shit 状态 — status、runtime、explain evt_…、label evt_… correct
argument-hint: status | runtime | explain evt_… | label evt_… correct
---
$stop-that-shit $ARGUMENTS
`;

const TEMPLATES = [
  { name: 'stop-that-shit', content: STOP_TEMPLATE },
  { name: 'sts', content: STATUS_TEMPLATE }
];

function defaultTemplateDir() {
  return path.join(os.homedir(), '.pi', 'agent', 'prompts');
}

function reasonOf(error) {
  return (error && (error.code || error.message)) || String(error || 'unknown error');
}

// One template's failure must not hide the other's result, so every target is
// attempted once and reports its own outcome.
function installOne(dir, name, content) {
  const file = path.join(dir, `${name}.md`);
  const result = { file, changed: false, status: 'kept' };
  try {
    let current = null;
    let exists = false;
    try {
      current = fs.readFileSync(file, 'utf8');
      exists = true;
    } catch (error) {
      // ENOENT is the first install; anything else (a directory in the way, a
      // denied read) is a real failure worth naming.
      if (error.code !== 'ENOENT') throw error;
    }
    // Identical content needs no write, so a start with current templates costs
    // one read per file instead of a rewrite.
    if (exists && current === content) return result;
    if (exists) {
      // A changed template is replaced, and the text it displaces is kept once.
      // A later refresh must not overwrite that copy, or the second upgrade
      // would erase the only backup.
      const backup = `${file}.bak`;
      if (!fs.existsSync(backup)) {
        fs.writeFileSync(backup, current, 'utf8');
        result.backup = backup;
      }
    }
    // Write aside and rename, so an interrupted run cannot leave a half-written
    // template that the host keeps loading.
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, file);
    result.changed = true;
    result.status = exists ? 'updated' : 'created';
    return result;
  } catch (error) {
    result.error = reasonOf(error);
    return result;
  }
}

function installPromptTemplates(dir = defaultTemplateDir()) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    const reason = reasonOf(error);
    return TEMPLATES.map(({ name }) => ({
      file: path.join(dir, `${name}.md`),
      changed: false,
      status: 'kept',
      error: reason
    }));
  }
  return TEMPLATES.map(({ name, content }) => installOne(dir, name, content));
}

module.exports = { STATUS_TEMPLATE, STOP_TEMPLATE, TEMPLATES, defaultTemplateDir, installPromptTemplates };
