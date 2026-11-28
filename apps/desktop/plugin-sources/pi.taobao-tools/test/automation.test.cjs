"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-taobao-automation-test-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;

const catalog = require("../compiled/bridge/automation/catalog.js");
const params = require("../compiled/bridge/automation/params.js");
const pageScripts = require("../compiled/bridge/automation/page-scripts.js");
const publishGuard = require("../compiled/bridge/automation/publish-guard.js");
const runs = require("../compiled/bridge/automation/runs.js");
const dsl = require("../compiled/bridge/automation/dsl.js");

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("catalogue loads every bundled script and derives its kind", () => {
  const scripts = catalog.loadScripts();
  const ids = Object.keys(scripts);
  assert.ok(ids.length >= 34, `expected the QiWork library, got ${ids.length}`);
  for (const [id, script] of Object.entries(scripts)) {
    assert.equal(script.id, id);
    assert.ok(script.steps.length > 0, id);
    assert.ok(["collect", "publish", "interact"].includes(script.kind), id);
    assert.ok(fs.existsSync(path.join(catalog.SCRIPTS_DIR, `${id}.json`)));
  }
  const catalogItems = catalog.scriptCatalog();
  const platforms = new Set(catalogItems.map((item) => item.platform));
  for (const platform of ["xiaohongshu", "douyin", "kuaishou", "wechat-channels"]) {
    assert.ok(platforms.has(platform), `missing platform ${platform}`);
  }
});

test("catalogue rejects an unsupported action and a lying kind", () => {
  assert.throws(
    () =>
      catalog.normalizeScript("bad", {
        steps: [{ action: "teleport" }],
      }),
    /unsupported action/,
  );
  assert.throws(
    () =>
      catalog.normalizeScript("bad", {
        kind: "collect",
        steps: [{ action: "upload", inputSelector: "input[type=file]" }],
      }),
    /declares kind/,
  );
});

test("params render templates, derived flags and platform lengths", () => {
  assert.equal(params.renderTemplate("hi {{ name }}", { name: "x" }), "hi x");
  const script = {
    variables: [
      { key: "title", type: "text", default: "你好世界" },
      { key: "files", type: "files", default: [] },
    ],
    contextSetup: {
      load: { type: "number", default: 5 },
      shouldLoad: { type: "derived", source: "load", op: ">", value: 0 },
      empty: { type: "derived", source: "title", op: "==", value: "" },
    },
  };
  const context = params.buildContext(script, {});
  assert.equal(context.load, 5);
  assert.equal(context.shouldLoad, true);
  assert.equal(context.empty, false);
  assert.equal(params.xhsLength("hello"), 3);
  assert.equal(params.xhsLength("你好世界"), 4);
  assert.equal(params.truncateText("hello world", 3, "xhs"), "hello ");
  assert.equal(params.truncateText("abcdef", 3, "chars"), "abc");
});

test("content issues catch the limits the platform would reject", () => {
  const script = {
    variables: [
      {
        key: "title",
        type: "text",
        minChars: 6,
        forbidChars: ["#"],
        lengthUnit: "chars",
      },
      { key: "image", type: "files" },
    ],
  };
  const issues = params.contentIssues(script, { title: "a#b", image: [] });
  assert.equal(issues.length, 2);
  assert.match(issues.join("\n"), /至少需要 6 字/);
  assert.match(issues.join("\n"), /不支持的字符/);
  assert.deepEqual(params.contentIssues(script, { title: "完善的标题啊" }), []);
});

test("page scripts carry the conditions they were built from", () => {
  const assertScript = pageScripts.assertScript(
    [{ type: "text", value: "验证", errorCode: "RISK_CAPTCHA" }],
    [{ type: "visible", selector: ".btn" }],
  );
  assert.match(assertScript, /RISK_CAPTCHA/);
  assert.match(assertScript, /__qiworkEl/);
  const wait = pageScripts.waitStateScript("window.ready", 5000);
  assert.match(wait, /window\.ready/);
  assert.match(wait, /Date\.now\(\) \+ 5000/);
});

test("publish guard refuses the same content twice inside the window", () => {
  publishGuard.clear();
  const context = { title: "同一条", images: ["/tmp/a.png"] };
  const key = publishGuard.buildKey("xiaohongshu", publishGuard.digestContext(context));
  publishGuard.check(key, { windowMs: 60_000 });
  publishGuard.record(key);
  assert.throws(
    () => publishGuard.check(key, { windowMs: 60_000 }),
    (error) => error.code === "PUBLISH_ALREADY_ATTEMPTED",
  );
  // A different content is a different key.
  const other = publishGuard.buildKey(
    "xiaohongshu",
    publishGuard.digestContext({ ...context, title: "另一条" }),
  );
  publishGuard.check(other, { windowMs: 60_000 });
  publishGuard.clear();
});

function fakeDriver(overrides = {}) {
  const calls = [];
  const driver = {
    calls,
    async attach() {
      calls.push(["attach"]);
    },
    async open(url) {
      calls.push(["open", url]);
    },
    async navigate(url) {
      calls.push(["navigate", url]);
    },
    async reload() {
      calls.push(["reload"]);
    },
    async evaluate(expression) {
      calls.push(["evaluate", expression]);
      if (expression.includes("getBoundingClientRect")) {
        return {
          left: 0,
          top: 0,
          width: 10,
          height: 10,
          editable: false,
          tag: "BUTTON",
          disabled: false,
        };
      }
      if (expression.includes("element.click()")) return true;
      if (expression.includes("Boolean(")) return true;
      return true;
    },
    async currentUrl() {
      return "https://example.com";
    },
    async pageSnapshot() {
      return { url: "https://example.com", title: "t", body: "" };
    },
    async capture(target) {
      return target;
    },
    async install(source) {
      calls.push(["install", source.slice(0, 40)]);
    },
    async insertText() {},
    async pressKey() {},
    async clickAt() {},
    async resolveObject() {
      return "obj";
    },
    async setFiles() {},
    async setFilesOn() {},
    async setFilesOnObject() {},
    async resolveShadowElement() {
      return null;
    },
    async findAxNode() {
      return 0;
    },
    async nodeState() {
      return {};
    },
    async nodeBoxByBackend() {
      return null;
    },
    async shadowButtons() {
      return [];
    },
    async callOnNode() {
      return true;
    },
    async callOnBackendNode() {
      return true;
    },
    async callOnObject() {
      return true;
    },
    async clickNode() {},
    async clickBackendNode() {},
    async clickObject() {},
    async focusNode() {},
    async focusObject() {},
    async movePointer() {},
    ...overrides,
  };
  return driver;
}

test("executor runs steps in order and folds result values into context", async () => {
  const script = {
    id: "unit",
    name: "unit",
    platform: "test",
    kind: "collect",
    startUrl: "https://example.com",
    variables: [{ key: "word", type: "text", default: "hello" }],
    contextSetup: {},
    outputSchema: {},
    steps: [
      { action: "wait", duration: [0, 0] },
      {
        action: "execute",
        params: { fn: "async function (ctx) { return 'v-' + ctx.word; }", saveAs: "made" },
      },
      {
        action: "assertPageState",
        params: { failWhen: [], passWhen: [] },
      },
      {
        action: "click",
        whenState: "true",
        target: { selector: ".x" },
      },
    ],
  };
  const driver = fakeDriver();
  const artifactDir = path.join(dataDir, "run-unit");
  const result = await dsl.runScript({
    script,
    variables: { word: "hi" },
    driver,
    artifactDir,
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.context.word, "hi");
  assert.equal(result.context.execute_made, true);
  const kinds = driver.calls.map(([kind]) => kind);
  assert.equal(kinds[0], "open");
  assert.ok(kinds.includes("evaluate"));
  assert.ok(fs.existsSync(artifactDir));
});

test("executor fails fast on content the platform would reject", async () => {
  const script = {
    id: "unit-content",
    name: "unit",
    platform: "test",
    kind: "collect",
    startUrl: "https://example.com",
    variables: [{ key: "title", type: "text", minChars: 6 }],
    contextSetup: {},
    outputSchema: {},
    steps: [{ action: "wait", duration: [0, 0] }],
  };
  await assert.rejects(
    dsl.runScript({
      script,
      variables: { title: "短" },
      driver: fakeDriver(),
      artifactDir: path.join(dataDir, "run-content"),
      timeoutMs: 30_000,
    }),
    (error) => error.code === "AUTOMATION_CONTENT_INVALID",
  );
});

test("executor rejects a missing upload file before pressing anything", async () => {
  const script = {
    id: "unit-upload",
    name: "unit",
    platform: "test",
    kind: "collect",
    startUrl: "https://example.com",
    variables: [{ key: "images", type: "files", default: [] }],
    contextSetup: {},
    outputSchema: {},
    steps: [
      {
        action: "upload",
        inputSelector: "input[type=file]",
        value: "{{images}}",
        params: { verify: { maxFiles: 4 } },
      },
    ],
  };
  await assert.rejects(
    dsl.runScript({
      script,
      variables: { images: [path.join(dataDir, "missing.png")] },
      driver: fakeDriver(),
      artifactDir: path.join(dataDir, "run-upload"),
      timeoutMs: 30_000,
    }),
    (error) => error.code === "AUTOMATION_UPLOAD_INVALID",
  );
});

test("run records survive the process and report files and failures", async () => {
  const okRun = runs.submit(
    { automationId: "unit-ok", name: "ok", platform: "test", kind: "collect" },
    async () => ({ context: { value: 1 }, files: ["/tmp/a"] }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const okRecord = runs.get(okRun.runId);
  assert.equal(okRecord.status, "succeeded");
  assert.deepEqual(okRecord.result, { value: 1 });
  assert.deepEqual(okRecord.files, ["/tmp/a"]);
  assert.ok(fs.existsSync(path.join(okRecord.artifacts, "run.json")));

  const badRun = runs.submit(
    { automationId: "unit-bad", name: "bad", platform: "test", kind: "collect" },
    async () => {
      const error = new Error("nope");
      error.code = "AUTOMATION_TIMEOUT";
      throw error;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const badRecord = runs.get(badRun.runId);
  assert.equal(badRecord.status, "failed");
  assert.equal(badRecord.error.code, "AUTOMATION_TIMEOUT");
});

test("login QR result is written to disk and reduced for the caller", () => {
  const { finalizeRunResult } = require("../compiled/bridge/automation/xhs-login.js");
  const dir = path.join(dataDir, "qr-run");
  fs.mkdirSync(dir, { recursive: true });
  const png = Buffer.alloc(128, 7).toString("base64");
  const value = finalizeRunResult(
    "xiaohongshu-login-qrcode",
    {
      context: {
        execute_xhsLoginQrcode: {
          qrcode_data_url: `data:image/png;base64,${png}`,
        },
      },
      files: [],
    },
    dir,
  );
  const target = path.join(dir, "xhs_login_qrcode.png");
  assert.equal(value.context.logged_in, false);
  assert.equal(value.context.qrcode_png, target);
  assert.ok(value.files.includes(target));
  assert.equal(fs.statSync(target).size, 128);

  const loggedIn = finalizeRunResult(
    "xiaohongshu-login-qrcode",
    { context: { execute_xhsLoginProbe: { logged_in: true } }, files: [] },
    dir,
  );
  assert.equal(loggedIn.context.logged_in, true);
  assert.match(loggedIn.context.next, /可直接运行/);
});

test("runs in different sessions execute concurrently", async () => {
  runs.clearMemory();
  let started = 0;
  let bothStarted;
  const both = new Promise((resolve) => {
    bothStarted = resolve;
  });
  const task = async () => {
    started += 1;
    if (started === 2) bothStarted();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { context: { started } };
  };
  const first = runs.submit(
    { automationId: "a", name: "a", platform: "t", sessionId: "s1" },
    task,
  );
  const second = runs.submit(
    { automationId: "b", name: "b", platform: "t", sessionId: "s2" },
    task,
  );
  await both;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runs.get(first.runId).status, "succeeded");
  assert.equal(runs.get(second.runId).status, "succeeded");
});

test("a queued run can be cancelled before it starts", async () => {
  runs.clearMemory();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = runs.submit(
    { automationId: "block", name: "block", platform: "t", sessionId: "s1" },
    async () => {
      await gate;
      return { context: { ok: 1 } };
    },
  );
  let ran = false;
  const second = runs.submit(
    { automationId: "queued", name: "queued", platform: "t", sessionId: "s1" },
    async () => {
      ran = true;
      return { context: {} };
    },
  );
  const cancelled = runs.cancel(second.runId);
  assert.equal(cancelled.status, "cancelled");
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ran, false);
  assert.equal(runs.get(second.runId).status, "cancelled");
  assert.equal(runs.get(first.runId).status, "succeeded");
});

test("a running run stops at the next abort check", async () => {
  runs.clearMemory();
  let started;
  const startedP = new Promise((resolve) => {
    started = resolve;
  });
  const run = runs.submit(
    { automationId: "long", name: "long", platform: "t", sessionId: "s1" },
    async (_progress, meta) => {
      started();
      while (!meta.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const error = new Error("运行已取消");
      error.code = "ABORTED";
      throw error;
    },
  );
  await startedP;
  const requested = runs.cancel(run.runId);
  assert.equal(requested.status, "cancelling");
  await new Promise((resolve) => setTimeout(resolve, 60));
  const settled = runs.get(run.runId);
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.error.code, "ABORTED");
});

test("HTML to Markdown keeps structure, code and tables", () => {
  const { htmlToMarkdown } = require("../compiled/bridge/automation/artifacts.js");
  const markdown = htmlToMarkdown(`
    <h2>标题</h2>
    <p>一段 <strong>加粗</strong> 和 <a href="https://example.com/a">链接</a>。</p>
    <ul><li>一<ul><li>一.a</li></ul></li><li>二</li></ul>
    <blockquote>引用<br>第二行</blockquote>
    <pre class="language-js"><code>const x = 1;</code></pre>
    <table><thead><tr><th>A</th><th>B</th></tr></thead>
    <tbody><tr><td>1</td><td>2 | 3</td></tr></tbody></table>
  `);
  assert.match(markdown, /^## 标题/m);
  assert.match(markdown, /\*\*加粗\*\*/);
  assert.match(markdown, /\[链接\]\(https:\/\/example\.com\/a\)/);
  assert.match(markdown, /- 一\n  - 一\.a/);
  assert.match(markdown, /> 引用\n> 第二行/);
  assert.match(markdown, /```js\nconst x = 1;\n```/);
  assert.match(markdown, /\| A \| B \|/);
  assert.match(markdown, /\| 1 \| 2 \\\| 3 \|/);
});

test("tool surface lists the QiWork catalogue without executing anything", async () => {
  const { callTool } = require("../compiled/bridge/server.js");
  const listed = await callTool("list_automations", {}, null);
  assert.ok(listed.total >= 34);
  assert.equal(listed.contractVersion, "1.0");
  assert.ok(listed.kinds.publish >= 10);
  const prepared = await callTool(
    "prepare_automation",
    { id: "xiaohongshu-search", variables: { keyword: "咖啡" } },
    null,
  );
  assert.equal(prepared.dryRun, true);
  assert.equal(prepared.id, "xiaohongshu-search");
  assert.ok(Array.isArray(prepared.steps));
});
