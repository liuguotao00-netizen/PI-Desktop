import assert from "node:assert/strict";
import test from "node:test";

test("cua_js keeps bindings per session and resets them", async () => {
  const tools = new Map();
  globalThis.pi = {
    agent: {
      registerTool: async (tool) => { tools.set(tool.name, tool); },
      unregisterTool: async (name) => { tools.delete(name); },
    },
    cua: {
      state: async () => ({ ok: true }),
      bind: async () => ({}),
      clear: async () => ({ ok: true }),
      app: async () => ({}),
      browser: async () => ({}),
      createTab: async () => ({}),
      claimTab: async () => ({ ok: true }),
      releaseTab: async () => ({ ok: true }),
      act: async (input) => { (globalThis.__cuaActs ??= []).push(input); return { ok: true }; },
    },
  };
  const module = await import(`../resources/plugins/pi.cua/main.js?test=${Date.now()}`);
  await module.onLoad();
  const js = tools.get("cua_js");
  const first = await js.execute({ code: "globalThis.count = (globalThis.count || 0) + 1; write(count); return count;" }, { sessionId: "s1" });
  const second = await js.execute({ code: "globalThis.count += 1; return count;" }, { sessionId: "s1" });
  const other = await js.execute({ code: "return typeof count;" }, { sessionId: "s2" });
  assert.deepEqual(JSON.parse(first[0].text).result, 1);
  assert.deepEqual(JSON.parse(second[0].text).result, 2);
  assert.equal(JSON.parse(other[0].text).result, "undefined");
  await tools.get("cua_js_reset").execute({}, { sessionId: "s1" });
  const reset = await js.execute({ code: "return typeof count;" }, { sessionId: "s1" });
  assert.equal(JSON.parse(reset[0].text).result, "undefined");
  await module.onUnload();
  delete globalThis.pi;
});

test("cua_js exposes app/tab handles and image emission", async () => {
  globalThis.__cuaActs = [];
  const tools = new Map();
  globalThis.pi = {
    agent: {
      registerTool: async (tool) => { tools.set(tool.name, tool); },
      unregisterTool: async (name) => { tools.delete(name); },
    },
    cua: {
      state: async () => ({}),
      bind: async () => ({}),
      clear: async () => ({ ok: true }),
      app: async () => ({ targetId: "w1", nodes: [] }),
      browser: async () => ({ tabs: [{ id: "t1" }] }),
      createTab: async () => ({ tabId: "t2" }),
      claimTab: async () => ({ ok: true }),
      releaseTab: async () => ({ ok: true }),
      act: async (input) => { globalThis.__cuaActs.push(input); return { ok: true, data: "aGVsbG8=", mimeType: "image/png" }; },
      capture: async () => ({ mimeType: "image/png", data: "aGVsbG8=" }),
      sessionInvoke: async (input) => {
        globalThis.__cuaSessionCalls ??= [];
        globalThis.__cuaSessionCalls.push(input);
        const last = (input.steps || []).at(-1)?.m;
        if (last === "tabId" || last === "id") return { kind: "value", value: input.tabId };
        if (last === "history") return { kind: "value", value: [] };
        return { kind: "value", value: null };
      },
    },
  };
  const module = await import(`../resources/plugins/pi.cua/main.js?handles=${Date.now()}`);
  await module.onLoad();
  const result = await tools.get("cua_js").execute({
    code: `
      const app = await cua.getApp("w1");
      await app.click("e1");
      const tab = await cua.getTab("t1");
      await tab.click("e2");
      await tab.fill("e3", "text");
      await tab.navigate("https://example.com");
      const history = await tab.history();
      emitImage(await app.screenshot());
      emitImage(history);
      return [app.targetId, await tab.id];
    `,
  }, { sessionId: "handles" });
  assert.deepEqual(JSON.parse(result[0].text).result, ["w1", "t1"]);
  assert.equal(result[1].type, "image");
  assert.deepEqual(globalThis.__cuaActs.map((act) => [act.surface, act.action, act.targetId ?? act.tabId]), [
    ["app", "click", "w1"],
  ]);
  assert.deepEqual((globalThis.__cuaSessionCalls || []).map((call) => [call.tabId, call.steps.at(-1).m]), [
    ["t1", "click"],
    ["t1", "fill"],
    ["t1", "navigate"],
    ["t1", "history"],
    ["t1", "id"],
  ]);
  await module.onUnload();
  delete globalThis.pi;
  delete globalThis.__cuaActs;
  delete globalThis.__cuaSessionCalls;
});
