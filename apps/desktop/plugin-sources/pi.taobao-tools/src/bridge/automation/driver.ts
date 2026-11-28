"use strict";

/**
 * Page driver for automation runs: the conversation's browser pane, one page
 * at a time.
 *
 * The DSL needs a page that can evaluate JavaScript and navigate; clicks,
 * typing, scrolling and waits are expressions evaluated in that page. CDP is
 * used only where a page script cannot reach: file inputs, closed shadow
 * roots, accessibility nodes, trusted pointer/keyboard input and screenshots.
 *
 * This is the JavaScript port of QiWork's `automation/driver.py`, bound to
 * PI-Desktop's `pi.browser` plugin API instead of a local CDP socket.
 */

import { codedError } from "./errors";
import type { Capture } from "./types";

type NetFacade = {
  fetch(input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    responseType?: "text" | "base64";
    maxResponseBytes?: number;
    redirect?: "follow" | "error" | "manual";
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    bodyText: string;
    bodyBase64?: string;
    contentType?: string;
    byteLength?: number;
  }>;
};

export type BinaryFetchResult = {
  bytes: Buffer;
  status: number;
  contentType: string;
};
import * as fs from "node:fs";
import * as path from "node:path";



type CdpException = { exception?: { description?: string }; text?: string };
type CdpEvalResult = {
  result?: { objectId?: string; value?: unknown };
  exceptionDetails?: CdpException;
};
type CdpObjectResult = { object?: { objectId?: string } };
type CdpFunctionResult = {
  result?: { value?: unknown };
  exceptionDetails?: CdpException;
};
type CdpNode = {
  backendNodeId?: number;
  nodeId?: number;
  shadowRootType?: string;
  shadowRoots?: CdpNode[];
  children?: CdpNode[];
};
type CdpDescribe = { node?: CdpNode };
type CdpDocument = { root?: CdpNode };
type CdpAxNode = {
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
};
type CdpAxTree = { nodes?: CdpAxNode[] };
type CdpScreenshot = { data?: string };

type BrowserFacade = {
  reveal(input?: { sessionId?: string; tabId?: string }): Promise<void>;
  navigate(input: {
    url?: string;
    path?: string;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
  evaluateNative(input: {
    expression?: string;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
  insertText?(input: {
    text: string;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
  cdp(input: {
    method: string;
    params?: unknown;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
  input(input: {
    method: string;
    params?: unknown;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
};

type DriverOptions = {
  browser: BrowserFacade;
  net?: NetFacade;
  sessionId?: string;
  tabId?: string;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

type ScopedInput = { sessionId?: string; tabId?: string; [key: string]: unknown };

const READY_TIMEOUT_SECONDS = 30;
const SNAPSHOT_SCRIPT =
  "({ url: location.href, title: document.title," +
  " body: (document.body ? document.body.innerText : '').slice(0, 1500) })";

/** Two keys are all the publishing scripts need, and both must be trusted. */
const KEYS: Record<
  string,
  { code: string; keyCode: number; text: string | null }
> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Space: { code: "Space", keyCode: 32, text: " " },
  Tab: { code: "Tab", keyCode: 9, text: null },
};


const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, message?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(codedError("AUTOMATION_TIMEOUT", message || "页面脚本执行超时")),
      Math.max(1000, Number(timeoutMs) || 60_000),
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function boxOfModel(model: unknown): Record<string, number> | null {
  const record = model && typeof model === "object" ? (model as Record<string, unknown>) : null;
  const inner = record && record.model && typeof record.model === "object"
    ? (record.model as Record<string, unknown>)
    : null;
  const content = inner && inner.content;
  if (!Array.isArray(content) || content.length !== 8) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index < 8; index += 2) {
    xs.push(Number(content[index]));
    ys.push(Number(content[index + 1]));
  }
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function findNode(node: CdpNode | undefined, backendNodeId: number): CdpNode | null {
  if (!node) return null;
  if (Number(node.backendNodeId || 0) === backendNodeId) return node;
  const children = [
    ...(Array.isArray(node.children) ? node.children : []),
    ...(Array.isArray(node.shadowRoots) ? node.shadowRoots : []),
  ];
  for (const child of children) {
    const found = findNode(child, backendNodeId);
    if (found) return found;
  }
  return null;
}

function parseCaptures(raw: unknown): Capture[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value)
      ? (value.filter((item) => item && typeof item === "object") as Capture[])
      : [];
  } catch (error) {
    return [];
  }
}

function readCapturesExpression() {
  return (
    "JSON.stringify(window.__qiworkAutomation" +
    " && window.__qiworkAutomation.captures || [])"
  );
}

/**
 * One page in the conversation's pane, driven through `pi.browser`.
 *
 * `browser` is the plugin API facade:
 *   reveal(), navigate(input), evaluateNative(input), insertText(input),
 *   cdp(input), input(input), screenshot(input)
 */
function createDriver({
  browser,
  net,
  sessionId,
  tabId,
  signal,
  sleep = sleepDefault,
  log = () => {},
}: DriverOptions) {
  if (!browser) {
    throw codedError(
      "AUTOMATION_BROWSER_UNAVAILABLE",
      "自动化需要 PI-Desktop 的浏览器面板；请先打开当前对话的 Browser 页签后重试",
    );
  }

  const scoped = <T extends Record<string, unknown>>(
    input: T,
  ): T & { sessionId?: string; tabId?: string } => {
    const payload: T & { sessionId?: string; tabId?: string } = { ...input };
    if (sessionId) payload.sessionId = sessionId;
    if (tabId) payload.tabId = tabId;
    return payload;
  };

  const checkAbort = () => {
    if (signal && signal.aborted) {
      throw codedError("ABORTED", "自动化已中止");
    }
  };

  const unwrap = (result: unknown): unknown => {
    const record = result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : null;
    if (
      record &&
      typeof record.savedTo === "string" &&
      record.preview !== undefined
    ) {
      try {
        return JSON.parse(fs.readFileSync(record.savedTo, "utf8"));
      } catch (error) {
        return result;
      }
    }
    return result;
  };

  const cdp = async <T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> => {
    checkAbort();
    const result = await browser.cdp(scoped({ method, params }));
    return unwrap(result) as T;
  };

  const input = async (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> => {
    checkAbort();
    return browser.input(scoped({ method, params }));
  };

  const evaluateNative = async (expression: string): Promise<unknown> => {
    checkAbort();
    try {
      return await browser.evaluateNative(scoped({ expression }));
    } catch (error) {
      const message = String((error as Error)?.message || error);
      if (/no page|not started|unavailable|尚未|还没有|未打开/i.test(message)) {
        throw codedError(
          "AUTOMATION_NO_PAGE",
          "自动化页面尚未打开；请先在右侧 Browser 中打开目标页面后重试",
        );
      }
      throw error;
    }
  };

  // The host detaches the CDP session after each command, so a
  // `Page.addScriptToEvaluateOnNewDocument` registration cannot be relied on
  // to survive a navigation. Remember what was installed and re-apply it
  // after every load; the current document gets an explicit evaluation too.
  const installedSources: string[] = [];
  const reinstall = async () => {
    for (const source of installedSources) {
      try {
        await cdp("Page.enable", {});
        await cdp("Page.addScriptToEvaluateOnNewDocument", { source });
      } catch (error) {
        // Registration is best effort; the explicit evaluation below is what
        // makes the current document work.
      }
      try {
        await evaluateNative(source);
      } catch (error) {
        // A page that changed origin mid-load will be retried next time.
      }
    }
  };

  const waitReady = async (
    timeoutMs: number = READY_TIMEOUT_SECONDS * 1000,
  ): Promise<void> => {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 0);
    while (Date.now() < deadline) {
      checkAbort();
      try {
        const ready = await evaluateNative("document.readyState");
        if (ready === "complete") {
          // A short settle keeps the first assertion off a half-painted page.
          await sleep(150);
          return;
        }
      } catch (error) {
        // The previous document is being replaced; ask again.
      }
      await sleep(200);
    }
  };

  const reveal = async () => {
    if (typeof browser.reveal !== "function") return;
    try {
      await browser.reveal(scoped({}));
    } catch (error) {
      log(`reveal skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const driver = {
    /** Attach to the pane's page without navigating it. */
    async attach() {
      await reveal();
    },

    async open(url: string, { timeout = 60_000 }: { timeout?: number } = {}) {
      if (!url) {
        throw codedError("AUTOMATION_BAD_SCRIPT", "自动化缺少起始地址");
      }
      await reveal();
      await browser.navigate(scoped({ url: String(url) }));
      await waitReady(Math.min(timeout, READY_TIMEOUT_SECONDS * 1000));
      await reinstall();
    },

    async navigate(url: string, { timeout = 60_000 }: { timeout?: number } = {}) {
      if (!url) {
        throw codedError("AUTOMATION_BAD_SCRIPT", "navigate 缺少 URL");
      }
      await reveal();
      await browser.navigate(scoped({ url: String(url) }));
      await waitReady(Math.min(timeout, READY_TIMEOUT_SECONDS * 1000));
      await reinstall();
    },

    async reload({ timeout = 60_000 }: { timeout?: number } = {}) {
      await cdp("Page.reload", {});
      await waitReady(Math.min(timeout, READY_TIMEOUT_SECONDS * 1000));
      await reinstall();
    },

    async evaluate(
      expression: string,
      { returnByValue = true, timeoutMs = 60_000 }: { returnByValue?: boolean; timeoutMs?: number } = {},
    ) {
      checkAbort();
      const work = returnByValue
        ? evaluateNative(expression)
        : cdp<CdpEvalResult>("Runtime.evaluate", {
            expression,
            returnByValue: false,
            awaitPromise: true,
          }).then((output) => {
            if (output && output.exceptionDetails) {
              const remote = output.exceptionDetails.exception || {};
              throw codedError(
                "AUTOMATION_PAGE_ERROR",
                String(
                  remote.description ||
                    output.exceptionDetails.text ||
                    "页面脚本执行失败",
                ),
              );
            }
            return output && output.result ? output.result : output;
          });
      return raceTimeout(work, timeoutMs);
    },

    async currentUrl() {
      try {
        return String((await evaluateNative("location.href")) || "");
      } catch (error) {
        return "";
      }
    },

    async pageSnapshot(): Promise<Record<string, unknown>> {
      try {
        const value = await evaluateNative(SNAPSHOT_SCRIPT);
        return value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      } catch (error) {
        return {};
      }
    },

    async movePointer(x: number, y: number) {
      await input("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Number(x),
        y: Number(y),
      });
    },

    /**
     * Press at a point after putting the pointer there first. The move is not
     * decoration: the page reads it (hover state, menus that open on approach)
     * and the pane draws the agent's hand from it.
     */
    async clickAt(
      x: number,
      y: number,
      { count = 1 }: { count?: number } = {},
    ) {
      try {
        await this.movePointer(x, y);
      } catch (error) {
        // The press is what the script asked for.
      }
      const press = {
        type: "mousePressed",
        x: Number(x),
        y: Number(y),
        button: "left",
        clickCount: Math.max(1, Number(count) || 1),
      };
      await input("Input.dispatchMouseEvent", press);
      try {
        await input("Input.dispatchMouseEvent", { ...press, type: "mouseReleased" });
      } catch (error) {
        // The press may already have taken the page away; that is success.
      }
    },

    async insertText(text: string) {
      if (!text) return;
      checkAbort();
      if (typeof browser.insertText === "function") {
        await browser.insertText(scoped({ text: String(text) }));
        return;
      }
      await input("Input.insertText", { text: String(text) });
    },

    async pressKey(key: string) {
      const named = KEYS[String(key)];
      if (!named) {
        throw codedError("AUTOMATION_BAD_SCRIPT", `不支持的按键：${key}`);
      }
      const down: Record<string, unknown> = {
        type: named.text ? "keyDown" : "rawKeyDown",
        key: String(key),
        code: named.code,
        windowsVirtualKeyCode: named.keyCode,
        nativeVirtualKeyCode: named.keyCode,
      };
      if (named.text) {
        down.text = named.text;
        down.unmodifiedText = named.text;
      }
      await input("Input.dispatchKeyEvent", down);
      await input("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: String(key),
        code: named.code,
        windowsVirtualKeyCode: named.keyCode,
        nativeVirtualKeyCode: named.keyCode,
      });
    },

    /** Evaluate *expression* and return the remote object id it produced. */
    async resolveObject(expression: string): Promise<string> {
      const output = await cdp<CdpEvalResult>("Runtime.evaluate", {
        expression,
        returnByValue: false,
        awaitPromise: true,
      });
      if (output && output.exceptionDetails) {
        const remote = output.exceptionDetails.exception || {};
        throw codedError(
          "AUTOMATION_TARGET_NOT_FOUND",
          String(remote.description || "无法定位页面元素"),
        );
      }
      const objectId = String(
        (output && output.result && output.result.objectId) || "",
      );
      if (!objectId) {
        throw codedError("AUTOMATION_TARGET_NOT_FOUND", "未找到页面元素");
      }
      return objectId;
    },

    /** Hand *files* to the file input *expression* resolves to. */
    async setFiles(expression: string, files: string[]) {
      const objectId = await this.resolveObject(expression);
      await cdp("DOM.enable", {});
      await cdp("DOM.setFileInputFiles", {
        files: files.map((file) => String(file)),
        objectId,
      });
    },

    async setFilesOnObject(objectId: string, files: string[]) {
      await cdp("DOM.enable", {});
      await cdp("DOM.setFileInputFiles", {
        files: files.map((file) => String(file)),
        objectId: String(objectId),
      });
    },

    async setFilesOn(
      files: string[],
      { nodeId = 0, backendId = 0 }: { nodeId?: number; backendId?: number } = {},
    ) {
      await cdp("DOM.enable", {});
      const params: Record<string, unknown> = {
        files: files.map((file) => String(file)),
      };
      if (nodeId) params.nodeId = Number(nodeId);
      else if (backendId) params.backendNodeId = Number(backendId);
      else {
        throw codedError("AUTOMATION_BAD_SCRIPT", "缺少文件输入框节点");
      }
      await cdp("DOM.setFileInputFiles", params);
    },

    async describeShadowRoot(expression: string) {
      await cdp("DOM.enable", {});
      let objectId;
      try {
        objectId = await this.resolveObject(expression);
      } catch (error) {
        return null;
      }
      const described = await cdp<CdpDescribe>("DOM.describeNode", {
        objectId,
        depth: 1,
        pierce: true,
      });
      const node: CdpNode = (described && described.node) || {};
      let roots = Array.isArray(node.shadowRoots) ? node.shadowRoots : [];
      if (!roots.length && node.backendNodeId) {
        const document = await cdp<CdpDocument>("DOM.getDocument", { depth: -1, pierce: true });
        const host = findNode(document && document.root, Number(node.backendNodeId));
        roots = host && Array.isArray(host.shadowRoots) ? host.shadowRoots : [];
      }
      for (const root of roots) {
        if (Number(root.nodeId || 0)) {
          return {
            nodeId: Number(root.nodeId),
            type: String(root.shadowRootType || ""),
          };
        }
      }
      return null;
    },

    /**
     * Resolve a control inside a **closed** shadow root, by object id.
     *
     * `DOM.describeNode(pierce: true)` exposes the closed root, but its
     * `nodeId` is 0 in some CDP bridges even after `DOM.enable` — so nothing
     * may depend on it. The root's `backendNodeId` always resolves.
     */
    async resolveShadowElement(hostExpression: string, selector: string) {
      await cdp("DOM.enable", {});
      let hostObject;
      try {
        hostObject = await this.resolveObject(hostExpression);
      } catch (error) {
        return null;
      }
      const described = await cdp<CdpDescribe>("DOM.describeNode", {
        objectId: hostObject,
        depth: 1,
        pierce: true,
      });
      const roots = (described && described.node && described.node.shadowRoots) || [];
      if (!roots.length) return null;
      const backend = Number(roots[0].backendNodeId || 0);
      if (!backend) return null;
      const resolved = await cdp<CdpObjectResult>("DOM.resolveNode", { backendNodeId: backend });
      const rootObject = String(
        (resolved && resolved.object && resolved.object.objectId) || "",
      );
      if (!rootObject) return null;
      const output = await cdp<CdpEvalResult>("Runtime.callFunctionOn", {
        objectId: rootObject,
        functionDeclaration:
          "function (selector) {" +
          " try { return this.querySelector(selector); }" +
          " catch (error) { return null; }" +
          " }",
        arguments: [{ value: selector }],
        returnByValue: false,
      });
      const elementObject = String(
        (output && output.result && output.result.objectId) || "",
      );
      if (!elementObject) return null;
      const box = (await this.objectBox(elementObject)) || {};
      const state = await this.objectState(elementObject);
      return {
        mode: "object",
        objectId: elementObject,
        box,
        editable: Boolean(state.editable),
        tag: String(state.tag || ""),
        disabled: Boolean(state.disabled),
        shadowRootType: String(roots[0].shadowRootType || ""),
      };
    },

    async callOnObject(
      objectId: string,
      declaration: string,
      { arguments: args = [] }: { arguments?: unknown[] } = {},
    ) {
      const value = String(objectId || "");
      if (!value) {
        throw codedError("AUTOMATION_TARGET_NOT_FOUND", "无法定位页面元素");
      }
      const output = await cdp<CdpFunctionResult>("Runtime.callFunctionOn", {
        objectId: value,
        functionDeclaration: declaration,
        arguments: (args || []).map((item) => ({ value: item })),
        returnByValue: true,
      });
      if (output && output.exceptionDetails) {
        const remote = output.exceptionDetails.exception || {};
        throw codedError(
          "AUTOMATION_PAGE_ERROR",
          String(remote.description || output.exceptionDetails.text || "页面脚本执行失败"),
        );
      }
      return output && output.result ? output.result.value : undefined;
    },

    async objectBox(objectId: string) {
      const value = await this.callOnObject(
        objectId,
        "function () {" +
          " const rect = this.getBoundingClientRect();" +
          " return { left: rect.left, top: rect.top," +
          " width: rect.width, height: rect.height }; }",
      );
      return value && typeof value === "object" ? value : null;
    },

    async objectState(
      objectId: string,
    ): Promise<{ editable?: boolean; tag?: string; disabled?: boolean }> {
      const value = await this.callOnObject(
        objectId,
        "function () { return {" +
          " tag: String(this.tagName || '').toUpperCase()," +
          " editable: Boolean(this.isContentEditable)" +
          "   || this.tagName === 'INPUT' || this.tagName === 'TEXTAREA'," +
          " disabled: Boolean(this.disabled)" +
          "   || String(this.getAttribute && this.getAttribute('aria-disabled')" +
          "     || '') === 'true'" +
          " }; }",
      );
      return value && typeof value === "object" ? value : {};
    },

    async focusObject(objectId: string) {
      await this.callOnObject(
        objectId,
        "function () { if (this.focus) this.focus(); return true; }",
      );
    },

    async clickObject(objectId: string) {
      const clicked = await this.callOnObject(
        objectId,
        "function () { this.click(); return true; }",
      );
      if (!clicked) {
        throw codedError("AUTOMATION_TARGET_NOT_FOUND", "控件未能点击");
      }
    },

    async callOnNode(
      nodeId: number,
      declaration: string,
      { arguments: args = [] }: { arguments?: unknown[] } = {},
    ) {
      await cdp("DOM.enable", {});
      const resolved = await cdp<CdpObjectResult>("DOM.resolveNode", { nodeId: Number(nodeId) });
      return this.callOnObject(
        (resolved && resolved.object && resolved.object.objectId) || "",
        declaration,
        { arguments: args },
      );
    },

    async callOnBackendNode(
      backendNodeId: number,
      declaration: string,
      { arguments: args = [] }: { arguments?: unknown[] } = {},
    ) {
      await cdp("DOM.enable", {});
      const resolved = await cdp<CdpObjectResult>("DOM.resolveNode", {
        backendNodeId: Number(backendNodeId),
      });
      return this.callOnObject(
        (resolved && resolved.object && resolved.object.objectId) || "",
        declaration,
        { arguments: args },
      );
    },

    async nodeState(
      { nodeId = 0, backendId = 0 }: { nodeId?: number; backendId?: number } = {},
    ): Promise<Record<string, unknown>> {
      const declaration =
        "function () { return {" +
        " tag: String(this.tagName || '').toUpperCase()," +
        " editable: Boolean(this.isContentEditable)" +
        "   || this.tagName === 'INPUT' || this.tagName === 'TEXTAREA'" +
        " }; }";
      if (nodeId) {
        const value = await this.callOnNode(Number(nodeId), declaration);
        return value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      }
      const value = await this.callOnBackendNode(Number(backendId || 0), declaration);
      return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    },

    async focusNode(
      { nodeId = 0, backendId = 0 }: { nodeId?: number; backendId?: number } = {},
    ) {
      await cdp("DOM.enable", {});
      const params = nodeId
        ? { nodeId: Number(nodeId) }
        : { backendNodeId: Number(backendId || 0) };
      await cdp("DOM.focus", params);
    },

    async clickNode(nodeId: number) {
      const clicked = await this.callOnNode(
        nodeId,
        "function () { this.click(); return true; }",
      );
      if (!clicked) {
        throw codedError("AUTOMATION_TARGET_NOT_FOUND", "控件未能点击");
      }
    },

    async clickBackendNode(backendNodeId: number) {
      const clicked = await this.callOnBackendNode(
        backendNodeId,
        "function () { this.click(); return true; }",
      );
      if (!clicked) {
        throw codedError("AUTOMATION_TARGET_NOT_FOUND", "控件未能点击");
      }
    },

    async nodeBoxByBackend(backendNodeId: number) {
      await cdp("DOM.enable", {});
      const model = await cdp("DOM.getBoxModel", {
        backendNodeId: Number(backendNodeId),
      });
      return boxOfModel(model);
    },

    async shadowButtons(hostExpression: string, { limit = 6 }: { limit?: number } = {}) {
      await cdp("DOM.enable", {});
      let hostObject;
      try {
        hostObject = await this.resolveObject(hostExpression);
      } catch (error) {
        return [];
      }
      const described = await cdp<CdpDescribe>("DOM.describeNode", {
        objectId: hostObject,
        depth: 1,
        pierce: true,
      });
      const roots = (described && described.node && described.node.shadowRoots) || [];
      if (!roots.length) return [];
      const backend = Number(roots[0].backendNodeId || 0);
      if (!backend) return [];
      const resolved = await cdp<CdpObjectResult>("DOM.resolveNode", { backendNodeId: backend });
      const rootObject = String(
        (resolved && resolved.object && resolved.object.objectId) || "",
      );
      if (!rootObject) return [];
      const output = await cdp<CdpFunctionResult>("Runtime.callFunctionOn", {
        objectId: rootObject,
        functionDeclaration:
          "function (limit) {" +
          " return Array.from(this.querySelectorAll(" +
          "   'button, [role=\"button\"]'" +
          " )).slice(0, limit).map(function (el) {" +
          "   return {" +
          "     text: (el.innerText || '').trim().slice(0, 60)," +
          "     html: String(el.outerHTML || '').slice(0, 90)" +
          "   };" +
          " });" +
          " }",
        arguments: [{ value: Number(limit) }],
        returnByValue: true,
      });
      const value = output && output.result ? output.result.value : [];
      return Array.isArray(value)
        ? value.filter((item) => item && typeof item === "object")
        : [];
    },

    /**
     * Backend node id of a control by its accessible name. The accessibility
     * tree contains content inside **closed** shadow roots, which no page
     * script and no CSS selector can reach.
     */
    async findAxNode(name: string, { role = "button" }: { role?: string } = {}) {
      const wanted = String(name || "").trim();
      if (!wanted) return 0;
      await cdp("Accessibility.enable", {});
      const tree = await cdp<CdpAxTree>("Accessibility.getFullAXTree", {});
      for (const node of (tree && tree.nodes) || []) {
        if (!node || node.ignored) continue;
        if (String((node.role && node.role.value) || "") !== role) continue;
        const value = String((node.name && node.name.value) || "").trim();
        if (value !== wanted) continue;
        const backend = Number(node.backendDOMNodeId || 0);
        if (backend) return backend;
      }
      return 0;
    },

    /**
     * Fetch raw bytes for an upload file. The host fetch runs in the main
     * process against `net.anyHost`, so an image CDN that does not send CORS
     * headers still works; the page fetch is the fallback when the host has no
     * binary response support.
     */
    async fetchBinary(url: string): Promise<BinaryFetchResult> {
      const cleaned = String(url || "").trim();
      if (net) {
        try {
          let referer = "";
          try {
            referer = `${new URL(cleaned).origin}/`;
          } catch (error) {
            referer = "";
          }
          const result = await net.fetch({
            url: cleaned,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              ...(referer ? { Referer: referer } : {}),
            },
            responseType: "base64",
            maxResponseBytes: 32 * 1024 * 1024,
            timeoutMs: 60_000,
            redirect: "follow",
          });
          if (result.status >= 200 && result.status < 300 && result.bodyBase64) {
            return {
              bytes: Buffer.from(result.bodyBase64, "base64"),
              status: result.status,
              contentType: String(result.contentType || ""),
            };
          }
        } catch (error) {
          // The host may refuse the host or lack binary responses; the page
          // fetch below still has the browser's cookies and same-origin path.
        }
      }
      const encoded = (await evaluateNative(
        "(async () => {\n" +
          `  const response = await fetch(${JSON.stringify(cleaned)}, { credentials: 'include' });\n` +
          "  if (!response.ok) return { ok: false, status: response.status, contentType: '' };\n" +
          "  const bytes = new Uint8Array(await response.arrayBuffer());\n" +
          "  let binary = ''; const chunk = 0x8000;\n" +
          "  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));\n" +
          "  return { ok: true, status: response.status, contentType: response.headers.get('content-type') || '', data: btoa(binary) };\n" +
          "})()",
      )) as { ok?: boolean; status?: number; contentType?: string; data?: string };
      if (!encoded || encoded.ok !== true || typeof encoded.data !== "string") {
        throw codedError(
          "AUTOMATION_UPLOAD_INVALID",
          `图片下载失败${encoded?.status ? ` HTTP ${encoded.status}` : ""}：${cleaned}`,
        );
      }
      return {
        bytes: Buffer.from(encoded.data, "base64"),
        status: Number(encoded.status) || 200,
        contentType: String(encoded.contentType || ""),
      };
    },

    async capture(targetPath: string): Promise<string> {
      const output = await cdp<CdpScreenshot>("Page.captureScreenshot", { format: "png" });
      const data = String((output && output.data) || "");
      if (!data) return "";
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, Buffer.from(data, "base64"));
      return String(targetPath);
    },

    /** Install *source* in this document and every later document. */
    async install(source: string) {
      if (!source) return;
      if (!installedSources.includes(source)) installedSources.push(source);
      await cdp("Page.enable", {});
      await cdp("Page.addScriptToEvaluateOnNewDocument", { source });
      await evaluateNative(source);
    },

    /** Keep the tab: returning control must not blank the user's pane. */
    async close() {},

    // Exposed for tests and for the executor's failure metadata.
    waitReady,
    reinstall,
    hasInstalledSources: () => installedSources.length > 0,
    cdp,
    input,
    sleep,
  };

  return driver;
}

export type Driver = ReturnType<typeof createDriver>;

export {
  KEYS,
  READY_TIMEOUT_SECONDS,
  createDriver,
  parseCaptures,
  readCapturesExpression,
};
