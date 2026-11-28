'use strict';
const { ROOT, MEMORY_ROOT, hash } = require('./core.cjs');
const { usableMemory, sensitiveMemory } = require('./memory-policy.cjs');
const { isInterrupted } = require('./operation-errors.cjs');

const MAIN_MEMORY_PATH = `${MEMORY_ROOT}/MEMORY.md`;
const MAX_MAIN_MEMORY_BYTES = 64 * 1024;
const MARKER = '<!-- bone-project-wiki:main-memory:v1';
const header = /^<!-- bone-project-wiki:main-memory:v1 sha256:([a-f0-9]{64}) -->\n/;
const markdown = value => String(value).replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').replace(/[\\`*_[\]<>]/g, '\\$&');
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const isMainMemory = raw => typeof raw === 'string' && raw.startsWith(MARKER);
function ownedMainMemory(raw) {
  const match = header.exec(raw || '');
  return Boolean(match && hash(raw.slice(match[0].length)) === match[1]);
}
function seal(body) { return `${MARKER} sha256:${hash(body)} -->\n${body}`; }

/** Derived routes only. Actual records, confirmation, scope and linked sources remain authoritative. */
function renderMainMemory(entries) {
  const eligible = entries.filter(entry => entry.status === 'confirmed' && usableMemory(entry)
    && (!entry.documentRef || entry.documentLink?.state === 'current')
    && typeof entry.path === 'string' && entry.path.startsWith(`${MEMORY_ROOT}/`) && entry.path !== MAIN_MEMORY_PATH);
  const rows = eligible.map(entry => ({ entry, topic: entry.topics?.[0] || 'Ungrouped' }))
    .sort((a, b) => order(a.topic, b.topic) || order(a.entry.importance === 'core' ? 0 : 1, b.entry.importance === 'core' ? 0 : 1) || order(a.entry.id, b.entry.id));
  let body = '# Project memory\n\nGenerated routing index. Read the actual record and current source before using or revising a fact.\n'
    + 'This file is not an additional memory record or instruction layer. Use project_wiki action memoryIndex for a freshly verified view.\n'
    + 'Edit topic records through project_wiki; the plugin maintains this file. Drafts, archived entries and unverifiable linked summaries are excluded.\n\n';
  let group = '', count = 0;
  for (const { entry, topic } of rows) {
    const title = sensitiveMemory(entry.title || '') ? `Memory ${entry.id}` : entry.title || 'Untitled memory';
    const relativePath = entry.path.slice(MEMORY_ROOT.length + 1);
    const target = relativePath.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
    const row = `${topic !== group ? `## ${markdown(topic)}\n\n` : ''}- [${markdown(title)}](${target})${entry.importance === 'core' ? ' — core' : ''}\n`
      + `  - Read: project_wiki read, section=memory, id=${markdown(entry.id)}\n`
      + `  - Revision: ${markdown(entry.revision || '')}\n`
      + `  - Scope: ${entry.scopePaths?.length ? entry.scopePaths.map(markdown).join(', ') : 'current project'}\n`
      + (entry.documentRef ? `  - Source: recordId=${markdown(entry.documentRef.recordId)}; read when ${markdown(entry.documentRef.readWhen)}\n` : '')
      + (entry.topics?.length > 1 ? `  - Topics: ${entry.topics.map(markdown).join(', ')}\n` : '') + '\n';
    if (Buffer.byteLength(body + row, 'utf8') > MAX_MAIN_MEMORY_BYTES - 512) continue;
    body += row; group = topic; count++;
  }
  const omitted = eligible.length - count;
  if (!count) body += 'No confirmed memory routes are currently available.\n';
  if (omitted) body += `\n${omitted} additional routes exceed this file's bounded size. Use memoryOverview to inspect the full collection.\n`;
  return { path: MAIN_MEMORY_PATH, content: seal(body), count, omitted };
}

class MainMemoryIndex {
  constructor(service) { this.service = service; }
  async read(workspacePath) {
    await this.service.initialized(workspacePath);
    const scanned = await this.service.scan('memory', workspacePath);
    const loaded = await this.service.documentMemories.projectRows(scanned.entries, undefined, workspacePath, { readBodies: true, includeUnreadable: true });
    const result = renderMainMemory(loaded);
    const stored = await this.service.existsFresh(MAIN_MEMORY_PATH, workspacePath);
    return { ...result, revision: hash(result.content), persisted: stored === result.content,
      ...(stored !== null && !ownedMainMemory(stored) ? { error: 'MAIN_MEMORY_FILE_CONFLICT' } : {}) };
  }
  async sync(workspacePath) {
    const result = await this.read(workspacePath);
    if (result.persisted) return this.metadata(result);
    if (result.error) throw new Error(result.error);
    const current = await this.service.existsFresh(MAIN_MEMORY_PATH, workspacePath);
    if (current !== null && !ownedMainMemory(current)) throw new Error('MAIN_MEMORY_FILE_CONFLICT');
    // One publication, no verification retry that could adopt a competing writer's version.
    await this.service.writeFile(MAIN_MEMORY_PATH, result.content, workspacePath);
    if (await this.service.readFreshFile(MAIN_MEMORY_PATH, workspacePath) !== result.content) throw new Error('MAIN_MEMORY_WRITE_VERIFY_FAILED');
    return this.metadata({ ...result, persisted: true });
  }
  metadata(result) {
    const { content, ...metadata } = result;
    return metadata;
  }
  async synchronize(workspacePath) {
    try { return await this.sync(workspacePath); }
    catch (error) {
      if (isInterrupted(error)) throw error;
      return { path: MAIN_MEMORY_PATH, persisted: false,
        error: error.message === 'MAIN_MEMORY_FILE_CONFLICT' ? error.message : 'MAIN_MEMORY_UPDATE_FAILED' };
    }
  }
}
function changesMainMemory(name) {
  return name === `${ROOT}/project.json` || (name !== MAIN_MEMORY_PATH && /\.md$/i.test(name)
    && (name.startsWith(`${ROOT}/knowledge/`) || name.startsWith(`${MEMORY_ROOT}/`)));
}
module.exports = { MAIN_MEMORY_PATH, MAX_MAIN_MEMORY_BYTES, isMainMemory, ownedMainMemory, renderMainMemory, changesMainMemory, MainMemoryIndex };
