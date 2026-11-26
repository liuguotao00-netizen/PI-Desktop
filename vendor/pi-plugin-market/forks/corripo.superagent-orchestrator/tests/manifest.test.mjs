import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const manifest = require("../manifest.json");
const runtime = require("../runtime.js");

test("manifest exposes notify and interrupt to the model", () => {
  const tool = manifest.contributes.agentTools[0];
  assert.ok(tool.schema.properties.action.enum.includes("notify"));
  assert.equal(tool.schema.properties.interrupt.type, "boolean");
  assert.match(tool.description, /action `notify`/);
  assert.match(tool.description, /default true/);
});

test("manifest documents the new behavior in both safety notes", () => {
  assert.match(manifest.safetyNotes, /interrupt/);
  assert.match(manifest.safetyNotes, /notify/);
  assert.match(manifest.i18n["zh-CN"].safetyNotes, /interrupt/);
  assert.match(manifest.i18n["zh-CN"].safetyNotes, /notify/);
});

test("the reviewed host operation required for interrupt is exported", () => {
  assert.equal(runtime.SESSION_ABORT, "agent/abort");
});
