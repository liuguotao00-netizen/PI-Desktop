/**
 * Type-check and unit-test every bundled plugin that has a TypeScript source
 * tree (the same discovery rule as `build-bundled-plugins.mjs`).
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
  if (!pkg.scripts?.test) continue;
  console.log(`[plugins] testing ${id.name}`);
  execFileSync(process.execPath, [join(dir, "build.mjs"), "--no-stage"], {
    cwd: dir,
    stdio: "inherit",
  });
  const tests = readdirSync(join(dir, "test"))
    .filter((file) => file.endsWith(".test.cjs"))
    .map((file) => join(dir, "test", file));
  execFileSync(process.execPath, ["--test", ...tests], {
    cwd: dir,
    stdio: "inherit",
  });
}
