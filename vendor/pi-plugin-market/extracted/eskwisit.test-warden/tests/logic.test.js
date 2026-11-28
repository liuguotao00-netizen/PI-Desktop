"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadMain, sandbox, fakePi } = require("./helpers");

const t = loadMain(fakePi(sandbox())).__t;
const bashOk = (script) => {
  const file = path.join(sandbox().base, "s.sh");
  fs.writeFileSync(file, script);
  execFileSync("bash", ["-n", file]);
};

test("relPath normalises and refuses escapes", () => {
  assert.equal(t.relPath("./src//a.ts"), "src/a.ts");
  assert.equal(t.relPath("src\\a.ts:42:7"), "src/a.ts");
  assert.equal(t.relPath("/etc/passwd"), "");
  assert.equal(t.relPath("C:/x"), "");
  assert.equal(t.relPath("a/../../b"), "");
});

test("q single-quotes for sh, including embedded quotes", () => {
  const quoted = t.q("it's $HOME `x`");
  assert.equal(execFileSync("bash", ["-c", `printf %s ${quoted}`], { encoding: "utf8" }), "it's $HOME `x`");
});

test("runPath accepts ids and run paths, refuses anything else", () => {
  assert.equal(t.runPath("20260101-120000-ab12"), ".test-warden/runs/20260101-120000-ab12");
  assert.throws(() => t.runPath("../etc"), /run must look like/);
  assert.throws(() => t.runPath(".test-warden/runs/a/b"), /run must look like/);
});

test("groupOf groups by language family, not by framework", () => {
  assert.equal(t.groupOf("a.tsx"), "js");
  assert.equal(t.groupOf("a.vue"), "js");
  assert.equal(t.groupOf("a.py"), "py");
  assert.equal(t.groupOf("a.h"), "c");
  assert.equal(t.groupOf("Foo.kts"), "kt");
  assert.equal(t.groupOf("README.md"), null);
});

test("globRe handles **, *, braces and bare patterns", () => {
  assert.ok(t.globRe("**/*.spec.ts").test("src/a/b.spec.ts"));
  assert.ok(t.globRe("**/*.spec.ts").test("b.spec.ts"));
  assert.ok(t.globRe("*.spec.ts").test("deep/x/b.spec.ts"), "a bare pattern matches at any depth");
  assert.ok(t.globRe("src/**/*.spec.ts").test("src/x.spec.ts"));
  assert.ok(!t.globRe("src/**/*.spec.ts").test("lib/x.spec.ts"));
  assert.ok(t.globRe("**/*.{test,spec}.{js,ts}").test("a/b.test.ts"));
  assert.ok(!t.globRe("**/*.{test,spec}.{js,ts}").test("a/b.check.ts"));
});

test("isTestFile follows conventions across ecosystems, or the project's own patterns", () => {
  for (const p of ["src/a.test.ts", "src/app/my.compoent.spec.ts", "src/__tests__/a.js", "tests/test_api.py", "pkg/x_test.go",
    "src/test/java/FooTest.java", "spec/foo_spec.rb", "tests/FooTest.php", "test/a.js", "tests/integration.rs"]) {
    assert.ok(t.isTestFile(p), p);
  }
  for (const p of ["tests/helpers.js", "tests/index.js", "tests/conftest.py", "test/fixtures/user.ts", "src/a.ts", "README.test.md"]) {
    assert.ok(!t.isTestFile(p), p);
  }
  assert.ok(t.isTestFile("src/a.check.ts", ["**/*.check.ts"]));
  assert.ok(!t.isTestFile("src/a.test.ts", ["**/*.check.ts"]));
});

test("isHelperFile spots helpers, fixtures, mocks and conftest", () => {
  assert.ok(t.isHelperFile("tests/helpers.js"));
  assert.ok(t.isHelperFile("test/fixtures/user.ts"));
  assert.ok(t.isHelperFile("tests/conftest.py"));
  assert.ok(t.isHelperFile("src/__mocks__/fs.js"));
  assert.ok(!t.isHelperFile("src/helpers.ts"), "a helpers module outside test dirs is source");
  assert.ok(!t.isHelperFile("src/a.test.ts"));
});

test("testStem and nameMatch ignore separators and allow one typo", () => {
  assert.equal(t.testStem("src/foo.test.ts"), "foo");
  assert.equal(t.testStem("tests/test_foo.py"), "foo");
  assert.equal(t.testStem("pkg/foo_test.go"), "foo");
  assert.equal(t.testStem("src/FooTest.java"), "Foo");
  assert.equal(t.testStem("spec/foo_spec.rb"), "foo");
  assert.equal(t.testStem("src/app/my.compoent.spec.ts"), "my.compoent");
  assert.equal(t.nameMatch("my.component", "my-component"), "same");
  assert.equal(t.nameMatch("my.compoent", "my-component"), "similar");
  assert.equal(t.nameMatch("cart", "card"), null, "short names need an exact match");
  assert.equal(t.nameMatch("checkout", "cart"), null);
  assert.deepEqual(t.sourceStems("src/cart/index.ts"), ["index", "cart"]);
});

test("refersTo matches imports in any language, not substrings", () => {
  assert.ok(t.refersTo('import { a } from "../src/my-component";', "my-component", "js"));
  assert.ok(t.refersTo("const m = require('./lib/cart.js')", "cart", "js"));
  assert.ok(!t.refersTo('import x from "../src/shopping-cart-utils"', "cart", "js"));
  assert.ok(t.refersTo("from shop.cart import total", "cart", "py"));
  assert.ok(!t.refersTo("from shop.cartography import x", "cart", "py"));
  assert.ok(t.refersTo("import com.shop.Cart;", "Cart", "java"));
  assert.ok(t.refersTo("require_relative '../lib/cart'", "cart", "rb"));
  assert.ok(t.refersTo('#include "cart.h"', "cart", "c"));
  assert.ok(!t.refersTo("// the cart is great", "cart", "java"));
});

test("extractGlobs reads the project's test globs out of any config", () => {
  const angular = JSON.stringify({ projects: { app: { architect: { test: { options: { include: ["**/*.spec.ts"], exclude: ["!**/e2e/**"] } } } } } });
  assert.deepEqual(t.extractGlobs(angular), ["**/*.spec.ts"]);
  assert.deepEqual(t.extractGlobs('module.exports = { testMatch: ["<rootDir>/src/**/*.test.js", "**/node_modules/**/*.test.js"], collectCoverageFrom: ["src/**/*.js"] }'), ["src/**/*.test.js"]);
  assert.deepEqual(t.extractGlobs('"test": "mocha \'test/**/*.spec.js\' --recursive"'), ["test/**/*.spec.js"]);
  assert.deepEqual(t.extractGlobs('{ "include": ["src/**/*.ts"] }'), [], "globs without test/spec are not test patterns");
});

test("generalize turns a test file name into its pattern", () => {
  assert.equal(t.generalize("src/app/my.compoent.spec.ts"), "**/*.spec.ts");
  assert.equal(t.generalize("pkg/x_test.go"), "**/*_test.go");
  assert.equal(t.generalize("tests/test_x.py"), "**/test_*.py");
  assert.equal(t.generalize("src/FooTest.java"), "**/*Test.java");
  assert.equal(t.generalize("test/a.js"), null);
});

test("declaredCommands reads what the project declares, never a framework table", () => {
  const pkg = JSON.stringify({ scripts: { test: "ng test", "test:watch": "ng test --watch", build: "ng build" }, devDependencies: { karma: "6" } });
  assert.deepEqual(t.declaredCommands("js", { "package.json": pkg }, new Set(["pnpm-lock.yaml"])), {
    candidates: ["pnpm run test"],
    evidence: ["package.json scripts.test: ng test"],
  });
  assert.deepEqual(t.declaredCommands("py", { Makefile: "lint:\n\truff .\ntest:\n\tpytest -q\n" }, new Set()).candidates, ["make test"]);
  assert.deepEqual(t.declaredCommands("py", {}, new Set()).candidates, [], "no guessing: nothing declared, nothing proposed");
  assert.deepEqual(t.declaredCommands("go", { "go.mod": "module x" }, new Set()).candidates, ["go test ./..."]);
});

test("unitOf: per file with {file}, per directory with {dir}, else the suite", () => {
  const profile = {
    stacks: [
      { id: "js", suite: "npm test", file: "npx vitest run {file}" },
      { id: "go", suite: "go test ./...", file: "go test ./{dir}" },
      { id: "rb", suite: "bundle exec rspec", file: null },
    ],
  };
  assert.deepEqual(t.unitOf(profile, "src/a b.test.ts"), { key: "src/a b.test.ts", path: "src/a b.test.ts", cmd: "npx vitest run 'src/a b.test.ts'", stack: "js" });
  assert.deepEqual(t.unitOf(profile, "pkg/x/y_test.go"), { key: "pkg/x", path: "pkg/x", cmd: "go test './pkg/x'", stack: "go" });
  assert.deepEqual(t.unitOf(profile, "spec/a_spec.rb"), { key: "<rb suite>", path: ".", cmd: "bundle exec rspec", stack: "rb" });
  assert.equal(t.unitOf(profile, "tests/test_a.py"), null);
  assert.equal(t.unitOf(profile, "src/cost$.test.ts").cmd, "npx vitest run 'src/cost$.test.ts'", "replacement patterns in paths are not expanded");
  const units = t.unitsOf(profile, ["pkg/a_test.go", "pkg/b_test.go", "spec/a_spec.rb", "spec/b_spec.rb"]);
  assert.deepEqual(units.map((u) => [u.key, u.files]), [["pkg", ["pkg/a_test.go", "pkg/b_test.go"]], ["<rb suite>", ["spec/a_spec.rb", "spec/b_spec.rb"]]]);
  assert.equal(t.unitsOf(profile, ["spec/a_spec.rb"], "bug")[0].role, "bug");
});

test("buildScript variants are valid bash and quote hostile names", () => {
  const units = [{ key: "t/it's.test.js", path: "t/it's.test.js", cmd: "node --test 't/it'\\''s.test.js'" }, { key: "b.test.js", path: "b.test.js", cmd: "x", role: "bug" }];
  const fix = t.buildScript({ run: ".test-warden/runs/x", name: "gate", base: "HEAD~1", copies: ["t/it's.test.js"], units, headRuns: 3, title: "gate" });
  bashOk(fix);
  assert.match(fix, /run head3 /);
  assert.match(fix, /worktree add --detach/);
  assert.equal((fix.match(/^run base /gm) || []).length, 1, "bug units never run on the old code");
  const suite = t.buildScript({ run: ".test-warden/runs/x", name: "gate", base: "HEAD", overlay: true, sabotage: ["src/it's.ts"], units, headRuns: 3, oldSide: "sabotage", title: "suite" });
  bashOk(suite);
  assert.match(suite, /ls-files -o --exclude-standard -z/);
  assert.match(suite, /: > "\$WTW\/"'src\/it'\\''s\.ts'/);
  const head = t.buildScript({ run: ".test-warden/runs/x", name: "check", units: units.slice(0, 1), title: "check" });
  bashOk(head);
  assert.doesNotMatch(head, /worktree/, "a head-only run needs no worktree");
  assert.match(head, /^export pnpm_config_verify_deps_before_run=false npm_config_verify_deps_before_run=false$/m, "a run never installs packages");
  assert.match(head, /^LIMIT=600 /m, "the default per-run timeout");
  assert.match(t.buildScript({ run: ".test-warden/runs/x", name: "check", units: units.slice(0, 1), title: "check", timeout: 45 }), /^LIMIT=45 /m);
});

test("parseTsv reads results", () => {
  const { units } = t.parseTsv("base\t1\t0\ta.test.js\nhead1\t1\t1\ta.test.js\nbase\t2\tabsent\tb.test.js\n\njunk\n");
  assert.deepEqual(units.get("1"), { key: "a.test.js", sides: { base: 0, head1: 1 } });
  assert.deepEqual(units.get("2").sides, { base: "absent" });
  assert.equal(units.size, 2);
  assert.deepEqual(t.parseTsv("head\t1\ttimeout\ta.test.js\n").units.get("1").sides, { head: "timeout" });
});

test("excerpt keeps failure lines and caps the size", () => {
  const log = ["noise"].concat(Array.from({ length: 40 }, (_, i) => `not ok ${i} - AssertionError: expected ${i}`)).join("\n");
  assert.equal(t.excerpt(log).split("\n").length, 15);
  assert.equal(t.excerpt("a\nb\nc"), "a\nb\nc");
});

test("undoCommand restores snapshots exactly; never truncates or checks out a file without one", () => {
  const snap = { "src/a.ts": { sha: "x" }, "src/new.ts": { absent: true }, "src/big.ts": { skipped: true, sha: "y" } };
  const cmd = t.undoCommand(["src/a.ts", "src/new.ts", "src/big.ts", "t/it's.test.js"], snap, ".test-warden/runs/r");
  assert.match(cmd, /^if \[ -f '\.test-warden\/runs\/r\/snapshot\/src\/a\.ts' \]; then cp -- '\.test-warden\/runs\/r\/snapshot\/src\/a\.ts' 'src\/a\.ts'; else printf/);
  assert.match(cmd, /; rm -f -- 'src\/new\.ts'; /);
  assert.doesNotMatch(cmd, /git checkout/, "no fallback to HEAD: it would lose uncommitted work");
  assert.doesNotMatch(cmd, /cat .*>/, "no shell truncation before the copy");
  assert.match(cmd, /then printf 'test-warden: no snapshot, review by hand: %s\\n' 'src\/big\.ts' >&2; else rm -f -- 'src\/big\.ts'; fi/);
  execFileSync("bash", ["-n", "-c", cmd]);
});

test("undoCommand at run time: missing snapshot leaves the file alone; untracked unsnapshotted files are removed", () => {
  const dir = sandbox().base;
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "keep.js"), "user work");
  fs.writeFileSync(path.join(dir, "new.test.js"), "writer file");
  const cmd = t.undoCommand(["keep.js", "new.test.js"], { "keep.js": { sha: "x" } }, ".test-warden/runs/gone");
  execFileSync("bash", ["-c", cmd], { cwd: dir, stdio: "ignore" });
  assert.equal(fs.readFileSync(path.join(dir, "keep.js"), "utf8"), "user work");
  assert.equal(fs.existsSync(path.join(dir, "new.test.js")), false);
});

test("suggestPaths and variantPath follow the project's naming", () => {
  const patterns = ["**/*.spec.ts"];
  const profile = { stacks: [{ id: "js", naming: "**/*.spec.ts" }], tests: { layout: "colocated", dirs: [] } };
  assert.deepEqual(t.suggestPaths(profile, "src/app/my-component.ts", patterns), { own: "src/app/my-component.spec.ts", bugs: "src/app/my-component.bugs.spec.ts" });
  const py = { stacks: [{ id: "py", naming: "**/test_*.py" }], tests: { layout: "separate", dirs: ["tests"] } };
  assert.deepEqual(t.suggestPaths(py, "app/core.py", ["**/test_*.py"]), { own: "tests/test_core.py", bugs: "tests/test_core_bugs.py" });
  assert.equal(t.variantPath("pkg/clamp_test.go", "bugs", ["**/*_test.go"]), "pkg/clamp.bugs_test.go");
  const sep = { stacks: [{ id: "js", naming: "**/*.test.js" }], tests: { layout: "separate", dirs: ["tests"] } };
  const taken = new Set(["tests/index.test.js"]);
  assert.equal(t.suggestPaths(sep, "src/a/index.js", ["**/*.test.js"], taken).own, "tests/a-index.test.js", "no collision between same-stem targets");
  assert.equal(t.suggestPaths({ stacks: [{ id: "js", naming: "tests/**/*.js" }], tests: {} }, "src/x.js", ["tests/**/*.js"]).own, "tests/x.js");
  assert.equal(t.suggestPaths({ stacks: [], tests: {} }, "src/x.js", ["**/*.check.js"]).own, null, "no valid name: no suggestion rather than a non-test path");
  assert.equal(t.variantPath("src/FooTest.java", "bugs", ["**/*Test.java"]), "src/FooBugsTest.java");
});

test("jaccard similarity", () => {
  assert.equal(t.jaccard("use the fake clock helper", "use the fake clock helper"), 1);
  assert.equal(t.jaccard("alpha beta", "gamma delta"), 0);
});
