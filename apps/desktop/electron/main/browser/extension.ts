import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import WebSocket from "ws";
import type { BackendTab, BrowserBackend, BrowserCapability, BrowserPageOperations, ScreenshotResult, SnapshotResult } from "./types.ts";
import { BaseBrowserTransport, type BrowserTransportHealth, type BrowserTransportKind } from "./transport.ts";
import { locatorExpression } from "./locator-script.ts";

export interface ExtensionBridge {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/**
 * Extension backend. The bridge owns tab ownership and page execution; this
 * class only maps the shared operations onto its request protocol.
 */
export class ExtensionBrowserBackend implements BrowserBackend {
  readonly kind = "extension" as const;
  readonly id: string;
  readonly transport?: WebSocketExtensionBridge;

  private readonly bridge: ExtensionBridge;
  private readonly ownsBridge: boolean;
  private readonly downloadDir?: string;
  constructor(
    bridge: ExtensionBridge,
    id = "extension",
    options: { ownsBridge?: boolean; downloadDir?: string } = {},
  ) {
    this.bridge = bridge;
    this.id = id;
    this.ownsBridge = options.ownsBridge ?? true;
    this.downloadDir = options.downloadDir;
    if (bridge instanceof WebSocketExtensionBridge) this.transport = bridge;
  }

  capabilities(): readonly BrowserCapability[] {
    return ["tabs", "navigate", "snapshot", "evaluate", "screenshot", "input", "click", "fill", "upload", "download", "frames", "locator"];
  }

  async listTabs(): Promise<BackendTab[]> {
    const result = (await this.bridge.request("tabs.list")) as { tabs?: BackendTab[] };
    return Array.isArray(result?.tabs) ? result.tabs : [];
  }

  async openTab(url: string, _options?: { headless?: boolean }): Promise<BackendTab> {
    return (await this.bridge.request("tabs.open", { url })) as BackendTab;
  }

  async closeTab(tabId: string): Promise<void> {
    await this.bridge.request("tabs.close", { tabId });
  }

  async attach(tabId: string): Promise<void> {
    await this.bridge.request("tabs.select", { tabId });
  }

  page(tabId: string): BrowserPageOperations {
    const bridge = this.bridge;
    const downloadDir = this.downloadDir;
    const call = (method: string, params: Record<string, unknown> = {}) =>
      bridge.request(method, { tabId, ...params });
    return {
      async goto(url) { await call("page.goto", { url }); },
      async reload() { await call("page.reload"); },
      async snapshot() { return (await call("page.snapshot")) as SnapshotResult; },
      async evaluate(expression) { return call("page.evaluate", { expression }); },
      async screenshot(input) { return (await call("page.screenshot", { ...input })) as ScreenshotResult; },
      async input(event) { return call("page.input", { event }); },
      async click(ref) { await call("page.click", { ref }); },
      async fill(ref, text) { await call("page.fill", { ref, text }); },
      async consoleLogs(limit) { return (await call("page.console", { limit: limit ?? 100 })) as { entries: Array<{ type?: string; message: string; timestamp: number }> }; },
      async networkRequests(limit) { return (await call("page.network", { limit: limit ?? 100 })) as { entries: Array<{ method?: string; url: string; status: number; timestamp: number }> }; },
      async handleDialog(input) { return (await call("page.dialog", { ...input })) as { ok: boolean; error?: string }; },
      async uploadFiles(selector, files) { await call("page.upload", { selector, files }); },
      async download(url, filename) {
        const result = (await call("page.download", { url, filename })) as { path?: string; url?: string; filename?: string; state?: string };
        const moved = relocateDownload(result, downloadDir);
        return { path: String(moved.path ?? ""), bytes: Number(moved.bytes ?? 0) };
      },
      async frames(input) { return call("page.frames", { ...input }); },
      async locator(input) { return call("page.evaluate", { expression: locatorExpression(input) }); },
      async waitForDownload(timeoutMs) { return (await call("page.waitForDownload", { timeoutMs })) as { path: string; url: string; filename: string; state: "completed" | "cancelled" | "interrupted" }; },
    };
  }

  dispose(): void {
    // The in-app bridge server is shared by every session and outlives any one
    // backend; closing it here would take the extension connection down with
    // the session that happened to unbind last.
    if (this.ownsBridge) this.bridge.close();
  }
}

export class WebSocketExtensionBridge extends BaseBrowserTransport implements ExtensionBridge {
  readonly kind: BrowserTransportKind = "extension";
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly ready: Promise<void>;

  constructor(url: string) {
    super();
    this.setStatus("connecting");
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("open", () => {
        this.setStatus("open");
        resolve();
      });
      this.socket.once("error", (error) => {
        this.setStatus("error");
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      this.socket.on("close", () => {
        if (this.status() !== "closed") this.setStatus("error");
      });
      this.socket.on("message", (data) => {
        let message: BridgeResponse;
        try {
          message = JSON.parse(String(data)) as BridgeResponse;
        } catch {
          return;
        }
        if (typeof message.id !== "number") return;
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || "extension bridge error"));
        else entry.resolve(message.result ?? null);
      });
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async connect(): Promise<void> {
    await this.ready;
    this.setStatus("open");
  }

  async health(): Promise<BrowserTransportHealth> {
    return {
      ok: this.status() === "open",
      status: this.status(),
      ...(this.status() === "open" ? {} : { error: "extension bridge is not connected" }),
    };
  }

  close(): void {
    this.setStatus("closed");
    this.socket.close();
    for (const entry of this.pending.values()) entry.reject(new Error("extension bridge closed"));
    this.pending.clear();
  }
}

type BridgeResponse = { id?: number; result?: unknown; error?: { message?: string } };

/**
 * chrome.downloads always writes to the browser's download folder. The plugin
 * contract is "into the session scratch directory", so move the completed file
 * there and hand back the relocated path.
 */
function relocateDownload(result: { path?: string } & Record<string, unknown>, downloadDir?: string) {
  const path = result?.path;
  if (!path) return result;
  const size = (file: string) => {
    try { return statSync(file).size; } catch { return 0; }
  };
  if (!downloadDir) return { ...result, bytes: size(path) };
  const targetDir = resolve(downloadDir);
  const source = resolve(path);
  if (source === targetDir || source.startsWith(targetDir + sep)) return { ...result, bytes: size(source) };
  mkdirSync(targetDir, { recursive: true });
  const name = basename(source) || "download";
  let target = join(targetDir, name);
  if (existsSync(target)) target = join(targetDir, `${Date.now()}-${name}`);
  try {
    renameSync(source, target);
  } catch {
    copyFileSync(source, target);
    unlinkSync(source);
  }
  return { ...result, path: target, filename: basename(target), bytes: size(target) };
}
