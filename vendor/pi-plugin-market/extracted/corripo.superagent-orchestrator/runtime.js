"use strict";

const PREFIX = "session/collaboration/";
// Reviewed desktop-control operations this plugin also needs. Both are `write`
// risk and neither requires `confirm: true`.
const SESSION_CREATE = "session/create";
const SESSION_OPEN = "session/open";
// The only interrupt entry the host exposes to a plugin: `agent/abort` is a
// reviewed `write` operation whose request names the session and, optionally,
// the turn. With a turn id the host refuses the call unless that turn is still
// the session's active turn, which is what makes "interrupt the old turn" safe.
const SESSION_ABORT = "agent/abort";
const READ_TIMEOUT_MS = 5_000;
const MAX_SELECTED_SESSIONS = 16;
const MAX_WAIT_TIMEOUT_MS = 45_000;
const WAIT_TIMEOUT_MS = 25_000;
const POLL_INTERVAL_MS = 1_000;
const MAX_PROJECT_PATH_CHARS = 4_096;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function taskError(code, message, details) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function text(value, field, limit = 256) {
  if (typeof value !== "string" || !value.trim()) {
    throw taskError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
  }
  if (value.trim().length > limit) {
    throw taskError("LIMIT_EXCEEDED", `${field} exceeds ${limit} characters`);
  }
  return value.trim();
}

function optionalText(value, field, limit = 256) {
  return value === undefined || value === null || value === ""
    ? undefined : text(value, field, limit);
}

/**
 * A project path is host input, not a plugin-invented one. Only the shape that
 * would make `session/create` fail confusingly is rejected here; whether the
 * directory exists and is a project stays the host's decision.
 */
function projectPath(value) {
  const path = text(value, "projectPath", MAX_PROJECT_PATH_CHARS);
  if (/[\u0000-\u001f]/.test(path)) {
    throw taskError("INVALID_ARGUMENT", "projectPath must not contain control characters");
  }
  return path;
}

/**
 * An absent or blank project path means "no explicit project". A non-string is
 * still an argument error, because silently spawning elsewhere is worse.
 */
function optionalProjectPath(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return text(value, "projectPath", MAX_PROJECT_PATH_CHARS);
  return value.trim() ? projectPath(value) : undefined;
}

function targetSessionId(args) {
  const id = optionalText(args?.sessionId, "sessionId");
  const legacy = optionalText(args?.workerId, "workerId");
  if (id && legacy && id !== legacy) {
    throw taskError("INVALID_ARGUMENT", "sessionId and workerId must identify the same session");
  }
  return id || legacy || text(undefined, "sessionId");
}

function selectedSessionIds(args, required = false) {
  function normalize(value) {
    if (!Array.isArray(value)) throw taskError("INVALID_ARGUMENT", "sessionIds must be an array");
    const ids = [...new Set(value.map((id) => text(id, "sessionId")))];
    if (ids.length > MAX_SELECTED_SESSIONS) {
      throw taskError("LIMIT_EXCEEDED", `Select at most ${MAX_SELECTED_SESSIONS} sessions`);
    }
    return ids;
  }
  const ids = args.sessionIds !== undefined ? normalize(args.sessionIds) : undefined;
  const legacy = args.workerIds !== undefined ? normalize(args.workerIds) : undefined;
  if (ids && legacy && JSON.stringify(ids) !== JSON.stringify(legacy)) {
    throw taskError("INVALID_ARGUMENT", "sessionIds and workerIds must identify the same sessions");
  }
  const selected = ids || legacy ||
    ((args.sessionId !== undefined || args.workerId !== undefined) ? [targetSessionId(args)] : undefined);
  if (required && !selected?.length) throw taskError("INVALID_ARGUMENT", "sessionIds must not be empty");
  return selected;
}

function contextSessionId(ctx) {
  return text(ctx?.sessionId, "active sessionId");
}

function deliveryOptions(args) {
  if (args.notifyOnCompletion !== undefined && typeof args.notifyOnCompletion !== "boolean") {
    throw taskError("INVALID_ARGUMENT", "notifyOnCompletion must be a boolean");
  }
  const idempotencyKey = optionalText(args.idempotencyKey, "idempotencyKey");
  return {
    ...(args.notifyOnCompletion !== undefined ? { notifyOnCompletion: args.notifyOnCompletion } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function waitTimeout(value) {
  if (value === undefined) return WAIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WAIT_TIMEOUT_MS) {
    throw taskError("INVALID_ARGUMENT", `timeoutMs must be between 1 and ${MAX_WAIT_TIMEOUT_MS}`);
  }
  return value;
}

/** One runtime owns its abort signal; an old invocation can never write into a reloaded runtime. */
function createRuntime(store, api = pi) {
  const lifecycle = new AbortController();
  let capabilities;

  function assertActive(signal) {
    if (lifecycle.signal.aborted || signal?.aborted) {
      throw taskError("ABORTED", "Session Orchestrator request was cancelled");
    }
  }

  function bounded(callback, { signal, deadline, timeoutMs = READ_TIMEOUT_MS } = {}) {
    assertActive(signal);
    const remaining = deadline === undefined ? timeoutMs : deadline - Date.now();
    const budget = Math.min(timeoutMs, remaining);
    const timeoutCode = deadline !== undefined && remaining <= timeoutMs ? "WAIT_TIMEOUT" : "TIMEOUT";
    if (budget <= 0) return Promise.reject(taskError(timeoutCode, "Session Orchestrator read timed out", { localTimeout: true }));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const signals = [...new Set([lifecycle.signal, signal].filter(Boolean))];
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const item of signals) item.removeEventListener("abort", abort);
        handler(value);
      };
      const abort = () => finish(reject, taskError("ABORTED", "Session Orchestrator request was cancelled"));
      for (const item of signals) item.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish(reject, taskError(timeoutCode, "Session Orchestrator read timed out", { localTimeout: true })), budget);
      Promise.resolve().then(() => {
        assertActive(signal);
        return callback();
      }).then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }

  async function ensureOperation(operation, options) {
    assertActive(options?.signal);
    if (!api.desktop?.invoke || !api.desktop?.listOperations) {
      throw taskError("UNSUPPORTED", "Update PI-Desktop to a build with Session Collaboration support");
    }
    if (!capabilities) {
      const operations = await bounded(() => api.desktop.listOperations(), options);
      capabilities = new Set((Array.isArray(operations) ? operations : []).map((entry) => entry.id));
    }
    if (!capabilities.has(operation)) {
      throw taskError("UNSUPPORTED", `Update PI-Desktop to a build with Session Collaboration support; missing ${operation}`);
    }
  }

  async function invoke(operation, input, options = {}) {
    await ensureOperation(operation, options);
    assertActive(options.signal);
    const request = () => api.desktop.invoke({ operation, args: [input] });
    // Writes retain the gateway's own deadline. A wait/read budget never cancels admitted work.
    const result = await bounded(request, { ...options, timeoutMs: options.read === false ? 110_000 : READ_TIMEOUT_MS });
    assertActive(options.signal);
    return result;
  }

  /**
   * A reviewed desktop-control operation whose arguments are positional and are
   * not a single object, e.g. `session/open` (one Session ID).
   */
  async function invokeOperation(operation, args, options = {}) {
    await ensureOperation(operation, options);
    assertActive(options.signal);
    const request = () => api.desktop.invoke({ operation, args });
    const result = await bounded(request, { ...options, timeoutMs: options.read === false ? 110_000 : READ_TIMEOUT_MS });
    assertActive(options.signal);
    return result;
  }

  /**
   * Resolve a host API method by dotted path. The permission gateway lives in
   * the host, so a missing method is the only thing checked here: an unpermitted
   * call must reach the host and come back as its own coded refusal.
   */
  function hostMethod(path) {
    const parts = String(path).split(".");
    let node = api;
    for (const key of parts.slice(0, -1)) {
      if (!node || typeof node !== "object") return undefined;
      node = node[key];
    }
    const name = parts[parts.length - 1];
    const fn = node ? node[name] : undefined;
    return typeof fn === "function" ? { fn, parent: node } : undefined;
  }

  function hasHost(path) {
    return Boolean(hostMethod(path));
  }

  async function callHost(path, args = [], options = {}) {
    const method = hostMethod(path);
    if (!method) throw taskError("UNSUPPORTED", `Update PI-Desktop to a build with ${path} support`);
    return bounded(() => method.fn.apply(method.parent, args), options);
  }

  async function remember(sessionId, owner, title, patch) {
    assertActive();
    try {
      await bounded(() => store.remember(sessionId, owner, title, patch));
      return undefined;
    } catch (error) {
      if (error.code === "ABORTED") throw error;
      // The host delivery already succeeded; preserve its receipt even when optional UI history fails.
      return `Session reference was not saved: ${String(error?.message || error).slice(0, 300)}`;
    }
  }

  return {
    store,
    assertActive,
    bounded,
    ensureOperation,
    invoke,
    invokeOperation,
    hasHost,
    callHost,
    call: (action, input, options) => invoke(PREFIX + action, input, options),
    models: (options) => bounded(() => api.models.list(), options),
    /**
     * The plugin's own settings object. A missing host API or a failing read is
     * not fatal: every caller has a documented default.
     */
    async settings(options) {
      if (!api.plugin?.getSettings) return {};
      try {
        const value = await bounded(() => api.plugin.getSettings(), options);
        return value && typeof value === "object" ? value : {};
      } catch (error) {
        if (error?.code === "ABORTED") throw error;
        return {};
      }
    },
    remember,
    async sleep(ms, options) {
      let timer;
      try {
        await bounded(() => new Promise((resolve) => { timer = setTimeout(resolve, ms); }), {
          ...options, timeoutMs: ms + READ_TIMEOUT_MS,
        });
      } finally {
        clearTimeout(timer);
      }
    },
    dispose: () => lifecycle.abort(),
  };
}

module.exports = {
  MAX_SELECTED_SESSIONS,
  MAX_WAIT_TIMEOUT_MS,
  MAX_PROJECT_PATH_CHARS,
  WAIT_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  PREFIX,
  SESSION_ABORT,
  SESSION_CREATE,
  SESSION_OPEN,
  TERMINAL_STATUSES,
  contextSessionId,
  createRuntime,
  deliveryOptions,
  optionalText,
  optionalProjectPath,
  projectPath,
  selectedSessionIds,
  targetSessionId,
  taskError,
  text,
  waitTimeout,
};
