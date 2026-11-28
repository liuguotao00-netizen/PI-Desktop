import { BaseBrowserTransport, type BrowserTransportHealth, type BrowserTransportKind } from "../transport.ts";
import { launchChrome, waitForCdp, type ChromeLaunchOptions } from "../chrome-launcher.ts";
import type { ChildProcess } from "node:child_process";

export type CdpIdentity = {
  browser: string;
  protocolVersion: string;
  endpoint: string;
};

export class CdpTransport extends BaseBrowserTransport {
  readonly kind: BrowserTransportKind = "cdp";
  private readonly endpoint: string;
  private readonly launchOptions?: ChromeLaunchOptions;
  private identityInfo: CdpIdentity | null = null;
  private launched: ChildProcess | null = null;

  constructor(endpoint: string, launchOptions?: ChromeLaunchOptions) {
    super();
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.launchOptions = launchOptions;
  }

  private async endpointAlive(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/json/version`, { signal: AbortSignal.timeout(600) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async launchIfNeeded(): Promise<void> {
    if (!this.launchOptions || (await this.endpointAlive())) return;
    const launched = await launchChrome(this.launchOptions);
    this.launched = launched.child;
    await waitForCdp(this.endpoint, 15_000);
  }

  async connect(): Promise<void> {
    this.setStatus("connecting");
    try {
      await this.launchIfNeeded();
      this.identityInfo = await this.readIdentity();
      this.setStatus("open");
    } catch (error) {
      this.identityInfo = null;
      this.setStatus("error");
      throw error;
    }
  }

  async identity(): Promise<CdpIdentity> {
    if (this.identityInfo) return this.identityInfo;
    await this.connect();
    if (!this.identityInfo) throw new Error("CDP identity unavailable");
    return this.identityInfo;
  }

  async health(): Promise<BrowserTransportHealth> {
    try {
      this.identityInfo = await this.readIdentity();
      this.setStatus("open");
      return { ok: true, status: this.status() };
    } catch (error) {
      this.setStatus("error");
      return {
        ok: false,
        status: this.status(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  close(): void {
    this.identityInfo = null;
    try {
      this.launched?.kill();
    } catch {
      // Already exited.
    }
    this.launched = null;
    this.setStatus("closed");
  }

  private async readIdentity(): Promise<CdpIdentity> {
    const response = await fetch(`${this.endpoint}/json/version`);
    if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}`);
    const version = (await response.json()) as {
      Browser?: string;
      "Protocol-Version"?: string;
      webSocketDebuggerUrl?: string;
    };
    if (!version.webSocketDebuggerUrl) throw new Error("CDP endpoint did not expose a browser WebSocket URL");
    const ws = new URL(version.webSocketDebuggerUrl);
    if (ws.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(ws.hostname)) {
      throw new Error("CDP browser WebSocket must be loopback");
    }
    return {
      browser: String(version.Browser ?? "unknown"),
      protocolVersion: String(version["Protocol-Version"] ?? "unknown"),
      endpoint: this.endpoint,
    };
  }
}
