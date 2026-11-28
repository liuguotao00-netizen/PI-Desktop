import type { CdpConnection } from "./connection.ts";

export class PageObserver {
  private consoleEntries: Array<{ type?: string; message: string; timestamp: number }> = [];
  private networkEntries = new Map<string, { method?: string; url: string; status: number; timestamp: number }>();
  private readonly inFlightNetwork = new Set<string>();
  private lastNetworkActivity = Date.now();
  private dialog: { type: string; message: string; defaultPrompt?: string } | null = null;

  constructor(connection: CdpConnection) {
    connection.on("Runtime.consoleAPICalled", (params) => {
      const record = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
      const args = Array.isArray(record.args) ? record.args : [];
      const text = args.map((arg) => {
        const value = arg && typeof arg === "object" ? (arg as Record<string, unknown>) : {};
        return String(value.value ?? value.description ?? value.type ?? "");
      }).filter(Boolean).join(" ");
      this.consoleEntries.push({
        type: typeof record.type === "string" ? record.type : "log",
        message: text.slice(0, 4000),
        timestamp: Date.now(),
      });
      if (this.consoleEntries.length > 300) this.consoleEntries.shift();
    });
    connection.on("Network.requestWillBeSent", (params) => {
      const record = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
      const request = (record.request ?? {}) as Record<string, unknown>;
      const requestId = String(record.requestId ?? "");
      if (!requestId) return;
      this.inFlightNetwork.add(requestId);
      this.lastNetworkActivity = Date.now();
      this.networkEntries.set(requestId, {
        method: typeof request.method === "string" ? request.method : undefined,
        url: String(request.url ?? ""),
        status: 0,
        timestamp: Date.now(),
      });
      while (this.networkEntries.size > 300) {
        const first = this.networkEntries.keys().next().value;
        if (typeof first !== "string") break;
        this.networkEntries.delete(first);
      }
    });
    connection.on("Network.loadingFinished", (params) => {
      const record = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
      this.inFlightNetwork.delete(String(record.requestId ?? ""));
      this.lastNetworkActivity = Date.now();
    });
    connection.on("Network.loadingFailed", (params) => {
      const record = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
      this.inFlightNetwork.delete(String(record.requestId ?? ""));
      this.lastNetworkActivity = Date.now();
    });
    connection.on("Network.responseReceived", (params) => {
      const record = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
      const response = (record.response ?? {}) as Record<string, unknown>;
      const requestId = String(record.requestId ?? "");
      const entry = this.networkEntries.get(requestId);
      if (entry) entry.status = Number(response.status) || 0;
    });
    connection.on("Page.javascriptDialogOpening", (params) => {
      const record = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
      this.dialog = {
        type: String(record.type ?? "alert"),
        message: String(record.message ?? ""),
        ...(typeof record.defaultPrompt === "string" ? { defaultPrompt: record.defaultPrompt } : {}),
      };
    });
    connection.on("Page.javascriptDialogClosed", () => {
      this.dialog = null;
    });
  }

  currentDialog(): { type: string; message: string; defaultPrompt?: string } | null {
    return this.dialog ? { ...this.dialog } : null;
  }

  consoleLogs(limit = 100): { entries: Array<{ type?: string; message: string; timestamp: number }> } {
    return { entries: this.consoleEntries.slice(-Math.max(1, Math.min(300, limit))) };
  }

  async waitForNetworkIdle(timeoutMs = 15_000, idleMs = 500): Promise<void> {
    const deadline = Date.now() + Math.max(100, timeoutMs);
    while (Date.now() < deadline) {
      if (this.inFlightNetwork.size === 0 && Date.now() - this.lastNetworkActivity >= idleMs) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Object.assign(new Error("network did not become idle"), { code: "TIMEOUT" });
  }

  networkRequests(limit = 100): { entries: Array<{ method?: string; url: string; status: number; timestamp: number }> } {
    return { entries: [...this.networkEntries.values()].slice(-Math.max(1, Math.min(300, limit))) };
  }

  async handleDialog(connection: CdpConnection, input: { accept?: boolean; promptText?: string } = {}): Promise<{ ok: boolean; error?: string }> {
    if (!this.dialog) return { ok: false, error: "no JavaScript dialog is open" };
    await connection.send("Page.handleJavaScriptDialog", {
      accept: input.accept !== false,
      ...(typeof input.promptText === "string" ? { promptText: input.promptText } : {}),
    });
    this.dialog = null;
    return { ok: true };
  }
}
