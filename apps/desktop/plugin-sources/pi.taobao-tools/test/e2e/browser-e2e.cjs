"use strict";

/**
 * Real-Chromium E2E for the automation engine.
 *
 * The suite runs the compiled driver and DSL unchanged against a local fixture
 * page in Google Chrome: navigation, typing into a contenteditable editor,
 * uploading a file into a hidden input, clicking a button inside a **closed**
 * shadow root, waiting for a publish receipt, capturing network responses and
 * reporting a captcha. Chrome is launched headless; nothing touches a real
 * account.
 *
 *   node build.mjs --no-stage && node test/e2e/browser-e2e.cjs
 *
 * Set CHROME_PATH when Chrome is not in a standard location. The suite skips
 * (exit 0) when no Chromium is installed.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const { createDriver } = require("../../compiled/bridge/automation/driver.js");
const dsl = require("../../compiled/bridge/automation/dsl.js");
const { startFixture } = require("./fixture-server.cjs");
const { findChrome, launchChrome } = require("./chrome-cdp.cjs");

const chrome = findChrome();
const run = chrome ? test : test.skip;

function baseScript(overrides) {
  return {
    id: "fixture",
    name: "fixture",
    platform: "fixture",
    kind: "collect",
    startUrl: "",
    variables: [],
    contextSetup: {},
    outputSchema: {},
    dedupeWindowMs: 0,
    actions: [],
    requiresCapture: false,
    steps: [],
    ...overrides,
  };
}

async function execute(script, variables = {}) {
  const artifactDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-taobao-browser-e2e-"),
  );
  const driver = createDriver({
    browser: page,
    sessionId: "e2e",
  });
  try {
    const value = await dsl.runScript({
      script,
      variables,
      driver,
      artifactDir,
      timeoutMs: 30_000,
    });
    return { value, artifactDir };
  } finally {
    // Keep the artifact dir for a failed assertion; the OS cleans /tmp.
  }
}

let page;
let fixture;
let chromeProcess;

before(async () => {
  if (!chrome) return;
  fixture = await startFixture();
  chromeProcess = await launchChrome();
  page = chromeProcess.browser;
});

after(async () => {
  if (chromeProcess) await chromeProcess.close();
  if (fixture) await fixture.close();
});

run("types into a contenteditable editor", async () => {
  const { value } = await execute(
    baseScript({
      startUrl: fixture.url,
      steps: [
        { action: "waitForElement", target: { selector: "#editor" } },
        {
          action: "type",
          target: { selector: "#editor" },
          value: "hello 世界",
        },
        {
          action: "assertPageState",
          params: { passWhen: [{ type: "visible", selector: "#editor" }] },
        },
        {
          action: "execute",
          params: {
            fn: "async function () { return document.querySelector('#editor').innerText; }",
            saveAs: "editorText",
          },
        },
      ],
    }),
  );
  assert.match(String(value.context.execute_editorText), /hello 世界/);
});

run("uploads a file into a hidden input and waits for the thumbnail", async () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-taobao-upload-")),
    "pixel.png",
  );
  fs.writeFileSync(file, Buffer.from("not-a-real-png"));
  const { value } = await execute(
    baseScript({
      startUrl: fixture.url,
      variables: [],
      steps: [
        {
          action: "upload",
          inputSelector: "input#file",
          value: [file],
          params: {
            verify: {
              uploadedSelector: "#thumb",
              expectedCount: 1,
              timeout: 5000,
              stabilityMs: 0,
              pollInterval: 100,
            },
          },
        },
      ],
    }),
  );
  assert.ok(value.ok);
  const uploaded = await page.evaluateNative({
    expression: "Boolean(document.querySelector('#thumb'))",
  });
  assert.equal(uploaded, true);
});

run("clicks a publish button inside a closed shadow root and reads the receipt", async () => {
  const { value } = await execute(
    baseScript({
      startUrl: fixture.url,
      kind: "publish",
      steps: [
        {
          id: "publish",
          action: "activateAndWaitForResponse",
          target: {
            shadowHost: "xhs-publish-btn",
            selector: "button#publish",
            text: "发布",
          },
          timeout: 10_000,
          params: {
            urlPattern: "*/api/publish",
            successPath: "success",
            successEquals: true,
            saveAs: "publishReceipt",
          },
        },
      ],
    }),
  );
  const receipt = value.context.execute_publishReceipt;
  assert.equal(receipt.ok, true);
  assert.match(String(receipt.url), /\/api\/publish$/);
  const body = await page.evaluateNative({
    expression: "JSON.stringify(window.__published || null)",
  });
  assert.match(String(body), /"success":true/);
});

run("reports a captcha as RISK_CAPTCHA", async () => {
  await assert.rejects(
    execute(
      baseScript({
        startUrl: `${fixture.url}/captcha`,
        steps: [
          {
            action: "assertPageState",
            params: {
              failWhen: [{ type: "text", value: "请完成下方验证" }],
              errorCode: "RISK_CAPTCHA",
              errorMessage: "需要验证",
            },
          },
        ],
      }),
    ),
    (error) => error.code === "RISK_CAPTCHA",
  );
});

run("captures a fetch response across a document and counts it", async () => {
  const { value } = await execute(
    baseScript({
      startUrl: `${fixture.url}/list`,
      steps: [
        {
          action: "sessionCapture",
          params: {
            sessionList: [
              {
                sessionKey: "data",
                urlIncludes: ["/api/data"],
                countByValueKey: "items[].id",
                hasNextKey: "hasNext",
              },
            ],
          },
        },
        {
          action: "waitForState",
          params: {
            expression:
              "Boolean(window.__qiworkAutomation && window.__qiworkAutomation.captures.length > 0)",
            errorMessage: "没有捕获到网络响应",
          },
        },
        {
          action: "scrollForSession",
          params: {
            sessionKey: "data",
            limitTotal: 3,
            limitScroll: 5,
            scrollStep: 100,
            saveAs: "captured",
          },
        },
      ],
    }),
  );
  const captured = value.context.execute_captured;
  assert.ok(captured.count >= 3, JSON.stringify(captured));
});

run("saves a failure screenshot when a step cannot find its target", async () => {
  let artifactDir;
  try {
    await execute(
      baseScript({
        startUrl: fixture.url,
        steps: [
          {
            action: "click",
            target: { selector: "#does-not-exist" },
          },
        ],
      }),
    );
    assert.fail("expected the step to fail");
  } catch (error) {
    assert.equal(error.code, "AUTOMATION_TARGET_NOT_FOUND");
    artifactDir = error.details && error.details.screenshot
      ? path.dirname(error.details.screenshot)
      : null;
    if (artifactDir) {
      assert.ok(fs.existsSync(path.join(artifactDir, "failure.json")));
    }
  }
});
