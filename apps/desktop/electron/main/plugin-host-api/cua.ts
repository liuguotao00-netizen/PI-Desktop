import type { CuaActionInput, CuaRuntime } from "../cua/runtime.ts";
import type { BrowserSessions } from "../browser/sessions.ts";
import { isPlaywrightLocator } from "../browser/locator-api.ts";

type CuaHostServices = Pick<
  CuaRuntime,
  "state" | "bind" | "clear" | "app" | "browser" | "createTab" | "capture" | "claimTab" | "releaseTab" | "act"
>;

export type CuaHostApiOptions = {
  cua: CuaHostServices | undefined;
  /** Shared browser session registry; the JS sandbox drives these objects. */
  sessions?: BrowserSessions;
  assertPermission: () => void;
  /** Session bound to the current plugin tool invocation. */
  requireSession: (operation: string) => string;
};

function apiError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

type SessionStep = { m: string; args?: unknown[] };
const DENIED_MEMBERS = new Set(["deps", "service", "tab", "input", "constructor", "__proto__", "prototype", "browser"]);

function toJson(value: unknown): unknown {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

/**
 * `pi.cua` host surface. Permission and session ownership stay with the caller;
 * this module only maps plugin arguments onto the unified CUA runtime.
 */
export function createCuaHostApi(options: CuaHostApiOptions) {
  const requireCua = () => {
    options.assertPermission();
    if (!options.cua) throw apiError("UNAVAILABLE", "cua host missing");
    return options.cua;
  };
  return {
    state: async () => requireCua().state(options.requireSession("state")),
    bind: (input: { targetId?: string; tabId?: string } = {}) =>
      requireCua().bind(options.requireSession("bind"), {
        ...(typeof input.targetId === "string" ? { targetId: input.targetId } : {}),
        ...(typeof input.tabId === "string" ? { tabId: input.tabId } : {}),
      }),
    clear: () => {
      requireCua().clear(options.requireSession("clear"));
      return { ok: true };
    },
    app: (input: { targetId?: string } = {}) =>
      requireCua().app(options.requireSession("app"), input.targetId),
    browser: (input: { tabId?: string } = {}) =>
      requireCua().browser(options.requireSession("browser"), input.tabId),
    createTab: (input: { url?: string; visible?: boolean } = {}) =>
      requireCua().createTab(options.requireSession("createTab"), String(input.url ?? ""), input.visible !== false),
    capture: (input: { targetId?: string } = {}) =>
      requireCua().capture(options.requireSession("capture"), input.targetId),
    claimTab: async (input: { tabId?: string } = {}) => {
      const cua = requireCua();
      const sessionId = options.requireSession("claimTab");
      const tabId = String(input.tabId ?? "").trim();
      if (!tabId) throw apiError("INVALID_ARGUMENT", "cua claimTab requires a tab id");
      await cua.claimTab(sessionId, tabId);
      return { ok: true, tabId };
    },
    releaseTab: () => {
      requireCua().releaseTab(options.requireSession("releaseTab"));
      return { ok: true };
    },
    act: (input: Record<string, unknown>) =>
      requireCua().act(options.requireSession("act"), input as CuaActionInput),
    /** Codex-shaped browser catalog available to agent code. */
    browsers: async () => {
      if (!options.sessions) return [{ id: "embedded", type: "iab", name: "In-app browser" }];
      return options.sessions.catalog();
    },
    /** Describe the Codex-shaped BrowserSession bound to this invocation. */
    session: async () => {
      const sessionId = options.requireSession("session");
      const session = options.sessions?.get(sessionId);
      if (!session) throw apiError("UNAVAILABLE", "browser session unavailable");
      const tabs = await session.tabs.list();
      return { sessionId, tabs, capabilities: session.capabilities.list(), name: session.name };
    },
    /**
     * Resolve a method/chain path on BrowserSession or a tab handle. Locators
     * come back as a path marker so the sandbox proxy can keep chaining.
     */
    sessionInvoke: async (input: { tabId?: string; steps?: SessionStep[] }) => {
      const sessionId = options.requireSession("sessionInvoke");
      const session = options.sessions?.get(sessionId);
      if (!session) throw apiError("UNAVAILABLE", "browser session unavailable");
      const steps = Array.isArray(input?.steps) ? input.steps : [];
      let current: unknown = input?.tabId ? await session.tabs.get(String(input.tabId)) : session;
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        const member = String(step?.m ?? "");
        if (!member || DENIED_MEMBERS.has(member) || member.startsWith("_")) {
          throw apiError("PERMISSION_DENIED", `browser session member ${member || "(empty)"} is not available`);
        }
        const holder = current as Record<string, unknown>;
        const value = holder?.[member];
        const args = Array.isArray(step?.args) ? step.args : [];
        if (typeof value === "function") {
          current = await (value as (...params: unknown[]) => unknown).apply(holder, args);
        } else if (args.length) {
          throw apiError("INVALID_ARGUMENT", `${member} is not callable`);
        } else {
          current = value;
        }
        if (isPlaywrightLocator(current)) {
          return { kind: "locator", path: steps.slice(0, index + 1) };
        }
        if (index < steps.length - 1 && (current === null || current === undefined)) {
          throw apiError("INVALID_ARGUMENT", `${member} is undefined`);
        }
      }
      return { kind: "value", value: toJson(current) };
    },
  };
}
