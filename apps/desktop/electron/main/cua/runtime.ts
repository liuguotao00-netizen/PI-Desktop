import type {
  AppSettings,
  ComputerCapabilities,
  ComputerGrantView,
  ComputerInspection,
  ComputerTarget,
} from "@pi-desktop/shared";
import type { BrowserService } from "../browser/service.ts";
import type { HostProcess } from "../host-process.ts";
import { BrowserSession } from "../browser/session.ts";
import type { BrowserSessions } from "../browser/sessions.ts";
import type { CuaClaim, CuaSessions, CuaState } from "./session.ts";

export type CuaSurface = "app" | "browser";

/** The only browser operations CUA needs; keeps the runtime independent of the
 * full plugin-facing BrowserService surface. */
export type CuaBrowserPort = Pick<
  BrowserService,
  | "reveal"
  | "tabs"
  | "navigate"
  | "snapshot"
  | "screenshot"
  | "click"
  | "fill"
  | "evaluate"
  | "console"
  | "history"
  | "uploadFiles"
  | "downloadUrl"
  | "crossOriginFrame"
  | "handleDialog"
  | "action"
>;

export type CuaPoint = { x: number; y: number };

type CuaAppActionBase = { surface: "app"; targetId?: string };

export type CuaAppActionInput =
  | (CuaAppActionBase & { action: "observe" | "snapshot" })
  | (CuaAppActionBase & {
      action: "click" | "double_click" | "right_click" | "secondary_action";
      uid?: string;
      point?: CuaPoint;
      option?: string;
    })
  | (CuaAppActionBase & {
      action: "set_value" | "paste_text";
      uid?: string;
      text: string;
    })
  | (CuaAppActionBase & { action: "press_keys"; keys: string[] })
  | (CuaAppActionBase & {
      action: "scroll";
      scroll: { dx: number; dy: number };
      uid?: string;
      point?: CuaPoint;
    })
  | (CuaAppActionBase & { action: "select"; uid?: string; option: string })
  | (CuaAppActionBase & { action: "drag"; point: CuaPoint; toPoint: CuaPoint })
  | (CuaAppActionBase & { action: "launch_app" });

type CuaBrowserActionBase = { surface: "browser"; tabId?: string };

export type CuaBrowserActionInput =
  | (CuaBrowserActionBase & { action: "navigate"; url: string })
  | (CuaBrowserActionBase & { action: "snapshot" })
  | (CuaBrowserActionBase & { action: "screenshot"; fullPage?: boolean })
  | (CuaBrowserActionBase & { action: "click"; uid: string })
  | (CuaBrowserActionBase & { action: "fill"; uid: string; text: string })
  | (CuaBrowserActionBase & { action: "evaluate"; expression: string })
  | (CuaBrowserActionBase & { action: "console"; limit?: number })
  | (CuaBrowserActionBase & { action: "history" })
  | (CuaBrowserActionBase & { action: "upload"; selector: string; files: string[] })
  | (CuaBrowserActionBase & { action: "download"; url: string; filename?: string })
  | (CuaBrowserActionBase & { action: "frame"; frame?: Record<string, unknown> })
  | (CuaBrowserActionBase & { action: "dialog"; accept?: boolean; promptText?: string })
  | (CuaBrowserActionBase & { action: "back" | "forward" | "reload" | "stop" });

export type CuaActionInput = CuaAppActionInput | CuaBrowserActionInput;

export type CuaAppState = {
  targetId: string;
  targetLabel: string;
  appKey: string;
  bounds: ComputerGrantView["bounds"];
  revision: number;
  remainingBudget: number;
  capabilities: ComputerCapabilities | null;
  nodes: ComputerInspection["nodes"];
  truncated: boolean;
  secureInput: boolean;
};

export type CuaBrowserState = CuaState["browser"] & { tabs: unknown };

export type CuaRuntimeDependencies = {
  sessions: CuaSessions;
  browser: CuaBrowserPort;
  /** Shared browser-session registry; when present, CUA and plugins share
   * sessions, claims, capabilities, and turn cleanup. */
  browserSessions?: BrowserSessions;
  getHost: () => Pick<HostProcess, "call"> | null;
  /** Ask the user before an agent claims a tab. Absent means deny. */
  confirmClaim?: (claim: CuaClaim) => Promise<boolean>;
  /** Chromium window capture, scoped to the live grant. */
  capture?: (input: { targetId: string; bounds: ComputerGrantView["bounds"] }) => Promise<{ mimeType: string; base64: string } | undefined>;
  readClipboard?: () => Promise<string>;
  writeClipboard?: (text: string) => Promise<void>;
  readClipboardImage?: () => Promise<string | null>;
  writeClipboardImage?: (data: string) => Promise<void>;
};

/**
 * Unified CUA actions over one session.
 *
 * The state/binding lives in CuaSessions; this class turns a target id and a
 * tab id into the same action vocabulary Codex exposes through `cua`. It does
 * not invent authority: the host grant still gates every native action.
 */
export class CuaRuntime {
  private readonly deps: CuaRuntimeDependencies;

  constructor(deps: CuaRuntimeDependencies) {
    this.deps = deps;
  }

  state(sessionId: string): Promise<CuaState> {
    return this.deps.sessions.state(sessionId);
  }

  bind(sessionId: string, patch: { targetId?: string; tabId?: string }) {
    return this.deps.sessions.bind(sessionId, patch);
  }

  clear(sessionId: string): void {
    this.deps.sessions.clear(sessionId);
  }

  async claimTab(sessionId: string, tabId: string): Promise<CuaClaim> {
    const listed = await this.deps.browser.tabs({ action: "list" }, sessionId);
    const tabs = (Array.isArray(listed)
      ? listed
      : Array.isArray((listed as { tabs?: unknown[] } | null)?.tabs)
        ? (listed as { tabs: unknown[] }).tabs
        : []) as Array<{ id?: string; tabId?: string; title?: string; url?: string; active?: boolean }>;
    const wanted = String(tabId ?? "").trim();
    const exact = tabs.find((tab) => (tab.id ?? tab.tabId) === wanted);
    const baseId = "plugin:pi.browser/browser";
    const selected = exact ?? (wanted === baseId ? tabs.find((tab) => tab.active) ?? tabs[0] : { tabId: wanted });
    if (!selected || !String(selected.id ?? selected.tabId ?? "").trim()) {
      throw Object.assign(new Error("No Browser page is connected to this session. Navigate or open a preview first."), {
        errorCode: "UNAVAILABLE",
      });
    }
    const resolvedId = String(selected.id ?? selected.tabId ?? "");
    const claim: CuaClaim = {
      tabId: resolvedId,
      ...(selected.title ? { title: selected.title } : {}),
      ...(selected.url ? { url: selected.url } : {}),
    };
    const allowed = this.deps.confirmClaim ? await this.deps.confirmClaim(claim) : false;
    if (!allowed) {
      throw Object.assign(new Error("The user declined to hand over this tab."), {
        errorCode: "COMPUTER_CLAIM_DENIED",
      });
    }
    this.deps.sessions.claimTab(sessionId, claim);
    return claim;
  }

  releaseTab(sessionId: string): void {
    this.deps.sessions.releaseTab(sessionId);
  }

  private host(): Pick<HostProcess, "call"> {
    const host = this.deps.getHost();
    if (!host) throw Object.assign(new Error("Host unavailable."), { errorCode: "HOST_UNAVAILABLE" });
    return host;
  }

  private async ensureGrant(sessionId: string, targetId?: string): Promise<ComputerGrantView> {
    const host = this.host();
    const settings = await host.call<AppSettings>("settings.get");
    if (settings.computerUse?.enabled !== true) {
      throw Object.assign(new Error("Computer use is off."), { errorCode: "COMPUTER_DISABLED" });
    }
    const described = await host.call<{ grant: ComputerGrantView | null }>("computer.grantDescribe", {});
    const active = described.grant?.state === "active" ? described.grant : null;
    if (active && active.sessionId !== sessionId) {
      throw Object.assign(new Error("Another session holds the active computer-use grant."), {
        errorCode: "COMPUTER_GRANT_IN_USE",
      });
    }
    let grant = active;
    if (!grant) {
      const options = settings.computerUse;
      grant = await host.call<ComputerGrantView>("computer.grantCreate", {
        sessionId,
        origin: "agent",
        ...(targetId ? { targetId } : {}),
        ...(options.defaultInputPolicy ? { inputPolicy: options.defaultInputPolicy } : {}),
        ...(options.defaultCapture ? { capture: options.defaultCapture } : {}),
        ...(options.actionBudget ? { actionBudget: options.actionBudget } : {}),
        ...(options.idleExpiryMs ? { idleExpiryMs: options.idleExpiryMs } : {}),
      });
    }
    const wanted = targetId ?? this.selectionTarget(sessionId);
    if (wanted && wanted !== grant.targetId) {
      await host.call<ComputerInspection>("computer.inspect", {
        grantId: grant.grantId,
        sessionId,
        targetId: wanted,
      });
      const next = await host.call<{ grant: ComputerGrantView | null }>("computer.grantDescribe", {});
      if (!next.grant) throw new Error("computer grant disappeared after rebind");
      grant = next.grant;
    }
    return grant;
  }

  private selectionTarget(sessionId: string): string | undefined {
    return this.deps.sessions.selection(sessionId).targetId;
  }

  private browserSession(sessionId: string): BrowserSession {
    if (this.deps.browserSessions) return this.deps.browserSessions.get(sessionId);
    return new BrowserSession({
      service: this.deps.browser as unknown as BrowserService,
      sessionId,
      capabilities: [],
      ...(this.deps.readClipboard ? { readClipboard: this.deps.readClipboard } : {}),
      ...(this.deps.writeClipboard ? { writeClipboard: this.deps.writeClipboard } : {}),
      ...(this.deps.readClipboardImage ? { readClipboardImage: this.deps.readClipboardImage } : {}),
      ...(this.deps.writeClipboardImage ? { writeClipboardImage: this.deps.writeClipboardImage } : {}),
    });
  }

  private tabFor(sessionId: string, input: CuaBrowserActionInput): string | undefined {
    return input.tabId
      ?? this.deps.sessions.claimedTab(sessionId)?.tabId
      ?? this.deps.sessions.selection(sessionId).tabId;
  }

  async app(sessionId: string, targetId?: string): Promise<CuaAppState> {
    const host = this.host();
    const grant = await this.ensureGrant(sessionId, targetId);
    const inspection = await host.call<ComputerInspection>("computer.inspect", {
      grantId: grant.grantId,
      sessionId,
    });
    const next = await host.call<{ grant: ComputerGrantView | null }>("computer.grantDescribe", {});
    const live = next.grant ?? grant;
    return {
      targetId: live.targetId,
      targetLabel: live.targetLabel,
      appKey: live.appKey,
      bounds: live.bounds,
      revision: live.revision,
      remainingBudget: live.remainingBudget,
      capabilities: await host.call<ComputerCapabilities>("computer.capabilities", {}),
      nodes: inspection.nodes,
      truncated: inspection.truncated,
      secureInput: inspection.secureInput,
    };
  }

  async capture(sessionId: string, targetId?: string): Promise<{ mimeType: string; data: string }> {
    if (!this.deps.capture) throw new Error("computer capture is unavailable");
    const grant = await this.ensureGrant(sessionId, targetId ?? this.selectionTarget(sessionId));
    const shot = await this.deps.capture({ targetId: grant.targetId, bounds: grant.bounds });
    if (!shot) throw new Error("computer capture returned no image");
    return { mimeType: shot.mimeType, data: shot.base64 };
  }

  async browser(sessionId: string, tabId?: string): Promise<CuaBrowserState> {
    const state = await this.deps.sessions.state(sessionId);
    const tabs = await this.deps.browser.tabs({ action: "list" }, sessionId);
    return { ...state.browser, tabId: tabId ?? state.browser.tabId, tabs };
  }

  async createTab(sessionId: string, url: string, visible = true): Promise<unknown> {
    const result = await this.deps.browser.tabs({ action: "new", url }, sessionId);
    const tabId = (result as { tabId?: string } | null)?.tabId;
    if (tabId) this.deps.sessions.bind(sessionId, { tabId });
    if (visible) await this.deps.browser.reveal(sessionId);
    return result;
  }

  async act(sessionId: string, input: CuaActionInput): Promise<unknown> {
    if (input.surface === "browser") return this.actBrowser(sessionId, input);
    return this.actApp(sessionId, input);
  }

  private async actBrowser(sessionId: string, input: CuaBrowserActionInput): Promise<unknown> {
    const tabId = this.tabFor(sessionId, input);
    const browser = this.deps.browser;
    const session = this.browserSession(sessionId);
    const tab = tabId ? await session.tabs.get(tabId) : await session.tabs.get("");
    switch (input.action) {
      case "navigate": return tab.goto(input.url);
      case "snapshot": return tab.snapshot();
      case "screenshot": return tab.screenshot();
      case "click": return tab.click(input.uid);
      case "fill": return tab.fill(input.uid, input.text);
      case "evaluate": return tab.evaluate(input.expression);
      case "history": return tab.history();
      case "back": return tab.back();
      case "forward": return tab.forward();
      case "reload": return tab.reload();
      case "console": return browser.console(input.limit ?? 100, sessionId, tabId);
      case "upload":
        if (!input.selector || !input.files?.length) throw new Error("upload requires selector and files");
        return browser.uploadFiles(input.selector, input.files, sessionId, tabId);
      case "download":
        if (!input.url) throw new Error("download requires url");
        return browser.downloadUrl(input.url, input.filename, sessionId, tabId);
      case "frame":
        return browser.crossOriginFrame(input.frame ?? {}, sessionId, tabId);
      case "dialog":
        return browser.handleDialog({ accept: input.accept, promptText: input.promptText }, sessionId, tabId);
      case "stop":
        browser.action("stop", sessionId, tabId);
        return { ok: true };
    }
    const exhaustive: never = input;
    throw new Error(`unsupported browser action: ${String(exhaustive)}`);
  }

  private async actApp(sessionId: string, input: CuaAppActionInput): Promise<unknown> {
    const targetId = input.targetId ?? this.selectionTarget(sessionId);
    const grant = await this.ensureGrant(sessionId, targetId);
    if (input.action === "observe" || input.action === "snapshot") {
      return this.app(sessionId, targetId);
    }
    const action: Record<string, unknown> = { kind: input.action };
    if ("uid" in input && input.uid) action.uid = input.uid;
    if ("text" in input) action.text = input.text;
    if ("keys" in input) action.keys = input.keys;
    if ("scroll" in input) action.scroll = input.scroll;
    if ("option" in input) action.option = input.option;
    if ("point" in input && input.point) {
      action.point = input.point;
      action.basis = { revision: grant.revision, bounds: grant.bounds };
    }
    if ("toPoint" in input) {
      action.toPoint = input.toPoint;
      action.basis = action.basis ?? { revision: grant.revision, bounds: grant.bounds };
    }
    return this.host().call("computer.act", {
      grantId: grant.grantId,
      sessionId,
      expectedRevision: grant.revision,
      action,
    });
  }
}
