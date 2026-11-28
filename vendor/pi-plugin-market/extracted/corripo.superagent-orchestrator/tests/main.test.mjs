import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * `main.js` talks to the injected `pi` global, so this file drives the real
 * module against a fake host. It covers the one path unit tests cannot: what
 * happens when the plugin's own history write fails while unloading.
 */
function fakeHost({ setSettings } = {}) {
  const registered = new Map();
  const listeners = new Map();
  const unregistered = [];
  let settings = { version: 4, sessions: [], acceptances: [], workers: [] };
  const host = {
    plugin: {
      async getSettings() {
        return { ...settings };
      },
      async setSettings(next) {
        if (setSettings) return setSettings(next, () => {
          settings = { ...settings, ...next };
        });
        settings = { ...settings, ...next };
      },
    },
    desktop: {
      async listOperations() {
        return [
          { id: "session/collaboration/spawn", risk: "write" },
          { id: "session/collaboration/status", risk: "read" },
        ];
      },
      async invoke({ operation }) {
        if (operation === "session/collaboration/spawn") {
          return { sessionId: "worker-1", messageId: "msg-1", status: "queued" };
        }
        throw Object.assign(new Error(`unexpected ${operation}`), { code: "TEST" });
      },
    },
    models: {
      async list() {
        return [{ key: "prov/m1", providerId: "prov", modelId: "m1", providerName: "Prov", label: "M1", isDefault: true }];
      },
    },
    agent: {
      async registerTool(tool) {
        registered.set(tool.name, tool);
      },
      async unregisterTool(name) {
        unregistered.push(name);
        registered.delete(name);
      },
    },
    events: {
      on(event, handler) {
        listeners.set(event, handler);
      },
      off(event) {
        listeners.delete(event);
      },
    },
  };
  return { host, registered, listeners, unregistered };
}

test("onLoad registers the tool, onUnload survives a failing history write", async () => {
  const { host, registered, listeners, unregistered } = fakeHost({
    setSettings: () => Promise.reject(new Error("disk full")),
  });
  globalThis.pi = host;
  const plugin = require("../main.js");

  await plugin.onLoad();
  const tool = registered.get("SessionTask");
  assert.ok(tool, "SessionTask must be registered");
  assert.equal(tool.risk, "high");
  assert.equal(typeof listeners.get("session:turnEnded"), "function", "the result-card watcher must start");

  // The spawn itself succeeds; only the optional history write fails, which is
  // reported as a warning instead of failing the delivery.
  const receipt = await tool.execute({ action: "spawn", task: "do the thing" }, { sessionId: "main-1" });
  assert.equal(receipt.sessionId, "worker-1");
  assert.match(receipt.warning, /was not saved/);

  // The pending write is now rejected: unloading must still resolve.
  await assert.doesNotReject(() => plugin.onUnload());
  assert.deepEqual(unregistered, ["SessionTask"]);
  assert.equal(listeners.size, 0, "the event listener must be released");
});

test("onUnload is a no-op when the plugin never loaded", async () => {
  globalThis.pi = fakeHost().host;
  const plugin = require("../main.js");
  await assert.doesNotReject(() => plugin.onUnload());
});

test("a view call before load is refused instead of throwing a TypeError", async () => {
  globalThis.pi = fakeHost().host;
  const plugin = require("../main.js");
  await assert.rejects(
    () => plugin.onPanelInvoke("workers.list", {}),
    (error) => error.code === "UNAVAILABLE",
  );
});
