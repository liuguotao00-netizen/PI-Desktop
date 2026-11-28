#!/usr/bin/env node
/**
 * Real MCP browser E2E. Start the Playwright MCP server first:
 *   npx -y @playwright/mcp@0.0.86 --port 8931 --headless
 * then run:
 *   MCP_BROWSER_URL=http://localhost:8931/mcp node scripts/e2e-mcp-browser.mjs
 * (the server binds localhost, which can resolve to ::1 on macOS)
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { McpBrowserBackend, McpHttpToolCaller } from "../apps/desktop/electron/main/browser/mcp.ts";

const endpoint = process.env.MCP_BROWSER_URL || "http://localhost:8931/mcp";
const caller = new McpHttpToolCaller(endpoint);
const backend = new McpBrowserBackend((name, args) => caller.callTool(name, args), "mcp", "mcp:e2e");
try {
  await caller.connect();
  assert.ok(backend.capabilities().includes("snapshot"));
  const tabs = await backend.listTabs();
  assert.ok(Array.isArray(tabs));
  const opened = await backend.openTab(
    "data:text/html,<title>PI MCP E2E</title><button id='b' onclick=\"document.title='clicked'\">Click</button><input id='i' />",
  );
  const page = backend.page(opened.id);
  const snapshot = await page.snapshot();
  assert.match(snapshot.tree, /ref=e/);
  assert.equal(snapshot.title, "PI MCP E2E");
  const screenshot = await page.screenshot({ fullPage: false });
  assert.equal(screenshot.mimeType, "image/png");
  assert.ok(screenshot.data.length > 100);
  await page.fill("#i", "hello");
  assert.equal(await page.evaluate("document.querySelector('#i').value"), "hello");
  await page.click("#b");
  assert.equal(await page.evaluate("document.title"), "clicked");
  await assert.rejects(
    () => page.click("#missing-target"),
    (error) => error?.code === "TOOL_FAILED",
  );
  console.log(JSON.stringify({
    ok: true,
    endpoint,
    tabs: tabs.length,
    snapshotChars: snapshot.tree.length,
    screenshotBytes: screenshot.data.length,
  }, null, 2));
} finally {
  backend.dispose();
}
