"use strict";

/**
 * Page-script runner over the extension bridge.
 *
 * Ported from qwenpaw `mcp/src/runner.js`, minus the enterprise-account
 * recovery machinery: this build targets the user's own Chrome profile, so a
 * login is something the user does in their browser, never something the tool
 * performs for them.
 *
 * The guard before every business script mirrors the original: refuse to run
 * when the tab is on a login page, a risk-control page, or a different origin
 * than the scene it claims to be, and keep the tab open in those cases so the
 * user can finish the login or the captcha by hand.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DATA_ROOT = path.join(__dirname, "..", "data");

const SCENES: Record<string, string> = {
  sycm: "https://sycm.taobao.com",
  taobao: "https://sale.taobao.com",
  myseller: "https://myseller.taobao.com/home.htm",
  sale: "https://sale.taobao.com",
  dmp: "https://dmp.taobao.com",
  alimama: "https://one.alimama.com/index.html",
  databank: "https://databank.tmall.com",
};

const RISK_PATTERN = /rgv587|punish|captcha|风控|安全策略|429|rate limit|限流/i;

function inside(root: string, candidate: string): string {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`脚本路径越界：${candidate}`);
  }
  return resolved;
}

function requiredArgs(entry: RegistryEntry | undefined): string[] {
  return Object.entries(entry && entry.args ? entry.args : {})
    .filter(([, hint]) => typeof hint === "string" && hint.includes("必填"))
    .map(([key]) => key);
}

export type RegistryEntry = {
  path: string;
  scene?: string;
  desc?: string;
  args?: Record<string, string>;
  [key: string]: unknown;
};

export type MerchantBrowser = {
  reveal(input?: { sessionId?: string; tabId?: string }): Promise<void>;
  navigate(input: {
    url: string;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
  evaluateNative(input: {
    expression: string;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
  evaluate?(input: {
    expression: string;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
};

export type MerchantBrowserBinding = {
  browser: MerchantBrowser;
  sessionId?: string;
  tabId?: string;
};

class MerchantRunner {
  private browser: MerchantBrowser;
  private sessionId?: string;
  private tabId?: string;
  private opened = false;

  constructor({ browser, sessionId, tabId }: MerchantBrowserBinding) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.tabId = tabId;
  }

  private scoped(input: Record<string, unknown> = {}) {
    return {
      ...input,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.tabId ? { tabId: this.tabId } : {}),
    };
  }

  async open(scene = "sycm"): Promise<void> {
    const url = SCENES[scene];
    if (!url) throw new Error(`未知场景：${scene}`);
    if (this.opened) return;
    await this.browser.reveal(this.scoped());
    await this.browser.navigate(this.scoped({ url }) as { url: string });
    this.opened = true;
  }

  async evaluate(expression: string, scene: string): Promise<unknown> {
    await this.open(scene);
    const origin = new URL(SCENES[scene]).origin;
    const guard = `(async () => {
      if (${RISK_PATTERN}.test(location.href)) throw new Error('RISK_CONTROL: 请在浏览器中完成人工验证');
      if (location.origin !== ${JSON.stringify(origin)}
        || /^\\/(?:custom\\/login\\.htm|login\\.html)$/i.test(location.pathname)
        || /(?:^#!?\\/|^#\\/?)login(?:\\/|$)/i.test(location.hash)) {
        throw new Error('LOGIN_REQUIRED: 请在浏览器中完成店铺登录');
      }
      return true;
    })()`;

    try {
      const evaluate = async (value: string) => {
        const input = this.scoped({ expression: value }) as { expression: string };
        return this.browser.evaluateNative
          ? await this.browser.evaluateNative(input)
          : await this.browser.evaluate!(input);
      };
      await evaluate(guard);
      return await evaluate(
        guard.replace("return true;", `return await (${expression});`),
      );
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (RISK_PATTERN.test(message) || /RISK_CONTROL/.test(message)) {
        throw new Error(`命中风控，已停止取数，请在浏览器中处理：${message}`);
      }
      throw error;
    }
  }

  async evalScript(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const registry = loadRegistry();
    const entry = registry[name];
    if (!entry) throw new Error(`未知脚本：${name}`);
    const missing = requiredArgs(entry).filter((key) => {
      const value = args ? args[key] : undefined;
      return value === undefined || value === null || value === "";
    });
    if (missing.length) {
      throw new Error(
        `缺少必填参数：${missing.join("、")}；脚本 ${name} 的参数：${JSON.stringify(entry.args || {})}`,
      );
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error("timeout_ms 范围为 1～120000");
    }

    const file = inside(DATA_ROOT, entry.path);
    const content = fs.readFileSync(file, "utf8");
    const requires: Record<string, unknown> = {};
    for (const match of content.matchAll(/require\((['"])([^'"]+\.json)\1\)/g)) {
      const jsonFile = inside(
        DATA_ROOT,
        path.relative(DATA_ROOT, path.resolve(path.dirname(file), match[2])),
      );
      requires[match[2]] = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    }

    const expression = `(async () => {
      const module = { exports: {} };
      const files = ${JSON.stringify(requires)};
      const require = name => {
        if (Object.prototype.hasOwnProperty.call(files, name)) return files[name];
        throw new Error('未注册的 require: ' + name);
      };
      const mtop = () => { throw new Error('mtop() bridge is not implemented in this port'); };
      new Function('module', 'exports', 'require', 'mtop', ${JSON.stringify(content)})(module, module.exports, require, mtop);
      const fn = typeof module.exports === 'function' ? module.exports : module.exports.default;
      if (typeof fn !== 'function') throw new Error('脚本没有导出函数');
      return await fn(${JSON.stringify(args)});
    })()`;

    const result = await this.evaluate(expression, entry.scene || "sycm");
    if (result === null || typeof result !== "object") {
      throw new Error("脚本必须返回 JSON 对象或数组");
    }
    return result;
  }

  async checkSession() {
    const result = (await this.evaluate(
      `(async () => {
        const r = await fetch('/portal/shop/getMainCateInfo.json', { credentials: 'include' });
        const body = await r.json().catch(() => null);
        return {
          isJson: body !== null,
          cateLevel1Id: body?.content?.data?.cateLevel1Id ?? body?.data?.cateLevel1Id ?? null,
          code: body?.code ?? null,
          msg: body?.msg ?? null,
        };
      })()`,
      "sycm",
    )) as { isJson?: boolean; cateLevel1Id?: unknown; code?: unknown } | null;
    if (!result?.isJson || result.cateLevel1Id == null) {
      throw new Error(
        result?.code === 5902
          ? "当前账号未绑定店铺，请在浏览器中登录商家账号"
          : "未能验证生意参谋登录，请在浏览器中确认登录和权限",
      );
    }
    return { ok: true, cateLevel1Id: String(result.cateLevel1Id) };
  }

  async close() {
    // The built-in browser owns the tab; there is no lease to release.
    this.opened = false;
  }
}

function loadRegistry(): Record<string, RegistryEntry> {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(DATA_ROOT, "registry.json"), "utf8"),
    );
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, RegistryEntry>)
      : {};
  } catch {
    return {};
  }
}

export { MerchantRunner, SCENES, loadRegistry, RISK_PATTERN, requiredArgs };
