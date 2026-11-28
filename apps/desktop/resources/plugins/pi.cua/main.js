import vm from "node:vm";

function text(value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

async function cuaState() {
  return text(await pi.cua.state());
}

async function cuaBind(args) {
  const targetId = args && typeof args.targetId === "string" ? args.targetId : undefined;
  const tabId = args && typeof args.tabId === "string" ? args.tabId : undefined;
  return text(await pi.cua.bind({ ...(targetId ? { targetId } : {}), ...(tabId ? { tabId } : {}) }));
}

async function cuaClear() {
  return text(await pi.cua.clear());
}

export async function onLoad() {
  await pi.agent.registerTool({
    name: "cua_state",
    description: "Read the unified CUA state: browser backend/tab, desktop capabilities, live grant and target windows.",
    risk: "low",
    planSafeActions: ["*"],
    schema: { type: "object", properties: {}, additionalProperties: false },
    execute: cuaState,
  });
  await pi.agent.registerTool({
    name: "cua_bind",
    description: "Remember the selected desktop target and/or browser tab for this session.",
    risk: "low",
    schema: {
      type: "object",
      properties: { targetId: { type: "string" }, tabId: { type: "string" } },
      additionalProperties: false,
    },
    execute: cuaBind,
  });
  await pi.agent.registerTool({
    name: "cua_clear",
    description: "Clear the session's selected target and browser tab.",
    risk: "low",
    schema: { type: "object", properties: {}, additionalProperties: false },
    execute: cuaClear,
  });

  await pi.agent.registerTool({
    name: "cua_app",
    description: "Observe one desktop target (or the selected target) and return its accessibility nodes, grant and budget.",
    risk: "low",
    planSafeActions: ["*"],
    schema: { type: "object", properties: { targetId: { type: "string" } }, additionalProperties: false },
    execute: cuaApp,
  });
  await pi.agent.registerTool({
    name: "cua_browser",
    description: "Read the session browser binding and its tabs.",
    risk: "low",
    planSafeActions: ["*"],
    schema: { type: "object", properties: { tabId: { type: "string" } }, additionalProperties: false },
    execute: cuaBrowser,
  });
  await pi.agent.registerTool({
    name: "cua_create_tab",
    description: "Open a browser tab and remember it as the session selection.",
    risk: "medium",
    schema: {
      type: "object",
      properties: { url: { type: "string" }, visible: { type: "boolean" } },
      required: ["url"],
      additionalProperties: false,
    },
    execute: cuaCreateTab,
  });
  await pi.agent.registerTool({
    name: "cua_claim_tab",
    description: "Claim a browser tab for agent control until released.",
    risk: "medium",
    schema: { type: "object", properties: { tabId: { type: "string" } }, required: ["tabId"], additionalProperties: false },
    execute: cuaClaimTab,
  });
  await pi.agent.registerTool({
    name: "cua_release_tab",
    description: "Release the claimed browser tab back to the user.",
    risk: "low",
    planSafeActions: ["*"],
    schema: { type: "object", properties: {}, additionalProperties: false },
    execute: cuaReleaseTab,
  });
  await pi.agent.registerTool({
    name: "cua_js",
    description: "Run JavaScript in a persistent per-session CUA runtime. Use cua.state(), cua.app(), cua.browser(), cua.act() and write() to inspect or act; bindings survive across calls until cua_js_reset.",
    risk: "medium",
    schema: {
      type: "object",
      properties: { code: { type: "string" }, title: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
    execute: cuaJs,
  });
  await pi.agent.registerTool({
    name: "cua_js_reset",
    description: "Reset the persistent CUA JavaScript session.",
    risk: "low",
    planSafeActions: ["*"],
    schema: { type: "object", properties: {}, additionalProperties: false },
    execute: cuaJsReset,
  });
  await pi.agent.registerTool({
    name: "cua_act",
    description: "Run one unified CUA action against the selected desktop target or browser tab.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        surface: { type: "string", enum: ["app", "browser"] },
        action: { type: "string" },
        targetId: { type: "string" },
        tabId: { type: "string" },
        uid: { type: "string" },
        point: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
        toPoint: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
        text: { type: "string" },
        keys: { type: "array", items: { type: "string" } },
        scroll: { type: "object", properties: { dx: { type: "number" }, dy: { type: "number" } }, required: ["dx", "dy"] },
        option: { type: "string" },
        url: { type: "string" },
        expression: { type: "string" },
        fullPage: { type: "boolean" },
        limit: { type: "number" },
      },
      required: ["surface", "action"],
      additionalProperties: false,
    },
    execute: cuaAct,
  });
}

export async function onUnload() {
  cuaContexts.clear();
  for (const name of ["cua_state", "cua_bind", "cua_clear", "cua_app", "cua_browser", "cua_create_tab", "cua_claim_tab", "cua_release_tab", "cua_js", "cua_js_reset", "cua_act"]) {
    await pi.agent.unregisterTool(name);
  }
}

async function cuaApp(args) {
  return text(await pi.cua.app({ ...(args?.targetId ? { targetId: args.targetId } : {}) }));
}

async function cuaBrowser(args) {
  return text(await pi.cua.browser({ ...(args?.tabId ? { tabId: args.tabId } : {}) }));
}

async function cuaCreateTab(args) {
  return text(await pi.cua.createTab({ url: String(args?.url ?? ""), visible: args?.visible !== false }));
}

async function cuaClaimTab(args) {
  return text(await pi.cua.claimTab({ tabId: String(args?.tabId ?? "") }));
}

async function cuaReleaseTab() {
  return text(await pi.cua.releaseTab());
}

function appHandle(targetId) {
  const act = (action, extra = {}) => pi.cua.act({ surface: "app", action, targetId, ...extra });
  return {
    targetId,
    observe: () => pi.cua.app({ targetId }),
    screenshot: () => pi.cua.capture({ targetId }),
    click: (uid) => act("click", { uid }),
    doubleClick: (uid) => act("double_click", { uid }),
    rightClick: (uid) => act("right_click", { uid }),
    setValue: (uid, text) => act("set_value", { uid, text }),
    press: (keys) => act("press_keys", { keys }),
    scroll: (uid, dx, dy) => act("scroll", { uid, scroll: { dx, dy } }),
    drag: (point, toPoint) => act("drag", { point, toPoint }),
    launch: (name) => act("launch_app", { text: name }),
    paste: (uid, text) => act("paste_text", { uid, text }),
    secondary: (uid, option) => act("secondary_action", { uid, option }),
    act,
  };
}

/**
 * Generic client for the host's BrowserSession object. Every property/method
 * becomes a path segment sent to `pi.cua.sessionInvoke`, so the sandbox sees
 * the full session API (tabs, playwright locators, ax, dom_cua, clipboard,
 * dev, marks, waits) without a hand-written wrapper per method.
 */
function sessionNode(steps = [], tabId) {
  const target = (...args) => {
    const next = steps.length
      ? [...steps.slice(0, -1), { ...steps[steps.length - 1], args }]
      : steps;
    return sessionNode(next, tabId);
  };
  return new Proxy(target, {
    get(_target, prop) {
      if (prop === "then") {
        // A bare handle (no member access yet) must survive `await getTab()`
        // unchanged; only member paths resolve through the host.
        if (!steps.length) return undefined;
        return (resolve, reject) => {
          pi.cua.sessionInvoke({ ...(tabId ? { tabId } : {}), steps })
            .then((response) => {
              if (response && response.kind === "locator") resolve({ locator: true, path: response.path });
              else resolve(response ? response.value : undefined);
            }, reject);
        };
      }
      if (prop === "toJSON") return () => ({ steps, ...(tabId ? { tabId } : {}) });
      if (prop === "constructor" || typeof prop === "symbol") return undefined;
      return sessionNode([...steps, { m: String(prop) }], tabId);
    },
  });
}

const cuaContexts = new Map();

function contextFor(sessionId) {
  let entry = cuaContexts.get(sessionId);
  if (entry) return entry;
  const output = [];
  const images = [];
  const sandbox = {
    cua: {
      getState: () => pi.cua.state(),
      state: () => pi.cua.state(),
      bind: (input) => pi.cua.bind(input ?? {}),
      clear: () => pi.cua.clear(),
      app: (input) => pi.cua.app(input ?? {}),
      browser: (input) => pi.cua.browser(input ?? {}),
      createTab: (input) => pi.cua.createTab(input ?? {}),
      claimTab: (input) => pi.cua.claimTab(input ?? {}),
      releaseTab: () => pi.cua.releaseTab(),
      capture: (input) => pi.cua.capture(input ?? {}),
      act: (input) => pi.cua.act(input ?? {}),
      getApp: async (targetId) => appHandle(targetId),
      getTab: (tabId) => sessionNode([], String(tabId)),
      getSession: () => sessionNode([]),
      getBrowser: async () => {
        const state = await pi.cua.browser();
        const root = sessionNode([], state && state.tabId ? String(state.tabId) : undefined);
        return {
          tabs: async () => (await sessionNode([]).tabs.list()),
          getTab: (tabId) => sessionNode([], String(tabId)),
          createTab: (url, options = {}) => pi.cua.createTab({ url, visible: options.visible !== false }),
          getState: () => pi.cua.browser(),
          session: root,
        };
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(30_000, Number(ms) || 0)))),
      screenshot: (input) => pi.cua.capture(input ?? {}),
      session: () => sessionNode([]),
      getDialog: async (tabId) => {
        const tab = sessionNode([], tabId ? String(tabId) : undefined);
        const info = await tab.getJsDialog();
        if (!info) return null;
        return {
          ...info,
          accept: (promptText) => pi.cua.act({
            surface: "browser",
            action: "dialog",
            ...(tabId ? { tabId: String(tabId) } : {}),
            accept: true,
            ...(typeof promptText === "string" ? { promptText } : {}),
          }),
          dismiss: () => pi.cua.act({
            surface: "browser",
            action: "dialog",
            ...(tabId ? { tabId: String(tabId) } : {}),
            accept: false,
          }),
        };
      },
      browsers: () => pi.cua.browsers(),
      getBrowsers: () => ({
        list: () => pi.cua.browsers(),
        getDefault: async () => {
          const list = await pi.cua.browsers();
          return list.find((browser) => browser.id === "embedded") ?? list[0] ?? null;
        },
        getForUrl: async (url) => {
          const list = await pi.cua.browsers();
          if (!/^https?:/i.test(String(url))) return list.find((browser) => browser.id === "embedded") ?? list[0] ?? null;
          return list.find((browser) => browser.type === "extension") ?? list.find((browser) => browser.id === "embedded") ?? list[0] ?? null;
        },
        get: async (id) => (await pi.cua.browsers()).find((browser) => browser.id === id) ?? null,
      }),
      waitFor: async (predicate, options = {}) => {
        const timeoutMs = Math.max(1, Math.min(60_000, Number(options.timeoutMs ?? 10_000) || 10_000));
        const intervalMs = Math.max(25, Math.min(2_000, Number(options.intervalMs ?? 100) || 100));
        const deadline = Date.now() + timeoutMs;
        let last;
        while (Date.now() <= deadline) {
          last = await predicate();
          if (last) return last;
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        throw new Error(`cua.waitFor timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
      },
      help: () => [
        "cua.state() / cua.bind({targetId,tabId}) / cua.clear()",
        "cua.app({targetId}) / cua.browser({tabId}) / cua.createTab({url})",
        "cua.claimTab({tabId}) / cua.releaseTab() / cua.capture()",
        "cua.act({surface,action,...})",
        "cua.getApp(targetId) / cua.getTab(tabId) / cua.getSession() / cua.getBrowser()",
        "cua.browsers() / cua.getBrowsers().list()|getDefault()|getForUrl(url)|get(id)",
        "cua.getDialog(tabId) → { type, message, accept(text?), dismiss() }",
        "Session objects expose the full API: tab.playwright.locator(...).click(), tab.dom_cua.get_visible_dom(), tab.ax, tab.clipboard, tab.dev.logs(), tab.waitForLoadState(), tab.markDeliverable()",
        "cua.waitFor(predicate,{timeoutMs,intervalMs})",
        "cua.screenshot() / cua.sleep(ms) / emitImage(image)",
      ].join("\n"),
    },
    emitImage: (image) => {
      if (images.length < 8 && image && typeof image.data === "string") {
        images.push({ type: "image", mimeType: String(image.mimeType || "image/png"), data: image.data });
      }
    },
    nodeRepl: {
      write: (value) => { if (output.length < 200) output.push(value); },
      emitImage: (image) => {
        if (images.length < 8 && image && typeof image.data === "string") {
          images.push({ type: "image", mimeType: String(image.mimeType || "image/png"), data: image.data });
        }
      },
    },
    write: (value) => { if (output.length < 200) output.push(value); },
    console: { log: (...values) => { if (output.length < 200) output.push(values.length === 1 ? values[0] : values); } },
    setTimeout,
    clearTimeout,
  };
  entry = {
    context: vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    }),
    output,
    images,
  };
  cuaContexts.set(sessionId, entry);
  return entry;
}

async function cuaJs(args, ctx) {
  const code = String(args?.code ?? "").trim();
  if (!code) return text({ ok: false, error: "cua_js requires code" });
  if (code.length > 200_000) return text({ ok: false, error: "cua_js code exceeds 200 KB" });
  if (ctx?.signal?.aborted) return text({ ok: false, error: "cua_js cancelled", output: [] });
  const sessionId = String(ctx?.sessionId ?? "default");
  const entry = contextFor(sessionId);
  entry.output.length = 0;
  entry.images.length = 0;
  try {
    const script = new vm.Script(`(async () => {\n${code}\n})()`, {
      filename: "cua-repl.js",
    });
    const result = await script.runInContext(entry.context, { timeout: 15_000 });
    if (ctx?.signal?.aborted) return text({ ok: false, error: "cua_js cancelled" });
    return [
      { type: "text", text: JSON.stringify({ ok: true, result, output: entry.output }, null, 2) },
      ...entry.images,
    ];
  } catch (error) {
    return [
      { type: "text", text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), output: entry.output }, null, 2) },
      ...entry.images,
    ];
  }
}

async function cuaJsReset(_args, ctx) {
  cuaContexts.delete(String(ctx?.sessionId ?? "default"));
  return text({ ok: true, reset: true });
}

async function cuaAct(args) {
  const input = { ...args };
  delete input.action_name;
  return text(await pi.cua.act(input));
}
