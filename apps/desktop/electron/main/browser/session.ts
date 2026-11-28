import type { BrowserService } from "./service.ts";
import type { BrowserCapability, LocatorQuery, SnapshotResult } from "./types.ts";
import type { TabLifecycle, TabMark } from "./lifecycle.ts";
import { PlaywrightTab } from "./locator-api.ts";

export type BrowserTabInfo = {
  id: string;
  title: string;
  url: string;
  active: boolean;
  windowId?: number;
  groupId?: number;
  providerTabId?: string;
};

const sessionVisits = new Map<string, Array<{ url: string; title: string; dateVisited: string }>>();
/** Last AX state per tab, for Codex-style diffing across snapshots. */
const axSnapshots = new Map<string, string>();

export type BrowserSessionDeps = {
  service: BrowserService;
  sessionId: string;
  capabilities: readonly BrowserCapability[];
  lifecycle?: TabLifecycle;
  claimTab?: (sessionId: string, tabId: string) => Promise<unknown>;
  releaseTab?: (sessionId: string) => unknown;
  /** Whether this tab is the one the pane currently presents. */
  isTabVisible?: (tabId: string) => Promise<boolean>;
  /** Reveal or hide the browser pane for one tab (visibility capability). */
  setTabVisible?: (tabId: string, visible: boolean) => Promise<void>;
  /** Explicit user takeover, with Codex's reason vocabulary. */
  requestTakeover?: (reason?: string) => void;
  readClipboard?: () => Promise<string>;
  writeClipboard?: (text: string) => Promise<void>;
  readClipboardImage?: () => Promise<string | null>;
  writeClipboardImage?: (data: string) => Promise<void>;
};

type CapabilityProvider = (id: string) => unknown;

type LocatorOptions = { exact?: boolean; name?: string; limit?: number };

/** Human- and agent-readable documentation for each backend capability. */
const CAPABILITY_DOCS: Record<string, { description: string; documentation: string }> = {
  tabs: { description: "List, create, select and close tabs.", documentation: "await browser.tabs.list(); const tab = await browser.tabs.get(id); await browser.tabs.new(); await tab.close();" },
  navigate: { description: "Navigate a tab to a URL or file.", documentation: "await tab.goto('https://example.com'); await tab.back(); await tab.forward(); await tab.reload();" },
  snapshot: { description: "Accessibility snapshot with stable refs.", documentation: "const snap = await tab.snapshot(); // snap.tree lists nodes with eN refs usable by click/fill" },
  evaluate: { description: "Run JavaScript in the page.", documentation: "await tab.evaluate('document.title'); await tab.playwright.evaluate(() => location.href);" },
  screenshot: { description: "Capture the viewport, full page or a clip.", documentation: "await tab.screenshot({ fullPage: true }); await tab.screenshot({ clip: { x: 0, y: 0, width: 640, height: 480 } });" },
  input: { description: "Raw mouse, keyboard and IME input.", documentation: "await tab.cua.click({ x, y }); await tab.cua.type({ text: 'hi' }); await tab.cua.keypress({ keys: ['Meta','A'] });" },
  click: { description: "Click an element by snapshot ref.", documentation: "await tab.click('e12');" },
  fill: { description: "Fill an element by snapshot ref.", documentation: "await tab.fill('e7', 'hello');" },
  upload: { description: "Attach files to a file input.", documentation: "await tab.uploadFiles('input[type=file]', ['/abs/file.pdf']);" },
  download: { description: "Download a URL or wait for a download.", documentation: "await tab.download(url); await tab.playwright.waitForEvent('download');" },
  frames: { description: "List and read frames.", documentation: "await tab.playwright.domSnapshot(); // includes same-origin frame bodies" },
  locator: { description: "Playwright-style locators.", documentation: "await tab.playwright.getByRole('button', { name: 'Save' }).click(); await tab.playwright.locator('.row').nth(2).innerText();" },
  visibility: { description: "Show or hide the browser pane.", documentation: "const v = await tab.capabilities.get('visibility'); await v.set(true); await v.get();" },
  playwright: { description: "Full Playwright-style tab surface.", documentation: "await tab.playwright.waitForLoadState({ state: 'networkidle' }); await tab.playwright.waitForURL('**/done');" },
  content: { description: "Export tab text or HTML.", documentation: "const { text, html } = await tab.content();" },
  clipboard: { description: "Read and write the browser clipboard.", documentation: "await tab.clipboard.writeText('hi'); await tab.clipboard.readItems();" },
  dev: { description: "Console, network and raw CDP.", documentation: "await tab.dev.logs({ levels: ['error'], filter: 'fetch' }); await tab.dev.cdp('Page.enable');" },
  ax: { description: "Accessibility state and element actions.", documentation: "await tab.ax.write(); await tab.ax.click(3); await tab.ax.pressKey(3, 'Enter');" },
  cua: { description: "Coordinate-level computer use.", documentation: "await tab.cua.click({ x: 120, y: 80, clickCount: 2 }); await tab.cua.drag({ path: [{x:1,y:1},{x:50,y:50}] });" },
  dom_cua: { description: "DOM node ids with direct actions.", documentation: "const dom = await tab.dom_cua.get_visible_dom(); await tab.dom_cua.click({ node_id: dom.nodes[0].id });" },
};

export class BrowserCapabilityCollection {
  private readonly ids: readonly string[];
  private readonly provider?: CapabilityProvider;
  constructor(ids: readonly string[], provider?: CapabilityProvider) {
    this.ids = [...new Set(ids)];
    this.provider = provider;
  }
  list(): string[] { return [...this.ids]; }
  describe(): Array<{ id: string; description: string }> {
    return this.ids.map((id) => ({
      id,
      description: CAPABILITY_DOCS[id]?.description ?? `${id} is available in this browser backend.`,
    }));
  }
  has(id: string): boolean { return this.ids.includes(id); }
  /**
   * Capabilities are the Codex contract, not a label list: `get` returns the
   * object an agent calls (`visibility.set(true)`, `tabs.list()`, ...). Ids the
   * backend declares without an implementation keep the documentation stub so
   * older surfaces still answer.
   */
  async get(id: string): Promise<unknown> {
    if (!this.ids.includes(id)) {
      throw Object.assign(new Error(`unknown browser capability: ${id}`), { code: "UNSUPPORTED" });
    }
    const doc = CAPABILITY_DOCS[id];
    const documentation = async () =>
      doc?.documentation ?? `${id} is available in this browser backend.`;
    const implementation = this.provider?.(id);
    if (implementation !== undefined) {
      if (implementation && typeof implementation === "object") {
        return {
          ...(implementation as Record<string, unknown>),
          ...(doc ? { description: doc.description } : {}),
          documentation,
        };
      }
      return implementation;
    }
    return {
      id,
      ...(doc ? { description: doc.description } : {}),
      documentation,
    };
  }
}

class AXAPI {
  private readonly tab: BrowserTabHandle;
  constructor(tab: BrowserTabHandle) { this.tab = tab; }
  async get(
    mode: "state" | "screenshot" | "both" = "state",
    options: { disableDiffing?: boolean } = {},
  ) {
    const [snapshot, shot] = await Promise.all([
      this.tab.snapshot(),
      mode === "state" ? Promise.resolve(null) : this.tab.screenshot(),
    ]);
    if (mode === "screenshot") return (shot as { data?: string })?.data ?? "";
    const state = this.diff(snapshot.tree, options.disableDiffing === true);
    if (mode === "both") return { state, screenshot: (shot as { data?: string })?.data };
    return state;
  }

  /** Mark added and removed lines relative to the previous state for this tab. */
  private diff(tree: string, disableDiffing: boolean): string {
    const key = `${this.tab.browser.sessionId}:${this.tab.id}`;
    const current = String(tree ?? "");
    const previous = axSnapshots.get(key);
    axSnapshots.set(key, current);
    if (disableDiffing || previous === undefined || previous === current) return current;
    const before = new Set(previous.split("\n"));
    const now = new Set(current.split("\n"));
    const lines: string[] = [];
    for (const line of current.split("\n")) {
      lines.push(before.has(line) ? line : `+ ${line}`);
    }
    for (const line of previous.split("\n")) {
      if (!now.has(line)) lines.push(`- ${line}`);
    }
    return lines.join("\n");
  }
  async click(
    target: number | { x: number; y: number },
    options: { clickCount?: number; duration?: number; key?: string } = {},
  ) {
    const clickCount = Math.max(1, Math.trunc(options.clickCount ?? 1));
    if (typeof target === "number") {
      const tree = (await this.tab.snapshot()).tree;
      const refs = [...tree.matchAll(/\b(e\d+)\b/g)].map((match) => match[1]);
      const ref = refs[target];
      if (!ref) throw new Error(`AX element index out of range: ${target}`);
      if (options.key) await this.tab.sessionInput({ type: "keyDown", keyCode: options.key });
      for (let index = 0; index < clickCount; index += 1) await this.tab.click(ref);
      if (options.key) await this.tab.sessionInput({ type: "keyUp", keyCode: options.key });
      return;
    }
    if (options.key) await this.tab.sessionInput({ type: "keyDown", keyCode: options.key });
    await this.tab.sessionInput({ type: "mouseMove", x: target.x, y: target.y });
    await this.tab.sessionInput({ type: "mouseDown", x: target.x, y: target.y, button: "left", clickCount });
    if (options.duration && options.duration > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, (options.duration as number) * 1000)));
    }
    await this.tab.sessionInput({ type: "mouseUp", x: target.x, y: target.y, button: "left", clickCount });
    if (options.key) await this.tab.sessionInput({ type: "keyUp", keyCode: options.key });
  }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }) {
    await this.tab.sessionInput({ type: "mouseMove", x: from.x, y: from.y });
    await this.tab.sessionInput({ type: "mouseDown", x: from.x, y: from.y, button: "left", clickCount: 1 });
    await this.tab.sessionInput({ type: "mouseMove", x: to.x, y: to.y });
    await this.tab.sessionInput({ type: "mouseUp", x: to.x, y: to.y, button: "left", clickCount: 1 });
  }
  async scroll(target: number | { x: number; y: number }, direction: "up" | "down" | "left" | "right", pages = 1) {
    const point = typeof target === "number" ? { x: 20, y: 20 } : target;
    const delta = Math.round(600 * Math.max(1, pages));
    const deltaX = direction === "left" ? -delta : direction === "right" ? delta : 0;
    const deltaY = direction === "up" ? -delta : direction === "down" ? delta : 0;
    await this.tab.sessionInput({ type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY });
  }
  async pressKey(_element: number | null, key: string, options: { duration?: number } = {}) {
    await this.tab.sessionInput({ type: "keyDown", keyCode: key });
    if (options.duration && options.duration > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, (options.duration as number) * 1000)));
    }
    await this.tab.sessionInput({ type: "keyUp", keyCode: key });
  }
  async paste(_element: number | null, text: string, _options: { format?: "text" | "md" | "html" } = {}) {
    await this.tab.sessionInsertText(text);
  }
  async write(mode: "state" | "both" | "screenshot" = "state") {
    return this.get(mode);
  }
  async selectText(element: number, text: string, options: { prefix?: string; suffix?: string; selectionType?: string } = {}) {
    const tree = (await this.tab.snapshot()).tree;
    const refs = [...tree.matchAll(/\b(e\d+)\b/g)].map((match) => match[1]);
    const ref = refs[element];
    if (!ref) throw new Error(`AX element index out of range: ${element}`);
    await this.tab.evaluate(`(() => { const el = globalThis.__PI_REFS?.get(${JSON.stringify(ref)}); if (el) { el.focus(); el.select?.(); } })()`);
    if (text) await this.tab.sessionInsertText(text);
  }
  async performSecondaryAction(element: number, action: string) {
    const tree = (await this.tab.snapshot()).tree;
    const refs = [...tree.matchAll(/\b(e\d+)\b/g)].map((match) => match[1]);
    const ref = refs[element];
    if (!ref) throw new Error(`AX element index out of range: ${element}`);
    const key = action === "increment" ? "ArrowUp" : action === "decrement" ? "ArrowDown" : "";
    if (key) {
      await this.tab.sessionInput({ type: "keyDown", keyCode: key });
      await this.tab.sessionInput({ type: "keyUp", keyCode: key });
      return;
    }
    const event = action === "showMenu" || action === "contextmenu" ? "contextmenu" : "click";
    await this.tab.evaluate(`(() => {
      const map = globalThis.__PI_REFS || (globalThis.__PI_EXT_REFS && globalThis.__PI_EXT_REFS.byRef);
      const el = map && map.get(${JSON.stringify(ref)});
      if (!el) return false;
      el.dispatchEvent(new MouseEvent(${JSON.stringify(event)}, { bubbles: true }));
      return true;
    })()`);
  }
}

class CUAAPI {
  private readonly tab: BrowserTabHandle;
  constructor(tab: BrowserTabHandle) { this.tab = tab; }

  private buttonName(button?: number | string): "left" | "right" | "middle" {
    if (button === 3 || button === "right" || button === "r") return "right";
    if (button === 2 || button === "middle" || button === "m") return "middle";
    return "left";
  }

  private async holdKey(key: string | undefined, pressed: boolean) {
    if (!key) return;
    await this.tab.sessionInput({ type: pressed ? "keyDown" : "keyUp", keyCode: key });
  }

  async click({ x, y, button, clickCount = 1, keypress, duration }: {
    x: number; y: number; button?: number | string; clickCount?: number; keypress?: string[]; duration?: number;
  }) {
    const name = this.buttonName(button);
    for (const key of keypress ?? []) await this.holdKey(key, true);
    await this.tab.sessionInput({ type: "mouseMove", x, y });
    await this.tab.sessionInput({ type: "mouseDown", x, y, button: name, clickCount });
    if (duration && duration > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, (duration as number) * 1000)));
    await this.tab.sessionInput({ type: "mouseUp", x, y, button: name, clickCount });
    for (const key of [...(keypress ?? [])].reverse()) await this.holdKey(key, false);
  }
  async double_click({ x, y, keypress }: { x: number; y: number; keypress?: string[] }) {
    await this.click({ x, y, clickCount: 2, keypress });
  }
  move({ x, y, keys }: { x: number; y: number; keys?: string[] }) {
    const release = () => Promise.all((keys ?? []).map((key) => this.holdKey(key, false)));
    return (async () => {
      for (const key of keys ?? []) await this.holdKey(key, true);
      await this.tab.sessionInput({ type: "mouseMove", x, y });
      await release();
    })();
  }
  async scroll({ x, y, deltaX = 0, deltaY = 0, keypress }: {
    x: number; y: number; deltaX?: number; deltaY?: number; keypress?: string[];
  }) {
    for (const key of keypress ?? []) await this.holdKey(key, true);
    await this.tab.sessionInput({ type: "mouseWheel", x, y, deltaX, deltaY });
    for (const key of [...(keypress ?? [])].reverse()) await this.holdKey(key, false);
  }
  type({ text }: { text: string }) { return this.tab.sessionInsertText(text); }
  async keypress({ keys, duration }: { keys: string[]; duration?: number }) {
    for (const key of keys) await this.tab.sessionInput({ type: "keyDown", keyCode: key });
    if (duration && duration > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, (duration as number) * 1000)));
    for (const key of [...keys].reverse()) await this.tab.sessionInput({ type: "keyUp", keyCode: key });
  }
  async drag({ from, to, path, keys }: {
    from?: { x: number; y: number }; to?: { x: number; y: number }; path?: Array<{ x: number; y: number }>; keys?: string[];
  }) {
    const points = path?.length ? path : [from, to].filter(Boolean) as Array<{ x: number; y: number }>;
    const [start, ...rest] = points;
    if (!start) throw new Error("drag requires a path");
    for (const key of keys ?? []) await this.holdKey(key, true);
    await this.tab.sessionInput({ type: "mouseMove", x: start.x, y: start.y });
    await this.tab.sessionInput({ type: "mouseDown", x: start.x, y: start.y, button: "left", clickCount: 1 });
    for (const point of rest.length ? rest : [start]) {
      await this.tab.sessionInput({ type: "mouseMove", x: point.x, y: point.y });
    }
    const end = rest.at(-1) ?? start;
    await this.tab.sessionInput({ type: "mouseUp", x: end.x, y: end.y, button: "left", clickCount: 1 });
    for (const key of [...(keys ?? [])].reverse()) await this.holdKey(key, false);
  }
  async downloadMedia(options: { node_id?: string; ref?: string; x?: number; y?: number; timeoutMs?: number }) {
    if (typeof options.x === "number" && typeof options.y === "number") {
      const url = await this.tab.evaluate(`(() => {
        const el = document.elementsFromPoint(${Number(options.x)}, ${Number(options.y)})[0];
        return el ? String(el.currentSrc || el.src || el.href || '') : '';
      })()`);
      if (!url) throw new Error(`no media at (${options.x}, ${options.y})`);
      return this.tab.download(String(url));
    }
    return this.tab.dom_cua.downloadMedia(options);
  }
}

class ClipboardAPI {
  private readonly session: BrowserSession;
  constructor(session: BrowserSession) { this.session = session; }
  async read(): Promise<Array<{ type: "text"; text: string } | { type: "image"; data: string }>> {
    const items: Array<{ type: "text"; text: string } | { type: "image"; data: string }> = [];
    const text = await this.session.clipboardRead();
    if (text) items.push({ type: "text", text });
    const image = await this.session.clipboardReadImage();
    if (image) items.push({ type: "image", data: image });
    return items;
  }
  readText() { return this.session.clipboardRead(); }
  async write(items: Array<{ type?: string; text?: string; data?: string }>): Promise<void> {
    const text = items.filter((item) => item?.type !== "image").map((item) => item?.text ?? "").join("\n");
    if (text) await this.session.clipboardWrite(text);
    const image = items.find((item) => item?.type === "image" && item.data);
    if (image?.data) {
      if (!text) await this.session.clipboardWrite("");
      await this.session.clipboardWriteImage(image.data);
    }
  }
  writeText(text: string) { return this.session.clipboardWrite(text); }
  /** Codex clipboard item shape: entries carry mimeType plus text or base64. */
  async readItems(): Promise<Array<{ entries: Array<{ mimeType: string; text?: string; base64?: string }>; presentationStyle?: string }>> {
    const items: Array<{ entries: Array<{ mimeType: string; text?: string; base64?: string }>; presentationStyle?: string }> = [];
    const text = await this.session.clipboardRead();
    if (text) items.push({ entries: [{ mimeType: "text/plain", text }] });
    const image = await this.session.clipboardReadImage();
    if (image) items.push({ entries: [{ mimeType: "image/png", base64: image }], presentationStyle: "attachment" });
    return items;
  }
  async writeItems(items: Array<{ entries?: Array<{ mimeType?: string; text?: string; base64?: string }> }>): Promise<void> {
    for (const item of items ?? []) {
      for (const entry of item?.entries ?? []) {
        const mime = String(entry.mimeType ?? "text/plain");
        if (mime.startsWith("image/") && typeof entry.base64 === "string") {
          await this.session.clipboardWriteImage(entry.base64);
        } else if (typeof entry.text === "string") {
          await this.session.clipboardWrite(entry.text);
        }
      }
    }
  }
}

class TabDevAPI {
  private readonly tab: BrowserTabHandle;
  constructor(tab: BrowserTabHandle) { this.tab = tab; }
  cdp(method: string, params?: unknown) { return this.tab.sessionCdP(method, params); }
  console(limit = 100) { return this.tab.sessionConsole(limit); }
  network(limit = 100) { return this.tab.sessionNetwork(limit); }
  /**
   * Console entries with Codex's filter/levels shape. Backends answer either
   * `{messages}` (embedded) or `{entries}` (extension), so normalize both.
   */
  async logs(options: { limit?: number; filter?: string; levels?: Array<"debug" | "info" | "log" | "warn" | "error"> } = {}) {
    const limit = Math.max(1, Math.min(1000, Number(options.limit) || 100));
    const raw = await this.tab.sessionConsole(Math.max(limit, 500)) as
      | Array<Record<string, unknown>>
      | { messages?: Array<Record<string, unknown>>; entries?: Array<Record<string, unknown>> }
      | null;
    const list = Array.isArray(raw) ? raw : raw?.messages ?? raw?.entries ?? [];
    const levelOf = (value: unknown): "debug" | "info" | "log" | "warn" | "error" => {
      const text = String(value ?? "").toLowerCase();
      if (text === "warning") return "warn";
      if (text === "error" || text === "warn" || text === "info" || text === "debug") return text;
      return "log";
    };
    const levels = options.levels?.length ? new Set(options.levels) : null;
    const filter = String(options.filter ?? "");
    return list
      .map((entry) => ({
        level: levelOf(entry.type ?? entry.level),
        message: String(entry.text ?? entry.message ?? ""),
        timestamp: new Date(Number(entry.timestamp) || 0).toISOString(),
      }))
      .filter((entry) => !levels || levels.has(entry.level))
      .filter((entry) => !filter || entry.message.includes(filter))
      .slice(-limit);
  }
}

class DomCUAAPI {
  private readonly tab: BrowserTabHandle;
  constructor(tab: BrowserTabHandle) { this.tab = tab; }

  /** Filtered, id-tagged DOM of what the user can see and touch. */
  async get_visible_dom(): Promise<unknown> {
    return this.tab.evaluate(`(() => {
      const state = globalThis.__PI_DOM_NODES || (globalThis.__PI_DOM_NODES = { byId: new Map(), next: 1 });
      state.byId.clear();
      state.next = 1;
      const visible = (el) => {
        if (!el.isConnected) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const interactive = (el) => {
        const tag = el.tagName;
        if (['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY'].includes(tag)) return true;
        if (el.isContentEditable) return true;
        const role = el.getAttribute('role');
        if (role && ['button','link','checkbox','radio','tab','menuitem','option','switch','textbox','combobox','searchbox'].includes(role)) return true;
        if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
        return false;
      };
      const roleOf = (el) => el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button' : el.tagName === 'INPUT' ? 'textbox' : '');
      const nameOf = (el) => String(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      const nodes = [];
      const walk = (el, depth, parentId) => {
        if (nodes.length >= 800 || depth > 24) return;
        if (el.nodeType !== 1) return;
        if (!visible(el)) return;
        const id = 'd' + state.next++;
        state.byId.set(id, el);
        const rect = el.getBoundingClientRect();
        const node = {
          id,
          ...(parentId ? { parent: parentId } : {}),
          tag: el.tagName.toLowerCase(),
          role: roleOf(el),
          name: nameOf(el),
          ...(interactive(el) ? { interactive: true } : {}),
          ...(typeof el.value === 'string' && el.value ? { value: el.value.slice(0, 200) } : {}),
          ...(el.tagName === 'A' && el.href ? { href: el.href.slice(0, 500) } : {}),
          box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        };
        nodes.push(node);
        for (const child of el.children) walk(child, depth + 1, id);
      };
      walk(document.body || document.documentElement, 0, null);
      const lines = nodes.map((node) => {
        const flags = [node.role, node.interactive ? 'interactive' : '', node.value ? 'value=' + JSON.stringify(node.value) : ''].filter(Boolean).join(' ');
        return node.id + ' ' + node.tag + (flags ? ' [' + flags + ']' : '') + ' ' + node.name;
      });
      return { ok: true, url: location.href, title: document.title, count: nodes.length, nodes, tree: lines.join('\n') };
    })()`) as Promise<unknown>;
  }

  private async resolve(nodeId: string): Promise<boolean> {
    const id = String(nodeId ?? "");
    if (!id) throw new Error("dom_cua requires a node id from get_visible_dom()");
    return Boolean(await this.tab.evaluate(`(() => {
      const state = globalThis.__PI_DOM_NODES;
      const el = state && state.byId.get(${JSON.stringify(id)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    })()`));
  }

  async click(options: { node_id?: string; ref?: string; button?: number }) {
    const id = String(options.node_id ?? options.ref ?? "");
    if (!(await this.resolve(id))) throw new Error(`DOM node not found: ${id}`);
    await this.tab.evaluate(`(() => {
      const el = globalThis.__PI_DOM_NODES.byId.get(${JSON.stringify(id)});
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.click();
    })()`);
  }

  async double_click(options: { node_id?: string; ref?: string }) {
    const id = String(options.node_id ?? options.ref ?? "");
    if (!(await this.resolve(id))) throw new Error(`DOM node not found: ${id}`);
    await this.tab.evaluate(`(() => {
      const el = globalThis.__PI_DOM_NODES.byId.get(${JSON.stringify(id)});
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      el.click();
      el.click();
    })()`);
  }

  async scroll(options: { node_id?: string; x?: number; y?: number; deltaX?: number; deltaY?: number }) {
    const deltaX = Number(options.deltaX ?? options.x ?? 0);
    const deltaY = Number(options.deltaY ?? options.y ?? 0);
    if (options.node_id) {
      await this.resolve(String(options.node_id));
      await this.tab.evaluate(`(() => {
        const el = globalThis.__PI_DOM_NODES.byId.get(${JSON.stringify(String(options.node_id))});
        if (!el) return false;
        if (el.scrollBy) el.scrollBy(${deltaX}, ${deltaY});
        else window.scrollBy(${deltaX}, ${deltaY});
        return true;
      })()`);
      return;
    }
    await this.tab.evaluate(`window.scrollBy(${deltaX}, ${deltaY})`);
  }

  async keypress(options: { keys: string[] }) { return this.tab.cua.keypress(options); }

  async type(options: { text: string; node_id?: string }) {
    if (options.node_id) {
      await this.resolve(String(options.node_id));
      await this.tab.evaluate(`(() => { const el = globalThis.__PI_DOM_NODES.byId.get(${JSON.stringify(String(options.node_id))}); el && el.focus(); })()`);
    }
    return this.tab.sessionInsertText(options.text);
  }

  async downloadMedia(options: { node_id?: string; ref?: string }) {
    const id = String(options.node_id ?? options.ref ?? "");
    const url = await this.tab.evaluate(`(() => {
      const el = globalThis.__PI_DOM_NODES && globalThis.__PI_DOM_NODES.byId.get(${JSON.stringify(id)});
      return el ? String(el.currentSrc || el.src || el.href || '') : '';
    })()`);
    if (!url) throw new Error(`media node not found: ${id}`);
    return this.tab.download(String(url));
  }
}

export class BrowserTabHandle {
  readonly id: string;
  readonly browser: BrowserSession;
  readonly capabilities: BrowserCapabilityCollection;
  readonly ax: AXAPI;
  readonly cua: CUAAPI;
  readonly dom_cua: DomCUAAPI;
  readonly clipboard: ClipboardAPI;
  readonly dev: TabDevAPI;
  readonly playwright: PlaywrightTab;
  constructor(session: BrowserSession, id: string, capabilities: readonly BrowserCapability[]) {
    this.browser = session;
    this.id = id;
    this.capabilities = new BrowserCapabilityCollection(capabilities, (capability) => {
      switch (capability) {
        case "visibility":
          return { get: () => this.isVisible(), set: (visible: boolean) => this.setVisible(visible) };
        case "playwright":
          return this.playwright;
        case "content":
          return { text: async () => (await this.content()).text, html: async () => (await this.content()).html, both: () => this.content() };
        case "clipboard":
          return this.clipboard;
        case "dev":
          return this.dev;
        case "ax":
          return this.ax;
        case "cua":
          return this.cua;
        case "dom_cua":
          return this.dom_cua;
        default:
          return undefined;
      }
    });
    this.ax = new AXAPI(this);
    this.cua = new CUAAPI(this);
    this.dom_cua = new DomCUAAPI(this);
    this.clipboard = new ClipboardAPI(session);
    this.dev = new TabDevAPI(this);
    this.playwright = new PlaywrightTab({
      id: this.id,
      locator: (input) => this.browser.locator(input as LocatorQuery, this.id),
      input: (event) => this.sessionInput(event),
      insertText: (text) => this.sessionInsertText(text),
      evaluate: (expression) => this.evaluate(expression),
      download: (url, filename) => this.download(url, filename),
      screenshot: () => this.screenshot(),
      frameMatches: (frameSelector, selector) => this.frameMatches(frameSelector, selector),
      frameAction: (frameSelector, input) => this.frameAction(frameSelector, input),
      networkIdle: (timeoutMs, idleMs) => this.browser.waitForNetworkIdle(timeoutMs, idleMs),
      waitForDownload: (timeoutMs) => this.browser.waitForDownload(timeoutMs, this.id),
      waitForFileChooser: (timeoutMs) => this.browser.waitForFileChooser(timeoutMs, this.id),
      setFileChooserFiles: (files) => this.browser.setFileChooserFiles(files, this.id),
      state: async () => (await this.browser.snapshot(this.id)) as { url?: string; title?: string },
    });
  }
  sessionLocator(input: Record<string, unknown>) { return this.browser.locator(input, this.id); }
  sessionInput(event: Record<string, unknown>) { return Promise.resolve(this.browser.inputEvent(event, this.id)); }
  sessionInsertText(text: string) { return Promise.resolve(this.browser.insertText(text, this.id)); }
  sessionCdP(method: string, params?: unknown) { return this.browser.cdp(method, params, this.id); }
  async frameMatches(frameSelector: string, selector: string): Promise<string[] | null> {
    const value = await this.evaluate(`(() => {
      const frame = document.querySelector(${JSON.stringify(frameSelector)});
      if (!frame) return null;
      const doc = frame.contentDocument;
      if (!doc) return null;
      return [...doc.querySelectorAll(${JSON.stringify(selector)})].map((el) => String(el.innerText || el.value || '').trim().slice(0, 200));
    })()`) as string[] | null;
    return value;
  }
  async frameAction(frameSelector: string, input: Record<string, unknown>): Promise<unknown> {
    const src = await this.evaluate(`(() => { const frame = document.querySelector(${JSON.stringify(frameSelector)}); return frame ? String(frame.src || frame.name || '') : ''; })()`);
    if (!src) throw new Error(`frame not found: ${frameSelector}`);
    return this.browser.crossOriginFrame({ ...input, url: String(src) }, this.id);
  }
  sessionConsole(limit: number) { return this.browser.console(limit, this.id); }
  sessionNetwork(limit: number) { return this.browser.network(limit, this.id); }
  async goto(url: string) {
    const result = await this.browser.navigate({ url }, this.id);
    const title = await this.evaluate("document.title").catch(() => "");
    const visits = sessionVisits.get(this.browser.sessionId) ?? [];
    visits.push({ url, title: String(title ?? ""), dateVisited: new Date().toISOString() });
    sessionVisits.set(this.browser.sessionId, visits.slice(-500));
    return result;
  }
  async url(): Promise<string | undefined> { return (await this.browser.snapshot(this.id))?.url; }
  async title(): Promise<string | undefined> { return (await this.browser.snapshot(this.id))?.title; }
  snapshot() { return this.browser.snapshot(this.id); }
  screenshot(input: { fullPage?: boolean; format?: "jpeg" | "png"; clip?: { x: number; y: number; width: number; height: number } } = {}) {
    return this.browser.screenshot(input, this.id);
  }
  getJsDialog() { return this.browser.getJsDialog(this.id); }
  click(ref: string) { return this.browser.click(ref, this.id); }
  fill(ref: string, text: string) { return this.browser.fill(ref, text, this.id); }
  evaluate(expression: string) { return this.browser.evaluate(expression, this.id); }
  history() { return this.browser.tabHistory(this.id); }
  back() { return this.browser.action("back", this.id); }
  forward() { return this.browser.action("forward", this.id); }
  reload() { return this.browser.action("reload", this.id); }
  close() { return this.browser.closeTab(this.id); }
  /** Keep this tab open after the turn as a user-facing output. */
  markDeliverable(): void { this.browser.markTab(this.id, "deliverable"); }
  /** Keep this tab open for a later turn. */
  markHandoff(): void { this.browser.markTab(this.id, "handoff"); }
  marks(): TabMark[] { return this.browser.tabMarks(this.id); }
  isVisible(): Promise<boolean> { return this.browser.isTabVisible(this.id); }
  setVisible(visible: boolean): Promise<void> { return this.browser.setTabVisible(this.id, visible); }
  /** Ask the user to take over (authentication, captcha, or by request). */
  requestUserTakeover(reason?: string): void { this.browser.takeover(reason); }
  download(url: string, filename?: string) { return this.browser.downloadUrl(url, filename, this.id); }
  /** Stable mention token a composer or transcript can link back to. */
  mention(): string { return `[[tab:${this.id}]]`; }
  async content(): Promise<{ text: string; html: string }> {
    const text = await this.evaluate("document.body ? document.body.innerText : ''");
    const html = await this.evaluate("document.documentElement ? document.documentElement.outerHTML : ''");
    return { text: String(text ?? ""), html: String(html ?? "") };
  }
}

export class BrowserSession {
  readonly tabs: {
    list: () => Promise<BrowserTabInfo[]>;
    get: (id: string) => Promise<BrowserTabHandle>;
    new: () => Promise<BrowserTabHandle>;
    selected: () => Promise<BrowserTabHandle | undefined>;
    content: (options: { urls: string[]; contentType?: "html" | "text" | "domSnapshot"; timeoutMs?: number }) => Promise<Array<{ url: string; title: string; content: string; text?: string; html?: string }>>;
  };
  readonly user: {
    openTabs: () => Promise<BrowserTabInfo[]>;
    claimTab: (tab: BrowserTabInfo | string) => Promise<BrowserTabHandle>;
    getTabContext: (tab?: BrowserTabInfo | string) => Promise<{ tab: BrowserTabInfo; content: { text: string; html: string } }>;
  };
  readonly capabilities: BrowserCapabilityCollection;
  private sessionName = "";
  private readonly deps: BrowserSessionDeps;
  get sessionId(): string { return this.deps.sessionId; }
  constructor(deps: BrowserSessionDeps) {
    this.deps = deps;
    this.capabilities = new BrowserCapabilityCollection(deps.capabilities, (capability) => {
      switch (capability) {
        case "visibility":
          return {
            get: async () => {
              const selected = await this.tabs.selected();
              return selected ? selected.isVisible() : false;
            },
            set: async (visible: boolean) => {
              const selected = await this.tabs.selected();
              if (selected) await selected.setVisible(visible);
            },
          };
        case "tabs":
          return this.tabs;
        case "playwright":
          return { forTab: async (id: string) => (await this.getTab(id)).playwright };
        default:
          return undefined;
      }
    });
    this.tabs = {
      list: () => this.listTabs(),
      get: (id) => this.getTab(id),
      new: () => this.newTab(),
      content: (options: { urls: string[]; contentType?: "html" | "text" | "domSnapshot"; timeoutMs?: number }) => this.tabContents(options),
      selected: async () => {
        const tabs = await this.listTabs();
        const selected = tabs.find((tab) => tab.active);
        return selected ? this.getTab(selected.id) : undefined;
      },
    };
    this.user = {
      openTabs: () => this.listTabs(),
      claimTab: async (tab) => {
        const id = typeof tab === "string" ? tab : tab.id;
        await this.deps.claimTab?.(this.deps.sessionId, id);
        return this.getTab(id);
      },
      getTabContext: async (tab) => {
        const tabs = await this.listTabs();
        const target = typeof tab === "string" ? tabs.find((item) => item.id === tab) : tab ?? tabs.find((item) => item.active);
        if (!target) throw new Error("browser tab not found");
        const handle = await this.getTab(target.id);
        return { tab: target, content: await handle.content() };
      },
    };
  }
  async history(options: { limit?: number; from?: string | number; queries?: string[] } = {}): Promise<Array<{ url: string; title: string; dateVisited: string }>> {
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const from = options.from === undefined ? 0 : new Date(options.from).getTime() || 0;
    const queries = (options.queries ?? []).map((query) => String(query).toLowerCase()).filter(Boolean);
    const matches = (entry: { url: string; title: string; dateVisited: string }) => {
      if (from && new Date(entry.dateVisited).getTime() < from) return false;
      if (!queries.length) return true;
      const haystack = `${entry.url} ${entry.title}`.toLowerCase();
      return queries.some((query) => haystack.includes(query));
    };
    const visits = [...(sessionVisits.get(this.deps.sessionId) ?? [])].reverse();
    if (visits.length) return visits.filter(matches).slice(0, limit);
    const tab = await this.tabs.selected();
    const history = tab ? await tab.history() as { entries?: Array<{ url?: string; title?: string; timestamp?: number }> } : { entries: [] };
    return (history.entries ?? [])
      .map((entry) => ({
        url: String(entry.url ?? ""),
        title: String(entry.title ?? ""),
        dateVisited: new Date(Number(entry.timestamp) || Date.now()).toISOString(),
      }))
      .filter(matches)
      .slice(0, limit);
  }
  async nameSession(name: string): Promise<void> { this.sessionName = String(name ?? ""); }
  get name(): string { return this.sessionName; }

  /** Keep a tab open past the current turn (Codex's deliverable/handoff). */
  markTab(tabId: string, mark: TabMark): void {
    this.deps.lifecycle?.mark(this.deps.sessionId, tabId, mark);
  }
  tabMarks(tabId: string): TabMark[] {
    return this.deps.lifecycle?.marks(this.deps.sessionId, tabId) ?? [];
  }
  async isTabVisible(tabId: string): Promise<boolean> {
    if (this.deps.isTabVisible) return this.deps.isTabVisible(tabId);
    const tabs = await this.listTabs();
    return tabs.find((tab) => tab.id === tabId)?.active === true;
  }
  async setTabVisible(tabId: string, visible: boolean): Promise<void> {
    if (this.deps.setTabVisible) return this.deps.setTabVisible(tabId, visible);
    await this.deps.service.tabs({ action: visible ? "show" : "select", tabId }, this.deps.sessionId);
  }
  takeover(reason?: string): void {
    this.deps.requestTakeover?.(reason);
  }
  async closeTab(tabId: string): Promise<void> {
    await this.tabsClose(tabId);
  }
  private async tabsClose(tabId: string): Promise<void> {
    await this.deps.service.tabs({ action: "close", tabId }, this.deps.sessionId);
    this.deps.lifecycle?.close(this.deps.sessionId, tabId);
  }
  clipboardRead(): Promise<string> { return this.deps.readClipboard?.() ?? Promise.resolve(""); }
  clipboardWrite(text: string): Promise<void> { return this.deps.writeClipboard?.(text) ?? Promise.resolve(); }
  clipboardReadImage(): Promise<string | null> { return this.deps.readClipboardImage?.() ?? Promise.resolve(null); }
  clipboardWriteImage(data: string): Promise<void> { return this.deps.writeClipboardImage?.(data) ?? Promise.resolve(); }
  private async tabContents(options: { urls: string[]; contentType?: "html" | "text" | "domSnapshot"; timeoutMs?: number }): Promise<Array<{ url: string; title: string; content: string; text?: string; html?: string }>> {
    const results: Array<{ url: string; title: string; content: string; text?: string; html?: string }> = [];
    const timeoutMs = Math.max(1_000, Math.min(60_000, options.timeoutMs ?? 15_000));
    for (const url of options.urls) {
      const tab = await this.newTab();
      const tabId = tab.id;
      this.deps.lifecycle?.register(this.deps.sessionId, tabId, "headless");
      try {
        await tab.goto(url);
        await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs }).catch(() => undefined);
        const [text, html, title] = await Promise.all([
          tab.evaluate("document.body ? document.body.innerText : ''"),
          tab.evaluate("document.documentElement ? document.documentElement.outerHTML : ''"),
          tab.evaluate("document.title"),
        ]);
        const type = options.contentType ?? "text";
        const content = type === "html" ? String(html ?? "") : String(text ?? "");
        results.push({ url, title: String(title ?? ""), content, text: String(text ?? ""), html: String(html ?? "") });
      } catch (error) {
        results.push({ url, title: "", content: "", ...(error instanceof Error ? { content: `ERROR: ${error.message}` } : {}) });
      } finally {
        await tab.close().catch(() => undefined);
      }
    }
    return results;
  }
  // Typed session operations. Tools and CUA call these directly; there is no
  // string-dispatch layer between the Browser/Tab objects and the service.
  navigate(input: { url?: string; path?: string }, tabId?: string) {
    return this.deps.service.navigate(input, this.deps.sessionId, tabId);
  }
  snapshot(tabId?: string) {
    return this.deps.service.snapshot(this.deps.sessionId, tabId) as Promise<SnapshotResult>;
  }
  screenshot(input: { fullPage?: boolean; format?: "jpeg" | "png"; clip?: { x: number; y: number; width: number; height: number } } = {}, tabId?: string) {
    return this.deps.service.screenshot(input, this.deps.sessionId, tabId);
  }
  getJsDialog(tabId?: string) {
    return this.deps.service.getJsDialog?.(this.deps.sessionId, tabId) ?? Promise.resolve(null);
  }
  click(uid: string, tabId?: string) {
    return this.deps.service.click(uid, this.deps.sessionId, tabId);
  }
  fill(uid: string, text: string, tabId?: string) {
    return this.deps.service.fill(uid, text, this.deps.sessionId, tabId);
  }
  evaluate(expression: string, tabId?: string) {
    return this.deps.service.evaluate(expression, this.deps.sessionId, tabId);
  }
  evaluateNative(expression: string, tabId?: string) {
    return this.deps.service.evaluateNative({ expression }, this.deps.sessionId, tabId);
  }
  evaluateIsolated(expression: string, tabId?: string) {
    return this.deps.service.evaluateIsolated({ expression }, this.deps.sessionId, tabId);
  }
  tabHistory(tabId?: string) {
    return this.deps.service.history(this.deps.sessionId, tabId);
  }
  action(action: "back" | "forward" | "reload" | "stop", tabId?: string) {
    return this.deps.service.action(action, this.deps.sessionId, tabId);
  }
  locator(input: Record<string, unknown>, tabId?: string) {
    return this.deps.service.locator(input, this.deps.sessionId, tabId);
  }
  crossOriginFrame(input: Record<string, unknown>, tabId?: string) {
    return this.deps.service.crossOriginFrame(input, this.deps.sessionId, tabId);
  }
  downloadUrl(url: string, filename?: string, tabId?: string) {
    return this.deps.service.downloadUrl(url, filename, this.deps.sessionId, tabId);
  }
  clickAndWaitForDownload(ref: string, timeoutMs?: number, tabId?: string) {
    return this.deps.service.clickAndWaitForDownload(ref, timeoutMs, this.deps.sessionId, tabId);
  }
  inputEvent(event: unknown, tabId?: string) {
    return this.deps.service.inputEvent(event, this.deps.sessionId, tabId);
  }
  insertText(text: string, tabId?: string) {
    return this.deps.service.insertText(text, this.deps.sessionId, tabId);
  }
  handleDialog(input: { accept?: boolean; promptText?: string }, tabId?: string) {
    return this.deps.service.handleDialog(input, this.deps.sessionId, tabId);
  }
  waitForFileChooser(timeoutMs: number | undefined, tabId?: string) {
    return this.deps.service.waitForFileChooser(timeoutMs, this.deps.sessionId, tabId);
  }
  waitForNetworkIdle(timeoutMs?: number, idleMs?: number, tabId?: string) {
    return this.deps.service.waitForNetworkIdle({ timeoutMs, idleMs }, this.deps.sessionId, tabId);
  }
  waitForDownload(timeoutMs?: number, tabId?: string) {
    return this.deps.service.waitForDownload(timeoutMs, this.deps.sessionId, tabId);
  }
  setFileChooserFiles(files: string[], tabId?: string) {
    return this.deps.service.setFileChooserFiles(files, this.deps.sessionId, tabId);
  }
  uploadFiles(selector: string, files: string[], tabId?: string) {
    return this.deps.service.uploadFiles(selector, files, this.deps.sessionId, tabId);
  }
  cdp(method: string, params?: unknown, tabId?: string) {
    return this.deps.service.cdp(method, params, this.deps.sessionId, tabId);
  }
  console(limit: number, tabId?: string) {
    return this.deps.service.console(limit, this.deps.sessionId, tabId);
  }
  network(limit: number, tabId?: string) {
    return this.deps.service.networkRequests({ limit }, this.deps.sessionId, tabId);
  }
  private async listTabs(): Promise<BrowserTabInfo[]> {
    const state = await this.deps.service.tabs({ action: "list" }, this.deps.sessionId) as {
      tabs?: Array<{ tabId?: string; id?: string; title?: string; url?: string; active?: boolean; windowId?: number; groupId?: number; providerTabId?: string }>;
      activeTabId?: string;
    };
    const lifecycle = this.deps.lifecycle;
    if (lifecycle) {
      for (const tab of state?.tabs ?? []) {
        const id = String(tab.tabId ?? tab.id ?? "");
        // A tab this lifecycle has never seen was opened by the user.
        if (id && !lifecycle.has(this.deps.sessionId, id)) lifecycle.register(this.deps.sessionId, id, "user");
      }
    }
    return (state?.tabs ?? []).map((tab) => ({
      id: String(tab.tabId ?? tab.id ?? ""),
      title: String(tab.title ?? ""),
      url: String(tab.url ?? ""),
      active: tab.active === true || String(tab.tabId ?? tab.id ?? "") === state.activeTabId,
      ...(typeof tab.windowId === "number" ? { windowId: tab.windowId } : {}),
      ...(typeof tab.groupId === "number" ? { groupId: tab.groupId } : {}),
      ...(typeof tab.providerTabId === "string" ? { providerTabId: tab.providerTabId } : {}),
    }));
  }
  private getTab(id: string) { return Promise.resolve(new BrowserTabHandle(this, id, this.deps.capabilities)); }
  private async newTab(): Promise<BrowserTabHandle> {
    const opened = await this.deps.service.tabs({ action: "new" }, this.deps.sessionId) as { tabId?: string };
    const id = String(opened?.tabId ?? "");
    if (!id) throw new Error("browser did not return a new tab id");
    this.deps.lifecycle?.register(this.deps.sessionId, id, "agent");
    return this.getTab(id);
  }
}
