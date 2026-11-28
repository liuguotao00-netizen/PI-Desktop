import type { BrowserRouter } from "./router.ts";
import type { BrowserService } from "./service.ts";
import type { BrowserCapability } from "./types.ts";
import { BrowserSession } from "./session.ts";
import { TabLifecycle, type TabMark } from "./lifecycle.ts";

export type BrowserSessionsDeps = {
  service: BrowserService;
  router: Pick<BrowserRouter, "capabilities" | "state">;
  lifecycle: TabLifecycle;
  claimTab?: (sessionId: string, tabId: string) => Promise<unknown>;
  releaseTab?: (sessionId: string) => unknown;
  isTabVisible?: (sessionId: string, tabId: string) => Promise<boolean>;
  setTabVisible?: (sessionId: string, tabId: string, visible: boolean) => Promise<void>;
  requestTakeover?: (sessionId: string, reason?: string) => void;
  readClipboard?: () => Promise<string>;
  writeClipboard?: (text: string) => Promise<void>;
  readClipboardImage?: () => Promise<string | null>;
  writeClipboardImage?: (data: string) => Promise<void>;
};

export type BrowserSessionState = {
  sessionId: string;
  turnId?: string;
  claimedTabId?: string;
  tabs: Array<{ tabId: string; origin: string; marks: TabMark[]; claimed: boolean; turnId?: string }>;
};

/**
 * One registry of browser sessions. Plugin tools (`pi.browser.*`) and CUA
 * (`cua.browser`) resolve the same BrowserSession here, so tabs, claims,
 * capabilities, and turn cleanup have a single owner.
 */
export class BrowserSessions {
  readonly lifecycle: TabLifecycle;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly deps: BrowserSessionsDeps;

  constructor(deps: BrowserSessionsDeps) {
    this.deps = deps;
    this.lifecycle = deps.lifecycle;
  }

  /**
   * Codex-shaped browser catalog: the embedded browser plus every backend a
   * live session is bound to. getForUrl-style selection happens in the sandbox.
   */
  catalog(): Array<{ id: string; type: string; name: string; metadata?: Record<string, string> }> {
    const entries: Array<{ id: string; type: string; name: string; metadata?: Record<string, string> }> = [
      { id: "embedded", type: "iab", name: "In-app browser" },
    ];
    const seen = new Set(["embedded"]);
    for (const sessionId of this.sessions.keys()) {
      const state = this.deps.router.state(sessionId);
      const id = String(state?.backendId ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        type: String(state?.kind ?? "cdp"),
        name: `${state?.kind ?? "cdp"} (${id})`,
        metadata: { codexSessionId: sessionId },
      });
    }
    return entries;
  }

  get(sessionId: string): BrowserSession {
    const id = String(sessionId ?? "").trim();
    if (!id) throw new Error("browser session requires a session id");
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const capabilities: readonly BrowserCapability[] = this.deps.router.capabilities(id);
    const created = new BrowserSession({
      service: this.deps.service,
      sessionId: id,
      capabilities,
      lifecycle: this.lifecycle,
      ...(this.deps.claimTab ? { claimTab: this.deps.claimTab } : {}),
      ...(this.deps.releaseTab ? { releaseTab: this.deps.releaseTab } : {}),
      ...(this.deps.isTabVisible ? { isTabVisible: (tabId: string) => this.deps.isTabVisible?.(id, tabId) ?? Promise.resolve(false) } : {}),
      ...(this.deps.setTabVisible ? { setTabVisible: (tabId: string, visible: boolean) => this.deps.setTabVisible?.(id, tabId, visible) ?? Promise.resolve() } : {}),
      ...(this.deps.requestTakeover ? { requestTakeover: (reason?: string) => this.deps.requestTakeover?.(id, reason) } : {}),
      ...(this.deps.readClipboard ? { readClipboard: this.deps.readClipboard } : {}),
      ...(this.deps.writeClipboard ? { writeClipboard: this.deps.writeClipboard } : {}),
      ...(this.deps.readClipboardImage ? { readClipboardImage: this.deps.readClipboardImage } : {}),
      ...(this.deps.writeClipboardImage ? { writeClipboardImage: this.deps.writeClipboardImage } : {}),
    });
    this.sessions.set(id, created);
    return created;
  }

  noteTurnStarted(sessionId: string, turnId: string): void {
    this.lifecycle.noteTurnStarted(sessionId, turnId);
  }

  noteTurnEnded(sessionId: string, turnId?: string): void {
    this.lifecycle.noteTurnEnded(sessionId, turnId);
  }

  /** Register a tab opened through the plugin-facing `browser.tabs` surface. */
  tabOpened(sessionId: string, tabId: string, headless = false): void {
    this.lifecycle.register(sessionId, tabId, headless ? "headless" : "agent");
  }

  tabClosed(sessionId: string, tabId: string): void {
    this.lifecycle.close(sessionId, tabId);
  }

  release(sessionId: string): void {
    this.lifecycle.release(sessionId);
    this.deps.releaseTab?.(sessionId);
  }

  /**
   * Close this turn's temporary tabs and turn the survivors into persistent
   * tabs. Called once when the turn settles.
   */
  async endTurn(sessionId: string, turnId?: string): Promise<string[]> {
    const closing = this.lifecycle.tabsToCloseOnTurnEnd(sessionId, turnId);
    for (const tabId of closing) {
      try {
        await this.deps.service.tabs({ action: "close", tabId }, sessionId);
      } catch {
        // A tab that already disappeared is fine; cleanup is best effort.
      }
      this.lifecycle.close(sessionId, tabId);
    }
    this.lifecycle.settleTurn(sessionId, turnId);
    this.lifecycle.noteTurnEnded(sessionId, turnId);
    return closing;
  }

  state(sessionId: string): BrowserSessionState {
    return {
      sessionId,
      ...(this.lifecycle.currentTurn(sessionId) ? { turnId: this.lifecycle.currentTurn(sessionId) } : {}),
      ...(this.lifecycle.claimedTabId(sessionId) ? { claimedTabId: this.lifecycle.claimedTabId(sessionId) } : {}),
      tabs: this.lifecycle.list(sessionId).map((record) => ({
        tabId: record.tabId,
        origin: record.origin,
        marks: [...record.marks],
        claimed: record.claimed,
        ...(record.turnId ? { turnId: record.turnId } : {}),
      })),
    };
  }

  clear(sessionId: string): void {
    this.lifecycle.clearSession(sessionId);
    this.sessions.delete(sessionId);
  }
}
