/**
 * Discover plugins whose packaged artifact came from a public GitHub source.
 *
 * Most catalog entries have no repository metadata. This script collects
 * GitHub URLs mentioned in the extracted package, fetches each candidate's
 * root manifest.json from raw.githubusercontent.com, and keeps only candidates
 * whose manifest id matches the catalog id. It writes a review file; it does
 * not create forks.
 */

import { readFile, readdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const vendor = join(root, "vendor/pi-plugin-market");
const extracted = join(vendor, "extracted");
const output = join(vendor, "forks/UPSTREAM-CANDIDATES.json");
let existing = [];
try {
  existing = JSON.parse(await readFile(output, "utf8")).matches ?? [];
} catch {
  existing = [];
}
const cachePath = join(vendor, "forks/DISCOVERY-CACHE.json");
let cache = {};
try {
  cache = JSON.parse(await readFile(cachePath, "utf8"));
} catch {
  cache = {};
}
for (const match of existing) cache[match.repository] = match.id;
const URL_RE = /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g;
const IGNORED = new Set([
  "vastsa/PI-Desktop",
  "vastsa/pi-desktop-plugins",
  "earendil-works/pi-coding-agent",
  "AIUO-Net/pi-desktop-plugins",
  "Tioit-Wang/PI-Desktop",
]);

async function candidatesFor(id) {
  const directory = join(extracted, id);
  const urls = new Set();
  const walk = async (path, depth) => {
    if (depth > 2 || !existsSync(path)) return;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(child, depth + 1);
        continue;
      }
      if (!/\.(md|json|js|mjs|cjs|txt)$/i.test(entry.name)) continue;
      const text = await readFile(child, "utf8").catch(() => "");
      for (const match of text.matchAll(URL_RE)) {
        const value = match[0].replace(/\.git$/, "").replace(/[).,]+$/, "");
        const repo = value.replace("https://github.com/", "");
        if (!IGNORED.has(repo)) urls.add(value);
      }
    }
  };
  await walk(directory, 0);
  return [...urls];
}

function normalizeIdentity(value) {
  return String(value).toLowerCase().replace(/^@[^/]+\//, "").replace(/[._]/g, "-");
}

async function manifestIdFromTarball(url) {
  const repo = url.replace("https://github.com/", "");
  const directory = await mkdtemp(join(tmpdir(), "pi-discover-"));
  try {
    const response = await fetch(`https://codeload.github.com/${repo}/tar.gz/HEAD`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return null;
    const archive = join(directory, "source.tar.gz");
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const extractJson = (pattern) => {
      try {
        return JSON.parse(
          execFileSync("tar", ["-xOzf", archive, `--include=${pattern}`], {
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
          }),
        );
      } catch {
        return null;
      }
    };
    const manifest = extractJson("*/manifest.json");
    if (typeof manifest?.id === "string") return manifest.id;
    const pkg = extractJson("*/package.json");
    return typeof pkg?.name === "string" ? pkg.name : null;
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function manifestId(url) {
  const repo = url.replace("https://github.com/", "");
  if (Object.prototype.hasOwnProperty.call(cache, url)) return cache[url];
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/contents/manifest.json`, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        "user-agent": "pi-desktop-plugin-fork-discovery",
        accept: "application/vnd.github+json",
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    });
    if (response.status === 403) {
      const found = await manifestIdFromTarball(url);
      cache[url] = found;
      return found;
    }
    if (!response.ok) {
      cache[url] = null;
      return null;
    }
    const body = await response.json();
    if (!body || body.type !== "file" || typeof body.content !== "string") return null;
    const manifest = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
    const found = typeof manifest.id === "string" ? manifest.id : null;
    cache[url] = found;
    return found;
  } catch (error) {
    if (error instanceof Error && error.message === "rate limited") throw error;
    return null;
  }
}

const ids = (await readdir(extracted, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const matches = [...existing];
const pending = [];
const seenRepos = new Set();
let cursor = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= ids.length) return;
      const id = ids[index];
      const candidates = await candidatesFor(id);
      for (const repository of candidates) {
        if (seenRepos.has(repository)) continue;
        seenRepos.add(repository);
        const repoName = repository.split("/").pop().toLowerCase();
        const tokens = id.toLowerCase().split(/[._-]+/).filter((token) => token.length > 2);
        const score = tokens.some((token) => repoName.includes(token)) ? 3 : 1;
        pending.push({ id, repository, score });
      }
    }
  }),
);
const uncached = pending.filter((item) => !Object.prototype.hasOwnProperty.call(cache, item.repository));
uncached.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
const offset = Math.max(0, Number(value("--offset", "0")) || 0);
const limited = uncached.slice(offset, offset + (Number(value("--limit", "55")) || 55));
cursor = 0;
let limitedOut = false;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= limited.length || limitedOut) return;
      const item = limited[index];
      try {
        const found = await manifestId(item.repository);
        if (found && normalizeIdentity(found) === normalizeIdentity(item.id)) {
          matches.push({ id: item.id, repository: item.repository });
        }
      } catch {
        limitedOut = true;
        return;
      }
    }
  }),
);
const unique = new Map(matches.map((match) => [match.id, match]));
matches.length = 0;
matches.push(...unique.values());
matches.sort((a, b) => a.id.localeCompare(b.id));
await writeFile(cachePath, JSON.stringify(cache, null, 2) + "\n", "utf8");
await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), count: matches.length, matches }, null, 2) + "\n", "utf8");
console.log(`candidates: ${pending.length}, confirmed: ${matches.length}`);
for (const match of matches) console.log(`${match.id} ${match.repository}`);
