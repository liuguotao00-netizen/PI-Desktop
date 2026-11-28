/**
 * Plugin host process (ADR 0008).
 *
 * One instance runs exactly one plugin's main module, outside the Electron main
 * process. It owns no host capability: every `pi.*` call is proxied back to the
 * broker in `plugin-runtime.ts`, where the permission gateway and the host API
 * allowlist live. Plain ESM JS (not TS) so the same file can be forked directly
 * by tests and bundled to `out/main/plugin-host-process.js` for the app.
 *
 * Wire protocol (both directions, one JSON message per frame):
 *   parent -> child  { t: "init", id, pluginId, pluginPath, main, manifest }
 *   parent -> child  { t: "call", id, method, payload, invocationId? } command.run | tool.execute |
 *                                                        service.start | service.stop |
 *                                                        lifecycle.unload
 *   child  -> parent { t: "call", id, api, args, invocationId? } host API request
 *   parent -> child  { t: "cancel", invocationId, reason } abort one tool invocation
 *   *      -> *      { t: "res", id, ok, value } | { t: "res", id, ok: false, error: { code, message } }
 *   parent -> child  { t: "event", event, ... }           push, no reply (bus.message, host events)
 *   child  -> parent { t: "log", level, message }         diagnostics, fire and forget
 *   child  -> parent { t: "ping", id } / parent -> child { t: "pong", id }
 *                                                    keepalive proving the parent is alive
 */
import { createRequire } from "node:module";

const NodeModule = createRequire(import.meta.url)("node:module");
import { pathToFileURL } from "node:url";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { pluginSandboxPolicy } from "./plugin-sandbox-policy.mjs";
import { createPluginApi } from "./plugin-host-api/api-surface.mjs";

const parentPort = process.parentPort;

// Once the parent channel is gone, diagnostics must never re-enter it: every
// further send attempt would only produce a new failure to report. One stderr
// note is the last thing a broken channel gets. The terminal path is
// idempotent: whichever failure surface gets here first (a synchronous throw
// in `send`, an async delivery error callback, or a process-level transport
// error) runs the single `process.exit` — later arrivals see the flag and stop.
let transportBroken = false;
let exitStarted = false;

function markBrokenAndExit(error) {
  if (transportBroken) return;
  transportBroken = true;
  const reason = error?.code || error?.message || String(error ?? "unknown");
  try {
    process.stderr.write(`plugin host: parent IPC channel is broken (${reason})\n`);
  } catch {
    // Even stderr can be gone (closed pipe); nothing left to report to.
  }
  if (exitStarted) return;
  exitStarted = true;
  // The channel to the owner is gone: nothing this process does is useful
  // anymore, and lingering here would leak the plugin host. A settled
  // process.exit cannot recurse through further diagnostics.
  process.exit(0);
}

// Async delivery failures on the node IPC channel do not throw inside `send`:
// with the parent connector gone, `process.send` fails asynchronously and the
// channel reports it as a process-level `error` event (typically EPIPE).
// Handling it here keeps it out of `uncaughtException`, where the diagnostics
// send would otherwise recurse forever. It is the same terminal break.
process.on("error", (error) => {
  markBrokenAndExit(error);
});
if (parentPort) {
  // Electron's pinned parent-port never surfaces `disconnect`: the gone
  // connector shows up as `close`, and undeliverable frames as `messageerror`.
  // Treat both as the same terminal break.
  parentPort.on("close", () => markBrokenAndExit(new Error("parent-port closed")));
  parentPort.on("messageerror", (error) => markBrokenAndExit(error));
}

/**
 * Send over the parent transport. On the node IPC channel delivery is
 * asynchronous: failures are reported through `onDeliveryError` (or the
 * process-level `error` handler above), never synchronously, so callers must
 * not assume `send` returning means the parent received the frame.
 */
function send(message, onDeliveryError) {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message, (error) => onDeliveryError?.(error));
}

/** Best-effort send. Never throws, so callers that report failures through
 * this channel cannot recurse into reporting the failure of the report. */
function trySend(message) {
  if (transportBroken) return false;
  try {
    send(message, (error) => {
      if (error) markBrokenAndExit(error);
    });
    return true;
  } catch (error) {
    markBrokenAndExit(error);
  }
  return false;
}

function log(level, message) {
  trySend({ t: "log", level, message: String(message) });
}

// Keepalive tunables. The parent answers every `ping` with a `pong`; missing
// that round-trip repeatedly means the parent (or its connector) is gone.
function positiveIntEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
const PING_INTERVAL_MS = positiveIntEnv("PI_PLUGIN_PING_INTERVAL_MS", 10_000);
const PING_MISSES = positiveIntEnv("PI_PLUGIN_PING_MISSES", 2);
let missedPings = 0;
let nextPingId = 1;

let pluginId = "";
let pluginPath = "";
let manifest = { id: "", name: "", version: "", main: "", schemaVersion: 1 };
let pluginModule = null;

const pending = new Map();
const invocations = new Map();
const invocationContext = new AsyncLocalStorage();
let nextCallId = 1;

/** Proxy a host API call to the broker and await its verdict. */
function call(api, args = []) {
  const invocation = invocationContext.getStore();
  if (invocation && (invocation.controller.signal.aborted || invocations.get(invocation.id) !== invocation)) {
    return Promise.reject(invocation.controller.signal.reason ?? toolAbortedError("Plugin tool invocation finished"));
  }
  const id = `c${nextCallId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, invocationId: invocation?.id });
    try {
      send(
        { t: "call", id, api, args, ...(invocation ? { invocationId: invocation.id } : {}) },
        // An async delivery failure means the channel to the broker is gone:
        // fail the pending call and take the same terminal break as every
        // other transport error. A null argument is a successful flush, not
        // a failure: the child channel reports delivery as callback(null).
        (error) => {
          if (!error) return;
          const entry = pending.get(id);
          if (entry) {
            pending.delete(id);
            entry.reject(error);
          }
          markBrokenAndExit(error);
        },
      );
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

function toolAbortedError(reason) {
  return Object.assign(new Error(reason), { code: "PLUGIN_TOOL_ABORTED" });
}

/**
 * The same refusal the broker returns for the audio surface, for the two
 * synchronous registration helpers that cannot reject.
 */
function audioUnavailable(api) {
  return Object.assign(new Error(`host api not available: ${api}`), {
    code: "UNSUPPORTED",
  });
}

function rejectInvocationCalls(invocationId, error) {
  for (const [id, entry] of pending) {
    if (entry.invocationId !== invocationId) continue;
    pending.delete(id);
    entry.reject(error);
  }
}

function cancelInvocation(invocationId, reason) {
  const invocation = invocations.get(invocationId);
  if (!invocation || invocation.controller.signal.aborted) return;
  const error = toolAbortedError(reason || "Plugin tool execution aborted");
  invocation.controller.abort(error);
  rejectInvocationCalls(invocationId, error);
}

function settle(message) {
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) {
    entry.resolve(message.value);
    return;
  }
  const error = new Error(message.error?.message || "plugin host call failed");
  error.code = message.error?.code || "UNKNOWN";
  entry.reject(error);
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (!value || typeof value !== "object") return new Uint8Array();
  const bytes = Object.entries(value)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, byte]) => Number(byte));
  return Uint8Array.from(bytes);
}

function normalizeClipboardHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    entry?.type === "image"
      ? { ...entry, data: asUint8Array(entry.data) }
      : entry,
  );
}

function normalizeBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (!value || typeof value !== "object") return new Uint8Array();
  if (value.type === "Buffer" && Array.isArray(value.data)) {
    return Uint8Array.from(value.data);
  }
  return Uint8Array.from(
    Object.entries(value)
      .filter(([key]) => /^\d+$/.test(key))
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, byte]) => Number(byte)),
  );
}

// Contribution points registered by this plugin. The callable half stays here;
// the broker only ever holds the descriptor plus a proxy back into this process.
const commands = new Map();
const tools = new Map();
const speechHandles = new Map();
// Parent initiated OAuth callbacks can outlive the UI prompt. Their own
// cancellation signal lets the plugin stop polling or clean up local state.
const parentCallControllers = new Map();
// Resident services declared in the manifest. The broker decides when they run;
// this map only holds the callables and whether they are currently up.
const services = new Map();
// Bus subscriptions keyed by the id the broker handed out, plus the `pi.events`
// listeners. Both are driven by the parent's push frames.
const busHandlers = new Map();
const eventListeners = new Map();

function buildApi() {
  return createPluginApi({
    call,
    commands,
    tools,
    speechHandles,
    services,
    busHandlers,
    eventListeners,
    pluginId,
    manifest,
    normalizeBytes,
    normalizeClipboardHistory,
    audioUnavailable,
  });
}

function handleHostEvent(message) {
  const event = String(message.event ?? "");
  if (event === "bus.message") {
    const handler = busHandlers.get(String(message.subscriptionId ?? ""));
    if (handler) {
      try {
        handler(message.message);
      } catch (error) {
        log("warn", `bus handler failed for ${message.message?.topic}: ${error?.message ?? error}`);
      }
    }
  }
  const args = message.args ?? [message.message];
  for (const listener of [...(eventListeners.get(event) ?? [])]) {
    try {
      listener(...args);
    } catch (error) {
      log("warn", `event handler failed for ${event}: ${error?.message ?? error}`);
    }
  }
}

async function loadPluginModule(entry) {
  const require = createRequire(import.meta.url);
  try {
    delete require.cache[require.resolve(entry)];
    return require(entry);
  } catch (error) {
    if (error?.code === "ERR_REQUIRE_ESM" || error?.code === "ERR_REQUIRE_ASYNC_MODULE") {
      const mod = await import(pathToFileURL(entry).href);
      return mod?.default && typeof mod.default === "object" ? mod.default : mod;
    }
    throw error;
  }
}

const PROCESS_PERMISSIONS = new Set(["system.process", "computer.control", "browser.launch"]);
let processAccess = false;
let computerControl = false;
let shellAccess = false;
let allowedProcesses = new Set();
let sandboxProcesses = false;
let processGuardInstalled = false;

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const DEFAULT_ALLOWED_PROCESSES = new Set(["git", "open", "xdg-open"]);
const DESKTOP_BINARIES = new Set([
  "cua-driver", "cua-driver.exe", "osascript", "cliclick", "xdotool", "ydotool", "wtype",
  "grim", "scrot", "import", "screencapture", "gnome-screenshot", "spectacle", "kdotool",
]);
const childProcessProxies = new WeakMap();

function commandName(value) {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const token = raw.trim().split(/\s+/)[0] ?? "";
  return token.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function shellChains(command) {
  let quote = null;
  let escaped = false;
  for (const char of String(command)) {
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === ";" || char === "&" || char === "|" || char === "`" || char === "\n" || char === "\r") return true;
    if (char === "$" && String(command).includes("$(")) return true;
  }
  return false;
}

function assertCommandAllowed(command, viaShell) {
  const name = commandName(command);
  if (viaShell && shellChains(command)) {
    const error = new Error("shell command chaining is refused");
    error.code = "PLUGIN_PERMISSION_DENIED";
    throw error;
  }
  if (DESKTOP_BINARIES.has(name)) {
    const error = new Error(
      `plugin process cannot launch desktop automation binary ${name}; use pi.cua instead`,
    );
    error.code = "PLUGIN_PERMISSION_DENIED";
    throw error;
  }
  if (processAccess && !allowedProcesses.has(name)) {
    const error = new Error(
      `plugin process ${name} is not in its processAllowlist`,
    );
    error.code = "PLUGIN_PERMISSION_DENIED";
    throw error;
  }
  if ((viaShell || SHELLS.has(name)) && !shellAccess) {
    const error = new Error("plugin requires the system.shell permission to use a shell");
    error.code = "PLUGIN_PERMISSION_DENIED";
    throw error;
  }
}

function resolveExecutable(file) {
  const raw = String(file ?? "");
  if (isAbsolute(raw) || raw.includes("/")) {
    const candidate = isAbsolute(raw) ? raw : resolve(raw);
    return existsSync(candidate) ? candidate : null;
  }
  for (const directory of String(process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, raw);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sandboxProfile(executable, viaShell) {
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny process-exec*)",
    `(allow process-exec (literal ${JSON.stringify(executable)}))`,
  ];
  if (viaShell) lines.push('(allow process-exec (literal "/bin/sh"))');
  const base = executable.split("/").pop() ?? "";
  if (base === "git") {
    lines.push('(allow process-exec (subpath "/usr/libexec/git-core"))');
    lines.push('(allow process-exec (subpath "/Library/Developer/CommandLineTools/usr/libexec/git-core"))');
    lines.push('(allow process-exec (literal "/usr/bin/ssh"))');
  }
  return lines.join("\n");
}

function sandboxArgs(executable, args, viaShell) {
  return [
    "/usr/bin/sandbox-exec",
    ["-p", sandboxProfile(executable, viaShell), executable, ...args],
  ];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function guardedChildProcess(real) {
  if (childProcessProxies.has(real)) return childProcessProxies.get(real);
  const proxy = { ...real };
  const wrapFile = (fn) => function guardedFile(file, ...args) {
    const options = args.find((value) => value && typeof value === "object" && !Array.isArray(value));
    const viaShell = options?.shell === true;
    assertCommandAllowed(file, viaShell);
    if (sandboxProcesses) {
      const executable = resolveExecutable(file);
      if (!executable) {
        const error = new Error(`plugin process could not resolve ${String(file)}`);
        error.code = "PLUGIN_PERMISSION_DENIED";
        throw error;
      }
      const argv = args.find((value) => Array.isArray(value)) ?? [];
      const launch = sandboxArgs(executable, argv.map(String), viaShell);
      return real[fn](launch[0], launch[1], ...args.filter((value) => !Array.isArray(value)));
    }
    return real[fn](file, ...args);
  };
  const wrapShell = (fn) => function guardedShell(command, ...args) {
    assertCommandAllowed(command, true);
    if (sandboxProcesses) {
      const executable = resolveExecutable(commandName(command));
      if (!executable) {
        const error = new Error(`plugin process could not resolve ${commandName(command)}`);
        error.code = "PLUGIN_PERMISSION_DENIED";
        throw error;
      }
      const profile = sandboxProfile(executable, true);
      const shellCommand = [
        shellQuote("/usr/bin/sandbox-exec"),
        "-p",
        shellQuote(profile),
        "/bin/sh",
        "-c",
        shellQuote(command),
      ].join(" ");
      return real[fn](shellCommand, ...args);
    }
    return real[fn](command, ...args);
  };
  proxy.spawn = wrapFile("spawn");
  proxy.spawnSync = wrapFile("spawnSync");
  proxy.execFile = wrapFile("execFile");
  proxy.execFileSync = wrapFile("execFileSync");
  proxy.exec = wrapShell("exec");
  proxy.execSync = wrapShell("execSync");
  childProcessProxies.set(real, proxy);
  return proxy;
}

function installProcessGuard() {
  if (processGuardInstalled) return;
  processGuardInstalled = true;
  const originalLoad = NodeModule._load;
  NodeModule._load = function loadWithProcessGuard(request, parent, isMain) {
    if (request === "child_process" || request === "node:child_process") {
      if (!processAccess) {
        const error = new Error(
          "plugin requires the system.process, computer.control or browser.launch permission to spawn processes",
        );
        error.code = "PLUGIN_PERMISSION_DENIED";
        throw error;
      }
      if (computerControl) {
        const error = new Error(
          "plugins with computer.control must drive the desktop through pi.cua; direct process spawning is refused",
        );
        error.code = "PLUGIN_PERMISSION_DENIED";
        throw error;
      }
      return guardedChildProcess(originalLoad.call(this, request, parent, isMain));
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

async function handleInit(message) {
  pluginId = String(message.pluginId ?? "");
  pluginPath = String(message.pluginPath ?? "");
  manifest = message.manifest ?? manifest;
  const permissions = manifest.permissions ?? [];
  processAccess = permissions.some((permission) => PROCESS_PERMISSIONS.has(permission));
  computerControl = permissions.includes("computer.control");
  const policy = pluginSandboxPolicy(permissions);
  shellAccess = policy.shellAccess;
  sandboxProcesses = policy.sandboxChildProcesses;
  const declaredProcesses = Array.isArray(manifest.processAllowlist) ? manifest.processAllowlist : [];
  const implicitProcesses = policy.allowImplicitProcesses ? [...DEFAULT_ALLOWED_PROCESSES] : [];
  allowedProcesses = new Set(
    (declaredProcesses.length ? declaredProcesses : implicitProcesses)
      .map((value) => String(value).toLowerCase()),
  );
  installProcessGuard();
  const entry = join(pluginPath, String(message.main ?? manifest.main ?? ""));

  globalThis.pi = buildApi();
  pluginModule = await loadPluginModule(entry);
  const oauthProviders = Array.isArray(manifest?.contributes?.providers)
    ? manifest.contributes.providers.filter((provider) => provider?.authKind === "oauth")
    : [];
  if (oauthProviders.length > 0 && typeof pluginModule?.onProviderOAuth !== "function") {
    const error = new Error("OAuth providers require an onProviderOAuth hook");
    error.code = "PLUGIN_INVALID";
    throw error;
  }
  if (pluginModule?.onLoad) await pluginModule.onLoad();
  return { pluginId };
}

async function handleParentCall(method, payload, invocationId, callId) {
  switch (method) {
    case "panel.invoke": {
      const invoke = pluginModule?.onPanelInvoke;
      if (typeof invoke !== "function") {
        const error = new Error("plugin does not expose panel operations");
        error.code = "UNSUPPORTED";
        throw error;
      }
      return invoke(String(payload?.channel ?? ""), payload?.payload ?? {});
    }
    case "provider.oauth": {
      const handle = pluginModule?.onProviderOAuth;
      if (typeof handle !== "function") {
        const error = new Error("plugin does not expose provider OAuth operations");
        error.code = "UNSUPPORTED";
        throw error;
      }
      if (typeof callId !== "string" || !callId || parentCallControllers.has(callId)) {
        const error = new Error("provider OAuth requires a unique parent call ID");
        error.code = "INVALID_ARGUMENT";
        throw error;
      }
      const controller = new AbortController();
      parentCallControllers.set(callId, controller);
      try {
        return await handle(payload ?? {}, { signal: controller.signal });
      } finally {
        parentCallControllers.delete(callId);
      }
    }
    case "command.run": {
      const run = commands.get(String(payload?.id ?? ""));
      if (!run) {
        const error = new Error(`command not registered: ${payload?.id}`);
        error.code = "NOT_FOUND";
        throw error;
      }
      await run();
      return { ok: true };
    }
    case "speech.handle": {
      const handle = speechHandles.get(String(payload?.protocol ?? ""));
      if (!handle) {
        const error = new Error(`speech adapter not registered: ${payload?.protocol}`);
        error.code = "NOT_FOUND";
        throw error;
      }
      return handle(payload ?? {});
    }
    case "tool.execute": {
      if (typeof invocationId !== "string" || !invocationId || invocations.has(invocationId)) {
        throw toolAbortedError("A unique host tool invocation ID is required");
      }
      const execute = tools.get(String(payload?.name ?? ""));
      if (!execute) {
        const error = new Error(`tool not registered: ${payload?.name}`);
        error.code = "TOOL_NOT_FOUND";
        throw error;
      }
      const invocation = { id: invocationId, controller: new AbortController() };
      invocations.set(invocationId, invocation);
      try {
        const result = await invocationContext.run(invocation, () => execute(payload?.args, {
          sessionId: payload?.sessionId,
          turnId: payload?.turnId,
          mode: payload?.mode,
          modelKey: payload?.modelKey,
          thinkingLevel: payload?.thinkingLevel,
          signal: invocation.controller.signal,
          log: (msg) => log("info", msg),
        }));
        return result ?? null;
      } finally {
        invocations.delete(invocationId);
        rejectInvocationCalls(invocationId, toolAbortedError("Plugin tool invocation finished"));
      }
    }
    case "service.start": {
      const id = String(payload?.id ?? "");
      const entry = services.get(id);
      if (!entry) {
        const error = new Error(`service not registered: ${id}`);
        error.code = "NOT_FOUND";
        throw error;
      }
      // Idempotent: a restart of the host process re-runs start, but a second
      // start inside one process must not spawn a duplicate worker.
      if (entry.running) return { ok: true, alreadyRunning: true };
      await entry.start({ log: (msg) => log("info", msg) });
      entry.running = true;
      return { ok: true };
    }
    case "service.stop": {
      const entry = services.get(String(payload?.id ?? ""));
      if (!entry?.running) return { ok: true };
      entry.running = false;
      if (entry.stop) await entry.stop();
      return { ok: true };
    }
    case "renderer.call": {
      const handler = pluginModule?.onRendererCall;
      if (typeof handler !== "function") {
        const error = new Error("plugin does not implement onRendererCall");
        error.code = "PLUGIN_CALL_NO_HANDLER";
        throw error;
      }
      const answer = await handler(String(payload?.method ?? ""), payload?.args ?? {});
      // The relay answers JSON only. A cycle, a BigInt or a bare function is
      // the plugin's bug and is reported as one, instead of surfacing as a
      // structured-clone failure without a code.
      let text;
      try {
        text = JSON.stringify(answer ?? null);
      } catch {
        text = undefined;
      }
      if (text === undefined) {
        const error = new Error("onRendererCall answer is not JSON");
        error.code = "PLUGIN_CALL_UNSERIALIZABLE";
        throw error;
      }
      return JSON.parse(text);
    }
    case "composer.transform": {
      const handler = pluginModule?.onComposerTransform;
      if (typeof handler !== "function") {
        const error = new Error("plugin does not implement onComposerTransform");
        error.code = "PLUGIN_TRANSFORM_NO_HANDLER";
        throw error;
      }
      const answer = await handler({
        id: String(payload?.id ?? ""),
        text: String(payload?.text ?? ""),
        ...(typeof payload?.modelKey === "string" ? { modelKey: payload.modelKey } : {}),
      });
      if (typeof answer !== "string") {
        const error = new Error("onComposerTransform must return a text string");
        error.code = "PLUGIN_INVALID_RESULT";
        throw error;
      }
      return answer;
    }
    case "agent.modelContext": {
      const handler = pluginModule?.onModelContext;
      if (typeof handler !== "function") return null;
      const controller = new AbortController();
      parentCallControllers.set(callId, controller);
      // Release the controller even if the plugin never settles its promise.
      const release = () => parentCallControllers.delete(callId);
      controller.signal.addEventListener("abort", release, { once: true });
      try {
        const answer = await handler(payload, { signal: controller.signal });
        if (controller.signal.aborted || answer === undefined || answer === null) return null;
        // Reject before crossing IPC; don't copy arbitrary plugin objects.
        const text = answer.text;
        if (typeof text !== "string" || text.length > 4096 || Buffer.byteLength(text, "utf8") > 4096) {
          throw Object.assign(new Error("onModelContext requires text of at most 4096 UTF-8 bytes"), {
            code: "PLUGIN_INVALID_RESULT",
          });
        }
        return { text };
      } finally {
        release();
      }
    }
    case "lifecycle.unload": {
      for (const id of invocations.keys()) cancelInvocation(id, "Plugin unloaded");
      for (const [id, controller] of parentCallControllers) {
        controller.abort(toolAbortedError("Plugin unloaded"));
        parentCallControllers.delete(id);
      }
      // Best effort: a throwing onUnload must not block teardown.
      try {
        if (pluginModule?.onUnload) await pluginModule.onUnload();
      } catch (error) {
        log("warn", `onUnload failed: ${error?.message ?? error}`);
      }
      commands.clear();
      tools.clear();
      speechHandles.clear();
      services.clear();
      busHandlers.clear();
      eventListeners.clear();
      return { ok: true };
    }
    default: {
      const error = new Error(`unknown method: ${method}`);
      error.code = "UNSUPPORTED";
      throw error;
    }
  }
}

function onHostMessage(handler) {
  if (parentPort) parentPort.on("message", (event) => handler(event.data));
  else process.on("message", handler);
}

// Parent liveness. node:child_process emits `disconnect` when the parent side
// goes away, but Electron's pinned parent-port (utilityProcess) only closes its
// connector without any JavaScript-visible event: there we keep a ping/pong
// round-trip going and exit when the parent stops answering. Either way the
// host must not outlive the parent that owns it.
if (parentPort) {
  const heartbeat = setInterval(() => {
    missedPings += 1;
    if (missedPings > PING_MISSES || !trySend({ t: "ping", id: nextPingId++ })) {
      clearInterval(heartbeat);
      process.exit(0);
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref?.();
} else {
  process.on("disconnect", () => {
    process.exit(0);
  });
}

onHostMessage((message) => {
  if (!message || typeof message !== "object") return;
  if (message.t === "pong") {
    missedPings = 0;
    return;
  }
  if (message.t === "res") {
    settle(message);
    return;
  }
  if (message.t === "event") {
    handleHostEvent(message);
    return;
  }
  if (message.t === "cancel") {
    if (typeof message.callId === "string") {
      const controller = parentCallControllers.get(message.callId);
      if (controller && !controller.signal.aborted) {
        controller.abort(toolAbortedError(String(message.reason ?? "Plugin call cancelled")));
      }
    }
    cancelInvocation(message.invocationId, String(message.reason ?? ""));
    return;
  }
  if (message.t === "init") {
    void handleInit(message)
      .then((value) => {
        trySend({ t: "res", id: message.id, ok: true, value });
      })
      .catch((error) => {
        trySend({
          t: "res",
          id: message.id,
          ok: false,
          error: {
            code: error?.code || "PLUGIN_LOAD_FAILED",
            message: error?.message ? String(error.message) : String(error),
          },
        });
      });
    return;
  }
  if (message.t === "call") {
    void invocationContext.run(undefined, () => handleParentCall(message.method, message.payload, message.invocationId, message.id))
      .then((value) => {
        trySend({ t: "res", id: message.id, ok: true, value: value ?? null });
      })
      .catch((error) => {
        trySend({
          t: "res",
          id: message.id,
          ok: false,
          error: {
            code: error?.code || "PLUGIN_CALL_FAILED",
            message: error?.message ? String(error.message) : String(error),
          },
        });
      });
  }
});

// A misbehaving plugin must not take down its own host process silently, and it
// can never take down the app: the broker owns teardown decisions. Diagnostics
// go through the guarded channel, so a broken transport can never re-enter
// these handlers recursively.
process.on("uncaughtException", (error) => {
  try {
    log("error", `uncaught exception: ${error?.stack || error}`);
  } catch {
    // Reporting failed; survive to keep the transport diagnostics bounded.
  }
});
process.on("unhandledRejection", (reason) => {
  try {
    log("error", `unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  } catch {
    // Reporting failed; survive to keep the transport diagnostics bounded.
  }
});
