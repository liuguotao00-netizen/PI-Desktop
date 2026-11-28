import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve("electron/main/plugin-host-process.mjs"), "utf8");
const runtime = readFileSync(resolve("electron/main/plugin-runtime.ts"), "utf8");

test("plugin host refuses child_process without a process permission", () => {
  assert.match(source, /PROCESS_PERMISSIONS/);
  assert.match(source, /system\.process/);
  assert.match(source, /NodeModule\._load/);
  assert.match(source, /PLUGIN_PERMISSION_DENIED/);
  assert.match(source, /plugins with computer\.control must drive the desktop through pi\.cua/);
  assert.match(source, /system\.shell/);
  assert.match(source, /DESKTOP_BINARIES/);
  assert.match(source, /processAllowlist/);
  assert.match(source, /DEFAULT_ALLOWED_PROCESSES/);
});

test("desktop-control and browser launch tools require declared permissions", () => {
  assert.match(runtime, /COMPUTER_CONTROL_TOOLS/);
  assert.match(runtime, /computer\.control/);
  assert.match(runtime, /BROWSER_LAUNCH_TOOLS/);
  assert.match(runtime, /browser\.launch/);
});
