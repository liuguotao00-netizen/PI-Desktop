import { homedir } from "node:os";
import { join } from "node:path";

export type DownloadSettings = {
  downloadDirectory?: string | null;
  downloadPrompt?: boolean;
};

export type DownloadPlan =
  | { mode: "cancel" }
  | { mode: "prompt"; defaultPath: string }
  | { mode: "save"; path: string };

/**
 * Decide where a download goes. Settings win over the session scratch folder;
 * "ask where to save" keeps no save path so Chromium shows its save dialog.
 */
export function resolveDownloadPlan(input: {
  filename: string;
  scratch?: string | null;
  settings?: DownloadSettings | null;
}): DownloadPlan {
  const configured = expandHome(input.settings?.downloadDirectory ?? "");
  const scratch = input.scratch ?? "";
  const filename = input.filename || "download";
  if (input.settings?.downloadPrompt) {
    const base = configured || scratch;
    return { mode: "prompt", defaultPath: base ? join(base, filename) : filename };
  }
  if (configured) return { mode: "save", path: join(configured, `${Date.now()}-${filename}`) };
  if (scratch) return { mode: "save", path: join(scratch, `${Date.now()}-${filename}`) };
  return { mode: "cancel" };
}

export function expandHome(path: string): string {
  const value = String(path ?? "").trim();
  if (!value) return "";
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}
