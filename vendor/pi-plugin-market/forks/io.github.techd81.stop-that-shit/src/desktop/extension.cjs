'use strict';

// PI-Desktop agent extension.
//
// Thin host shell: it maps the host's lifecycle onto the shared Desktop
// adapter and never invents policy. Every handler fails open: a guard that
// cannot answer must not break the user's turn.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  handleDesktopPrompt,
  handleDesktopSessionEnd,
  handleDesktopSessionStart,
  handleDesktopTool,
  handleDesktopToolAfter,
  isDesktopDoctorPrompt,
  toPromptEvent
} = require('./hooks.cjs');
const { buildDoctorReport, formatDoctorReport } = require('./doctor.cjs');
const { handleControlEvent } = require('../controller.cjs');

const PLUGIN_ID = 'io.github.techd81.stop-that-shit';
const MAX_PENDING_CONTEXTS = 512;

function defaultDataDir() {
  return process.env.STS_DESKTOP_DATA
    || path.join(os.homedir(), '.pi-desktop', 'plugins', 'data', PLUGIN_ID);
}

function messageOf(error) {
  return error && error.message ? error.message : String(error || 'unknown error');
}

function firstLine(text) {
  return String(text || '').split('\n').find((line) => line.trim()) || 'Stop That Shit declined the action.';
}

function modelLabel(model) {
  if (!model) return null;
  if (typeof model === 'string') return model;
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  return model.id || null;
}

function sessionContext(ctx) {
  let sessionId = '';
  try {
    const manager = ctx && ctx.sessionManager;
    if (manager && typeof manager.getSessionId === 'function') sessionId = String(manager.getSessionId() || '');
  } catch {
    sessionId = '';
  }
  const cwd = ctx && typeof ctx.cwd === 'string' ? ctx.cwd : '';
  return {
    // The host shim exposes getSessionId(); the fallback keeps state per
    // project instead of merging unrelated sessions when it does not.
    sessionId: sessionId || `desktop-cwd:${cwd || 'unknown'}`,
    cwd,
    mode: ctx && ctx.mode,
    hasUI: Boolean(ctx && ctx.hasUI),
    model: modelLabel(ctx && ctx.model)
  };
}

function notify(ctx, message, level = 'warning') {
  try {
    if (ctx && ctx.hasUI && ctx.ui && typeof ctx.ui.notify === 'function') ctx.ui.notify(message, level);
  } catch {
    // A failed toast must not change a control decision.
  }
}

const INTERESTING_MEMBERS = ['on', 'registerCommand', 'registerTool', 'registerAgent', 'publishCommands', 'getActiveTools', 'sendUserMessage'];

// The host surface differs between PI-Desktop builds. Recording what the
// sidecar actually hands over turns "the command is missing" into a fact the
// panel can show instead of a guess.
function describeHostApi(pi) {
  const seen = new Set();
  const members = [];
  let current = pi;
  for (let depth = 0; current && depth < 4; depth += 1) {
    let keys = [];
    try {
      keys = Object.getOwnPropertyNames(current);
    } catch {
      // A bridge object that refuses introspection is reported as unknown.
      break;
    }
    for (const key of keys) {
      if (seen.has(key) || key === 'constructor') continue;
      seen.add(key);
      let type = 'unknown';
      try {
        type = typeof pi[key];
      } catch {
        type = 'threw';
      }
      members.push(`${key}:${type}`);
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      current = null;
    }
  }
  const has = (name) => {
    try {
      return typeof pi?.[name] === 'function';
    } catch {
      return false;
    }
  };
  return {
    members: members.sort().slice(0, 120),
    commandApi: has('registerCommand') ? 'registerCommand' : has('publishCommands') ? 'publishCommands' : 'none',
    ...Object.fromEntries(INTERESTING_MEMBERS.map((name) => [name, has(name)]))
  };
}

function recordExtensionProbe(dataDir, api) {
  try {
    const dir = path.join(dataDir, 'runtime');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'extension.json');
    const record = {
      schemaVersion: 1,
      registeredAt: new Date().toISOString(),
      pluginVersion: require('../../package.json').version,
      // The directory this process actually guards: the panel reports a
      // mismatch instead of silently showing an empty audit trail.
      dataDir,
      host: api
    };
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } catch {
    // A diagnostic that cannot be written must not block registration.
  }
}

// Registration touches a host object we do not own, so a throw here would cost
// the whole extension. Catch it once, leave a trace, and report the failure
// instead of failing the host's extension load.
function registerDesktopExtension(pi, options = {}) {
  const dataDir = options.dataDir || defaultDataDir();
  try {
    return registerExtension(pi, options, dataDir);
  } catch (error) {
    const message = messageOf(error);
    console.error(`[stop-that-shit] extension registration failed: ${message}`);
    notify(null, `Stop That Shit did not register in this host: ${message}`, 'warning');
    return { dataDir, registered: false, error: message };
  }
}

function registerExtension(pi, options, dataDir) {
  const controllerOptions = { ...options, dataDir };
  const pendingToolContext = new Map();
  const hostApi = describeHostApi(pi);
  recordExtensionProbe(dataDir, hostApi);
  console.error(`[stop-that-shit] extension registered (commandApi=${hostApi.commandApi}, plugin=${PLUGIN_ID})`);

  function guard(ctx, label, run, fallback) {
    try {
      return run();
    } catch (error) {
      notify(ctx, `Stop That Shit failed open while ${label}: ${messageOf(error)}`, 'warning');
      return fallback;
    }
  }

  function rememberToolContext(key, text) {
    if (!key) return;
    if (pendingToolContext.size >= MAX_PENDING_CONTEXTS) {
      pendingToolContext.delete(pendingToolContext.keys().next().value);
    }
    pendingToolContext.set(key, text);
  }

  const canSubscribe = (() => {
    try {
      return typeof pi?.on === 'function';
    } catch {
      return false;
    }
  })();
  if (!canSubscribe) {
    notify(null, 'Stop That Shit: this host exposes no agent extension events.', 'warning');
    return { dataDir, registered: false, error: 'NO_EXTENSION_API' };
  }

  // One unsubscribable event must not cost the others.
  const on = (name, handler) => {
    try {
      pi.on(name, handler);
      return true;
    } catch (error) {
      notify(null, `Stop That Shit: could not subscribe to ${name}: ${messageOf(error)}`, 'warning');
      return false;
    }
  };

  on('session_start', (_event, ctx) => guard(ctx, 'opening the session',
    () => handleDesktopSessionStart(sessionContext(ctx), controllerOptions)));

  // The host does not emit `input`; the turn's prompt arrives here instead.
  on('before_agent_start', (event, ctx) => guard(ctx, 'preparing the turn', () => {
    const prompt = typeof event?.prompt === 'string' ? event.prompt : '';
    if (!prompt) return undefined;
    const base = typeof event?.systemPrompt === 'string' ? event.systemPrompt : '';
    if (isDesktopDoctorPrompt(prompt)) {
      // `doctor` is a self check, not a contract change: answer it in place so
      // `/sts doctor` works without the host's extension command surface.
      const report = buildDoctorReport({ dataDir });
      const text = formatDoctorReport(report);
      notify(ctx, report.ok ? 'Stop That Shit doctor: all checks passed.' : firstLine(text), report.ok ? 'info' : 'warning');
      return { systemPrompt: base ? `${base}\n\n${text}` : text };
    }
    const result = handleDesktopPrompt({ text: prompt }, sessionContext(ctx), controllerOptions);
    if (!result || result.kind === 'none') return undefined;
    let text = '';
    if (result.kind === 'context') text = result.text;
    else if (result.kind === 'prompt-error') {
      text = `Stop That Shit directive rejected (${result.error?.code || 'INVALID_DIRECTIVE'}): ${result.message}\n`
        + 'The previous contract is unchanged. Submit a corrected instruction.';
      notify(ctx, firstLine(text), 'error');
    }
    if (result.warning) notify(ctx, result.warning.message || String(result.warning), 'info');
    if (!text) return undefined;
    // Preserve earlier handlers' additions: only append.
    return { systemPrompt: base ? `${base}\n\n${text}` : text };
  }));

  on('tool_call', (event, ctx) => guard(ctx, 'checking a tool call', () => {
    const call = {
      toolName: event?.toolName,
      toolCallId: event?.toolCallId,
      input: event?.input
    };
    const result = handleDesktopTool(call, sessionContext(ctx), controllerOptions);
    if (!result || result.kind === 'none') return undefined;
    if (result.kind === 'deny') {
      notify(ctx, `Stop That Shit blocked ${call.toolName}: ${firstLine(result.message)}`);
      return { block: true, reason: result.message };
    }
    if (result.kind === 'context') {
      rememberToolContext(call.toolCallId ? String(call.toolCallId) : null, result.text);
      return undefined;
    }
    return undefined;
  }));

  on('tool_result', (event, ctx) => guard(ctx, 'settling a tool call', () => {
    const call = {
      toolName: event?.toolName,
      toolCallId: event?.toolCallId,
      input: event?.input,
      details: event?.details,
      isError: event?.isError
    };
    handleDesktopToolAfter(call, sessionContext(ctx), controllerOptions);
    const key = call.toolCallId ? String(call.toolCallId) : null;
    const text = key ? pendingToolContext.get(key) : null;
    if (!text) return undefined;
    // Decide delivery before dropping the note: the host's result shape varies,
    // and a shape we do not recognise keeps the note instead of swallowing it.
    const note = `<stop_that_shit_context>\n${text}\n</stop_that_shit_context>`;
    if (Array.isArray(event?.content)) {
      if (key) pendingToolContext.delete(key);
      return { content: [...event.content, { type: 'text', text: note }] };
    }
    if (typeof event?.content === 'string') {
      if (key) pendingToolContext.delete(key);
      return { content: `${event.content}\n\n${note}` };
    }
    return undefined;
  }));

  on('session_shutdown', (_event, ctx) => {
    pendingToolContext.clear();
    return guard(ctx, 'closing the session',
      () => handleDesktopSessionEnd(sessionContext(ctx), controllerOptions));
  });

  // `/sts status|runtime|explain|label|doctor` reuses the shared query path, so
  // command output stays byte-identical to the directive output.
  const commandOptions = {
    description: 'Stop That Shit: status | runtime [all] | explain <evt_id> | label <evt_id> correct|incorrect|inconclusive | doctor',
    handler: async (args, ctx) => {
      // The host turns a rejected command promise into a failed command, so the
      // handler answers with text even when the shared controller throws.
      try {
        const text = String(typeof args === 'string' ? args : '').trim() || 'status';
        if (text === 'doctor') {
          const report = buildDoctorReport({ dataDir });
          const message = formatDoctorReport(report);
          notify(ctx, report.ok ? 'Stop That Shit doctor: all checks passed.' : firstLine(message), report.ok ? 'info' : 'warning');
          return message;
        }
        const context = sessionContext(ctx);
        const result = handleControlEvent(
          toPromptEvent({ text: `$stop-that-shit ${text}` }, context),
          { ...controllerOptions, denialResponseOutcome: 'execution_denial_returned' }
        );
        const message = result && result.kind === 'context' ? result.text : 'Stop That Shit could not answer that command.';
        notify(ctx, firstLine(message), 'info');
        return message;
      } catch (error) {
        const message = `Stop That Shit could not answer that command: ${messageOf(error)}`;
        notify(ctx, firstLine(message), 'warning');
        return message;
      }
    }
  };

  // PI-Desktop builds differ: 0.22.0 hands over a bridge whose members are
  // listed in the probe file, while the documented ExtensionAPI takes a name
  // plus options. Try the documented shape, then the single-object shape, and
  // leave a trace instead of failing silently.
  const commandPayload = { ...commandOptions, run: commandOptions.handler };
  if (hostApi.registerCommand) {
    const failed = (error) => {
      console.error(`[stop-that-shit] /sts command rejected: ${messageOf(error)}`);
      notify(null, `Stop That Shit: /sts command rejected: ${messageOf(error)}`, 'warning');
    };
    // A host may answer with a promise; a rejection is a failure to report, not
    // an unhandled one.
    const settle = (pending) => {
      if (pending && typeof pending.then === 'function') pending.then(undefined, failed);
    };
    try {
      settle(pi.registerCommand('sts', commandPayload));
    } catch (error) {
      try {
        settle(pi.registerCommand({ name: 'sts', ...commandPayload }));
      } catch {
        failed(error);
      }
    }
  }

  return { dataDir, registered: true };
}

module.exports = { PLUGIN_ID, defaultDataDir, registerDesktopExtension, sessionContext };
