import type { BrowserWindow, WebContents } from "electron";
import type { BrowserSettings, BrowserState } from "@pi-desktop/shared";
import type { BrowserPane } from "./browser-view";
import { BrowserCdp } from "./browser-cdp";
import { controlSnapshot, handBack, onControlChange, stopTurn, takeOver } from "./browser-agent-control.ts";
import { BrowserPageRegistry, type BrowserDownloadRecord, type BrowserPage } from "./browser/page-registry.ts";
import { BrowserPanePresenter, type BrowserRevealWaiter, type ChromeSurface } from "./browser/presenter.ts";
import { writeFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { resolveDownloadPlan } from "./browser/download-target.ts";
import { randomUUID } from "node:crypto";

export type { BrowserDownloadRecord } from "./browser/page-registry.ts";

export const BROWSER_PLUGIN_ID = "pi.browser";
export const BROWSER_VIEW_ID = "browser";
const BROWSER_REVEAL_TIMEOUT_MS = 5_000;
const BROWSER_CDP_TIMEOUT_MS = 30_000;
const DEFAULT_BROWSER_TAB_ID = "plugin:pi.browser/browser";

export type BrowserRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserNavigateInput = {
  url?: string;
  path?: string;
};


function rootBoundary(root: string): string {
  return root.endsWith(sep) ? root : root + sep;
}

function isWithinRoot(path: string, root: string): boolean {
  try {
    const realRoot = realpathSync(resolve(root));
    const realPath = realpathSync(resolve(path));
    return realPath === realRoot || realPath.startsWith(rootBoundary(realRoot));
  } catch {
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(path);
    return resolvedPath === resolvedRoot || resolvedPath.startsWith(rootBoundary(resolvedRoot));
  }
}

function resolveExistingFile(candidate: string): string | null {
  try {
    const real = realpathSync(resolve(candidate));
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Translate a plugin-page hole into window coordinates and clamp it so the
 * guest cannot cover chat/composer outside the calling plugin view.
 */
export function clampGuestBounds(
  view: BrowserRect,
  hole: BrowserRect,
): BrowserRect | null {
  const x = Math.max(view.x, view.x + hole.x);
  const y = Math.max(view.y, view.y + hole.y);
  const right = Math.min(view.x + view.width, view.x + hole.x + hole.width);
  const bottom = Math.min(view.y + view.height, view.y + hole.y + hole.height);
  const width = Math.floor(right - x);
  const height = Math.floor(bottom - y);
  if (width < 1 || height < 1) return null;
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width,
    height,
  };
}

/**
 * Convert a chrome page's hole from its own CSS pixels to DIP.
 *
 * A docked view follows the app's Appearance type scale as page zoom
 * (`PluginViewHost`), so a rect the page measured at 125% covers 1.25 DIP per
 * pixel in the window. Without this the guest page would sit in a hole smaller
 * than the one the chrome actually draws from 100% type upward.
 */
export function scaleGuestHole(hole: BrowserRect, scale: unknown): BrowserRect {
  const factor = Number(scale);
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return hole;
  return {
    x: hole.x * factor,
    y: hole.y * factor,
    width: hole.width * factor,
    height: hole.height * factor,
  };
}

function asRect(value: unknown): BrowserRect | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return { x, y, width, height };
}

export type BrowserHostDeps = {
  createPane: (
    onState: (state: BrowserState) => void,
    onOpenUrl: (url: string) => void,
    sessionId: string,
  ) => BrowserPane;
  onOpenUrl?: (url: string, sessionId?: string) => void;
  isPluginLoaded: (pluginId: string) => boolean;
  getFileRoots: (sessionId?: string) => Promise<readonly string[]>;
  getScratchDir?: (sessionId?: string) => string | null;
  onState: (state: BrowserState) => void;
  onPresentationState?: (state: BrowserState) => void;
  onRevealView?: (sessionId: string, tabId?: string, location?: BrowserNavigateInput) => void;
  onSessionClose?: (sessionId: string) => void;
  /** Live browser preferences (downloads, link target) owned by app settings. */
  getBrowserSettings?: () => BrowserSettings | null;
  /** Called when a page starts publishing state, to attach session-level hooks. */
  onPageState?: (page: BrowserPage) => void;
};

export /**
 * Bound any CDP round trip on the guest. A page that opens a native dialog
 * or runs a busy loop never answers `debugger.sendCommand`, and neither the
 * CDP layer nor the RPC timeout table bounds it (#1611) — without this the
 * agent's browser tool call hangs forever. On timeout the whole debugger
 * session is detached as recovery, which also drops previously created
 * snapshot uids; the tool result explains the timeout so the agent can
 * re-snapshot.
 */
function withCdpDeadline<T>(
  page: BrowserPage,
  wc: WebContents,
  run: () => Promise<T>,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = Object.assign(
        new Error(`browser ${label} timed out after ${BROWSER_CDP_TIMEOUT_MS}ms`),
        { code: "TIMEOUT" },
      );
      reject(error);
      try {
        page.cdp.detach(wc);
      } catch {
        // Preserve the timeout result if the guest is already shutting down.
      }
    }, BROWSER_CDP_TIMEOUT_MS);
  });
  return Promise.race([Promise.resolve().then(run), timedOut])
    .finally(() => { if (timeout) clearTimeout(timeout); });
}

function captureScreenshotWithDeadline<T>(
  page: BrowserPage,
  capture: (wc: WebContents) => Promise<T>,
): Promise<T> {
  return page.pane.captureScreenshot((wc) =>
    withCdpDeadline(page, wc, () => capture(wc), "screenshot"),
  );
}

/** Orchestrates agent operations over the page registry and presenter. */
export class BrowserHost {
  private readonly deps: BrowserHostDeps;
  private readonly registry!: BrowserPageRegistry;
  private readonly presenter!: BrowserPanePresenter;
  private readonly stopControlSubscription: () => void;

  private get pages() { return this.registry.pages; }
  private get locations() { return this.registry.locations; }
  private get selectedTabs() { return this.registry.selectedTabs; }
  private get connectedTabs() { return this.registry.connectedTabs; }
  private get headlessTabs() { return this.registry.headlessTabs; }
  private get revealWaiters() { return this.presenter.revealWaiters; }
  private get active() { return this.presenter.active; }
  private set active(page: BrowserPage | null) { this.presenter.active = page; }
  private get window() { return this.presenter.window; }
  private set window(window: BrowserWindow | null) { this.presenter.window = window; }
  private get chrome() { return this.presenter.chrome; }
  private set chrome(surface: ChromeSurface | null) { this.presenter.chrome = surface; }
  private get hole() { return this.presenter.hole; }
  private set hole(hole: BrowserRect | null) { this.presenter.hole = hole; }
  private get holePluginId() { return this.presenter.holePluginId; }
  private set holePluginId(id: string | null) { this.presenter.holePluginId = id; }

  constructor(deps: BrowserHostDeps) {
    this.deps = deps;
    this.registry = new BrowserPageRegistry({
      createPane: deps.createPane,
      onOpenUrl: deps.onOpenUrl,
      onState: deps.onState,
      onPresentationState: deps.onPresentationState,
      isActive: (page) => this.presenter?.active === page,
      activePage: () => this.presenter?.active ?? null,
      currentWindow: () => this.presenter?.window ?? null,
      error: (message) => this.unavailableError(message),
      onPageClosed: (page) => {
        if (this.presenter?.active === page) this.presenter.active = null;
      },
      onPageState: (page) => this.deps.onPageState?.(page),
      onSessionClose: deps.onSessionClose,
      onAgentControlAction: (page, action) => {
        const id = page.sessionId || undefined;
        if (action === "takeover") takeOver(id);
        else if (action === "handBack") handBack(id);
        else stopTurn(id);
      },
    });
    this.presenter = new BrowserPanePresenter({
      pluginId: BROWSER_PLUGIN_ID,
      viewId: BROWSER_VIEW_ID,
      revealTimeoutMs: BROWSER_REVEAL_TIMEOUT_MS,
      isPluginLoaded: deps.isPluginLoaded,
      onRevealView: deps.onRevealView,
      error: (message) => this.unavailableError(message),
      pages: () => this.registry.pages.values(),
      selectedTab: (sessionId) => this.registry.selectedTabs.get(sessionId) ?? null,
      disposeGuest: () => this.disposeGuest(),
      guestBoundsFor: (surface, hole) =>
        surface?.visible && hole
          ? clampGuestBounds(surface.bounds, scaleGuestHole(hole, surface.scale))
          : null,
    });
    // The bar lives per page but the state machine is per session, so every
    // tab of that session follows the same takeover.
    this.stopControlSubscription = onControlChange((sessionId) => {
      const snapshot = controlSnapshot(sessionId);
      let matched = false;
      for (const page of this.pages.values()) {
        if ((page.sessionId || "default") === sessionId) {
          matched = true;
          page.pane.setAgentControl(snapshot.state, snapshot.action);
        }
      }
      // The plugin view itself reports bounds without a session, so the page
      // actually on screen can be keyed "default" while tools run under the
      // real session. The visible page still shows that session's bar.
      if (!matched && this.active) {
        this.active.pane.setAgentControl(snapshot.state, snapshot.action);
      }
    });
  }

  setWindow(window: BrowserWindow | null): void {
    this.presenter.setWindow(window);
  }

  setChromeSurface(surface: ChromeSurface | null): void {
    this.presenter.setChromeSurface(surface);
  }

  async reveal(sessionId?: string): Promise<void> {
    return this.presenter.reveal(sessionId);
  }

  getContext(): { sessionId?: string; tabId?: string } {
    return this.active ? this.contextFor(this.active) : {};
  }

  private contextFor(page: BrowserPage): { sessionId?: string; tabId?: string } {
    return {
      ...(page.sessionId ? { sessionId: page.sessionId } : {}),
      ...(page.tabId ? { tabId: page.tabId } : {}),
    };
  }

  private isBrowserVisibleForSession(sessionId: string): boolean {
    return this.presenter.isBrowserVisibleForSession(sessionId);
  }

  private resolveVisibleRevealWaiters(): void {
    this.presenter.resolveVisibleRevealWaiters();
  }

  private rejectRevealWaiter(waiter: BrowserRevealWaiter, error: Error): void {
    this.presenter.rejectRevealWaiter(waiter, error);
  }

  private unavailableError(message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code: "UNAVAILABLE" });
  }

  private assertBrowserViewVisible(): void {
    this.presenter.assertBrowserViewVisible();
  }

  private key(sessionId: string, tabId: string | null): string {
    return JSON.stringify([sessionId, tabId]);
  }

  private pageFor(sessionId: string, tabId: string | null): BrowserPage {
    return this.registry.pageFor(sessionId, tabId);
  }

  private publishPage(page: BrowserPage): void {
    this.registry.publishPage(page);
  }

  private publishCurrent(): void {
    this.registry.publishCurrent();
  }

  setChromeSession(sessionId: string | undefined, tabId?: string, location?: string): boolean {
    const id = sessionId?.trim() || "";
    const tab = tabId ?? (this.active?.sessionId === id
      ? this.active.tabId : this.selectedTabs.get(id) ?? null);
    const page = this.pageFor(id, tab);
    if (this.active === page) return false;
    this.active?.pane.setVisible(false);
    this.active = page;
    this.selectedTabs.set(id, tab);
    const target = this.locations.get(page.key) ?? location?.trim();
    const navigate = !page.started && !page.navigating;
    if (target && navigate) {
      page.started = false;
      page.state = null;
      this.publishCurrent();
      this.applyGuest();
      void this.navigatePage(page, target).catch((error) => {
        console.warn("Browser tab restore failed", error);
      });
    } else {
      this.publishCurrent();
      this.applyGuest();
    }
    return true;
  }

  setGuestHole(pluginId: string, hole: unknown): BrowserRect | null {
    return this.presenter.setGuestHole(pluginId, asRect(hole));
  }

  setGuestVisible(pluginId: string, visible: boolean): void {
    this.presenter.setGuestVisible(pluginId, visible);
  }

  /** A new preview has its own page even before the renderer mounts its tab. */
  async openTab(input: BrowserNavigateInput, sessionId: string): Promise<{ tabId: string; state: BrowserState | null }> {
    this.assertPluginAvailable();
    const id = sessionId.trim();
    if (!id) throw this.unavailableError("Browser navigation requires a session.");
    const tabId = `plugin:pi.browser/browser:${randomUUID()}`;
    const page = this.pageFor(id, tabId);
    this.selectedTabs.set(id, tabId);
    this.connectedTabs.set(id, tabId);
    const navigation = this.navigatePage(page, String(input.path ?? input.url ?? "").trim());
    this.deps.onRevealView?.(id, tabId, input);
    return { tabId, state: await navigation };
  }

  /** A tab the agent drives without taking the visible pane (headless-like). */
  async openBackgroundTab(
    input: BrowserNavigateInput,
    sessionId: string,
  ): Promise<{ tabId: string; state: BrowserState | null }> {
    this.assertPluginAvailable();
    const id = sessionId.trim();
    if (!id) throw this.unavailableError("Browser navigation requires a session.");
    const tabId = `plugin:pi.browser/browser:${randomUUID()}`;
    const page = this.pageFor(id, tabId);
    this.selectedTabs.set(id, tabId);
    this.connectedTabs.set(id, tabId);
    this.headlessTabs.add(page.key);
    const target = String(input.path ?? input.url ?? "").trim();
    const navigation = target ? this.navigatePage(page, target) : Promise.resolve(this.stateFor(page));
    return { tabId, state: await navigation };
  }

  async navigate(input: BrowserNavigateInput, sessionId?: string, tabId?: string): Promise<BrowserState | null> {
    this.assertPluginAvailable();
    const target = String(input.path ?? input.url ?? "").trim();
    let page: BrowserPage;
    if (sessionId !== undefined) {
      const id = sessionId.trim();
      if (!id) throw this.unavailableError("Browser navigation requires a session.");
      const selected = tabId ?? this.connectedTabs.get(id) ?? this.selectedTabs.get(id) ?? DEFAULT_BROWSER_TAB_ID;
      const key = this.key(id, selected);
      const existing = this.pages.get(key);
      if (tabId !== undefined && !existing) throw this.unavailableError("The Browser tab is closed.");
      page = existing ?? this.pageFor(id, selected);
      if (tabId === undefined) this.connectedTabs.set(id, selected);
      if (!existing) this.selectedTabs.set(id, selected);
      const navigation = target ? this.navigatePage(page, target) : Promise.resolve(this.stateFor(page));
      if (!existing) this.deps.onRevealView?.(id, selected);
      return navigation;
    }
    page = this.operationPage();
    return target ? this.navigatePage(page, target) : this.stateFor(page);
  }

  private async navigatePage(page: BrowserPage, target: string): Promise<BrowserState | null> {
    const version = ++page.navigationVersion;
    page.navigating = true;
    this.locations.set(page.key, target);
    const current = () => this.pages.get(page.key) === page && page.navigationVersion === version;
    let roots: readonly string[];
    try {
      roots = await this.getFileRoots(page.sessionId || undefined);
    } catch (error) {
      if (!current()) return null;
      page.navigating = false;
      page.started = false;
      page.state = { url: target, title: "", isLoading: false, canGoBack: false,
        canGoForward: false, loadError: error instanceof Error ? error.message : String(error) };
      this.publishPage(page);
      if (this.active === page) this.applyGuest();
      return null;
    }
    if (!current()) return null;
    let state: BrowserState | null;
    try {
      state = await page.pane.navigateAndWait(target, roots[0] ?? null);
    } catch (error) {
      if (!current()) return null;
      page.navigating = false;
      page.started = false;
      page.state = { url: target, title: "", isLoading: false, canGoBack: false,
        canGoForward: false, loadError: error instanceof Error ? error.message : String(error) };
      this.publishPage(page);
      if (this.active === page) this.applyGuest();
      return null;
    }
    if (!current()) return null;
    page.navigating = false;
    page.started = state !== null;
    page.state = state ?? page.pane.getState();
    this.locations.set(page.key, state?.url || target);
    if (!state && !page.state?.loadError) {
      page.state = { url: target, title: "", isLoading: false,
        canGoBack: false, canGoForward: false, loadError: "INVALID_URL" };
    }
    this.publishPage(page);
    if (this.active === page) this.applyGuest();
    return state ? { ...state, ...this.contextFor(page) } : null;
  }

  private assertPluginAvailable(): void {
    if (!this.deps.isPluginLoaded(BROWSER_PLUGIN_ID)) {
      throw this.unavailableError("The Browser plugin is unavailable.");
    }
  }

  /** Trusted tool session identity never falls back to the visible page. */
  private operationPage(sessionId?: string, tabId?: string): BrowserPage {
    this.assertPluginAvailable();
    if (sessionId !== undefined) {
      const id = sessionId.trim();
      const tab = tabId ?? this.connectedTabs.get(id) ?? this.selectedTabs.get(id);
      const page = id && tab !== undefined ? this.pages.get(this.key(id, tab)) : undefined;
      if (!page) throw this.unavailableError("No Browser page is connected to this session. Navigate or open a preview first.");
      if (tabId === undefined) this.connectedTabs.set(id, page.tabId);
      return page;
    }
    // Unscoped plugin/UI calls retain their existing visible-page boundary.
    this.assertBrowserViewVisible();
    if (!this.active) throw this.unavailableError("browser guest is not available");
    return this.active;
  }

  private stateFor(page: BrowserPage): BrowserState | null {
    return page.state ? { ...page.state, ...this.contextFor(page) } : null;
  }

  action(action: "back" | "forward" | "reload" | "stop", sessionId?: string, tabId?: string): void {
    const page = this.operationPage(sessionId, tabId);
    if (page.state) page.pane.action(action);
  }

  async history(sessionId?: string, tabId?: string): Promise<{ index: number; entries: Array<{ index: number; url: string; title: string }> }> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    const history = wc.navigationHistory;
    const entries = history.getAllEntries().map((entry, index) => ({ index, url: entry.url, title: entry.title }));
    return { index: history.getActiveIndex(), entries };
  }

  getState(): BrowserState | null {
    return this.active ? this.stateFor(this.active) : null;
  }

  getStateForPlugin(sessionId?: string, tabId?: string): BrowserState | null {
    return this.stateFor(this.operationPage(sessionId, tabId));
  }

  /** Rehydrate side-panel tabs after a renderer reload; DOM stays in Main. */
  getPages(sessionId: string): BrowserState[] {
    return this.registry.getPages(sessionId);
  }

  openExternal(sessionId?: string, tabId?: string): void {
    const page = this.operationPage(sessionId, tabId);
    if (page.started) page.pane.openExternal();
  }

  private currentPage(sessionId?: string, tabId?: string): BrowserPage {
    const page = this.operationPage(sessionId, tabId);
    if (!page.started) throw this.unavailableError("browser guest is not available");
    return page;
  }

  private requireWebContents(page: BrowserPage): WebContents {
    const wc = page.pane.getWebContents();
    if (!wc || wc.isDestroyed()) throw this.unavailableError("browser guest is not available");
    this.trackDownloads(page, wc);
    return wc;
  }

  async snapshot(sessionId?: string, tabId?: string): Promise<{ tree: string; url: string; title: string }> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    return withCdpDeadline(page, wc, () => page.cdp.snapshot(wc), "snapshot");
  }

  async screenshot(input: { fullPage?: boolean; format?: "jpeg" | "png"; clip?: { x: number; y: number; width: number; height: number } } = {}, sessionId?: string, tabId?: string): Promise<{ mimeType: string; data: string; path?: string; width?: number; height?: number; resized?: boolean }> {
    const page = this.currentPage(sessionId, tabId);
    // Viewport captures stay on the trusted path: capturePage never attaches
    // the debugger, which is what Cursor/qiwork avoid on risk-sensitive sites.
    const shot = input.fullPage || input.clip
      ? await captureScreenshotWithDeadline(page, (wc) => page.cdp.screenshot(wc, input)).finally(() => {
          // Full-page capture is the only routine CDP use; drop the debugger
          // as soon as it finishes. The guest may have been closed while the
          // capture was in flight — the capture result still stands.
          try {
            page.cdp.detach(this.requireWebContents(page));
          } catch {
            // guest closed or replaced during capture
          }
        })
      : await capturePageImage(this.requireWebContents(page), input.format === "png" ? "png" : "jpeg");
    const scratch = this.deps.getScratchDir?.(sessionId ?? page.sessionId);
    let path: string | undefined;
    if (scratch) {
      try {
        mkdirSync(scratch, { recursive: true });
        path = join(scratch, `browser-screenshot-${Date.now()}.jpg`);
        writeFileSync(path, Buffer.from(shot.data, "base64"));
      } catch {
        path = undefined;
      }
    }
    // View-service cache (Cursor's updateScreenshot): the latest capture is
    // reusable by coordinate clicks and any later tool without re-capturing.
    page.lastScreenshot = {
      url: page.state?.url ?? this.locations.get(page.key) ?? "",
      imageWidth: Number(shot.width) || 0,
      imageHeight: Number(shot.height) || 0,
      ...(path ? { path } : {}),
      at: Date.now(),
    };
    return path ? { ...shot, path } : shot;
  }

  screenshotState(sessionId?: string, tabId?: string): BrowserPage["lastScreenshot"] | null {
    try {
      return this.operationPage(sessionId, tabId).lastScreenshot ?? null;
    } catch {
      return null;
    }
  }

  async click(uid: string, sessionId?: string, tabId?: string): Promise<void> {
    const page = this.currentPage(sessionId, tabId);
    return page.pane.withStableViewport((wc) =>
      withCdpDeadline(page, wc, () => page.cdp.click(wc, uid), "click"),
    );
  }
  async fill(uid: string, text: string, sessionId?: string, tabId?: string): Promise<void> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    return withCdpDeadline(page, wc, () => page.cdp.fill(wc, uid, text), "fill");
  }
  async evaluate(expression: string, sessionId?: string, tabId?: string): Promise<unknown> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    return withCdpDeadline(page, wc, () => page.cdp.evaluate(wc, expression), "evaluate");
  }
  /**
   * Evaluate without attaching the CDP debugger. Automation that must not look
   * "driven" uses this path; nothing about it is visible to the page.
   */
  async evaluateNative(expression: string, sessionId?: string, tabId?: string): Promise<unknown> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    return await wc.executeJavaScript(expression, true);
  }

  /**
   * Same page, isolated JS world: the page cannot see ref maps or helper
   * objects, which keeps automation bookkeeping off its detection surface.
   */
  async evaluateIsolated(expression: string, sessionId?: string, tabId?: string): Promise<unknown> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    return await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: expression }], true);
  }

  /** Set files on a file input after validating every path against the session roots. */
  async crossOriginFrame(
    input: {
      action: "list" | "text" | "html" | "click" | "fill" | "count";
      frameId?: string;
      url?: string;
      targetSelector?: string;
      value?: string;
      limit?: number;
    },
    sessionId?: string,
    tabId?: string,
  ): Promise<unknown> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    return withCdpDeadline(page, wc, () => page.cdp.crossOriginFrame(wc, input), "cross-origin frame");
  }

  async waitForFileChooser(
    sessionId?: string,
    tabId?: string,
    timeoutMs = 15_000,
  ): Promise<{ backendNodeId: number; mode: string }> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    return withCdpDeadline(
      page,
      wc,
      () => page.cdp.waitForFileChooser(wc, timeoutMs),
      "file chooser",
    );
  }

  async cancelFileChooser(sessionId?: string, tabId?: string): Promise<void> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    await withCdpDeadline(page, wc, () => page.cdp.cancelFileChooser(wc), "file chooser cancel");
  }

  async setFileChooserFiles(
    files: string[],
    sessionId?: string,
    tabId?: string,
  ): Promise<{ ok: true; files: string[] }> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    const normalized = await this.authorizeUploadFiles(files, sessionId ?? page.sessionId);
    await withCdpDeadline(
      page,
      wc,
      () => page.cdp.setFileChooserFiles(wc, normalized),
      "file chooser upload",
    );
    return { ok: true, files: normalized };
  }

  async authorizeUploadFiles(files: string[], sessionId?: string): Promise<string[]> {
    const roots = await this.getFileRoots(sessionId);
    const normalized = files.map((file) => String(file).trim()).filter(Boolean);
    if (!normalized.length) {
      throw Object.assign(new Error("At least one file is required."), { code: "INVALID_ARGUMENT" });
    }
    for (const file of normalized) {
      const absolute = resolveExistingFile(file);
      if (!absolute || !roots.some((root) => isWithinRoot(absolute, root))) {
        throw Object.assign(new Error(`File is outside the session workspace: ${file}`), { code: "PERMISSION_DENIED" });
      }
    }
    return normalized;
  }

  async uploadFiles(
    selector: string,
    files: string[],
    sessionId?: string,
    tabId?: string,
  ): Promise<{ ok: true; files: string[] }> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    const normalized = await this.authorizeUploadFiles(files, sessionId ?? page.sessionId);
    await withCdpDeadline(page, wc, () => page.cdp.setFiles(wc, selector, normalized), "file upload");
    return { ok: true, files: normalized };
  }

  /** Fetch one http(s) resource into this session's scratch directory. */
  async downloadUrl(
    url: string,
    filename: string | undefined,
    sessionId?: string,
    tabId?: string,
  ): Promise<{ ok: true; path: string; bytes: number; contentType: string | null }> {
    const page = this.currentPage(sessionId, tabId);
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) {
      throw Object.assign(new Error("Only http(s) URLs can be downloaded."), { code: "INVALID_ARGUMENT" });
    }
    const scratch = this.deps.getScratchDir?.(sessionId ?? page.sessionId);
    if (!scratch) throw Object.assign(new Error("session scratch directory unavailable"), { code: "UNAVAILABLE" });
    const MAX_BYTES = 64 * 1024 * 1024;
    const wc = this.requireWebContents(page);
    const response = await wc.session.fetch(target);
    if (!response.ok) {
      throw Object.assign(new Error(`download failed: HTTP ${response.status}`), { code: "TOOL_FAILED" });
    }
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_BYTES) {
      throw Object.assign(new Error(`download exceeds ${MAX_BYTES} bytes`), { code: "TOOL_FAILED" });
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw Object.assign(new Error(`download exceeds ${MAX_BYTES} bytes`), { code: "TOOL_FAILED" });
        }
        chunks.push(Buffer.from(value));
      }
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.byteLength > MAX_BYTES) {
      throw Object.assign(new Error(`download exceeds ${MAX_BYTES} bytes`), { code: "TOOL_FAILED" });
    }
    mkdirSync(scratch, { recursive: true });
    const requested = filename ? basename(String(filename)) : basename(new URL(target).pathname) || "download";
    const safe = requested.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "download";
    const path = join(scratch, safe.startsWith(".") ? `download${safe}` : safe);
    writeFileSync(path, buffer);
    const download: BrowserDownloadRecord = {
      id: randomUUID(),
      url: target,
      filename: safe,
      path,
      state: "completed",
      receivedBytes: buffer.byteLength,
      totalBytes: buffer.byteLength,
    };
    page.downloads = [...(page.downloads ?? []), download].slice(-50);
    return { ok: true, path, bytes: buffer.byteLength, contentType: response.headers.get("content-type") };
  }

  /**
   * Trusted native input: dispatched by the web contents itself, so it never
   * attaches the debugger and the page sees a normal input event.
   */
  sendInputEvent(event: unknown, sessionId?: string, tabId?: string): { ok: true } {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    wc.sendInputEvent(event as Parameters<WebContents["sendInputEvent"]>[0]);
    return { ok: true };
  }

  consoleLogs(input: { limit?: number } = {}, sessionId?: string, tabId?: string) {
    const page = this.currentPage(sessionId, tabId);
    return { ok: true as const, entries: page.pane.readConsole(Number(input.limit) || 100) };
  }

  networkRequests(input: { limit?: number } = {}, sessionId?: string, tabId?: string) {
    const page = this.currentPage(sessionId, tabId);
    return { ok: true as const, entries: page.pane.readNetwork(Number(input.limit) || 100) };
  }

  async waitForNetworkIdle(
    input: { timeoutMs?: number; idleMs?: number } = {},
    sessionId?: string,
    tabId?: string,
  ): Promise<{ ok: true }> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    await page.cdp.waitForNetworkIdle(wc, input.timeoutMs, input.idleMs);
    return { ok: true };
  }

  /** Answer the JavaScript dialog currently blocking the page, if any. */
  async handleDialog(
    input: { accept?: boolean; promptText?: string },
    sessionId?: string,
    tabId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    try {
      await page.cdp.send(wc, "Page.handleJavaScriptDialog", {
        accept: input.accept !== false,
        ...(typeof input.promptText === "string" ? { promptText: input.promptText } : {}),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  insertText(text: string, sessionId?: string, tabId?: string): { ok: true } {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    wc.insertText(String(text ?? ""));
    return { ok: true };
  }
  console(limit?: number, sessionId?: string, tabId?: string): { messages: ReturnType<BrowserCdp["console"]> } {
    const page = this.operationPage(sessionId, tabId);
    if (!page.started) return { messages: [] };
    const wc = this.requireWebContents(page);
    void page.cdp.attach(wc);
    return { messages: page.cdp.console(limit) };
  }
  listTabs(sessionId?: string): {
    tabs: Array<{ tabId: string; url: string; title: string; active: boolean }>;
    headlessTabs: Array<{ tabId: string; url: string; title: string }>;
    activeTabId: string | null;
  } {
    return this.registry.listTabs(sessionId);
  }

  selectTab(sessionId: string, tabId: string): unknown {
    const id = sessionId.trim();
    if (!id) throw this.unavailableError("Browser tab selection requires a session.");
    const page = this.pages.get(this.key(id, tabId));
    if (!page) throw this.unavailableError("The Browser tab is closed.");
    this.connectedTabs.set(id, tabId);
    this.selectedTabs.set(id, tabId);
    // A headless page is selected for tooling only: it never enters the
    // visible pane and keeps its headless mark.
    if (this.headlessTabs.has(page.key)) return this.stateFor(page);
    this.setChromeSession(id, tabId);
    this.deps.onRevealView?.(id, tabId);
    this.applyGuest();
    return this.stateFor(page);
  }

  /** Reveal a background (headless) tab: it joins the visible pane from now on. */
  showTab(sessionId: string, tabId: string): unknown {
    const id = sessionId.trim();
    if (!id) throw this.unavailableError("Browser tab selection requires a session.");
    const page = this.pages.get(this.key(id, tabId));
    if (!page) throw this.unavailableError("The Browser tab is closed.");
    this.headlessTabs.delete(page.key);
    return this.selectTab(id, tabId);
  }

  async cdpCommand(method: string, params?: unknown, sessionId?: string, tabId?: string): Promise<unknown> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    if (method === "Page.captureScreenshot") {
      return captureScreenshotWithDeadline(page, (view) => page.cdp.send(view, method, params));
    }
    const result = await withCdpDeadline(page, wc, () => page.cdp.send(wc, method, params), `cdp ${method}`)
      .finally(() => page.cdp.detach(wc));
    // Cursor saves CDP responses above 25k characters to a file instead of
    // inlining them; keep the same budget for the agent-facing tool.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(result ?? null);
    } catch {
      serialized = undefined;
    }
    if (serialized && serialized.length > 25_000) {
      const scratch = this.deps.getScratchDir?.(sessionId ?? page.sessionId);
      if (scratch) {
        try {
          mkdirSync(scratch, { recursive: true });
          const path = join(scratch, `browser-cdp-${Date.now()}.json`);
          writeFileSync(path, serialized, "utf8");
          return {
            savedTo: path,
            sizeBytes: Buffer.byteLength(serialized),
            preview: serialized.slice(0, 2_000),
          };
        } catch {
          // Fall through to inline truncation in the plugin.
        }
      }
    }
    return result;
  }

  async inputCommand(method: string, params?: unknown, sessionId?: string, tabId?: string): Promise<unknown> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    return withCdpDeadline(page, wc, () => page.cdp.sendInput(wc, method, params), `input ${method}`);
  }

  /** Resolve containment roots from the owning session, not the visible UI. */
  getScratchDir(sessionId?: string): string | null {
    return this.deps.getScratchDir?.(sessionId) ?? null;
  }

  getFileRoots(sessionId?: string): Promise<readonly string[]> {
    return this.deps.getFileRoots(sessionId);
  }

  async previewFile(): Promise<{ ok: true } | { ok: false; content: string }> {
    if (!this.deps.isPluginLoaded(BROWSER_PLUGIN_ID)) return {
      ok: false, content: "BrowserPreview: the Browser plugin is disabled. Enable pi.browser in Plugins to preview HTML.",
    };
    return { ok: true };
  }

  trackDownloadsForPage(page: BrowserPage, wc: WebContents): void {
    this.trackDownloads(page, wc);
  }

  private trackDownloads(page: BrowserPage, wc: WebContents): void {
    if (page.detachDownloads && page.downloadContentsId === wc.id) return;
    page.detachDownloads?.();
    const ses = wc.session;
    if (!ses?.on) return;
    const handler = (_event: Electron.Event, item: Electron.DownloadItem, contents: WebContents) => {
      if (contents.id !== wc.id) return;
      const scratch = this.deps.getScratchDir?.(page.sessionId);
      const filename = basename(item.getFilename()).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "download";
      const settings = this.deps.getBrowserSettings?.() ?? null;
      const plan = resolveDownloadPlan({ filename, scratch, settings });
      let path = plan.mode === "save" ? plan.path : "";
      if (plan.mode === "default") {
        // Keep Electron's default download behavior; tracking still records it.
      } else if (plan.mode === "prompt") {
        item.setSaveDialogOptions({ defaultPath: plan.defaultPath });
      } else {
        mkdirSync(dirname(plan.path), { recursive: true });
        item.setSavePath(plan.path);
      }
      const record: BrowserDownloadRecord = {
        id: randomUUID(),
        url: item.getURL(),
        filename,
        path,
        state: "started",
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
      };
      page.downloads = [...(page.downloads ?? []), record].slice(-50);
      page.downloadItems ??= new Map();
      page.downloadItems.set(record.id, item);
      const resolveDone = () => {
        const waiters = page.downloadWaiters?.splice(0) ?? [];
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          if (record.state === "completed") waiter.resolve(record);
          else waiter.reject(Object.assign(new Error(record.error || `download ${record.state}`), { code: "TOOL_FAILED" }));
        }
      };
      item.on("updated", (_event, state) => {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        record.state = state === "interrupted" ? "interrupted" : "started";
      });
      item.once("done", (_event, state) => {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        const savedPath = item.getSavePath();
        if (savedPath) record.path = savedPath;
        record.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
        if (record.state !== "completed") record.error = "download failed";
        page.downloadItems?.delete(record.id);
        resolveDone();
      });
    };
    ses.on("will-download", handler);
    page.downloadContentsId = wc.id;
    page.detachDownloads = () => ses.off("will-download", handler);
  }

  async waitForDownload(
    sessionId?: string,
    tabId?: string,
    timeoutMs = 30_000,
  ): Promise<BrowserDownloadRecord> {
    const page = this.currentPage(sessionId, tabId);
    const wc = this.requireWebContents(page);
    this.trackDownloads(page, wc);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        page.downloadWaiters = page.downloadWaiters?.filter((item) => item.timer !== timer);
        reject(Object.assign(new Error("download did not start in time"), { code: "TIMEOUT" }));
      }, Math.max(1, timeoutMs));
      page.downloadWaiters = [...(page.downloadWaiters ?? []), { resolve, reject, timer }];
    });
  }

  async clickAndWaitForDownload(
    ref: string,
    timeoutMs = 30_000,
    sessionId?: string,
    tabId?: string,
  ): Promise<BrowserDownloadRecord> {
    const wait = this.waitForDownload(sessionId, tabId, timeoutMs);
    try {
      await this.click(ref, sessionId, tabId);
    } catch (error) {
      wait.catch(() => undefined);
      throw error;
    }
    return wait;
  }

  cancelDownload(id: string, sessionId?: string, tabId?: string): boolean {
    const sessionKey = String(sessionId ?? "");
    const pages = tabId
      ? [this.operationPage(sessionId, tabId)]
      : [...this.pages.values()].filter((page) => !sessionKey || page.sessionId === sessionKey);
    for (const page of pages) {
      const item = page.downloadItems?.get(String(id));
      if (!item) continue;
      item.cancel();
      return true;
    }
    return false;
  }

  listDownloads(sessionId?: string): BrowserDownloadRecord[] {
    const id = String(sessionId ?? "");
    const records = [...this.pages.values()]
      .filter((page) => !id || page.sessionId === id)
      .flatMap((page) => page.downloads ?? []);
    const seen = new Set<string>();
    const result = records.filter((record) => {
      if (seen.has(record.id)) return false;
      seen.add(record.id);
      return true;
    });
    return result;
  }

  closeTab(sessionId: string, tabId: string | null): void {
    this.registry.closeTab(sessionId, tabId);
  }

  closeSession(sessionId: string): void {
    this.registry.closeSession(sessionId);
  }

  dispose(): void {
    this.stopControlSubscription();
    this.disposeGuest();
  }

  /** Presentation is renderer-owned; page lifetime is not. */
  detachPresentation(): void {
    this.presenter.detachPresentation();
  }

  disposeGuest(): void {
    for (const waiter of [...this.presenter.revealWaiters]) {
      this.presenter.rejectRevealWaiter(
        waiter,
        this.unavailableError("Browser view was closed before it became visible."),
      );
    }
    this.registry.disposePages();
    this.presenter.detachPresentation();
  }

  private guestBounds(): BrowserRect | null {
    return this.presenter.guestBounds();
  }

  private applyGuest(): void {
    this.presenter.applyGuest();
  }
}

/** JPEG with the same ≈20 KB budget as the CDP path. */
async function capturePageImage(wc: WebContents, format: "jpeg" | "png" = "jpeg"): Promise<{
  mimeType: string;
  data: string;
  width: number;
  height: number;
  resized: boolean;
}> {
  return wc.capturePage().then((picked) => {
    const maxChars = format === "png" ? 200_000 : 20_000;
    let image = picked;
    let data = (format === "png" ? image.toPNG() : image.toJPEG(70)).toString("base64");
    let resized = false;
    for (let attempt = 0; attempt < 8 && data.length > maxChars; attempt += 1) {
      const size = image.getSize();
      image = image.resize({
        width: Math.max(1, Math.round(size.width * 0.8)),
        height: Math.max(1, Math.round(size.height * 0.8)),
        quality: "good",
      });
      data = (format === "png" ? image.toPNG() : image.toJPEG(65)).toString("base64");
      resized = true;
    }
    const size = image.getSize();
    return {
      mimeType: format === "png" ? "image/png" : "image/jpeg",
      data,
      width: size.width,
      height: size.height,
      resized,
    };
  });
}
