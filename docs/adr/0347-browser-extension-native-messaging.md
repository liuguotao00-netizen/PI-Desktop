# ADR 0347: Browser extension connects through a native messaging host

- Status: Accepted
- Date: 2026-11-27
- Related: [browser-backend-abstraction](browser-backend-abstraction.md) ·
  [browser-automation-tool-surface](browser-automation-tool-surface.md) ·
  Codex's `com.openai.codexextension` host as prior art

## Context

The MV3 extension reached the app through a loopback WebSocket bridge
(`ws://127.0.0.1:47123/pi-browser?token=…`). The token was created per app
install and had to be copied from Settings into the extension options. That
pairing failed in practice whenever the copy was stale, the bridge token file
was lost, or the service worker reconnected while the app was starting —
symptom: `extension bridge is not connected`, `ERR_CONNECTION_REFUSED`, or
`1008 extension token required`.

Chrome offers a transport that removes pairing altogether: native messaging.
The extension calls `chrome.runtime.connectNative(name)`; Chrome launches the
registered host process and validates the calling extension against the host
manifest's `allowed_origins`. Codex uses exactly this model (a stdio host that
relays to its app-server over a loopback socket with a token). The host is only
ever started on demand, so "the bridge is not listening yet" cannot happen.

## Decision

1. **Native messaging is the primary transport.** The app installs a host
   manifest named `com.pi.desktop.browser` into every Chromium browser's
   `NativeMessagingHosts` directory (Chrome, Chromium, Chrome for Testing, Edge,
   Brave, Opera, Vivaldi) on macOS and Linux. The manifest points at a launcher
   script generated in the app data directory, which runs the bundled
   `resources/browser-native-host/host.mjs` with `ELECTRON_RUN_AS_NODE=1`.
   Windows reports unsupported until a signed standalone host executable ships;
   Chrome cannot launch a script there.
2. **The allowed extension id is computed from the extension directory.** Chromium
   derives the id of a Load-unpacked extension from its absolute path, so the app
   hashes each directory it ships (`resources/browser-extension`, also under the
   packaged Resources directory) and lists those ids in the host manifest's
   `allowed_origins`. A future store build that pins an id with a manifest `key`
   passes that id explicitly.
3. **The host relays Chrome stdio frames to the existing bridge.** Chrome's
   4-byte little-endian length framing maps 1:1 onto the bridge's
   `{id, method, params}` / `{id, result | error}` frames. The host connects to
   the bridge's `/pi-browser-native` path, which is authenticated by the
   per-install token in `<dataDir>/extension-bridge-token` (mode 0600) and does
   not require an extension `Origin` header (a native process cannot send one).
   The extension-origin path `/pi-browser` is unchanged: it still requires both
   a `chrome-extension://` origin and the token.
4. **The WebSocket URL remains a fallback.** A stored `bridgeUrl` is used when
   the native host is unavailable, which keeps the browser-extension E2E and
   setups without the host working. Saving a URL in the options page forces the
   WebSocket transport and drops the native port.
5. **Reconnect is alarm-driven.** The extension retries native messaging on a
   30s alarm, with an in-worker backoff of 2s doubling to 30s, and pings the
   active transport every 20s to keep the MV3 worker alive. A host that cannot
   reach the bridge exits so Chrome reports a clean disconnect.

## Consequences

- The extension no longer needs a URL or token on the native path; the user
  only loads the unpacked extension once.
- The host authorizes the unpacked extension's path-derived id, so moving the
  extension directory changes the id; restarting the app recomputes and
  rewrites the manifest.
- Windows has no native messaging until a platform host executable exists; the
  WebSocket fallback covers it in the meantime.
- A browser started with a custom `--user-data-dir` reads native host manifests
  from `<user-data-dir>/NativeMessagingHosts`; the app cannot discover that path,
  so such profiles need the manifest copied there or the WebSocket fallback.
- The token file (0600) and the host manifest's `allowed_origins` are the trust
  boundary: another local process running as the same user can read the token,
  exactly as it could read the file before. Other extensions cannot launch the
  host.
- The app rewrites the launcher and manifests on every start; stale files are
  harmless and point at the same host name.

## Alternatives

- **Keep URL copy-paste only.** Rejected after it produced repeated, hard-to-
  diagnose pairing failures.
- **Ship a Rust host binary like Codex.** Faithful but adds cross-platform
  build, signing, and notarization work; the Node host is sufficient on macOS
  and Linux and runs under the app's own Electron binary.
- **Auto-pair over an unauthenticated loopback HTTP endpoint.** Rejected: it
  would expose the token to any sandboxed local process, weakening the boundary.
