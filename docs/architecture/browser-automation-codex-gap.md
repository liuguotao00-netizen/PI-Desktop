# Built-in browser and automation: gap vs Codex

Date: 2026-11-26
Reference: Codex's unified browser surface as described in
`docs/adr/browser-backend-abstraction.md` and `docs/adr/cua-codex-parity.md`
(IAB, Chrome extension, CDP, MCP Apps). This is a code-grounded review, not a
claim about unpublished Codex internals.

## What is already aligned

| Area | PI-Desktop |
| --- | --- |
| Unified session | session-bound backend, tab, claim and CUA state |
| Backends | embedded, CDP, extension bridge, MCP, mcpapps kind |
| Browser tools | navigate, snapshot, click, fill, type, hover, scroll, drag, select, screenshot, wait, console, network, tabs, locator, frames, upload, download, dialog, evaluate, history |
| Safety | loopback-only CDP, denied cookie/storage/target CDP domains, file roots, download cap |
| Agent control | per-session lock, user takeover, HANDOFF_REQUIRED |
| Claim | native Allow/Deny, per-tab claim dot, browser-local tab strip, release banner |
| Agent loop | observe → one action → execute, screenshot input, idle wait, failure recovery, budgets |
| WebMCP | list/call page tools |

## Material gaps

### 1. Browser profile isolation

Fixed: the embedded browser now derives a persistent partition from the
session id (`browser/partition.ts`), so cookies, storage and logins do not cross
sessions. Panes without a session keep the legacy `persist:work-browser`
partition. Profile cleanup on session delete is still a follow-up.

### 2. MCP browser backend

The `mcp` / `mcpapps` backend now maps a real Playwright MCP server, including
snapshot, screenshot image content, evaluate unwrapping, fill/click schema
mapping and `isError` -> `TOOL_FAILED`. A UI resource host for MCP Apps
resources is a separate surface, not required by the Codex browser backend.

### 3. MCP tab model

MCP `browser_tabs` is now mapped to real tab ids/indexes; `openTab` selects the
new tab before navigating, and page operations re-select the bound tab. The
remaining capability-discovery work is to derive `capabilities()` from
`tools/list` instead of a fixed list.

### 4. Extension distribution and install flow

Added: Electron owns a loopback WebSocket bridge
(`browser/extension-server.ts`, `ws://127.0.0.1:47123/pi-browser`), and the
MV3 extension ships under `resources/browser-extension` with a Load unpacked
README and options page. Packaged builds copy the extension directory next to
`bin/`.

Native messaging now mirrors Codex's install model
([ADR 0347](../adr/0347-browser-extension-native-messaging.md)): on every start
the app writes `com.pi.desktop.browser` host manifests into each Chromium
browser's `NativeMessagingHosts` directory and a launcher for
`resources/browser-native-host/host.mjs`, and the extension connects with
`chrome.runtime.connectNative` first (WebSocket URL retained as a fallback).
The remaining follow-up is a signed native host executable for Windows, which
cannot launch the script-based host.

### 4. Action grounding and actionability

CDP click now checks layout box, visibility, disabled state, pointer-events and
`elementFromPoint` occlusion, then retries three times before failing. Stale
refs still require a new snapshot; fill has the same stale-ref failure path.

### 5. User takeover inside browser_run

`browser_run` now locks the browser for the loop and returns `needs-user`
immediately on HANDOFF_REQUIRED. It does not yet resume from the same step
after the user hands control back.

### 6. Multi-tab orchestration

`browser_run` now exposes `new_tab`, `switch_tab` and `close_tab` and drives the
active session binding across steps. It still does not wait for a new tab or
track ownership of tabs it opened.

### 7. Load/network lifecycle

`wait idle` now uses CDP `Network.requestWillBeSent` /
`Network.loadingFinished` / `Network.loadingFailed` in-flight tracking and
falls back to the `readyState` heuristic only for backends without CDP.

### 8. Long-horizon planning

`browser_run` has max 16 steps and keeps the last 12 history entries. There is
no persistent task plan, checkpoint, or explicit replan after recovery.

### 9. Download/upload edge parity

Downloads expose progress records and a cancel API (`pi.browser.downloads` /
`cancelDownload`); uploads still use the file-chooser path without a cancel UI.

### 10. Cross-platform/browser verification

Embedded and CDP paths have unit coverage; extension, real MCP Apps, Windows
and Linux browser automation are not live E2E tested.

## Priority

```text
P0  per-session browser profile isolation
P0  MCP Apps host
P1  actionability + stale-ref retry
P1  browser_run takeover pause/resume
P1  multi-tab orchestration
P2  real network-idle and task planning
P2  extension packaging/onboarding
P2  download/upload progress/cancel
```

### Browser session model (2026-11-27)

Aligned with Codex's `agent.browsers` object model: one `BrowserSessions`
registry serves both the `pi.browser.*` tools and `cua.browser`, with real
capability objects (`visibility`, `tabs`, `playwright`, `content`, and the
tab-scoped APIs), turn-scoped Temporary tabs that close unless marked
`deliverable`/`handoff`, and user-consented claims recorded in a single
`TabLifecycle` (ADR 0348). Remaining gaps in this area are the JS-kernel
programming model, tab groups, and mention deep links.


## 2026-11-27 surface alignment

Aligned with Codex's browser object API:

- Tabs: list/get/new/selected plus background `content` extraction.
- Locators: the Codex method set, including chained filters, waits and
  evaluate/evaluateAll; one in-page program (`locator-script.ts`) shared by
  embedded, CDP and extension backends.
- Page waits: load state, URL, timeout, download and filechooser events.
- DOM CUA: id-tagged visible DOM with click/double-click/scroll/type/keypress/
  download by node id.
- Console logs: level and text filters; history: `from`/`queries`.
- `cua_js` now drives the real `BrowserSession` through `sessionInvoke` and a
  generic proxy, replacing the hand-written tab handle.


## 2026-11-27 settings and runtime alignment

- Browser preferences moved from renderer localStorage into host settings
  (`AppSettings.browser`) with a Codex-shaped Settings section.
- Downloads honor directory and ask-where-to-save; link target and
  external-browser shortcut are read from settings.
- The browser view gained a bookmarks bar, a history panel, an
  extensions/bridge panel and a device toolbar; full-URL display follows the
  setting.
- Agent surfaces gained screenshot clips, clipboard entries, CUA/AX option
  depth, dialog objects, a browser catalog, capability documentation and
  window/group/mention tab fields.
