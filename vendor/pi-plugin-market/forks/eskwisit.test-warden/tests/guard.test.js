"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { sandbox, put, ROOT } = require("./helpers");

const RUN = ".test-warden/runs/20260101-120000-ab12";
const SOURCES = ["src/a.js", "src/price/index.ts"];

/** Load the ESM extension against a fake pi; returns a `call(toolName, input)` that fires tool_call. */
async function loadGuard(cwd) {
  const mod = await import(pathToFileURL(path.join(ROOT, "extension", "warden-guard.js")).href);
  const handlers = new Map();
  mod.default({ on: (name, fn) => handlers.set(name, fn) });
  assert.ok(handlers.has("tool_call"));
  return (toolName, input) => handlers.get("tool_call")({ toolName, input, toolCallId: "c1" }, { cwd });
}

function guarded({ until = new Date(Date.now() + 3600e3).toISOString() } = {}) {
  const dirs = sandbox();
  put(dirs, ".test-warden/guard.json", JSON.stringify({ run: RUN, sources: SOURCES, since: new Date().toISOString(), until }));
  return dirs.workspace;
}

const blocked = (r, re) => {
  assert.equal(r && r.block, true, `expected a block, got ${JSON.stringify(r)}`);
  assert.match(r.reason, re);
};
const allowed = (r) => assert.equal(r, undefined, `expected allow, got ${JSON.stringify(r)}`);
const READ_ONLY = /is code under test and read-only during run .*release/;

test("guard: Edit and Write to a protected source are blocked, tests are not", async () => {
  const cwd = guarded();
  const call = await loadGuard(cwd);
  blocked(await call("Edit", { path: "src/a.js", ops: "PUT 1.=1:\n+x" }), READ_ONLY);
  blocked(await call("edit", { file_path: path.join(cwd, "src/price/index.ts") }), READ_ONLY);
  blocked(await call("Write", { path: "./src/a.js", content: "" }), READ_ONLY);
  blocked(await call("MultiEdit", { path: "src/a.js" }), READ_ONLY);
  allowed(await call("Edit", { path: "src/a.test.js" }));
  allowed(await call("Write", { file_path: "tests/price.test.ts", content: "" }));
  allowed(await call("Read", { path: "src/a.js" }));
});

test("guard: Bash writes to a source are blocked; reads and the snapshot restore are allowed", async () => {
  const cwd = guarded();
  const call = await loadGuard(cwd);
  blocked(await call("Bash", { command: "sed -i 's/a/b/' src/a.js" }), READ_ONLY);
  blocked(await call("Bash", { command: "echo x > src/a.js" }), READ_ONLY);
  blocked(await call("Bash", { command: "cat fix.js >> ./src/price/index.ts" }), READ_ONLY);
  blocked(await call("Bash", { command: "perl -pi -e 's/a/b/' src/a.js" }), READ_ONLY);
  blocked(await call("Bash", { command: "cp fix.js src/a.js" }), READ_ONLY);
  blocked(await call("Bash", { command: "rm -f src/a.js" }), READ_ONLY);
  blocked(await call("Bash", { command: "git checkout -- src/a.js" }), READ_ONLY);
  blocked(await call("Bash", { command: "git restore src/a.js" }), READ_ONLY);
  allowed(await call("Bash", { command: "cp .test-warden/runs/x/snapshot/src/a.js src/a.js" }));
  allowed(await call("Bash", { command: "cat src/a.js" }));
  allowed(await call("Bash", { command: "grep -n total src/a.js | head" }));
  allowed(await call("Bash", { command: "cp src/a.js /tmp/copy.js" }));
  allowed(await call("Bash", { command: "echo x > src/a.test.js" }));
  allowed(await call("Bash", { command: "node src/a.js > out.txt" }));
});

test("guard: the fixer agent is blocked, the writer is not", async () => {
  const cwd = guarded();
  const call = await loadGuard(cwd);
  blocked(await call("Task", { agent: "fixer", prompt: "make the tests pass" }), /fixer agent.*test-warden-writer/);
  allowed(await call("Task", { agent: "test-warden-writer", prompt: "write tests" }));
  allowed(await call("Task", { agent: "test-runner", prompt: "why" }));
});

test("guard: warden scripts need timeout >= 900", async () => {
  const cwd = guarded();
  const call = await loadGuard(cwd);
  blocked(await call("Bash", { command: `bash ${RUN}/check.sh`, timeout: 60 }), /timeout ≥ 900 \(this one: 60\)/);
  blocked(await call("Bash", { command: `bash ${RUN}/gate.sh` }), /this one: missing/);
  allowed(await call("Bash", { command: `bash ${RUN}/check.sh`, timeout: 900 }));
  allowed(await call("Bash", { command: `bash ${RUN}/check.sh`, timeout: 1800 }));
  allowed(await call("Bash", { command: `cat ${RUN}/plan.json`, timeout: 10 }));
});

test("guard: an expired, missing or broken guard allows everything", async () => {
  const expired = guarded({ until: new Date(Date.now() - 1000).toISOString() });
  let call = await loadGuard(expired);
  allowed(await call("Edit", { path: "src/a.js" }));
  allowed(await call("Task", { agent: "fixer" }));

  const none = sandbox().workspace;
  call = await loadGuard(none);
  allowed(await call("Write", { path: "src/a.js" }));
  allowed(await call("Bash", { command: "sed -i s/a/b/ src/a.js" }));

  const broken = sandbox();
  put(broken, ".test-warden/guard.json", "{ not json");
  call = await loadGuard(broken.workspace);
  allowed(await call("Edit", { path: "src/a.js" }));
  assert.ok(fs.existsSync(path.join(broken.workspace, ".test-warden/guard.json")));
});

test("guard: a missing cwd or input fails open", async () => {
  const call = await loadGuard(undefined);
  allowed(await call("Edit", undefined));
  allowed(await call(undefined, { path: 1 }));
});
