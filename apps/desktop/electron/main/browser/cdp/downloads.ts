import { mkdirSync } from "node:fs";
import type { CdpConnection } from "./connection.ts";
import type { DownloadResult } from "../types.ts";

export class PageDownloads {
  private readonly downloads = new Map<string, DownloadResult>();
  private waiters: Array<{
    resolve: (value: DownloadResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private readonly connection: CdpConnection;
  private readonly downloadDir: string;
  constructor(connection: CdpConnection, downloadDir: string) {
    this.connection = connection;
    this.downloadDir = downloadDir;
    connection.on("Browser.downloadWillBegin", (params) => {
      const record = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
      const guid = String(record.guid ?? "");
      if (!guid) return;
      this.downloads.set(guid, {
        path: `${downloadDir}/${guid}`,
        url: String(record.url ?? ""),
        filename: String(record.suggestedFilename ?? "download"),
        state: "interrupted",
      });
    });
    connection.on("Browser.downloadProgress", (params) => {
      const record = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
      const guid = String(record.guid ?? "");
      const entry = this.downloads.get(guid);
      if (!entry) return;
      const state = String(record.state ?? "");
      if (state === "completed" || state === "canceled") {
        entry.state = state === "completed" ? "completed" : "cancelled";
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.resolve(entry);
        }
      }
    });
  }

  async enable(): Promise<void> {
    mkdirSync(this.downloadDir, { recursive: true });
    await this.connection
      .send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: this.downloadDir,
        eventsEnabled: true,
      })
      .catch(() => undefined);
  }

  async wait(timeoutMs = 30_000): Promise<DownloadResult> {
    await this.enable();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item.timer !== timer);
        reject(new Error("download did not start in time"));
      }, Math.max(1, timeoutMs));
      this.waiters.push({ resolve, reject, timer });
    });
  }

  dispose(): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("CDP page closed"));
    }
  }
}
