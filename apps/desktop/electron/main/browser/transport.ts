/**
 * Unified transport lifecycle for external browser backends.
 *
 * Protocol clients keep their own request shapes; this layer owns connect,
 * status, health and listeners so CDP, extension and MCP backends expose the
 * same operational surface to the router and settings.
 */

export type BrowserTransportKind = "cdp" | "extension" | "mcp";
export type BrowserTransportStatus = "idle" | "connecting" | "open" | "closed" | "error";

export type BrowserTransportHealth = {
  ok: boolean;
  status: BrowserTransportStatus;
  error?: string;
};

export interface BrowserTransport {
  readonly kind: BrowserTransportKind;
  status(): BrowserTransportStatus;
  connect(): Promise<void>;
  close(): void;
  health(): Promise<BrowserTransportHealth>;
  onStatus(listener: (status: BrowserTransportStatus) => void): () => void;
}

export abstract class BaseBrowserTransport implements BrowserTransport {
  abstract readonly kind: BrowserTransportKind;
  private current: BrowserTransportStatus = "idle";
  private readonly listeners = new Set<(status: BrowserTransportStatus) => void>();

  status(): BrowserTransportStatus {
    return this.current;
  }

  protected setStatus(status: BrowserTransportStatus): void {
    if (status === this.current) return;
    this.current = status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // Status listeners are diagnostics only.
      }
    }
  }

  onStatus(listener: (status: BrowserTransportStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async health(): Promise<BrowserTransportHealth> {
    return { ok: this.current === "open", status: this.current };
  }

  abstract connect(): Promise<void>;
  abstract close(): void;
}
