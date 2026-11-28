# Uncommitted CUA/browser architecture review

Date: 2026-11-26
Scope: the uncommitted CUA, browser-backend, plugin-sandbox and host-launcher
changes on `feat/vendor-plugin-forks` (HEAD `16a33a9`).

## Verdict

The main boundaries are clear:

```text
Renderer
  UI, claim banner, work-panel tabs
      │ IPC
Electron Main
  CuaRuntime / CuaSessions      session selection, claim, action routing
  BrowserRouter / BrowserService
  PluginRuntime                 permission gate, plugin host API
      │ RPC
host-core
  grant scope, budget, revision, AX/UIA/AT-SPI execution
      │
macOS sandbox-exec / Windows UIA / Linux AT-SPI
```

The weak point is not the CUA boundary. It is the plugin runtime, which still
carries a large amount of unrelated host API logic in one file. It is now
ratcheted, but not fully decomposed.

Architecture score after the second refactor: **9.0 / 10**.

## Layer review

### Clear

- **host-core is the authority.** Grants, budgets, revisions and native actions
  live in host-core; Electron does not mint authority.
- **CuaSessions is only session state.** Target/tab selection and claims are
  ephemeral; the grant is not.
- **Browser backends are capability-scoped.** `BrowserRouter` selects the
  backend; backend implementations do not leak into `BrowserHost`.
- **Plugin host API is permission-gated.** `computer.control`,
  `browser.cdp`, `browser.launch`, `system.process`, `system.shell` and
  `processAllowlist` are enforced before work reaches a service.
- **Platform adaptation is isolated.** macOS TCC disclaim lives in
  `crates/host-launcher`, not in Electron main.
- **The plugin call surface is separated.** `plugin-host-process.mjs` is 822 LOC;
  the `pi.*` object lives in `plugin-host-api/api-surface.mjs`.

### Still muddy

- `plugin-runtime.ts` is **6,884 LOC** (ratcheted at 7,000). CUA, browser and
  agent.complete were extracted; the class still owns plugin loading,
  permissions, fs, shell, bus, themes, ui, desktop, audio, net and tools.
- `plugin-host-api/browser.ts` is a 465-line mapping layer. It is cohesive, but
  it depends on the full `BrowserService` interface; a narrower port would make
  it easier to test.
- Windows/Linux OS sandbox is **not implemented**. The policy is fail-closed:
  no implicit executables off macOS; a process plugin must declare its
  `processAllowlist`.
- `mcpapps` is only a backend kind alias today; it is not an MCP Apps host.

## Codex parity matrix

Status: yes / partial / no / unverified.

| Area | PI-Desktop | Codex reference | Gap |
| --- | --- | --- | --- |
| Native macOS CUA | yes, live E2E | Codex Computer Use.app, macOS | none for the tested path |
| Native Windows CUA | implemented, not live-tested | Codex native CUA is macOS-only | PI-Desktop has code; verification missing |
| Native Linux CUA | implemented, not live-tested | not a Codex native surface | AT-SPI/Wayland behavior unverified |
| Browser backends | embedded, CDP, extension, MCP, mcpapps alias | IAB, Chrome extension, CDP, MCP Apps | no real IAB wrapper; MCP Apps is not a host |
| Unified session API | yes | `unified-computer-use` | close |
| Persistent JS | `cua_js` persistent VM, app/tab/browser handles, capture, emitImage | Codex-style `cua_repl` | narrower runtime; no full REPL/module surface |
| Tab claim | browser-local tab strip + per-tab claim dot, native Allow/Deny, release banner | browser tab-bar-level claim | aligned for the PI work-panel browser |
| Browser agent loop | `browser_run`: observe, screenshot, act, wait (including idle), upload/download, frame/dialog, budgets, cancel, failure recovery | Codex observe/act loop | no long-horizon memory or full replanning |
| WebMCP | `browser_webmcp_list` / `call` | WebMCP | close for page tools |
| MCP Apps | backend kind and browser_* mapping only | MCP Apps resource/UI host | no resource lifecycle or UI sandbox |
| Plugin sandbox | macOS sandbox-exec + Node permission + allowlist; Windows/Linux fail-closed | host-level native control | Windows/Linux have no OS sandbox |
| Live E2E | macOS host-core inspect/set_value/click/revoke; app TCC self-test | Codex app service | Windows/Linux E2E missing |
| Browser breadth | CDP, frames, locator, downloads, uploads, console, network, dialogs, screenshots | Codex browser surface | mostly covered; backend-specific gaps remain |

## Highest-value gaps

1. **Windows/Linux OS sandbox.** The current policy is fail-closed but not
   native. This is the largest security-parity gap.
2. **MCP Apps host.** A backend kind is not parity; Codex exposes MCP Apps
   resources and UI.
3. **Browser tab-bar-level claim.** A browser-local tab strip now carries the
   per-tab claim dot.
4. **Browser loop horizon.** Idle waits and failure recovery landed; longer
   planning memory and explicit replanning remain.
5. **`cua_repl` surface.** The persistent VM is useful, but it is a restricted
   API surface, not a full Codex-style REPL.

## Do not regress

- Keep host-core grants authoritative.
- Keep claim/selection ephemeral; never persist a claim as permission.
- Keep backend capability checks in `BrowserRouter`, not in tools.
- Keep TCC disclaim in `host-launcher`.
- Keep the plugin sandbox policy in one module.
