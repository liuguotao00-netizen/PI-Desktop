import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cdpSource = await readFile(new URL("../electron/main/browser-cdp.ts", import.meta.url), "utf8");
const externalCdpSource = await readFile(new URL("../electron/main/browser/cdp/page.ts", import.meta.url), "utf8");
const discoverySource = await readFile(new URL("../electron/main/browser/discovery.ts", import.meta.url), "utf8");
const launcherSource = await readFile(new URL("../electron/main/browser/chrome-launcher.ts", import.meta.url), "utf8");
const cdpDownloadsSource = await readFile(new URL("../electron/main/browser/cdp/downloads.ts", import.meta.url), "utf8");
const cdpFramesSource = await readFile(new URL("../electron/main/browser/cdp/frames.ts", import.meta.url), "utf8");
const cdpObserverSource = await readFile(new URL("../electron/main/browser/cdp/observer.ts", import.meta.url), "utf8");
const hostSource = await readFile(new URL("../electron/main/browser-host.ts", import.meta.url), "utf8");
const runtimeSource = await readFile(new URL("../electron/main/plugin-runtime.ts", import.meta.url), "utf8");
const pluginSource = await readFile(new URL("../resources/plugins/pi.browser/main.js", import.meta.url), "utf8");

test("file uploads use CDP file inputs and host-checked session roots", () => {
  assert.match(cdpSource, /DOM\.setFileInputFiles/);
  assert.match(cdpSource, /Page\.setInterceptFileChooserDialog/);
  assert.match(cdpSource, /Page\.fileChooserOpened/);
  assert.match(hostSource, /async uploadFiles\(/);
  assert.match(hostSource, /File is outside the session workspace/);
  assert.match(hostSource, /resolveExistingFile\(file\)/);
  assert.match(pluginSource, /name: "browser_upload_file"/);
  assert.match(pluginSource, /waitForFileChooser/);
  assert.match(pluginSource, /setFileChooserFiles/);
});

test("downloads are bounded and land in session scratch", () => {
  assert.match(hostSource, /async downloadUrl\(/);
  assert.match(hostSource, /64 \* 1024 \* 1024/);
  assert.match(hostSource, /Only http\(s\) URLs can be downloaded/);
  assert.match(hostSource, /will-download/);
  assert.match(hostSource, /clickAndWaitForDownload/);
  assert.match(cdpDownloadsSource, /Browser\.setDownloadBehavior/);
  assert.match(cdpDownloadsSource, /Browser\.downloadProgress/);
  assert.match(pluginSource, /name: "browser_download"/);
  assert.match(pluginSource, /clickAndWaitForDownload/);
  assert.match(pluginSource, /waitForDownload/);
});

test("locator and frame tools stay read-scoped", () => {
  assert.match(pluginSource, /name: "browser_locator"/);
  assert.match(pluginSource, /action: \{ type: "string", enum: \["list", "count"/);
  assert.match(pluginSource, /pi\.browser\.locator/);
  assert.match(pluginSource, /action === "click" \|\| action === "dblclick"/);
  assert.match(pluginSource, /hasText/);
  assert.match(pluginSource, /action === "waitFor"/);
  assert.match(pluginSource, /name: "browser_frame"/);
  assert.match(pluginSource, /Cross-origin frame content is not readable/);
  assert.match(pluginSource, /action === 'fill'/);
  assert.match(pluginSource, /frameRect.left \+ targetRect.left/);
  assert.match(pluginSource, /crossOriginFrame/);
  assert.match(cdpSource, /crossOriginFrame/);
  assert.match(cdpFramesSource, /Page\.createIsolatedWorld/);
  assert.match(hostSource, /getScratchDir/);
  assert.match(pluginSource, /name: "browser_evaluate"/);
});

test("upload and download are admitted by the plugin host API", () => {
  assert.match(runtimeSource, /"browser\.uploadFiles"/);
  assert.match(runtimeSource, /"browser\.downloadUrl"/);
  assert.match(runtimeSource, /case "uploadFiles":/);
  assert.match(runtimeSource, /case "downloadUrl":/);
  assert.match(runtimeSource, /"browser\.connectBackend"/);
  assert.match(runtimeSource, /browser\.backendState/);
  assert.match(discoverySource, /discoverChromeCdp/);
  assert.match(launcherSource, /launchChrome/);
  assert.match(launcherSource, /remote-debugging-port/);
});

test("browser plugin registers the new tools", async () => {
  const previous = globalThis.pi;
  const names = [];
  globalThis.pi = {
    agent: {
      registerTool: async (tool) => { names.push(tool.name); },
      unregisterTool: async () => {},
    },
    browser: {},
  };
  try {
    const plugin = await import(`../resources/plugins/pi.browser/main.js?caps=${Date.now()}`);
    await plugin.onLoad();
    assert.ok(names.includes("browser_upload_file"));
    assert.ok(names.includes("browser_download"));
    assert.ok(names.includes("browser_locator"));
    assert.ok(names.includes("browser_frame"));
    assert.ok(names.includes("browser_evaluate"));
    assert.ok(names.includes("browser_backend"));
  } finally {
    globalThis.pi = previous;
  }
});
