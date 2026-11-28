import type { LocatorQuery, LocatorResult } from "./types.ts";

/**
 * The tab-facing Playwright-style API. It mirrors the surface Codex exposes
 * (`agent.browsers` → tab.playwright) so an agent can compose lookups instead
 * of issuing one tool call per step.
 *
 * All element resolution happens through the backend's locator action; real
 * mouse input is used for click/double-click/hover so pages that gate on
 * `isTrusted` behave the same as in a browser.
 */
export type LocatorHost = {
  id: string;
  locator(input: LocatorQuery): Promise<unknown>;
  input(event: Record<string, unknown>): Promise<unknown>;
  insertText(text: string): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  download(url: string, filename?: string): Promise<unknown>;
  screenshot(options?: { fullPage?: boolean }): Promise<unknown>;
  frameMatches?(frameSelector: string, selector: string): Promise<string[] | null>;
  frameAction?(frameSelector: string, input: Record<string, unknown>): Promise<unknown>;
  state?(): Promise<{ url?: string; title?: string }>;
  navigate?(url: string): Promise<unknown>;
  networkIdle?(timeoutMs?: number, idleMs?: number): Promise<unknown>;
  waitForDownload?(timeoutMs?: number): Promise<unknown>;
  waitForFileChooser?(timeoutMs?: number): Promise<unknown>;
  setFileChooserFiles?(files: string[]): Promise<unknown>;
}

type State = "attached" | "detached" | "visible" | "hidden";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function numberArg(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isPlaywrightLocator(value: unknown): boolean {
  return value instanceof PlaywrightLocator;
}

export class PlaywrightLocator {
  private readonly host: LocatorHost;
  private readonly query: LocatorQuery;
  private readonly frameSelector?: string;

  constructor(host: LocatorHost, query: LocatorQuery = {}, frameSelector?: string) {
    this.host = host;
    this.query = query;
    this.frameSelector = frameSelector;
  }

  private chain(patch: LocatorQuery): PlaywrightLocator {
    return new PlaywrightLocator(this.host, { ...this.query, ...patch }, this.frameSelector);
  }

  private frameError(operation: string): Error {
    return Object.assign(
      new Error(`${operation} is not available inside a cross-origin frame; use frame text/html/count`),
      { code: "UNSUPPORTED" },
    );
  }

  locator(selector: string, options: LocatorQuery = {}) {
    return this.chain({ ...options, selector, nth: undefined, nthFromEnd: undefined });
  }
  getByRole(role: string, options: { exact?: boolean; name?: string } = {}) {
    return this.chain({ role, ...(options.name ? { name: options.name } : {}), nth: undefined, nthFromEnd: undefined });
  }
  getByLabel(text: string) { return this.chain({ name: text, nth: undefined, nthFromEnd: undefined }); }
  getByPlaceholder(text: string) { return this.chain({ placeholder: text, nth: undefined, nthFromEnd: undefined }); }
  getByTestId(testId: string) { return this.chain({ testId, nth: undefined, nthFromEnd: undefined }); }
  getByText(text: string, options: { exact?: boolean } = {}) {
    return this.chain({ text, nth: undefined, nthFromEnd: undefined, ...(options.exact ? { hasText: text } : {}) });
  }
  frameLocator(selector: string) {
    return new PlaywrightLocator(this.host, { ...this.query, selector: "", nth: undefined, nthFromEnd: undefined }, selector);
  }
  nth(index: number) { return this.chain({ nth: Math.max(0, Math.trunc(index)), nthFromEnd: undefined }); }
  first() { return this.nth(0); }
  last() { return this.chain({ nthFromEnd: 1, nth: undefined }); }
  filter(options: { hasText?: string; hasNotText?: string; visible?: boolean } = {}) {
    return this.chain({
      ...(options.hasText ? { hasText: options.hasText } : {}),
      ...(options.hasNotText ? { hasNotText: options.hasNotText } : {}),
      ...(options.visible ? { visibleOnly: true } : {}),
    });
  }
  and(other: PlaywrightLocator) {
    return new PlaywrightLocator(this.host, { ...this.query, combine: "and", combined: other.input() }, this.frameSelector);
  }
  or(other: PlaywrightLocator) {
    return new PlaywrightLocator(this.host, { ...this.query, combine: "or", combined: other.input() }, this.frameSelector);
  }
  input(): LocatorQuery { return { ...this.query }; }

  private async run(action: LocatorQuery["action"], extra: LocatorQuery = {}): Promise<LocatorResult> {
    const input: LocatorQuery = { ...this.query, ...extra, action, limit: Math.max(numberArg(this.query.limit, 10), 50) };
    if (this.frameSelector) {
      return this.runFrame(action, input);
    }
    return (await this.host.locator(input)) as LocatorResult;
  }

  private async runFrame(action: LocatorQuery["action"], input: LocatorQuery): Promise<LocatorResult> {
    if (!this.host.frameAction || !this.host.frameMatches) throw this.frameError(String(action));
    const selector = String(input.selector ?? "");
    const local = action === "count" || action === "list"
      ? await this.host.frameMatches(this.frameSelector!, selector || "*")
      : action === "text" || action === "innerText" || action === "textContent"
        ? await this.host.frameMatches(this.frameSelector!, selector || "body")
        : null;
    if (local) {
      if (action === "count" || action === "list") return { ok: true, count: local.length, matches: [] };
      return { ok: true, count: local.length, value: local.join("\n") };
    }
    if (action === "count" || action === "list") {
      const result = await this.host.frameAction(this.frameSelector!, { action: "count", targetSelector: selector || "*" }) as { count?: number; matches?: unknown[] };
      return { ok: true, count: result?.count ?? result?.matches?.length ?? 0, matches: [] };
    }
    if (action === "text" || action === "innerText" || action === "textContent") {
      const result = await this.host.frameAction(this.frameSelector!, { action: "text", targetSelector: selector || "body" }) as { text?: string };
      return { ok: true, count: 1, value: String(result?.text ?? "") };
    }
    if (action === "click" || action === "fill" || action === "type") {
      await this.host.frameAction(this.frameSelector!, {
        action: action === "click" ? "click" : "fill",
        targetSelector: selector,
        value: input.value,
      });
      return { ok: true, count: 1, matches: [] };
    }
    throw this.frameError(String(action));
  }

  private async target(): Promise<{ match?: NonNullable<LocatorResult["matches"]>[number]; count: number; error?: string }> {
    const result = await this.run("list");
    const match = result.matches?.[0];
    return { match, count: result.count ?? 0, ...(result.ok === false ? { error: result.error ?? "locator failed" } : {}) };
  }

  private async center(): Promise<{ x: number; y: number }> {
    const { match, error } = await this.target();
    if (error || !match) throw new Error(error ?? "Locator matched no element");
    if (!match.visible) throw new Error("Matched element is not visible");
    await this.run("scrollIntoView");
    const refreshed = (await this.run("list")).matches?.[0] ?? match;
    return { x: refreshed.box.x + refreshed.box.width / 2, y: refreshed.box.y + refreshed.box.height / 2 };
  }

  async count(): Promise<number> {
    const result = await this.run("count");
    return numberArg(result.count);
  }

  async all(): Promise<PlaywrightLocator[]> {
    const total = await this.count();
    return Array.from({ length: total }, (_, index) => this.nth(index));
  }

  async allTextContents(options: { timeoutMs?: number } = {}): Promise<string[]> {
    void options;
    const result = await this.run("evaluateAll", { fn: "return el.textContent;" });
    return Array.isArray(result.value) ? result.value.map((item) => String(item ?? "")) : [];
  }

  async textContent(options: { timeoutMs?: number } = {}): Promise<string | null> {
    void options;
    const result = await this.run("textContent");
    return result.value === undefined ? null : String(result.value);
  }

  async innerText(options: { timeoutMs?: number } = {}): Promise<string> {
    void options;
    const result = await this.run("innerText");
    return String(result.value ?? "");
  }

  async getAttribute(name: string, options: { timeoutMs?: number } = {}): Promise<string | null> {
    void options;
    const result = await this.run("attribute", { attribute: name });
    return result.value === undefined ? null : (result.value as string | null);
  }

  async isVisible(): Promise<boolean> { return (await this.run("isVisible")).value === true; }
  async isEnabled(): Promise<boolean> { return (await this.run("isEnabled")).value === true; }
  async isChecked(): Promise<boolean> { return (await this.run("isChecked")).value === true; }

  async click(options: { button?: "left" | "right" | "middle"; clickCount?: number; timeoutMs?: number } = {}): Promise<void> {
    if (this.frameSelector) {
      const result = await this.run("click");
      if (result.ok === false) throw new Error(result.error ?? "frame click failed");
      return;
    }
    void options;
    const { x, y } = await this.center();
    const button = options.button ?? "left";
    const clickCount = Math.max(1, numberArg(options.clickCount, 1));
    await this.host.input({ type: "mouseMove", x, y });
    await this.host.input({ type: "mouseDown", x, y, button, clickCount });
    await this.host.input({ type: "mouseUp", x, y, button, clickCount });
  }

  async dblclick(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.frameSelector) return this.click();
    void options;
    await this.click({ clickCount: 2 });
  }

  async hover(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.frameSelector) throw this.frameError("hover");
    void options;
    const { x, y } = await this.center();
    await this.host.input({ type: "mouseMove", x, y });
  }

  async fill(value: string, options: { timeoutMs?: number } = {}): Promise<void> {
    void options;
    const result = await this.run("fill", { value: String(value ?? "") });
    if (result.ok === false) throw new Error(result.error ?? "fill failed");
  }

  async type(value: string, options: { timeoutMs?: number } = {}): Promise<void> {
    void options;
    const result = await this.run("type", { value: String(value ?? "") });
    if (result.ok === false) throw new Error(result.error ?? "type failed");
  }

  async press(key: string, options: { timeoutMs?: number } = {}): Promise<void> {
    void options;
    await this.run("focus");
    await this.host.input({ type: "keyDown", keyCode: key });
    await this.host.input({ type: "keyUp", keyCode: key });
  }

  async pressSequentially(value: string, options: { timeoutMs?: number } = {}): Promise<void> {
    void options;
    await this.run("focus");
    for (const char of String(value ?? "")) {
      await this.host.insertText(char);
      await sleep(0);
    }
  }

  async check(options: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
    void options;
    const result = await this.run("check");
    if (result.ok === false) throw new Error(result.error ?? "check failed");
  }

  async uncheck(options: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
    void options;
    const result = await this.run("uncheck");
    if (result.ok === false) throw new Error(result.error ?? "uncheck failed");
  }

  async setChecked(checked: boolean, options: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
    void options;
    const result = await this.run("setChecked", { checked });
    if (result.ok === false) throw new Error(result.error ?? "setChecked failed");
  }

  async selectOption(value: string | string[] | Array<{ value?: string; label?: string; index?: number }>): Promise<void> {
    const values = Array.isArray(value)
      ? value.map((item) => (typeof item === "string" ? item : String(item.value ?? item.label ?? "")))
      : [String(value)];
    const result = await this.run("selectOption", { values });
    if (result.ok === false) throw new Error(result.error ?? "selectOption failed");
  }

  async waitFor(options: { state: State; timeoutMs?: number }): Promise<void> {
    const state: State = options.state ?? "visible";
    const timeout = Math.max(0, numberArg(options.timeoutMs, 30_000));
    const deadline = Date.now() + timeout;
    for (;;) {
      const result = await this.run("list");
      const match = result.matches?.[0];
      const attached = Boolean(match);
      const visible = Boolean(match?.visible);
      const done = state === "attached" ? attached
        : state === "detached" ? !attached
          : state === "visible" ? visible
            : !visible;
      if (done) return;
      if (Date.now() >= deadline) throw new Error(`locator did not become ${state} in ${timeout}ms`);
      await sleep(100);
    }
  }

  async evaluate<TArg, TResult>(fn: string | ((element: unknown, arg: TArg) => TResult | Promise<TResult>), arg?: TArg): Promise<TResult> {
    const source = typeof fn === "function" ? fn.toString() : fn;
    const result = await this.run("evaluate", { fn: source, arg });
    if (result.ok === false) throw new Error(result.error ?? "evaluate failed");
    return result.value as TResult;
  }

  async evaluateAll<TArg, TResult>(fn: string | ((elements: Array<unknown>, arg: TArg) => TResult | Promise<TResult>), arg?: TArg): Promise<TResult> {
    const source = typeof fn === "function" ? fn.toString() : fn;
    const result = await this.run("evaluateAll", { fn: source, arg });
    if (result.ok === false) throw new Error(result.error ?? "evaluateAll failed");
    return result.value as TResult;
  }

  async downloadMedia(options: { timeoutMs?: number } = {}): Promise<string> {
    void options;
    const result = await this.run("mediaUrl");
    const url = String(result.value ?? "");
    if (!url) throw new Error("matched element has no media URL");
    const saved = (await this.host.download(url)) as { path?: string } | null;
    return String(saved?.path ?? "");
  }

  async expectNavigation<T>(action: () => Promise<T>, options: { timeoutMs?: number; url?: string } = {}): Promise<T> {
    const before = await this.host.evaluate("location.href");
    const result = await action();
    const deadline = Date.now() + Math.max(100, options.timeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      const current = String(await this.host.evaluate("location.href") ?? "");
      if (current !== before && (!options.url || current.includes(options.url))) return result;
      await sleep(100);
    }
    throw new Error("expected navigation did not occur");
  }

  async elementScreenshot(options: { x: number; y: number }): Promise<string> {
    const geometry = await this.host.evaluate(`(() => {
      const el = document.elementsFromPoint(${Number(options.x)}, ${Number(options.y)})[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    })()`) as { x?: number; y?: number; width?: number; height?: number; viewportWidth?: number; viewportHeight?: number } | null;
    const shot = await this.host.screenshot() as { data?: string };
    if (!shot?.data || !geometry || typeof geometry.x !== "number" || typeof geometry.y !== "number") return shot?.data ?? "";
    const { nativeImage } = await import("electron");
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
    const size = image.getSize();
    const scaleX = size.width / Math.max(1, geometry.viewportWidth ?? size.width);
    const scaleY = size.height / Math.max(1, geometry.viewportHeight ?? size.height);
    const cropped = image.crop({
      x: Math.max(0, Math.round(geometry.x * scaleX)),
      y: Math.max(0, Math.round(geometry.y * scaleY)),
      width: Math.max(1, Math.round((geometry.width ?? 1) * scaleX)),
      height: Math.max(1, Math.round((geometry.height ?? 1) * scaleY)),
    });
    return cropped.toPNG().toString("base64");
  }

  async elementInfo(options: { x: number; y: number; includeNonInteractable?: boolean }): Promise<Array<Record<string, unknown>>> {
    return (await this.host.evaluate(`(() => {
      const x = ${Number(options.x)}; const y = ${Number(options.y)};
      return document.elementsFromPoint(x, y).slice(0, 8).map((el) => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 120), box: { x: r.x, y: r.y, width: r.width, height: r.height } };
      });
    })()`)) as Array<Record<string, unknown>>;
  }
}

/** Page-level Playwright surface: waits, snapshots, events. */
export class PlaywrightTab {
  private readonly host: LocatorHost;
  constructor(host: LocatorHost) { this.host = host; }

  locator(selector: string, options: LocatorQuery = {}) { return new PlaywrightLocator(this.host, { ...options, selector }); }
  getByRole(role: string, options: { exact?: boolean; name?: string } = {}) { return new PlaywrightLocator(this.host, { role, ...(options.name ? { name: options.name } : {}) }); }
  getByLabel(text: string) { return new PlaywrightLocator(this.host, { name: text }); }
  getByPlaceholder(text: string) { return new PlaywrightLocator(this.host, { placeholder: text }); }
  getByTestId(testId: string) { return new PlaywrightLocator(this.host, { testId }); }
  getByText(text: string, options: { exact?: boolean } = {}) { return new PlaywrightLocator(this.host, { text, ...(options.exact ? { hasText: text } : {}) }); }
  frameLocator(selector: string) { return new PlaywrightLocator(this.host, {}, selector); }

  async evaluate<TArg, TResult>(fn: string | ((arg: TArg) => TResult | Promise<TResult>), arg?: TArg): Promise<TResult> {
    const source = typeof fn === "function" ? fn.toString() : fn;
    return (await this.host.evaluate(`(${source})(${JSON.stringify(arg ?? null)})`)) as TResult;
  }

  async domSnapshot(): Promise<string> {
    return String(await this.host.evaluate(`(() => {
      const parts = [document.documentElement ? document.documentElement.outerHTML : ''];
      for (const frame of document.querySelectorAll('iframe, frame')) {
        try { if (frame.contentDocument) parts.push(frame.contentDocument.documentElement.outerHTML); } catch {}
      }
      return parts.join('\\n');
    })()`) ?? "");
  }

  async expectNavigation<T>(action: () => Promise<T>, options: { timeoutMs?: number; url?: string } = {}): Promise<T> {
    return new PlaywrightLocator(this.host, {}).expectNavigation(action, options);
  }
  elementInfo(options: { x: number; y: number; includeNonInteractable?: boolean }) {
    return new PlaywrightLocator(this.host, {}).elementInfo(options);
  }
  elementScreenshot(options: { x: number; y: number; includeNonInteractable?: boolean }) {
    return new PlaywrightLocator(this.host, {}).elementScreenshot(options);
  }

  async waitForTimeout(timeoutMs: number): Promise<void> {
    await sleep(Math.max(0, Math.min(60_000, numberArg(timeoutMs, 0))));
  }

  async waitForURL(url: string, options: { timeoutMs?: number; waitUntil?: string } = {}): Promise<void> {
    const needle = String(url ?? "");
    const timeout = Math.max(0, numberArg(options.timeoutMs, 30_000));
    const deadline = Date.now() + timeout;
    for (;;) {
      const current = String(await this.host.evaluate("location.href") ?? "");
      if (current === needle || (needle && current.includes(needle))) return;
      if (Date.now() >= deadline) throw new Error(`URL did not match ${needle} in ${timeout}ms`);
      await sleep(100);
    }
  }

  async waitForLoadState(options: { state?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number } = {}): Promise<void> {
    const state = options.state ?? "load";
    const timeout = Math.max(0, numberArg(options.timeoutMs, 30_000));
    if (state === "networkidle") {
      if (!this.host.networkIdle) throw new Error("networkidle is not available on this backend");
      await this.host.networkIdle(timeout, 500);
      return;
    }
    const deadline = Date.now() + timeout;
    for (;;) {
      const ready = String(await this.host.evaluate("document.readyState") ?? "");
      if (state === "domcontentloaded" ? ready !== "loading" : ready === "complete") return;
      if (Date.now() >= deadline) throw new Error(`load state ${state} not reached in ${timeout}ms`);
      await sleep(100);
    }
  }

  async waitForEvent(event: "download" | "filechooser", options: { timeoutMs?: number } = {}): Promise<unknown> {
    const timeout = Math.max(0, numberArg(options.timeoutMs, 120_000));
    if (event === "download") {
      if (!this.host.waitForDownload) throw new Error("download events are not available on this backend");
      const record = (await this.host.waitForDownload(timeout)) as { path?: string; url?: string; filename?: string } | null;
      return {
        path: async () => record?.path ?? null,
        suggestedFilename: () => record?.filename ?? null,
        url: () => record?.url ?? null,
      };
    }
    if (!this.host.waitForFileChooser) throw new Error("filechooser events are not available on this backend");
    const chooser = (await this.host.waitForFileChooser(timeout)) as { mode?: string } | null;
    return {
      isMultiple: () => String(chooser?.mode ?? "").includes("Multiple"),
      setFiles: async (files: string | string[]) => {
        if (!this.host.setFileChooserFiles) throw new Error("setFiles is not available on this backend");
        await this.host.setFileChooserFiles(Array.isArray(files) ? files : [files]);
      },
    };
  }
}
