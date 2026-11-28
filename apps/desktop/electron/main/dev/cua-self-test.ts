import type { AppSettings, ComputerGrantView } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process.ts";

/**
 * Dev-only macOS CUA smoke test.
 *
 * Runs in the app process so the Accessibility TCC grant belongs to the app
 * rather than to a standalone test binary. It never clicks or types: it
 * creates a user-origin grant, enumerates real windows, and inspects the first
 * non-refused target.
 */
export async function runCuaSelfTest(
  host: Pick<HostProcess, "call">,
  log: (message: string, data?: Record<string, unknown>) => void,
): Promise<void> {
  try {
    const settings = await host.call<AppSettings>("settings.get");
    if (settings.computerUse?.enabled !== true) {
      log("cua self-test skipped: computerUse disabled");
      return;
    }
    const capabilities = await host.call("computer.capabilities", {});
    log("cua self-test capabilities", { data: capabilities });
    if ((capabilities as { accessibility?: string }).accessibility !== "granted") {
      const requested = await host.call("computer.requestPermission", {});
      log("cua self-test permission requested", { data: requested });
    }
    const listed = await host.call<{ targets: Array<{ targetId: string; refusedReason?: string }> }>(
      "computer.listTargets",
      {},
    );
    log("cua self-test targets", { data: { count: listed.targets.length } });
    const target = listed.targets.find((entry) => !entry.refusedReason);
    if (!target) {
      log("cua self-test no eligible target");
      return;
    }
    const grant = await host.call<ComputerGrantView>("computer.grantCreate", {
      sessionId: "cua-self-test",
      origin: "user",
      targetId: target.targetId,
      inputPolicy: "confirm-each",
      capture: "a11y-only",
    });
    log("cua self-test grant", { data: { targetId: grant.targetId, budget: grant.remainingBudget } });
    const inspection = await host.call<{ nodes: unknown[]; truncated: boolean }>("computer.inspect", {
      grantId: grant.grantId,
      sessionId: "cua-self-test",
    });
    log("cua self-test inspect ok", { data: { nodes: inspection.nodes.length, truncated: inspection.truncated } });
    await host.call("computer.grantRevoke", { reason: "self-test" }).catch(() => undefined);
  } catch (error) {
    log("cua self-test failed", {
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}
