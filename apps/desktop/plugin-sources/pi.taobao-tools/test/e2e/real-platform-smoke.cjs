"use strict";

/**
 * Real-platform smoke runner.
 *
 * This does **not** launch a browser or touch an account. It connects to a
 * Chrome the user started with remote debugging and is already logged in to,
 * then runs one bundled automation against that live page:
 *
 *   1. start Chrome with a dedicated profile:
 *      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *        --remote-debugging-port=9222 --user-data-dir="$HOME/.pi-e2e-chrome"
 *   2. log in to the platform in that Chrome window
 *   3. run:
 *      node test/e2e/real-platform-smoke.cjs \
 *        --cdp http://127.0.0.1:9222 \
 *        --script xiaohongshu-search \
 *        --variables '{"keyword":"咖啡"}'
 *
 * The script is the real bundled one; the engine is the compiled driver/DSL.
 * Use `--match <substring>` to pick a page when several tabs are open, and
 * `--timeout <ms>` to raise the run budget for publishing.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const catalog = require("../../compiled/bridge/automation/catalog.js");
const dsl = require("../../compiled/bridge/automation/dsl.js");
const { createDriver } = require("../../compiled/bridge/automation/driver.js");
const { connectToPage, PageBrowser } = require("./chrome-cdp.cjs");

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[name] = next;
      index += 1;
    } else {
      args[name] = true;
    }
  }
  return args;
}

function usage() {
  console.error(
    "usage: node test/e2e/real-platform-smoke.cjs --cdp http://127.0.0.1:9222 " +
      "--script <id> [--variables '<json>'] [--match <url-substring>] [--timeout <ms>] [--list]",
  );
}

async function findPage(cdpBase, match) {
  const response = await fetch(`${cdpBase}/json/list`);
  const targets = await response.json();
  const pages = (targets || []).filter(
    (target) => target.type === "page" && target.webSocketDebuggerUrl,
  );
  if (match) {
    const matched = pages.find((target) => String(target.url).includes(match));
    if (matched) return matched;
  }
  return pages[0] ?? null;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.list) {
    for (const item of catalog.scriptCatalog()) {
      console.log(`${item.id}\t${item.platform}\t${item.kind}\t${item.name}`);
    }
    return;
  }
  if (!args.cdp || !args.script) {
    usage();
    process.exitCode = 2;
    return;
  }
  const script = catalog.requireScript(String(args.script));
  const variables = args.variables ? JSON.parse(String(args.variables)) : {};
  const cdpBase = String(args.cdp).replace(/\/$/, "");
  const pageTarget = await findPage(cdpBase, args.match ? String(args.match) : "");
  if (!pageTarget) {
    throw new Error("no page target at the CDP endpoint; open a tab first");
  }
  const connection = await connectToPage(pageTarget.webSocketDebuggerUrl);
  const browser = new PageBrowser(connection);
  const artifactDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `pi-taobao-smoke-${script.id}-`),
  );
  const driver = createDriver({ browser, sessionId: "smoke" });
  try {
    const value = await dsl.runScript({
      script,
      variables,
      driver,
      artifactDir,
      timeoutMs: Number(args.timeout) || (script.kind === "publish" ? 900_000 : 300_000),
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          automation: script.id,
          page: pageTarget.url,
          artifactDir,
          context: value.context,
          files: value.files,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          automation: script.id,
          page: pageTarget.url,
          artifactDir,
          code: error.code || "AUTOMATION_FAILED",
          message: String(error.message || error),
          details: error.details || null,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    connection.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: String(error.message || error) }, null, 2));
  process.exitCode = 1;
});
