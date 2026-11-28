# ADR: Cursor-aligned browser automation surface

- Status: accepted
- Date: 2026-11-24
- Related: `browser-agent-control-and-native-evaluate.md`, ADR 0170 (browser plugin), ADR 0104 (plugin views)

## Context

`pi.browser` shipped one `Browser` tool with an `action` switch, a CDP
allowlist, and an accessibility-tree snapshot. Cursor's
`cursor-browser-automation` extension instead exposes one tool per action, a
DOM snapshot full of refs, hit-testing before clicks, structured failure
suggestions, isolated-world UI injection, and a raw-CDP tool that denies
`Input.*`. Session records showed the consequences of the old shape: raw
`no visible box` / `unknown or stale uid` errors, blind retries, and large
snapshots.

This ADR records the adopted surface. It does not claim feature parity where a
Cursor feature needs a host capability we do not have.

## Decision

1. **One tool per action.** `pi.browser` registers `browser_navigate`,
   `browser_snapshot`, `browser_click`, `browser_mouse_click_xy`,
   `browser_type`, `browser_fill`, `browser_fill_form`, `browser_select_option`,
   `browser_press_key`, `browser_scroll`, `browser_drag`, `browser_hover`,
   `browser_highlight`, `browser_get_bounding_box`, `browser_take_screenshot`,
   `browser_tabs`, and `browser_cdp`. Descriptions carry the workflow rules
   (snapshot first, no CDP `Input.*`, one retry per new observation).
2. **DOM snapshot with refs.** `browser_snapshot` walks the document and open
   shadow roots and keeps `eN → element` in an isolated-world `Map` (no
   `data-*` attributes, so the page's DOM carries no automation markers), and emits role/name/ref/nth/level/
   value/placeholder/options/state in YAML (or one-line `compact`). Interactive
   nodes and content nodes (headings, labels, paragraphs, list items, landmarks,
   article/section/nav roles) are both included unless `interactive` is set.
   `interactive`, `compact`, `selector`, and `maxDepth` bound size.
   `browser_click`/`browser_type` recover a stale ref by matching the `element`
   description.
3. **Hit-testing before input.** `browser_click` scrolls (up to
   `maxScrollAttempts`), resolves the element centre, and checks
   `elementFromPoint` through shadow roots. Modal, iframe, dropdown,
   scroll-container, and element blockers return `{ error, suggestion,
   recovery, blocking, pageState }`; dropdowns are dismissed with Escape and
   retried. Pointer input is dispatched through CDP after the check.
4. **Routine automation never touches the debugger or page attributes.**
   Snapshots/refs/DOM helpers run in isolated world 1001; no `data-pi-ref` is
   written. Pointer events use
   `webContents.sendInputEvent` (`pi.browser.inputEvent`); text uses
   `webContents.insertText` (`pi.browser.insertText`); keyboard uses native
   keyDown/char/keyUp. The CDP `Input.*` channel remains only for legacy
   callers and still cannot be reached through `browser_cdp`. DOM helpers and
   refs run in an isolated JS world (`pi.browser.evaluateIsolated`), so the page
   never sees helper objects. `pi.browser.cdp` (and `browser_cdp`) deny `Input.*`; they also deny
   `Cookie.*`, `Storage.*`, `Target.*`, and `Fetch.*`, a deliberate deviation
   from Cursor (credential-grade surfaces stay closed). Domains are enabled
   lazily, and one-shot raw CDP calls detach immediately. CDP responses above
   25,000 characters are written to the session scratch directory and returned
   as `{ savedTo, sizeBytes, preview }`.
5. **Screenshots are bounded and cached by the host.** Viewport captures use
   `webContents.capturePage` and never attach the debugger; only an explicit
   full-page capture uses CDP, then detaches. Captures are JPEG and
   shrink until the base64 payload is ≈20,000 characters; the result reports
   `width`, `height`, and `resized`. Each page keeps its last capture
   (`url / imageWidth / imageHeight / path / at`), exposed through
   `pi.browser.screenshotState`. `browser_mouse_click_xy` prefers that
   view-service cache, falls back to plugin memory, rejects a different URL,
   and maps screenshot pixels back to viewport coordinates.
6. **Ownership effects live in an isolated world.** The page glow/curtain/dot
   effect is injected with `executeJavaScriptInIsolatedWorld(1001, …)`. The DOM
   is shared, script objects are not; the page cannot call into our layer, and
   the control bar stays a trusted native overlay.
7. **Origin policy is explicit.** `PI_BROWSER_ALLOWED_ORIGINS` (comma-separated
   hosts) gates navigation and every action when set; when unset, agent tools
   accept http(s) only and reject `file:` pages. This matches Cursor's
   per-navigation and per-action origin checks without inventing a settings
   surface yet.
8. **Tabs are a first-class tool.** `browser_tabs` lists the calling session's
   pages and its `headlessTabs` separately, opens a new one (optionally
   `headless: true`, which stays out of the visible tab list and is driven in
   the background), selects an existing one, or closes one. Selecting a normal
   tab moves the host's active page and reveals it; selecting a headless tab
   only retargets tool calls and never reveals it. `position` is accepted for
   `new`; PI-Desktop has one Browser pane, so `active` and `side` name the same
   surface.
9. **`browser_lock` is an automation lease.** It keeps the quiet `agent` state
   across operations so the bar does not flicker during a long automation.
   User takeover still wins: it clears the lease and refuses a later lock with
   `HANDOFF_REQUIRED`. This is deliberately not Cursor's "block the user" lock.
10. **Telemetry is durable and readable.** Every tool outcome appends one
    bounded JSONL row (`browser-telemetry.jsonl` in the plugin data
    directory): tool, ok, duration, session, error, suggestion, bounded args.
    `browser_telemetry` reads the last 300 rows and aggregates per-tool
    success/failure/latency. It never changes the tool result.
11. **Snapshot freshness and backfill.** A ref-based action refreshes the
    snapshot when the cached one is older than 10 s (Cursor's
    `ensureFreshSnapshot`). A stale-ref failure returns `snapshotBackfill`
    with fresh refs (bounded to 4 KB) instead of forcing another round trip.
12. **Cross-cutting action options.** Every non-read-only tool accepts
    `take_screenshot_afterwards`; the wrapper attaches the capture on success
    and on failure. Action tools return `pageState`. `browser_type` emits
    per-character keydown/keypress/keyup around each insertion. A stale-ref
    failure retries once after a fresh snapshot. `browser_tabs` resolves
    `index` against `action: "list"` and honors `position` for `new`.
    `browser_navigate` accepts `newTab / headless / position / preserveFocus`.
    `browser_hover` accepts `waitForChange / timeoutMs`. CDP `Profiler.stop`
    and oversized responses are written under `<data>/browser-logs` and
    returned as `{ savedTo, log_file: { path, sizeBytes }, preview }`, matching
    Cursor's `log_file` content shape.

## Consequences

- Tool-list context grows (19 tools). Read-only tools (`snapshot`,
  `bounding_box`, `highlight`, `tabs list`) stay small; the workflow text is
  carried once per tool rather than in a global instruction.
- Plan mode keeps navigate/snapshot/take_screenshot/bounding_box through the
  wildcard declaration; mutating tools stay hidden.
- Hit-testing adds one page evaluation per click; snapshots add one per
  snapshot. Both are bounded by `maxDepth`, `interactive`, and screenshot
  budgets.
- Headless tabs are "background" pages: the host keeps them in the lazy
  backing window and never reveals them, not a separate headless browser.
- Plan mode is covered by a wildcard (`planSafeActions: ["*"]`) on read-only
  tools; the host gate now understands that sentinel.

## Alternatives

- Keep the single `Browser` action switch: rejected — the model had to encode
  intent in one description and error text could not be action-specific.
- Inject the glow in the main world: rejected — page script could observe and
  tamper with it, and it adds an avoidable detection surface.
- Allow `Cookie.*`/`Storage.*` for Cursor parity: rejected — reading the cookie
  jar is a credential grant, not a browser-automation primitive.
- Enforce a hard-coded origin allowlist: rejected for now — the built-in
  browser is also used for general browsing; an env-configured allowlist keeps
  automation deployments strict without breaking that.


## Additions from the Cursor parity pass (2026-11-25)

- **Stable refs and snapshot diff.** `browser_snapshot` keeps an element's
  `eN` handle for as long as it stays in the DOM (isolated-world `WeakMap` +
  monotonic counter). `includeDiff` reports only added, removed, and changed
  nodes against the tab's previous snapshot, and the header carries ref counts
  and active filters.
- **Snapshot detail.** Nodes may carry `description`, `url`, `src`,
  `activeDescendant`, and select options (label, value, disabled, capped at
  20); password values are never emitted.
- **Native tool options.** `browser_click` accepts modifiers; `browser_type`
  accepts `clear`, `submit`, and `slowly`; screenshots accept `type` and a
  `filename` saved inside the plugin data directory.
- **Dialogs and detached pages.** `browser_dialog` answers the blocking
  JavaScript dialog through CDP. Detached or destroyed pages return a
  `browser_navigate` recovery instead of an opaque exception.
- **Page diagnostics.** `browser_console` and `browser_network` read bounded
  per-tab ring buffers (console messages, HTTP requests) captured by the pane;
  both are Plan-safe.
- **Waiting.** `browser_wait` polls selector, text, URL, navigation, DOM
  stability, or network idle with a bounded timeout instead of sleeping.
- **Link handling.** Alt+Click opens a link through the work-panel preview
  instead of replacing the current tab; known SSO hosts receive a
  local-network permission shim.
- **Permissions.** The guest session allows `pointerLock`,
  `clipboard-sanitized-write`, and local-network permissions, and denies
  everything else.
