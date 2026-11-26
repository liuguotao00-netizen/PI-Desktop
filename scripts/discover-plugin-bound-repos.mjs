/**
 * Read the plugin center's own detail records for `boundRepository`.
 *
 * The detail endpoint is authoritative: it is what the plugin page shows and
 * what the publisher bound through the GitHub app. Package contents and
 * catalog.json frequently omit it, so source discovery must start here.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "vendor/pi-plugin-market/manifest.json"), "utf8"));
const output = join(root, "vendor/pi-plugin-market/forks/BOUND-REPOSITORIES.json");
const concurrency = 8;
let cursor = 0;
const results = [];

async function one(plugin) {
  const url = `https://plugins.aiuo.net/api/v1/plugins/${encodeURIComponent(plugin.id)}`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        "user-agent": "pi-desktop-plugin-fork-discovery",
        accept: "application/json",
      },
    });
    if (!response.ok) return;
    const detail = await response.json();
    const bound = detail?.boundRepository;
    if (bound?.url) {
      results.push({
        id: plugin.id,
        repository: bound.url,
        coordinate: bound.coordinate ?? null,
        owner: detail.ownerUsername ?? null,
        verified: bound.verified === true,
      });
    }
  } catch {
    // A detail endpoint that is down must not erase the rest of the map.
  }
}

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= manifest.plugins.length) return;
      await one(manifest.plugins[index]);
    }
  }),
);

results.sort((a, b) => a.id.localeCompare(b.id));
await writeFile(
  output,
  JSON.stringify({ generatedAt: new Date().toISOString(), count: results.length, plugins: results }, null, 2) + "\n",
  "utf8",
);
console.log(`bound repositories: ${results.length}/${manifest.plugins.length}`);
console.log(`wrote ${output}`);
