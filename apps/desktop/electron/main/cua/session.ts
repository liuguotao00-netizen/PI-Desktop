import type {
  ComputerCapabilities,
  ComputerGrantView,
  ComputerTarget,
} from "@pi-desktop/shared";
import type { BrowserRouter } from "../browser/router.ts";
import type { TabLifecycle } from "../browser/lifecycle.ts";
import type { HostProcess } from "../host-process.ts";

/**
 * One agent session's persistent computer-use context.
 *
 * The grant itself still belongs to host-core; this object only remembers which
 * app window and which browser tab the agent last selected, so a later tool
 * call can act without asking the model to repeat the whole inventory. It is
 * deliberately per session and never persisted across restarts.
 */
export type CuaSelection = {
  targetId?: string;
  tabId?: string;
};

export type CuaClaim = {
  tabId: string;
  title?: string;
  url?: string;
};

export type CuaState = {
  sessionId: string;
  selection: CuaSelection;
  /** Tab explicitly claimed for agent control until released. */
  claimedTabId?: string;
  claimedTabTitle?: string;
  claimedTabUrl?: string;
  browser: ReturnType<BrowserRouter["state"]>;
  computer: {
    capabilities: ComputerCapabilities | null;
    grant: ComputerGrantView | null;
    targets: ComputerTarget[];
  };
};

export type CuaSessionDependencies = {
  router: Pick<BrowserRouter, "state">;
  getHost: () => Pick<HostProcess, "call"> | null;
  /** The shared tab lifecycle owns the session's claimed tab. */
  claims: Pick<TabLifecycle, "claim" | "release" | "claimedTab">;
};

export class CuaSessions {
  private readonly selections = new Map<string, CuaSelection>();
  private readonly deps: CuaSessionDependencies;

  constructor(deps: CuaSessionDependencies) {
    this.deps = deps;
  }

  selection(sessionId: string): CuaSelection {
    return this.selections.get(sessionId) ?? {};
  }

  bind(sessionId: string, patch: CuaSelection): CuaSelection {
    const current = this.selections.get(sessionId) ?? {};
    const next: CuaSelection = {
      ...current,
      ...(patch.targetId !== undefined ? { targetId: patch.targetId } : {}),
      ...(patch.tabId !== undefined ? { tabId: patch.tabId } : {}),
    };
    this.selections.set(sessionId, next);
    return next;
  }

  clear(sessionId: string): void {
    this.selections.delete(sessionId);
    this.deps.claims.release(sessionId);
  }

  claimTab(sessionId: string, claim: string | CuaClaim): void {
    this.deps.claims.claim(sessionId, claim);
  }

  releaseTab(sessionId: string): void {
    this.deps.claims.release(sessionId);
  }

  claimedTab(sessionId: string): CuaClaim | undefined {
    return this.deps.claims.claimedTab(sessionId);
  }

  async state(sessionId: string): Promise<CuaState> {
    const browser = this.deps.router.state(sessionId);
    const selection = this.selections.get(sessionId) ?? {};
    const claimed = this.deps.claims.claimedTab(sessionId);
    const claimedFields = claimed
      ? {
          claimedTabId: claimed.tabId,
          ...(claimed.title ? { claimedTabTitle: claimed.title } : {}),
          ...(claimed.url ? { claimedTabUrl: claimed.url } : {}),
        }
      : {};
    const host = this.deps.getHost();
    if (!host) {
      return {
        sessionId,
        selection,
        ...claimedFields,
        browser,
        computer: { capabilities: null, grant: null, targets: [] },
      };
    }
    const [capabilities, described, listed] = await Promise.all([
      host.call<ComputerCapabilities>("computer.capabilities", {}),
      host.call<{ grant: ComputerGrantView | null }>("computer.grantDescribe", {}),
      host.call<{ targets: ComputerTarget[] }>("computer.listTargets", {}),
    ]);
    return {
      sessionId,
      selection,
      ...claimedFields,
      browser,
      computer: {
        capabilities,
        grant: described.grant,
        targets: listed.targets,
      },
    };
  }
}
