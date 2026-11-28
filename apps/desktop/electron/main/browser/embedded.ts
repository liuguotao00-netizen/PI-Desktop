import type { BrowserBackend, BrowserCapability, BrowserPageOperations, BackendTab, ScreenshotResult, SnapshotResult } from "./types.ts";
import type { BrowserHost } from "../browser-host";
import { locatorExpression } from "./locator-script.ts";

export type EmbeddedBrowserHost = Pick<
  BrowserHost,
  | "listTabs"
  | "openTab"
  | "openBackgroundTab"
  | "closeTab"
  | "selectTab"
  | "showTab"
  | "navigate"
  | "action"
  | "snapshot"
  | "history"
  | "evaluate"
  | "evaluateNative"
  | "evaluateIsolated"
  | "screenshot"
  | "sendInputEvent"
  | "insertText"
  | "click"
  | "fill"
  | "uploadFiles"
  | "downloadUrl"
  | "waitForDownload"
  | "authorizeUploadFiles"
  | "waitForFileChooser"
  | "setFileChooserFiles"
  | "cancelFileChooser"
  | "crossOriginFrame"
  | "consoleLogs"
  | "networkRequests"
  | "waitForNetworkIdle"
  | "handleDialog"
  | "clickAndWaitForDownload"
>;

export class EmbeddedBrowserBackend implements BrowserBackend {
  readonly id = "embedded";
  readonly kind = "embedded" as const;
  private readonly host: EmbeddedBrowserHost;
  private readonly sessionId: string;

  constructor(host: EmbeddedBrowserHost, sessionId: string) {
    this.host = host;
    this.sessionId = sessionId;
  }

  capabilities(): readonly BrowserCapability[] {
    return ["tabs", "navigate", "snapshot", "evaluate", "screenshot", "input", "click", "fill", "upload", "download", "frames", "locator"];
  }

  async listTabs(): Promise<BackendTab[]> {
    const listed = this.host.listTabs(this.sessionId);
    return [
      ...listed.tabs.map((tab) => ({
        id: tab.tabId,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        headless: false,
      })),
      ...listed.headlessTabs.map((tab) => ({
        id: tab.tabId,
        url: tab.url,
        title: tab.title,
        active: false,
        headless: true,
      })),
    ];
  }

  async openTab(url: string, options?: { headless?: boolean }): Promise<BackendTab> {
    const opened = options?.headless
      ? await this.host.openBackgroundTab({ url }, this.sessionId)
      : await this.host.openTab({ url }, this.sessionId);
    return { id: opened.tabId, url, title: opened.state?.title || "", headless: options?.headless === true };
  }

  async closeTab(tabId: string): Promise<void> {
    this.host.closeTab(this.sessionId, tabId);
  }

  async attach(tabId: string): Promise<void> {
    this.host.selectTab(this.sessionId, tabId);
  }

  async showTab(tabId: string): Promise<void> {
    this.host.showTab(this.sessionId, tabId);
  }

  page(tabId?: string): BrowserPageOperations {
    const host = this.host;
    const sessionId = this.sessionId;
    const tab = tabId || undefined;
    return {
      async goto(url) { return await host.navigate({ url }, sessionId, tab); },
      async reload() { host.action("reload", sessionId, tab); },
      async snapshot() { return await host.snapshot(sessionId, tab); },
      async history() { return await host.history(sessionId, tab); },
      async evaluate(expression) { return await host.evaluate(expression, sessionId, tab); },
      async evaluateNative(expression) { return await host.evaluateNative(expression, sessionId, tab); },
      async evaluateIsolated(expression) { return await host.evaluateIsolated(expression, sessionId, tab); },
      async screenshot(input) {
        const shot = await host.screenshot(input, sessionId, tab);
        return { ...shot, width: shot.width ?? 0, height: shot.height ?? 0 };
      },
      async input(event) {
        if (event && typeof event === "object" && (event as { type?: string }).type === "insertText") {
          return host.insertText(String((event as { text?: string }).text ?? ""), sessionId, tab);
        }
        return host.sendInputEvent(event, sessionId, tab);
      },
      async click(ref) { await host.click(ref, sessionId, tab); },
      async fill(ref, text) { await host.fill(ref, text, sessionId, tab); },
      async uploadFiles(selector, files) { await host.uploadFiles(selector, files, sessionId, tab); },
      async waitForFileChooser(timeoutMs) { return await host.waitForFileChooser(sessionId, tab, timeoutMs); },
      async setFileChooserFiles(files) { await host.setFileChooserFiles(files, sessionId, tab); },
      async cancelFileChooser() { await host.cancelFileChooser(sessionId, tab); },
      async crossOriginFrame(input) { return await host.crossOriginFrame(input, sessionId, tab); },
      async consoleLogs(limit) { return host.consoleLogs({ limit: limit ?? 100 }, sessionId, tab); },
      async networkRequests(limit) { return host.networkRequests({ limit: limit ?? 100 }, sessionId, tab); },
      async waitForNetworkIdle(timeoutMs, idleMs) {
        await host.waitForNetworkIdle({ timeoutMs, idleMs }, sessionId, tab);
      },
      async handleDialog(input) { return host.handleDialog(input, sessionId, tab); },
      async clickAndWaitForDownload(ref, timeoutMs) {
        const record = await host.clickAndWaitForDownload(ref, timeoutMs, sessionId, tab);
        return { path: record.path, url: record.url, filename: record.filename, state: record.state === "completed" ? "completed" : record.state === "cancelled" ? "cancelled" : "interrupted" };
      },
      async download(url, filename) { return await host.downloadUrl(url, filename, sessionId, tab); },
      async waitForDownload(timeoutMs) {
        const record = await host.waitForDownload(sessionId, tab, timeoutMs);
        return { path: record.path, url: record.url, filename: record.filename, state: record.state === "completed" ? "completed" : record.state === "cancelled" ? "cancelled" : "interrupted" };
      },
      async frames() { throw Object.assign(new Error("embedded frames are handled by the browser tool"), { code: "UNSUPPORTED" }); },
      async locator(input) { return await host.evaluate(locatorExpression(input), sessionId, tab); },
    };
  }

  dispose(): void {
    // BrowserHost owns the page lifetime.
  }
}
