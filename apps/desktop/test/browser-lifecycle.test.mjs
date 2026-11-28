import assert from "node:assert/strict";
import test from "node:test";
import { TabLifecycle } from "../electron/main/browser/lifecycle.ts";
import { BrowserSessions } from "../electron/main/browser/sessions.ts";
import { BrowserSession } from "../electron/main/browser/session.ts";

function fakeService(tabs = []) {
  const closed = [];
  const shown = [];
  const service = {
    closed,
    shown,
    tabs: async (input) => {
      if (input.action === "list") {
        return {
          tabs: tabs.map((tab) => ({ tabId: tab.id, url: tab.url, title: tab.title, active: tab.active === true })),
          activeTabId: tabs.find((tab) => tab.active)?.id ?? null,
        };
      }
      if (input.action === "close") closed.push(input.tabId);
      if (input.action === "show") shown.push(input.tabId);
      return { ok: true };
    },
  };
  return service;
}

test("a turn closes only its unmarked automation tabs and settles survivors", () => {
  const lifecycle = new TabLifecycle();
  lifecycle.noteTurnStarted("s", "t1");
  lifecycle.register("s", "user-tab", "user");
  lifecycle.register("s", "agent-tab", "agent");
  lifecycle.register("s", "deliverable-tab", "agent");
  lifecycle.register("s", "handoff-tab", "agent");
  lifecycle.register("s", "headless-tab", "headless");
  lifecycle.register("s", "claimed-tab", "agent");
  lifecycle.mark("s", "deliverable-tab", "deliverable");
  lifecycle.mark("s", "handoff-tab", "handoff");
  lifecycle.claim("s", "claimed-tab");

  assert.deepEqual(
    lifecycle.tabsToCloseOnTurnEnd("s", "t1").sort(),
    ["agent-tab", "headless-tab"],
  );

  lifecycle.settleTurn("s", "t1");
  assert.deepEqual(lifecycle.marks("s", "deliverable-tab"), []);
  assert.equal(lifecycle.record("s", "deliverable-tab")?.turnId, undefined);
  // A tab that survived is persistent: the next turn does not close it.
  lifecycle.noteTurnStarted("s", "t2");
  assert.deepEqual(lifecycle.tabsToCloseOnTurnEnd("s", "t2"), []);
});

test("registry endTurn closes unmarked tabs through the service and releases nothing else", async () => {
  const service = fakeService([{ id: "agent", url: "https://a", active: true }]);
  const lifecycle = new TabLifecycle();
  const sessions = new BrowserSessions({
    service,
    router: { capabilities: () => ["tabs", "snapshot", "visibility"] },
    lifecycle,
  });
  lifecycle.noteTurnStarted("s", "t1");
  lifecycle.register("s", "agent", "agent");
  lifecycle.register("s", "user", "user");

  const closed = await sessions.endTurn("s", "t1");
  assert.deepEqual(closed, ["agent"]);
  assert.deepEqual(service.closed, ["agent"]);
  assert.equal(lifecycle.record("s", "agent"), undefined);
  assert.ok(lifecycle.record("s", "user"), "user tabs survive turn cleanup");
  assert.equal(sessions.state("s").tabs.length, 1);
});

test("browser and tab capabilities resolve to callable objects", async () => {
  let takeoverReason;
  const service = fakeService([{ id: "a", url: "https://a", title: "A", active: true }]);
  const lifecycle = new TabLifecycle();
  const session = new BrowserSession({
    service,
    sessionId: "s",
    capabilities: ["tabs", "visibility", "content", "playwright"],
    lifecycle,
    requestTakeover: (reason) => { takeoverReason = reason; },
  });

  const caps = session.capabilities;
  assert.deepEqual(caps.list().sort(), ["content", "playwright", "tabs", "visibility"]);
  const visibility = await caps.get("visibility");
  assert.equal(typeof visibility.get, "function");
  assert.equal(await visibility.get(), true);
  await visibility.set(true);
  assert.deepEqual(service.shown, ["a"]);

  const tabsCapability = await caps.get("tabs");
  assert.equal(typeof tabsCapability.list, "function");

  const tab = await session.tabs.get("a");
  assert.equal(typeof (await tab.capabilities.get("visibility")).set, "function");
  const content = await tab.capabilities.get("content");
  assert.equal(typeof content.text, "function");

  tab.markHandoff();
  assert.deepEqual(tab.marks(), ["handoff"]);
  tab.requestUserTakeover("captcha");
  assert.equal(takeoverReason, "captcha");
  await assert.rejects(session.capabilities.get("missing"), /unknown browser capability/);
});
