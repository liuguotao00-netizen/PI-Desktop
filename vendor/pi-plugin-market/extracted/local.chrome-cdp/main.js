/**
 * Chrome CDP — a real Google Chrome window driven over the DevTools protocol.
 *
 * The plugin process spawns Chrome with `--remote-debugging-port`, connects to
 * the browser target over a WebSocket and registers one agent tool ("Chrome")
 * that can launch the browser, navigate, read the accessibility tree, click,
 * fill, evaluate JavaScript, capture screenshots and read console output.
 *
 * Everything is plain Node: `node:net` speaks RFC 6455 for the DevTools socket,
 * `node:child_process` starts Chrome. No third-party dependencies, no network
 * egress except 127.0.0.1. The browser window is a normal Chrome window the
 * user can watch and use by hand while the agent works.
 */

"use strict";

const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/* ------------------------------------------------------------------ consts */

const DEFAULT_PORT = 9333;
const CONNECT_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 60000;
const LAUNCH_WAIT_MS = 30000;
const NAVIGATE_TIMEOUT_MS = 45000;
const CONSOLE_BUFFER_LIMIT = 200;
const SNAPSHOT_MAX_LINES = 600;
const SNAPSHOT_MAX_CHARS = 30000;

const ACTIONS = [
  "launch",
  "status",
  "tabs",
  "select",
  "navigate",
  "snapshot",
  "screenshot",
  "click",
  "fill",
  "evaluate",
  "console",
  "cdp",
  "close",
];

// Read-only actions that stay available in Plan and Goal modes.
const PLAN_SAFE_ACTIONS = ["status", "tabs", "snapshot", "screenshot", "console"];

// Raw CDP methods that would take the browser down or out of the plugin.
const DENIED_CDP = new Set(["Browser.close", "Browser.crash"]);

// Accessibility roles that add noise to a snapshot without being actionable.
const HIDDEN_ROLES = new Set([
  "none",
  "generic",
  "InlineTextBox",
  "StaticText",
  "lineBreak",
  "separator",
  "Ignored",
]);

const AX_FLAGS = [
  "focused",
  "disabled",
  "checked",
  "pressed",
  "selected",
  "expanded",
  "required",
  "readonly",
  "invalid",
  "level",
];

const TOOL_DESCRIPTION = [
  "Drive a real Google Chrome window over the Chrome DevTools Protocol (CDP).",
  'Call ToolSearch for "chrome", "cdp" or "browser automation" to load this tool.',
  "Action launch starts Chrome (visible window) and connects; every other action uses that window,",
  "including when the user works in another app. Then snapshot the accessibility tree, click/fill by uid (e1, e2, …),",
  "take screenshots, evaluate JavaScript, read console output, manage tabs, or send a raw CDP method.",
  "Navigate first after launch; re-snapshot after a page change because uids expire.",
  "This is a real browser with cookies, localStorage and network access: treat it as the user's machine.",
].join(" ");

/* ------------------------------------------------------------- WebSocket */

/** Minimal RFC 6455 client (text frames, ping/pong, fragmentation). */
class WebSocketClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.handshakeDone = false;
    this.closed = false;
    this.onMessage = () => {};
    this.onClose = () => {};
  }

  connect(timeoutMs = CONNECT_TIMEOUT_MS) {
    let target;
    try {
      target = new URL(this.url);
    } catch {
      return Promise.reject(new Error(`invalid websocket url: ${this.url}`));
    }
    if (target.protocol !== "ws:") {
      return Promise.reject(new Error(`only ws:// is supported, got ${target.protocol}`));
    }
    const host = target.hostname;
    const port = Number(target.port || 80);
    const requestPath = `${target.pathname}${target.search}`;

    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      let settled = false;
      let handshake = Buffer.alloc(0);
      const socket = net.createConnection({ host, port });
      this.socket = socket;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("websocket connect timeout")), timeoutMs);

      socket.on("connect", () => {
        socket.write(
          `GET ${requestPath} HTTP/1.1\r\n` +
            `Host: ${host}:${port}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n"
        );
      });

      socket.on("data", (chunk) => {
        if (!this.handshakeDone) {
          handshake = Buffer.concat([handshake, chunk]);
          const index = handshake.indexOf("\r\n\r\n");
          if (index === -1) return;
          const head = handshake.slice(0, index).toString("utf8");
          const status = /HTTP\/1\.[01]\s+(\d+)/.exec(head);
          if (!status || status[1] !== "101") {
            fail(new Error(`websocket handshake failed: ${head.split("\r\n")[0]}`));
            return;
          }
          this.handshakeDone = true;
          this.buffer = handshake.slice(index + 4);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(this);
          }
          if (this.buffer.length) this._onData(Buffer.alloc(0));
          return;
        }
        this._onData(chunk);
      });

      socket.on("error", (error) => {
        if (!settled) fail(error);
        else this._shutdown();
      });
      socket.on("close", () => {
        if (!settled) fail(new Error("websocket closed during handshake"));
        else this._shutdown();
      });
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      let payload = Buffer.from(this.buffer.slice(offset, offset + length));
      this.buffer = this.buffer.slice(offset + length);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index & 3];
        }
      }

      if (opcode === 0x8) {
        this._shutdown();
        return;
      }
      if (opcode === 0x9) {
        this._sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;

      this.fragments.push(payload);
      if (final) {
        const message = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        try {
          this.onMessage(message);
        } catch {
          /* listeners are best effort */
        }
      }
    }
  }

  _sendFrame(opcode, payload) {
    if (!this.socket || this.closed) throw new Error("websocket is closed");
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index += 1) {
      masked[index] ^= mask[index & 3];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    this._sendFrame(0x1, Buffer.from(String(text), "utf8"));
  }

  _shutdown() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.destroy();
    } catch {
      /* already gone */
    }
    try {
      this.onClose();
    } catch {
      /* listeners are best effort */
    }
  }

  close() {
    if (this.closed) return;
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
    } catch {
      /* socket already gone */
    }
    this._shutdown();
  }
}

/* ------------------------------------------------------------ CDP client */

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.onMessage = (text) => this._dispatch(text);
    ws.onClose = () => this._handleClose();
  }

  _dispatch(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(
          new Error(`${message.error.message || "CDP error"} (code ${message.error.code ?? "?"})`)
        );
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    if (!message.method) return;
    const key = `${message.method}::${message.sessionId || ""}`;
    for (const listeners of [this.listeners.get(key), this.listeners.get(`${message.method}::*`)]) {
      if (!listeners) continue;
      for (const handler of [...listeners]) {
        try {
          handler(message.params || {}, message);
        } catch {
          /* listeners are best effort */
        }
      }
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("CDP connection is closed"));
    const id = this.nextId++;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after ${COMMAND_TIMEOUT_MS}ms: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, sessionId, handler) {
    const key = `${method}::${sessionId || ""}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(handler);
    return () => this.listeners.get(key)?.delete(handler);
  }

  _handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(new Error("CDP connection is closed"));
    this.pending.clear();
    this.listeners.clear();
    if (session.client === this) {
      session.client = null;
      session.pageSessionId = undefined;
      session.pageTargetId = null;
      session.sessionsByTarget.clear();
    }
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
    this._handleClose();
  }
}

/* ---------------------------------------------------------- browser state */

const session = {
  client: null,
  pageSessionId: undefined,
  pageTargetId: null,
  sessionsByTarget: new Map(),
  child: null,
  owned: false,
  port: null,
  consoleBuffer: [],
  uids: new Map(),
  uidSeq: 0,
  launchPending: false,
};

/* ------------------------------------------------------------------ utils */

async function getSettings() {
  try {
    const settings = await pi.plugin?.getSettings?.();
    if (settings && typeof settings === "object") return settings;
  } catch {
    /* settings are optional */
  }
  return {};
}

function log(message, extra) {
  try {
    console.log(`[chrome-cdp] ${extra ? `${message} ${JSON.stringify(extra)}` : message}`);
  } catch {
    /* console is best effort */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse({ port, method = "GET", urlPath, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, timeout: timeoutMs },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode && response.statusCode >= 400) {
            reject(new Error(`HTTP ${response.statusCode} for ${urlPath}`));
            return;
          }
          try {
            resolve(JSON.parse(body || "null"));
          } catch {
            reject(new Error(`invalid JSON from ${urlPath}`));
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error(`timeout for ${urlPath}`)));
    request.on("error", reject);
    request.end();
  });
}

/** Chrome binaries to try when the setting is empty. */
function chromeCandidates() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(home, "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
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

function resolveChromeBinary(settings) {
  const configured = String(settings.chromePath || "").trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`chromePath must be an absolute path, got "${configured}"`);
    }
    try {
      if (fs.statSync(configured).isFile()) return configured;
    } catch {
      /* fall through to the error below */
    }
    throw new Error(`chromePath does not exist: ${configured}`);
  }
  for (const candidate of chromeCandidates()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    "Google Chrome was not found. Install Chrome or set chromePath in the plugin settings " +
      "(Settings -> Plugins -> Chrome CDP)."
  );
}

function defaultUserDataDir() {
  return path.join(os.homedir(), ".pi-desktop", "chrome-cdp-profile");
}

function normalizeUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (/^javascript:/i.test(value)) {
    throw new Error("javascript: URLs are not allowed");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `https://${value}`;
}

/* ------------------------------------------------------- browser plumbing */

async function probe(port) {
  try {
    return await jsonResponse({ port, urlPath: "/json/version" });
  } catch {
    return null;
  }
}

async function connectTo(version, port) {
  const wsUrl = version?.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error(
      `Chrome on port ${port} did not expose a browser websocket (webSocketDebuggerUrl missing). ` +
        "Use Chrome 63+ and make sure no other tool owns the debug port."
    );
  }
  const ws = new WebSocketClient(wsUrl);
  await ws.connect();
  const client = new CdpClient(ws);
  session.client = client;
  session.port = port;
  session.consoleBuffer = [];
  return client;
}

async function attachPage(client) {
  const { targetInfos = [] } = await client.send("Target.getTargets");
  const pages = targetInfos.filter((target) => target.type === "page");
  const target =
    pages.find((page) => page.url && !/^about:|chrome:\/\/|devtools:/.test(page.url)) || pages[0];
  let targetId = target?.targetId;
  if (!targetId) {
    const created = await client.send("Target.createTarget", { url: "about:blank" });
    targetId = created.targetId;
  }
  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  session.pageTargetId = targetId;
  session.pageSessionId = sessionId;
  session.sessionsByTarget.set(targetId, sessionId);

  client.on("Runtime.consoleAPICalled", sessionId, (params) => {
    pushConsole(
      params.type || "log",
      (params.args || [])
        .map((arg) => arg.value ?? arg.unserializableValue ?? arg.description ?? "")
        .join(" "),
      params.timestamp
    );
  });
  client.on("Runtime.exceptionThrown", sessionId, (params) => {
    const details = params.exceptionDetails || {};
    const text =
      details.exception?.description || details.text || "uncaught exception";
    pushConsole("error", String(text), details.timestamp);
  });
  client.on("Log.entryAdded", sessionId, (params) => {
    const entry = params.entry || {};
    pushConsole(entry.level || "info", String(entry.text || ""), entry.timestamp);
  });

  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await client.send("DOM.enable", {}, sessionId);
  await client.send("Log.enable", {}, sessionId);
  return sessionId;
}

function pushConsole(type, text, timestamp) {
  if (!text) return;
  session.consoleBuffer.push({
    type: String(type),
    text: String(text).slice(0, 2000),
    at: timestamp ? Number(timestamp) : Date.now(),
  });
  if (session.consoleBuffer.length > CONSOLE_BUFFER_LIMIT) {
    session.consoleBuffer.splice(0, session.consoleBuffer.length - CONSOLE_BUFFER_LIMIT);
  }
}

async function launchBrowser(settings, url) {
  if (session.client && !session.client.closed) {
    return { alreadyRunning: true };
  }
  if (session.launchPending) throw new Error("Chrome is already starting, retry in a moment");
  session.launchPending = true;
  try {
    const attachUrl = String(settings.attachUrl || "").trim();
    let port;
    let version;
    if (attachUrl) {
      const parsed = new URL(attachUrl);
      port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
      version = await probe(port);
      if (!version) {
        throw new Error(
          `nothing answers at ${attachUrl}. Start Chrome with --remote-debugging-port=${port} or clear attachUrl.`
        );
      }
    } else {
      port = Number(settings.port) || DEFAULT_PORT;
      version = await probe(port);
      if (!version) {
        const binary = resolveChromeBinary(settings);
        const userDataDir = String(settings.userDataDir || "").trim() || defaultUserDataDir();
        const startUrl = normalizeUrl(url) || DEFAULT_START_URL;
        const args = [
          `--remote-debugging-port=${port}`,
          "--remote-allow-origins=*",
          `--user-data-dir=${userDataDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-default-apps",
        ];
        if (settings.headless === true) {
          args.push("--headless=new", "--disable-gpu");
        }
        const extra = String(settings.chromeArgs || "")
          .split(/\s+/)
          .map((value) => value.trim())
          .filter(Boolean);
        args.push(...extra, startUrl);

        log("starting Chrome", { binary, port, userDataDir, headless: settings.headless === true });
        const child = spawn(binary, args, { stdio: "ignore" });
        session.child = child;
        session.owned = true;
        child.on("exit", () => {
          if (session.child === child) {
            session.child = null;
            session.owned = false;
          }
        });

        const deadline = Date.now() + LAUNCH_WAIT_MS;
        while (Date.now() < deadline) {
          version = await probe(port);
          if (version) break;
          if (child.exitCode !== null) break;
          await sleep(300);
        }
        if (!version) {
          throw new Error(
            `Chrome started but the DevTools endpoint on 127.0.0.1:${port} never answered. ` +
              "Another Chrome instance may be holding the profile directory."
          );
        }
      }
    }

    const client = await connectTo(version, port);
    await attachPage(client);
    const target = normalizeUrl(url);
    if (target) await navigate(target);
    return { alreadyRunning: false, port };
  } finally {
    session.launchPending = false;
  }
}

function pageSend(method, params) {
  if (!session.client || session.client.closed) {
    throw new Error("Chrome is not connected. Call the tool with action=launch first.");
  }
  return session.client.send(method, params, session.pageSessionId);
}

async function pageInfo() {
  const result = await pageSend("Runtime.evaluate", {
    expression:
      "(() => ({ url: location.href, title: document.title, readyState: document.readyState }))()",
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value || {};
}

async function navigate(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error("navigate needs a url");
  await pageSend("Page.enable");
  const result = await pageSend("Page.navigate", { url });
  if (result.errorText) {
    throw new Error(`navigation failed: ${result.errorText} (${url})`);
  }
  const deadline = Date.now() + NAVIGATE_TIMEOUT_MS;
  for (;;) {
    try {
      const state = await pageSend("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (state?.result?.value === "complete") break;
    } catch {
      /* page may still be committing */
    }
    if (Date.now() > deadline) break;
    await sleep(250);
  }
  return { url, ...(await pageInfo()) };
}

/* ------------------------------------------------------------- snapshot */

function axName(node) {
  for (const key of ["name", "value", "description"]) {
    const entry = node?.[key];
    const value = entry && typeof entry === "object" ? entry.value : entry;
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function axFlags(node) {
  const flags = [];
  const OFF = [false, "false", "undefined", "none", "", 0];
  for (const property of node.properties || []) {
    if (!AX_FLAGS.includes(property.name)) continue;
    const value = property.value?.value;
    if (value === undefined || value === null || OFF.includes(value)) continue;
    flags.push(property.name === "level" ? `level=${value}` : property.name);
  }
  return flags;
}

async function buildSnapshot() {
  await pageSend("Accessibility.enable");
  const { nodes = [] } = await pageSend("Accessibility.getFullAXTree");
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const parentIds = new Set();
  for (const node of nodes) {
    for (const childId of node.childIds || []) parentIds.add(childId);
  }
  const roots = nodes.filter((node) => !parentIds.has(node.nodeId));

  session.uids = new Map();
  session.uidSeq = 0;
  const lines = [];

  const walk = (node, depth) => {
    if (!node || lines.length >= SNAPSHOT_MAX_LINES) return;
    const role = String(node.role?.value || "");
    const hidden = node.ignored || HIDDEN_ROLES.has(role) || (!role && !axName(node));
    if (!hidden) {
      const name = axName(node);
      const flags = axFlags(node);
      let uid = "";
      if (node.backendDOMNodeId && !["StaticText", "text"].includes(role)) {
        session.uidSeq += 1;
        uid = `e${session.uidSeq}`;
        session.uids.set(uid, node.backendDOMNodeId);
      }
      const label = [uid || "-", role || "node", name ? JSON.stringify(name) : "", flags.length ? `[${flags.join(",")}]` : ""]
        .filter(Boolean)
        .join(" ");
      lines.push(`${"  ".repeat(Math.min(depth, 12))}${label}`);
    }
    for (const childId of node.childIds || []) {
      walk(byId.get(childId), hidden ? depth : depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);

  const text = lines.slice(0, SNAPSHOT_MAX_LINES).join("\n");
  return {
    text: text.length > SNAPSHOT_MAX_CHARS ? `${text.slice(0, SNAPSHOT_MAX_CHARS)}\n… (truncated)` : text,
    elements: session.uids.size,
  };
}

function resolveUid(uid) {
  const key = String(uid || "").trim();
  const backendNodeId = session.uids.get(key);
  if (!backendNodeId) {
    throw new Error(`unknown uid "${key}". Take a fresh snapshot first (uids change after page updates).`);
  }
  return backendNodeId;
}

/** backendDOMNodeId -> Runtime objectId for callFunctionOn. */
async function resolveObjectId(backendNodeId) {
  const resolved = await pageSend("DOM.resolveNode", { backendNodeId });
  const objectId = resolved?.object?.objectId || resolved?.objectId;
  if (!objectId) throw new Error(`could not resolve element ${backendNodeId} to a JS object`);
  return objectId;
}

async function clickUid(uid) {
  const backendNodeId = resolveUid(uid);
  try {
    await pageSend("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const { model } = await pageSend("DOM.getBoxModel", { backendNodeId });
    const quad = model?.content || [];
    if (quad.length !== 8) throw new Error("no box model");
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    await pageSend("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await pageSend("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await pageSend("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return { uid, x: Math.round(x), y: Math.round(y), via: "input" };
  } catch {
    // Fallback for elements without a layout box (e.g. display: contents).
    const objectId = await resolveObjectId(backendNodeId);
    await pageSend("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: "function () { this.click(); return true; }",
    });
    return { uid, via: "script" };
  }
}

async function fillUid(uid, text) {
  const backendNodeId = resolveUid(uid);
  const objectId = await resolveObjectId(backendNodeId);
  const result = await pageSend("Runtime.callFunctionOn", {
    objectId,
    arguments: [{ value: String(text ?? "") }],
    returnByValue: true,
    awaitPromise: true,
    functionDeclaration: `function (text) {
      const element = this;
      element.focus({ preventScroll: true });
      if (element.isContentEditable) {
        element.textContent = String(text);
      } else {
        const proto = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : element instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (descriptor && descriptor.set) descriptor.set.call(element, String(text));
        else element.value = String(text);
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }`,
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "fill failed");
  }
  return { uid, filled: String(text ?? "").length };
}

async function captureScreenshot({ fullPage = false, format = "jpeg", quality = 70 } = {}) {
  await pageSend("Page.enable");
  const params = { format: format === "png" ? "png" : "jpeg" };
  if (params.format === "jpeg") params.quality = Math.max(1, Math.min(100, Number(quality) || 70));
  if (fullPage) {
    const metrics = await pageSend("Page.getLayoutMetrics");
    const size = metrics.cssContentSize || metrics.contentSize || {};
    const width = Math.ceil(Number(size.width) || 0);
    const height = Math.ceil(Number(size.height) || 0);
    if (width > 0 && height > 0) {
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
      params.captureBeyondViewport = true;
    }
  }
  const { data } = await pageSend("Page.captureScreenshot", params);
  const mimeType = params.format === "png" ? "image/png" : "image/jpeg";
  let savedPath = "";
  try {
    const dir = path.join(os.tmpdir(), "pi-chrome-cdp");
    fs.mkdirSync(dir, { recursive: true });
    savedPath = path.join(dir, `shot-${Date.now()}.${params.format === "png" ? "png" : "jpg"}`);
    fs.writeFileSync(savedPath, Buffer.from(data, "base64"));
  } catch {
    /* saving is best effort; the image still travels in the tool result */
  }
  return { mimeType, data, path: savedPath };
}

async function evaluate(expression) {
  const source = String(expression || "").trim();
  if (!source) throw new Error("evaluate needs an expression");
  const result = await pageSend("Runtime.evaluate", {
    expression: source,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    return {
      ok: false,
      error: details.exception?.description || details.text || "evaluation failed",
    };
  }
  return { ok: true, result: result?.result?.value ?? null };
}

async function listTabs() {
  const { targetInfos = [] } = await session.client.send("Target.getTargets");
  return targetInfos
    .filter((target) => target.type === "page")
    .map((target) => ({
      targetId: target.targetId,
      title: target.title,
      url: target.url,
      active: target.targetId === session.pageTargetId,
    }));
}

async function selectTab({ targetId, index }) {
  const tabs = await listTabs();
  const wanted = targetId
    ? tabs.find((tab) => tab.targetId === String(targetId))
    : tabs[Number(index) || 0];
  if (!wanted) throw new Error(`no such tab (${targetId ?? index}); call action=tabs first`);
  let sessionId = session.sessionsByTarget.get(wanted.targetId);
  if (!sessionId) {
    const attached = await session.client.send("Target.attachToTarget", {
      targetId: wanted.targetId,
      flatten: true,
    });
    sessionId = attached.sessionId;
    session.sessionsByTarget.set(wanted.targetId, sessionId);
    await session.client.send("Page.enable", {}, sessionId);
    await session.client.send("Runtime.enable", {}, sessionId);
  }
  session.pageTargetId = wanted.targetId;
  session.pageSessionId = sessionId;
  session.uids = new Map();
  return { selected: wanted };
}

async function closeTab(targetId) {
  const id = String(targetId || session.pageTargetId || "");
  if (!id) throw new Error("nothing to close");
  await session.client.send("Target.closeTarget", { targetId: id });
  session.sessionsByTarget.delete(id);
  if (id === session.pageTargetId) {
    session.pageTargetId = null;
    session.pageSessionId = undefined;
    session.uids = new Map();
  }
  return { closed: id };
}

function disconnect() {
  if (session.client) {
    try {
      session.client.close();
    } catch {
      /* already gone */
    }
  }
  session.client = null;
  session.pageSessionId = undefined;
  session.pageTargetId = null;
  session.sessionsByTarget.clear();
  session.uids = new Map();
}

async function shutdownBrowser({ closeWindow }) {
  const owned = session.owned;
  const child = session.child;
  if (closeWindow && session.client && !session.client.closed) {
    if (owned) {
      // We started it with a private profile: shut the whole browser down.
    } else {
      try {
        if (session.pageTargetId) {
          await session.client.send("Target.closeTarget", { targetId: session.pageTargetId });
        }
      } catch {
        /* the tab may already be gone */
      }
    }
  }
  disconnect();
  if (owned && child) {
    session.child = null;
    session.owned = false;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    // Chrome lingers on a busy profile; escalate once after a grace period.
    setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 3000).unref?.();
  }
  return { closed: true, owned };
}

/* ------------------------------------------------------------- tool body */

async function runAction(action, args, settings) {
  switch (action) {
    case "launch": {
      const outcome = await launchBrowser(settings, args?.url);
      return {
        ok: true,
        action,
        text: outcome.alreadyRunning
          ? "Chrome is already running and connected."
          : `Chrome is running on 127.0.0.1:${outcome.port}.`,
        ...(await statusPayload()),
      };
    }
    case "status":
      return { ok: true, action, ...(await statusPayload()) };
    case "tabs":
      requireClient();
      return { ok: true, action, tabs: await listTabs() };
    case "select":
      requireClient();
      return {
        ok: true,
        action,
        ...(await selectTab({ targetId: args?.targetId, index: args?.index })),
      };
    case "navigate": {
      requireClient();
      const state = await navigate(args?.url);
      return { ok: true, action, state };
    }
    case "snapshot": {
      requireClient();
      return { ok: true, action, ...(await buildSnapshot()) };
    }
    case "screenshot": {
      requireClient();
      const shot = await captureScreenshot({
        fullPage: args?.fullPage === true,
        format: typeof args?.format === "string" ? args.format : undefined,
        quality: typeof args?.quality === "number" ? args.quality : undefined,
      });
      return {
        ok: true,
        action,
        text: shot.path
          ? `Captured screenshot (${shot.mimeType}) saved at ${shot.path}.`
          : `Captured screenshot (${shot.mimeType}).`,
        path: shot.path,
        mimeType: shot.mimeType,
        images: [{ mimeType: shot.mimeType, data: shot.data }],
      };
    }
    case "click":
      requireClient();
      return { ok: true, action, ...(await clickUid(args?.uid)) };
    case "fill":
      requireClient();
      return { ok: true, action, ...(await fillUid(args?.uid, args?.text)) };
    case "evaluate":
      requireClient();
      return { ok: true, action, ...(await evaluate(args?.expression)) };
    case "console": {
      requireClient();
      const limit = typeof args?.limit === "number" ? Math.max(1, args.limit) : 50;
      return {
        ok: true,
        action,
        messages: session.consoleBuffer.slice(-limit),
        total: session.consoleBuffer.length,
      };
    }
    case "cdp": {
      requireClient();
      const method = String(args?.method || "").trim();
      if (!method) throw new Error("cdp needs a method name");
      if (DENIED_CDP.has(method)) throw new Error(`${method} is not allowed`);
      const browserScoped = /^(Browser|Target|Tracing)\./.test(method);
      const result = browserScoped
        ? await session.client.send(method, args?.params || {})
        : await pageSend(method, args?.params || {});
      return { ok: true, action, method, result };
    }
    case "close": {
      requireClient();
      if (args?.closeWindow === false) {
        // Keep the browser, close just the tab this plugin drives.
        return { ok: true, action, ...(await closeTab(session.pageTargetId)) };
      }
      return {
        ok: true,
        action,
        ...(await shutdownBrowser({ closeWindow: true })),
      };
    }
    default:
      throw new Error(`unknown action "${action}"; use ${ACTIONS.join(", ")}`);
  }
}

function requireClient() {
  if (!session.client || session.client.closed) {
    throw new Error("Chrome is not connected. Call the tool with action=launch first.");
  }
}

async function statusPayload() {
  if (!session.client || session.client.closed) {
    return {
      running: false,
      text: "Chrome is not running. Call the tool with action=launch to start it.",
    };
  }
  try {
    const info = await pageInfo();
    return {
      running: true,
      owned: session.owned,
      port: session.port,
      url: info.url,
      title: info.title,
      readyState: info.readyState,
      tabs: (await listTabs()).length,
    };
  } catch (error) {
    return { running: true, owned: session.owned, port: session.port, error: String(error?.message || error) };
  }
}

/* ------------------------------------------------------------- lifecycle */

async function onLoad() {
  await pi.agent.registerTool({
    name: "Chrome",
    description: TOOL_DESCRIPTION,
    risk: "medium",
    planSafeActions: PLAN_SAFE_ACTIONS,
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ACTIONS,
          description:
            "launch=start the browser; navigate/open a page; snapshot read the UI tree; click/fill use snapshot uids; " +
            "screenshot returns the image; evaluate runs JavaScript in the page; console reads console output; " +
            "tabs/select/close manage tabs; cdp sends a raw CDP method; status reports state.",
        },
        url: { type: "string", description: "http(s) URL for action=launch and action=navigate." },
        uid: { type: "string", description: "Snapshot uid (e1, e2, …) for action=click and action=fill." },
        text: { type: "string", description: "Text to type for action=fill." },
        expression: { type: "string", description: "JavaScript for action=evaluate." },
        method: { type: "string", description: "CDP method for action=cdp, e.g. Page.getLayoutMetrics." },
        params: { type: "object", description: "CDP parameters for action=cdp." },
        fullPage: { type: "boolean", description: "Capture beyond the viewport for action=screenshot." },
        format: { type: "string", enum: ["jpeg", "png"], description: "Image format for action=screenshot." },
        quality: { type: "number", description: "JPEG quality 1-100 for action=screenshot." },
        limit: { type: "number", description: "Max console messages for action=console." },
        targetId: { type: "string", description: "Tab target id for action=select and action=close." },
        index: { type: "number", description: "Tab index from action=tabs for action=select." },
        closeWindow: {
          type: "boolean",
          description: "Also close the browser window for action=close (default true).",
        },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args?.action ?? "").trim();
      if (!ACTIONS.includes(action)) {
        return { ok: false, error: `unknown action "${action}"; use ${ACTIONS.join(", ")}` };
      }
      try {
        const settings = await getSettings();
        return await runAction(action, args, settings);
      } catch (error) {
        return { ok: false, action, error: String(error?.message || error) };
      }
    },
  });
  log("tool registered");
}

async function onUnload() {
  try {
    await pi.agent.unregisterTool("Chrome");
  } catch {
    /* the host may already be shutting down */
  }
  try {
    await shutdownBrowser({ closeWindow: true });
  } catch {
    /* best effort */
  }
}

module.exports = { onLoad, onUnload };
