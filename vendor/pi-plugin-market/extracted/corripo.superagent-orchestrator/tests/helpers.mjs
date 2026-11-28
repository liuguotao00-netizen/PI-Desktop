import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const cards = require("../cards.js");
export const runtimeModule = require("../runtime.js");
export const { createActions } = require("../actions.js");
export const { createWorkerStore } = require("../state.js");
export const { createWatcher, TURN_ENDED } = require("../watcher.js");
export const { createDeliverer } = require("../deliver.js");

/** In-memory stand-in for `pi.plugin` (getSettings / setSettings). */
export function memoryPlugin(initial = {}) {
  let value = { ...initial };
  return {
    async getSettings() {
      return { ...value };
    },
    async setSettings(next) {
      value = { ...value, ...next };
    },
    snapshot() {
      return { ...value };
    },
  };
}

export async function makeStore(initial = {}) {
  const plugin = memoryPlugin(initial);
  const store = await createWorkerStore(plugin);
  return { store, plugin };
}

export const MODELS = [
  {
    key: "prov/m1",
    providerId: "prov",
    modelId: "m1",
    providerName: "Prov",
    label: "M1",
    availableForSubagents: true,
    isDefault: true,
  },
];

/**
 * A runtime double. `calls` records everything so a test can assert that a
 * failed step never silently fell through to another path.
 */
export function fakeRuntime({ store, call = {}, invokeOperation = {}, callHost = {}, models = MODELS } = {}) {
  const calls = [];
  const hostCalls = [];
  const runtime = {
    store,
    calls,
    hostCalls,
    async call(action, input, options) {
      calls.push({ kind: "call", action, input, options });
      const handler = call[action];
      if (!handler) throw Object.assign(new Error(`unexpected collaboration action: ${action}`), { code: "TEST_UNEXPECTED" });
      return handler(input, options);
    },
    async invokeOperation(operation, args, options) {
      calls.push({ kind: "operation", operation, args, options });
      const handler = invokeOperation[operation];
      if (!handler) throw Object.assign(new Error(`unexpected operation: ${operation}`), { code: "TEST_UNEXPECTED" });
      return handler(args, options);
    },
    async callHost(path, args, options) {
      hostCalls.push({ path, args, options });
      const handler = callHost[path];
      if (!handler) throw Object.assign(new Error(`host api unavailable: ${path}`), { code: "UNSUPPORTED" });
      return handler(args, options);
    },
    async ensureOperation() {},
    async models() {
      return models;
    },
    async remember(sessionId, owner, title, patch) {
      calls.push({ kind: "remember", sessionId, owner, title, patch });
      await store.remember(sessionId, owner, title, patch);
      return undefined;
    },
    assertActive() {},
    async sleep() {},
    bounded: (fn) => fn(),
    dispose() {},
  };
  return runtime;
}

export const CTX = { sessionId: "main-session", turnId: "main-turn" };

export function receipt(sessionId = "worker-1") {
  return { sessionId, messageId: `${sessionId}-msg-1`, status: "queued" };
}

export function hostError(code, message = code) {
  return Object.assign(new Error(message), { code });
}
