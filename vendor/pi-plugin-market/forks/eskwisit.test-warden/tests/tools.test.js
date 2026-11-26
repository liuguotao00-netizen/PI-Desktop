"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setup, put, get, verify, ROOT } = require("./helpers");

/** A JS project with colocated *.test.ts files and a test helper. */
function jsProject(dirs) {
  put(dirs, "package.json", JSON.stringify({ name: "p", scripts: { test: "vitest run" } }));
  put(dirs, "src/cart.ts", "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n");
  put(dirs, "src/price/index.ts", "export const vat = (x: number) => x * 1.2;\n");
  put(dirs, "src/lonely.ts", "export const x = 1;\n");
  put(dirs, "src/cart.test.ts", 'import { total } from "./cart";\n');
  put(dirs, "src/checkout.test.ts", 'import { vat } from "./price";\nimport { total } from "./cart";\n');
  put(dirs, "test/helpers/clock.ts", "export const fakeClock = () => 0;\n");
  put(dirs, "test/flow.test.ts", 'import { fakeClock } from "./helpers/clock";\n');
  put(dirs, "node_modules/vitest/index.test.js", "ignored");
  put(dirs, "README.md", "# p\n");
}
const verifyJs = (s) => verify(s.pi, "js", "npm run test", "npx vitest run {file}");

test("profile: an Angular/Karma project gets its own command and patterns, no framework table", async () => {
  const s = await setup();
  try {
    put(s.dirs, "package.json", JSON.stringify({ scripts: { test: "ng test", "test:watch": "ng test --watch" }, devDependencies: { karma: "6", "jasmine-core": "5" } }));
    put(s.dirs, "angular.json", JSON.stringify({ projects: { app: { architect: { test: { options: { include: ["**/*.spec.ts"] } } } } } }));
    put(s.dirs, "karma.conf.js", "module.exports = (c) => c.set({ frameworks: ['jasmine'] });\n");
    put(s.dirs, "src/app/my-component.ts", "export class MyComponent {}\n");
    put(s.dirs, "src/app/my.compoent.spec.ts", 'import { TestBed } from "@angular/core/testing";\n');
    put(s.dirs, "src/app/other.spec.ts", "");
    put(s.dirs, ".github/workflows/ci.yml", "jobs:\n  t:\n    steps:\n      - run: npm ci\n      - run: npx ng test --watch=false --browsers=ChromeHeadless\n");
    const { profile } = await s.pi.call("warden_profile", {});
    const js = profile.stacks.find((x) => x.id === "js");
    assert.equal(js.suite, "npm run test");
    assert.equal(js.file, null, "no per-file command is invented");
    assert.equal(js.verified, false);
    assert.deepEqual(js.evidence, ["package.json scripts.test: ng test"]);
    assert.ok(profile.tests.patterns.includes("**/*.spec.ts"));
    assert.equal(profile.tests.count, 2);
    assert.ok(profile.configs.includes("angular.json") && profile.configs.includes("karma.conf.js"));
    assert.deepEqual(profile.ci, ["ci.yml: npx ng test --watch=false --browsers=ChromeHeadless"]);
    assert.ok(profile.warnings.some((w) => /unverified/.test(w)));

    await assert.rejects(s.pi.call("warden_check", { changed: ["src/app/my-component.ts"] }), /no verified test command for js/);
    await verify(s.pi, "js", "npx ng test --watch=false --browsers=ChromeHeadless", "");
    const r = await s.pi.call("warden_check", { changed: ["src/app/my-component.ts"] });
    assert.deepEqual(r.map, ["src/app/my-component.ts <- src/app/my.compoent.spec.ts"], "the typo'd spec is found by its name");
    assert.deepEqual(r.similar, ["src/app/my-component.ts ~ src/app/my.compoent.spec.ts"]);
    assert.match(get(s.dirs, `${r.run}/check.sh`), /run base "\$WTW" '\.' '<js suite>' 1 'npx ng test --watch=false --browsers=ChromeHeadless'/);
  } finally {
    await s.done();
  }
});

test("profile: an ecosystem the plugin knows nothing about works once its command is set", async () => {
  const s = await setup();
  try {
    put(s.dirs, "Gemfile", "source 'https://rubygems.org'\n");
    put(s.dirs, "lib/cart.rb", "class Cart; end\n");
    put(s.dirs, "spec/cart_spec.rb", "require_relative '../lib/cart'\n");
    put(s.dirs, "spec/spec_helper.rb", "");
    put(s.dirs, ".gitlab-ci.yml", "test:\n  script:\n    - bundle exec rspec --format progress\n");
    const { profile } = await s.pi.call("warden_profile", {});
    const rb = profile.stacks.find((x) => x.id === "rb");
    assert.equal(rb.suite, null);
    assert.ok(profile.warnings.some((w) => /^rb: the project declares no test command/.test(w)));
    assert.deepEqual(profile.ci, [".gitlab-ci.yml: bundle exec rspec --format progress"]);
    assert.deepEqual(profile.tests.patterns, ["**/*_spec.rb"]);
    assert.deepEqual(profile.helpers, ["spec/spec_helper.rb"]);

    const set = await verify(s.pi, "rb", "bundle exec rspec", "bundle exec rspec {file}");
    assert.equal(set.pinned, true);
    assert.ok(!set.profile.warnings.some((w) => /^rb:|unverified/.test(w)));
    const r = await s.pi.call("warden_check", { changed: ["lib/cart.rb"] });
    assert.deepEqual(r.map, ["lib/cart.rb <- spec/cart_spec.rb"]);
    assert.match(get(s.dirs, `${r.run}/check.sh`), /'bundle exec rspec '\\''spec\/cart_spec\.rb'\\'''/);
  } finally {
    await s.done();
  }
});

test("profile set validates its input and patterns change what counts as a test", async () => {
  const s = await setup();
  try {
    jsProject(s.dirs);
    await assert.rejects(s.pi.call("warden_profile", { action: "set", stack: "js", file: "npx vitest run" }), /must contain \{file\}/);
    await assert.rejects(s.pi.call("warden_profile", { action: "set", stack: "js", suite: "", file: "", verified: true }), /needs a suite or a file/);
    await assert.rejects(s.pi.call("warden_profile", { action: "set", stack: "Bad Id", suite: "x" }), /language group id/);
    await assert.rejects(s.pi.call("warden_profile", { action: "set", stack: "js", suite: "a\nb" }), /one line/);
    await verifyJs(s);
    const changed = await s.pi.call("warden_profile", { action: "set", stack: "js", suite: "npm run other" });
    assert.equal(changed.profile.stacks[0].verified, false, "a changed command must be verified again");
    put(s.dirs, "src/cart.check.ts", "");
    const r = await s.pi.call("warden_profile", { action: "set", patterns: ["**/*.check.ts"] });
    assert.equal(r.profile.tests.count, 1);
    assert.deepEqual(r.profile.examples, ["src/cart.check.ts"]);
  } finally {
    await s.done();
  }
});

test("profile caches, re-detects on config change, and a pinned profile survives", async () => {
  const s = await setup();
  try {
    jsProject(s.dirs);
    const first = await s.pi.call("warden_profile", {});
    assert.equal(first.cached, false);
    assert.deepEqual(first.profile.tests.patterns, ["**/*.test.ts"]);
    assert.deepEqual(first.profile.helpers, ["test/helpers/clock.ts"]);
    assert.deepEqual(first.settings, { maxWriters: 3, writerModel: "", runTimeout: 600, guardMinutes: 120 });
    assert.ok(JSON.stringify(first.profile).length < 2000, "the profile stays small");
    assert.match(get(s.dirs, ".test-warden/.gitignore"), /^runs\/\nguard\.json$/m);
    assert.equal((await s.pi.call("warden_profile", {})).cached, true);
    put(s.dirs, "package.json", JSON.stringify({ scripts: { "test:unit": "x" } }));
    assert.equal((await s.pi.call("warden_profile", {})).profile.stacks[0].suite, "npm run test:unit");
    await verifyJs(s);
    put(s.dirs, "package.json", JSON.stringify({ scripts: { test: "other" } }));
    const pinned = (await s.pi.call("warden_profile", {})).profile.stacks[0];
    assert.deepEqual([pinned.suite, pinned.verified], ["npm run test", true]);
  } finally {
    await s.done();
  }
});

test("profile warns on cold start and monorepos", async () => {
  const s = await setup();
  try {
    put(s.dirs, "package.json", "{}");
    put(s.dirs, "src/a.js", "");
    put(s.dirs, "packages/b/package.json", "{}");
    const { profile } = await s.pi.call("warden_profile", {});
    assert.ok(profile.warnings.some((w) => /cold start/.test(w)));
    assert.ok(profile.warnings.some((w) => /monorepo/.test(w)));
    assert.equal(profile.tests.learned, false);
  } finally {
    await s.done();
  }
});

test("check plan maps by name, import and directory stem; finds uncovered; re-runs helper users", async () => {
  const s = await setup();
  try {
    jsProject(s.dirs);
    await verifyJs(s);
    const r = await s.pi.call("warden_check", { changed: ["src/cart.ts", "./src/price/index.ts", "src/lonely.ts", "README.md", ".test-warden/x"] });
    assert.match(r.run, /^\.test-warden\/runs\/\d{8}-\d{6}-[0-9a-f]{4}$/);
    assert.equal(r.command, `bash ${r.run}/check.sh`);
    assert.deepEqual(r.map, ["src/cart.ts <- src/cart.test.ts, src/checkout.test.ts", "src/price/index.ts <- src/checkout.test.ts"]);
    assert.deepEqual(r.uncovered, ["src/lonely.ts"]);
    assert.deepEqual(r.suggest, [{ target: "src/lonely.ts", own: "src/lonely.test.ts", existing: false, bugs: "src/lonely.bugs.test.ts" }]);
    assert.deepEqual(r.ignored, ["README.md"]);
    assert.equal(r.units, 2);
    assert.equal(get(s.dirs, `${r.run}/snapshot/src/cart.ts`), get(s.dirs, "src/cart.ts"), "changed sources are snapshotted");

    const h = await s.pi.call("warden_check", { changed: ["test/helpers/clock.ts"] });
    assert.equal(h.units, 1);
    assert.match(get(s.dirs, `${h.run}/check.sh`), /test\/flow\.test\.ts/);
    assert.equal((await s.pi.call("warden_check", { changed: ["README.md"] })).nothing, true);
    const cold = await s.pi.call("warden_check", { changed: ["src/lonely.ts"] });
    assert.equal(cold.command, null);
    assert.ok(get(s.dirs, `${cold.run}/plan.json`), "a run exists for the diff and the gate");
  } finally {
    await s.done();
  }
});

test("check maps a source reached only through a test helper, and conftest re-runs its tests", async () => {
  const s = await setup();
  try {
    put(s.dirs, "package.json", "{}");
    put(s.dirs, "main.js", "module.exports = {};\n");
    put(s.dirs, "tests/helpers.js", 'const MAIN = require("path").join(__dirname, "..", "main.js");\n');
    put(s.dirs, "tests/a.test.js", 'const h = require("./helpers");\n');
    put(s.dirs, "tests/b.test.js", "// unrelated\n");
    put(s.dirs, "pyproject.toml", "");
    put(s.dirs, "app/core.py", "");
    put(s.dirs, "tests/conftest.py", "");
    put(s.dirs, "tests/unit/test_core.py", "from app.core import x\n");
    await verify(s.pi, "js", "node --test", "node --test {file}");
    await verify(s.pi, "py", "python3 -m pytest -q", "python3 -m pytest -q {file}");
    assert.deepEqual((await s.pi.call("warden_check", { changed: ["main.js"] })).map, ["main.js <- tests/a.test.js"]);
    const c = await s.pi.call("warden_check", { changed: ["tests/conftest.py"] });
    assert.equal(c.units, 1);
    assert.match(get(s.dirs, `${c.run}/check.sh`), /tests\/unit\/test_core\.py/);
  } finally {
    await s.done();
  }
});

test("check refuses a hostile base; verdict needs results", async () => {
  const s = await setup();
  try {
    jsProject(s.dirs);
    await verifyJs(s);
    await assert.rejects(s.pi.call("warden_check", { changed: ["src/cart.ts"], base: "HEAD; rm -rf /" }), /base must be a git ref/);
    await assert.rejects(s.pi.call("warden_check", { changed: ["src/cart.ts"], base: "--output=x" }), /base must be a git ref/);
    const r = await s.pi.call("warden_check", { changed: ["src/cart.ts"] });
    await assert.rejects(s.pi.call("warden_check", { action: "verdict", run: r.run }), /check\.tsv is missing/);
    await assert.rejects(s.pi.call("warden_check", { action: "verdict", run: ".test-warden/runs/nope" }), /plan\.json is missing/);
  } finally {
    await s.done();
  }
});

test("check verdict classifies regressions, new, still failing, fixed, removed and incomplete", async () => {
  const s = await setup();
  try {
    jsProject(s.dirs);
    await verifyJs(s);
    const r = await s.pi.call("warden_check", { changed: ["src/cart.ts"] });
    put(s.dirs, `${r.run}/check.tsv`, [
      "base\t1\t0\tsrc/cart.test.ts", "head\t1\t1\tsrc/cart.test.ts",
      "base\t2\t1\tsrc/a.test.ts", "head\t2\t1\tsrc/a.test.ts",
      "base\t3\tabsent\tsrc/b.test.ts", "head\t3\t1\tsrc/b.test.ts",
      "base\t4\t1\tsrc/c.test.ts", "head\t4\t0\tsrc/c.test.ts",
      "base\t5\t0\tsrc/d.test.ts", "head\t5\tabsent\tsrc/d.test.ts",
      "base\t6\t0\tsrc/e.test.ts",
    ].join("\n"));
    put(s.dirs, `${r.run}/logs/check-head-1.log`, "ok 1\nnot ok 2 - total\n  AssertionError: expected 6, received 5\n");
    const v = await s.pi.call("warden_check", { action: "verdict", run: r.run });
    assert.deepEqual(v.regressions.map((x) => x.test), ["src/cart.test.ts"]);
    assert.match(v.regressions[0].log, /expected 6, received 5/);
    assert.deepEqual(v.stillFailing, ["src/a.test.ts"]);
    assert.deepEqual(v.newFailing.map((x) => x.test), ["src/b.test.ts"]);
    assert.deepEqual(v.fixed, ["src/c.test.ts"]);
    assert.deepEqual(v.removed, ["src/d.test.ts"]);
    assert.ok(v.incomplete.includes("src/e.test.ts"));
    put(s.dirs, `${r.run}/check.tsv`, "base\t1\t0\tsrc/cart.test.ts\nhead\t1\t0\tsrc/cart.test.ts\n");
    const partial = await s.pi.call("warden_check", { action: "verdict", run: r.run });
    assert.deepEqual(partial.incomplete, ["src/checkout.test.ts"], "a planned unit missing from the results is incomplete");
  } finally {
    await s.done();
  }
});

test("suite plan: targets must be sources; suggests the suite file, extends a same-name test, snapshots both", async () => {
  const s = await setup();
  try {
    jsProject(s.dirs);
    await verifyJs(s);
    await assert.rejects(s.pi.call("warden_check", { mode: "suite", changed: ["src/cart.test.ts"] }), /must be source files/);
    await assert.rejects(s.pi.call("warden_check", { mode: "suite", changed: ["src/missing.ts"] }), /not found/);
    const r = await s.pi.call("warden_check", { mode: "suite", changed: ["src/cart.ts", "src/lonely.ts"] });
    assert.equal(r.mode, "suite");
    assert.deepEqual(r.suggest, [
      { target: "src/cart.ts", own: "src/cart.test.ts", existing: true, bugs: "src/cart.bugs.test.ts" },
      { target: "src/lonely.ts", own: "src/lonely.test.ts", existing: false, bugs: "src/lonely.bugs.test.ts" },
    ]);
    assert.ok(get(s.dirs, `${r.run}/snapshot/src/cart.test.ts`), "an existing suite file a writer will extend is snapshotted");
    const script = get(s.dirs, `${r.run}/check.sh`);
    assert.doesNotMatch(script, /worktree add/, "suite mode runs the existing tests on the current code only");
    put(s.dirs, `${r.run}/check.tsv`, ["head\t1\t0\tsrc/cart.test.ts", "head\t2\t1\tsrc/checkout.test.ts"].join("\n"));
    const v = await s.pi.call("warden_check", { action: "verdict", run: r.run });
    assert.equal(v.passed, 1);
    assert.deepEqual(v.failing.map((f) => f.test), ["src/checkout.test.ts"]);
    assert.match(v.note, /never edit the targets/);
  } finally {
    await s.done();
  }
});

test("gate plan: a changed target is detected by content and restored from the snapshot, whoever reported what", async () => {
  const s = await setup();
  try {
    jsProject(s.dirs);
    await verifyJs(s);
    const r = await s.pi.call("warden_check", { mode: "suite", changed: ["src/lonely.ts"] });
    put(s.dirs, "src/lonely.test.ts", 'import { x } from "./lonely";\n');
    put(s.dirs, "src/lonely.ts", "export const x = 2; // a writer 'fixed' it\n");
    put(s.dirs, "src/cart.ts", "tampered\n");
    const g = await s.pi.call("warden_gate", { run: r.run, kind: "suite", tests: ["src/lonely.test.ts"], written: ["src/lonely.test.ts", "src/cart.ts", "package.json"] });
    assert.deepEqual(g.protectedChanged, ["src/lonely.ts"], "detected although the writer did not report it");
    assert.deepEqual(g.violations, ["src/cart.ts", "package.json"]);
    assert.match(g.restoreCommand, /^if \[ -f '\.test-warden\/runs\/[^']+\/snapshot\/src\/lonely\.ts' \]; then cp -- /);
    assert.doesNotMatch(g.restoreCommand, /git checkout/);
    assert.deepEqual(g.manualReview, ["src/cart.ts", "package.json"], "files without a snapshot are reviewed by hand, never checked out");
    const script = get(s.dirs, `${r.run}/gate.sh`);
    assert.match(script, /: > "\$WTW\/"'src\/lonely\.ts'/, "the suite gate empties the target in the worktree");
    assert.match(script, /run sabotage "\$WTW"/);
    await assert.rejects(s.pi.call("warden_gate", { run: r.run, kind: "oops", tests: ["src/lonely.test.ts"] }), /kind must be/);
    await assert.rejects(s.pi.call("warden_gate", { run: ".test-warden/runs/none", kind: "suite", tests: ["src/lonely.test.ts"] }), /plan\.json is missing/);
    await assert.rejects(s.pi.call("warden_gate", { run: r.run, kind: "suite", tests: ["src/nope.test.ts"] }), /not found/);
    await assert.rejects(s.pi.call("warden_gate", { run: r.run, kind: "suite", tests: ["src/cart.ts"] }), /not test files/);
  } finally {
    await s.done();
  }
});

test("gate verdict (fix): keeps tests that catch the change, rejects useless, flaky and broken ones", async () => {
  const s = await setup();
  try {
    jsProject(s.dirs);
    await verifyJs(s);
    const r = await s.pi.call("warden_check", { changed: ["src/cart.ts"] });
    const files = ["src/good.test.ts", "src/useless.test.ts", "src/flaky.test.ts", "src/broken.test.ts", "src/late.test.ts"];
    for (const f of files) put(s.dirs, f, "");
    await s.pi.call("warden_gate", { run: r.run, kind: "fix", tests: files });
    const rows = [];
    const add = (n, key, old, heads, side = "base") => {
      if (old !== null) rows.push(`${side}\t${n}\t${old}\t${key}`);
      heads.forEach((rc, i) => rows.push(`head${i + 1}\t${n}\t${rc}\t${key}`));
    };
    add(1, "src/good.test.ts", 1, [0, 0, 0]);
    add(2, "src/useless.test.ts", 0, [0, 0, 0]);
    add(3, "src/flaky.test.ts", 1, [0, 1, 0]);
    add(4, "src/broken.test.ts", 1, [1, 1, 1]);
    add(5, "src/late.test.ts", 1, [0]);
    put(s.dirs, `${r.run}/gate.tsv`, rows.join("\n"));
    const v = await s.pi.call("warden_gate", { action: "verdict", run: r.run });
    assert.deepEqual(v.keep, ["src/good.test.ts"]);
    assert.deepEqual(v.reject.map((x) => [x.test, x.reason.split(":")[0]]), [
      ["src/useless.test.ts", "passes on the old code"],
      ["src/flaky.test.ts", "flaky"],
      ["src/broken.test.ts", "fails on the new code"],
    ]);
    assert.deepEqual(v.incomplete, ["src/late.test.ts"]);
    // an absent head result is incomplete, not a failure
    put(s.dirs, `${r.run}/gate.tsv`, ["base\t1\t1\tsrc/good.test.ts", "head1\t1\tabsent\tsrc/good.test.ts", "head2\t1\tabsent\tsrc/good.test.ts", "head3\t1\tabsent\tsrc/good.test.ts"].join("\n"));
    const absent = await s.pi.call("warden_gate", { action: "verdict", run: r.run });
    assert.deepEqual(absent.reject, []);
    assert.ok(absent.incomplete.includes("src/good.test.ts"));
    for (const f of ["useless", "flaky", "broken"]) assert.match(v.undoCommand, new RegExp(`src/${f}\\.test\\.ts`));
    assert.doesNotMatch(v.undoCommand, /good/);
  } finally {
    await s.done();
  }
});

test("gate verdict (suite): must fail with the target emptied; bug files must fail; undo restores snapshots", async () => {
  const s = await setup();
  try {
    jsProject(s.dirs);
    await verifyJs(s);
    const r = await s.pi.call("warden_check", { mode: "suite", changed: ["src/cart.ts"] });
    put(s.dirs, "src/cart.test.ts", "extended by the writer\n"); // existing, snapshotted
    for (const f of ["src/cart.more.test.ts", "src/cart.bugs.test.ts", "src/cart.nobug.test.ts"]) put(s.dirs, f, "");
    const g = await s.pi.call("warden_gate", {
      run: r.run, kind: "suite",
      tests: ["src/cart.test.ts", "src/cart.more.test.ts"], bugs: ["src/cart.bugs.test.ts", "src/cart.nobug.test.ts"],
    });
    assert.equal(g.protectedChanged, undefined);
    const script = get(s.dirs, `${r.run}/gate.sh`);
    assert.equal((script.match(/^run sabotage /gm) || []).length, 2, "bug files never run on the emptied target");
    put(s.dirs, `${r.run}/gate.tsv`, [
      "sabotage\t1\t1\tsrc/cart.test.ts", "head1\t1\t0\tsrc/cart.test.ts", "head2\t1\t0\tsrc/cart.test.ts", "head3\t1\t0\tsrc/cart.test.ts",
      "sabotage\t2\t0\tsrc/cart.more.test.ts", "head1\t2\t0\tsrc/cart.more.test.ts", "head2\t2\t0\tsrc/cart.more.test.ts", "head3\t2\t0\tsrc/cart.more.test.ts",
      "head1\t3\t1\tsrc/cart.bugs.test.ts", "head2\t3\t1\tsrc/cart.bugs.test.ts", "head3\t3\t1\tsrc/cart.bugs.test.ts",
      "head1\t4\t0\tsrc/cart.nobug.test.ts", "head2\t4\t0\tsrc/cart.nobug.test.ts", "head3\t4\t0\tsrc/cart.nobug.test.ts",
    ].join("\n"));
    put(s.dirs, `${r.run}/logs/gate-head1-3.log`, "AssertionError: expected 0 for an empty cart, received NaN\n");
    const v = await s.pi.call("warden_gate", { action: "verdict", run: r.run });
    assert.deepEqual(v.keep, ["src/cart.test.ts"]);
    assert.deepEqual(v.reject.map((x) => x.test), ["src/cart.more.test.ts"]);
    assert.match(v.reject[0].reason, /passes with src\/cart\.ts emptied: it does not exercise the target/);
    assert.deepEqual(v.bugs.confirmed.map((b) => b.test), ["src/cart.bugs.test.ts"]);
    assert.match(v.bugs.confirmed[0].log, /received NaN/);
    assert.deepEqual(v.bugs.notReproduced.map((b) => b.test), ["src/cart.nobug.test.ts"]);
    assert.match(v.undoCommand, /src\/cart\.more\.test\.ts/);
    assert.match(v.undoCommand, /src\/cart\.nobug\.test\.ts/);
    assert.doesNotMatch(v.undoCommand, /cart\.bugs/, "a confirmed bug reproduction is kept");
  } finally {
    await s.done();
  }
});

test("gate with a suite-level command: tests run without the bug files; incomplete is tracked per unit, not per key", async () => {
  const s = await setup();
  try {
    jsProject(s.dirs);
    await verify(s.pi, "js", "npm run test", "");
    const r = await s.pi.call("warden_check", { mode: "suite", changed: ["src/lonely.ts"] });
    put(s.dirs, "src/lonely.test.ts", "");
    put(s.dirs, "src/lonely.bugs.test.ts", "");
    const g = await s.pi.call("warden_gate", { run: r.run, kind: "suite", tests: ["src/lonely.test.ts"], bugs: ["src/lonely.bugs.test.ts"] });
    assert.equal(g.units, 2);
    const script = get(s.dirs, `${r.run}/gate.sh`);
    assert.match(script, /rm -f "\$HTW\/"'src\/lonely\.bugs\.test\.ts'/);
    assert.match(script, /rm -f "\$WTW\/"'src\/lonely\.bugs\.test\.ts'/);
    assert.match(script, /run head1 "\$HTW" '\.' '<js suite>' 1/);
    assert.match(script, /run head1 "\$WS" '\.' '<js suite>' 2/);
    put(s.dirs, `${r.run}/gate.tsv`, ["sabotage\t1\t1\t<js suite>", "head1\t1\t0\t<js suite>", "head2\t1\t0\t<js suite>", "head3\t1\t0\t<js suite>"].join("\n"));
    const v = await s.pi.call("warden_gate", { action: "verdict", run: r.run });
    assert.deepEqual(v.keep, ["<js suite>"]);
    assert.deepEqual(v.incomplete, ["<js suite>"], "the bug unit (same key, unit 2) did not run");
  } finally {
    await s.done();
  }
});

test("warden_lessons: evidence required, dedup, merge, cap, prune, remove", async () => {
  const s = await setup();
  try {
    put(s.dirs, "tests/helpers.js", "");
    put(s.dirs, "src/db.ts", "");
    const add = (lessons) => s.pi.call("warden_lessons", { action: "add", lessons });
    const r1 = await add([
      { text: "Use fakeClock() from tests/helpers.js for anything time-based", evidence: "tests/helpers.js:3" },
      { text: "too short", evidence: "tests/helpers.js" },
      { text: "DB tests need TEST_DB=1 or they hit the real database", evidence: "src/missing.ts" },
      { text: "two\nlines are joined into one line here", evidence: "src/db.ts" },
    ]);
    assert.equal(r1.added.length, 2);
    assert.equal(r1.rejected.length, 2);
    const r2 = await add([{ text: "Always use fakeClock() from tests/helpers.js for anything time-based", evidence: "tests/helpers.js" }]);
    assert.equal(r2.merged.length, 1);
    for (let i = 0; i < 40; i++) await add([{ text: `distinct lesson number ${i} about module m${i}`, evidence: "src/db.ts" }]);
    const capped = await s.pi.call("warden_lessons", {});
    assert.equal(capped.count, s.t.LESSON_CAP);
    assert.match(capped.lessons.at(-1), /number 39/);
    fs.rmSync(path.join(s.dirs.workspace, "src/db.ts"));
    assert.equal((await s.pi.call("warden_lessons", {})).count, 0, "lessons whose evidence is gone are dropped");
    await add([{ text: "Use fakeClock() from tests/helpers.js for timers", evidence: "tests/helpers.js" }]);
    const id = (await s.pi.call("warden_lessons", {})).lessons[0].split(" ")[0];
    assert.equal((await s.pi.call("warden_lessons", { action: "remove", ids: [id] })).count, 0);
  } finally {
    await s.done();
  }
});

test("manifest agentTools match the registered tools; the plugin writes only to .test-warden", async () => {
  const s = await setup();
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
    const declared = manifest.contributes.agentTools.map(({ name, description, risk, schema }) => ({ name, description, risk, schema }));
    const actual = s.t.TOOLS.map(({ name, description, risk, schema }) => ({ name, description, risk, schema }));
    assert.deepEqual(JSON.parse(JSON.stringify(declared)), JSON.parse(JSON.stringify(actual)));
    assert.deepEqual([...s.pi.tools.keys()], actual.map((x) => x.name));
    assert.ok(s.pi.writes.every((w) => w.startsWith(".test-warden/")));
  } finally {
    await s.done();
  }
});

test("manifest meets the plugin center fields: license, a host category, en and zh-CN texts", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.equal(m.license, "Apache-2.0");
  assert.match(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0/);
  const hostCategories = ["coding", "data", "devtools", "docs", "productivity", "web", "workflow", "writing"];
  assert.ok(m.categories.length && m.categories.every((c) => hostCategories.includes(c)), `categories: ${m.categories}`);
  for (const lang of ["en", "zh-CN"]) {
    for (const key of ["name", "description", "safetyNotes"]) assert.ok(m.i18n[lang] && m.i18n[lang][key], `i18n.${lang}.${key}`);
  }
  assert.equal(m.i18n.en.description, m.description);
  assert.equal(m.i18n.en.safetyNotes, m.safetyNotes);
  assert.match(m.i18n["zh-CN"].description, /[\u4e00-\u9fff]/);
});

test("no framework name drives behaviour in main.js", () => {
  const src = fs.readFileSync(path.join(ROOT, "main.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  // config files are discovered by name (ROOT_FILE_RE, MANIFEST_GROUPS); that is the only place names may appear
  const code = src.replace(/const ROOT_FILE_RE = [^\n]*\n/, "").replace(/const MANIFEST_GROUPS = \{[\s\S]*?\};/, "");
  for (const fw of ["vitest", "jest", "mocha", "karma", "jasmine", "pytest", "unittest", "rspec", "phpunit", "junit"]) {
    assert.doesNotMatch(code, new RegExp(`\\b${fw}\\b`, "i"), `${fw} appears in the logic`);
  }
});

test("runTimeout is clamped and reaches the generated scripts", async () => {
  for (const [given, want] of [[5, 30], [90.4, 90], [99999, 7200], ["x", 600], [0, 600]]) {
    const s = await setup({ settings: { runTimeout: given } });
    try {
      assert.equal((await s.pi.call("warden_profile", {})).settings.runTimeout, want, `runTimeout ${given}`);
    } finally {
      await s.done();
    }
  }
});

test("guard.json: plan writes it with the sources, lessons add and release delete it, guardMinutes is clamped", async () => {
  const s = await setup({ settings: { guardMinutes: 30 } });
  try {
    jsProject(s.dirs);
    await verifyJs(s);
    const before = Date.now();
    const r = await s.pi.call("warden_check", { changed: ["src/cart.ts", "src/cart.test.ts", "README.md"] });
    const g = JSON.parse(get(s.dirs, ".test-warden/guard.json"));
    assert.deepEqual(Object.keys(g).sort(), ["run", "since", "sources", "until"]);
    assert.equal(g.run, r.run);
    assert.deepEqual(g.sources, ["src/cart.ts"], "tests and ignored files are not protected");
    const since = Date.parse(g.since);
    assert.ok(since >= before - 1000 && since <= Date.now());
    assert.equal(Date.parse(g.until) - since, 30 * 60000);

    const again = await s.pi.call("warden_check", { changed: ["src/lonely.ts"] });
    assert.equal(JSON.parse(get(s.dirs, ".test-warden/guard.json")).run, again.run, "a new plan replaces the guard");

    await s.pi.call("warden_lessons", { action: "add", lessons: [{ text: "run vitest with --run, never watch mode", evidence: "package.json" }] });
    assert.equal(get(s.dirs, ".test-warden/guard.json"), null, "lessons add ends the run");

    await s.pi.call("warden_check", { changed: ["src/cart.ts"] });
    assert.ok(get(s.dirs, ".test-warden/guard.json"));
    assert.equal((await s.pi.call("warden_check", { action: "release" })).released, true);
    assert.equal(get(s.dirs, ".test-warden/guard.json"), null, "release ends the guard");
    assert.equal((await s.pi.call("warden_check", { action: "release" })).released, false);
    await assert.rejects(s.pi.call("warden_check", { action: "bogus" }), /plan.*verdict.*release/);
  } finally {
    await s.done();
  }
  for (const [given, want] of [[0, 120], ["x", 120], [99999, 1440], [15.6, 16]]) {
    const c = await setup({ settings: { guardMinutes: given } });
    try {
      assert.equal((await c.pi.call("warden_profile", {})).settings.guardMinutes, want, `guardMinutes ${given}`);
    } finally {
      await c.done();
    }
  }
});

test("guard.json: without a host delete, the guard is left expired", async () => {
  const s = await setup();
  try {
    delete s.pi.fs.remove;
    jsProject(s.dirs);
    await verifyJs(s);
    await s.pi.call("warden_check", { changed: ["src/cart.ts"] });
    assert.equal((await s.pi.call("warden_check", { action: "release" })).released, true);
    const g = JSON.parse(get(s.dirs, ".test-warden/guard.json"));
    assert.deepEqual(g.sources, []);
    assert.ok(Date.parse(g.until) <= Date.now());
  } finally {
    await s.done();
  }
});
