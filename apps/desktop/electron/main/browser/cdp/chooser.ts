import type { CdpConnection } from "./connection.ts";

export class PageFileChooser {
  private chooser: { backendNodeId: number; mode: string } | null = null;
  private waiters: Array<{
    resolve: (value: { backendNodeId: number; mode: string }) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private intercepting = false;

  private readonly connection: CdpConnection;
  constructor(connection: CdpConnection) {
    this.connection = connection;
    connection.on("Page.fileChooserOpened", (params) => {
      const record = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
      const backendNodeId = Number(record.backendNodeId);
      if (!Number.isFinite(backendNodeId)) return;
      this.chooser = { backendNodeId, mode: String(record.mode ?? "selectSingle") };
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(this.chooser);
      }
    });
  }

  async wait(timeoutMs = 15_000): Promise<{ backendNodeId: number; mode: string }> {
    await this.connection.send("Page.setInterceptFileChooserDialog", { enabled: true });
    this.intercepting = true;
    if (this.chooser) {
      const current = this.chooser;
      this.chooser = null;
      return current;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item.timer !== timer);
        this.intercepting = false;
        void this.connection.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
        reject(new Error("file chooser did not open in time"));
      }, Math.max(1, timeoutMs));
      this.waiters.push({ resolve, reject, timer });
    });
  }

  async setFiles(files: string[]): Promise<void> {
    const chooser = this.chooser;
    if (!chooser) throw new Error("no file chooser is open");
    await this.connection.send("DOM.enable", {});
    await this.connection.send("DOM.setFileInputFiles", {
      files,
      backendNodeId: chooser.backendNodeId,
    });
    this.chooser = null;
    this.intercepting = false;
    await this.connection.send("Page.setInterceptFileChooserDialog", { enabled: false });
  }

  /** Dismiss an intercepted chooser without selecting anything. */
  async cancel(): Promise<void> {
    const chooser = this.chooser;
    if (chooser) {
      await this.connection.send("DOM.enable", {});
      await this.connection.send("DOM.setFileInputFiles", {
        files: [],
        backendNodeId: chooser.backendNodeId,
      });
    }
    this.chooser = null;
    this.intercepting = false;
    await this.connection.send("Page.setInterceptFileChooserDialog", { enabled: false });
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error("file chooser cancelled"), { code: "ABORTED" }));
    }
  }

  async reenable(): Promise<void> {
    if (!this.intercepting) return;
    await this.connection.send("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => undefined);
  }

  dispose(): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("CDP page closed"));
    }
  }
}
