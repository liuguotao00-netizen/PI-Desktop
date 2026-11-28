/**
 * Type-check, compile, and stage the plugin.
 *
 * The TypeScript sources live under `src/`; `tsc` writes CommonJS to
 * `compiled/`, and the runtime assets (automation scripts, the data registry,
 * vendored adm-zip) are copied next to the compiled modules. The app bundles
 * the staged copy under `apps/desktop/resources/plugins/<id>`.
 *
 *   node build.mjs             compile + stage
 *   node build.mjs --no-stage  compile only (tests)
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, "compiled");
const noStage = process.argv.includes("--no-stage");
const typecheckOnly = process.argv.includes("--typecheck-only");

const tsc = require.resolve("typescript/bin/tsc");
if (typecheckOnly) {
  execFileSync(
    process.execPath,
    [tsc, "-p", join(here, "tsconfig.json"), "--noEmit"],
    { stdio: "inherit" },
  );
  process.exit(0);
}

rmSync(compiled, { recursive: true, force: true });
mkdirSync(compiled, { recursive: true });

execFileSync(process.execPath, [tsc, "-p", join(here, "tsconfig.json")], {
  stdio: "inherit",
});

cpSync(join(here, "bridge/automation/scripts"), join(compiled, "bridge/automation/scripts"), {
  recursive: true,
});
cpSync(join(here, "bridge/vendor"), join(compiled, "bridge/vendor"), {
  recursive: true,
});
cpSync(join(here, "data"), join(compiled, "data"), { recursive: true });

if (!noStage) {
  const target = join(here, "../../resources/plugins/pi.taobao-tools");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(compiled, join(target, "compiled"), { recursive: true });
  for (const file of ["manifest.json", "package.json", "README.md", "CONTROL-FLOW.md"]) {
    cpSync(join(here, file), join(target, file));
  }
  console.log(`staged ${target}`);
}
