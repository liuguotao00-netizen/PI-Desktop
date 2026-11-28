import type { BackendTab, BrowserBackend, BrowserCapability, BrowserPageOperations, ScreenshotResult, SnapshotResult } from "./types.ts";
import { BaseBrowserTransport, type BrowserTransportHealth, type BrowserTransportKind } from "./transport.ts";

export type McpToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * MCP Apps backend. Only the tools named here are reachable; an MCP server
 * cannot widen this surface from its own manifest.
 */
export class McpBrowserBackend implements BrowserBackend {
  readonly kind: "mcp" | "mcpapps";
  readonly id: string;
  readonly transport?: McpHttpToolCaller;

  private readonly callTool: McpToolCaller;
  private readonly tabId: string;
  private discovered: BrowserCapability[] | null = null;
  constructor(
    callTool: McpToolCaller,
    tabId = "mcp",
    id = "mcp",
    kind: "mcp" | "mcpapps" = "mcp",
    transport?: McpHttpToolCaller,
  ) {
    this.callTool = callTool;
    this.tabId = tabId;
    this.id = id;
    this.kind = kind;
    if (transport) this.transport = transport;
    else if (callTool instanceof McpHttpToolCaller) this.transport = callTool;
  }

  capabilities(): readonly BrowserCapability[] {
    return this.discovered ?? ["tabs", "navigate", "snapshot", "evaluate", "screenshot", "click", "fill"];
  }

  async initialize(): Promise<void> {
    if (!this.transport) return;
    try {
      const tools = await this.transport.listTools();
      const map: Array<[string, BrowserCapability]> = [
        ["browser_tabs", "tabs"],
        ["browser_navigate", "navigate"],
        ["browser_snapshot", "snapshot"],
        ["browser_evaluate", "evaluate"],
        ["browser_take_screenshot", "screenshot"],
        ["browser_click", "click"],
        ["browser_type", "fill"],
        ["browser_file_upload", "upload"],
        ["browser_press_key", "input"],
        ["browser_hover", "input"],
        ["browser_drag", "input"],
        ["browser_select_option", "input"],
      ];
      const available = new Set(tools);
      const capabilities = map.filter(([tool]) => available.has(tool)).map(([, capability]) => capability);
      if (capabilities.length) this.discovered = [...new Set(capabilities)];
    } catch {
      // Keep the conservative fallback when discovery is unavailable.
    }
  }

  private async rawTabs(): Promise<BackendTab[]> {
    const raw = await this.callTool("browser_tabs", { action: "list" });
    const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
    const tabs: BackendTab[] = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^- (\d+): (current )?\[([^\]]*)\]\(([^)]*)\)/.exec(line.trim());
      if (!match) continue;
      tabs.push({
        id: match[1],
        url: match[4],
        title: match[3],
        active: Boolean(match[2]),
      });
    }
    return tabs;
  }

  async listTabs(): Promise<BackendTab[]> {
    const tabs = await this.rawTabs();
    return tabs.length ? tabs : [{ id: "0", url: "", title: "MCP browser", active: true }];
  }

  async openTab(url: string, _options?: { headless?: boolean }): Promise<BackendTab> {
    await this.callTool("browser_tabs", { action: "new", url });
    const tabs = await this.rawTabs();
    const target = tabs.find((tab) => tab.url === url) ?? tabs[tabs.length - 1] ?? { id: "0", url, title: "" };
    await this.callTool("browser_tabs", { action: "select", index: Number(target.id) });
    await this.callTool("browser_navigate", { url });
    return { ...target, url, active: true };
  }

  async closeTab(tabId: string): Promise<void> {
    await this.callTool("browser_tabs", { action: "close", index: Number(tabId) });
  }

  async attach(tabId: string): Promise<void> {
    await this.callTool("browser_tabs", { action: "select", index: Number(tabId) });
  }

  page(tabId?: string): BrowserPageOperations {
    const callTool = this.callTool;
    const ensureTab = async () => {
      if (tabId === undefined) return;
      await callTool("browser_tabs", { action: "select", index: Number(tabId) });
    };
    return {
      async goto(url) { await ensureTab(); await callTool("browser_navigate", { url }); },
      async reload() { throw Object.assign(new Error("MCP backend reload is server-owned"), { code: "UNSUPPORTED" }); },
      async snapshot() {
        await ensureTab();
        const raw = await callTool("browser_snapshot", {});
        if (raw && typeof raw === "object" && typeof (raw as { tree?: unknown }).tree === "string") {
          return raw as SnapshotResult;
        }
        const text = String(raw ?? "");
        const url = /^- Page URL: (.+)$/m.exec(text)?.[1]?.trim() ?? "";
        const title = /^- Page Title: (.+)$/m.exec(text)?.[1]?.trim() ?? "";
        return { tree: text, url, title };
      },
      async evaluate(expression) {
        await ensureTab();
        const raw = await callTool("browser_evaluate", { function: `() => (${expression})` });
        const text = typeof raw === "string" ? raw : "";
        const match = /### Result\n([\s\S]*?)\n###/.exec(text);
        if (!match) return raw;
        const value = match[1].trim();
        try {
          return JSON.parse(value);
        } catch {
          return value.replace(/^"(.*)"$/, "$1");
        }
      },
      async screenshot(input) {
        await ensureTab();
        const result = (await callTool("browser_take_screenshot", {
          fullPage: input?.fullPage === true,
          scale: "css",
        })) as {
          content?: Array<{ type?: string; data?: string; mimeType?: string }>;
        };
        const image = result?.content?.find((entry) => entry.type === "image" && entry.data);
        if (!image?.data) throw Object.assign(new Error("MCP screenshot returned no image"), { code: "TOOL_FAILED" });
        return { mimeType: image.mimeType || "image/png", data: image.data, width: 0, height: 0 };
      },
      async input() { throw Object.assign(new Error("MCP backend input is not declared"), { code: "UNSUPPORTED" }); },
      async click(ref) { await ensureTab(); await callTool("browser_click", { target: ref }); },
      async fill(ref, text) { await ensureTab(); await callTool("browser_type", { target: ref, text }); },
      async uploadFiles() { throw Object.assign(new Error("MCP backend upload is not declared"), { code: "UNSUPPORTED" }); },
      async download() { throw Object.assign(new Error("MCP backend download is not declared"), { code: "UNSUPPORTED" }); },
      async frames() { throw Object.assign(new Error("MCP backend frames are not declared"), { code: "UNSUPPORTED" }); },
      async locator() { throw Object.assign(new Error("MCP backend locator is not declared"), { code: "UNSUPPORTED" }); },
    };
  }

  dispose(): void {
    this.transport?.close();
  }
}

type JsonRpcReply = { result?: unknown; error?: { message?: string } };

export class McpHttpToolCaller extends BaseBrowserTransport {
  readonly kind: BrowserTransportKind = "mcp";
  private readonly endpoint: string;
  private sessionId: string | null = null;
  private initialized: Promise<void> | null = null;
  private nextId = 1;

  constructor(endpoint: string) {
    super();
    this.endpoint = endpoint.replace(/\/+$/, "");
  }

  async connect(): Promise<void> {
    this.setStatus("connecting");
    try {
      await (this.initialized ??= this.initialize());
      this.setStatus("open");
    } catch (error) {
      this.initialized = null;
      this.setStatus("error");
      throw error;
    }
  }

  async health(): Promise<BrowserTransportHealth> {
    return {
      ok: this.status() === "open",
      status: this.status(),
      ...(this.status() === "open" ? {} : { error: "MCP transport is not connected" }),
    };
  }

  close(): void {
    this.setStatus("closed");
    this.initialized = null;
  }

  async listTools(): Promise<string[]> {
    await this.connect();
    const result = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/list",
      params: {},
    });
    if (result.error) throw new Error(result.error.message || "MCP tools/list failed");
    const tools = (result.result as { tools?: Array<{ name?: string }> } | undefined)?.tools;
    return Array.isArray(tools) ? tools.flatMap((tool) => (typeof tool.name === "string" ? [tool.name] : [])) : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const result = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (result.error) throw new Error(result.error.message || `MCP tool ${name} failed`);
    const value = result.result as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    } | undefined;
    if (value?.isError === true) {
      const message = Array.isArray(value.content)
        ? value.content.map((item) => item.text ?? "").join("\n").trim()
        : "";
      throw Object.assign(new Error(message || `MCP tool ${name} failed`), { code: "TOOL_FAILED" });
    }
    if (value?.structuredContent !== undefined) return value.structuredContent;
    if (Array.isArray(value?.content) && value.content.some((item) => item.type === "image")) {
      return { content: value.content };
    }
    const text = Array.isArray(value?.content) ? value.content.map((item) => item.text ?? "").join("\n") : "";
    try {
      return text ? JSON.parse(text) : value ?? null;
    } catch {
      return text || value || null;
    }
  }

  private async initialize(): Promise<void> {
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pi-desktop", version: "1.0.0" },
      },
    });
    if (response.error) throw new Error(response.error.message || "MCP initialize failed");
    await this.post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, true);
  }

  private async post(body: unknown, notification = false): Promise<JsonRpcReply> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!response.ok) throw new Error(`MCP endpoint returned HTTP ${response.status}`);
    if (notification) return {};
    const text = await response.text();
    if (!text.trim()) return {};
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try {
          return JSON.parse(line.slice(5).trim()) as JsonRpcReply;
        } catch {
          // Keep looking for a JSON data line.
        }
      }
      throw new Error("MCP endpoint returned no JSON event");
    }
    return JSON.parse(text) as JsonRpcReply;
  }
}
