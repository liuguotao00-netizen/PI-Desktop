import { session } from "electron";
import { partitionForSession, SHARED_BROWSER_PARTITION } from "./partition.ts";

/**
 * Clear a session's isolated browser profile when the session closes. The
 * shared legacy partition is never wiped: it belongs to panes without a
 * session and may predate the isolation change.
 */
export async function clearBrowserProfile(sessionId: string): Promise<void> {
  const id = String(sessionId ?? "").trim();
  if (!id) return;
  const partition = partitionForSession(id);
  if (partition === SHARED_BROWSER_PARTITION) return;
  await session.fromPartition(partition).clearStorageData();
}
