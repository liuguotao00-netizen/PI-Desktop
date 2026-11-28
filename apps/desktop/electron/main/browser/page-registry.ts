import type { BrowserWindow, DownloadItem } from "electron";
import type { BrowserState } from "@pi-desktop/shared";
import type { BrowserPane } from "../browser-view";
import { BrowserCdp } from "../browser-cdp";
import { controlSnapshot } from "../browser-agent-control.ts";

export type BrowserDownloadRecord = {
  id: string;
  url: string;
  filename: string;
  path: string;
  state: "started" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  error?: string;
};

export type BrowserDownloadWaiter = {
  resolve: (record: BrowserDownloadRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** A host-owned page, keyed by conversation and resource tab. */
export type BrowserPage = {
  key: string;
  sessionId: string;
  tabId: string | null;
  pane: BrowserPane;
  cdp: BrowserCdp;
  state: BrowserState | null;
  started: boolean;
  navigationVersion: number;
  navigating: boolean;
  lastScreenshot?: {
    url: string;
    imageWidth: number;
    imageHeight: number;
    path?: string;
    at: number;
  };
  downloads?: BrowserDownloadRecord[];
  downloadItems?: Map<string, DownloadItem>;
  downloadWaiters?: BrowserDownloadWaiter[];
  detachDownloads?: () => void;
  downloadContentsId?: number;
};

export type BrowserPageRegistryDeps = {
  createPane: (
    onState: (state: BrowserState) => void,
    onOpenUrl: (url: string) => void,
    sessionId: string,
  ) => BrowserPane;
  onOpenUrl?: (url: string, sessionId?: string) => void;
  onState: (state: BrowserState) => void;
  onPresentationState?: (state: BrowserState) => void;
  isActive: (page: BrowserPage) => boolean;
  activePage: () => BrowserPage | null;
  currentWindow: () => BrowserWindow | null;
  error: (message: string) => Error & { code: string };
  onPageClosed?: (page: BrowserPage) => void;
  onSessionClose?: (sessionId: string) => void;
  onAgentControlAction?: (page: BrowserPage, action: "takeover" | "handBack" | "stop") => void;
};

/**
 * Owns the page/tab registry: page creation, tab selection and connection
 * bookkeeping, locations, headless marks, and page state publication. The
 * presenter owns what is on screen; the host owns agent operations.
 */
export class BrowserPageRegistry {
  readonly pages = new Map<string, BrowserPage>();
  readonly locations = new Map<string, string>();
  readonly selectedTabs = new Map<string, string | null>();
  readonly connectedTabs = new Map<string, string | null>();
  readonly headlessTabs = new Set<string>();
  private readonly deps: BrowserPageRegistryDeps;

  constructor(deps: BrowserPageRegistryDeps) {
    this.deps = deps;
  }

  key(sessionId: string, tabId: string | null): string {
    return JSON.stringify([sessionId, tabId]);
  }

  contextFor(page: BrowserPage): { sessionId?: string; tabId?: string } {
    return {
      ...(page.sessionId ? { sessionId: page.sessionId } : {}),
      ...(page.tabId ? { tabId: page.tabId } : {}),
    };
  }

  pageFor(sessionId: string, tabId: string | null): BrowserPage {
    const key = this.key(sessionId, tabId);
    const existing = this.pages.get(key);
    if (existing) return existing;
    const page: BrowserPage = {
      key, sessionId, tabId, cdp: new BrowserCdp(), state: null,
      started: false, navigationVersion: 0, navigating: false,
      pane: this.deps.createPane(
        (state) => {
          if (this.pages.get(key) !== page) return;
          page.state = state;
          if (state.url && !page.navigating) this.locations.set(key, state.url);
          this.publishPage(page);
        },
        (url) => {
          if (this.pages.get(key) === page) this.deps.onOpenUrl?.(url, sessionId || undefined);
        },
        sessionId,
      ),
    };
    page.pane.onAgentControlAction = (action) => {
      const id = page.sessionId || undefined;
      // The host wires the actual control actions; this callback only needs
      // the page's identity, so the registry emits it through a small hook.
      this.deps.onAgentControlAction?.(page, action);
    };
    page.pane.setSessionId(page.sessionId);
    page.pane.setWindow(this.deps.currentWindow());
    const initial = controlSnapshot(page.sessionId || undefined);
    page.pane.setAgentControl(initial.state, initial.action);
    this.pages.set(key, page);
    return page;
  }

  stateFor(page: BrowserPage): BrowserState | null {
    return page.state ? { ...page.state, ...this.contextFor(page) } : null;
  }

  publishPage(page: BrowserPage): void {
    const state = this.stateFor(page);
    if (!state) return;
    this.deps.onState(state);
    if (this.deps.isActive(page)) this.deps.onPresentationState?.(state);
  }

  publishCurrent(): void {
    const active = this.deps.activePage();
    const state = (active ? this.stateFor(active) : null) ?? {
      url: "", title: "", isLoading: false, canGoBack: false, canGoForward: false,
      ...(active ? this.contextFor(active) : {}),
    };
    this.deps.onState(state);
    this.deps.onPresentationState?.(state);
  }

  listTabs(sessionId?: string): {
    tabs: Array<{ tabId: string; url: string; title: string; active: boolean }>;
    headlessTabs: Array<{ tabId: string; url: string; title: string }>;
    activeTabId: string | null;
  } {
    const id = (sessionId || "").trim();
    const tabs: Array<{ tabId: string; url: string; title: string; active: boolean }> = [];
    const headlessTabs: Array<{ tabId: string; url: string; title: string }> = [];
    const active = this.deps.activePage();
    for (const page of this.pages.values()) {
      if (page.sessionId !== id) continue;
      const entry = {
        tabId: page.tabId ?? "",
        url: page.state?.url ?? this.locations.get(page.key) ?? "",
        title: page.state?.title ?? "",
      };
      if (this.headlessTabs.has(page.key)) headlessTabs.push(entry);
      else tabs.push({ ...entry, active: active === page });
    }
    return { tabs, headlessTabs, activeTabId: active?.sessionId === id ? active.tabId ?? null : null };
  }

  getPages(sessionId: string): BrowserState[] {
    return [...this.pages.values()]
      .filter((page) => page.sessionId === sessionId && page.tabId !== null)
      .map((page) => this.stateFor(page) ?? {
        url: "", title: "", isLoading: page.navigating, canGoBack: false, canGoForward: false,
        ...this.contextFor(page),
      });
  }

  closeTab(sessionId: string, tabId: string | null): void {
    const key = this.key(sessionId, tabId);
    this.headlessTabs.delete(key);
    const page = this.pages.get(key);
    if (page) {
      this.pages.delete(key);
      page.navigationVersion += 1;
      page.detachDownloads?.();
      page.cdp.detach(page.pane.getWebContents() ?? undefined);
      page.pane.dispose();
      this.deps.onPageClosed?.(page);
    }
    this.locations.delete(key);
    if (this.selectedTabs.get(sessionId) === tabId) this.selectedTabs.delete(sessionId);
    if (this.connectedTabs.get(sessionId) === tabId) this.connectedTabs.delete(sessionId);
  }

  closeSession(sessionId: string): void {
    this.deps.onSessionClose?.(sessionId);
    for (const page of [...this.pages.values()]) {
      if (page.sessionId !== sessionId) continue;
      this.closeTab(sessionId, page.tabId);
    }
    this.selectedTabs.delete(sessionId);
    this.connectedTabs.delete(sessionId);
    for (const key of [...this.locations.keys()]) {
      if (JSON.parse(key)[0] === sessionId) this.locations.delete(key);
    }
  }

  disposePages(): void {
    for (const page of this.pages.values()) {
      page.navigationVersion += 1;
      page.detachDownloads?.();
      page.cdp.detach(page.pane.getWebContents() ?? undefined);
      page.pane.dispose();
    }
    this.pages.clear();
    this.locations.clear();
    this.selectedTabs.clear();
    this.connectedTabs.clear();
    this.headlessTabs.clear();
  }
}
