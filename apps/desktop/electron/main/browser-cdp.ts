import { nativeImage, type WebContents } from "electron";

/** Chrome DevTools Protocol revision attached to the work-panel guest. */
export const BROWSER_CDP_PROTOCOL = "1.3";

/**
 * Deny-by-default CDP methods the public `pi.browser.cdp` API may send.
 * Cookie, storage, target, and network-interception methods stay off this list.
 */
export const BROWSER_CDP_ALLOWLIST = new Set([
  "Page.enable",
  "Page.reload",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.bringToFront",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getBoxModel",
  "DOM.describeNode",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.getOuterHTML",
  "DOM.getAttributes",
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.getProperties",
  "Runtime.awaitPromise",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "Console.enable",
]);

const MAX_EVALUATE_CHARS = 64 * 1024;
const MAX_CONSOLE_MESSAGES = 100;
const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_MAX_HEIGHT = 2048;

export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: number;
};

export type AxNode = {
  nodeId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
  childIds?: string[];
};

export type SnapshotResult = {
  tree: string;
  url: string;
  title: string;
};

export function isAllowedCdpMethod(method: string): boolean {
  return BROWSER_CDP_ALLOWLIST.has(method.trim());
}

/**
 * Flatten an accessibility tree into indented text with stable `eN` uids.
 * Ignored nodes are skipped; uids map to backend DOM node ids for click/fill.
 */
export function flattenAxTree(nodes: AxNode[]): {
  tree: string;
  uids: Map<string, number>;
} {
  const byId = new Map<string, AxNode>();
  for (const node of nodes) {
    if (typeof node.nodeId === "string") byId.set(node.nodeId, node);
  }
  const childIds = new Set<string>();
  for (const node of nodes) {
    for (const id of node.childIds ?? []) childIds.add(id);
  }
  const roots = nodes.filter(
    (node) => typeof node.nodeId === "string" && !childIds.has(node.nodeId),
  );
  const uids = new Map<string, number>();
  const lines: string[] = [];
  let next = 1;

  const walk = (node: AxNode, depth: number) => {
    if (!node.ignored) {
      const role = node.role?.value?.trim() || "Generic";
      const name = node.name?.value?.trim() ?? "";
      const uid = `e${next}`;
      next += 1;
      if (typeof node.backendDOMNodeId === "number") {
        uids.set(uid, node.backendDOMNodeId);
      }
      const label = name ? `${role} ${JSON.stringify(name)}` : role;
      lines.push(`${"  ".repeat(depth)}- ${uid} ${label}`);
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, node.ignored ? depth : depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return { tree: lines.join("\n") || "(empty)", uids };
}

function consoleText(args: unknown): string {
  if (!Array.isArray(args)) return String(args ?? "");
  return args
    .map((arg) => {
      if (!arg || typeof arg !== "object") return String(arg);
      const record = arg as { value?: unknown; description?: string; type?: string };
      if (typeof record.value === "string") return record.value;
      if (record.value !== undefined) return String(record.value);
      if (typeof record.description === "string") return record.description;
      return record.type ?? "";
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * CDP session bound to one guest WebContents. Re-attaches when the view is
 * recreated. Snapshot uids are valid only until the next snapshot.
 */
export class BrowserCdp {
  private attachedId: number | null = null;
  private uids = new Map<string, number>();
  private readonly domains = new Set<string>();
  private messages: BrowserConsoleMessage[] = [];
  private inFlightNetwork = new Set<string>();
  private lastNetworkActivity = Date.now();
  private chooser: { backendNodeId: number; mode: string } | null = null;
  private chooserWaiters: Array<{
    resolve: (value: { backendNodeId: number; mode: string }) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private onDebuggerMessage?: (
    event: unknown,
    method: string,
    params: unknown,
  ) => void;

  isAttached(wc: WebContents): boolean {
    return this.attachedId === wc.id && !wc.isDestroyed() && wc.debugger.isAttached();
  }

  async attach(wc: WebContents): Promise<void> {
    if (wc.isDestroyed()) {
      throw new Error("browser guest is not available");
    }
    if (this.isAttached(wc)) return;
    this.detach();
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach(BROWSER_CDP_PROTOCOL);
    }
    this.attachedId = wc.id;
    this.onDebuggerMessage = (_event, method, params) => {
      const payload = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      if (method === "Network.requestWillBeSent") {
        const id = String(payload.requestId ?? "");
        if (id) this.inFlightNetwork.add(id);
        this.lastNetworkActivity = Date.now();
        return;
      }
      if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        this.inFlightNetwork.delete(String(payload.requestId ?? ""));
        this.lastNetworkActivity = Date.now();
        return;
      }
      if (method === "Page.fileChooserOpened") {
        const backendNodeId = Number(payload.backendNodeId);
        if (Number.isFinite(backendNodeId)) {
          this.chooser = { backendNodeId, mode: String(payload.mode ?? "selectSingle") };
          const waiters = this.chooserWaiters.splice(0);
          for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(this.chooser);
          }
        }
        return;
      }
      if (method !== "Runtime.consoleAPICalled" && method !== "Console.messageAdded") {
        return;
      }
      const record = payload;
      const type =
        typeof record.type === "string"
          ? record.type
          : typeof (record.message as { level?: string } | undefined)?.level === "string"
            ? (record.message as { level: string }).level
            : "log";
      const text =
        method === "Console.messageAdded"
          ? String((record.message as { text?: string } | undefined)?.text ?? "")
          : consoleText(record.args);
      this.messages.push({ type, text, timestamp: Date.now() });
      if (this.messages.length > MAX_CONSOLE_MESSAGES) this.messages.shift();
    };
    wc.debugger.on("message", this.onDebuggerMessage);
    // Domains are enabled lazily per operation. Attaching alone is far less
    // visible than turning on Runtime/Console/Accessibility for every page.
  }

  private async ensureDomain(wc: WebContents, domain: string): Promise<void> {
    if (this.domains.has(domain)) return;
    await wc.debugger.sendCommand(`${domain}.enable`);
    this.domains.add(domain);
  }

  detach(wc?: WebContents): void {
    const target = wc && !wc.isDestroyed() ? wc : null;
    if (target?.debugger.isAttached()) {
      if (this.onDebuggerMessage) {
        target.debugger.off("message", this.onDebuggerMessage);
      }
      try {
        target.debugger.detach();
      } catch {
        // Already detached.
      }
    }
    this.onDebuggerMessage = undefined;
    this.chooser = null;
    for (const waiter of this.chooserWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error("file chooser was interrupted"), { code: "ABORTED" }));
    }
    this.attachedId = null;
    this.inFlightNetwork.clear();
    this.domains.clear();
    this.uids.clear();
  }

  /**
   * Raw CDP for the agent-facing tool: Cursor's split. Everything except
   * `Input.*` is allowed; input goes through `sendInput` so focus-sensitive
   * events cannot be dispatched by an arbitrary tool call.
   */
  async send(wc: WebContents, method: string, params?: unknown): Promise<unknown> {
    const name = String(method || "").trim();
    if (!name) throw Object.assign(new Error("CDP method required"), { code: "INVALID_ARGUMENT" });
    if (/^Input\./i.test(name)) {
      throw Object.assign(
        new Error(`CDP ${name} is denied; use the browser input tools`),
        { code: "PERMISSION_DENIED" },
      );
    }
    // Credential-grade surfaces stay closed even though Cursor leaves them
    // reachable: a plugin already has net.fetch, but reading the cookie jar or
    // intercepting requests is a different grant.
    if (/^(Cookie|Storage|Target|Fetch)\./i.test(name)) {
      throw Object.assign(new Error(`CDP ${name} is denied`), { code: "PERMISSION_DENIED" });
    }
    await this.attach(wc);
    return wc.debugger.sendCommand(
      name,
      (params && typeof params === "object" ? params : {}) as Record<string, unknown>,
    );
  }

  async waitForNetworkIdle(wc: WebContents, timeoutMs = 15_000, idleMs = 500): Promise<void> {
    await this.attach(wc);
    await this.ensureDomain(wc, "Network");
    const deadline = Date.now() + Math.max(100, timeoutMs);
    while (Date.now() < deadline) {
      if (this.inFlightNetwork.size === 0 && Date.now() - this.lastNetworkActivity >= idleMs) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Object.assign(new Error("network did not become idle"), { code: "TIMEOUT" });
  }

  /** Trusted input channel used by click/type/drag/hover tools. */
  async sendInput(wc: WebContents, method: string, params?: unknown): Promise<unknown> {
    const name = String(method || "").trim();
    if (!/^Input\./.test(name)) {
      throw Object.assign(new Error(`not an Input method: ${name}`), { code: "INVALID_ARGUMENT" });
    }
    await this.attach(wc);
    return wc.debugger.sendCommand(
      name,
      (params && typeof params === "object" ? params : {}) as Record<string, unknown>,
    );
  }

  async snapshot(wc: WebContents): Promise<SnapshotResult> {
    await this.attach(wc);
    await this.ensureDomain(wc, "Accessibility");
    const raw = (await wc.debugger.sendCommand("Accessibility.getFullAXTree")) as {
      nodes?: AxNode[];
    };
    const flattened = flattenAxTree(Array.isArray(raw?.nodes) ? raw.nodes : []);
    this.uids = flattened.uids;
    return {
      tree: flattened.tree,
      url: wc.getURL(),
      title: wc.getTitle(),
    };
  }

  async screenshot(
    wc: WebContents,
    input: { fullPage?: boolean; format?: "jpeg" | "png"; clip?: { x: number; y: number; width: number; height: number } } = {},
  ): Promise<{ mimeType: string; data: string; width: number; height: number; resized: boolean }> {
    await this.attach(wc);
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (input.clip) {
      clip = {
        x: Math.max(0, Math.round(input.clip.x)),
        y: Math.max(0, Math.round(input.clip.y)),
        width: Math.max(1, Math.round(input.clip.width)),
        height: Math.max(1, Math.round(input.clip.height)),
        scale: 1,
      };
    } else if (input.fullPage) {
      const metrics = (await wc.debugger.sendCommand("Page.getLayoutMetrics")) as {
        contentSize?: { width?: number; height?: number };
        cssContentSize?: { width?: number; height?: number };
      };
      const size = metrics.cssContentSize ?? metrics.contentSize ?? { width: 0, height: 0 };
      const width = Math.max(1, Number(size.width) || 1);
      const height = Math.max(1, Number(size.height) || 1);
      const scale = Math.min(
        1,
        SCREENSHOT_MAX_WIDTH / width,
        SCREENSHOT_MAX_HEIGHT / height,
      );
      clip = { x: 0, y: 0, width, height, scale };
    }
    const format = input.format === "png" ? "png" : "jpeg";
    const result = (await wc.debugger.sendCommand("Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality: 70 } : {}),
      ...(clip ? { clip, captureBeyondViewport: true } : {}),
    })) as { data?: string };
    if (typeof result?.data !== "string" || !result.data) {
      throw new Error("screenshot produced no data");
    }
    return encodeScreenshot(result.data);
  }

  async click(wc: WebContents, uid: string): Promise<void> {
    const backendNodeId = this.requireUid(uid);
    await this.attach(wc);
    await this.ensureDomain(wc, "Runtime");
    await this.ensureDomain(wc, "DOM");
    await this.ensureDomain(wc, "Emulation");
    await wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false });
    await wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    const resolved = (await wc.debugger.sendCommand("DOM.resolveNode", { backendNodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) throw Object.assign(new Error(`could not resolve ${uid}`), { code: "NOT_FOUND" });
    // CDP box quads can include the detached native view's offscreen offset.
    // Resolve the actual element in its page viewport, then use trusted input.
    const evaluated = (await wc.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        const view = this.ownerDocument.defaultView;
        let rect = this.getBoundingClientRect();
        if (rect.left < 0 || rect.top < 0 || rect.right > view.innerWidth || rect.bottom > view.innerHeight) {
          this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        }
        return new Promise(resolve => view.requestAnimationFrame(() => view.requestAnimationFrame(() => {
          rect = this.getBoundingClientRect();
          const left = Math.max(0, rect.left), right = Math.min(view.innerWidth, rect.right);
          const top = Math.max(0, rect.top), bottom = Math.min(view.innerHeight, rect.bottom);
          resolve(right > left && bottom > top ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null);
        })));
      }`,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: { x?: number; y?: number } | null } };
    const point = evaluated.result?.value;
    if (typeof point?.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw Object.assign(new Error(`no visible box for ${uid}`), { code: "NOT_FOUND" });
    }
    const { x, y } = point;
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "none", buttons: 0,
    });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
      buttons: 0,
    });
  }

  async setFiles(wc: WebContents, selector: string, files: string[]): Promise<void> {
    const css = String(selector || "").trim();
    if (!css) throw Object.assign(new Error("file input selector required"), { code: "INVALID_ARGUMENT" });
    if (!files.length) throw Object.assign(new Error("at least one file is required"), { code: "INVALID_ARGUMENT" });
    await this.attach(wc);
    await this.ensureDomain(wc, "Runtime");
    await this.ensureDomain(wc, "DOM");
    const resolved = (await wc.debugger.sendCommand("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(css)})`,
      returnByValue: false,
    })) as { result?: { objectId?: string }; exceptionDetails?: { text?: string } };
    const objectId = resolved.result?.objectId;
    if (!objectId) {
      throw Object.assign(new Error(resolved.exceptionDetails?.text || `file input not found: ${css}`), { code: "NOT_FOUND" });
    }
    await wc.debugger.sendCommand("DOM.setFileInputFiles", { objectId, files });
  }

  async fill(wc: WebContents, uid: string, text: string): Promise<void> {
    const backendNodeId = this.requireUid(uid);
    await this.attach(wc);
    await this.ensureDomain(wc, "Runtime");
    await this.ensureDomain(wc, "DOM");
    const resolved = (await wc.debugger.sendCommand("DOM.resolveNode", { backendNodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw Object.assign(new Error(`could not resolve ${uid}`), { code: "NOT_FOUND" });
    }
    const ready = (await wc.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        if (this.disabled) return false;
        const style = getComputedStyle(this);
        if (style.visibility === "hidden" || style.display === "none") return false;
        this.scrollIntoView({ block: "center" });
        this.focus({ preventScroll: true });
        if (typeof this.select === "function") this.select();
        else if (this.isContentEditable) document.getSelection()?.selectAllChildren(this);
        return true;
      }`,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    if (ready.result?.value !== true) {
      throw Object.assign(new Error(`unknown, disabled or invisible uid "${uid}"`), { code: "NOT_FOUND" });
    }
    await this.sendInput(wc, "Input.insertText", { text });
  }

  async evaluate(wc: WebContents, expression: string): Promise<unknown> {
    await this.attach(wc);
    await this.ensureDomain(wc, "Runtime");
    const result = (await wc.debugger.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: unknown; description?: string; type?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      const message =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "evaluation failed";
      throw Object.assign(new Error(message), { code: "TOOL_FAILED" });
    }
    const value = result.result?.value ?? result.result?.description ?? null;
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length > MAX_EVALUATE_CHARS) {
      return {
        truncated: true,
        value: serialized.slice(0, MAX_EVALUATE_CHARS),
      };
    }
    return value;
  }

  console(limit = 50): BrowserConsoleMessage[] {
    const cap = Math.min(MAX_CONSOLE_MESSAGES, Math.max(1, Math.floor(limit) || 50));
    return this.messages.slice(-cap);
  }

  async crossOriginFrame(
    wc: WebContents,
    input: {
      action: "list" | "text" | "html" | "click" | "fill" | "count";
      frameId?: string;
      url?: string;
      targetSelector?: string;
      value?: string;
      limit?: number;
    },
  ): Promise<unknown> {
    await this.attach(wc);
    await this.ensureDomain(wc, "Page");
    const raw = (await wc.debugger.sendCommand("Page.getFrameTree")) as {
      frameTree?: { frame?: { id?: string; url?: string; name?: string }; childFrames?: Array<{ frame?: { id?: string; url?: string; name?: string }; childFrames?: unknown[] }> };
    };
    type Frame = { id: string; url: string; name: string };
    const frames: Frame[] = [];
    const walk = (node: { frame?: { id?: string; url?: string; name?: string }; childFrames?: Array<{ frame?: { id?: string; url?: string; name?: string }; childFrames?: unknown[] }> }) => {
      if (node.frame?.id) frames.push({ id: node.frame.id, url: node.frame.url || "", name: node.frame.name || "" });
      for (const child of node.childFrames ?? []) walk(child as typeof node);
    };
    if (raw.frameTree) walk(raw.frameTree);
    if (input.action === "list") return { ok: true, frames };
    const selected = frames.find((frame) => (input.frameId ? frame.id === input.frameId : input.url ? frame.url.includes(input.url) : false)) ?? frames.find((frame) => frame.id !== frames[0]?.id) ?? frames[0];
    if (!selected) return { ok: false, error: "no frame available", frames };
    const world = (await wc.debugger.sendCommand("Page.createIsolatedWorld", {
      frameId: selected.id,
      worldName: "pi-browser-frame",
    })) as { executionContextId?: number };
    if (typeof world.executionContextId !== "number") return { ok: false, error: "could not create frame context", frames };
    const contextId = world.executionContextId;
    const run = async (expression: string) => {
      const result = (await wc.debugger.sendCommand("Runtime.evaluate", {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "frame evaluation failed");
      return result.result?.value;
    };
    if (input.action === "text") {
      return { ok: true, frame: selected, text: String(await run("document.body ? document.body.innerText : ''") ?? "").slice(0, Math.max(200, Math.min(30000, input.limit || 8000))) };
    }
    if (input.action === "html") {
      return { ok: true, frame: selected, html: String(await run("document.documentElement ? document.documentElement.outerHTML : ''") ?? "").slice(0, Math.max(200, Math.min(30000, input.limit || 8000))) };
    }
    const selector = String(input.targetSelector || "");
    if (!selector) return { ok: false, error: "targetSelector required", frames };
    if (input.action === "fill") {
      const value = await run(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.focus({ preventScroll: true });
        if ('value' in el) { el.value = ${JSON.stringify(String(input.value ?? ""))}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
        else { el.textContent = ${JSON.stringify(String(input.value ?? ""))}; el.dispatchEvent(new Event('input', { bubbles: true })); }
        return String('value' in el ? el.value : el.textContent);
      })()`);
      if (value === null) return { ok: false, error: "frame target not found", frames };
      return { ok: true, frame: selected, value };
    }
    const point = (await run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`)) as { x?: number; y?: number } | null;
    if (!point || typeof point.x !== "number" || typeof point.y !== "number") return { ok: false, error: "frame target not found", frames };
    const owner = (await wc.debugger.sendCommand("DOM.getFrameOwner", { frameId: selected.id })) as { backendNodeId?: number };
    let origin = { x: 0, y: 0 };
    if (typeof owner.backendNodeId === "number") {
      try {
        const box = (await wc.debugger.sendCommand("DOM.getBoxModel", { backendNodeId: owner.backendNodeId })) as { model?: { border?: number[] } };
        const border = box.model?.border;
        if (border && border.length >= 2) origin = { x: border[0], y: border[1] };
      } catch {
        // Keep viewport coordinates.
      }
    }
    wc.sendInputEvent({ type: "mouseMove", x: Math.round(origin.x + point.x), y: Math.round(origin.y + point.y) });
    wc.sendInputEvent({ type: "mouseDown", x: Math.round(origin.x + point.x), y: Math.round(origin.y + point.y), button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: Math.round(origin.x + point.x), y: Math.round(origin.y + point.y), button: "left", clickCount: 1 });
    return { ok: true, frame: selected, x: Math.round(origin.x + point.x), y: Math.round(origin.y + point.y) };
  }

  /** Arm the CDP file chooser interception and wait for the next chooser. */
  async waitForFileChooser(wc: WebContents, timeoutMs = 15_000): Promise<{ backendNodeId: number; mode: string }> {
    await this.attach(wc);
    await this.ensureDomain(wc, "Page");
    await wc.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
    if (this.chooser) {
      const current = this.chooser;
      this.chooser = null;
      return current;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.chooserWaiters = this.chooserWaiters.filter((item) => item.timer !== timer);
        void wc.debugger
          .sendCommand("Page.setInterceptFileChooserDialog", { enabled: false })
          .catch(() => undefined);
        reject(Object.assign(new Error("file chooser did not open in time"), { code: "TIMEOUT" }));
      }, Math.max(1, timeoutMs));
      this.chooserWaiters.push({ resolve, reject, timer });
    });
  }

  async cancelFileChooser(wc: WebContents): Promise<void> {
    await this.attach(wc);
    await this.ensureDomain(wc, "DOM");
    if (this.chooser) {
      await wc.debugger.sendCommand("DOM.setFileInputFiles", {
        files: [],
        backendNodeId: this.chooser.backendNodeId,
      });
    }
    this.chooser = null;
    await wc.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false });
    for (const waiter of this.chooserWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error("file chooser cancelled"), { code: "ABORTED" }));
    }
  }

  async setFileChooserFiles(wc: WebContents, files: string[]): Promise<void> {
    await this.attach(wc);
    const chooser = this.chooser;
    if (!chooser) throw Object.assign(new Error("no file chooser is open"), { code: "NOT_FOUND" });
    await this.ensureDomain(wc, "DOM");
    await wc.debugger.sendCommand("DOM.setFileInputFiles", {
      files,
      backendNodeId: chooser.backendNodeId,
    });
    this.chooser = null;
    await wc.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false });
  }

  private requireUid(uid: string): number {
    const id = this.uids.get(uid.trim());
    if (typeof id !== "number") {
      throw Object.assign(
        new Error(`unknown or stale uid "${uid}"; call snapshot first`),
        { code: "INVALID_ARGUMENT" },
      );
    }
    return id;
  }
}

/** Keep screenshots inside the context budget Cursor uses (≈20 KB base64). */
function encodeScreenshot(data: string, format: "jpeg" | "png" = "jpeg"): {
  mimeType: string;
  data: string;
  width: number;
  height: number;
  resized: boolean;
} {
  const maxChars = format === "png" ? 200_000 : 20_000;
  const mimeType = format === "png" ? "image/png" : "image/jpeg";
  if (data.length <= maxChars) {
    const size = nativeImage.createFromBuffer(Buffer.from(data, "base64")).getSize();
    return { mimeType, data, width: size.width, height: size.height, resized: false };
  }
  let image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
  let out = data;
  let resized = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const size = image.getSize();
    const width = Math.max(1, Math.round(size.width * 0.8));
    const height = Math.max(1, Math.round(size.height * 0.8));
    image = image.resize({ width, height, quality: "good" });
    out = (format === "png" ? image.toPNG() : image.toJPEG(65)).toString("base64");
    resized = true;
    if (out.length <= maxChars) break;
  }
  const size = image.getSize();
  return { mimeType, data: out, width: size.width, height: size.height, resized };
}
