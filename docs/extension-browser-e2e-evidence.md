# Extension browser E2E evidence

Date: 2026-11-26
Command:

```bash
pnpm test:e2e:extension-browser
```

Environment: Playwright Chromium (`Google Chrome for Testing`) with
`--load-extension=apps/desktop/resources/browser-extension`.

Result:

```text
ok: true
tabs: 2
title: Ext E2E
snapshotChars: 12
```

Covered: extension bridge token endpoint, origin check, storage-driven
reconnect, `tabs.list`, `page.evaluate`, `page.snapshot`.

## Native messaging transport (2026-11-27)

Native messaging is now the primary transport
([ADR 0347](adr/0347-browser-extension-native-messaging.md)). Evidence from the
live app (macOS, Chrome 158, unpacked extension whose id is derived from
`apps/desktop/resources/browser-extension`):

- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.pi.desktop.browser.json`
  written with `type: stdio`, the path-derived extension id in `allowed_origins`,
  and the launcher path.
- `~/.pi-desktop-dev/native-host/pi-browser-host.sh` (0700) runs the copied
  `host.mjs` with `ELECTRON_RUN_AS_NODE=1` and the bridge endpoint baked in.
- Extension storage after reload: `{"state":"connected","transport":"native",
  "host":"com.pi.desktop.browser"}` even with a stored fallback URL; the app's
  bridge shows an established connection from the host process
  (`…/PI-Desktop.app/Contents/MacOS/PI-Desktop …/native-host/host.mjs`).
- The acceptance Chrome runs with `--user-data-dir=/tmp/pi-cdp-manual`, which
  makes Chrome read `<user-data-dir>/NativeMessagingHosts`; the manifest was
  copied there for the test. Per-user browser directories are written
  automatically.
- `pnpm --filter @pi-desktop/desktop test`: native host registration, stdio
  relay, native-path auth and the WebSocket fallback suites pass.
- WebSocket fallback still verified by `pnpm test:e2e:extension-browser`.

Note: restart the browser if Chrome reports `Specified native messaging host
not found` after the host was first installed.

### Extension backend live acceptance (same day)

- Settings-equivalent `browser/backend/connect` for the active session returned
  `backendId: "extension:in-app-bridge"`, `kind: "extension"`, and the Chrome
  tab id.
- `browser_navigate` moved the real Chrome tab to `https://example.com` (the
  Chrome CDP target shows that page and title), and `browser_snapshot` returned
  the page tree (`title: "Example Domain"`, 7 refs, `Learn more` link).
- Found and fixed an extension bug on the way: a failed
  `chrome.debugger.attach` (the tab started as `chrome://newtab`) was cached as
  attached, so later calls sent commands without attaching. Attachment is now
  recorded only on success, retried once on `not attached`, and cleared on
  `chrome.debugger.onDetach`.
- `browser_click` on ref `e7` (Learn more) succeeded (attempts: 1) and the real
  Chrome tab navigated to `https://www.iana.org/help/example-domains`
  (`Example Domains`). Two supporting fixes: element clicks are deferred with
  `setTimeout(0)` so the evaluate returns before a navigation destroys its
  context, and the plugin's double-`requestAnimationFrame` waits fall back to a
  200 ms timer because Chrome throttles rAF in background windows.
- `browser_take_screenshot` succeeded through the extension. With
  `filename: acceptance.png` it saved a 121,827-byte 1310×1156 PNG, and after
  honoring the plugin's requested format a 79,237-byte 1310×1190 JPEG; both
  validated with `sips`. The full base64 payload crosses native messaging, the
  host, and the bridge intact.
- `browser_download` with `url: https://example.com/` completed through
  `chrome.downloads`. Chrome writes to the browser download directory, so the
  app moves the completed file into the session scratch directory before
  returning: `…/scratch/<sessionId>/pi-scratch-test.html`, 577 bytes, and the
  `~/Downloads` copy is gone.
