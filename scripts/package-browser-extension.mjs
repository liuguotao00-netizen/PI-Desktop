#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "apps/desktop/resources/browser-extension");
const outputDir = join(root, "dist");
const output = join(outputDir, "pi-desktop-browser-extension.zip");
if (!existsSync(source)) throw new Error(`extension source missing: ${source}`);
mkdirSync(outputDir, { recursive: true });
rmSync(output, { force: true });
execFileSync("zip", ["-qr", output, "."], { cwd: source });
console.log(output);
