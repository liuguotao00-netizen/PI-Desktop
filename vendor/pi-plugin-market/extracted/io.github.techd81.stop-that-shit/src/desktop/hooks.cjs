'use strict';

// PI-Desktop adapter: native ExtensionAPI events -> ControlEvent v2.
//
// PI-Desktop emits `before_agent_start` (prompt + system prompt, result is a
// prompt replacement), `tool_call` (block with reason), `tool_result`
// (replacement result), `session_start`, and `session_shutdown`. It does not
// emit `input`, so directives are read from the turn's prompt at
// `before_agent_start` - the same first-line boundary, applied once per turn.

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { parseContractPrompt } = require('../contracts.cjs');
const { handleControlEvent } = require('../controller.cjs');
const { readState } = require('../state.cjs');
const {
  analyzeDesktopTool,
  desktopDelegationShape,
  isBackgroundDelegation,
  isDelegationTool
} = require('./tool-classifier.cjs');
// PI-Desktop reports a detached launch with any of these flags.
const ASYNC_FIELDS = [
  'async_launched',
  'asyncLaunched',
  'run_in_background',
  'runInBackground',
  'background'
];

function readAsyncLaunched(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of ASYNC_FIELDS) {
      if (typeof source[field] === 'boolean') return source[field];
    }
  }
  return null;
}

function optionalIdentifier(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || null;
}

const SKILL_INVOCATION = /(^|[\s(（])\/skill:(?:stop-that-shit|sts)\b/gi;
// PI-Desktop's composer only offers `/`. The two contributed templates expand
// to the `$` head, and a raw `/stop-that-shit`, `/sts` or `$sts` is accepted
// too, with `:` or a dash allowed between the head and its first field.
const SLASH_BARE_HEAD = /^(\s*)\/(?:stop-that-shit|sts)[ \t]*$/i;
const SLASH_HEAD = /^(\s*)\/(?:stop-that-shit|sts)(?=$|[\s,:—–])[ \t]*[:,—–]?[ \t]*/i;
const DOLLAR_ALIAS = /(^|[\s(（])\$sts(?=$|[\s,:—–])/gi;
// `$stop-that-shit:status` is the same instruction as `$stop-that-shit status`.
const DOLLAR_SEPARATOR = /^(\s*)\$stop-that-shit[ \t]*[:,—–][ \t]*/i;
// Query verbs take no task text, so a tail after one is punctuation rather than
// a directive field. `runtime all` is part of the query, not a tail.
const QUERY_VERB = /^\$stop-that-shit\s+(status|runtime(?:\s+all)?|doctor)\b[\s\S]*$/i;
const BARE_HEAD = /^\$stop-that-shit$/i;
// A head only counts as a directive where the shared contract parser would
// accept one: four spaces or a tab makes it an indented sample instead.
const INDENTED_SAMPLE = /^(?: {4,}|\t)/;
// A head on a later line is lifted out of prose only when it carries contract
// wording, so a quoted `/sts status` example stays a quotation.
const CONTRACT_HINT = /\b(?:answer|review|change|monitor|open|watch|guard|lock|off)\b|\b(?:agents|hash|files|deps)=|(?:^|\s)--(?:\s|$)/i;

function firstContentLine(text) {
  const line = String(text || '').split('\n').find((candidate) => candidate.trim());
  return String(line === undefined ? '' : line).replace(/\r$/, '');
}

function liftDirectiveLines(text) {
  const lines = String(text).split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    const match = SLASH_HEAD.exec(line);
    if (!match) continue;
    const tail = line.slice(match[0].length);
    if (!CONTRACT_HINT.test(tail)) continue;
    lines[index] = `${match[1]}$stop-that-shit ${tail}`;
  }
  return lines.join('\n');
}

function normalizeDesktopPrompt(text) {
  // A leading BOM arrives when a directive is pasted from an editor; the shared
  // parser does not treat it as line start, so it would arm nothing.
  const source = String(text || '').replace(/^\uFEFF/, '');
  const [first = '', ...rest] = source.replace(SKILL_INVOCATION, '$1$stop-that-shit').split('\n');
  const head = first
    .replace(SLASH_BARE_HEAD, '$1$stop-that-shit status')
    .replace(SLASH_HEAD, '$1$stop-that-shit ');
  const normalized = [head, ...rest].join('\n')
    .replace(DOLLAR_ALIAS, '$1$stop-that-shit')
    .replace(DOLLAR_SEPARATOR, '$1$stop-that-shit ');
  const lifted = liftDirectiveLines(normalized);
  const line = firstContentLine(lifted);
  // A head the shared parser would read as an indented sample stays untouched.
  if (INDENTED_SAMPLE.test(line)) return lifted;
  const trimmed = line.trim();
  // The composer expands the templates with an empty `$ARGUMENTS`, so a bare
  // head is how `/sts` arrives; it asks for the current state.
  if (BARE_HEAD.test(trimmed)) return '$stop-that-shit status';
  const query = QUERY_VERB.exec(trimmed);
  if (query) return `$stop-that-shit ${query[1].replace(/\s+/g, ' ').toLowerCase()}`;
  return lifted;
}

function isDesktopDoctorPrompt(text) {
  const line = firstContentLine(normalizeDesktopPrompt(text));
  if (INDENTED_SAMPLE.test(line)) return false;
  return /^\$stop-that-shit\s+doctor\s*$/i.test(line.trim());
}

function hostMetadata(context = {}) {
  return {
    family: 'desktop',
    mode: context.mode || null,
    hasUI: context.hasUI !== false,
    model: context.model || null
  };
}

function sessionIdOf(context = {}) {
  return String(context.sessionId || '');
}

function toPromptEvent(input, context = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind: 'prompt.submit',
    sessionId: sessionIdOf(context),
    prompt: normalizeDesktopPrompt(input && input.text),
    host: hostMetadata(context)
  };
}

function toActionEvent(input, context = {}) {
  const toolName = String(input && input.toolName || 'unknown');
  const toolInput = input && input.input;
  const delegation = desktopDelegationShape(toolName, toolInput);
  const analysis = analyzeDesktopTool(toolName, toolInput, context.cwd);
  const actionId = optionalIdentifier(input && input.toolCallId, input && input.tool_call_id);
  // A delegation without a stable call identity cannot be reserved, released,
  // or replayed safely; ordinary actions keep their path checks.
  if (analysis.mutability === 'delegate' && !actionId) return null;
  const action = {
    id: actionId,
    name: toolName,
    input: toolInput,
    ...analysis,
    cwd: context.cwd,
    delegationCount: delegation.count,
    completionScope: 'call',
    unboundedDelegation: delegation.unbounded,
    asyncLaunched: isDelegationTool(toolName) ? isBackgroundDelegation(toolInput) : undefined
  };
  if (action.asyncLaunched === undefined) delete action.asyncLaunched;
  return {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind: 'action.before',
    sessionId: sessionIdOf(context),
    host: hostMetadata(context),
    action
  };
}

// A settled Task call is the host's completion signal for that call. Detached
// launches keep their reservation; unknown shapes stay reserved as well.
function toActionAfterEvent(input, context = {}) {
  const toolName = String(input && input.toolName || '');
  if (!isDelegationTool(toolName)) return null;
  const actionId = optionalIdentifier(input && input.toolCallId, input && input.tool_call_id);
  if (!actionId) return null;
  const asyncLaunched = readAsyncLaunched(input, input && input.details);
  const detached = asyncLaunched === true || isBackgroundDelegation(input && input.input);
  return {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind: 'action.after',
    sessionId: sessionIdOf(context),
    host: hostMetadata(context),
    action: {
      id: actionId,
      lifecycle: detached ? 'running' : 'joined',
      completed: true
    }
  };
}

function toSessionEvent(kind, context = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind,
    sessionId: sessionIdOf(context),
    host: hostMetadata(context)
  };
}

function controllerOptions(options) {
  // A block is a denial handed back to the agent; the host's final effect is
  // not observed, which the audit record keeps saying.
  // The block happens before the tool runs; PI-Desktop records no permission
  // dialog, so this is a pre-execution denial, not a permission-dialog result.
  return { ...options, denialResponseOutcome: 'execution_denial_returned' };
}

function handleDesktopPrompt(input, context = {}, options = {}) {
  return handleControlEvent(toPromptEvent(input, context), controllerOptions(options));
}

function handleDesktopTool(input, context = {}, options = {}) {
  const event = toActionEvent(input, context);
  return event ? handleControlEvent(event, controllerOptions(options)) : { kind: 'none' };
}

function handleDesktopToolAfter(input, context = {}, options = {}) {
  const event = toActionAfterEvent(input, context);
  return event ? handleControlEvent(event, controllerOptions(options)) : { kind: 'none' };
}

function handleDesktopSessionStart(context = {}, options = {}) {
  return handleControlEvent(toSessionEvent('session.start', context), controllerOptions(options));
}

function handleDesktopSessionEnd(context = {}, options = {}) {
  return handleControlEvent(toSessionEvent('session.end', context), controllerOptions(options));
}

function isDesktopControlPrompt(text, context = {}, options = {}) {
  const prompt = normalizeDesktopPrompt(text);
  if (/\$stop-that-shit\b/i.test(prompt)) return true;
  const state = readState(sessionIdOf(context), options.dataDir);
  const parsed = parseContractPrompt(prompt, state.contract);
  return parsed.changed || Boolean(parsed.correction);
}

module.exports = {
  handleDesktopPrompt,
  handleDesktopSessionEnd,
  handleDesktopSessionStart,
  handleDesktopTool,
  handleDesktopToolAfter,
  hostMetadata,
  isDesktopControlPrompt,
  isDesktopDoctorPrompt,
  normalizeDesktopPrompt,
  toActionAfterEvent,
  toActionEvent,
  toPromptEvent,
  toSessionEvent
};
