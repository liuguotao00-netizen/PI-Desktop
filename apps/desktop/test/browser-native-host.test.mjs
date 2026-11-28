import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BROWSER_NATIVE_HOST_NAME,
  extensionIdForPath,
  registerBrowserNativeHost,
} from "../electron/main/browser/native-host.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-native-host-"));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const source = join(root, "host.mjs");
  writeFileSync(source, "console.error('fixture host');\n");
  return { root, home, dataDir, source, execPath: "/Applications/PI-Desktop.app/Contents/MacOS/PI-Desktop" };
}

test("unpacked extension ids derive from the directory path", () => {
  const id = extensionIdForPath("/opt/pi/web-extension");
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(id, extensionIdForPath("/opt/pi/web-extension"));
  assert.notEqual(id, extensionIdForPath("/opt/pi/other-extension"));
});

test("macOS registration installs a launcher and chrome manifests", () => {
  const f = fixture();
  const result = registerBrowserNativeHost({
    dataDir: f.dataDir,
    bridgeEndpoint: "ws://127.0.0.1:47123/pi-browser-native?token=test-token",
    hostScriptPath: f.source,
    execPath: f.execPath,
    extensionPaths: ["/opt/pi/web-extension"],
    platform: "darwin",
    home: f.home,
    env: {},
  });
  assert.equal(result.supported, true);
  assert.deepEqual(result.failures, []);
  assert.ok(result.launcherPath && existsSync(result.launcherPath));
  assert.equal(statSync(result.launcherPath).mode & 0o777, 0o700);
  const launcher = readFileSync(result.launcherPath, "utf8");
  assert.match(launcher, /^#!\/bin\/sh/);
  assert.match(launcher, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(launcher, /PI_BROWSER_BRIDGE_URL='ws:\/\/127\.0\.0\.1:47123\/pi-browser-native\?token=test-token'/);
  assert.ok(launcher.includes(f.execPath));

  const chromeManifest = join(
    f.home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    `${BROWSER_NATIVE_HOST_NAME}.json`,
  );
  assert.ok(existsSync(chromeManifest));
  const manifest = JSON.parse(readFileSync(chromeManifest, "utf8"));
  assert.equal(manifest.name, BROWSER_NATIVE_HOST_NAME);
  assert.equal(manifest.type, "stdio");
  assert.equal(manifest.path, result.launcherPath);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionIdForPath("/opt/pi/web-extension")}/`]);
  // Edge and Brave get the same manifest.
  assert.ok(existsSync(join(f.home, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts", `${BROWSER_NATIVE_HOST_NAME}.json`)));
  assert.ok(existsSync(join(f.home, "Library", "Application Support", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts", `${BROWSER_NATIVE_HOST_NAME}.json`)));
});

test("linux registration honours XDG_CONFIG_HOME", () => {
  const f = fixture();
  const config = join(f.root, "xdg");
  registerBrowserNativeHost({
    dataDir: f.dataDir,
    bridgeEndpoint: "ws://127.0.0.1:47123/pi-browser-native?token=t",
    hostScriptPath: f.source,
    execPath: "/opt/PI-Desktop/pi-desktop",
    extensionPaths: ["/opt/pi/web-extension"],
    platform: "linux",
    home: f.home,
    env: { XDG_CONFIG_HOME: config },
  });
  assert.ok(existsSync(join(config, "google-chrome", "NativeMessagingHosts", `${BROWSER_NATIVE_HOST_NAME}.json`)));
  assert.ok(existsSync(join(config, "microsoft-edge", "NativeMessagingHosts", `${BROWSER_NATIVE_HOST_NAME}.json`)));
});

test("windows registration reports unsupported instead of writing a broken host", () => {
  const f = fixture();
  const result = registerBrowserNativeHost({
    dataDir: f.dataDir,
    bridgeEndpoint: "ws://127.0.0.1:47123/pi-browser-native?token=t",
    hostScriptPath: f.source,
    execPath: "C:\\Program Files\\PI-Desktop\\PI-Desktop.exe",
    extensionPaths: ["C:\\pi\\web-extension"],
    platform: "win32",
    home: f.home,
    env: {},
  });
  assert.equal(result.supported, false);
  assert.match(result.reason ?? "", /Windows/);
});
