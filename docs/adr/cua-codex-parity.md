# ADR: CUA parity with Codex

- Status: accepted
- Date: 2026-11-25
- Related: `browser-backend-abstraction.md`, ADR 0342, ADR 0344

## Context

Codex ships two CUA surfaces with different platform scopes:

- `unified-computer-use` (browser) is cross-platform and fronts IAB, Chrome,
  extensions and MCP Apps through one session API.
- `computer-use` (native apps) is macOS-only: its manifest describes macOS
  desktop control, and the app-managed service is `Codex Computer Use.app`.

PI-Desktop must match that end state without pretending that every third-party
community plugin defines Codex parity. Cross-platform native desktop control is
therefore a plugin responsibility on Windows/Linux, not a host-core backend
requirement.

## Decision

### Native CUA

- host-core implements three native backends behind the same `Desktop` trait:
  - macOS Accessibility (`macos-ax`)
  - Windows UI Automation (`windows-uia`)
  - Linux AT-SPI (`linux-atspi`)
- Windows uses UIA patterns for invocation, value, selection and scroll, and
  synthesizes pointer/key input only for actions UIA does not expose.
- Linux reads the AT-SPI tree over D-Bus. Input that AT-SPI cannot synthesize
  is dispatched with `xdotool`; Wayland sessions refuse synthetic input rather
  than falling back to an X11 tool that may hit the wrong surface.
- Plugins may still provide alternative CUA surfaces, but must declare
  `computer.control`; the plugin host refuses desktop-control tools without it,
  and refuses `child_process` for plugins with `computer.control`.
- Plugin process spawning is additionally checked: shell interpreters require
  `system.shell`, and known desktop automation binaries (`cua-driver`,
  `osascript`, `xdotool`, `powershell`, screenshots tools) are refused so the
  host grant cannot be bypassed through a helper process.

Browser control is cross-platform; native app control now has a built-in
backend on all three desktop platforms.

### Unified session

`CuaSessions` is the per-session state that combines:

```text
browser backend binding
selected browser tab
selected desktop target
computer capabilities
live grant
desktop targets
```

It is exposed through `cua.state` / `cua.bind` / `cua.clear`. The state is
in-memory and session-scoped, exactly like the browser binding; it is not
persisted across app restart.

### Persistent grant

The computer-use grant is owned by host-core and survives across tool calls in
one session until it is revoked, expires or exhausts its action budget. A second
session cannot take it over.

### Action surface

The native loop accepts:

```text
click
double_click
right_click
set_value
press_keys
scroll
select
drag
launch_app
paste_text
secondary_action
```

`drag`, `launch_app`, `paste_text` and `secondary_action` are host-side
validated; `secondary_action` is a closed AX verb list, and `launch_app` accepts
only a bounded, non-flag application name or absolute application path.

### Unified agent runtime

`CuaRuntime` and the bundled `pi.cua` plugin expose one session-bound CUA
surface:

```text
cua_state / cua_bind / cua_clear
cua_app / cua_browser / cua_create_tab
cua_claim_tab / cua_release_tab
cua_act
cua_js / cua_js_reset
```

`cua_js` is a persistent per-session VM with `cua.getApp`, `cua.getTab`,
`cua.getBrowser`, `cua.act`, `emitImage` and bounded output. Tab claims require
a native Allow/Deny confirmation and can be released from the work-panel tab
badge or the claim banner.

`pi.browser-loop` adds a model-driven `browser_run` loop over observe, click,
fill, navigate, wait and screenshot, with step/time limits and cancellation.

### Browser parity

Chrome launch/profile/headless/args, CDP discovery, transport status, file
chooser, downloads, locator, same-origin and cross-origin frames, console,
network, dialogs, screenshots, reconnect and tab operations are implemented in
`browser/`. Plugin tools that launch a browser must declare `browser.launch`.

## Consequences

- Windows/Linux users get native CUA from host-core without installing a
  plugin.
- A missing accessibility service or Wayland restrictions still surface as
  `unsupported`/`input_unsupported_reason`, never as silent success.
- A first-party portal-based Wayland input path can replace the `xdotool`
  fallback without changing the tool surface.

## macOS TCC responsibility

Electron spawns host-core through `crates/host-launcher`. The launcher calls
`responsibility_spawnattrs_setdisclaim` and then `posix_spawn` with
`POSIX_SPAWN_SETEXEC`, so Accessibility is evaluated against the authorized
`pi-desktop-host-core` binary instead of the GUI app that started it. This keeps
the dev and packaged flows on one grant and avoids requiring a second grant for
each Electron build.

## Session selection, claims and grants

`CuaSessions` keeps the latest app target and browser tab per agent session in
Electron main memory. `claimTab` additionally records the tab the user handed
over. Both are deliberately ephemeral: a restart clears selections and claims,
so no stale permission survives into a new process.

The authority is separate. host-core owns the grant, its target scope, action
budget, revision and expiry. Rebinding to another target calls
`computer.inspect` and refreshes the grant; it never widens the old one. A
restart therefore requires a fresh grant even though the UI may restore the
work-panel tab.

## Codex-style browser handles

`cua_js` exposes a Codex-shaped surface over the unified runtime:

```js
const browser = await cua.browsers.getForUrl(url);
const tabs = await browser.tabs.list();
const tab = await browser.tabs.get(tabs[0].tabId);
await browser.user.claimTab(tab);
await (await browser.capabilities.get("visibility")).set(true);
```

`browser.tabs.list()` returns tab handles, not plain records, so the same object
supports navigation, snapshot, screenshot, click/fill, evaluation, upload,
download, frame and dialog operations. The flat `browser_*` tools remain as
compatibility adapters for plugins.
