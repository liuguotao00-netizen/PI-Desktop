import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { getToolPhrase } from "../src/lib/tool-phrases.ts";
import { slotSsr } from "./helpers/slot-ssr.mjs";

test("persisted plugin tool names resolve through their namespace", () => {
  const click = getToolPhrase("plugin_pi_browser_browser_click", {
    ref: "e4",
    element: "提交订单",
  });
  assert.equal(click?.labelKey, "chat.tools.browser.click");
  assert.equal(
    getToolPhrase("plugin_pi_taobao_tools_fetch_search_keywords", { cate_name: "连衣裙" })
      ?.labelKey,
    "chat.tools.data.fetchKeywords",
  );
});

test("browser actions read as a verb plus the element, never as JSON", () => {
  const click = getToolPhrase("pi.browser.browser_click", {
    ref: "e4",
    element: "提交订单",
  });
  assert.equal(click?.labelKey, "chat.tools.browser.click");
  assert.equal(click?.summaryKey, "chat.tools.summary.target");
  assert.deepEqual(click?.summaryParams, { target: "提交订单" });

  const hover = getToolPhrase("browser_hover", { ref: "e9" });
  assert.equal(hover?.labelKey, "chat.tools.browser.hover");
  assert.equal(hover?.summaryKey, "chat.tools.summary.ref");
  assert.deepEqual(hover?.summaryParams, { ref: "e9" });
});

test("typed text stays private: the phrase carries the target only", () => {
  const typed = getToolPhrase("browser_type", { ref: "e2", text: "hunter2" });
  assert.equal(typed?.summaryKey, "chat.tools.summary.ref");
  assert.ok(!JSON.stringify(typed).includes("hunter2"));
});

test("press_key, scroll and coordinate clicks summarize their own argument", () => {
  assert.deepEqual(getToolPhrase("browser_press_key", { key: "Enter" })?.summaryParams, {
    key: "Enter",
  });
  assert.equal(
    getToolPhrase("browser_scroll", { direction: "down" })?.summaryKey,
    "chat.tools.summary.scrollDown",
  );
  assert.deepEqual(
    getToolPhrase("browser_mouse_click_xy", { x: 12, y: 34 })?.summaryParams,
    { x: 12, y: 34 },
  );
});

test("navigation shows the page, not the full query string", () => {
  const navigate = getToolPhrase("browser_navigate", {
    url: "https://s.taobao.com/search?q=abc&secret=xyz",
  });
  assert.equal(navigate?.summaryKey, "chat.tools.summary.url");
  assert.deepEqual(navigate?.summaryParams, { url: "s.taobao.com/search" });
});

test("form tools count their fields instead of printing them", () => {
  const fill = getToolPhrase("browser_fill_form", {
    fields: [
      { ref: "e1", text: "a" },
      { ref: "e2", text: "b" },
    ],
  });
  assert.equal(fill?.summaryKey, "chat.tools.summary.fields");
  assert.deepEqual(fill?.summaryParams, { count: 2 });
});

test("data-retrieval tools get their own names and arguments", () => {
  const keywords = getToolPhrase("fetch_search_keywords", { cate_name: "连衣裙" });
  assert.equal(keywords?.labelKey, "chat.tools.data.fetchKeywords");
  assert.deepEqual(keywords?.summaryParams, { category: "连衣裙" });

  const run = getToolPhrase("run_automation", { id: "keyword-rank" });
  assert.equal(run?.labelKey, "chat.tools.data.runAutomation");
  assert.deepEqual(run?.summaryParams, { id: "keyword-rank" });
});

test("new diagnostics tools have their own phrases", () => {
  assert.equal(getToolPhrase("browser_wait", { kind: "selector", target: "#go" })?.summaryKey, "chat.tools.summary.target");
  assert.equal(getToolPhrase("browser_wait", { kind: "networkIdle" })?.summaryKey, "chat.tools.summary.waitNetworkIdle");
  assert.equal(getToolPhrase("browser_dialog", { action: "dismiss" })?.summaryKey, "chat.tools.summary.dialogDismiss");
  assert.equal(getToolPhrase("browser_console")?.labelKey, "chat.tools.browser.console");
  assert.equal(getToolPhrase("browser_network")?.labelKey, "chat.tools.browser.network");
});

test("unmapped tools keep the generic presentation", () => {
  assert.equal(getToolPhrase("some_plugin_tool", { foo: "bar" }), null);
  assert.equal(getToolPhrase(undefined), null);
});

test("a browser click row reads as a sentence, not as a tool call", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const message = {
    id: "browser-click-row",
    role: "tool",
    content: "",
    createdAt: "2026-11-24T00:00:00.000Z",
    status: "complete",
    toolName: "plugin_pi_browser_browser_click",
    toolCallId: "browser-click-1",
    toolStatus: "success",
    toolArgs: { ref: "e4", element: "提交订单" },
    toolResult: { content: [{ type: "text", text: "ok" }] },
  };
  const html = ssr.render(createElement(ToolRow, { message }));
  assert.match(html, />Click</);
  assert.match(html, /提交订单/);
  assert.doesNotMatch(html, /browser_click|"ref"|e4/);
});
