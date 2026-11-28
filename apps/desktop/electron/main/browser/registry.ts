import type { BrowserBackend, BrowserBackendBinding } from "./types.ts";

export class BrowserBackendRegistry {
  private readonly bindings = new Map<string, BrowserBackendBinding>();
  private readonly external = new Map<string, BrowserBackend>();

  bind(sessionId: string, backend: BrowserBackend, tabId: string): BrowserBackendBinding {
    const id = sessionId.trim();
    if (!id) throw new Error("Browser backend binding requires a session.");
    this.unbind(id);
    const binding = { backend, tabId };
    this.bindings.set(id, binding);
    this.external.set(backend.id, backend);
    return binding;
  }

  binding(sessionId?: string): BrowserBackendBinding | undefined {
    const id = (sessionId || "").trim();
    return id ? this.bindings.get(id) : undefined;
  }

  setTab(sessionId: string, tabId: string): void {
    const binding = this.bindings.get(sessionId.trim());
    if (binding) binding.tabId = tabId;
  }

  unbind(sessionId: string): void {
    const id = sessionId.trim();
    const binding = this.bindings.get(id);
    this.bindings.delete(id);
    if (!binding) return;
    const stillUsed = [...this.bindings.values()].some((item) => item.backend.id === binding.backend.id);
    if (!stillUsed) this.disposeBackend(binding.backend.id);
  }

  disposeBackend(backendId: string): void {
    for (const [sessionId, binding] of this.bindings) {
      if (binding.backend.id === backendId) this.bindings.delete(sessionId);
    }
    this.external.get(backendId)?.dispose();
    this.external.delete(backendId);
  }

  dispose(): void {
    for (const backend of this.external.values()) backend.dispose();
    this.external.clear();
    this.bindings.clear();
  }
}
