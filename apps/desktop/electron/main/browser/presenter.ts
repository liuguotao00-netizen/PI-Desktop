import type { BrowserWindow } from "electron";
import type { BrowserPage } from "./page-registry.ts";
import type { BrowserNavigateInput, BrowserRect } from "../browser-host";

export type ChromeSurface = {
  pluginId: string;
  viewId: string;
  visible: boolean;
  bounds: BrowserRect;
  /**
   * Page zoom the chrome page is painting at. The page measures its guest hole
   * in its own CSS pixels, so once the host scales that page with the app's
   * type scale one chrome CSS pixel covers `scale` DIP (see `scaleGuestHole`).
   */
  scale?: number;
};

export type BrowserRevealWaiter = {
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type BrowserPanePresenterDeps = {
  pluginId: string;
  viewId: string;
  revealTimeoutMs: number;
  isPluginLoaded: (pluginId: string) => boolean;
  onRevealView?: (sessionId: string, tabId?: string, location?: BrowserNavigateInput) => void;
  error: (message: string) => Error & { code: string };
  pages: () => Iterable<BrowserPage>;
  selectedTab: (sessionId: string) => string | null | undefined;
  /** Called with a null window so the host can release every guest page. */
  disposeGuest: () => void;
  guestBoundsFor: (surface: ChromeSurface | null, hole: BrowserRect | null) => BrowserRect | null;
};

/**
 * Owns what the user sees: the active page, the native window/chrome surface,
 * the guest hole, and reveal waiters. Page lifetime and agent operations stay
 * with the page registry and the host.
 */
export class BrowserPanePresenter {
  active: BrowserPage | null = null;
  window: BrowserWindow | null = null;
  chrome: ChromeSurface | null = null;
  hole: BrowserRect | null = null;
  holePluginId: string | null = null;
  readonly revealWaiters = new Set<BrowserRevealWaiter>();
  private readonly deps: BrowserPanePresenterDeps;

  constructor(deps: BrowserPanePresenterDeps) {
    this.deps = deps;
  }

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
    if (!window) {
      this.deps.disposeGuest();
      return;
    }
    for (const page of this.deps.pages()) page.pane.setWindow(window);
    this.applyGuest();
  }

  setChromeSurface(surface: ChromeSurface | null): void {
    this.chrome = surface;
    this.applyGuest();
    this.resolveVisibleRevealWaiters();
  }

  async reveal(sessionId?: string): Promise<void> {
    const id = sessionId?.trim();
    if (!id) throw this.deps.error("Browser reveal requires an active session.");
    if (!this.deps.isPluginLoaded(this.deps.pluginId)) {
      throw this.deps.error("The Browser plugin is unavailable.");
    }
    if (this.isBrowserVisibleForSession(id)) return;
    const revealView = this.deps.onRevealView;
    if (!revealView) throw this.deps.error("Browser view cannot be opened by this host.");

    let waiter: BrowserRevealWaiter | undefined;
    const visible = new Promise<void>((resolve, reject) => {
      const entry: BrowserRevealWaiter = {
        sessionId: id,
        resolve,
        reject: (error) => reject(error),
        timeout: setTimeout(() => {
          this.rejectRevealWaiter(
            entry,
            this.deps.error(
              "Browser view did not become visible for the calling session. Switch to that session and retry.",
            ),
          );
        }, this.deps.revealTimeoutMs),
      };
      waiter = entry;
      this.revealWaiters.add(entry);
    });

    try {
      const tabId = this.active?.sessionId === id
        ? this.active.tabId ?? undefined
        : this.deps.selectedTab(id) ?? undefined;
      revealView(id, tabId);
    } catch (error) {
      if (waiter) {
        this.rejectRevealWaiter(
          waiter,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return visible;
  }

  isBrowserVisibleForSession(sessionId: string): boolean {
    return this.chrome?.visible === true &&
      this.chrome.pluginId === this.deps.pluginId &&
      this.chrome.viewId === this.deps.viewId &&
      this.active?.sessionId === sessionId;
  }

  assertBrowserViewVisible(): void {
    if (
      this.chrome?.visible === true &&
      this.chrome.pluginId === this.deps.pluginId &&
      this.chrome.viewId === this.deps.viewId
    ) return;
    throw this.deps.error("Browser view must be visible before browser operations can run");
  }

  setGuestHole(pluginId: string, hole: BrowserRect | null): BrowserRect | null {
    this.hole = hole;
    this.holePluginId = pluginId;
    this.applyGuest();
    return this.guestBounds();
  }

  setGuestVisible(pluginId: string, visible: boolean): void {
    if (!visible && this.holePluginId === pluginId) {
      this.active?.pane.setVisible(false);
    } else if (visible) {
      this.applyGuest();
    }
  }

  guestBounds(): BrowserRect | null {
    return this.deps.guestBoundsFor(this.chrome, this.holePluginId === this.chrome?.pluginId ? this.hole : null);
  }

  applyGuest(): void {
    if (!this.active) return;
    const bounds = this.guestBounds();
    if (!bounds || !this.active.started) { this.active.pane.setVisible(false); return; }
    this.active.pane.setBounds(bounds);
    this.active.pane.setVisible(true);
  }

  resolveVisibleRevealWaiters(): void {
    for (const waiter of [...this.revealWaiters]) {
      if (!this.isBrowserVisibleForSession(waiter.sessionId)) continue;
      this.revealWaiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }

  rejectRevealWaiter(waiter: BrowserRevealWaiter, error: Error): void {
    if (!this.revealWaiters.delete(waiter)) return;
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }

  /** Presentation is renderer-owned; page lifetime is not. */
  detachPresentation(): void {
    for (const page of this.deps.pages()) page.pane.setVisible(false);
    this.active = null;
    this.chrome = null;
    this.hole = null;
    this.holePluginId = null;
  }
}
