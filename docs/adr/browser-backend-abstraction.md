# ADR: Browser backend abstraction

- Status: accepted
- Date: 2026-11-25
- Related: `browser-automation-tool-surface.md`, `browser-agent-control-and-native-evaluate.md`, ADR 0170 (browser plugin), ADR 0004 (remote gateway out of scope)

## Context

`pi.browser` currently binds one page implementation: an Electron
`WebContentsView` driven by `wc.debugger` and native input. That is the right
default for the bundled work-panel browser, but it makes every additional
browser source a branch inside `BrowserHost`. Codex instead exposes one
browser abstraction over several backends:

```text
Agent → Browser API → IAB | Chrome extension | CDP | MCP Apps
```

The useful idea is not the four names. It is that sessions address a
**capability-scoped page** rather than a concrete Electron view, so a new
browser source can be added without growing the host again.

## Decision

`pi.browser` gains a session-bound backend abstraction with three layers.

### 1. BrowserRuntime (host-owned)

Keeps the invariants that must not move into a backend:

- `sessionId → { backendId, tabId, ownership }`
- user takeover / agent control state
- visibility and bounds for the embedded view
- upload roots, download destination and byte cap
- permission checks and audit
- tab claiming consent

### 2. BrowserBackend (one per browser source)

```ts
interface BrowserBackend {
  id: string;
  kind: "embedded" | "cdp" | "extension" | "mcp";
  capabilities(): BrowserCapability[];
  listTabs(): Promise<BackendTab[]>;
  openTab(url: string): Promise<BackendTab>;
  closeTab(tabId: string): Promise<void>;
  page(tabId: string): PageOperations;
}
```

`capabilities()` is authoritative. A tool that needs an unsupported
capability returns `UNSUPPORTED` with the backend id; callers must not assume
feature parity between backends.

### 3. PageOperations

```ts
interface PageOperations {
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  snapshot(): Promise<SnapshotResult>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(input?): Promise<ScreenshotResult>;
  input(event: unknown): Promise<void>;
  click(ref: string): Promise<void>;
  fill(ref: string, text: string): Promise<void>;
  uploadFiles(selector: string, files: string[]): Promise<void>;
  download(url: string, filename?: string): Promise<DownloadResult>;
  frames(input): Promise<FrameResult>;
  locator(input): Promise<LocatorResult>;
}
```

The embedded backend keeps the existing `WebContentsView`, CDP and native
input implementation. A `CdpTransport` seam (`wc.debugger` or a WebSocket)
lets the same page logic drive external Chromium.

## Backends

### Embedded (default)

Current work-panel page. Supports tabs, visibility, takeover, upload,
download, frames, locator, screenshots. No behavior change.

### CDP

Connects to an explicitly configured Chrome/Edge DevTools endpoint
(`http://127.0.0.1:<port>`), discovers tabs through `/json/list`, and uses
`Target.attachToTarget` + flat sessions. It never reads cookies, storage,
permissions or targets; structured tools remain the only write path.
Visibility is limited to activating the external tab.

### Extension

A user-installed Chrome/Edge extension connects to a loopback bridge owned by
Electron. Tabs are listed without content; a single tab is claimed only after
the user confirms its title and origin. Claim is turn-scoped and revocable at
any time. The backend never reads cookie/storage CDP domains.

### MCP Apps

An adapter over an MCP server that exposes browser tools. The backend maps
only explicitly declared tool names and capability ids; it cannot reach
unlisted MCP tools. This is the lowest-priority backend and is opt-in.

## Session binding

- A session starts on `embedded`.
- `browser.backend.connect` binds `{ kind, endpoint }` for that session only;
  `browser.backend.disconnect` returns it to `embedded`.
- Binding is not global and is not persisted across app restart.
- User takeover wins over every backend.
- A backend that disconnects resolves its tabs to `UNAVAILABLE`; it never
  silently falls back to embedded.

## Security

- External backends are opt-in per session.
- Extension tab claims require explicit per-tab confirmation showing title
  and origin.
- Cookie, storage, target and permission CDP domains stay denied for every
  backend.
- Uploads resolve inside the session project/worktree/scratch roots.
- Downloads use the active backend's session, are http(s)-only, capped at
  64 MiB, and land in session scratch.
- External pages remain untrusted content; page text cannot grant permission.

## Implementation status

- `browser-backends.ts` is a compatibility barrel; the implementation lives
  in `browser/` (`types`, `registry`, `router`, `factory`, `service`, `transport`, `embedded`,
  `cdp/{connection,transport,page,backend,snapshot,observer,chooser,downloads,frames,locator}`,
  `extension`, `mcp`).
- Plugins that register desktop-control tools must declare
  `computer.control`; plugins that launch a real browser must declare
  `browser.launch`. Tool registration is refused otherwise.
- Plugin processes cannot load `child_process` without `system.process`,
  `computer.control` or `browser.launch`; the module loader refuses the require.
- The bundled `pi.image-reader` tool attaches a workspace image as a visual
  input block through the host fs preview API.
- `browser/chrome-launcher.ts` can launch a separate Chrome profile when the
  configured CDP endpoint is not already running; `chromePath`, `userDataDir`,
  `headless` and extra `chromeArgs` are opt-in and loopback-only.
- `browser/transport.ts` owns the shared external transport lifecycle
  (`connect` / status / health / close / status listeners); CDP, extension and
  MCP clients implement it.
- `BrowserRouter` is the single session-bound routing and capability gate.
- `browser/service.ts` defines `BrowserService` and owns the plugin-facing
  routing; `plugin-services` only assembles dependencies.
- Tabs, console, network and dialogs go through the effective backend;
  `BrowserService` keeps only host-owned view plumbing (reveal, bounds,
  visibility, legacy raw CDP) on `BrowserHost`.
- `BrowserHost` keeps the embedded page runtime and no longer knows concrete
  backend classes or exposes backend-selection methods. IPC reaches the router
  directly for backend state/connect/disconnect.
- `CdpBrowserBackend` connects to a loopback DevTools endpoint and supports
  tabs, navigation, evaluation, snapshot refs, input, upload, frames and
  locator.
- `ExtensionBrowserBackend` consumes a loopback WebSocket bridge; the
  companion extension owns tab claiming and file access.
- `McpBrowserBackend` maps only the named `browser_*` MCP tools over Streamable
  HTTP; it exposes a reduced capability set.
- Session binding is `browser.backend.connect` / `disconnect` / `state`, and
  every binding is released on session close or plugin unload.
- Settings → System exposes the active backend, its capabilities,
  connect/disconnect controls and a Chrome-family auto-discovery action.
  Discovery reads local `DevToolsActivePort` files and probes loopback ports;
  it never leaves the machine.
- File chooser interception is CDP-backed (`Page.setInterceptFileChooserDialog`
  + `Page.fileChooserOpened`) and available to both embedded and CDP pages.
- Embedded downloads use `will-download`; CDP downloads use
  `Browser.setDownloadBehavior` and progress events. Both land in session
  scratch.
- CDP pages now expose console, network, JavaScript dialogs, layout-aware
  screenshots, download progress, and reconnect after a socket drop.
- CDP endpoint identity is verified through `/json/version`; both the browser
  WebSocket and target WebSockets must be loopback.
- Locator supports count/text/attribute/visibility/check/select actions,
  `waitFor`/filter semantics, and same-origin iframe click/fill.
- Cross-origin frames are driven only through the explicit CDP frame path
  (`browser_frame` with `crossOrigin: true`), using
  `Page.createIsolatedWorld` and frame-owner coordinates; no cookie/storage
  API is exposed.
- The embedded path is unchanged.

The backend abstraction does not change the Agent tool surface; the existing
`browser_*` tools keep their names and capability-gate at runtime. A backend
that has not been connected leaves the session on `embedded`.

Backend configuration (kind, endpoint, CDP launch/profile) is app-level and
remembered in renderer preferences, so Settings can prepare a backend before
any conversation exists; only `connect` binds it to the current session. The
state query without a session reports the embedded backend plus the app-global
extension bridge endpoint.
