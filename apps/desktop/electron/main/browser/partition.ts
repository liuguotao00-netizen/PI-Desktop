import { createHash } from "node:crypto";

/** Legacy shared partition for panes that never received a session id. */
export const SHARED_BROWSER_PARTITION = "persist:work-browser";

/**
 * Each agent session gets its own persistent profile. The profile is keyed by
 * the session id hash so cookies, storage and logins never cross sessions.
 */
export function partitionForSession(sessionId?: string): string {
  const id = String(sessionId ?? "").trim();
  if (!id) return SHARED_BROWSER_PARTITION;
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 20);
  return `${SHARED_BROWSER_PARTITION}-${digest}`;
}
