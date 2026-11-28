/**
 * Validate every bundled plugin manifest with the host's own reader.
 *
 * A malformed manifest used to make the app silently drop the whole plugin.
 * Run this after `cargo build -p host-core` and before packaging/dev startup so
 * the build fails with the same error the registry would report.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugins = join(root, "apps/desktop/resources/plugins");
const binary = process.env.PI_DESKTOP_HOST_CORE_BIN
  ? process.env.PI_DESKTOP_HOST_CORE_BIN
  : [
      join(root, "target/debug/pi-desktop-host-core"),
      join(root, "target/release/pi-desktop-host-core"),
    ].find((candidate) => existsSync(candidate));

if (!binary) {
  console.error(
    "validate-bundled-plugins: host-core binary missing; build it before validating",
  );
  process.exit(1);
}
if (!existsSync(plugins)) {
  console.log("validate-bundled-plugins: no bundled plugins to validate");
  process.exit(0);
}

const result = spawnSync(binary, {
  env: { ...process.env, PI_VALIDATE_PLUGINS_DIR: plugins },
  stdio: "inherit",
});
if (result.error) {
  console.error(`validate-bundled-plugins: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
