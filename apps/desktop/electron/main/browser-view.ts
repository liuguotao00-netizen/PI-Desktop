import { dialog, session, shell, View, WebContentsView, type BrowserWindow, type WebContents } from "electron";
import { realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserState } from "@pi-desktop/shared";
import { isAllowedHttpUrl, parseAllowedExternalUrl } from "./safe-open-external";
import { applyChromeIdentity } from "./browser-chrome-identity.ts";
import { BrowserBackingHost } from "./browser-backing-host";
import { partitionForSession } from "./browser/partition.ts";
import { installHttpAuthPrompt } from "./browser/http-auth.ts";
import { AGENT_CONTROL_BAR_URL } from "./browser-agent-bar.ts";
import { AGENT_GLOW_OFF, agentGlowOn } from "./browser-agent-glow.ts";

/**
 * Work panel embedded preview browser (D100, ADR 0019).
 *
 * A single WebContentsView owned by the main process, clipped by a native
 * presentation View positioned from renderer-measured bounds. The renderer is the
 * visibility authority: it hides the view whenever the browser tab is not
 * the active panel surface or a blocking overlay opens (the view always
 * composites above renderer content).
 *
 * Besides http(s) URLs, the pane renders existing local HTML files with live
 * reload: the loaded file's directory is watched so edits to the page or its
 * sibling assets refresh the preview.
 */

const PARTITION = "persist:work-browser";
const LIVE_RELOAD_DEBOUNCE_MS = 250;
let httpAuthInstalled = false;
const permissionDecisions = new Map<string, boolean>();
let authParentWindow: BrowserWindow | null = null;

const PROMPT_PERMISSIONS = new Set([
  "media",
  "geolocation",
  "notifications",
  "clipboard-read",
  "midi",
  "midiSysex",
  "idle-detection",
  "background-sync",
  "serial",
  "usb",
  "hid",
  "bluetooth",
]);

export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  // A dotted hostname or localhost followed by a numeric port is an HTTP
  // address, not a custom scheme. Keep other schemes subject to the allowlist.
  const hasHostPort =
    /^(?:localhost|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z0-9-]+):\d+(?:[/?#]|$)/i.test(trimmed);
  const withScheme = hasScheme && !hasHostPort
    ? trimmed
    : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

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

function fileUrlToLocalPath(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return null;
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/**
 * Resolve a BrowserPreview input to a previewable file inside the workspace.
 * It accepts a file:// URL, absolute path, or workspace-relative path. This
 * stays workspace-scoped for the Agent BrowserPreview tool and sidecar.
 */
export function resolveLocalFile(raw: string, root: string | null): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !root) return null;
  let candidate: string | null = null;
  if (/^file:/i.test(trimmed)) {
    try {
      candidate = fileURLToPath(trimmed);
    } catch {
      return null;
    }
  } else if (isAbsolute(trimmed)) {
    candidate = trimmed;
  } else if (/^\.{1,2}\//.test(trimmed) || /\.[a-zA-Z0-9]+$/.test(trimmed)) {
    candidate = resolve(root, trimmed);
  }
  if (!candidate) return null;
  if (!isWithinRoot(candidate, root)) return null;
  const real = resolveExistingFile(candidate);
  return real && isWithinRoot(real, root) ? real : null;
}

/**
 * Resolve a file requested by the embedded browser. Explicit file URLs and
 * absolute paths may target any existing local file; relative inputs remain
 * rooted in the current workspace. BrowserPreview uses resolveLocalFile.
 */
function resolveBrowserLocalFile(raw: string, root: string | null): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^file:/i.test(trimmed)) {
    const candidate = fileUrlToLocalPath(trimmed);
    return candidate ? resolveExistingFile(candidate) : null;
  }
  if (isAbsolute(trimmed)) return resolveExistingFile(trimmed);
  return resolveLocalFile(trimmed, root);
}

type ConsoleEntry = { type: string; message: string; timestamp: number; source?: string };
type NetworkEntry = { method: string; url: string; status: number; resourceType?: string; timestamp: number };

const NETWORK_LIMIT = 200;
const networkTracked = new WeakSet<Electron.Session>();
const networkBySession = new WeakMap<Electron.Session, Map<number, NetworkEntry[]>>();

function trackNetwork(ses: Electron.Session): void {
  if (networkTracked.has(ses)) return;
  networkTracked.add(ses);
  const byContents = new Map<number, NetworkEntry[]>();
  networkBySession.set(ses, byContents);
  const push = (details: Electron.OnCompletedListenerDetails | Electron.OnErrorOccurredListenerDetails, status: number) => {
    if (!/^https?:/i.test(details.url)) return;
    const id = details.webContentsId;
    if (typeof id !== "number") return;
    const entries = byContents.get(id) ?? [];
    entries.push({
      method: details.method,
      url: details.url.slice(0, 500),
      status,
      ...(details.resourceType ? { resourceType: details.resourceType } : {}),
      timestamp: Date.now(),
    });
    if (entries.length > NETWORK_LIMIT) entries.splice(0, entries.length - NETWORK_LIMIT);
    byContents.set(id, entries);
    if (byContents.size > 32) {
      const oldest = byContents.keys().next().value;
      if (typeof oldest === "number" && oldest !== id) byContents.delete(oldest);
    }
  };
  ses.webRequest.onCompleted((details) => push(details, details.statusCode));
  ses.webRequest.onErrorOccurred((details) => push(details, 0));
}

export class BrowserPane {
  private static readonly sharedBackingHost = new BrowserBackingHost();
  private view: WebContentsView | null = null;
  private surface: View | null = null;
  private window: BrowserWindow | null = null;
  private attachedWindow: BrowserWindow | null = null;
  private visible = false;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private viewportPinned = false;
  private operationTail: Promise<void> = Promise.resolve();
  private onState: (state: BrowserState) => void;
  private fileRoot: string | null = null;
  private watcher: FSWatcher | null = null;
  private watchedDir: string | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private navigationEpoch = 0;
  private stateEventsEpoch: number | null = null;
  private stateUrl: string | null = null;
  private nativeNavigationPending = false;
  private pendingTarget: string | null = null;
  private loadError: { url: string; message: string } | null = null;
  private cancelPending: (() => void) | null = null;
  private control: WebContentsView | null = null;
  private controlState: "idle" | "agent" | "user" = "idle";
  private glowTimer: NodeJS.Timeout | null = null;
  private consoleLogs: ConsoleEntry[] = [];

  /** The bar's own buttons; the host binds this to the control state machine. */
  onAgentControlAction?: (action: "takeover" | "handBack" | "stop") => void;


  private readonly onOpenUrl?: (url: string, sessionId?: string) => void;
  private sessionId?: string;
  private readonly backingHost: BrowserBackingHost;

  constructor(
    onState: (state: BrowserState) => void,
    onOpenUrl?: (url: string, sessionId?: string) => void,
    backingHost = BrowserPane.sharedBackingHost,
    sessionId?: string,
  ) {
    this.onState = onState;
    this.onOpenUrl = onOpenUrl;
    this.backingHost = backingHost;
    this.sessionId = sessionId;
  }

  setSessionId(sessionId?: string): void {
    this.sessionId = sessionId;
  }

  setWindow(window: BrowserWindow | null): void {
    if (this.window === window) return;
    this.detach();
    this.window = window;
    authParentWindow = window;
  }

  getState(): BrowserState | null {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) {
      return this.loadError ? {
        url: this.loadError.url,
        title: "",
        isLoading: false,
        loadError: this.loadError.message,
        canGoBack: false,
        canGoForward: false,
      } : null;
    }
    return {
      url: this.loadError?.url ?? this.pendingTarget ?? wc.getURL(),
      title: wc.getTitle(),
      isLoading: !this.loadError && (this.pendingTarget !== null || wc.isLoading()),
      ...(this.loadError ? { loadError: this.loadError.message } : {}),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }

  getWebContents() {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }

  /** Recent console output, oldest first, bounded. */
  readConsole(limit = 100): ConsoleEntry[] {
    return this.consoleLogs.slice(-Math.max(1, Math.min(300, limit)));
  }

  /** Recent HTTP(S) requests made by this page. */
  readNetwork(limit = 100): NetworkEntry[] {
    const wc = this.getWebContents();
    if (!wc) return [];
    const entries = networkBySession.get(wc.session)?.get(wc.id) ?? [];
    return entries.slice(-Math.max(1, Math.min(NETWORK_LIMIT, limit)));
  }

  /** Captures and pointer input share one page-local viewport owner. */
  captureScreenshot<T>(capture: (wc: WebContents) => Promise<T>): Promise<T> {
    return this.withStableViewport(capture);
  }

  withStableViewport<T>(operation: (wc: WebContents) => Promise<T>): Promise<T> {
    // Pin identity before queueing; a replacement cannot receive old work.
    const wc = this.getWebContents();
    const task = this.operationTail.then(async () => {
      if (!wc || wc.isDestroyed() || this.getWebContents() !== wc) {
        throw Object.assign(new Error("browser guest is not available"), { code: "UNAVAILABLE" });
      }
      const throttled = wc.getBackgroundThrottling();
      this.viewportPinned = true;
      wc.setBackgroundThrottling(false);
      try {
        return await operation(wc);
      } finally {
        this.viewportPinned = false;
        if (!wc.isDestroyed()) wc.setBackgroundThrottling(throttled);
        this.applyBounds();
      }
    });
    // The caller still receives capture errors; a failure must not block the
    // next independent capture.
    this.operationTail = task.then(() => undefined, () => undefined);
    return task;
  }

  /**
   * Stop native WebContents events from publishing state for the document
   * that belonged to the previous session. The next completed managed
   * navigation establishes a new event scope.
   */
  invalidateNavigation(): void {
    this.cancelPending?.();
    this.cancelPending = null;
    this.pendingTarget = null;
    this.loadError = null;
    this.navigationEpoch += 1;
    this.stateEventsEpoch = null;
    this.stateUrl = null;
    this.nativeNavigationPending = false;
  }

  navigate(raw: string, fileRoot: string | null = null): BrowserState | null {
    void this.navigateAndWait(raw, fileRoot);
    return this.getState();
  }

  async navigateAndWait(
    raw: string,
    fileRoot: string | null = null,
    timeoutMs = 15_000,
  ): Promise<BrowserState | null> {
    if (fileRoot) this.fileRoot = fileRoot;
    const localPath = resolveBrowserLocalFile(raw, this.fileRoot);
    const trimmed = raw.trim();
    const localInput = /^file:/i.test(trimmed) || isAbsolute(trimmed) || /^\.{1,2}\//.test(trimmed);
    const target = localPath
      ? pathToFileURL(localPath).toString()
      : localInput ? null : normalizeUrl(raw);
    if (!target) {
      this.beginManagedNavigation();
      this.loadError = { url: raw, message: localInput ? "LOCAL_FILE_NOT_ALLOWED" : "INVALID_URL" };
      const state = this.getState();
      if (state) this.onState(state);
      return null;
    }
    const epoch = this.beginManagedNavigation();
    this.pendingTarget = target;
    this.loadError = null;
    if (localPath) this.watchDirForReload(dirname(localPath));
    else this.clearLiveReload();
    const view = this.ensureView();
    const wc = view.webContents;
    const loading = this.getState();
    if (loading) this.onState(loading);
    if (this.visible) this.attach();
    return new Promise<BrowserState | null>((resolve) => {
      let settled = false;
      let started = false;
      const destinations = new Set([target]);
      const finish = (committed: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wc.removeListener("did-start-navigation", onStart);
        wc.removeListener("did-navigate", onCommit);
        wc.removeListener("did-redirect-navigation", onRedirect);
        wc.removeListener("did-fail-load", onFailure);
        if (epoch !== this.navigationEpoch) { resolve(null); return; }
        this.cancelPending = null;
        this.pendingTarget = null;
        if (error) this.loadError = { url: target, message: error };
        const state = this.getState();
        if (committed && state) this.enableStateEvents(epoch, state.url);
        if (error && state) this.onState(state);
        resolve(committed ? state : null);
      };
      const onStart = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
        if (mainFrame && !inPlace && url === target) started = true;
      };
      const onRedirect = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
        if (started && mainFrame && !inPlace && epoch === this.navigationEpoch) destinations.add(url);
      };
      const onFailure = (_event: unknown, code: number, description: string, url: string, mainFrame: boolean) => {
        if (mainFrame !== false && code !== -3 && destinations.has(url)) finish(false, description);
      };
      const onCommit = (_event: unknown, url: string) => {
        // A current main-frame commit is ready to display even if images or
        // subframes are still loading. Old-session events cannot satisfy it.
        if (started && epoch === this.navigationEpoch && destinations.has(url) && url === wc.getURL()) finish(true);
      };
      const timer = setTimeout(() => finish(false, "ERR_TIMED_OUT"), Math.max(1, timeoutMs));
      this.cancelPending = () => finish(false);
      wc.on("did-start-navigation", onStart);
      wc.on("did-navigate", onCommit);
      wc.on("did-redirect-navigation", onRedirect);
      wc.on("did-fail-load", onFailure);
      void wc.loadURL(target).then(
        () => { if (destinations.has(wc.getURL())) finish(true); },
        (error: unknown) => finish(false, error instanceof Error ? error.message : String(error)),
      );
    });
  }

  action(action: "back" | "forward" | "reload" | "stop"): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (action === "stop" && this.pendingTarget) {
      const url = this.pendingTarget;
      this.cancelPending?.();
      this.loadError = { url, message: "ERR_ABORTED" };
      wc.stop();
      const state = this.getState();
      if (state) this.onState(state);
      return;
    }
    if (action === "back" && wc.navigationHistory.canGoBack()) {
      this.nativeNavigationPending = this.hasCurrentStateEventScope();
      wc.navigationHistory.goBack();
    } else if (action === "forward" && wc.navigationHistory.canGoForward()) {
      this.nativeNavigationPending = this.hasCurrentStateEventScope();
      wc.navigationHistory.goForward();
    } else if (action === "reload") {
      this.nativeNavigationPending = this.hasCurrentStateEventScope();
      wc.reload();
    } else if (action === "stop") {
      wc.stop();
    }
  }

  /** Page-level takeover bar: a small transparent view above the page. */
  setAgentControl(state: "idle" | "agent" | "user", action?: string | null): void {
    this.controlState = state;
    this.syncGlow();
    if (state !== "idle" && this.surface) this.ensureControl();
    this.applyControlBounds();
    const wc = this.control?.webContents;
    if (wc && !wc.isDestroyed()) {
      void wc
        .executeJavaScript(
          `window.__piControl && window.__piControl(${JSON.stringify(state)}, ${JSON.stringify(action ?? null)})`,
        )
        .catch(() => {});
    }
  }

  /** Page-local ownership glow: qiwork's "it owns this page" frame. */
  private syncGlow(): void {
    const wc = this.getWebContents();
    if (!wc || wc.isDestroyed()) return;
    if (this.controlState === "idle" || !this.visible) {
      if (this.glowTimer) { clearInterval(this.glowTimer); this.glowTimer = null; }
      void wc
        .executeJavaScriptInIsolatedWorld(1001, [{ code: AGENT_GLOW_OFF }])
        .catch(() => {});
      return;
    }
    const paint = () => {
      const target = this.getWebContents();
      if (!target || target.isDestroyed() || !/^https?:/i.test(target.getURL())) return;
      // Isolated world: the page can see the DOM but not our script objects,
      // the same split Cursor uses for its injected UI layer.
      void target
        .executeJavaScriptInIsolatedWorld(1001, [{ code: agentGlowOn(this.controlState) }], true)
        .catch((error) => {
          console.error(`[glow] inject failed: ${String(error)}`);
        });
    };
    paint();
    // Navigation replaces the document; re-assert like qiwork does.
    if (!this.glowTimer) this.glowTimer = setInterval(paint, 3000);
  }

  private mountControl(surface: View): void {
    const control = this.control;
    if (control && !surface.children.includes(control)) surface.addChildView(control);
  }

  private ensureControl(): WebContentsView {
    if (this.control && !this.control.webContents.isDestroyed()) return this.control;
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor("#00000000");
    const wc = view.webContents;
    wc.on("console-message", (_event, _level, message) => {
      const action = /^pi-agent-control:(takeover|handBack|stop)$/.exec(String(message));
      if (action) this.onAgentControlAction?.(action[1] as "takeover" | "handBack" | "stop");
    });
    void wc.loadURL(AGENT_CONTROL_BAR_URL);
    this.control = view;
    this.surface?.addChildView(view);
    return view;
  }

  private applyControlBounds(): void {
    const control = this.control;
    if (!control || control.webContents.isDestroyed()) return;
    const { width, height } = this.bounds;
    // Only the capsule rectangle sits above the page, so the rest of the
    // bottom edge still receives page clicks.
    const WIDTH = 360;
    const HEIGHT = 56;
    if (!this.visible || this.controlState === "idle" || width < WIDTH || height < HEIGHT) {
      control.setVisible(false);
      return;
    }
    control.setBounds({
      x: Math.round((width - WIDTH) / 2),
      y: height - HEIGHT,
      width: WIDTH,
      height: HEIGHT,
    });
    control.setVisible(true);
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    const safe = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(0, Math.round(Number(bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds.height) || 0)),
    };
    this.bounds = safe;
    this.applyBounds();
    this.applyControlBounds();
  }

  private applyBounds(): void {
    // Move and clip the presentation surface immediately, even while Chromium
    // pins its capture-time viewport. A pending screenshot must not leave the
    // guest over the conversation when the window or work panel moves.
    if (this.visible) this.surface?.setBounds(this.bounds);
    if (this.view && this.visible && !this.viewportPinned && this.getWebContents()) {
      this.view.setBounds({ x: 0, y: 0, width: this.bounds.width, height: this.bounds.height });
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!this.view) return;
    if (visible) this.attach();
    else this.park();
    this.applyControlBounds();
    this.syncGlow();
  }

  openExternal(): void {
    const url = this.getWebContents()?.getURL();
    if (!url) return;
    const allowed = parseAllowedExternalUrl(url);
    if (allowed) {
      void shell.openExternal(allowed);
      return;
    }
    if (this.isAllowedFileUrl(url)) {
      try {
        void shell.openPath(fileURLToPath(url));
      } catch {
        // Invalid file URL — leave the preview in place.
      }
    }
  }

  dispose(): void {
    this.invalidateNavigation();
    this.clearLiveReload();
    this.detach();
    if (this.glowTimer) { clearInterval(this.glowTimer); this.glowTimer = null; }
    if (this.control) {
      this.surface?.removeChildView(this.control);
      this.control.webContents.close();
      this.control = null;
    }
    if (this.view) {
      const wc = this.getWebContents();
      this.surface?.removeChildView(this.view);
      this.view = null;
      this.surface = null;
      wc?.close();
    }
  }

  private attach(): void {
    if (!this.window || this.window.isDestroyed() || !this.surface) return;
    if (this.attachedWindow !== this.window) this.detach();
    const children = this.window.contentView.children;
    // Keep the guest above its plugin chrome, but confined to the measured hole.
    if (children.includes(this.surface) && children[children.length - 1] !== this.surface) {
      this.window.contentView.removeChildView(this.surface);
    }
    if (!this.window.contentView.children.includes(this.surface)) this.window.contentView.addChildView(this.surface);
    this.attachedWindow = this.window;
    this.surface.setVisible(true);
    this.view?.setVisible(true);
    this.applyBounds();
    this.applyControlBounds();
  }

  /** A hidden native host keeps Chromium input/capture independent of the UI. */
  private park(): void {
    if (!this.surface || !this.view || !this.getWebContents()) return;
    if (this.attachedWindow && this.attachedWindow !== this.window && !this.attachedWindow.isDestroyed()) return;
    this.detach();
    const bounds = this.view.getBounds();
    const size = { width: bounds.width || 1024, height: bounds.height || 768 };
    if (!bounds.width || !bounds.height) this.view.setBounds({ x: 0, y: 0, ...size });
    this.surface.setBounds({ x: 0, y: 0, ...size });
    this.surface.setVisible(true);
    this.view.setVisible(true);
    this.attachedWindow = this.backingHost.attach(this.surface, size);
  }

  private detach(): void {
    if (!this.surface) return;
    const owner = this.attachedWindow;
    if (owner && !owner.isDestroyed() && owner.contentView.children.includes(this.surface)) {
      owner.contentView.removeChildView(this.surface);
    }
    this.attachedWindow = null;
    this.backingHost.detach(this.surface);
  }

  /** Watch the previewed file's directory so page + asset edits re-render. */
  private watchDirForReload(dir: string): void {
    if (this.watcher && this.watchedDir === dir) return;
    this.clearLiveReload();
    try {
      this.watcher = watch(dir, { persistent: false }, () => this.scheduleReload());
      this.watchedDir = dir;
    } catch {
      this.watcher = null;
      this.watchedDir = null;
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      const wc = this.view?.webContents;
      if (wc && !wc.isDestroyed() && wc.getURL().startsWith("file:")) {
        wc.reloadIgnoringCache();
      }
    }, LIVE_RELOAD_DEBOUNCE_MS);
  }

  private clearLiveReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    this.watchedDir = null;
  }

  private isAllowedFileUrl(url: string): boolean {
    const localPath = resolveBrowserLocalFile(url, this.fileRoot);
    if (!localPath) return false;
    if (this.fileRoot && isWithinRoot(localPath, this.fileRoot)) return true;
    // Preserve workspace-file links from web pages, but only let a local
    // document navigate to files outside that workspace.
    return this.view?.webContents.getURL().startsWith("file:") === true;
  }

  private ensureView(): WebContentsView {
    if (!httpAuthInstalled) {
      httpAuthInstalled = true;
      installHttpAuthPrompt(() => authParentWindow);
    }
    if (this.view && this.getWebContents()) return this.view;
    this.detach();
    if (this.view) this.surface?.removeChildView(this.view);
    const partition = partitionForSession(this.sessionId);
    applyChromeIdentity(session.fromPartition(partition));
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true,
        partition,
      },
    });
    const surface = new View();
    surface.addChildView(view);
    this.mountControl(surface);
    surface.setVisible(this.visible);
    surface.setBounds(this.bounds);
    this.surface = surface;
    const wc = view.webContents;
    trackNetwork(wc.session);
    wc.on("console-message", (_event, level, message, line, sourceId) => {
      const type = ["log", "warning", "error", "debug", "info"][level] ?? "log";
      this.consoleLogs.push({
        type,
        message: String(message).slice(0, 2000),
        timestamp: Date.now(),
        ...(sourceId ? { source: `${sourceId}:${line}` } : {}),
      });
      if (this.consoleLogs.length > 300) this.consoleLogs.shift();
    });
    wc.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") return;
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.reload();
      }, 1_000);
    });
    wc.setWindowOpenHandler(({ url }) => {
      // OAuth and SSO providers need the popup's opener relationship, so a
      // web popup stays inside the same browser profile instead of being sent
      // to the system browser. Non-web schemes still leave the app.
      if (isAllowedHttpUrl(url)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            ...(this.window ? { parent: this.window } : {}),
            show: false,
            width: 520,
            height: 720,
            autoHideMenuBar: true,
            webPreferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              partition,
            },
          },
        };
      }
      const allowed = parseAllowedExternalUrl(url);
      if (allowed) {
        if (this.onOpenUrl) this.onOpenUrl(allowed, this.sessionId);
        else void shell.openExternal(allowed);
      }
      return { action: "deny" };
    });
    wc.on("did-create-window", (child) => {
      child.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedHttpUrl(url)) {
          return {
            action: "allow",
            overrideBrowserWindowOptions: {
              parent: child,
              show: false,
              width: 520,
              height: 720,
              autoHideMenuBar: true,
              webPreferences: {
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                partition,
              },
            },
          };
        }
        return { action: "deny" };
      });
      child.webContents.on("will-navigate", (event, target) => {
        if (!isAllowedHttpUrl(target)) event.preventDefault();
      });
      child.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(allowedPermissions.has(permission));
      });
      child.once("ready-to-show", () => child.show());
      child.once("closed", () => {
        if (this.window && !this.window.isDestroyed()) this.window.focus();
      });
    });
    // Narrow allowlist: page features that real sites need, nothing
    // credential-grade. Everything else is denied outright.
    const allowedPermissions = new Set([
      "pointerLock",
      "clipboard-sanitized-write",
      "local-network",
      "loopback-network",
      "local-network-access",
    ]);
    wc.session.setPermissionRequestHandler((requesting, permission, callback) => {
      if (allowedPermissions.has(permission)) {
        callback(true);
        return;
      }
      if (!PROMPT_PERMISSIONS.has(permission)) {
        callback(false);
        return;
      }
      let origin = "this page";
      try { origin = new URL(requesting.getURL()).origin; } catch {}
      const key = `${origin}:${permission}`;
      const cached = permissionDecisions.get(key);
      if (cached !== undefined) {
        callback(cached);
        return;
      }
      const options = {
        type: "question" as const,
        buttons: ["Block", "Allow"],
        defaultId: 0,
        cancelId: 0,
        title: "Site permission",
        message: `${origin} requests ${permission}`,
        detail: "Allow this browser tab to use the feature? The decision is remembered for this session.",
      };
      const prompt = this.window
        ? dialog.showMessageBox(this.window, options)
        : dialog.showMessageBox(options);
      void prompt
        .then(({ response }) => {
          const allowed = response === 1;
          permissionDecisions.set(key, allowed);
          callback(allowed);
        })
        .catch(() => callback(false));
    });
    wc.session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      if (allowedPermissions.has(permission)) return true;
      const origin = String(requestingOrigin ?? "");
      return permissionDecisions.get(`${origin}:${permission}`) === true;
    });
    wc.on("will-navigate", (event, url) => {
      if (isAllowedHttpUrl(url)) {
        this.nativeNavigationPending = this.hasCurrentStateEventScope();
        return;
      }
      // Keep web pages inside the existing workspace-file allowance. A local
      // file page may follow links to any other existing local file.
      if (/^file:/i.test(url) && this.isAllowedFileUrl(url)) {
        this.nativeNavigationPending = this.hasCurrentStateEventScope();
        return;
      }
      event.preventDefault();
    });
    wc.on("did-finish-load", () => {
      // Alt+Click follows a link into the work-panel preview instead of the
      // current tab. The listener lives in the isolated world and reports
      // through console, so the page DOM stays untouched.
      void wc
        .executeJavaScriptInIsolatedWorld(
          1001,
          [
            {
              code: `(() => {
                if (globalThis.__PI_ALT_CLICK) return;
                globalThis.__PI_ALT_CLICK = true;
                document.addEventListener("click", (event) => {
                  if (!event.altKey) return;
                  const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
                  if (!anchor || !anchor.href || /^javascript:/i.test(anchor.href)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  console.log("pi-browser:alt-open:" + anchor.href);
                }, true);
              })()`,
            },
          ],
          true,
        )
        .catch(() => undefined);
      // Some SSO providers gate their login on a local-network permission the
      // embedded browser does not expose; grant it on the known hosts only.
      let host = "";
      try {
        host = new URL(wc.getURL()).hostname.toLowerCase();
      } catch {
        host = "";
      }
      const sso = [".okta.com", ".okta-emea.com", ".oktapreview.com", ".duosecurity.com", ".duo.com", ".login.microsoftonline.com", ".onelogin.com", ".auth0.com", ".pingidentity.com", ".pingone.com", ".rippling.com"];
      if (sso.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
        void wc
          .executeJavaScript(
            `(() => {
              const permissions = navigator.permissions;
              if (!permissions || !permissions.query || permissions.__piLocalNetwork) return;
              permissions.__piLocalNetwork = true;
              const original = permissions.query.bind(permissions);
              permissions.query = async (descriptor) => {
                if (descriptor && ["local-network-access", "local-network", "loopback-network"].includes(descriptor.name)) {
                  return { state: "granted", name: descriptor.name, onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
                }
                return original(descriptor);
              };
            })()`,
            true,
          )
          .catch(() => undefined);
      }
    });
    wc.on("did-navigate", (_event, url) => {
      this.consoleLogs = [];
      if (networkBySession.has(wc.session)) {
        networkBySession.get(wc.session)?.delete(wc.id);
      }
      if (!this.acceptNativeNavigation(url)) return;
      if (!/^file:/i.test(url)) return;
      try {
        this.watchDirForReload(dirname(fileURLToPath(url)));
      } catch {
        // Non-path file URL — keep the previous watcher.
      }
    });
    const push = () => {
      if (!this.hasCurrentStateEventScope()) return;
      const url = wc.getURL();
      if (this.stateUrl !== url) return;
      const state = this.getState();
      if (state) this.onState(state);
    };
    wc.on("did-start-loading", push);
    wc.on("did-stop-loading", push);
    wc.on("did-navigate", (_event, url) => {
      if (this.acceptNativeNavigation(url)) push();
    });
    wc.on("did-navigate-in-page", (_event, url, isMainFrame, processId, routingId) => {
      // Same-document navigation has no will-navigate event. Accept only the
      // active main frame's current URL, without reopening invalidated sessions.
      if (
        !isMainFrame ||
        !this.hasCurrentStateEventScope() ||
        url !== wc.getURL() ||
        processId !== wc.mainFrame.processId ||
        routingId !== wc.mainFrame.routingId
      ) return;
      this.enableStateEvents(this.navigationEpoch, url);
      push();
    });
    wc.on("page-title-updated", push);
    wc.on(
      "did-fail-load",
      (_event, _errorCode, _errorDescription, validatedUrl, isMainFrame) => {
        // Replacing a still-loading document aborts its old request. That
        // event must not consume the pending navigation to the new document.
        if (isMainFrame === false || _errorCode === -3) return;
        if (this.acceptNativeNavigation(validatedUrl)) push();
      },
    );
    this.view = view;
    if (this.visible) this.attach();
    else this.park();
    return view;
  }

  private beginManagedNavigation(): number {
    this.cancelPending?.();
    this.cancelPending = null;
    this.pendingTarget = null;
    this.loadError = null;
    const epoch = ++this.navigationEpoch;
    this.stateEventsEpoch = null;
    this.stateUrl = null;
    this.nativeNavigationPending = false;
    return epoch;
  }

  private enableStateEvents(epoch: number, url: string): void {
    if (epoch !== this.navigationEpoch) return;
    this.stateEventsEpoch = epoch;
    this.stateUrl = url;
    this.nativeNavigationPending = false;
  }

  private hasCurrentStateEventScope(): boolean {
    return this.stateEventsEpoch === this.navigationEpoch && this.stateUrl !== null;
  }

  private acceptNativeNavigation(url: string): boolean {
    if (!this.hasCurrentStateEventScope()) return false;
    if (url === this.stateUrl) {
      this.nativeNavigationPending = false;
      return true;
    }
    if (!this.nativeNavigationPending) return false;
    this.stateUrl = url;
    this.nativeNavigationPending = false;
    return true;
  }
}
