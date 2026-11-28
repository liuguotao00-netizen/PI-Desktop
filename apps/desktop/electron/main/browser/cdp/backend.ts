import type { BackendTab, BrowserBackend, BrowserCapability, BrowserPageOperations } from "../types.ts";
import { CdpPage } from "./page.ts";
import { CdpTransport } from "./transport.ts";
import type { ChromeLaunchOptions } from "../chrome-launcher.ts";

export class CdpBrowserBackend implements BrowserBackend {
  readonly kind = "cdp" as const;
  readonly id: string;
  readonly transport: CdpTransport;
  private readonly pages = new Map<string, CdpPage>();
  private readonly endpoint: string;

  private readonly downloadDir?: string;
  constructor(endpoint: string, downloadDir?: string, id = `cdp:${endpoint}`, launchOptions?: ChromeLaunchOptions) {
    const raw = String(endpoint || "").trim().replace(/\/+$/, "");
    if (!raw) throw new Error("CDP endpoint is required.");
    this.endpoint = raw;
    this.downloadDir = downloadDir;
    this.id = id;
    this.transport = new CdpTransport(raw, launchOptions);
  }

  capabilities(): readonly BrowserCapability[] {
    return ["tabs", "navigate", "snapshot", "evaluate", "screenshot", "input", "click", "fill", "upload", "download", "frames", "locator"];
  }

  private async targetList(): Promise<Array<{ id: string; url: string; title: string; webSocketDebuggerUrl: string; type?: string }>> {
    const response = await fetch(`${this.endpoint}/json/list`);
    if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}`);
    const list = (await response.json()) as Array<{ id?: string; url?: string; title?: string; type?: string; webSocketDebuggerUrl?: string }>;
    return list.flatMap((entry) => {
      if (!entry.id || !entry.webSocketDebuggerUrl) return [];
      if (entry.type !== "page" && entry.type !== undefined) return [];
      let ws: URL;
      try { ws = new URL(entry.webSocketDebuggerUrl); } catch { return []; }
      if (ws.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(ws.hostname)) return [];
      return [{ id: entry.id, url: entry.url || "", title: entry.title || "", webSocketDebuggerUrl: entry.webSocketDebuggerUrl, type: entry.type }];
    });
  }

  async identity(): Promise<{ browser: string; protocolVersion: string; endpoint: string }> {
    return this.transport.identity();
  }

  async health(): Promise<{ ok: boolean; tabs: number; error?: string }> {
    const transport = await this.transport.health();
    if (!transport.ok) return { ok: false, tabs: 0, error: transport.error };
    try {
      const tabs = await this.listTabs();
      return { ok: true, tabs: tabs.length };
    } catch (error) {
      return { ok: false, tabs: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listTabs(): Promise<BackendTab[]> {
    return (await this.targetList()).map((target) => ({ id: target.id, url: target.url, title: target.title }));
  }

  async openTab(url: string, _options?: { headless?: boolean }): Promise<BackendTab> {
    const response = await fetch(`${this.endpoint}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!response.ok) throw new Error(`CDP endpoint could not open a tab (HTTP ${response.status})`);
    const target = (await response.json()) as { id?: string; url?: string; title?: string };
    if (!target.id) throw new Error("CDP endpoint returned no tab id");
    return { id: target.id, url: target.url || url, title: target.title || "" };
  }

  async closeTab(tabId: string): Promise<void> {
    await fetch(`${this.endpoint}/json/close/${encodeURIComponent(tabId)}`);
    this.pages.get(tabId)?.dispose();
    this.pages.delete(tabId);
  }

  page(tabId: string): BrowserPageOperations {
    const existing = this.pages.get(tabId);
    if (existing) return existing;
    const cached = this.targets.get(tabId);
    if (!cached) throw new Error("CDP tab is not attached; list tabs first.");
    const page = new CdpPage(cached, this.downloadDir);
    this.pages.set(tabId, page);
    return page;
  }

  private targets = new Map<string, { id: string; webSocketDebuggerUrl: string }>();

  async attach(tabId: string): Promise<void> {
    const target = (await this.targetList()).find((entry) => entry.id === tabId);
    if (!target) throw new Error("CDP tab not found");
    this.targets.set(tabId, { id: target.id, webSocketDebuggerUrl: target.webSocketDebuggerUrl });
  }

  dispose(): void {
    this.transport.close();
    for (const page of this.pages.values()) page.dispose();
    this.pages.clear();
    this.targets.clear();
  }
}

/** Transport implemented by a Chrome/Edge extension bridge. */
