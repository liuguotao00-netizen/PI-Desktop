/**
 * Browser-level agent control: who is driving the built-in browser right now.
 *
 * State is per session. While an agent operation runs the state is `agent`;
 * the user can take over at any time, which aborts the session's signal and
 * makes every later operation fail with `HANDOFF_REQUIRED` until they hand
 * back. `stop` ends the current turn only — the session stays usable.
 *
 * This lives in the host, not in a plugin, because it governs every caller of
 * `pi.browser.*` (the built-in Browser tool included).
 */

export type BrowserControlState = "idle" | "agent" | "user";

type Entry = {
  state: BrowserControlState;
  controller: AbortController;
  active: number;
  action: string | null;
  /** The session's turn is running, so the bar stays up between operations. */
  turnActive: boolean;
  /** explicit browser_lock lease; user takeover always clears it */
  locked: boolean;
};

const entries = new Map<string, Entry>();
/** Why the state changed, for listeners that must also stop the turn. */
export type ControlIntent = "takeover" | "stop";
const listeners = new Set<(sessionId: string, intent?: ControlIntent) => void>();

function keyOf(sessionId?: string): string {
  return sessionId && sessionId.trim() ? sessionId : "default";
}

function entryFor(sessionId?: string): Entry {
  const key = keyOf(sessionId);
  let entry = entries.get(key);
  if (!entry) {
    entry = { state: "idle", controller: new AbortController(), active: 0, action: null, turnActive: false, locked: false };
    entries.set(key, entry);
  }
  return entry;
}


function notify(sessionId?: string, intent?: ControlIntent): void {
  const key = keyOf(sessionId);
  for (const listener of listeners) listener(key, intent);
}

export function onControlChange(
  listener: (sessionId: string, intent?: ControlIntent) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function controlSnapshot(sessionId?: string): {
  state: BrowserControlState;
  action: string | null;
  active: number;
  locked: boolean;
} {
  const entry = entryFor(sessionId);
  return { state: entry.state, action: entry.action, active: entry.active, locked: entry.locked };
}

export class HandoffRequiredError extends Error {
  readonly code = "HANDOFF_REQUIRED";
  constructor() {
    super("用户已接管浏览器，自动化已暂停。请在控制条交还给 Agent 后重试。");
    this.name = "HandoffRequiredError";
  }
}

/** Throws when the user holds control. Call before any browser operation. */
export function assertAgentMayOperate(sessionId?: string): void {
  if (entryFor(sessionId).state === "user") throw new HandoffRequiredError();
}

/** Mark one operation in progress; returns the session signal. */
export function beginOperation(sessionId: string | undefined, action: string): AbortSignal {
  const entry = entryFor(sessionId);
  assertAgentMayOperate(sessionId);
  entry.active += 1;
  entry.action = action;
  if (entry.state === "idle") entry.state = "agent";
  notify(sessionId);
  return entry.controller.signal;
}

export function endOperation(sessionId?: string, action?: string): void {
  const entry = entryFor(sessionId);
  entry.active = Math.max(0, entry.active - 1);
  if (entry.active === 0) {
    entry.action = null;
    // A running turn keeps the bar up in its quiet state; only the end of the
    // turn (or an explicit stop) takes it down.
    if (entry.state === "agent" && !entry.turnActive && !entry.locked) entry.state = "idle";
  } else if (action && entry.action === action) {
    entry.action = null;
  }
  notify(sessionId);
}

/**
 * Explicit automation lease (Cursor's browser_lock). It keeps the page in the
 * quiet `agent` state across operations; user takeover still wins and clears
 * it. Locking while the user holds control is refused.
 */
export function lockForAgent(sessionId?: string): void {
  const entry = entryFor(sessionId);
  if (entry.state === "user") throw new HandoffRequiredError();
  entry.locked = true;
  if (entry.state === "idle") entry.state = "agent";
  notify(sessionId);
}

export function unlockForAgent(sessionId?: string): void {
  const entry = entryFor(sessionId);
  entry.locked = false;
  if (entry.active === 0 && !entry.turnActive && entry.state === "agent") entry.state = "idle";
  notify(sessionId);
}

/** Takeover: abort in-flight work and block further operations. */
export function takeOver(sessionId?: string): void {
  const entry = entryFor(sessionId);
  entry.state = "user";
  entry.locked = false;
  entry.controller.abort();
  entry.controller = new AbortController();
  entry.active = 0;
  entry.action = null;
  notify(sessionId, "takeover");
}

/** Hand control back to the agent. */
export function handBack(sessionId?: string): void {
  const entry = entryFor(sessionId);
  entry.state = entry.turnActive || entry.locked ? "agent" : "idle";
  entry.action = null;
  entry.controller = new AbortController();
  notify(sessionId);
}

/** Turn lifecycle: the agent owns this browser for as long as its turn runs. */
export function noteTurnStarted(sessionId?: string): void {
  const entry = entryFor(sessionId);
  if (entry.turnActive) return;
  entry.turnActive = true;
  notify(sessionId);
}

export function noteTurnEnded(sessionId?: string): void {
  const entry = entryFor(sessionId);
  if (!entry.turnActive) return;
  entry.turnActive = false;
  entry.locked = false;
  if (entry.active === 0 && entry.state === "agent") entry.state = "idle";
  notify(sessionId);
}

/**
 * Drop a hold left behind by a closed tab or an unloaded plugin. Only an
 * idle hold is cleared: a live operation keeps its state.
 */
export function resetSession(sessionId?: string): void {
  const entry = entryFor(sessionId);
  if (entry.active > 0) return;
  entry.state = "idle";
  entry.turnActive = false;
  entry.locked = false;
  entry.controller = new AbortController();
  entry.action = null;
  notify(sessionId);
}

/** Stop the current turn only; the session stays usable afterwards. */
export function stopTurn(sessionId?: string): void {
  const entry = entryFor(sessionId);
  entry.controller.abort();
  entry.controller = new AbortController();
  entry.state = "idle";
  entry.active = 0;
  entry.action = null;
  notify(sessionId, "stop");
}
