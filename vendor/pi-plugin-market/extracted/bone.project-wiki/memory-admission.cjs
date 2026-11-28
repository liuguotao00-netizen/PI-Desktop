'use strict';
const { text } = require('./core.cjs');
const { MEMORY_CONTENT_LIMIT, normalizedText, sensitiveMemory, usableMemory } = require('./memory-policy.cjs');
const { normalizeMemoryMetadata, normalizeScopePaths } = require('./memory-selection.cjs');

const ENUMS = {
  decision: ['retain', 'skip'], value: ['high', 'normal', 'low'],
  stability: ['durable', 'temporary'], novelty: ['new', 'update', 'duplicate'],
};
const TEXT_LIMITS = { reason: 400, futureUse: 400, evidence: 1000 };
const ASSESSMENT_KEYS = new Set([...Object.keys(ENUMS), ...Object.keys(TEXT_LIMITS)]);
const HAN = /\p{Script=Han}/u;
const PLACEHOLDERS = new Set([
  '以后有用', '供以后参考', '以后参考', '未来有用', '以后再用', '供参考',
  'for future use', 'for future reference', 'useful later', 'useful in future', 'useful in the future',
  'n/a', 'none', 'unknown', 'tbd', '无', '待定', '未提供',
]);
const EXPLANATIONS = {
  assessment_skip: 'The current Agent assessed this candidate as unnecessary to retain.',
  low_value: 'The current Agent assessed this candidate as low value.',
  temporary: 'The current Agent assessed this candidate as temporary.',
  duplicate: 'An equivalent memory is already retained or the current Agent classified it as a duplicate.',
  sensitive: 'The candidate or its assessment contains sensitive information and was not retained.',
};
const canonicalFact = value => normalizedText(value).normalize('NFKC').toLowerCase();
const placeholder = value => PLACEHOLDERS.has(canonicalFact(value).replace(/[.!！?？。;；]+$/u, '').trim());

function requiresMemoryAssessment(input) {
  return input?.action === 'remember' || (input?.action === 'save'
    && (input.kind === 'memory' || input.category === 'memory' || input.section === 'memory'));
}

function parseAssessment(input) {
  if (input?.assessment === undefined) throw new Error('MEMORY_ASSESSMENT_REQUIRED');
  const value = input.assessment;
  const invalid = () => { throw new Error('INVALID_MEMORY_ASSESSMENT'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  if (Object.keys(value).some(key => !ASSESSMENT_KEYS.has(key))) invalid();
  const required = value.decision === 'retain' ? [...ASSESSMENT_KEYS] : ['decision', 'reason'];
  if (required.some(key => !Object.hasOwn(value, key))) invalid();
  const assessment = {};
  for (const [key, item] of Object.entries(value)) {
    if (ENUMS[key]) {
      if (!ENUMS[key].includes(item)) invalid();
      assessment[key] = item;
    } else {
      if (typeof item !== 'string' || item.length > TEXT_LIMITS[key] || !item.trim()
        || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item)) invalid();
      assessment[key] = item.trim();
    }
  }
  return assessment;
}

function assessmentSummary(assessment) {
  // This reports the current model's judgment, never independent host fact verification.
  const { evidence, ...summary } = assessment;
  for (const key of ['reason', 'futureUse']) {
    if (summary[key] && sensitiveMemory(summary[key])) summary[key] = 'Sensitive assessment details omitted.';
  }
  return { ...summary, source: 'current-agent', independentlyVerified: false };
}
function skip(assessment, reasonCode) {
  return { accepted: false, saved: false, decision: 'skip', reasonCode,
    explanation: EXPLANATIONS[reasonCode], assessment: assessmentSummary(assessment) };
}
function sensitiveCandidate(input, assessment) {
  const fields = ['title', 'memoryTitle', 'content', 'summary', 'source', 'readWhen', 'category'];
  const values = [...fields.map(key => input[key]), ...Object.values(assessment),
    ...(Array.isArray(input.tags) ? input.tags : []), ...(Array.isArray(input.topics) ? input.topics : []),
    ...(Array.isArray(input.scopePaths) ? input.scopePaths : []), input.documentRef?.readWhen];
  return values.some(value => typeof value === 'string' && sensitiveMemory(value));
}
function chineseText(value, limit, code) {
  if (typeof value !== 'string' || value.length > limit || !HAN.test(value) || !value.trim()) throw new Error(code);
}

function assessMemory(input) {
  const assessment = parseAssessment(input);
  if (assessment.decision === 'skip') return skip(assessment, 'assessment_skip');
  if (assessment.value === 'low') return skip(assessment, 'low_value');
  if (assessment.stability === 'temporary') return skip(assessment, 'temporary');
  if (assessment.novelty === 'duplicate') return skip(assessment, 'duplicate');
  if (sensitiveCandidate(input, assessment)) return skip(assessment, 'sensitive');

  const kind = input.kind || 'memory';
  if (!['memory', 'document'].includes(kind)) throw new Error('INVALID_MEMORY_KIND');
  if (input.status !== 'confirmed') throw new Error(kind === 'document' ? 'CONFIRMED_DOCUMENT_REQUIRED' : 'CONFIRMED_MEMORY_REQUIRED');
  const title = kind === 'document' && input.memoryTitle !== undefined ? input.memoryTitle : input.title;
  const summary = kind === 'document' ? input.summary : input.content;
  chineseText(title, 200, 'MEMORY_CHINESE_TITLE_REQUIRED');
  chineseText(summary, MEMORY_CONTENT_LIMIT, 'MEMORY_CHINESE_SUMMARY_REQUIRED');
  if (!usableMemory({ content: summary })) throw new Error('INVALID_MEMORY_SUMMARY');
  if (typeof input.source !== 'string' || !input.source.trim() || input.source.length > 2000 || placeholder(input.source)) throw new Error('MEMORY_SOURCE_REQUIRED');
  // These are bounded format/placeholder checks; they cannot establish semantic quality.
  if (placeholder(assessment.futureUse) || placeholder(assessment.evidence)) throw new Error('INVALID_MEMORY_ASSESSMENT');
  normalizeMemoryMetadata(input);
  if (assessment.novelty === 'update'
    && (!(typeof input.id === 'string' && input.id.trim()) && !(typeof input.recordId === 'string' && input.recordId.trim())
      || typeof input.expectedRevision !== 'string' || !input.expectedRevision.trim())) throw new Error('MEMORY_UPDATE_REVISION_REQUIRED');
  if (kind === 'document') {
    if (!text(input.title, 'title', 200).trim()) throw new Error('TITLE_REQUIRED');
    if (!text(input.content, 'content').trim()) throw new Error('DOCUMENT_CONTENT_REQUIRED');
    const readWhen = text(input.readWhen, 'readWhen', 240).trim();
    if (!readWhen || !usableMemory({ content: readWhen }) || /[\x00-\x1f\x7f]/.test(readWhen)) throw new Error('INVALID_MEMORY_SUMMARY');
  }
  return { accepted: true, decision: 'retain', assessment: assessmentSummary(assessment) };
}

function sameScope(entry, input) {
  try {
    const key = value => JSON.stringify(normalizeScopePaths(value).sort());
    return key(entry.scopePaths) === key(input.scopePaths);
  } catch {
    // Invalid stored metadata cannot establish an eligible duplicate.
    return false;
  }
}
async function maintainMemory(service, input) {
  const admission = assessMemory(input);
  if (!admission.accepted) return admission;
  const { assessment, ...payload } = input;
  // Capture validated fields before I/O so a caller cannot replace them across awaits.
  for (const key of ['tags', 'topics', 'scopePaths']) {
    if (Array.isArray(payload[key])) payload[key] = [...payload[key]];
  }
  if (payload.documentRef) payload.documentRef = { ...payload.documentRef };
  const kind = payload.kind || 'memory';
  if (kind === 'document') payload.memoryTitle ??= payload.title;
  if (!payload.id && !payload.recordId) {
    const fact = canonicalFact(kind === 'document' ? payload.summary : payload.content);
    const { loaded } = await service.memoryViews.records(payload.workspacePath);
    const duplicate = loaded.some(entry => (entry.kind === 'memory' || entry.category === 'memory')
      && entry.status === 'confirmed' && entry.readable !== false && usableMemory(entry)
      && !sensitiveMemory(normalizedText(entry.title))
      && (!entry.documentRef || entry.documentLink?.state === 'current')
      && (!entry.documentLink || entry.documentLink.state === 'current')
      && sameScope(entry, payload) && canonicalFact(entry.content) === fact);
    if (duplicate) return skip(admission.assessment, 'duplicate');
  }
  if (kind === 'document') {
    const result = await service.documentMemories.remember({ ...payload, kind, section: 'knowledge' });
    // linked:false still means that the complete document was saved successfully.
    return { ...admission, saved: true, ...result };
  }
  const { memoryTitle, ...memory } = payload;
  const entry = await service.save({ ...memory, kind, section: 'memory', category: payload.category || 'memory' });
  return { ...admission, saved: true, entry };
}

module.exports = { assessMemory, maintainMemory, requiresMemoryAssessment };
