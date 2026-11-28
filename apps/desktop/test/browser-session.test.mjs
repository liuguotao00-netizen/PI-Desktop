import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSession } from "../electron/main/browser/session.ts";

function service() {
  const calls = [];
  return {
    calls,
    async tabs(input, sessionId) {
      calls.push(["tabs", input, sessionId]);
      if (input.action === "new") return { tabId: "t2" };
      return { tabs: [{ tabId: "t1", title: "One", url: "https://one.test", active: true }], activeTabId: "t1" };
    },
    async navigate(input, sessionId, tabId) { calls.push(["navigate", input, sessionId, tabId]); return { ok: true }; },
    async snapshot(sessionId, tabId) { calls.push(["snapshot", sessionId, tabId]); return { tree: "", url: "", title: "" }; },
    async screenshot(input, sessionId, tabId) { calls.push(["screenshot", input, sessionId, tabId]); return { data: "x" }; },
    async click(ref, sessionId, tabId) { calls.push(["click", ref, sessionId, tabId]); },
    async fill(ref, text, sessionId, tabId) { calls.push(["fill", ref, text, sessionId, tabId]); },
    async evaluate(expression, sessionId, tabId) {
      calls.push(["evaluate", expression, sessionId, tabId]);
      if (expression.includes("contentDocument")) return null;
      if (expression.includes("__PI_DOM_NODES")) return { ok: true, tree: "", nodes: [] };
      return expression.includes("frame ?") ? "https://one.test" : "Example";
    },
    async history(sessionId, tabId) { calls.push(["history", sessionId, tabId]); return { entries: [] }; },
    action(action, sessionId, tabId) { calls.push(["action", action, sessionId, tabId]); },
    inputEvent(event, sessionId, tabId) { calls.push(["inputEvent", event, sessionId, tabId]); return { ok: true }; },
    insertText(text, sessionId, tabId) { calls.push(["insertText", text, sessionId, tabId]); return { ok: true }; },
    cdp(method, params, sessionId, tabId) { calls.push(["cdp", method, params, sessionId, tabId]); return { ok: true }; },
    console(limit, sessionId, tabId) { calls.push(["console", limit, sessionId, tabId]); return { messages: [] }; },
    networkRequests(input, sessionId, tabId) { calls.push(["network", input, sessionId, tabId]); return { entries: [] }; },
    async crossOriginFrame(input, sessionId, tabId) { calls.push(["frame", input, sessionId, tabId]); return { ok: true, count: 2, matches: [{ text: "a" }, { text: "b" }] }; },
    async locator(input, sessionId, tabId) {
      calls.push(["locator", input, sessionId, tabId]);
      const action = input?.action || "list";
      const matches = [{ ref: "e1", index: 0, text: "Submit", visible: true, enabled: true, box: { x: 0, y: 0, width: 10, height: 10 } }];
      if (action === "count") return { ok: true, count: 1, matches: [] };
      if (action === "textContent" || action === "innerText" || action === "text") return { ok: true, count: 1, matches, value: "Submit" };
      if (action === "isVisible" || action === "isEnabled") return { ok: true, count: 1, matches, value: true };
      if (action === "evaluateAll") return { ok: true, count: 1, matches, value: ["Submit"] };
      return { ok: true, count: 1, matches };
    },
  };
}

test("BrowserSession exposes Codex-shaped tabs and tab handles", async () => {
  const svc = service();
  let clipboard = "";
  let clipboardImage = null;
  const session = new BrowserSession({
    service: svc,
    sessionId: "s1",
    capabilities: ["tabs", "locator"],
    readClipboard: async () => clipboard,
    writeClipboard: async (value) => { clipboard = value; },
    readClipboardImage: async () => clipboardImage,
    writeClipboardImage: async (value) => { clipboardImage = value; },
  });
  const tabs = await session.tabs.list();
  assert.equal(tabs[0].id, "t1");
  const tab = await session.tabs.get("t1");
  await tab.goto("https://one.test");
  assert.equal((await session.history())[0].url, "https://one.test");
  await tab.click("e1");
  await tab.fill("e1", "hello");
  assert.equal(await tab.evaluate("document.title"), "Example");
  assert.equal(await tab.playwright.locator("button").count(), 1);
  assert.equal(await tab.playwright.getByRole("button").textContent(), "Submit");
  await tab.ax.click({ x: 10, y: 20 });
  await tab.cua.type({ text: "hello" });
  await tab.dev.cdp("Page.enable");
  await tab.dev.console(10);
  assert.equal(await tab.playwright.locator("button").nth(1).count(), 1);
  assert.ok(Array.isArray(await tab.playwright.locator("button").all()));
  assert.equal(typeof tab.playwright.waitForLoadState, "function");
  assert.equal(typeof tab.playwright.waitForEvent, "function");
  assert.equal(typeof tab.dev.logs, "function");
  assert.equal(await tab.playwright.frameLocator("iframe#panel").locator(".item").count(), 2);
  await tab.playwright.frameLocator("iframe#panel").locator("button").click();
  assert.equal(svc.calls.find((call) => call[0] === "frame")[1].url, "https://one.test");
  await tab.clipboard.writeText("copied");
  assert.equal(await tab.clipboard.readText(), "copied");
  await tab.clipboard.write([{ type: "text", text: "items" }]);
  await tab.clipboard.write([{ type: "image", data: "aW1n" }]);
  assert.deepEqual(await tab.clipboard.read(), [{ type: "image", data: "aW1n" }]);
  const dom = await tab.dom_cua.get_visible_dom();
  assert.equal(typeof dom, "object");
  assert.equal(typeof dom.tree, "string");
  assert.ok(Array.isArray(dom.nodes));
  const created = await session.tabs.new();
  assert.equal(created.id, "t2");
  assert.deepEqual(svc.calls.at(-1)[1], { action: "new" });
});

test("BrowserSession user tabs claim through the injected claim callback", async () => {
  const svc = service();
  let claimed = null;
  const session = new BrowserSession({
    service: svc,
    sessionId: "s1",
    capabilities: ["tabs"],
    claimTab: async (sessionId, tabId) => { claimed = [sessionId, tabId]; },
  });
  const [open] = await session.user.openTabs();
  const context = await session.user.getTabContext(open);
  assert.equal(context.tab.id, "t1");
  assert.equal(context.content.text, "Example");
  const tab = await session.user.claimTab(open);
  assert.deepEqual(claimed, ["s1", "t1"]);
  assert.equal(tab.id, "t1");
});
