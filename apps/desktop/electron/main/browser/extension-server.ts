import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { ExtensionBridge } from "./extension.ts";

const DEFAULT_PORT = 47123;
const DEFAULT_PATH = "/pi-browser";
/**
 * Native messaging hosts relay Chrome's stdio frames here. They cannot set an
 * extension Origin header, so this path is authenticated by the per-install
 * token alone; the token lives in the app data directory with mode 0600.
 */
const NATIVE_PATH = "/pi-browser-native";

/**
 * Loopback bridge owned by Electron. The MV3 extension connects as a client;
 * the browser backend sends the same method frames the old client-side bridge
 * exposed. Only one extension connection is active at a time.
 */
export class ExtensionBridgeServer implements ExtensionBridge {
  private readonly port: number;
  private boundPort = DEFAULT_PORT;
  private readonly token: string;
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private readonly clientWaitMs: number;
  /** Woken when an extension connection is accepted; see waitForClient. */
  private readonly clientWaiters = new Set<() => void>();
  constructor(port = DEFAULT_PORT, token: string = randomUUID(), options: { clientWaitMs?: number } = {}) {
    this.port = port;
    this.token = token;
    this.clientWaitMs = options.clientWaitMs ?? 5_000;
  }

  get endpoint(): string {
    return `ws://127.0.0.1:${this.boundPort}${DEFAULT_PATH}?token=${this.token}`;
  }

  get nativeEndpoint(): string {
    return `ws://127.0.0.1:${this.boundPort}${NATIVE_PATH}?token=${this.token}`;
  }

  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  async listen(): Promise<void> {
    if (this.server) return;
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: this.port });
      server.once("listening", () => {
        const address = server.address();
        if (address && typeof address === "object") this.boundPort = address.port;
        this.server = server;
        resolve();
      });
      server.once("error", (error) => {
        this.starting = null;
        server.close();
        reject(error);
      });
      server.on("connection", (socket, request) => {
        const url = new URL(request.url ?? "/", "ws://127.0.0.1");
        if (url.pathname !== DEFAULT_PATH && url.pathname !== NATIVE_PATH) {
          socket.close(1008, "unknown bridge path");
          return;
        }
        const token = url.searchParams.get("token");
        if (token !== this.token) {
          socket.close(1008, "extension token required");
          return;
        }
        if (url.pathname === DEFAULT_PATH) {
          const origin = String(request.headers.origin ?? "");
          if (!/^(chrome-extension|moz-extension|extension):\/\//i.test(origin)) {
            socket.close(1008, "extension origin required");
            return;
          }
        }
        this.accept(socket);
      });
    });
    await this.starting;
  }

  private accept(socket: WebSocket): void {
    this.socket?.close();
    this.socket = socket;
    for (const wake of this.clientWaiters) wake();
    this.clientWaiters.clear();
    socket.on("message", (raw) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || "extension bridge error"));
      else entry.resolve(message.result ?? null);
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.rejectAll(new Error("extension bridge disconnected"));
    });
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /**
   * The extension reconnects a couple of seconds after the MV3 worker wakes, so
   * a request that lands in that gap waits briefly instead of failing.
   */
  private waitForClient(timeoutMs: number): Promise<boolean> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.clientWaiters.delete(wake);
        resolve(false);
      }, timeoutMs);
      this.clientWaiters.add(wake);
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.listen();
    await this.waitForClient(this.clientWaitMs);
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw Object.assign(new Error("extension bridge is not connected"), { code: "UNAVAILABLE" });
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`extension request timed out: ${method}`), { code: "TIMEOUT" }));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  close(): void {
    for (const wake of this.clientWaiters) wake();
    this.clientWaiters.clear();
    this.rejectAll(new Error("extension bridge closed"));
    this.socket?.close();
    this.socket = null;
    this.server?.close();
    this.server = null;
    this.starting = null;
  }
}
