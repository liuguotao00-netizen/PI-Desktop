import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpConnection } from "./connection.ts";
import { snapshotPage } from "./snapshot.ts";
import { PageObserver } from "./observer.ts";
import { PageFileChooser } from "./chooser.ts";
import { PageDownloads } from "./downloads.ts";
import { crossOriginFrame } from "./frames.ts";
import { readFrames, runLocator } from "./locator.ts";
import type { BackendTab, BrowserBackend, BrowserCapability, BrowserPageOperations, DownloadResult, LocatorQuery, ScreenshotResult, SnapshotResult } from "../types.ts";

export class CdpPage implements BrowserPageOperations {
  private connection: CdpConnection | null = null;
  private readonly ready: Promise<void>;
  private readonly chooserTracker: PageFileChooser;
  private readonly observer: PageObserver;
  private readonly downloads: PageDownloads;

  private readonly target: { id: string; webSocketDebuggerUrl: string };
  constructor(target: { id: string; webSocketDebuggerUrl: string }, downloadDir?: string) {
    this.target = target;
    const resolvedDownloadDir = downloadDir ? join(downloadDir, "cdp-downloads") : join(tmpdir(), "pi-desktop-cdp-downloads");
    const connection = new CdpConnection(target.webSocketDebuggerUrl);
    this.connection = connection;
    this.observer = new PageObserver(connection);
    this.chooserTracker = new PageFileChooser(connection);
    this.downloads = new PageDownloads(connection, resolvedDownloadDir);
    connection.on("__reconnect", () => {
      void this.enableDomains();
    });
    this.ready = this.enableDomains();
  }

  private async conn(): Promise<CdpConnection> {
    await this.ready;
    if (!this.connection) throw new Error("CDP page closed");
    return this.connection;
  }

  async goto(url: string, timeoutMs = 30_000): Promise<void> {
    const cdp = await this.conn();
    const loaded = new Promise<void>((resolve) => {
      const off = cdp.on("Page.loadEventFired", () => { off(); resolve(); });
      setTimeout(() => { off(); resolve(); }, Math.max(1_000, timeoutMs));
    });
    await cdp.send("Page.navigate", { url });
    await loaded;
  }

  async reload(): Promise<void> {
    const cdp = await this.conn();
    await cdp.send("Page.reload", {});
  }

  async snapshot(): Promise<SnapshotResult> {
    return snapshotPage(await this.conn());
  }

  async history() {
    const result = (await (await this.conn()).send("Page.getNavigationHistory")) as {
      currentIndex?: number;
      entries?: Array<{ id?: number; url?: string; title?: string }>;
    };
    const entries = (result.entries ?? []).map((entry, index) => ({
      index,
      url: String(entry.url ?? ""),
      title: String(entry.title ?? ""),
    }));
    return { index: Number(result.currentIndex ?? 0), entries };
  }

  async evaluate(expression: string): Promise<unknown> {
    const cdp = await this.conn();
    const result = (await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "CDP evaluate failed");
    return result.result?.value ?? null;
  }

  getJsDialog(): { type: string; message: string; defaultPrompt?: string } | null {
    return this.observer.currentDialog();
  }

  async screenshot(input: { fullPage?: boolean; format?: "jpeg" | "png"; clip?: { x: number; y: number; width: number; height: number } } = {}): Promise<ScreenshotResult> {
    const cdp = await this.conn();
    const format = input.format === "png" ? "png" : "jpeg";
    const metrics = (await cdp.send("Page.getLayoutMetrics")) as {
      cssContentSize?: { width?: number; height?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
      layoutViewport?: { clientWidth?: number; clientHeight?: number };
    };
    const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
    const content = metrics.cssContentSize ?? {};
    const clip = input.clip
      ? {
          x: Math.max(0, Math.round(input.clip.x)),
          y: Math.max(0, Math.round(input.clip.y)),
          width: Math.max(1, Math.round(input.clip.width)),
          height: Math.max(1, Math.round(input.clip.height)),
          scale: 1,
        }
      : null;
    const width = clip
      ? clip.width
      : Math.max(1, Math.round(Number(input.fullPage ? content.width : viewport.clientWidth) || 1));
    const height = clip
      ? clip.height
      : Math.max(1, Math.round(Number(input.fullPage ? content.height : viewport.clientHeight) || 1));
    const result = (await cdp.send("Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality: 70 } : {}),
      ...(clip
        ? { captureBeyondViewport: true, clip }
        : input.fullPage
          ? { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }
          : {}),
    })) as { data?: string };
    if (!result.data) throw new Error("CDP screenshot produced no data");
    return { mimeType: format === "png" ? "image/png" : "image/jpeg", data: result.data, width, height };
  }

  async input(event: unknown): Promise<unknown> {
    const cdp = await this.conn();
    const record = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
    const type = String(record.type || "");
    if (type === "insertText") return cdp.send("Input.insertText", { text: String(record.text ?? "") });
    if (type.startsWith("key")) {
      return cdp.send("Input.dispatchKeyEvent", {
        type: type === "keyDown" ? "keyDown" : type === "keyUp" ? "keyUp" : "char",
        key: String(record.key ?? ""),
        code: String(record.code ?? ""),
        text: typeof record.text === "string" ? record.text : undefined,
        modifiers: Number(record.modifiers) || 0,
      });
    }
    return cdp.send("Input.dispatchMouseEvent", {
      type: type === "mouseDown" ? "mousePressed" : type === "mouseUp" ? "mouseReleased" : type === "mouseWheel" ? "mouseWheel" : "mouseMoved",
      x: Number(record.x) || 0,
      y: Number(record.y) || 0,
      button: String(record.button ?? "none"),
      clickCount: Number(record.clickCount) || 0,
      modifiers: Number(record.modifiers) || 0,
    });
  }

  private async point(ref: string): Promise<{ x: number; y: number }> {
    let lastError = "unknown or stale ref";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const value = await this.evaluate(`(() => {
        const el = globalThis.__PI_EXT_REFS && globalThis.__PI_EXT_REFS.byRef.get(${JSON.stringify(ref)});
        if (!el) return { error: 'unknown or stale ref' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { error: 'element has no layout box' };
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') {
          return { error: 'element is not visible' };
        }
        if (el.disabled) return { error: 'element is disabled' };
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        if (!top || (top !== el && !el.contains(top))) return { error: 'element is obscured' };
        return { x, y };
      })()`);
      const point = value as { x?: number; y?: number; error?: string } | null;
      if (point && typeof point.x === "number" && typeof point.y === "number") {
        return { x: point.x, y: point.y };
      }
      lastError = point?.error ?? "unknown or stale ref";
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error(`${lastError} for ref "${ref}"; take a snapshot first`);
  }

  async click(ref: string): Promise<void> {
    const { x, y } = await this.point(ref);
    await this.input({ type: "mouseMove", x, y });
    await this.input({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    await this.input({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  }

  async crossOriginFrame(input: {
    action: "list" | "text" | "html" | "click" | "fill";
    frameId?: string;
    url?: string;
    targetSelector?: string;
    value?: string;
    limit?: number;
  }): Promise<unknown> {
    return crossOriginFrame(await this.conn(), input, async (x, y) => {
      await this.input({ type: "mouseMove", x, y });
      await this.input({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      await this.input({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    });
  }

  private async enableDomains(): Promise<void> {
    const cdp = this.connection;
    if (!cdp) return;
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Network.enable").catch(() => undefined),
    ]);
    await this.chooserTracker.reenable();
    await this.downloads.enable();
  }

  async consoleLogs(limit = 100): Promise<{ entries: Array<{ type?: string; message: string; timestamp: number }> }> {
    return this.observer.consoleLogs(limit);
  }

  async networkRequests(limit = 100): Promise<{ entries: Array<{ method?: string; url: string; status: number; timestamp: number }> }> {
    return this.observer.networkRequests(limit);
  }

  async handleDialog(input: { accept?: boolean; promptText?: string } = {}): Promise<{ ok: boolean; error?: string }> {
    return this.observer.handleDialog(await this.conn(), input);
  }

  async waitForFileChooser(timeoutMs = 15_000): Promise<{ backendNodeId: number; mode: string }> {
    return this.chooserTracker.wait(timeoutMs);
  }

  async cancelFileChooser(): Promise<void> {
    await this.chooserTracker.cancel();
  }

  async setFileChooserFiles(files: string[]): Promise<void> {
    return this.chooserTracker.setFiles(files);
  }

  async waitForDownload(timeoutMs = 30_000): Promise<DownloadResult> {
    return this.downloads.wait(timeoutMs);
  }

  async clickAndWaitForDownload(ref: string, timeoutMs = 30_000): Promise<DownloadResult> {
    const wait = this.downloads.wait(timeoutMs);
    try {
      await this.click(ref);
    } catch (error) {
      wait.catch(() => undefined);
      throw error;
    }
    return wait;
  }

  async waitForNetworkIdle(timeoutMs = 15_000, idleMs = 500): Promise<void> {
    await this.observer.waitForNetworkIdle(timeoutMs, idleMs);
  }

  async fill(ref: string, text: string): Promise<void> {
    const ready = await this.evaluate(`(() => {
      const map = globalThis.__PI_REFS || (globalThis.__PI_EXT_REFS && globalThis.__PI_EXT_REFS.byRef);
      const el = map && map.get(${JSON.stringify(ref)});
      if (!el || el.disabled) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      el.scrollIntoView({ block: 'center' });
      el.focus({ preventScroll: true });
      if (typeof el.select === 'function') el.select();
      else if (el.isContentEditable) document.getSelection()?.selectAllChildren(el);
      return true;
    })()`);
    if (ready !== true) throw new Error(`unknown, disabled or invisible ref "${ref}"; take a snapshot first`);
    await this.input({ type: "insertText", text });
  }

  async uploadFiles(selector: string, files: string[]): Promise<void> {
    const cdp = await this.conn();
    const object = (await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    })) as { result?: { objectId?: string } };
    if (!object.result?.objectId) throw new Error(`file input not found: ${selector}`);
    await cdp.send("DOM.enable", {});
    await cdp.send("DOM.setFileInputFiles", { objectId: object.result.objectId, files });
  }

  async download(url: string, _filename?: string): Promise<{ path: string; bytes: number; url: string; filename: string; state: "completed" | "cancelled" | "interrupted" }> {
    const wait = this.downloads.wait();
    const cdp = await this.conn();
    await cdp.send("Page.navigate", { url });
    const result = await wait;
    return { ...result, bytes: 0 };
  }

  async frames(input: { action: "list" | "text" | "html"; index?: number; selector?: string; limit?: number }): Promise<unknown> {
    return readFrames((expression) => this.evaluate(expression), input);
  }

  async locator(input: LocatorQuery): Promise<unknown> {
    return runLocator((expression) => this.evaluate(expression), input);
  }

  dispose(): void {
    this.chooserTracker.dispose();
    this.downloads.dispose();
  }
}