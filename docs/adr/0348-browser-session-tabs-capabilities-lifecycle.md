# ADR 0348: Browser sessions own tabs, capabilities, and turn cleanup

- Status: Accepted
- Date: 2026-11-27
- Related: [browser-backend-abstraction](browser-backend-abstraction.md) ·
  [browser-automation-tool-surface](browser-automation-tool-surface.md) ·
  [0347](0347-browser-extension-native-messaging.md) ·
  [browser-agent-control-and-native-evaluate](browser-agent-control-and-native-evaluate.md)

## Context

The browser surface grew two clients: `pi.browser.*` (the plugin tools) and
`cua.browser` (the Codex-shaped `BrowserSession` used by CUA). They shared the
backend registry but kept separate tab bookkeeping, claims, and a capability
list that only returned a documentation string. Automation tabs never closed
at the end of a turn, and the CUA session was built ad hoc without claims or
capabilities.

Codex models this with one `agent.browsers` object: `Browser.tabs`,
`Browser.user.claimTab`, per-browser/per-tab capability collections, and
temporary tabs that close at turn end unless `markDeliverable()` /
`markHandoff()` keeps them.

## Decision

1. **One registry.** `browser/sessions.ts` (`BrowserSessions`) creates and caches
   one `BrowserSession` per session and is injected into both the plugin host
   API and `CuaRuntime`. Driving `pi.browser` operations (navigate, snapshot,
   screenshot, click, fill, evaluate, history) resolve the same session and
   call it, so tools and CUA act on the same tab objects.
2. **Real capabilities.** `BrowserCapabilityCollection.get(id)` returns a
   callable object instead of a label: `visibility` (`get`/`set`), `tabs`,
   `playwright`, `content`, plus the tab-scoped `ax`, `cua`, `dom_cua`,
   `clipboard`, `dev`. Capability ids come from the bound backend and are
   exposed to plugins through `browser.capabilities`, `browser.capability`
   (`describe`/`get`/`set`), and a `browser_capabilities` tool. Unimplemented
   ids keep the documentation stub so older surfaces keep answering.
3. **One tab lifecycle.** `browser/lifecycle.ts` (`TabLifecycle`) records the
   origin (`user` / `agent` / `background` / `headless`), the creating turn,
   claims, and marks. At the end of a turn, `BrowserSessions.endTurn` closes
   automation tabs created in that turn unless they are marked `deliverable` or
   `handoff`; user tabs and claimed tabs are never closed by cleanup. Survivors
   become persistent and their marks are cleared, matching Codex's turn-scoped
   marks.
4. **Surfaces.** `browser_tabs` gains `claim`, `release`, and `mark` actions,
   and a `browser_capabilities` tool exists for capability checks and
   `visibility.set`. `BrowserTabHandle` gains `markDeliverable`,
   `markHandoff`, `marks`, `isVisible`/`setVisible`, and
   `requestUserTakeover(reason)`.
5. **Claims stay user-consented and live once.** A claim still goes through the
   native Allow/Deny prompt in `CuaRuntime.claimTab`; `TabLifecycle` stores the
   claimed tab (id, title, url) and `CuaSessions` reads it from there instead of
   keeping a second map. Takeover requests reuse the existing browser control
   state machine.
6. **Host responsibilities split.** `browser/page-registry.ts` owns page
   creation, tab selection/connection, locations, headless marks, page state
   publication and page teardown; `browser/presenter.ts` owns the active page,
   window/chrome surface, guest hole and reveal waiters. `BrowserHost` now
   orchestrates agent operations and delegates to both.
7. **Typed session operations.** `BrowserSession` exposes explicit methods
   (`snapshot`, `click`, `evaluateIsolated`, `cdp`, ...); the old string-dispatch
   `call()` is gone, so tools and CUA call the same strongly typed surface.

8. **Surface alignment.** Tabs gained `content` (temporary background tabs,
   `text`/`html`), locators gained the Codex method set (all/first/last/nth/
   filter/and/or, waitFor, check/uncheck/setChecked, selectOption, press,
   pressSequentially, innerText/getAttribute/isVisible/isEnabled, evaluate/
   evaluateAll, downloadMedia), page-level waits (`waitForLoadState`,
   `waitForURL`, `waitForTimeout`, `waitForEvent(download|filechooser)`),
   DOM CUA exposes id-tagged `get_visible_dom()` with click/double-click/
   scroll/type/keypress/downloadMedia, `dev.logs` filters by level and text,
   and history filters by `from`/`queries`.
9. **JS kernel injection.** `pi.cua.session()` and `pi.cua.sessionInvoke()`
   resolve the real `BrowserSession`/tab objects inside the host; the `cua_js`
   sandbox holds a generic proxy (`sessionNode`) instead of hand-written tab
   methods, so every session member (playwright locators, ax, dom_cua,
   clipboard, dev, marks, waits) is reachable from agent code without new
   wiring per method. Internal members (`deps`, `service`, `tab`, `input`,
   `__proto__`, `constructor`) are denied.

10. **Settings parity.** Browser preferences now live in host settings
    (`AppSettings.browser`), not renderer localStorage: backend selection,
    download directory and prompt, full-URL display, bookmarks bar visibility,
    extensions toolbar, device toolbar, link target, external-browser shortcut,
    and background networking. The Settings page renders them through
    `BrowserChromeSettingsSection`; the backend card reads and writes the same
    host value.
11. **Runtime parity.** Screenshot clips, clipboard entry arrays, CUA click
    counts/buttons/modifiers/drag paths/coordinate media download, AX click and
    key durations, a browser catalog (embedded plus bound backends) with
    `getForUrl`, capability descriptions/documentation, DOM snapshot content,
    window/group/mention tab fields, a bookmarks bar, a history panel, an
    extensions/bridge panel and a device toolbar are wired end to end.
    `cua.getDialog()` returns an object with `accept`/`dismiss`.

## Consequences

- Automation tabs no longer leak across turns; a workflow that needs its tab
  after the turn must mark it.
- The plugin and CUA surfaces share tab ids, claims, and capability answers;
  the `cua.browser` object now advertises real capabilities.
- Page lifetime and presentation now live in the registry/presenter; the host
  orchestrates agent operations. Cleanup is best effort (a tab already gone is
  ignored).
- Tests covering tabs, capabilities, and cleanup live in
  `apps/desktop/test/browser-lifecycle.test.mjs` and `browser-session.test.mjs`;
  the host split keeps the existing host/pane tests unchanged.
