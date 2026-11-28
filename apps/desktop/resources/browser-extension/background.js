const DEFAULT_URL = "ws://127.0.0.1:47123/pi-browser";
const NATIVE_HOST = "com.pi.desktop.browser";
let socket = null;
let nativePort = null;
let transport = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
/** Set when the user saves an explicit fallback URL for this worker's lifetime. */
let preferWebSocket = false;
const attached = new Set();
const consoleByTab = new Map();
const networkByTab = new Map();

async function bridgeUrl() {
  const stored = await chrome.storage.local.get({ bridgeUrl: DEFAULT_URL });
  return stored.bridgeUrl || DEFAULT_URL;
}

async function hasStoredUrl() {
  const stored = await chrome.storage.local.get({ bridgeUrl: null });
  return typeof stored.bridgeUrl === "string" && stored.bridgeUrl.length > 0;
}

function reportStatus(state, detail = {}) {
  void chrome.storage.local.set({ bridgeStatus: { state, at: Date.now(), ...detail } });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectAttempt += 1;
  const delay = Math.min(2_000 * reconnectAttempt, 30_000);
  reconnectTimer = setTimeout(() => void connect(), delay);
}

// An idle MV3 service worker is stopped after ~30s, which closes the transport.
// Traffic resets that timer, so ping while connected.
let keepalive = null;
function startKeepalive() {
  clearInterval(keepalive);
  keepalive = setInterval(() => {
    try {
      if (nativePort) nativePort.postMessage({ type: "ping" });
      else if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }, 20_000);
}

function stopKeepalive() {
  clearInterval(keepalive);
  keepalive = null;
}

/**
 * Native messaging is the primary transport: Chrome launches the registered
 * host, so there is no URL or token in the extension. The stored WebSocket
 * URL remains as an explicit fallback for setups without the host installed.
 */
function connectNative() {
  if (nativePort) return true;
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    return false;
  }
  nativePort = port;
  transport = "native";
  reconnectAttempt = 0;
  reportStatus("connected", { transport, host: NATIVE_HOST });
  startKeepalive();
  port.onMessage.addListener((message) => {
    if (nativePort !== port) return;
    void dispatchAndReply(message, (reply) => {
      try { port.postMessage(reply); } catch {}
    });
  });
  port.onDisconnect.addListener(() => {
    if (nativePort !== port) return;
    nativePort = null;
    transport = null;
    stopKeepalive();
    // Reading lastError is required inside this callback or Chrome logs it.
    const reason = chrome.runtime.lastError?.message || "native host disconnected";
    void fallbackOrRetry(reason);
  });
  return true;
}

async function fallbackOrRetry(reason) {
  if (await hasStoredUrl()) {
    reportStatus("reconnecting", { transport: "native", host: NATIVE_HOST, reason });
    await connectWebSocket();
    return;
  }
  // Retried by the 30s alarm instead of a tight loop; the app may be closed.
  reportStatus("disconnected", { transport: "native", host: NATIVE_HOST, reason });
}

function connectNativeOrWebSocket(preferWebSocket) {
  if (preferWebSocket) return false;
  return connectNative();
}

function dispatchAndReply(message, reply) {
  if (typeof message?.id !== "number" || !message.method) return;
  void (async () => {
    try {
      reply({ id: message.id, result: await dispatch(message.method, message.params || {}) });
    } catch (error) {
      reply({ id: message.id, error: { message: error?.message || String(error) } });
    }
  })();
}

async function connect(options = {}) {
  clearTimeout(reconnectTimer);
  const forceWebSocket = options.forceWebSocket === true || preferWebSocket;
  if (!forceWebSocket) {
    if (socket?.readyState === WebSocket.OPEN) return;
    if (connectNativeOrWebSocket(false)) return;
    if (!(await hasStoredUrl())) {
      scheduleReconnect();
      return;
    }
  }
  await connectWebSocket();
}

async function connectWebSocket() {
  const previous = socket;
  socket = null;
  if (previous) {
    try { previous.close(); } catch {}
  }
  const url = await bridgeUrl();
  transport = "websocket";
  reportStatus("connecting", { transport, url });
  const next = new WebSocket(url);
  socket = next;
  next.addEventListener("open", () => {
    if (socket !== next) return;
    reconnectAttempt = 0;
    reportStatus("connected", { transport, url });
    next.send(JSON.stringify({ type: "hello", extension: chrome.runtime.id }));
    startKeepalive();
  });
  next.addEventListener("message", (event) => {
    if (socket !== next) return;
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    void dispatchAndReply(message, (reply) => {
      if (socket === next) next.send(JSON.stringify(reply));
    });
  });
  next.addEventListener("close", (event) => {
    if (socket !== next) return;
    socket = null;
    transport = null;
    stopKeepalive();
    reportStatus("disconnected", { transport: "websocket", url, code: event.code, reason: event.reason || "" });
    scheduleReconnect();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bridgeUrl) {
    preferWebSocket = true;
    if (nativePort) {
      try { nativePort.disconnect(); } catch {}
      nativePort = null;
      transport = null;
      stopKeepalive();
    }
    void connect({ forceWebSocket: true });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "reconnect") {
    void connect();
    respond({ ok: true });
  }
});

chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("pi-bridge-retry", { periodInMinutes: 0.5 });
  void connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "pi-bridge-retry") return;
  if (nativePort) return;
  if (socket?.readyState === WebSocket.OPEN) return;
  void connect();
});
void chrome.alarms.create("pi-bridge-retry", { periodInMinutes: 0.5 });

void connect();

async function attachDebugger(tabId) {
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable").catch(() => undefined);
  await chrome.debugger.sendCommand({ tabId }, "Network.enable").catch(() => undefined);
  await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => undefined);
}

async function cdp(tabId, method, params = {}) {
  if (!attached.has(tabId)) {
    // chrome:// pages refuse attachment until navigation; do not cache a
    // failed attach or every later call would skip the retry.
    await attachDebugger(tabId);
  }
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (error) {
    if (!/not attached/i.test(String(error?.message ?? error))) throw error;
    attached.delete(tabId);
    await attachDebugger(tabId);
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attached.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;
  if (method === "Runtime.consoleAPICalled") {
    const list = consoleByTab.get(tabId) || [];
    list.push({ type: params?.type, message: (params?.args || []).map((arg) => String(arg.value ?? arg.description ?? "")).join(" "), timestamp: Date.now() });
    consoleByTab.set(tabId, list.slice(-300));
  }
  if (method?.startsWith("Network.")) {
    const list = networkByTab.get(tabId) || [];
    if (method === "Network.requestWillBeSent") list.push({ method: params?.request?.method, url: params?.request?.url, status: 0, timestamp: Date.now() });
    if (method === "Network.responseReceived") {
      const requestId = params?.requestId;
      const entry = list.find((item) => item.requestId === requestId);
      if (entry) entry.status = Number(params?.response?.status) || 0;
      else list.push({ requestId, url: params?.response?.url, status: Number(params?.response?.status) || 0, timestamp: Date.now() });
    }
    networkByTab.set(tabId, list.slice(-300));
  }
});

async function evaluate(tabId, expression) {
  const result = await cdp(tabId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluation failed");
  return result?.result?.value;
}

const SNAPSHOT_SCRIPT = `(() => {
  const lines = [];
  const byRef = new Map();
  let index = 0;
  const roleOf = (el) => {
    const tag = el.tagName?.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') return el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag || '')) return 'heading';
    if (tag === 'img') return 'image';
    return 'generic';
  };
  const nameOf = (el) => (el.getAttribute?.('aria-label') || el.innerText || el.value || el.getAttribute?.('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
  const walk = (el, depth) => {
    if (!el || depth > 24) return;
    const tag = el.tagName?.toLowerCase();
    if (['script','style','noscript','template'].includes(tag)) return;
    const role = roleOf(el);
    const interactive = ['link','button','checkbox','radio','textbox','combobox'].includes(role);
    const ref = interactive ? 'e' + (++index) : '';
    if (ref) byRef.set(ref, el);
    if (interactive || role === 'heading' || role === 'image') {
      lines.push('- ' + (ref ? ref + ' ' : '') + role + (nameOf(el) ? ' "' + nameOf(el) + '"' : ''));
    }
    for (const child of el.children || []) walk(child, depth + 1);
  };
  walk(document.body, 0);
  window.__PI_EXT_REFS = { byRef };
  return { tree: lines.join('\\n'), url: location.href, title: document.title };
})()`;

async function dispatch(method, params) {
  switch (method) {
    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs.map((tab) => ({
          id: String(tab.id),
          url: tab.url || "",
          title: tab.title || "",
          active: tab.active,
          ...(typeof tab.windowId === "number" ? { windowId: tab.windowId } : {}),
          ...(typeof tab.groupId === "number" && tab.groupId >= 0 ? { groupId: tab.groupId } : {}),
          ...(tab.sessionId ? { providerTabId: String(tab.sessionId) } : {}),
        })),
      };
    }
    case "tabs.open": {
      const tab = await chrome.tabs.create({ url: params.url || "about:blank" });
      return { id: String(tab.id), url: tab.url || params.url, title: tab.title || "" };
    }
    case "tabs.close": await chrome.tabs.remove(Number(params.tabId)); return { ok: true };
    case "tabs.select": await chrome.tabs.update(Number(params.tabId), { active: true }); return { ok: true };
    case "page.goto": await chrome.tabs.update(Number(params.tabId), { url: params.url }); return { ok: true };
    case "page.reload": await chrome.tabs.reload(Number(params.tabId)); return { ok: true };
    case "page.evaluate": return evaluate(Number(params.tabId), String(params.expression || ""));
    case "page.snapshot": return evaluate(Number(params.tabId), SNAPSHOT_SCRIPT);
    case "page.click": {
      const tabId = Number(params.tabId);
      const ok = await evaluate(tabId, `(() => { const el = window.__PI_EXT_REFS?.byRef.get(${JSON.stringify(params.ref)}); if (!el) return false; el.scrollIntoView({block:'center'}); setTimeout(() => el.click(), 0); return true; })()`);
      if (!ok) throw new Error(`unknown or stale ref ${params.ref}`);
      return { ok: true };
    }
    case "page.fill": {
      const tabId = Number(params.tabId);
      const ok = await evaluate(tabId, `(() => { const el = window.__PI_EXT_REFS?.byRef.get(${JSON.stringify(params.ref)}); if (!el) return false; el.focus(); if ('value' in el) { el.value = ${JSON.stringify(params.text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } else { el.textContent = ${JSON.stringify(params.text)}; } return true; })()`);
      if (!ok) throw new Error(`unknown or stale ref ${params.ref}`);
      return { ok: true };
    }
    case "page.screenshot": {
      const tabId = Number(params.tabId);
      const format = params.format === "jpeg" ? "jpeg" : "png";
      const fullPage = params.fullPage === true;
      const shot = await cdp(tabId, "Page.captureScreenshot", {
        format,
        ...(format === "jpeg" ? { quality: 70 } : {}),
        captureBeyondViewport: fullPage,
      });
      const size = await evaluate(tabId, "({ width: window.innerWidth, height: window.innerHeight })");
      return { mimeType: format === "jpeg" ? "image/jpeg" : "image/png", data: shot.data, width: size.width, height: size.height };
    }
    case "page.input": {
      const tabId = Number(params.tabId);
      const event = params.event || {};
      if (event.type === "mouseMove") await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: event.x, y: event.y });
      else if (event.type === "mouseDown" || event.type === "mouseUp") await cdp(tabId, "Input.dispatchMouseEvent", { type: event.type === "mouseDown" ? "mousePressed" : "mouseReleased", x: event.x, y: event.y, button: event.button || "left", clickCount: event.clickCount || 1 });
      else if (event.type === "keyDown" || event.type === "keyUp") await cdp(tabId, "Input.dispatchKeyEvent", { type: event.type === "keyDown" ? "keyDown" : "keyUp", key: event.keyCode });
      else if (event.type === "char") await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", text: event.text || event.keyCode });
      else if (event.type === "mouseWheel") await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: event.x || 0, y: event.y || 0, deltaX: event.deltaX || 0, deltaY: event.deltaY || 0 });
      else if (event.type === "insertText") await cdp(tabId, "Input.insertText", { text: event.text });
      return { ok: true };
    }
    case "page.upload": {
      const tabId = Number(params.tabId);
      const selector = String(params.selector || "input[type=file]");
      const files = Array.isArray(params.files) ? params.files.map(String) : [];
      if (!files.length) throw new Error("upload needs files");
      await cdp(tabId, "DOM.enable");
      const document = await cdp(tabId, "DOM.getDocument", { depth: 1 });
      const node = await cdp(tabId, "DOM.querySelector", { nodeId: document.root.nodeId, selector });
      if (!node?.nodeId) throw new Error(`file input not found: ${selector}`);
      await cdp(tabId, "DOM.setFileInputFiles", { files, nodeId: node.nodeId });
      return { ok: true, files };
    }
    case "page.locator": {
      const tabId = Number(params.tabId);
      const action = String(params.action || "list");
      const selector = String(params.selector || "");
      return evaluate(tabId, `(() => {
        const selector = ${JSON.stringify(selector)};
        const action = ${JSON.stringify(action)};
        const value = ${JSON.stringify(String(params.value ?? ""))};
        const nodes = selector ? [...document.querySelectorAll(selector)] : [];
        const describe = (el) => ({ text: (el.innerText || el.value || '').trim().slice(0, 200), tag: el.tagName.toLowerCase() });
        if (action === 'count') return nodes.length;
        if (action === 'text') return nodes.map(describe);
        if (action === 'click') { const el = nodes[0]; if (!el) return false; setTimeout(() => el.click(), 0); return true; }
        if (action === 'fill') { const el = nodes[0]; if (!el) return false; el.focus(); if ('value' in el) { el.value = value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } else { el.textContent = value; } return true; }
        return nodes.map(describe);
      })()`);
    }
    case "page.frames": {
      const tabId = Number(params.tabId);
      const tree = await cdp(tabId, "Page.getFrameTree");
      const frames = [];
      const walk = (node, depth) => {
        if (!node?.frame || depth > 8) return;
        frames.push({ frameId: node.frame.id, url: node.frame.url, name: node.frame.name || "", depth });
        for (const child of node.childFrames || []) walk(child, depth + 1);
      };
      walk(tree?.frameTree, 0);
      if ((params.action || "list") === "list") return { frames };
      const frameId = String(params.frameId || params.url || "");
      const selected = frames.find((frame) => frame.frameId === frameId || (params.url && frame.url.includes(String(params.url))));
      if (!selected) throw new Error(`frame not found: ${frameId}`);
      const world = await cdp(tabId, "Page.createIsolatedWorld", { frameId: selected.frameId, worldName: "pi-desktop" });
      const action = String(params.action || "text");
      const selector = String(params.targetSelector || "body");
      if (action === "count") {
        const value = await cdp(tabId, "Runtime.evaluate", {
          expression: `(() => { const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]; return { count: nodes.length, matches: nodes.slice(0,50).map((el) => ({ text: String(el.innerText || el.value || '').trim().slice(0,200), tag: el.tagName.toLowerCase() })) }; })()`,
          contextId: world.executionContextId,
          returnByValue: true,
        });
        return { frameId: selected.frameId, url: selected.url, ...(value?.result?.value || {}) };
      }
      const expression = action === "html"
        ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || ""`
        : action === "click"
          ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; setTimeout(() => el.click(), 0); return true; })()`
          : action === "fill"
            ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(String(params.value || ""))}; el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`
            : `document.querySelector(${JSON.stringify(selector)})?.innerText || document.body?.innerText || ""`;
      const result = await cdp(tabId, "Runtime.evaluate", { expression, contextId: world.executionContextId, returnByValue: true });
      return { frameId: selected.frameId, url: selected.url, value: result?.result?.value ?? "" };
    }
    case "page.download": {
      const url = String(params.url || "");
      if (!/^https?:\/\//i.test(url)) throw new Error("download needs an http(s) url");
      const id = await chrome.downloads.download({
        url,
        ...(params.filename ? { filename: String(params.filename) } : {}),
        saveAs: false,
      });
      let record;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        [record] = await chrome.downloads.search({ id });
        if (record?.state === "complete" || record?.state === "interrupted") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!record || record.state !== "complete") throw new Error(record?.error || "download did not complete");
      return { path: record.filename, url: record.url || url, filename: record.filename.split(/[\\/]/).pop() || "", state: "completed" };
    }
    case "page.waitForDownload": {
      const timeoutMs = Math.max(1000, Math.min(300000, Number(params.timeoutMs) || 30000));
      const prior = new Set((await chrome.downloads.search({ orderBy: ["-startTime"], limit: 50 })).map((item) => item.id));
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const list = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 50 });
        const fresh = list.find((item) => !prior.has(item.id));
        if (fresh) {
          let record = fresh;
          while (record.state === "in_progress" && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            record = (await chrome.downloads.search({ id: fresh.id }))[0] || record;
          }
          return {
            path: record.filename || "",
            url: record.url || "",
            filename: String(record.filename || "").split("/").pop() || "",
            state: record.state === "complete" ? "completed" : record.state === "interrupted" ? "interrupted" : "cancelled",
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error("download did not start in time");
    }
    case "page.console": return { entries: consoleByTab.get(Number(params.tabId)) || [] };
    case "page.network": return { entries: networkByTab.get(Number(params.tabId)) || [] };
    case "page.dialog": {
      const tabId = Number(params.tabId);
      try {
        await cdp(tabId, "Page.handleJavaScriptDialog", {
          accept: params.accept !== false,
          ...(typeof params.promptText === "string" ? { promptText: params.promptText } : {}),
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    default:
      throw new Error(`unknown extension method: ${method}`);
  }
}
