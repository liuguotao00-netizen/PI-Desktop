import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ChromeLaunchOptions = {
  chromePath?: string;
  userDataDir?: string;
  port: number;
  headless?: boolean;
  args?: string[];
  url?: string;
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function chromeCandidates(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
  }
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
      .filter((value): value is string => Boolean(value));
    return roots.flatMap((root) => [
      join(root, "Google/Chrome/Application/chrome.exe"),
      join(root, "Microsoft/Edge/Application/msedge.exe"),
      join(root, "Chromium/Application/chrome.exe"),
      join(root, "BraveSoftware/Brave-Browser/Application/brave.exe"),
    ]);
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
  ];
}

export function findChrome(chromePath?: string): string | null {
  if (chromePath?.trim()) return existsSync(chromePath.trim()) ? chromePath.trim() : null;
  return chromeCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

export async function waitForCdp(endpoint: string, timeoutMs = 15_000): Promise<void> {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" || !LOOPBACK.has(parsed.hostname)) {
    throw new Error("Chrome CDP endpoint must be loopback http");
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${parsed.origin}/json/version`, { signal: AbortSignal.timeout(800) });
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    if (Date.now() >= deadline) throw new Error("Chrome did not expose its DevTools endpoint in time");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function launchChrome(
  options: ChromeLaunchOptions,
): Promise<{ child: ChildProcess; executable: string; userDataDir: string }> {
  const executable = findChrome(options.chromePath);
  if (!executable) {
    throw new Error("Chrome/Chromium/Edge not found; set chromePath explicitly");
  }
  const userDataDir = options.userDataDir?.trim() || join(homedir(), ".pi-desktop", "chrome-cdp-profile");
  await mkdir(userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${options.port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    ...(options.headless ? ["--headless=new", "--disable-gpu"] : []),
    ...(options.args ?? []),
    ...(options.url ? [options.url] : []),
  ];
  const child = spawn(executable, args, { detached: false, stdio: "ignore" });
  child.on("error", () => undefined);
  return { child, executable, userDataDir };
}
