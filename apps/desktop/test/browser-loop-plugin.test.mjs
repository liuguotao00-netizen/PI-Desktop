import assert from "node:assert/strict";
import test from "node:test";

test("browser_run observes, asks the model, executes and stops on done", async () => {
  const tools = new Map();
  const calls = [];
  let answer = 0;
  const answers = [
    '{"action":"click","uid":"e1","note":"open"}',
    '{"action":"fill","uid":"e2","text":"hello","note":"type"}',
    '{"action":"done","summary":"finished the test"}',
  ];
  globalThis.pi = {
    agent: {
      registerTool: async (tool) => { tools.set(tool.name, tool); },
      unregisterTool: async (name) => { tools.delete(name); },
      complete: async () => {
        calls.push(["complete", answer]);
        return { text: answers[answer++] ?? '{"action":"done","summary":"fallback"}', modelKey: "m" };
      },
    },
    models: { list: async () => [{ key: "m", isDefault: true }] },
    session: { getLlmContext: async () => ({ modelKey: "m" }) },
    browser: {
      lock: async () => { calls.push(["lock"]); },
      unlock: async () => { calls.push(["unlock"]); },
      navigate: async (input) => { calls.push(["navigate", input]); },
      snapshot: async () => ({ tree: "- e1 button Open\n- e2 textbox Name", url: "https://example.test", title: "Example" }),
      evaluate: async () => ({ value: "Example page text" }),
      click: async (input) => { calls.push(["click", input]); },
      fill: async (input) => { calls.push(["fill", input]); },
    },
  };
  const module = await import(`../resources/plugins/pi.browser-loop/main.js?test=${Date.now()}`);
  await module.onLoad();
  const result = await tools.get("browser_run").execute({ goal: "test the loop", maxSteps: 5 }, { sessionId: "s1" });
  const parsed = JSON.parse(result[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary, "finished the test");
  assert.deepEqual(calls.filter((call) => call[0] === "click" || call[0] === "fill"), [
    ["click", { uid: "e1" }],
    ["fill", { uid: "e2", text: "hello" }],
  ]);
  assert.equal(calls.filter((call) => call[0] === "complete").length, 3);
  await module.onUnload();
  delete globalThis.pi;
});

test("browser_run supports wait, screenshot and time limits", async () => {
  const tools = new Map();
  const images = [];
  let answer = 0;
  const answers = [
    '{"action":"wait","selector":".ready","timeoutMs":1000}',
    '{"action":"screenshot","fullPage":true}',
    '{"action":"done","summary":"captured"}',
  ];
  globalThis.pi = {
    agent: {
      registerTool: async (tool) => { tools.set(tool.name, tool); },
      unregisterTool: async (name) => { tools.delete(name); },
      complete: async () => ({ text: answers[answer++] ?? '{"action":"done","summary":"fallback"}', modelKey: "m" }),
    },
    models: { list: async () => [{ key: "m", isDefault: true }] },
    session: { getLlmContext: async () => ({ modelKey: "m" }) },
    browser: {
      lock: async () => {},
      unlock: async () => {},
      snapshot: async () => ({ tree: "", url: "https://example.test", title: "Example" }),
      evaluate: async () => ({ value: { selector: true, text: true, url: true } }),
      screenshot: async () => ({ data: "aGVsbG8=", mimeType: "image/png", width: 800, height: 600 }),
    },
  };
  const module = await import(`../resources/plugins/pi.browser-loop/main.js?test=${Date.now()}`);
  await module.onLoad();
  const result = await tools.get("browser_run").execute({ goal: "wait and capture", maxSteps: 5, maxMs: 10000 }, { sessionId: "s2" });
  const parsed = JSON.parse(result[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary, "captured");
  assert.equal(result.filter((block) => block.type === "image").length, 1);
  await module.onUnload();
  delete globalThis.pi;
});
