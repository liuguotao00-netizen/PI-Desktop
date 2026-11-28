"use strict";

/**
 * A very small Chrome DevTools Protocol client for the plugin's E2E suites.
 *
 * It exposes the same `pi.browser` facade the plugin consumes, so the real
 * engine (`driver.cjs`, `dsl.cjs`) runs unchanged against a real Chromium:
 * navigation, native evaluation, trusted input, DOM file inputs, closed shadow
 * roots and the accessibility tree all go through actual CDP.
 */

const { spawn } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

function chromeCandidates() {
  if (process.env.CHROME_PATH) return [process.env.CHROME_PATH];
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ];
  }
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

function findChrome() {
  return chromeCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

async function waitForDevtoolsUrl(child, timeoutMs = 20_000) {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Chrome did not announce a DevTools endpoint"));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffer);
      if (!match) return;
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      resolve(match[1]);
    };
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited before DevTools was ready (${code})`));
    });
  });
}

class CdpConnection {
  constructor(socket, browserEndpoint) {
    this.socket = socket;
    this.browserEndpoint = browserEndpoint;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch (error) {
        return;
      }
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(
          Object.assign(new Error(message.error.message), {
            code: message.error.code,
            data: message.error.data,
          }),
        );
      } else {
        entry.resolve(message.result ?? {});
      }
    });
    const fail = (error) => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.pending.clear();
    };
    socket.on("close", () => fail(new Error("CDP connection closed")));
    socket.on("error", (error) => fail(error));
  }

  send(method, params = {}) {
    if (this.closed) {
      return Promise.reject(new Error("CDP connection closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    this.closed = true;
    try {
      this.socket.close();
    } catch (error) {
      // Already closed.
    }
  }
}

async function connectToPage(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return new CdpConnection(socket, webSocketDebuggerUrl);
}

class PageBrowser {
  constructor(connection) {
    this.connection = connection;
  }

  async reveal() {}

  async navigate(input) {
    const url = String(input.url ?? input.path ?? "about:blank");
    await this.connection.send("Page.navigate", { url });
    await this.waitReady();
    return { url };
  }

  async waitReady(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluateNative({
          expression: "document.readyState",
        });
        if (state === "complete") return;
      } catch (error) {
        // The previous document is being replaced.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async evaluateNative({ expression }) {
    const output = await this.connection.send("Runtime.evaluate", {
      expression: String(expression ?? ""),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (output.exceptionDetails) {
      const remote = output.exceptionDetails.exception || {};
      throw new Error(
        String(
          remote.description ||
            output.exceptionDetails.text ||
            "page script failed",
        ),
      );
    }
    return output.result ? output.result.value : undefined;
  }

  async evaluate({ expression }) {
    return this.evaluateNative({ expression });
  }

  async cdpCommand(input) {
    return this.connection.send(String(input.method), input.params || {});
  }

  async cdp(input) {
    return this.cdpCommand(input);
  }

  async input(input) {
    return this.connection.send(String(input.method), input.params || {});
  }

  async insertText({ text }) {
    return this.connection.send("Input.insertText", { text: String(text ?? "") });
  }

  async screenshot() {
    return this.connection.send("Page.captureScreenshot", { format: "png" });
  }

  async close() {
    this.connection.close();
  }
}

async function launchChrome() {
  const executable = findChrome();
  if (!executable) {
    throw Object.assign(new Error("Chrome/Chromium not found"), {
      code: "CHROME_NOT_FOUND",
    });
  }
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "pi-taobao-e2e-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr.setEncoding("utf8");
  const browserEndpoint = await waitForDevtoolsUrl(child);
  const parsed = new URL(browserEndpoint);
  const port = parsed.port;
  let targets;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await response.json();
      if (Array.isArray(targets) && targets.some((item) => item.type === "page")) {
        break;
      }
    } catch (error) {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const page = (targets || []).find(
    (item) => item.type === "page" && item.webSocketDebuggerUrl,
  );
  if (!page) {
    child.kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
    throw new Error("Chrome exposed no page target");
  }
  const cdp = await connectToPage(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Runtime.enable");
  return {
    browser: new PageBrowser(cdp),
    cdp,
    executable,
    async close() {
      cdp.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (!child.killed) child.kill("SIGKILL");
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

module.exports = {
  PageBrowser,
  chromeCandidates,
  connectToPage,
  findChrome,
  launchChrome,
};
