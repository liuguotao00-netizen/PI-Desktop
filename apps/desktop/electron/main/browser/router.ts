import type { BrowserBackend, BrowserBackendBinding, BrowserCapability, BrowserPageOperations } from "./types.ts";
import { BrowserBackendRegistry } from "./registry.ts";
import { EmbeddedBrowserBackend } from "./embedded.ts";
import { createBrowserBackend, type ConnectBrowserBackendInput } from "./factory.ts";
import { CdpBrowserBackend } from "./cdp.ts";
import type { BrowserHost } from "../browser-host";
import type { ExtensionBridge } from "./extension.ts";

/**
 * The session-bound routing layer. The embedded browser is the default
 * binding; external bindings replace it per session and never persist.
 */
export class BrowserRouter {
  private readonly registry = new BrowserBackendRegistry();
  private readonly embedded = new Map<string, EmbeddedBrowserBackend>();
  private readonly statusListeners = new Set<(sessionId: string, status: string) => void>();
  private readonly statusUnsubs = new Map<string, () => void>();

  private readonly host: BrowserHost;
  private readonly extensionBridge?: ExtensionBridge;
  private get extensionBridgeEndpoint(): string | undefined {
    const bridge = this.extensionBridge as { endpoint?: string } | undefined;
    return bridge?.endpoint;
  }
  constructor(host: BrowserHost, extensionBridge?: ExtensionBridge) {
    this.host = host;
    this.extensionBridge = extensionBridge;
  }

  private embeddedBackend(sessionId: string): EmbeddedBrowserBackend {
    const id = String(sessionId || "");
    const existing = this.embedded.get(id);
    if (existing) return existing;
    const created = new EmbeddedBrowserBackend(this.host, id);
    this.embedded.set(id, created);
    return created;
  }

  backendFor(sessionId?: string): BrowserBackend {
    return this.registry.binding(sessionId)?.backend ?? this.embeddedBackend(String(sessionId || ""));
  }

  activeTabId(sessionId?: string): string | null {
    return this.registry.binding(sessionId)?.tabId ?? null;
  }

  onBackendStatus(listener: (sessionId: string, status: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private watchTransport(sessionId: string, backend: BrowserBackend): void {
    this.statusUnsubs.get(sessionId)?.();
    if (!backend.transport) return;
    const unsubscribe = backend.transport.onStatus((status) => {
      for (const listener of this.statusListeners) {
        try {
          listener(sessionId, status);
        } catch {
          // Diagnostics only.
        }
      }
    });
    this.statusUnsubs.set(sessionId, unsubscribe);
  }

  binding(sessionId?: string): BrowserBackendBinding | undefined {
    return this.registry.binding(sessionId);
  }

  setTab(sessionId: string, tabId: string): void {
    this.registry.setTab(sessionId, tabId);
  }

  pageFor(sessionId?: string, tabId?: string): BrowserPageOperations {
    const binding = this.registry.binding(sessionId);
    if (binding) return binding.backend.page(binding.tabId);
    return this.embeddedBackend(String(sessionId || "")).page(tabId || "");
  }

  externalPage(sessionId?: string): BrowserPageOperations | null {
    const binding = this.registry.binding(sessionId);
    return binding ? binding.backend.page(binding.tabId) : null;
  }

  capabilities(sessionId?: string): readonly BrowserCapability[] {
    const binding = this.registry.binding(sessionId);
    return binding ? binding.backend.capabilities() : this.embeddedBackend(String(sessionId || "")).capabilities();
  }

  requireCapability(sessionId: string | undefined, capability: BrowserCapability): void {
    const binding = this.registry.binding(sessionId);
    if (binding && !binding.backend.capabilities().includes(capability)) {
      throw new Error(`backend ${binding.backend.kind} does not support ${capability}`);
    }
  }

  state(sessionId?: string): {
    backendId: string;
    kind: string;
    tabId: string | null;
    capabilities: readonly BrowserCapability[];
    transportStatus: string | null;
    extensionBridgeEndpoint?: string;
  } {
    const binding = this.registry.binding(sessionId);
    if (binding) {
      return {
        backendId: binding.backend.id,
        kind: binding.backend.kind,
        tabId: binding.tabId,
        capabilities: binding.backend.capabilities(),
        transportStatus: binding.backend.transport?.status() ?? null,
        ...(this.extensionBridgeEndpoint ? { extensionBridgeEndpoint: this.extensionBridgeEndpoint } : {}),
      };
    }
    const embedded = this.embeddedBackend(String(sessionId || ""));
    return {
      backendId: embedded.id,
      kind: embedded.kind,
      tabId: null,
      capabilities: embedded.capabilities(),
      transportStatus: null,
      ...(this.extensionBridgeEndpoint ? { extensionBridgeEndpoint: this.extensionBridgeEndpoint } : {}),
    };
  }

  async connect(input: ConnectBrowserBackendInput, sessionId?: string): Promise<unknown> {
    const id = String(sessionId || "").trim();
    if (!id) throw new Error("browser backend requires a session");
    const backend = createBrowserBackend({
      ...input,
      ...(this.extensionBridge ? { extensionBridge: this.extensionBridge } : {}),
      downloadDir: this.host.getScratchDir?.(id) ?? undefined,
    });
    try {
      await backend.transport?.connect();
      await backend.initialize?.();
      const identity = backend instanceof CdpBrowserBackend ? await backend.identity() : undefined;
      const tabs = await backend.listTabs();
      let tabId = typeof input.tabId === "string" ? input.tabId : tabs[0]?.id;
      if (!tabId && backend instanceof CdpBrowserBackend) {
        const opened = await backend.openTab(String(input.url || "about:blank"));
        tabId = opened.id;
      }
      if (!tabId) throw new Error("browser backend has no tab");
      await backend.attach(tabId);
      this.registry.bind(id, backend, tabId);
      this.watchTransport(id, backend);
      return {
        ok: true,
        backendId: backend.id,
        kind: backend.kind,
        tabId,
        capabilities: backend.capabilities(),
        tabs: await backend.listTabs(),
        ...(identity ? { identity } : {}),
      };
    } catch (error) {
      console.error("[browser-connect] failed", error instanceof Error ? error.message : error);
      backend.dispose();
      throw error;
    }
  }

  async health(sessionId?: string): Promise<{ ok: boolean; kind: string; tabs?: number; error?: string }> {
    const binding = this.registry.binding(sessionId);
    if (!binding) return { ok: true, kind: "embedded" };
    if (binding.backend.transport) {
      const health = await binding.backend.transport.health();
      return { ok: health.ok, kind: binding.backend.kind, ...(health.error ? { error: health.error } : {}) };
    }
    if (binding.backend.health) {
      const result = await binding.backend.health();
      return { ...result, kind: binding.backend.kind };
    }
    return { ok: true, kind: binding.backend.kind };
  }

  disconnect(sessionId?: string): { ok: true; kind: "embedded" } {
    const id = String(sessionId || "");
    this.statusUnsubs.get(id)?.();
    this.statusUnsubs.delete(id);
    this.registry.unbind(id);
    return { ok: true, kind: "embedded" };
  }

  release(sessionId: string): void {
    this.statusUnsubs.get(sessionId)?.();
    this.statusUnsubs.delete(sessionId);
    this.registry.unbind(sessionId);
    this.embedded.delete(sessionId);
  }

  dispose(): void {
    for (const unsubscribe of this.statusUnsubs.values()) unsubscribe();
    this.statusUnsubs.clear();
    this.registry.dispose();
    this.embedded.clear();
  }
}
