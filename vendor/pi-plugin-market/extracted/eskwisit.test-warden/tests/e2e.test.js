"use strict";

// End to end: real git repositories, the generated scripts run by bash, and the host tools called
// as the agent would. The "writers" are simulated by writing the files a writer would write.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setup, put, get, git, bash, verify } = require("./helpers");

const HEADER = 'const test = require("node:test");\nconst assert = require("node:assert/strict");\n';

function project(dirs, prefix = "") {
  put(dirs, `${prefix}package.json`, JSON.stringify({ name: "e2e", scripts: { test: "node --test" } }));
  put(dirs, `${prefix}src/math.js`, "exports.add = (a, b) => a + b;\n");
  put(dirs, `${prefix}src/other.js`, "exports.x = 1;\n");
  put(dirs, `${prefix}test/math.test.js`, `${HEADER}const { add } = require("../src/math.js");\ntest("add", () => assert.equal(add(2, 3), 5));\n`);
  git(dirs, "init", "-q", "-b", "main");
  git(dirs, "add", "-A");
  git(dirs, "commit", "-q", "-m", "init");
}
const verifyNode = (s) => verify(s.pi, "js", "node --test", "node --test {file}");
const worktrees = (s) => git(s.dirs, "worktree", "list").trim().split("\n").length;
const status = (s) => git(s.dirs, "status", "--porcelain", "--untracked-files=all").split("\n").filter((l) => l && !l.includes(".test-warden/")).sort().join("\n");

test("check finds a real regression without touching the working tree", async () => {
  const s = await setup();
  try {
    project(s.dirs);
    await verifyNode(s);
    put(s.dirs, "src/math.js", "exports.add = (a, b) => a - b;\n"); // the bug
    put(s.dirs, "src/other.js", "exports.x = 2;\n");
    const before = [status(s), get(s.dirs, "src/math.js")];
    const plan = await s.pi.call("warden_check", { changed: ["src/math.js", "src/other.js"] });
    assert.deepEqual(plan.map, ["src/math.js <- test/math.test.js"]);
    assert.deepEqual(plan.uncovered, ["src/other.js"]);
    const res = bash(s.dirs, `${plan.run}/check.sh`);
    assert.equal(res.code, 0, res.out);
    const v = await s.pi.call("warden_check", { action: "verdict", run: plan.run });
    assert.deepEqual(v.regressions.map((r) => r.test), ["test/math.test.js"]);
    assert.deepEqual([status(s), get(s.dirs, "src/math.js")], before, "the working tree is untouched");
    assert.equal(worktrees(s), 1, "the temporary worktree is gone");
    assert.match(git(s.dirs, "check-ignore", `${plan.run}/check.tsv`), /check\.tsv/, "run artifacts are git-ignored");
  } finally {
    await s.done();
  }
});

test("a suite-level command (no per-file form) still finds the regression", async () => {
  const s = await setup();
  try {
    project(s.dirs);
    await verify(s.pi, "js", "node --test", "");
    put(s.dirs, "src/math.js", "exports.add = (a, b) => a * b;\n");
    const plan = await s.pi.call("warden_check", { changed: ["src/math.js"] });
    assert.equal(bash(s.dirs, `${plan.run}/check.sh`).code, 0);
    const v = await s.pi.call("warden_check", { action: "verdict", run: plan.run });
    assert.deepEqual(v.regressions.map((r) => r.test), ["<js suite>"]);
  } finally {
    await s.done();
  }
});

test("a workspace inside a larger repository works (worktree paths are prefix-aware)", async () => {
  const s = await setup();
  try {
    // the git repo is the sandbox root's "workspace"; the plugin's workspace is its app/ folder
    const repo = s.dirs;
    put(repo, "README.md", "monorepo\n");
    project(repo, "app/");
    const appDirs = { ...s.dirs, workspace: path.join(s.dirs.workspace, "app") };
    const { fakePi, loadMain } = require("./helpers");
    const pi = fakePi(appDirs);
    const main = loadMain(pi);
    await main.onLoad();
    await verify(pi, "js", "node --test", "node --test {file}");
    put(repo, "app/src/math.js", "exports.add = () => 0;\n");
    const plan = await pi.call("warden_check", { changed: ["src/math.js"] });
    const res = bash(appDirs, `${plan.run}/check.sh`);
    assert.equal(res.code, 0, res.out);
    const v = await pi.call("warden_check", { action: "verdict", run: plan.run });
    assert.deepEqual(v.regressions.map((r) => r.test), ["test/math.test.js"]);
    await main.onUnload();
  } finally {
    await s.done();
  }
});

test("gate (feature) keeps a test that catches the feature, rejects useless and flaky tests; undo removes them", async () => {
  const s = await setup();
  try {
    project(s.dirs);
    await verifyNode(s);
    put(s.dirs, "src/math.js", "exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a - b;\n");
    const math = get(s.dirs, "src/math.js");
    const plan = await s.pi.call("warden_check", { changed: ["src/math.js"] });
    const req = 'const m = require("../src/math.js");\n';
    put(s.dirs, "test/sub.test.js", `${HEADER}${req}test("sub", () => assert.equal(m.sub(5, 3), 2));\n`);
    put(s.dirs, "test/useless.test.js", `${HEADER}${req}test("add again", () => assert.equal(m.add(1, 1), 2));\n`);
    const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tw-flaky-")), "n");
    put(s.dirs, "test/flaky.test.js", `${HEADER}${req}const fs = require("node:fs");\nconst f = ${JSON.stringify(counter)};\nconst n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;\nfs.writeFileSync(f, String(n + 1));\ntest("flaky", () => assert.ok(n !== 2 && typeof m.sub === "function"));\n`);
    const tests = ["test/sub.test.js", "test/useless.test.js", "test/flaky.test.js"];
    const g = await s.pi.call("warden_gate", { run: plan.run, kind: "feature", tests, written: tests });
    assert.equal(g.restoreCommand, undefined);
    assert.equal(bash(s.dirs, `${plan.run}/gate.sh`).code, 0);
    const v = await s.pi.call("warden_gate", { action: "verdict", run: plan.run });
    assert.deepEqual(v.keep, ["test/sub.test.js"]);
    const reasons = Object.fromEntries(v.reject.map((r) => [r.test, r.reason]));
    assert.match(reasons["test/useless.test.js"], /passes on the old code/);
    assert.match(reasons["test/flaky.test.js"], /flaky: passed 2\/3/);
    put(s.dirs, `${plan.run}/undo.sh`, `${v.undoCommand}\n`);
    assert.equal(bash(s.dirs, `${plan.run}/undo.sh`).code, 0);
    assert.equal(get(s.dirs, "test/useless.test.js"), null);
    assert.equal(get(s.dirs, "test/flaky.test.js"), null);
    assert.ok(get(s.dirs, "test/sub.test.js"));
    assert.equal(get(s.dirs, "src/math.js"), math);
    assert.equal(worktrees(s), 1);
  } finally {
    await s.done();
  }
});

test("'Create a test suite for clamp.js': the suite is kept, the bug is proven and reported, clamp.js is never changed", async () => {
  const s = await setup();
  try {
    project(s.dirs);
    // committed with a bug: clamp(15, 0, 10) should be 10
    put(s.dirs, "src/clamp.js", "exports.clamp = (x, lo, hi) => (x < lo ? lo : x);\n");
    git(s.dirs, "add", "-A");
    git(s.dirs, "commit", "-q", "-m", "clamp");
    // the user has uncommitted work in clamp.js too
    put(s.dirs, "src/clamp.js", "// user's work in progress\nexports.clamp = (x, lo, hi) => (x < lo ? lo : x);\n");
    const userVersion = get(s.dirs, "src/clamp.js");
    await verifyNode(s);

    const plan = await s.pi.call("warden_check", { mode: "suite", changed: ["src/clamp.js"] });
    assert.equal(plan.command, null, "no existing test reaches clamp.js");
    assert.deepEqual(plan.suggest, [{ target: "src/clamp.js", own: "test/clamp.test.js", existing: false, bugs: "test/clamp.bugs.test.js" }]);

    // what a writer produces: a passing suite, a tautology, a bug reproduction — and a forbidden "fix"
    const req = 'const { clamp } = require("../src/clamp.js");\n';
    put(s.dirs, "test/clamp.test.js", `${HEADER}${req}test("keeps values in range", () => assert.equal(clamp(5, 0, 10), 5));\ntest("raises values below lo", () => assert.equal(clamp(-1, 0, 10), 0));\n`);
    put(s.dirs, "test/clamp.extra.test.js", `${HEADER}test("math works", () => assert.equal(1 + 1, 2));\n`);
    put(s.dirs, "test/clamp.bugs.test.js", `${HEADER}${req}test("lowers values above hi", () => assert.equal(clamp(15, 0, 10), 10));\n`);
    put(s.dirs, "src/clamp.js", "exports.clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x)); // writer 'fixed' it\n");

    const g = await s.pi.call("warden_gate", {
      run: plan.run, kind: "suite",
      tests: ["test/clamp.test.js", "test/clamp.extra.test.js"], bugs: ["test/clamp.bugs.test.js"],
      written: ["test/clamp.test.js", "test/clamp.extra.test.js", "test/clamp.bugs.test.js"], // the writer did not report the edit
    });
    assert.deepEqual(g.protectedChanged, ["src/clamp.js"]);
    put(s.dirs, `${plan.run}/restore.sh`, `${g.restoreCommand}\n`);
    assert.equal(bash(s.dirs, `${plan.run}/restore.sh`).code, 0);
    assert.equal(get(s.dirs, "src/clamp.js"), userVersion, "restored exactly, including the user's uncommitted work");

    const res = bash(s.dirs, `${plan.run}/gate.sh`);
    assert.equal(res.code, 0, res.out);
    const v = await s.pi.call("warden_gate", { action: "verdict", run: plan.run });
    assert.deepEqual(v.keep, ["test/clamp.test.js"]);
    assert.deepEqual(v.reject.map((r) => r.test), ["test/clamp.extra.test.js"]);
    assert.match(v.reject[0].reason, /emptied: it does not exercise the target/);
    assert.deepEqual(v.bugs.confirmed.map((b) => b.test), ["test/clamp.bugs.test.js"]);
    assert.match(v.bugs.confirmed[0].log, /15|10|assert/i);
    assert.equal(get(s.dirs, "src/clamp.js"), userVersion, "the gate never writes to the working tree");
    assert.equal(worktrees(s), 1);

    put(s.dirs, `${plan.run}/undo.sh`, `${v.undoCommand}\n`);
    assert.equal(bash(s.dirs, `${plan.run}/undo.sh`).code, 0);
    assert.equal(get(s.dirs, "test/clamp.extra.test.js"), null);
    assert.ok(get(s.dirs, "test/clamp.test.js"));
    assert.ok(get(s.dirs, "test/clamp.bugs.test.js"), "the failing reproduction stays for the user to decide");
    assert.equal(get(s.dirs, "src/clamp.js"), userVersion);
  } finally {
    await s.done();
  }
});

test("suite gate with a whole-suite command: the suite is kept and the bug confirmed in one run", async () => {
  const s = await setup();
  try {
    project(s.dirs);
    put(s.dirs, "src/clamp.js", "exports.clamp = (x, lo, hi) => (x < lo ? lo : x);\n");
    git(s.dirs, "add", "-A");
    git(s.dirs, "commit", "-q", "-m", "clamp");
    await verify(s.pi, "js", "node --test", ""); // no per-file form: every run is the whole suite
    const plan = await s.pi.call("warden_check", { mode: "suite", changed: ["src/clamp.js"] });
    const req = 'const { clamp } = require("../src/clamp.js");\n';
    put(s.dirs, "test/clamp.test.js", `${HEADER}${req}test("keeps values in range", () => assert.equal(clamp(5, 0, 10), 5));\n`);
    put(s.dirs, "test/clamp.bugs.test.js", `${HEADER}${req}test("lowers values above hi", () => assert.equal(clamp(15, 0, 10), 10));\n`);
    await s.pi.call("warden_gate", { run: plan.run, kind: "suite", tests: ["test/clamp.test.js"], bugs: ["test/clamp.bugs.test.js"] });
    const res = bash(s.dirs, `${plan.run}/gate.sh`);
    assert.equal(res.code, 0, res.out);
    const v = await s.pi.call("warden_gate", { action: "verdict", run: plan.run });
    assert.deepEqual(v.keep, ["<js suite>"], "the suite passes 3x without the bug file and fails with clamp.js emptied");
    assert.deepEqual(v.bugs.confirmed.map((b) => b.test), ["<js suite>"]);
    assert.equal(v.undoCommand, undefined);
    assert.equal(worktrees(s), 1, "both temporary worktrees are gone");
    assert.ok(get(s.dirs, "test/clamp.bugs.test.js"));
  } finally {
    await s.done();
  }
});

test("suite mode extends an existing test file; a rejected extension is undone to the snapshot", async () => {
  const s = await setup();
  try {
    project(s.dirs);
    await verifyNode(s);
    put(s.dirs, "test/math.test.js", `${get(s.dirs, "test/math.test.js")}// user's uncommitted note\n`);
    const userTest = get(s.dirs, "test/math.test.js");
    const plan = await s.pi.call("warden_check", { mode: "suite", changed: ["src/math.js"] });
    assert.deepEqual(plan.suggest[0], { target: "src/math.js", own: "test/math.test.js", existing: true, bugs: "test/math.bugs.test.js" });
    assert.equal(bash(s.dirs, `${plan.run}/check.sh`).code, 0);
    assert.equal((await s.pi.call("warden_check", { action: "verdict", run: plan.run })).passed, 1);
    put(s.dirs, "test/math.test.js", `${userTest}test("tautology", () => assert.ok(true));\ntest("broken", () => assert.equal(1, 2));\n`);
    await s.pi.call("warden_gate", { run: plan.run, kind: "suite", tests: ["test/math.test.js"] });
    assert.equal(bash(s.dirs, `${plan.run}/gate.sh`).code, 0);
    const v = await s.pi.call("warden_gate", { action: "verdict", run: plan.run });
    assert.match(v.reject[0].reason, /fails on the current code/);
    put(s.dirs, `${plan.run}/undo.sh`, `${v.undoCommand}\n`);
    assert.equal(bash(s.dirs, `${plan.run}/undo.sh`).code, 0);
    assert.equal(get(s.dirs, "test/math.test.js"), userTest, "back to the user's version, not to HEAD");
  } finally {
    await s.done();
  }
});

test("a failing worktree checkout stops the script with a clear error", async () => {
  const s = await setup();
  try {
    project(s.dirs);
    await verifyNode(s);
    put(s.dirs, "src/math.js", "exports.add = (a, b) => a - b;\n");
    const plan = await s.pi.call("warden_check", { changed: ["src/math.js"], base: "no-such-ref" });
    const res = bash(s.dirs, `${plan.run}/check.sh`);
    assert.equal(res.code, 2);
    assert.match(res.out, /cannot check out no-such-ref/);
  } finally {
    await s.done();
  }
});

test("a hanging run is killed with its whole process tree and reported as timed out, not failed", async () => {
  const s = await setup();
  const marker = `sleep ${4000 + process.pid % 1000}`; // unique per test process
  const alive = () => {
    try {
      return require("node:child_process").execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim() !== "";
    } catch {
      return false;
    }
  };
  try {
    put(s.dirs, "package.json", JSON.stringify({ name: "e2e", scripts: { test: "node --test" } }));
    put(s.dirs, "src/math.js", "exports.add = (a, b) => a + b;\n");
    // like `pnpm <script>` waiting on a child `pnpm install` that never returns
    put(s.dirs, "test/math.test.js", `require("node:child_process").spawn("sleep", ["${marker.split(" ")[1]}"], { stdio: "ignore" });\nrequire("../src/math.js");\nsetInterval(() => {}, 1000);\n`);
    git(s.dirs, "init", "-q", "-b", "main");
    git(s.dirs, "add", "-A");
    git(s.dirs, "commit", "-q", "-m", "init");
    await verify(s.pi, "js", "node --test", "node {file}");
    put(s.dirs, "src/math.js", "exports.add = (a, b) => a - b;\n");
    const plan = await s.pi.call("warden_check", { changed: ["src/math.js"] });
    const script = path.join(s.dirs.workspace, plan.run, "check.sh");
    assert.match(fs.readFileSync(script, "utf8"), /^LIMIT=600 /m);
    fs.writeFileSync(script, fs.readFileSync(script, "utf8").replace(/^LIMIT=\d+/m, "LIMIT=1"));
    const started = Date.now();
    const res = bash(s.dirs, `${plan.run}/check.sh`);
    assert.equal(res.code, 0, res.out);
    assert.ok(Date.now() - started < 30000, "the script does not wait for the hang");
    assert.match(res.out, /test-warden: base 1 -> timeout/, "progress is printed per run");
    assert.equal(alive(), false, "no process of the killed run is left behind");
    assert.match(get(s.dirs, `${plan.run}/logs/check-head-1.log`), /timed out after 1s/);
    const v = await s.pi.call("warden_check", { action: "verdict", run: plan.run });
    assert.deepEqual(v.timedOut, ["test/math.test.js"]);
    assert.deepEqual(v.incomplete, ["test/math.test.js"]);
    assert.deepEqual(v.regressions, [], "a timeout is never a failure");
    assert.match(v.note, /runTimeout/);
    assert.equal(worktrees(s), 1, "the temporary worktree is gone");
  } finally {
    await s.done();
  }
});
