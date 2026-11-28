#!/usr/bin/env node
/**
 * Live Chrome extension E2E. Uses a locally installed Playwright Chromium and
 * the repository's MV3 extension. The browser opens visibly.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/macmini/Desktop/大笔/dbqs-mcp/standalone/node_modules/playwright-core/index.mjs";
import { ExtensionBridgeServer } from "../apps/desktop/electron/main/browser/extension-server.ts";

const extensionDir = fileURLToPath(new URL("../apps/desktop/resources/browser-extension", import.meta.url));
const executablePath =
  process.env.PI_CHROMIUM_PATH ||
  "/Users/macmini/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const server = new ExtensionBridgeServer(0);
await server.listen();
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "pi-ext-")), {
  executablePath,
  headless: false,
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});
try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  await worker.evaluate(async (url) => {
    await chrome.storage.local.set({ bridgeUrl: url });
  }, server.endpoint);
  let listed;
  for (let attempt = 0; attempt < 40 && !listed; attempt += 1) {
    try { listed = await server.request("tabs.list"); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  assert.ok(listed, "extension did not connect to the bridge");
  const page = await context.newPage();
  await page.goto("data:text/html,<title>Ext E2E</title><input id='i'>");
  const tabs = await server.request("tabs.list");
  const active = tabs.tabs.find((tab) => tab.active);
  assert.ok(active, "no active tab");
  const title = await server.request("page.evaluate", { tabId: active.id, expression: "document.title" });
  assert.equal(title, "Ext E2E");
  const snapshot = await server.request("page.snapshot", { tabId: active.id });
  assert.match(snapshot.tree, /textbox/);
  console.log(JSON.stringify({ ok: true, tabs: tabs.tabs.length, title, snapshotChars: snapshot.tree.length }, null, 2));
} finally {
  await context.close();
  server.close();
}
