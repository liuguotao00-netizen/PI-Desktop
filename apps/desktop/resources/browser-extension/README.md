# PI-Desktop Browser Bridge extension

1. Open `chrome://extensions` (or `edge://extensions`) and enable Developer mode.
2. Choose **Load unpacked** and select this directory. Chromium derives the
   extension id from the directory path; PI-Desktop computes the same id for the
   copy it ships and authorizes it in the native host manifest.
3. Start PI-Desktop once. It installs the native messaging host
   `com.pi.desktop.browser` into every Chromium browser it can find
   (`NativeMessagingHosts` directories for Chrome, Chromium, Chrome for
   Testing, Edge, Brave, Opera, Vivaldi on macOS and Linux).
4. In PI-Desktop Settings → Browser backend, choose `Extension` and connect.
   No URL is needed: the extension reaches the app through
   `chrome.runtime.connectNative`.

If the options page reports `Specified native messaging host not found` right
after PI-Desktop installed the host for the first time, restart the browser
once and reload the extension (`chrome://extensions` → reload).

A browser launched with a custom `--user-data-dir` reads native host manifests
from `<user-data-dir>/NativeMessagingHosts` instead of the per-user browser
directory; copy `com.pi.desktop.browser.json` there, or use the WebSocket
fallback below.

## Fallback: WebSocket URL

Where the native host is not available (currently Windows, or a browser whose
manifest directory was not writable), copy the **Extension bridge** URL from
Settings and paste it into the extension options. The extension then uses the
loopback WebSocket bridge with that token. Saving a URL switches to the
WebSocket transport; the native host is retried by the 30s reconnect alarm.

The bridge is loopback-only. The extension attaches Chrome Debugger to the tab
it is asked to operate on and speaks the same `tabs.*` / `page.*` protocol as
the CDP backend.
