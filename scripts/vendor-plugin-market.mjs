/**
 * Vendor the latest published plugin market artifacts into a local directory.
 *
 * The market packages are compiled `.piplug` archives, not source trees, and
 * almost none carry a source repository. This script therefore mirrors the
 * published artifacts (it cannot fork source it does not have), verifies every
 * sha256, optionally extracts them for inspection, and writes a manifest plus
 * per-plugin UPSTREAM.json provenance files. `--check` reports which pinned
 * versions the live catalog has moved past without downloading anything.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const defaultCatalog =
  "https://raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main/catalog.json";
const catalogSource = value("--catalog", defaultCatalog);
const checkOnly = flag("--check");
const output = resolve(value("--out", join(root, "vendor/pi-plugin-market")));
const extract = !flag("--no-extract");
const only = value("--only", "").split(",").map((item) => item.trim()).filter(Boolean);
const concurrency = Math.max(1, Math.min(8, Number(value("--concurrency", "4")) || 4));

async function readCatalog(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(await readFile(resolve(source), "utf8"));
}

let catalog;
try {
  catalog = await readCatalog(catalogSource);
} catch (error) {
  const fallback = join(homedir(), ".pi-desktop-dev/plugins/market/catalog.json");
  console.warn(`[catalog] ${catalogSource} unavailable: ${error instanceof Error ? error.message : String(error)}`);
  console.warn(`[catalog] falling back to ${fallback}`);
  catalog = await readCatalog(fallback);
}
const latest = catalog.plugins.flatMap((plugin) => {
  const versions = (plugin.versions || []).filter((version) => !version.yanked);
  if (!versions.length) return [];
  const version = versions.reduce((best, item) =>
    item.publishedAt > best.publishedAt ? item : best,
  );
  if (only.length && !only.includes(plugin.id)) return [];
  return [{ plugin, version }];
});

if (checkOnly) {
  const previous = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  const pinned = new Map(previous.plugins.map((plugin) => [plugin.id, plugin.version]));
  const updates = [];
  const added = [];
  for (const { plugin, version } of latest) {
    const old = pinned.get(plugin.id);
    if (old === undefined) added.push(`${plugin.id}@${version.version}`);
    else if (old !== version.version) updates.push(`${plugin.id} ${old} -> ${version.version}`);
    pinned.delete(plugin.id);
  }
  for (const [id, version] of pinned) updates.push(`${id} ${version} -> absent`);
  console.log(`catalog updatedAt: ${catalog.updatedAt ?? "unknown"}`);
  console.log(`pinned: ${previous.count}, catalog: ${latest.length}`);
  for (const line of added) console.log(`[new] ${line}`);
  for (const line of updates) console.log(`[update] ${line}`);
  if (added.length || updates.length) {
    console.log(`sync needed: ${added.length} new, ${updates.length} changed`);
    process.exit(1);
  }
  console.log("up to date");
  process.exit(0);
}

await mkdir(join(output, "packages"), { recursive: true });
await mkdir(join(output, "extracted"), { recursive: true });
const manifest = [];
let failed = 0;

async function fetchOne({ plugin, version }) {
  const catalogUrl = String(version.url || "");
  const downloadUrl = (() => {
    try {
      const parsed = new URL(catalogUrl);
      return `${parsed.origin}/download/${encodeURIComponent(plugin.id)}/${encodeURIComponent(version.version)}`;
    } catch {
      return catalogUrl;
    }
  })();
  const url = downloadUrl;
  if (!/^https?:\/\//i.test(url)) {
    failed += 1;
    console.warn(`[skip] ${plugin.id}: invalid package URL`);
    return;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (version.shasum && sha256 !== version.shasum) {
      throw new Error(`sha256 mismatch (expected ${version.shasum}, got ${sha256})`);
    }
    if (version.sizeBytes && bytes.byteLength !== Number(version.sizeBytes)) {
      throw new Error(`size mismatch (expected ${version.sizeBytes}, got ${bytes.byteLength})`);
    }
    const file = join(output, "packages", `${plugin.id}-${version.version}.piplug`);
    await writeFile(file, bytes);
    let extracted = null;
    if (extract) {
      const destination = join(output, "extracted", plugin.id);
      await mkdir(destination, { recursive: true });
      try {
        execFileSync("unzip", ["-q", "-o", file, "-d", destination], { stdio: "ignore" });
        extracted = destination;
      } catch {
        extracted = null;
        console.warn(`[extract-failed] ${plugin.id}`);
      }
    }
    const relativePackage = join("packages", `${plugin.id}-${version.version}.piplug`);
    const relativeExtracted = extract ? join("extracted", plugin.id) : null;
    if (extracted) {
      await writeFile(
        join(extracted, "UPSTREAM.json"),
        JSON.stringify(
          {
            id: plugin.id,
            version: version.version,
            publishedAt: version.publishedAt,
            downloadUrl: url,
            catalogUrl,
            shasum: sha256,
            repository: plugin.repository ?? null,
            homepage: plugin.homepage ?? null,
            license: plugin.license ?? null,
            mirroredAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    manifest.push({
      id: plugin.id,
      name: plugin.name,
      version: version.version,
      publishedAt: version.publishedAt,
      url,
      catalogUrl,
      shasum: sha256,
      sizeBytes: bytes.byteLength,
      permissions: version.permissions || [],
      trust: plugin.trust ?? null,
      verified: plugin.verified === true,
      repository: plugin.repository ?? null,
      homepage: plugin.homepage ?? null,
      license: plugin.license ?? null,
      packagePath: relativePackage,
      extractedPath: relativeExtracted,
    });
    console.log(`[ok] ${plugin.id}@${version.version} ${bytes.byteLength}B`);
  } catch (error) {
    failed += 1;
    console.warn(`[fail] ${plugin.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let cursor = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= latest.length) return;
      await fetchOne(latest[index]);
    }
  }),
);

manifest.sort((a, b) => a.id.localeCompare(b.id));
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      catalog: catalogSource,
      catalogUpdatedAt: catalog.updatedAt ?? null,
      count: manifest.length,
      failed,
      plugins: manifest,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`done: ${manifest.length}/${latest.length}, failed ${failed}`);
console.log(`manifest: ${join(output, "manifest.json")}`);
