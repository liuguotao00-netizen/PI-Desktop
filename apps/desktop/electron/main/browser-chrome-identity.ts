const FALLBACK_CHROME = "140.0.7339.207";
const LOW_ENTROPY = ["Sec-Ch-Ua", "Sec-Ch-Ua-Mobile", "Sec-Ch-Ua-Platform"];

const GREASE_BY_MAJOR: Record<number, { brand: string; version: string }> = {
  140: { brand: "Not=A?Brand", version: "24" },
  148: { brand: "Not/A)Brand", version: "99" },
};

export function chromeVersions(raw = process.versions.chrome): {
  full: string;
  major: string;
} {
  const full = raw && /^\d+\.\d+/.test(raw) ? raw : FALLBACK_CHROME;
  return { full, major: full.split(".")[0] ?? "140" };
}

function greaseFor(major: string): { brand: string; version: string } {
  const hit = GREASE_BY_MAJOR[Number(major)];
  if (hit) return hit;
  const latest = Math.max(...Object.keys(GREASE_BY_MAJOR).map(Number));
  return GREASE_BY_MAJOR[latest] ?? GREASE_BY_MAJOR[140];
}

function uaPlatform(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  if (platform === "linux") return "X11; Linux x86_64";
  return "Windows NT 10.0; Win64; x64";
}

function hintPlatform(platform: NodeJS.Platform): string {
  if (platform === "darwin") return '"macOS"';
  if (platform === "linux") return '"Linux"';
  return '"Windows"';
}

export function chromeUserAgent(
  platform: NodeJS.Platform = process.platform,
  chromeVersion = process.versions.chrome,
): string {
  const { major } = chromeVersions(chromeVersion);
  return `Mozilla/5.0 (${uaPlatform(
    platform,
  )}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function chromeClientHintHeaders(
  platform: NodeJS.Platform = process.platform,
  chromeVersion = process.versions.chrome,
  brand: "chromium" | "chrome" = "chromium",
): Record<string, string> {
  const { full, major } = chromeVersions(chromeVersion);
  const grease = greaseFor(major);
  const brands =
    brand === "chrome"
      ? `"${grease.brand}";v="${grease.version}", "Google Chrome";v="${major}", "Chromium";v="${major}"`
      : `"${grease.brand}";v="${grease.version}", "Chromium";v="${major}"`;
  const fullList =
    brand === "chrome"
      ? `"${grease.brand}";v="${grease.version}.0.0.0", "Google Chrome";v="${full}", "Chromium";v="${full}"`
      : `"${grease.brand}";v="${grease.version}.0.0.0", "Chromium";v="${full}"`;
  return {
    "Sec-Ch-Ua": brands,
    "Sec-Ch-Ua-Full-Version-List": fullList,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": hintPlatform(platform),
  };
}

function isDouyinUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "douyin.com" || host.endsWith(".douyin.com");
  } catch {
    return false;
  }
}

function mergeClientHints(
  headers: Record<string, string>,
  url: string,
  hints: Record<string, string>,
): Record<string, string> {
  const next = { ...headers };
  const https = /^https:\/\//i.test(url);
  const low = new Set(LOW_ENTROPY.map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(hints)) {
    const existing = Object.keys(next).find(
      (name) => name.toLowerCase() === key.toLowerCase(),
    );
    if (existing) {
      next[existing] = value;
      continue;
    }
    if (https && low.has(key.toLowerCase())) next[key] = value;
  }
  return next;
}

export function applyChromeIdentity(ses: Electron.Session): void {
  const ua = chromeUserAgent();
  const chromium = chromeClientHintHeaders(
    process.platform,
    process.versions.chrome,
    "chromium",
  );
  const chrome = chromeClientHintHeaders(
    process.platform,
    process.versions.chrome,
    "chrome",
  );
  ses.setUserAgent(ua);
  ses.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      const hints = isDouyinUrl(details.url) ? chrome : chromium;
      const headers = mergeClientHints(
        details.requestHeaders,
        details.url,
        hints,
      );
      const uaKey = Object.keys(headers).find(
        (key) => key.toLowerCase() === "user-agent",
      );
      if (uaKey) headers[uaKey] = ua;
      else headers["User-Agent"] = ua;
      callback({ requestHeaders: headers });
    },
  );
}
