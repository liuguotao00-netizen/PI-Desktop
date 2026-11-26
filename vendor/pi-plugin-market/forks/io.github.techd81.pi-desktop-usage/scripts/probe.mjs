#!/usr/bin/env node
/**
 * Development-only reconciliation probe.
 *
 * Scans the real session directories into a throwaway cache, then prints the
 * totals this plugin would show and compares them with independent sources:
 *
 *   PI-Desktop  ↔ `pi.sqlite` (`turns.usage_json.totalTokens`)
 *   Pi-CLI      ↔ the previous `token-usage-statistics/records.jsonl` cache
 *
 * Nothing is written outside a temporary directory; both session roots are only
 * read. Usage: node scripts/probe.mjs
 */

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { RecordStore } = require("../src/lib/store.js");
const { scanRoot } = require("../src/lib/scan.js");
const { query } = require("../src/lib/aggregate.js");
const { resolveRoots } = require("../src/lib/paths.js");
const cliAdapter = require("../src/adapters/cli.js");
const desktopAdapter = require("../src/adapters/desktop.js");
const Fmt = require("../src/lib/format.js");

const roots = resolveRoots();

function formatRow(label, value) {
  return `${label.padEnd(28)} ${value}`;
}

/** @param {string} label @param {number} actual @param {number | null} expected */
function compare(label, actual, expected) {
  if (expected === null) {
    console.log(formatRow(`${label} (reference)`, "unavailable"));
    return;
  }
  const delta = actual - expected;
  const deltaPercent = expected === 0 ? (actual === 0 ? 0 : Number.POSITIVE_INFINITY) : (delta / expected) * 100;
  const verdict = Math.abs(deltaPercent) < 1 ? "match" : `${delta > 0 ? "+" : ""}${delta} (${deltaPercent.toFixed(2)}%)`;
  console.log(formatRow(`${label} (reference)`, `${Fmt.formatTokensExact(expected)} → ${verdict}`));
}

/** @returns {number | null} */
function desktopReferenceTotal() {
  const database = path.join(os.homedir(), ".pi-desktop", "pi.sqlite");
  if (!fs.existsSync(database)) return null;
  const sqlite = ["sqlite3", "C:/msys64/ucrt64/bin/sqlite3.exe"].find((candidate) => {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    return probe.status === 0;
  });
  if (!sqlite) return null;

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-usage-probe-db-"));
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${database}${suffix}`;
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(temp, `pi.sqlite${suffix}`));
  }
  const result = spawnSync(
    sqlite,
    [
      path.join(temp, "pi.sqlite"),
      "select coalesce(sum(json_extract(usage_json, '$.totalTokens')), 0) from turns where usage_json is not null;",
    ],
    { encoding: "utf8" },
  );
  fs.rmSync(temp, { recursive: true, force: true });
  if (result.status !== 0) return null;
  const value = Number(String(result.stdout).trim());
  return Number.isFinite(value) ? value : null;
}

/** @returns {number | null} */
function cliReferenceTotal() {
  const records = path.join(os.homedir(), ".pi", "agent", "token-usage-statistics", "records.jsonl");
  if (!fs.existsSync(records)) return null;
  let total = 0;
  for (const line of fs.readFileSync(records, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      total += Number(record.totalTokens) || 0;
    } catch {
      // A damaged trailing line in the old cache is ignored, exactly like here.
    }
  }
  return total;
}

/**
 * Every `.jsonl` under a session root, depth first.
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function walkJsonl(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/**
 * Independent sum straight from the session files, with no adapter in the loop.
 *
 * This is the reference that has to match exactly: reading these files *is* the
 * plugin's job, so any difference here is a real bug. The database and the old
 * cache are wider books — they keep turns whose messages were compacted out of
 * the file, or sessions whose files are gone — which is why their rows are
 * printed as context instead of as the pass/fail line.
 *
 * @param {"cli" | "desktop"} source
 * @returns {number | null}
 */
function rawFileTotal(source) {
  const root = roots[source];
  if (!fs.existsSync(root)) return null;
  let total = 0;
  for (const file of walkJsonl(root)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (source === "cli") {
        const usage =
          parsed?.type === "message" && parsed?.message?.role === "assistant"
            ? parsed.message.usage
            : parsed?.type === "compaction" || parsed?.type === "branch_summary"
              ? parsed.usage
              : null;
        if (!usage) continue;
        total +=
          (Number(usage.input) || 0) +
          (Number(usage.output) || 0) +
          (Number(usage.cacheRead) || 0) +
          (Number(usage.cacheWrite) || 0);
        continue;
      }
      // Desktop: the aggregate total is authoritative; the per-field sum is the
      // fallback when an entry omits it.
      const usage =
        parsed?.type === "message" && parsed?.role === "assistant"
          ? parsed?.meta?.usage
          : parsed?.type === "compaction" || parsed?.type === "branch_summary"
            ? parsed?.desktopUsage ?? parsed?.usage
            : null;
      if (!usage) continue;
      const reported = Number(usage.totalTokens);
      total += Number.isFinite(reported)
        ? reported
        : (Number(usage.inputTokens) || 0) +
          (Number(usage.outputTokens) || 0) +
          (Number(usage.cacheReadTokens) || 0) +
          (Number(usage.cacheWriteTokens) || 0);
    }
  }
  return total;
}

const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-desktop-usage-probe-"));
const store = new RecordStore({ dir: dataDir });
await store.load();

const startedAt = Date.now();
const cli = await scanRoot({ root: roots.cli, source: "cli", adapter: cliAdapter, store, budgetMs: 600000, startedAt });
const desktop = await scanRoot({
  root: roots.desktop,
  source: "desktop",
  adapter: desktopAdapter,
  store,
  budgetMs: 600000,
  startedAt: Date.now(),
});
await store.flush({ scannedAt: Date.now() });

const usage = query(store.all(), { range: "all", nowMs: Date.now() });
const bySource = new Map(usage.bySource.map((row) => [row.source, row]));
const elapsed = Date.now() - startedAt;

console.log("");
console.log(`roots            cli=${roots.cli}`);
console.log(`                 desktop=${roots.desktop}`);
console.log(formatRow("files (cli)", `${cli.totalFiles} total, ${cli.scannedFiles} read, ${cli.skippedFiles} skipped`));
console.log(formatRow("files (desktop)", `${desktop.totalFiles} total, ${desktop.scannedFiles} read, ${desktop.skippedFiles} skipped`));
console.log(formatRow("records", String(store.size)));
console.log(formatRow("scan time", `${elapsed} ms`));
console.log("");
console.log(formatRow("tokens (cli)", Fmt.formatTokensExact(bySource.get("cli")?.tokens ?? 0)));
console.log(formatRow("tokens (desktop)", Fmt.formatTokensExact(bySource.get("desktop")?.tokens ?? 0)));
console.log(formatRow("tokens (total)", Fmt.formatTokensExact(usage.totals.tokens)));
console.log(formatRow("cost (total)", Fmt.formatUsd(usage.totals.cost)));
console.log(formatRow("requests (total)", Fmt.formatTokensExact(usage.totals.requests)));
console.log("");
console.log("reconciliation");
// The file rows are the pass/fail gate: the plugin's job is to read those files,
// so they must match to the byte. The database and the old cache are wider books
// — they also keep history the files no longer carry — so their rows are context.
compare("PI-Desktop ↔ session files", bySource.get("desktop")?.tokens ?? 0, rawFileTotal("desktop"));
compare("PI-Desktop ↔ pi.sqlite", bySource.get("desktop")?.tokens ?? 0, desktopReferenceTotal());
compare("Pi-CLI ↔ session files", bySource.get("cli")?.tokens ?? 0, rawFileTotal("cli"));
compare("Pi-CLI ↔ legacy cache", bySource.get("cli")?.tokens ?? 0, cliReferenceTotal());
console.log("");
console.log("note: the pi.sqlite row counts turns whose messages were compacted out of the");
console.log("      session file, and the legacy cache still counts sessions whose files are gone;");
console.log("      only the two '↔ session files' rows are expected to match exactly.");
console.log("");

await fsp.rm(dataDir, { recursive: true, force: true });
