import assert from "node:assert/strict";
import test from "node:test";
import { createCuaHostApi } from "../electron/main/plugin-host-api/cua.ts";

function api(session) {
  const host = createCuaHostApi({
    cua: undefined,
    sessions: { get: () => session },
    assertPermission: () => {},
    requireSession: () => "s1",
  });
  return host;
}

test("cua session resolves browser methods through the generic path", async () => {
  const tab = {
    id: "t1",
    async snapshot() { return { url: "https://example.test", title: "Example" }; },
    async title() { return "Example"; },
  };
  const session = {
    name: "demo",
    capabilities: { list: () => ["tabs", "playwright"] },
    tabs: { list: async () => [{ id: "t1", title: "Example", url: "https://example.test", active: true }], get: async (id) => { assert.equal(id, "t1"); return tab; } },
    async history() { return []; },
  };
  const host = api(session);

  const state = await host.session();
  assert.equal(state.sessionId, "s1");
  assert.equal(state.tabs[0].id, "t1");

  const value = await host.sessionInvoke({ tabId: "t1", steps: [{ m: "snapshot", args: [] }] });
  assert.equal(value.kind, "value");
  assert.equal(value.value.url, "https://example.test");

  const title = await host.sessionInvoke({ tabId: "t1", steps: [{ m: "title", args: [] }] });
  assert.equal(title.value, "Example");

  const root = await host.sessionInvoke({ steps: [{ m: "name" }] });
  assert.equal(root.value, "demo");
});

test("cua session blocks internal members", async () => {
  const session = { deps: { secret: true }, name: "x", capabilities: { list: () => [] }, tabs: { list: async () => [], get: async () => ({}) } };
  const host = api(session);
  await assert.rejects(() => host.sessionInvoke({ steps: [{ m: "deps" }] }), /not available/);
  await assert.rejects(() => host.sessionInvoke({ steps: [{ m: "__proto__" }] }), /not available/);
});
