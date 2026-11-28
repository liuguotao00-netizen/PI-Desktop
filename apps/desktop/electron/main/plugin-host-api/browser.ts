import type { BrowserService } from "../browser/service.ts";
import type { BrowserSessions } from "../browser/sessions.ts";
import type { TabMark } from "../browser/lifecycle.ts";

export type BrowserHostApiOptions = {
  browser: BrowserService | undefined;
  assertCdp: () => void;
  sessionId: () => string | undefined;
  contextSessionId: string | undefined;
  contextTabId: string | undefined;
  audit?: (entry: Record<string, unknown>) => void;
  lockForAgent: (sessionId: string | undefined) => void;
  unlockForAgent: (sessionId: string | undefined) => void;
  pluginId: string;
  /** Shared browser-session registry (tabs, claims, capabilities, cleanup). */
  sessions?: BrowserSessions;
};

function apiError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * `pi.browser` host surface. Session ownership and the `browser.cdp`
 * permission stay with the runtime; this module only maps arguments onto
 * BrowserService and returns its results.
 */
export function createBrowserHostApi(options: BrowserHostApiOptions) {
  const { browser, assertCdp, sessionId, contextSessionId, contextTabId, audit, lockForAgent, unlockForAgent, pluginId } = options;
  const services = { browser };
  /**
   * All driving operations resolve the Codex-shaped BrowserSession from the
   * shared registry, so tools and CUA act on the same tab objects and state.
   */
  const sessionRoute = (explicitSession?: string, explicitTab?: string) => {
    const id = explicitSession ?? sessionId() ?? contextSessionId;
    if (!id || !options.sessions) return null;
    const tabId = explicitTab ?? contextTabId;
    return { id, tabId, session: options.sessions!.get(id) };
  };
  return {
    reveal: async (input?: { sessionId?: string }) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      await services.browser.reveal(
        input?.sessionId ?? sessionId() ?? contextSessionId,
      );
      audit?.({
        pluginId,
        api: "browser.reveal",
        ok: true,
        ts: Date.now(),
      });
    },
    inputEvent: (event: unknown) => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return services.browser.inputEvent(
        event,
        sessionId() ?? contextSessionId,
        contextTabId,
      );
    },
    downloads: () => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return services.browser.downloads(sessionId() ?? contextSessionId, contextTabId);
    },
    cancelDownload: (input: string | { id?: string }) => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      const id = typeof input === "string" ? input : String(input?.id ?? "");
      return { ok: services.browser.cancelDownload(id, sessionId() ?? contextSessionId, contextTabId) };
    },
    networkIdle: (input: { timeoutMs?: number; idleMs?: number } = {}) => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return services.browser.waitForNetworkIdle(
        input ?? {},
        sessionId() ?? contextSessionId,
        contextTabId,
      );
    },
    consoleLogs: (input: { limit?: number }) => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return services.browser.consoleLogs(
        input,
        sessionId() ?? contextSessionId,
        contextTabId,
      );
    },
    networkRequests: (input: { limit?: number }) => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return services.browser.networkRequests(
        input,
        sessionId() ?? contextSessionId,
        contextTabId,
      );
    },
    handleDialog: (input: { accept?: boolean; promptText?: string }) => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return services.browser.handleDialog(
        input,
        sessionId() ?? contextSessionId,
        contextTabId,
      );
    },
    insertText: (input: string | { text?: string; sessionId?: string; tabId?: string }) => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      const text = typeof input === "string" ? input : String(input?.text ?? "");
      return services.browser.insertText(
        text,
        (typeof input === "object" ? input.sessionId : undefined) ??
          sessionId() ??
          contextSessionId,
        (typeof input === "object" ? input.tabId : undefined) ?? contextTabId,
      );
    },
    evaluateIsolated: async (
      input: { expression?: string; sessionId?: string; tabId?: string } = {},
    ) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const route = sessionRoute(input.sessionId, input.tabId);
      const result = route
        ? await route.session.evaluateIsolated(String(input.expression ?? ""), route.tabId)
        : await services.browser.evaluateIsolated(
            { expression: String(input.expression ?? "") },
            input.sessionId ?? contextSessionId ?? sessionId(),
            input.tabId ?? contextTabId,
          );
      audit?.({
        pluginId,
        api: "browser.evaluateIsolated",
        ok: true,
        ts: Date.now(),
      });
      return result;
    },
    evaluateNative: async (
      input: { expression?: string; sessionId?: string; tabId?: string } = {},
    ) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const route = sessionRoute(input.sessionId, input.tabId);
      const result = route
        ? await route.session.evaluateNative(String(input.expression ?? ""), route.tabId)
        : await services.browser.evaluateNative(
            { expression: String(input.expression ?? "") },
            input.sessionId ?? contextSessionId ?? sessionId(),
            input.tabId ?? contextTabId,
          );
      audit?.({
        pluginId,
        api: "browser.evaluateNative",
        ok: true,
        ts: Date.now(),
      });
      return result;
    },
    navigate: async (
      input: { url?: string; path?: string; sessionId?: string; tabId?: string } = {},
    ) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const route = sessionRoute(input.sessionId, input.tabId);
      const result = route
        ? await route.session.navigate(input, route.tabId)
        : await services.browser.navigate(
            input,
            input.sessionId ?? contextSessionId ?? sessionId(),
            input.tabId ?? contextTabId,
          );
      audit?.({
        pluginId,
        api: "browser.navigate",
        ok: true,
        ts: Date.now(),
      });
      return result;
    },
    action: (input: "back" | "forward" | "reload" | "stop" | { action?: string }) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const action = typeof input === "string" ? input : String(input?.action ?? "");
      if (
        action === "back" ||
        action === "forward" ||
        action === "reload" ||
        action === "stop"
      ) {
        services.browser.action(action, sessionId() ?? contextSessionId, contextTabId);
      }
    },
    setBounds: (hole: unknown) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      return services.browser.setBounds(pluginId, hole);
    },
    setVisible: (input: boolean | { visible?: boolean }) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const visible = typeof input === "boolean" ? input : input?.visible === true;
      services.browser.setVisible(pluginId, visible);
    },
    getState: () => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      return services.browser.getState(sessionId() ?? contextSessionId, contextTabId);
    },
    openExternal: () => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      services.browser.openExternal(sessionId() ?? contextSessionId, contextTabId);
      audit?.({
        pluginId,
        api: "browser.openExternal",
        ok: true,
        ts: Date.now(),
      });
    },
    snapshot: async () => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const route = sessionRoute();
      return route ? route.session.snapshot(route.tabId) : services.browser.snapshot(sessionId() ?? contextSessionId, contextTabId);
    },
    history: async (input: { from?: string | number; queries?: string[]; limit?: number; sessionId?: string; tabId?: string } = {}) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const route = sessionRoute(input.sessionId);
      return route
        ? route.session.history(input)
        : services.browser.history(sessionId() ?? contextSessionId, input.tabId ?? contextTabId);
    },
    screenshot: async (input?: { fullPage?: boolean }) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const route = sessionRoute();
      return route
        ? route.session.screenshot(input ?? {}, route.tabId)
        : services.browser.screenshot(input, sessionId() ?? contextSessionId, contextTabId);
    },
    click: async (input: string | { uid?: string }) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const uid = typeof input === "string" ? input : String(input?.uid ?? "");
      const route = sessionRoute();
      if (route) await route.session.click(uid, route.tabId);
      else await services.browser.click(uid, sessionId() ?? contextSessionId, contextTabId);
    },
    fill: async (
      input: string | { uid?: string; text?: string },
      textArg?: string,
    ) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const uid = typeof input === "string" ? input : String(input?.uid ?? "");
      const text = typeof input === "string" ? String(textArg ?? "") : String(input?.text ?? "");
      const route = sessionRoute();
      if (route) await route.session.fill(uid, text, route.tabId);
      else await services.browser.fill(uid, text, sessionId() ?? contextSessionId, contextTabId);
    },
    uploadFiles: async (
      input: { selector?: string; files?: string[]; sessionId?: string; tabId?: string } = {},
    ) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const result = await services.browser.uploadFiles(
        String(input.selector ?? "input[type=file]"),
        Array.isArray(input.files) ? input.files.map(String) : [],
        input.sessionId ?? contextSessionId ?? sessionId(),
        input.tabId ?? contextTabId,
      );
      audit?.({
        pluginId,
        api: "browser.uploadFiles",
        ok: true,
        ts: Date.now(),
      });
      return result;
    },
    domAction: async (input: { action?: string; nodeId?: string; x?: number; y?: number; deltaX?: number; deltaY?: number; text?: string; keys?: string[]; tabId?: string; sessionId?: string } = {}) => {
      const route = sessionRoute(input.sessionId);
      if (!route) throw apiError("UNAVAILABLE", "DOM actions require a browser session");
      const selected = route.tabId ?? (await route.session.tabs.selected())?.id;
      if (!selected) throw apiError("UNAVAILABLE", "no browser tab is selected");
      const tab = await route.session.tabs.get(selected);
      const action = String(input.action ?? "visibleDom");
      if (action === "visibleDom") return await tab.dom_cua.get_visible_dom();
      if (action === "click") { await tab.dom_cua.click({ node_id: input.nodeId }); return { ok: true }; }
      if (action === "doubleClick") { await tab.dom_cua.double_click({ node_id: input.nodeId }); return { ok: true }; }
      if (action === "scroll") { await tab.dom_cua.scroll({ node_id: input.nodeId, deltaX: input.deltaX, deltaY: input.deltaY }); return { ok: true }; }
      if (action === "type") { await tab.dom_cua.type({ text: String(input.text ?? ""), node_id: input.nodeId }); return { ok: true }; }
      if (action === "keypress") { await tab.dom_cua.keypress({ keys: Array.isArray(input.keys) ? input.keys.map(String) : [] }); return { ok: true }; }
      if (action === "downloadMedia") return await tab.dom_cua.downloadMedia({ node_id: input.nodeId });
      throw apiError("INVALID_ARGUMENT", `unknown DOM action: ${action}`);
    },
    locator: async (input: Record<string, unknown> = {}) => {
      const route = sessionRoute(typeof input.sessionId === "string" ? input.sessionId : undefined);
      if (route) return await route.session.locator(input as never, route.tabId);
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return await services.browser.locator(input, sessionId() ?? contextSessionId, typeof input.tabId === "string" ? input.tabId : contextTabId);
    },
    waitForDownload: async (input: { timeoutMs?: number; sessionId?: string; tabId?: string } = {}) => {
      const route = sessionRoute(input.sessionId);
      if (route) return await route.session.waitForDownload(input.timeoutMs, route.tabId);
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return await services.browser.waitForDownload(input.timeoutMs, sessionId() ?? contextSessionId, input.tabId ?? contextTabId);
    },
    waitForFileChooser: (input: { timeoutMs?: number; sessionId?: string; tabId?: string } = {}) => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return services.browser.waitForFileChooser(
        input.timeoutMs,
        input.sessionId ?? contextSessionId ?? sessionId(),
        input.tabId ?? contextTabId,
      );
    },
    cancelFileChooser: () => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return services.browser.cancelFileChooser(sessionId() ?? contextSessionId, contextTabId);
    },
    setFileChooserFiles: (input: { files?: string[]; sessionId?: string; tabId?: string } = {}) => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return services.browser.setFileChooserFiles(
        Array.isArray(input.files) ? input.files.map(String) : [],
        input.sessionId ?? contextSessionId ?? sessionId(),
        input.tabId ?? contextTabId,
      );
    },
    downloadUrl: async (
      input: { url?: string; filename?: string; sessionId?: string; tabId?: string } = {},
    ) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      return services.browser.downloadUrl(
        String(input.url ?? ""),
        typeof input.filename === "string" ? input.filename : undefined,
        input.sessionId ?? contextSessionId ?? sessionId(),
        input.tabId ?? contextTabId,
      );
    },
    crossOriginFrame: (input: { frameId?: string; url?: string; action?: string; targetSelector?: string; value?: string; limit?: number } = {}) => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return services.browser.crossOriginFrame(
        {
          action: (input.action as "list" | "text" | "html" | "click" | "fill") || "list",
          ...(input.frameId ? { frameId: input.frameId } : {}),
          ...(input.url ? { url: input.url } : {}),
          ...(input.targetSelector ? { targetSelector: input.targetSelector } : {}),
          ...(typeof input.value === "string" ? { value: input.value } : {}),
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        },
        sessionId() ?? contextSessionId,
        contextTabId,
      );
    },
    clickAndWaitForDownload: (input: { ref?: string; timeoutMs?: number; sessionId?: string; tabId?: string } = {}) => {
      assertCdp();
      if (!services.browser) throw apiError("UNAVAILABLE", "browser host missing");
      return services.browser.clickAndWaitForDownload(
        String(input.ref ?? ""),
        input.timeoutMs,
        input.sessionId ?? contextSessionId ?? sessionId(),
        input.tabId ?? contextTabId,
      );
    },
    evaluate: async (
      input: string | { expression?: string; sessionId?: string; tabId?: string },
    ) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const expression = typeof input === "string" ? input : String(input?.expression ?? "");
      const explicit = typeof input === "string" ? undefined : input;
      audit?.({
        pluginId,
        api: "browser.evaluate",
        ok: true,
        ts: Date.now(),
      });
      return services.browser.evaluate(expression, explicit?.sessionId ?? contextSessionId ?? sessionId(), explicit?.tabId ?? contextTabId);
    },
    lock: () => {
      assertCdp();
      lockForAgent(sessionId() ?? contextSessionId);
      return { locked: true };
    },
    unlock: () => {
      assertCdp();
      unlockForAgent(sessionId() ?? contextSessionId);
      return { locked: false };
    },
    screenshotState: () =>
      services.browser?.screenshotState(
        sessionId() ?? contextSessionId,
        contextTabId,
      ) ?? null,
    connectBackend: async (
      input: {
        kind?: string;
        endpoint?: string;
        tabId?: string;
        url?: string;
        sessionId?: string;
        launch?: boolean;
        chromePath?: string;
        userDataDir?: string;
        headless?: boolean;
        chromeArgs?: string[];
      } = {},
    ) => {
      assertCdp();
      if (!services.browser?.connectBackend) {
        throw apiError("UNAVAILABLE", "browser backend api missing");
      }
      return services.browser.connectBackend(
        input,
        input.sessionId ?? sessionId() ?? contextSessionId,
      );
    },
    disconnectBackend: (input: { sessionId?: string } = {}) => {
      assertCdp();
      if (!services.browser?.disconnectBackend) {
        throw apiError("UNAVAILABLE", "browser backend api missing");
      }
      return services.browser.disconnectBackend(
        input.sessionId ?? sessionId() ?? contextSessionId,
      );
    },
    backendHealth: (input: { sessionId?: string } = {}) => {
      assertCdp();
      return services.browser?.backendHealth?.(
        input.sessionId ?? sessionId() ?? contextSessionId,
      ) ?? null;
    },
    backendState: (input: { sessionId?: string } = {}) => {
      assertCdp();
      return services.browser?.backendState?.(
        input.sessionId ?? sessionId() ?? contextSessionId,
      ) ?? null;
    },
    tabs: async (input: { action: string; tabId?: string; url?: string; headless?: boolean; urls?: string[]; contentType?: "html" | "text" | "domSnapshot"; timeoutMs?: number }) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const sid = sessionId() ?? contextSessionId;
      const result = await services.browser.tabs(input as never, sid);
      if (sid && options.sessions) {
        if (input.action === "new") {
          const tabId = String((result as { tabId?: unknown } | null)?.tabId ?? "");
          if (tabId) options.sessions.tabOpened(sid, tabId, input.headless === true);
        } else if (input.action === "close") {
          options.sessions.tabClosed(sid, String(input.tabId ?? ""));
        }
      }
      return result;
    },
    input: (
      input: string | { method?: string; params?: unknown; sessionId?: string; tabId?: string },
      paramsArg?: unknown,
    ) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const method = typeof input === "string" ? input : String(input?.method ?? "");
      const params = typeof input === "string" ? paramsArg : input?.params;
      return services.browser.input(
        method,
        params,
        (typeof input === "object" ? input.sessionId : undefined) ??
          sessionId() ??
          contextSessionId,
        (typeof input === "object" ? input.tabId : undefined) ?? contextTabId,
      );
    },
    console: (input?: number | { limit?: number }) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const limit = typeof input === "number" ? input : input?.limit;
      return services.browser.console(limit, sessionId() ?? contextSessionId, contextTabId);
    },
    cdp: async (
      input: string | { method?: string; params?: unknown; sessionId?: string; tabId?: string },
      paramsArg?: unknown,
    ) => {
      assertCdp();
      if (!services.browser) {
        throw apiError("UNAVAILABLE", "browser host missing");
      }
      const method = typeof input === "string" ? input : String(input?.method ?? "");
      const params = typeof input === "string" ? paramsArg : input?.params;
      audit?.({
        pluginId,
        api: "browser.cdp",
        ok: true,
        ts: Date.now(),
        method,
      });
      return services.browser.cdp(
        method,
        params,
        (typeof input === "object" ? input.sessionId : undefined) ??
          sessionId() ??
          contextSessionId,
        (typeof input === "object" ? input.tabId : undefined) ?? contextTabId,
      );
    },
    catalog: async () => {
      if (!options.sessions) return [{ id: "embedded", type: "iab", name: "In-app browser" }];
      return options.sessions.catalog();
    },
    chromeSettings: async () => {
      if (!services.browser?.chromeSettings) return null;
      return await services.browser.chromeSettings();
    },
    getJsDialog: async (input: { tabId?: string; sessionId?: string } = {}) => {
      const route = sessionRoute(input.sessionId);
      if (route) return await route.session.getJsDialog(route.tabId);
      if (!services.browser?.getJsDialog) return null;
      return await services.browser.getJsDialog(sessionId() ?? contextSessionId, input.tabId ?? contextTabId);
    },
    capabilities: async (input: { tabId?: string } = {}) => {
      assertCdp();
      const sid = sessionId() ?? contextSessionId;
      if (!sid || !options.sessions) throw apiError("UNAVAILABLE", "browser session registry missing");
      const session = options.sessions.get(sid);
      if (input.tabId) return (await session.tabs.get(String(input.tabId))).capabilities.describe();
      return session.capabilities.describe();
    },
    capability: async (input: { id?: string; action?: string; value?: unknown; tabId?: string } = {}) => {
      assertCdp();
      const sid = sessionId() ?? contextSessionId;
      if (!sid || !options.sessions) throw apiError("UNAVAILABLE", "browser session registry missing");
      const id = String(input.id ?? "").trim();
      if (!id) throw apiError("INVALID_ARGUMENT", "browser capability id is required");
      const session = options.sessions.get(sid);
      const collection = input.tabId
        ? (await session.tabs.get(String(input.tabId))).capabilities
        : session.capabilities;
      const capability = await collection.get(id) as Record<string, unknown> | null;
      const action = String(input.action ?? "describe");
      if (action === "get") {
        const getter = capability?.get;
        if (typeof getter !== "function") throw apiError("UNSUPPORTED", `capability ${id} has no getter`);
        return getter.call(capability);
      }
      if (action === "set") {
        const setter = capability?.set;
        if (typeof setter !== "function") throw apiError("UNSUPPORTED", `capability ${id} has no setter`);
        await setter.call(capability, input.value);
        return { ok: true, id };
      }
      return {
        id,
        methods: capability
          ? Object.keys(capability).filter((key) => typeof capability[key] === "function")
          : [],
      };
    },
    markTab: async (input: { tabId?: string; mark?: string } = {}) => {
      assertCdp();
      const sid = sessionId() ?? contextSessionId;
      if (!sid || !options.sessions) throw apiError("UNAVAILABLE", "browser session registry missing");
      const tabId = String(input.tabId ?? "").trim();
      const mark = String(input.mark ?? "");
      if (!tabId) throw apiError("INVALID_ARGUMENT", "markTab requires a tab id");
      if (mark !== "deliverable" && mark !== "handoff") {
        throw apiError("INVALID_ARGUMENT", "mark must be deliverable or handoff");
      }
      options.sessions.get(sid).markTab(tabId, mark as TabMark);
      return { ok: true, tabId, mark };
    },
    sessionState: () => {
      assertCdp();
      const sid = sessionId() ?? contextSessionId;
      if (!sid || !options.sessions) throw apiError("UNAVAILABLE", "browser session registry missing");
      return options.sessions.state(sid);
    },
    claimTab: async (input: { tabId?: string } = {}) => {
      assertCdp();
      const sid = sessionId() ?? contextSessionId;
      if (!sid || !options.sessions) throw apiError("UNAVAILABLE", "browser session registry missing");
      const handle = await options.sessions.get(sid).user.claimTab(String(input.tabId ?? ""));
      return { ok: true, tabId: handle.id };
    },
    releaseTab: () => {
      assertCdp();
      const sid = sessionId() ?? contextSessionId;
      if (!sid || !options.sessions) throw apiError("UNAVAILABLE", "browser session registry missing");
      options.sessions.release(sid);
      return { ok: true };
    },
  };
}
