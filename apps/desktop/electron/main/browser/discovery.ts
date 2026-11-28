import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type DiscoveredBrowser = {
  kind: "cdp";
  endpoint: string;
  browser: string;
  protocolVersion: string;
  source: string;
};

const COMMON_PORTS = [9222, 9223, 9224, 9333, 9225, 9226];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function profileCandidates(): Array<{ path: string; source: string }> {
  const home = homedir();
  if (process.platform === "darwin") {
    return [
      { path: join(home, "Library/Application Support/Google/Chrome/DevToolsActivePort"), source: "Chrome" },
      { path: join(home, "Library/Application Support/Google/Chrome Canary/DevToolsActivePort"), source: "Chrome Canary" },
      { path: join(home, "Library/Application Support/Chromium/DevToolsActivePort"), source: "Chromium" },
      { path: join(home, "Library/Application Support/Microsoft Edge/DevToolsActivePort"), source: "Edge" },
      { path: join(home, "Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort"), source: "Brave" },
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(home, "AppData/Local");
    return [
      { path: join(local, "Google/Chrome/User Data/DevToolsActivePort"), source: "Chrome" },
      { path: join(local, "Chromium/User Data/DevToolsActivePort"), source: "Chromium" },
      { path: join(local, "Microsoft/Edge/User Data/DevToolsActivePort"), source: "Edge" },
      { path: join(local, "BraveSoftware/Brave-Browser/User Data/DevToolsActivePort"), source: "Brave" },
    ];
  }
  return [
    { path: join(home, ".config/google-chrome/DevToolsActivePort"), source: "Chrome" },
    { path: join(home, ".config/chromium/DevToolsActivePort"), source: "Chromium" },
    { path: join(home, ".config/microsoft-edge/DevToolsActivePort"), source: "Edge" },
    { path: join(home, ".config/BraveSoftware/Brave-Browser/DevToolsActivePort"), source: "Brave" },
  ];
}

async function probe(endpoint: string, source: string): Promise<DiscoveredBrowser | null> {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(900) });
    if (!response.ok) return null;
    const version = (await response.json()) as {
      Browser?: string;
      "Protocol-Version"?: string;
      webSocketDebuggerUrl?: string;
    };
    if (!version.webSocketDebuggerUrl) return null;
    const ws = new URL(version.webSocketDebuggerUrl);
    if (ws.protocol !== "ws:" || !LOOPBACK.has(ws.hostname)) return null;
    return {
      kind: "cdp",
      endpoint,
      browser: String(version.Browser ?? source),
      protocolVersion: String(version["Protocol-Version"] ?? "unknown"),
      source,
    };
  } catch {
    return null;
  }
}

/**
 * Discover local Chrome-family DevTools endpoints. It only reads loopback
 * DevToolsActivePort files and probes loopback HTTP; nothing leaves the machine.
 */
export async function discoverChromeCdp(): Promise<DiscoveredBrowser[]> {
  const endpoints = new Map<string, string>();
  for (const candidate of profileCandidates()) {
    try {
      const text = await readFile(candidate.path, "utf8");
      const port = Number.parseInt(text.split(/\r?\n/, 1)[0]?.trim() || "", 10);
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        endpoints.set(`http://127.0.0.1:${port}`, candidate.source);
      }
    } catch {
      // No active DevTools port for this profile.
    }
  }
  for (const port of COMMON_PORTS) {
    const endpoint = `http://127.0.0.1:${port}`;
    if (!endpoints.has(endpoint)) endpoints.set(endpoint, "port scan");
  }
  const results = await Promise.all(
    [...endpoints.entries()].map(([endpoint, source]) => probe(endpoint, source)),
  );
  const seen = new Set<string>();
  return results.filter((entry): entry is DiscoveredBrowser => {
    if (!entry || seen.has(entry.endpoint)) return false;
    seen.add(entry.endpoint);
    return true;
  });
}
