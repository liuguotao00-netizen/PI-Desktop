/**
 * Browser backend abstraction (ADR browser-backend-abstraction).
 *
 * A session binds to one backend. The embedded backend stays in
 * browser-host.ts; this module owns the registry and external backends, so a
 * new browser source does not grow the Electron view implementation.
 */


export type BrowserBackendKind = "embedded" | "cdp" | "extension" | "mcp" | "mcpapps";

export type BrowserCapability =
  | "tabs"
  | "navigate"
  | "snapshot"
  | "evaluate"
  | "screenshot"
  | "input"
  | "click"
  | "fill"
  | "upload"
  | "download"
  | "frames"
  | "locator";

export type BackendTab = {
  id: string;
  url: string;
  title: string;
  active?: boolean;
  headless?: boolean;
  windowId?: number;
  groupId?: number;
  providerTabId?: string;
};

export type SnapshotResult = { tree: string; url: string; title: string };
export type BrowserHistoryEntry = { index: number; url: string; title: string };
export type BrowserHistory = { index: number; entries: BrowserHistoryEntry[] };
export type ScreenshotResult = {
  mimeType: string;
  data: string;
  width: number;
  height: number;
};

export type DownloadResult = {
  path: string;
  url: string;
  filename: string;
  state: "completed" | "cancelled" | "interrupted";
};

export type LocatorInput = {
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  placeholder?: string;
  testId?: string;
  hasText?: string;
  hasNotText?: string;
  visibleOnly?: boolean;
  nth?: number;
  nthFromEnd?: number;
  frameSelector?: string;
  limit?: number;
  /** Intersect (and) or union (or) this query with another one. */
  combine?: "and" | "or";
  combined?: LocatorInput;
};

export type LocatorAction =
  | "list"
  | "count"
  | "text"
  | "innerText"
  | "textContent"
  | "html"
  | "attribute"
  | "isVisible"
  | "isEnabled"
  | "isChecked"
  | "check"
  | "uncheck"
  | "setChecked"
  | "selectOption"
  | "click"
  | "fill"
  | "type"
  | "focus"
  | "scrollIntoView"
  | "dblclick"
  | "evaluate"
  | "evaluateAll"
  | "mediaUrl";

export type LocatorQuery = LocatorInput & {
  action?: LocatorAction;
  value?: string;
  values?: Array<string>;
  attribute?: string;
  checked?: boolean;
  fn?: string;
  arg?: unknown;
};

export type LocatorResult = {
  ok: boolean;
  error?: string;
  count?: number;
  matches?: LocatorMatch[];
  value?: unknown;
};

export type LocatorMatch = {
  ref: string;
  index: number;
  tag: string;
  role: string;
  name: string;
  text: string;
  visible: boolean;
  enabled: boolean;
  checked?: boolean;
  value?: string;
  html?: string;
  box: { x: number; y: number; width: number; height: number };
};

export interface BrowserPageOperations {
  goto(url: string, timeoutMs?: number): Promise<unknown>;
  reload(): Promise<void>;
  snapshot(): Promise<SnapshotResult>;
  history?(): Promise<BrowserHistory>;
  evaluate(expression: string): Promise<unknown>;
  evaluateNative?(expression: string): Promise<unknown>;
  evaluateIsolated?(expression: string): Promise<unknown>;
  screenshot(input?: { fullPage?: boolean; format?: "jpeg" | "png"; clip?: { x: number; y: number; width: number; height: number } }): Promise<ScreenshotResult>;
  input(event: unknown): Promise<unknown>;
  click(ref: string): Promise<void>;
  fill(ref: string, text: string): Promise<void>;
  uploadFiles(selector: string, files: string[]): Promise<void>;
  waitForFileChooser?(timeoutMs?: number): Promise<{ backendNodeId: number; mode: string }>;
  setFileChooserFiles?(files: string[]): Promise<void>;
  cancelFileChooser?(): Promise<void>;
  clickAndWaitForDownload?(ref: string, timeoutMs?: number): Promise<DownloadResult>;
  waitForDownload?(timeoutMs?: number): Promise<DownloadResult>;
  consoleLogs?(limit?: number): Promise<{ entries: Array<{ type?: string; message: string; timestamp: number }> }>;
  networkRequests?(limit?: number): Promise<{ entries: Array<{ method?: string; url: string; status: number; timestamp: number }> }>;
  waitForNetworkIdle?(timeoutMs?: number, idleMs?: number): Promise<void>;
  handleDialog?(input: { accept?: boolean; promptText?: string }): Promise<{ ok: boolean; error?: string }>;
  getJsDialog?(): { type: string; message: string; defaultPrompt?: string } | null | Promise<{ type: string; message: string; defaultPrompt?: string } | null>;
  crossOriginFrame?(input: {
    action: "list" | "text" | "html" | "click" | "fill" | "count";
    frameId?: string;
    url?: string;
    targetSelector?: string;
    value?: string;
    limit?: number;
  }): Promise<unknown>;
  download(url: string, filename?: string): Promise<{ path: string; bytes: number }>;
  frames(input: { action: "list" | "text" | "html"; index?: number; selector?: string; limit?: number }): Promise<unknown>;
  locator(input: LocatorQuery): Promise<unknown>;
}

export interface BrowserBackend {
  readonly id: string;
  readonly kind: BrowserBackendKind;
  readonly transport?: import("./transport.ts").BrowserTransport;
  capabilities(): readonly BrowserCapability[];
  /** Optional one-time capability discovery before the first tab operation. */
  initialize?(): Promise<void>;
  listTabs(): Promise<BackendTab[]>;
  openTab(url: string, options?: { headless?: boolean }): Promise<BackendTab>;
  closeTab(tabId: string): Promise<void>;
  attach(tabId: string): Promise<void>;
  showTab?(tabId: string): Promise<void>;
  page(tabId: string): BrowserPageOperations;
  dispose(): void;
  health?(): Promise<{ ok: boolean; tabs?: number; error?: string }>;
}

export type BrowserBackendBinding = {
  backend: BrowserBackend;
  tabId: string;
};

/**
 * Per-session backend bindings. Nothing here is persisted: a restart returns
 * every session to the embedded browser.
 */
