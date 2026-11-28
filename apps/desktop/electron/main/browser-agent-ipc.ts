import { BrowserWindow } from "electron";
import { IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./ipc/types";
import {
  controlSnapshot,
  handBack,
  onControlChange,
  resetSession,
  stopTurn,
  takeOver,
} from "./browser-agent-control.ts";

type Dependencies = {
  registrar: IpcRegistrar;
};

/**
 * Renderer-facing control channel. The bar itself is a native overlay view in
 * the browser pane; this surface carries the renderer's own reset and the
 * turn-stop signal that takeover/stop asks for.
 */
export function registerBrowserAgentIpc({ registrar }: Dependencies): void {
  registrar.handleWithEvent(
    IPC.invoke.browserSetAgentControl,
    async (event, payload?: unknown) => {
      registrar.assertMainWindowSender(event);
      const input =
        payload && typeof payload === "object"
          ? (payload as { action?: unknown; sessionId?: unknown })
          : {};
      const action = String(input.action ?? "");
      const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
      if (action === "takeover") takeOver(sessionId);
      else if (action === "handBack") handBack(sessionId);
      else if (action === "stop") stopTurn(sessionId);
      else if (action === "reset") resetSession(sessionId);
      else throw new Error(`Invalid browser agent control action: ${action}`);
      return controlSnapshot(sessionId);
    },
  );

  onControlChange((sessionId, intent) => {
    const snapshot = controlSnapshot(sessionId);
    // Any window may host the browser panel, not only the main one.
    const payload = {
      sessionId,
      ...snapshot,
      // Takeover/stop must end the turn in the renderer, which owns the same
      // stop channels as the composer's Stop button. Whichever surface asked
      // (the panel bar or the IPC control), the intent travels with the event.
      turnStop: intent === "stop" ? "stop" : intent === "takeover" ? "abort" : undefined,
    };
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send(IPC.event.browserAgentControl, payload);
    }
  });
}
