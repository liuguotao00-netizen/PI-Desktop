"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const manifest = require("../manifest.json");

function fixture() {
  const calls = [];
  const registered = new Map();
  let settings = { pythonPath: "", draftRoot: "", jianyingPath: "", workDir: "Jianying" };
  let workspace = "D:\\test-project";
  class Runtime {
    constructor(options) { this.options = options; }
    async doctor(args) { calls.push(["doctor", args]); return { ok: true, ready: false }; }
    async setup(args) { calls.push(["setup", args]); return { ok: true }; }
    async probe(args) { calls.push(["probe", args]); throw new Error("素材不存在"); }
    async validate(args) { calls.push(["validate", args]); return { ok: true }; }
    async build(args) { calls.push(["build", args]); return { ok: true, jobDir: "job", title: "样片" }; }
    async publish(args) { calls.push(["publish", args]); return { ok: true }; }
    async launch(args) { calls.push(["launch", args]); return { ok: true }; }
    async dispose() { calls.push(["dispose"]); }
  }
  const pi = {
    workspace: { get: async () => workspace ? { path: workspace } : null },
    plugin: { getSettings: async () => settings, setSettings: async value => { settings = { ...settings, ...value }; } },
    commands: { register: async x => calls.push(["command", x]), unregister: async x => calls.push(["unregisterCommand", x]) },
    ui: { openPanel: async x => calls.push(["open", x]) },
    agent: { registerTool: async x => registered.set(x.name, x), unregisterTool: async x => registered.delete(x) },
  };
  const sandbox = { module: { exports: {} }, pi, require: name => {
    if (name === "./runtime") return { JianyingRuntime: Runtime };
    if (name === "./manifest.json") return manifest;
    throw new Error(`unexpected require ${name}`);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8"), sandbox);
  return { api: sandbox.module.exports, calls, registered, setWorkspace: x => { workspace = x; }, getSettings: () => settings };
}

test("manifest tools all register with consistent risks and unregister on unload", async () => {
  const f = fixture();
  await f.api.onLoad();
  assert.equal(f.registered.size, 7);
  for (const tool of manifest.contributes.agentTools) assert.equal(f.registered.get(tool.name).risk, tool.risk);
  await f.registered.get("check_environment").execute({});
  assert.equal(f.calls.at(-1)[0], "doctor");
  await f.api.onUnload();
  assert.equal(f.registered.size, 0);
  assert.ok(f.calls.some(x => x[0] === "dispose"));
});

test("panel direct RPC routes and surfaces runtime errors", async () => {
  const f = fixture();
  const result = await f.api.onPanelInvoke("jy.probe", { path: "missing.mp4" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "素材不存在");
  assert.equal(result.isError, true);
  assert.equal((await f.api.onPanelInvoke("jy.deleteEverything", {})).ok, false);
});

test("settings validation rejects malformed paths, strips whitespace and unknown keys", async () => {
  const f = fixture();
  assert.equal((await f.api.onPanelInvoke("jy.settings", { pythonPath: "x" })).ok, false);
  assert.equal((await f.api.onPanelInvoke("jy.settings", { pythonPath: "x\ny", draftRoot: "", jianyingPath: "", workDir: "Jianying" })).ok, false);
  const result = await f.api.onPanelInvoke("jy.settings", { pythonPath: " python.exe ", draftRoot: "", jianyingPath: "", workDir: "Jianying", injected: true });
  assert.equal(result.ok, true);
  assert.equal(f.getSettings().pythonPath, "python.exe");
  assert.equal(f.getSettings().injected, undefined);
});

test("last build visible in panel but cleared on workspace switch or settings changes", async () => {
  const f = fixture();
  await f.api.onPanelInvoke("jy.build", { timeline: {} });
  assert.equal((await f.api.onPanelInvoke("jy.state")).lastResult.title, "样片");
  f.setWorkspace("D:\\other-project");
  assert.equal((await f.api.onPanelInvoke("jy.state")).lastResult, null);
  await f.api.onPanelInvoke("jy.build", { timeline: {} });
  await f.api.onPanelInvoke("jy.settings", f.getSettings());
  assert.equal((await f.api.onPanelInvoke("jy.state")).lastResult, null);
});

test("missing workspace still allows opening settings panel state", async () => {
  const f = fixture();
  f.setWorkspace("");
  const state = await f.api.onPanelInvoke("jy.state");
  assert.equal(state.ok, true);
  assert.equal(state.workspace, "");
});
