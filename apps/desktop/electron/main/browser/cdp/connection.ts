import WebSocket from "ws";

export type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string; code?: number };
  method?: string;
  params?: unknown;
  sessionId?: string;
};

export class CdpConnection {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private open: Promise<void> | null = null;
  private closed = false;

  private readonly url: string;
  constructor(url: string) {
    this.url = url;
    this.connect();
  }

  private connect(): void {
    if (this.closed) throw new Error("CDP connection closed");
    this.socket = new WebSocket(this.url);
    const socket = this.socket;
    this.open = new Promise((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
      socket.on("message", (data) => this.onMessage(String(data)));
      socket.on("close", () => {
        if (this.closed) return;
        this.socket = null;
        this.open = null;
        for (const entry of this.pending.values()) entry.reject(new Error("CDP socket closed"));
        this.pending.clear();
      });
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.socket || !this.open) this.connect();
    await this.open;
    const socket = this.socket;
    if (!socket) throw new Error("CDP socket closed");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
    for (const entry of this.pending.values()) entry.reject(new Error("CDP connection closed"));
    this.pending.clear();
  }

  private onMessage(text: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(text) as CdpResponse;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || "CDP command failed"));
      else entry.resolve(message.result ?? null);
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(message.params);
        } catch {
          // Events are best effort.
        }
      }
    }
  }
}
