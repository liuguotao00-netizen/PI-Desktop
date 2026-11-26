/**
 * Sync source forks under vendor/pi-plugin-market/forks.
 *
 * The market mostly publishes compiled artifacts, so only plugins with a real
 * upstream Git repository have a source fork here. This script downloads the
 * upstream tarball, reads the commit and manifest version, and either reports
 * the difference (`--check`, the default) or replaces the snapshot with
 * `--apply`. It never runs git and never commits local changes.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const forks = join(root, "vendor/pi-plugin-market/forks");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const apply = flag("--apply");
const only = value("--only", "").split(",").map((item) => item.trim()).filter(Boolean);

const tarballCache = new Map();

async function fetchTarball(url) {
  if (tarballCache.has(url)) return tarballCache.get(url);
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(300_000),
        headers: {
          "user-agent": "pi-desktop-plugin-fork-sync",
          ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      tarballCache.set(url, buffer);
      return buffer;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError;
}

function normalizeIdentity(value) {
  return String(value).toLowerCase().replace(/^@[^/]+\//, "").replace(/[._]/g, "-");
}

async function findSourceRoot(directory, wanted, depth) {
  if (depth > 5) return null;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const name of ["manifest.json", "package.json"]) {
    const file = join(directory, name);
    if (!existsSync(file)) continue;
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      const identity = name === "manifest.json" ? value.id : value.name;
      if (typeof identity === "string" && normalizeIdentity(identity) === wanted) {
        return { root: directory, version: String(value.version ?? "") };
      }
    } catch {
      // Keep walking.
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
    const found = await findSourceRoot(join(directory, entry.name), wanted, depth + 1);
    if (found) return found;
  }
  return null;
}

function tarballUrl(upstream) {
  const repository = String(upstream.repository ?? "");
  if (repository.startsWith("https://github.com/")) {
    const branch = String(upstream.branch ?? "HEAD");
    const ref = branch && branch !== "HEAD" ? `refs/heads/${branch}` : "HEAD";
    return `https://codeload.github.com/${repository.slice("https://github.com/".length)}/tar.gz/${ref}`;
  }
  return upstream.tarball;
}

async function inspectSnapshot(upstream) {
  const bytes = await fetchTarball(tarballUrl(upstream));
  const directory = await mkdtemp(join(tmpdir(), "pi-fork-"));
  try {
    const archive = join(directory, "source.tar.gz");
    await writeFile(archive, bytes);
    execFileSync("tar", ["-xzf", archive, "-C", directory], { stdio: "ignore" });
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== "source.tar.gz")
      .map((entry) => entry.name);
    const top = entries[0];
    if (!top) throw new Error("tarball has no top-level directory");
    const sourceRoot = String(upstream.sourceRoot ?? "");
    let root = sourceRoot ? join(directory, top, sourceRoot) : join(directory, top);
    const wanted = normalizeIdentity(upstream.id);
    const identityAt = async (directory) => {
      for (const name of ["manifest.json", "package.json"]) {
        const file = join(directory, name);
        if (!existsSync(file)) continue;
        try {
          const value = JSON.parse(await readFile(file, "utf8"));
          const identity = name === "manifest.json" ? value.id : value.name;
          if (typeof identity === "string" && normalizeIdentity(identity) === wanted) return true;
        } catch {
          // Treat malformed metadata as no match.
        }
      }
      return false;
    };
    if (!(await identityAt(root))) {
      const found = await findSourceRoot(join(directory, top), wanted, 0);
      if (found) root = found.root;
      else if (upstream.layout !== "package") {
        throw new Error("tarball has no matching manifest.json or package.json");
      }
    }
    if (!existsSync(join(root, "manifest.json")) && !existsSync(join(root, "package.json"))) {
      throw new Error("tarball has no manifest.json or package.json");
    }
    let version = "";
    if (existsSync(join(root, "manifest.json"))) {
      version = String(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")).version ?? "");
    } else if (existsSync(join(root, "package.json"))) {
      version = String(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version ?? "");
    } else {
      throw new Error("tarball has no manifest.json or package.json");
    }
    const rawCommit = top.includes("-") ? top.slice(top.lastIndexOf("-") + 1) : "";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const commit = /^[0-9a-f]{7,40}$/i.test(rawCommit) ? rawCommit : sha256.slice(0, 16);
    return {
      directory,
      source: root,
      // Codeload archives do not carry the commit in the top directory name;
      // the archive hash is still a stable change detector.
      commit,
      version,
      sha256,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const entries = (await readdir(forks, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((id) => !only.length || only.includes(id));

let changed = 0;
let failed = 0;
let cursor = 0;
async function syncOne(id) {
  const upstreamPath = join(forks, id, "UPSTREAM.json");
  if (!existsSync(upstreamPath)) return;
  const upstream = JSON.parse(await readFile(upstreamPath, "utf8"));
  try {
    const inspected = await inspectSnapshot(upstream);
    try {
      const moved =
        inspected.commit !== upstream.commit || inspected.version !== upstream.version;
      if (!moved) {
        console.log(`[ok] ${id}@${inspected.version} ${inspected.commit}`);
        return;
      }
      changed += 1;
      console.log(
        `[update] ${id} ${upstream.version}@${upstream.commit} -> ${inspected.version}@${inspected.commit}`,
      );
      if (apply) {
        for (const child of await readdir(join(forks, id))) {
          if (child === "UPSTREAM.json") continue;
          await rm(join(forks, id, child), { recursive: true, force: true });
        }
        await cp(inspected.source, join(forks, id), { recursive: true, force: true });
        await writeFile(
          upstreamPath,
          JSON.stringify(
            {
              ...upstream,
              commit: inspected.commit,
              version: inspected.version,
              sha256: inspected.sha256,
              fetchedAt: new Date().toISOString(),
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );
        console.log(`[applied] ${id}`);
      }
    } finally {
      await rm(inspected.directory, { recursive: true, force: true });
    }
  } catch (error) {
    failed += 1;
    console.warn(`[fail] ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await Promise.all(
  Array.from({ length: Math.min(4, entries.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length) return;
      await syncOne(entries[index]);
    }
  }),
);

console.log(`done: ${entries.length} forks, ${changed} changed, ${failed} failed`);
if (apply) process.exit(failed ? 1 : 0);
process.exit(changed || failed ? 1 : 0);
