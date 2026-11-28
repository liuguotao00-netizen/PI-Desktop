import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Native messaging host id registered with each Chromium browser. */
export const BROWSER_NATIVE_HOST_NAME = "com.pi.desktop.browser";

/**
 * Extension ids allowed to launch the host. Loaded-unpacked Chromium builds
 * derive the id from the extension directory path, so the app computes it for
 * each directory it ships; a future store build with a manifest `key` passes
 * its fixed id explicitly.
 */
export function extensionIdForPath(path: string): string {
  const hex = createHash("sha256").update(path, "utf8").digest("hex").slice(0, 32);
  return [...hex].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join("");
}

export type NativeHostRegistration = {
  supported: boolean;
  hostName: string;
  launcherPath: string | null;
  manifestPaths: string[];
  failures: string[];
  reason?: string;
};

type RegisterInput = {
  dataDir: string;
  /** ws://127.0.0.1:<port>/pi-browser-native?token=... served by the app. */
  bridgeEndpoint: string;
  /** Path to the bundled host.mjs; copied into the app data directory. */
  hostScriptPath: string;
  /** The app executable, run with ELECTRON_RUN_AS_NODE=1 by the launcher. */
  execPath: string;
  /** Extension directories whose path-derived Chromium ids may launch the host. */
  extensionPaths?: readonly string[];
  /** Extra extension ids (e.g. a store build pinned by a manifest `key`). */
  extensionIds?: readonly string[];
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeFileIfChanged(path: string, content: string, mode: number): boolean {
  try {
    if (readFileSync(path, "utf8") === content) {
      chmodSync(path, mode);
      return false;
    }
  } catch {
    // Missing file: fall through and write it.
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return true;
}

function chromiumManifestDirs(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): string[] {
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return [
      join(support, "Google", "Chrome", "NativeMessagingHosts"),
      join(support, "Chromium", "NativeMessagingHosts"),
      join(support, "Google", "ChromeForTesting", "NativeMessagingHosts"),
      join(support, "Google", "Chrome for Testing", "NativeMessagingHosts"),
      join(support, "Microsoft Edge", "NativeMessagingHosts"),
      join(support, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      join(support, "com.operasoftware.Opera", "NativeMessagingHosts"),
      join(support, "Vivaldi", "NativeMessagingHosts"),
    ];
  }
  if (platform === "linux") {
    const defaultConfig = join(home, ".config");
    const configHome = env.XDG_CONFIG_HOME?.trim() || defaultConfig;
    const chromeHome = env.CHROME_CONFIG_HOME?.trim() || configHome;
    const dirs = ["google-chrome", "chromium", "google-chrome-beta", "google-chrome-unstable"].map((browser) =>
      join(configHome, browser, "NativeMessagingHosts"),
    );
    dirs.push(
      join(chromeHome, "google-chrome-for-testing", "NativeMessagingHosts"),
      join(configHome, "microsoft-edge", "NativeMessagingHosts"),
      join(configHome, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      join(configHome, "opera", "NativeMessagingHosts"),
      join(configHome, "vivaldi", "NativeMessagingHosts"),
    );
    return dirs;
  }
  return [];
}

/**
 * Installs the native messaging host: a launcher script plus a manifest in
 * every Chromium browser's NativeMessagingHosts directory. The extension then
 * connects with chrome.runtime.connectNative instead of a pasted URL.
 *
 * Windows needs a standalone host executable (Chrome cannot launch a script
 * with an Electron binary), so registration there reports unsupported.
 */
export function registerBrowserNativeHost(input: RegisterInput): NativeHostRegistration {
  const platform = input.platform ?? process.platform;
  const hostName = BROWSER_NATIVE_HOST_NAME;
  const extensionIds = [
    ...new Set([
      ...(input.extensionIds ?? []),
      ...(input.extensionPaths ?? []).map(extensionIdForPath),
    ]),
  ];
  if (!extensionIds.length) {
    return {
      supported: false,
      hostName,
      launcherPath: null,
      manifestPaths: [],
      failures: [],
      reason: "no extension id or extension directory to authorize",
    };
  }
  if (platform === "win32") {
    return {
      supported: false,
      hostName,
      launcherPath: null,
      manifestPaths: [],
      failures: [],
      reason: "native messaging host registration is not implemented on Windows yet",
    };
  }

  const dirs = chromiumManifestDirs(platform, input.home ?? homedir(), input.env ?? process.env);
  if (!dirs.length) {
    return {
      supported: false,
      hostName,
      launcherPath: null,
      manifestPaths: [],
      failures: [],
      reason: `native messaging host registration is not implemented on ${platform}`,
    };
  }

  const hostDir = join(input.dataDir, "native-host");
  mkdirSync(hostDir, { recursive: true, mode: 0o700 });
  const hostScript = join(hostDir, "host.mjs");
  writeFileIfChanged(hostScript, readFileSync(input.hostScriptPath, "utf8"), 0o600);

  const launcherPath = join(hostDir, "pi-browser-host.sh");
  const launcher = [
    "#!/bin/sh",
    "# Generated by PI-Desktop. Recreated on every app start; do not edit.",
    `exec env ELECTRON_RUN_AS_NODE=1 PI_BROWSER_BRIDGE_URL=${shellQuote(input.bridgeEndpoint)} ${shellQuote(input.execPath)} ${shellQuote(hostScript)}`,
    "",
  ].join("\n");
  writeFileIfChanged(launcherPath, launcher, 0o700);

  const manifest = `${JSON.stringify(
    {
      name: hostName,
      description: "PI-Desktop browser bridge",
      path: launcherPath,
      type: "stdio",
      allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
    },
    null,
    2,
  )}\n`;

  const manifestPaths: string[] = [];
  const failures: string[] = [];
  for (const dir of dirs) {
    const path = join(dir, `${hostName}.json`);
    try {
      writeFileIfChanged(path, manifest, 0o600);
      manifestPaths.push(path);
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { supported: true, hostName, launcherPath, manifestPaths, failures };
}

/** True when the app can locate its bundled host script at the given path. */
export function nativeHostScriptExists(path: string): boolean {
  return existsSync(path);
}
