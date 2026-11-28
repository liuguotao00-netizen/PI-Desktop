import type { BrowserHost } from "../browser-host";
import type { BrowserRouter } from "./router";

/**
 * The plugin-facing browser service. It owns capability checks and translates
 * the uniform pi.browser methods onto the session's effective backend.
 */
export type BrowserService = {
    reveal: (sessionId?: string) => Promise<void>;
    navigate: (
      input: { url?: string; path?: string },
      sessionId?: string,
      tabId?: string,
    ) => Promise<unknown>;
    evaluateNative: (
      input: { expression?: string },
      sessionId?: string,
      tabId?: string,
    ) => Promise<unknown>;
    evaluateIsolated: (
      input: { expression?: string },
      sessionId?: string,
      tabId?: string,
    ) => Promise<unknown>;
    inputEvent: (event: unknown, sessionId?: string, tabId?: string) => unknown;
    insertText: (text: string, sessionId?: string, tabId?: string) => unknown;
    handleDialog: (
      input: { accept?: boolean; promptText?: string },
      sessionId?: string,
      tabId?: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    consoleLogs: (input: { limit?: number }, sessionId?: string, tabId?: string) => unknown;
    networkRequests: (input: { limit?: number }, sessionId?: string, tabId?: string) => unknown;
    waitForNetworkIdle: (
      input: { timeoutMs?: number; idleMs?: number },
      sessionId?: string,
      tabId?: string,
    ) => Promise<unknown>;
    waitForDownload: (
      timeoutMs: number | undefined,
      sessionId?: string,
      tabId?: string,
    ) => Promise<unknown>;
    downloads: (sessionId?: string, tabId?: string) => unknown;
    cancelDownload: (id: string, sessionId?: string, tabId?: string) => boolean;
    action: (action: "back" | "forward" | "reload" | "stop", sessionId?: string, tabId?: string) => void;
    setBounds: (pluginId: string, hole: unknown) => unknown;
    setVisible: (pluginId: string, visible: boolean) => void;
    getState: (sessionId?: string, tabId?: string) => unknown;
    openExternal: (sessionId?: string, tabId?: string) => void;
    snapshot: (sessionId?: string, tabId?: string) => Promise<unknown>;
    history: (sessionId?: string, tabId?: string) => Promise<unknown>;
    screenshot: (
      input?: { fullPage?: boolean; format?: "jpeg" | "png"; clip?: { x: number; y: number; width: number; height: number } },
      sessionId?: string,
      tabId?: string,
    ) => Promise<unknown>;
    getJsDialog?: (sessionId?: string, tabId?: string) => Promise<unknown>;
    chromeSettings?: () => Promise<{
      showFullUrl?: boolean;
      bookmarksBarVisibility?: string;
      extensionsToolbarVisible?: boolean;
      deviceToolbarVisible?: boolean;
      linkTarget?: string;
      externalLinkShortcut?: string;
    } | null>;
    click: (uid: string, sessionId?: string, tabId?: string) => Promise<void>;
    fill: (uid: string, text: string, sessionId?: string, tabId?: string) => Promise<void>;
    uploadFiles: (selector: string, files: string[], sessionId?: string, tabId?: string) => Promise<unknown>;
    waitForFileChooser: (timeoutMs: number | undefined, sessionId?: string, tabId?: string) => Promise<unknown>;
    setFileChooserFiles: (files: string[], sessionId?: string, tabId?: string) => Promise<unknown>;
    cancelFileChooser: (sessionId?: string, tabId?: string) => Promise<unknown>;
    downloadUrl: (url: string, filename?: string, sessionId?: string, tabId?: string) => Promise<unknown>;
    clickAndWaitForDownload: (ref: string, timeoutMs?: number, sessionId?: string, tabId?: string) => Promise<unknown>;
    crossOriginFrame: (input: Record<string, unknown>, sessionId?: string, tabId?: string) => Promise<unknown>;
    locator: (input: Record<string, unknown>, sessionId?: string, tabId?: string) => Promise<unknown>;
    evaluate: (expression: string, sessionId?: string, tabId?: string) => Promise<unknown>;
    console: (limit?: number, sessionId?: string, tabId?: string) => unknown;
    cdp: (method: string, params?: unknown, sessionId?: string, tabId?: string) => Promise<unknown>;
    input: (method: string, params?: unknown, sessionId?: string, tabId?: string) => Promise<unknown>;
    tabs: (input: { action: string; tabId?: string; url?: string; headless?: boolean; urls?: string[]; contentType?: "html" | "text" | "domSnapshot"; timeoutMs?: number }, sessionId?: string) => Promise<unknown>;
    screenshotState: (sessionId?: string, tabId?: string) => unknown;
    connectBackend?: (
      input: {
        kind?: string;
        endpoint?: string;
        tabId?: string;
        url?: string;
        launch?: boolean;
        chromePath?: string;
        userDataDir?: string;
        headless?: boolean;
        chromeArgs?: string[];
      },
      sessionId?: string,
    ) => Promise<unknown>;
    disconnectBackend?: (sessionId?: string) => unknown;
    backendState?: (sessionId?: string) => unknown;
    backendHealth?: (sessionId?: string) => Promise<unknown>;
};

export function createBrowserService(host: BrowserHost, router: BrowserRouter): BrowserService {
  const externalPage = (sessionId?: string) => router.externalPage(sessionId);
  const effectivePage = (sessionId?: string, tabId?: string) => router.pageFor(sessionId, tabId);
  const requireCapability = (sessionId: string | undefined, capability: string) =>
    router.requireCapability(sessionId, capability as never);
  return {
  reveal: async (sessionId) => {
    if (router.binding(sessionId)) return;
    return host.reveal(sessionId);
  },
  navigate: async (input, sessionId, tabId) => {
    requireCapability(sessionId, "navigate");
    const target = String(input.path ?? input.url ?? "").trim();
    const page = effectivePage(sessionId, tabId);
    const state = target ? await page.goto(target) : null;
    return state ?? { url: target, title: "", isLoading: false, canGoBack: false, canGoForward: false };
  },
  evaluateNative: async (input, sessionId, tabId) => {
    requireCapability(sessionId, "evaluate");
    const page = effectivePage(sessionId, tabId);
    return page.evaluateNative ? page.evaluateNative(input.expression ?? "") : page.evaluate(input.expression ?? "");
  },
  evaluateIsolated: async (input, sessionId, tabId) => {
    requireCapability(sessionId, "evaluate");
    const page = effectivePage(sessionId, tabId);
    return page.evaluateIsolated ? page.evaluateIsolated(input.expression ?? "") : page.evaluate(input.expression ?? "");
  },
  inputEvent: async (event, sessionId, tabId) => {
    requireCapability(sessionId, "input");
    return effectivePage(sessionId, tabId).input(event);
  },
  insertText: async (text, sessionId, tabId) => {
    requireCapability(sessionId, "input");
    return effectivePage(sessionId, tabId).input({ type: "insertText", text });
  },
  handleDialog: async (input, sessionId, tabId) => {
    const page = effectivePage(sessionId, tabId);
    if (!page.handleDialog) throw new Error(`backend ${router.backendFor(sessionId).kind} does not support dialogs`);
    return page.handleDialog(input);
  },
  downloads: (sessionId) => ({ entries: host.listDownloads(sessionId) }),
  cancelDownload: (id, sessionId, tabId) => host.cancelDownload(id, sessionId, tabId),
  waitForNetworkIdle: async (input, sessionId, tabId) => {
    const page = effectivePage(sessionId, tabId);
    if (!page.waitForNetworkIdle) {
      throw Object.assign(new Error("network idle is unavailable for this backend"), { code: "UNSUPPORTED" });
    }
    await page.waitForNetworkIdle(input?.timeoutMs, input?.idleMs);
    return { ok: true };
  },
  consoleLogs: async (input, sessionId, tabId) => {
    const page = effectivePage(sessionId, tabId);
    if (!page.consoleLogs) throw new Error(`backend ${router.backendFor(sessionId).kind} does not expose console logs`);
    return page.consoleLogs(Number(input?.limit) || 100);
  },
  networkRequests: async (input, sessionId, tabId) => {
    const page = effectivePage(sessionId, tabId);
    if (!page.networkRequests) throw new Error(`backend ${router.backendFor(sessionId).kind} does not expose network requests`);
    return page.networkRequests(Number(input?.limit) || 100);
  },
  action: (action, sessionId, tabId) => host.action(action, sessionId, tabId),
  setBounds: (pluginId, hole) => host.setGuestHole(pluginId, hole),
  setVisible: (pluginId, visible) => host.setGuestVisible(pluginId, visible),
  getState: (sessionId, tabId) => host.getStateForPlugin(sessionId, tabId),
  openExternal: (sessionId, tabId) => host.openExternal(sessionId, tabId),
  snapshot: async (sessionId, tabId) => {
    requireCapability(sessionId, "snapshot");
    return effectivePage(sessionId, tabId).snapshot();
  },
  history: async (sessionId, tabId) => {
    const page = effectivePage(sessionId, tabId);
    if (page.history) return page.history();
    const current = await page.snapshot();
    return { index: 0, entries: [{ index: 0, url: current.url, title: current.title }] };
  },
  screenshot: async (input, sessionId, tabId) => {
    requireCapability(sessionId, "screenshot");
    return effectivePage(sessionId, tabId).screenshot(input);
  },
  click: async (uid, sessionId, tabId) => {
    requireCapability(sessionId, "click");
    return effectivePage(sessionId, tabId).click(uid);
  },
  fill: async (uid, text, sessionId, tabId) => {
    requireCapability(sessionId, "fill");
    return effectivePage(sessionId, tabId).fill(uid, text);
  },
  waitForFileChooser: async (timeoutMs, sessionId, tabId) => {
    requireCapability(sessionId, "upload");
    const page = effectivePage(sessionId, tabId);
    if (page.waitForFileChooser) return page.waitForFileChooser(Number(timeoutMs) || 15_000);
    return host.waitForFileChooser(sessionId, tabId, Number(timeoutMs) || 15_000);
  },
  cancelFileChooser: async (sessionId, tabId) => {
    const page = effectivePage(sessionId, tabId);
    if (!page.cancelFileChooser) {
      throw Object.assign(new Error("file chooser cancel is unavailable for this backend"), { code: "UNSUPPORTED" });
    }
    await page.cancelFileChooser();
    return { ok: true };
  },
  setFileChooserFiles: async (files, sessionId, tabId) => {
    requireCapability(sessionId, "upload");
    const normalized = await host.authorizeUploadFiles(files, sessionId);
    const page = effectivePage(sessionId, tabId);
    if (page.setFileChooserFiles) {
      await page.setFileChooserFiles(normalized);
      return { ok: true, files: normalized };
    }
    return host.setFileChooserFiles(normalized, sessionId, tabId);
  },
  uploadFiles: async (selector, files, sessionId, tabId) => {
    requireCapability(sessionId, "upload");
    const normalized = await host.authorizeUploadFiles(files, sessionId);
    await effectivePage(sessionId, tabId).uploadFiles(selector, normalized);
    return { ok: true, files: normalized };
  },
  downloadUrl: async (url, filename, sessionId, tabId) => {
    requireCapability(sessionId, "download");
    return effectivePage(sessionId, tabId).download(url, filename);
  },
  waitForDownload: async (timeoutMs, sessionId, tabId) => {
    requireCapability(sessionId, "download");
    const page = effectivePage(sessionId, tabId);
    if (!page.waitForDownload) {
      throw Object.assign(new Error("this browser backend cannot wait for downloads"), { code: "UNSUPPORTED" });
    }
    return page.waitForDownload(timeoutMs);
  },
  getJsDialog: async (sessionId, tabId) => {
    const page = effectivePage(sessionId, tabId);
    if (!page.getJsDialog) return null;
    return await page.getJsDialog();
  },
  locator: async (input, sessionId, tabId) => {
    requireCapability(sessionId, "locator");
    const page = effectivePage(sessionId, tabId);
    return page.locator(input as never);
  },
  crossOriginFrame: async (input, sessionId, tabId) => {
    const frameInput = input as {
      action: "list" | "text" | "html" | "click" | "fill";
      frameId?: string;
      url?: string;
      targetSelector?: string;
      value?: string;
      limit?: number;
    };
    const page = effectivePage(sessionId, tabId);
    if (page.crossOriginFrame) return page.crossOriginFrame(frameInput);
    return host.crossOriginFrame(frameInput, sessionId, tabId);
  },
  clickAndWaitForDownload: async (ref, timeoutMs, sessionId, tabId) => {
    requireCapability(sessionId, "download");
    const page = effectivePage(sessionId, tabId);
    if (!page.clickAndWaitForDownload) throw new Error("this backend does not support download events");
    return page.clickAndWaitForDownload(ref, Number(timeoutMs) || undefined);
  },
  evaluate: async (expression, sessionId, tabId) => {
    requireCapability(sessionId, "evaluate");
    return effectivePage(sessionId, tabId).evaluate(expression);
  },
  console: (limit, sessionId, tabId) => host.console(limit, sessionId, tabId),
  cdp: (method, params, sessionId, tabId) => {
    if (externalPage(sessionId)) throw new Error("external backend does not expose raw CDP through pi.browser");
    return host.cdpCommand(method, params, sessionId, tabId);
  },
  input: (method, params, sessionId, tabId) => {
    if (externalPage(sessionId)) throw new Error("external backend does not expose raw Input.* through pi.browser");
    return host.inputCommand(method, params, sessionId, tabId);
  },
  screenshotState: (sessionId, tabId) => host.screenshotState(sessionId, tabId),
  connectBackend: (input, sessionId) => router.connect(input ?? {}, sessionId),
  disconnectBackend: (sessionId) => router.disconnect(sessionId),
  backendState: (sessionId) => router.state(sessionId),
  backendHealth: (sessionId) => router.health(sessionId),
  tabs: async (input, sessionId) => {
    const action = String(input?.action ?? "");
    const id = String(sessionId || "");
    if (!id) throw new Error("browser_tabs requires a session");
    const backend = router.backendFor(id);
    const binding = router.binding(id);
    if (action === "list") {
      const tabs = await backend.listTabs();
      return {
        tabs: tabs.filter((tab) => !tab.headless).map((tab) => ({
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          active: tab.id === (binding?.tabId ?? tabs.find((item) => item.active)?.id),
          ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
          ...(tab.groupId !== undefined ? { groupId: tab.groupId } : {}),
          ...(tab.providerTabId ? { providerTabId: tab.providerTabId } : {}),
        })),
        headlessTabs: tabs.filter((tab) => tab.headless).map((tab) => ({ tabId: tab.id, url: tab.url, title: tab.title, ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}) })),
        activeTabId: binding?.tabId ?? tabs.find((tab) => tab.active)?.id ?? null,
        backend: backend.kind,
      };
    }
    if (action === "new") {
      const opened = await backend.openTab(String(input?.url || "about:blank"), {
        headless: input?.headless === true,
      });
      if (binding && input?.headless !== true) {
        await backend.attach(opened.id);
        router.setTab(id, opened.id);
      }
      return { ok: true, tabId: opened.id, url: opened.url, title: opened.title };
    }
    if (action === "content") {
      const urls = (Array.isArray(input?.urls) ? input.urls : []).map((url) => String(url)).filter(Boolean);
      const contentType = input?.contentType === "html" || input?.contentType === "domSnapshot" ? "html" : "text";
      const timeoutMs = Math.max(1_000, Math.min(60_000, Number(input?.timeoutMs) || 15_000));
      const results: Array<{ url: string; title: string; content: string }> = [];
      for (const url of urls) {
        const opened = await backend.openTab(url, { headless: true });
        try {
          const page = backend.page(opened.id);
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const ready = String(await page.evaluate("document.readyState").catch(() => "") ?? "");
            if (ready === "complete" || ready === "interactive") break;
            if (Date.now() >= deadline) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const [text, html, title] = await Promise.all([
            page.evaluate("document.body ? document.body.innerText : ''").catch(() => ""),
            page.evaluate("document.documentElement ? document.documentElement.outerHTML : ''").catch(() => ""),
            page.evaluate("document.title").catch(() => ""),
          ]);
          results.push({
            url,
            title: String(title ?? ""),
            content: String(contentType === "html" ? html : text) ?? "",
          });
        } catch (error) {
          results.push({ url, title: "", content: `ERROR: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
          await backend.closeTab(opened.id).catch(() => undefined);
        }
      }
      return { ok: true, action, results };
    }
    if (action === "select" || action === "show") {
      const tabId = String(input?.tabId || "");
      if (action === "show" && backend.showTab) await backend.showTab(tabId);
      else await backend.attach(tabId);
      if (binding) router.setTab(id, tabId);
      return { ok: true, tabId };
    }
    if (action === "close") {
      const listed = await backend.listTabs();
      const tabId = String(input?.tabId || binding?.tabId || listed.find((tab) => tab.active)?.id || listed[0]?.id || "");
      if (tabId) await backend.closeTab(tabId);
      if (binding) {
        const remaining = await backend.listTabs();
        if (remaining[0]) router.setTab(id, remaining[0].id);
        else router.disconnect(id);
      }
      return { ok: true };
    }
    throw new Error(`unknown tabs action: ${action}`);
  },
};
}
