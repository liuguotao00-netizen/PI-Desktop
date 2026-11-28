# CUA remaining projects

Split from the Codex-parity work on 2026-11-26. The current working tree keeps
the completed CUA runtime, sandbox policy, claim UI, WebMCP tools and browser
loop uncommitted.

## 1. Native OS sandbox (Windows/Linux)

Interim state after the 2026-11-26 refactor: `plugin-sandbox-policy.mjs` exposes
`osSandbox: "sandbox-exec" | "none"` and refuses implicit executables off macOS;
a process plugin must declare `processAllowlist`. This is fail-closed, but it is
not a native sandbox yet.


Current state:

- macOS plugin child processes use `sandbox-exec` with a process-exec allowlist.
- Plugins without process permission run under Node's Permission Model.
- Windows/Linux still rely on the process allowlist and Node permissions, not an
  OS-level sandbox.

Acceptance:

- Windows: Job Object/AppContainer profile created per plugin process, child
  process creation denied except the allowlist.
- Linux: seccomp/landlock profile applied before plugin code runs; execve
  allowlist enforced.
- Verified by a plugin probe that tries to spawn a non-allowlisted binary and
  must receive a platform refusal.

Depends on: native host code and real Windows/Linux runners.

## 2. macOS CUA live E2E — done

Verified on 2026-11-26 by `pnpm test:e2e:cua-macos-input`. Evidence:
`docs/cua-macos-e2e-evidence.md`.

## 3. MCP Apps host

Current state:

- `mcpapps` backend kind exists but maps only browser_* tools.
- No MCP App resource lifecycle or UI host sandbox.

Acceptance:

- Discover MCP resources and tools from the server.
- Mount a sandboxed MCP App surface in the work panel.
- Route tool calls with the same permission gate as plugin panels.
- Lifecycle: open, navigate, tool call, close, crash recovery.

Depends on: MCP Apps protocol implementation and a real MCP Apps server.
