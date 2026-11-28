/**
 * Build every bundled plugin that has a TypeScript source tree.
 *
 * A plugin opts in by having both `package.json` (with a `build` script) and
 * `tsconfig.json` under `apps/desktop/plugin-sources/<id>`. Plain-JS plugins
 * are copied by their own tooling and are skipped here.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = join(root, "apps/desktop/plugin-sources");

for (const id of readdirSync(sources, { withFileTypes: true })) {
  if (!id.isDirectory()) continue;
  const dir = join(sources, id.name);
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath) || !existsSync(join(dir, "tsconfig.json"))) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (!pkg.scripts?.build) continue;
  console.log(`[plugins] building ${id.name}`);
  execFileSync(process.execPath, [join(dir, "build.mjs")], {
    cwd: dir,
    stdio: "inherit",
  });
}
