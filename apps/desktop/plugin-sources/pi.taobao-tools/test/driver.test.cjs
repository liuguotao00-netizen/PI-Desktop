"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createDriver } = require("../compiled/bridge/automation/driver.js");

function fakeBrowser() {
  const calls = [];
  return {
    calls,
    async reveal() {
      calls.push(["reveal"]);
    },
    async navigate(input) {
      calls.push(["navigate", input.url]);
    },
    async evaluateNative({ expression }) {
      calls.push(["evaluate", expression.slice(0, 80)]);
      if (expression === "document.readyState") return "complete";
      if (expression === "location.href") return "https://example.com";
      return true;
    },
    async insertText() {
      calls.push(["insertText"]);
    },
    async cdp({ method, params }) {
      calls.push(["cdp", method, params]);
      if (method === "Runtime.evaluate") {
        if (String(params.expression).includes("__qiworkEl")) {
          return { result: { objectId: "obj-1" } };
        }
        return { result: { value: true } };
      }
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              role: { value: "button" },
              name: { value: "发布" },
              backendDOMNodeId: 42,
            },
          ],
        };
      }
      if (method === "Page.captureScreenshot") {
        return { data: Buffer.from("png-bytes").toString("base64") };
      }
      return {};
    },
    async input({ method }) {
      calls.push(["input", method]);
      return {};
    },
  };
}

test("driver opens, installs, and re-applies page scripts after navigation", async () => {
  const browser = fakeBrowser();
  const driver = createDriver({ browser, sessionId: "s1" });
  await driver.open("https://example.com");
  assert.equal(browser.calls[0][0], "reveal");
  assert.equal(browser.calls[1][0], "navigate");

  await driver.install("window.__marker = 1");
  const installs = () =>
    browser.calls.filter(
      ([kind, method]) =>
        kind === "cdp" && method === "Page.addScriptToEvaluateOnNewDocument",
    );
  assert.equal(installs().length, 1);

  await driver.navigate("https://example.com/next");
  assert.equal(installs().length, 2, "navigation re-applies installed scripts");
  assert.ok(
    browser.calls.some(
      ([kind, method]) => kind === "evaluate" && method === "window.__marker = 1",
    ),
  );
});

test("driver hands files to a shadow-DOM file input by object id", async () => {
  const browser = fakeBrowser();
  const driver = createDriver({ browser, sessionId: "s1" });
  await driver.open("https://example.com");
  await driver.setFiles('__qiworkEl({"selector":"input[type=file]"})', [
    "/tmp/a.png",
  ]);
  const call = browser.calls.find(
    ([kind, method]) => kind === "cdp" && method === "DOM.setFileInputFiles",
  );
  assert.ok(call, "DOM.setFileInputFiles was sent");
  assert.equal(call[2].objectId, "obj-1");
  assert.deepEqual(call[2].files, ["/tmp/a.png"]);
});

test("driver finds a closed-shadow control through the accessibility tree", async () => {
  const browser = fakeBrowser();
  const driver = createDriver({ browser, sessionId: "s1" });
  const backend = await driver.findAxNode("发布");
  assert.equal(backend, 42);
});

test("driver fetches remote bytes through the host net bridge", async () => {
  const browser = fakeBrowser();
  const net = {
    async fetch() {
      return {
        status: 200,
        headers: {},
        bodyText: "",
        bodyBase64: Buffer.from("image-bytes").toString("base64"),
        contentType: "image/png",
      };
    },
  };
  const driver = createDriver({ browser, net, sessionId: "s1" });
  const result = await driver.fetchBinary("https://cdn.example.com/a.png");
  assert.equal(result.bytes.toString(), "image-bytes");
  assert.equal(result.contentType, "image/png");
});

test("driver saves a failure screenshot into the run directory", async () => {
  const browser = fakeBrowser();
  const driver = createDriver({ browser, sessionId: "s1" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-taobao-driver-"));
  const target = path.join(dir, "failure.png");
  const saved = await driver.capture(target);
  assert.equal(saved, target);
  assert.equal(fs.readFileSync(target, "utf8"), "png-bytes");
  fs.rmSync(dir, { recursive: true, force: true });
});
