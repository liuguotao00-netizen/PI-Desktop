"use strict";

/**
 * Run records: one id per execution, readable while it runs and after.
 *
 * A publish can take minutes, and a tool call that blocks for minutes is not
 * observable. `run_automation` submits and returns a runId; the caller polls
 * `get_automation_run` or cancels it.
 *
 * Runs are serialized **per session**: the contended resource is that
 * session's browser tab, and two sessions drive different pages, so a long
 * publish in one conversation no longer blocks the others.
 *
 * Records are persisted under the run's artifact directory, so a restart does
 * not lose history. Ported from QiWork's `automation/runs.py`.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_RETAINED_RUNS = 50;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const GLOBAL_QUEUE = "__global__";
export type RunExecutor = (work: () => Promise<void>) => void;
let runExecutor: RunExecutor | null = null;
export function setRunExecutor(executor: RunExecutor | null): void {
  runExecutor = executor;
}
type RunStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

type RunRecord = {
  runId: string;
  automationId: string;
  name: string;
  platform: string;
  kind: string;
  sessionId: string;
  status: RunStatus;
  progress: unknown;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  artifactDir: string;
  result: unknown;
  files: string[];
  error: Record<string, unknown> | null;
};

type TaskMeta = {
  runId: string;
  artifactDir: string;
  signal: AbortSignal;
};

const runs = new Map<string, RunRecord>();
const controllers = new Map<string, AbortController>();
const chains = new Map<string, Promise<void>>();

function dataDir() {
  const root =
    process.env.PI_DESKTOP_DATA_DIR || path.join(os.homedir(), ".pi-desktop");
  return path.join(root, "plugins", "data", "pi.taobao-tools", "automation");
}

function runsRoot() {
  return path.join(dataDir(), "runs");
}

function artifactDirFor(runId: string): string {
  return path.join(runsRoot(), runId);
}

function snapshot(record: RunRecord): Record<string, unknown> {
  return {
    runId: record.runId,
    automationId: record.automationId,
    name: record.name,
    platform: record.platform,
    kind: record.kind,
    sessionId: record.sessionId,
    status: record.status,
    progress: record.progress,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    artifacts: record.artifactDir,
    result: record.result,
    files: record.files,
    error: record.error,
  };
}

function persist(record: RunRecord): void {
  try {
    fs.mkdirSync(record.artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(record.artifactDir, "run.json"),
      JSON.stringify(snapshot(record), null, 2),
      "utf8",
    );
  } catch (error) {
    // A lost record is not worth failing the run over.
  }
}

function prune() {
  if (runs.size <= MAX_RETAINED_RUNS) return;
  const finished = [...runs.values()]
    .filter(
      (record) =>
        record.status === "succeeded" ||
        record.status === "failed" ||
        record.status === "cancelled",
    )
    .sort((left, right) =>
      String(left.finishedAt || "").localeCompare(String(right.finishedAt || "")),
    );
  for (const record of finished) {
    if (runs.size <= MAX_RETAINED_RUNS) break;
    runs.delete(record.runId);
    controllers.delete(record.runId);
  }
}

/**
 * A run record left as `running`/`queued`/`cancelling` belongs to a previous
 * plugin process: the work does not survive a restart. Mark it interrupted
 * instead of letting the agent poll a run that will never finish.
 */
function reconcileStaleRuns(): void {
  const root = runsRoot();
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
    const file = path.join(root, entry.name, "run.json");
    try {
      const payload = JSON.parse(
        fs.readFileSync(file, "utf8"),
      ) as Record<string, unknown>;
      const status = String(payload.status || "");
      if (!["running", "queued", "cancelling"].includes(status)) continue;
      payload.status = "failed";
      payload.finishedAt = new Date().toISOString();
      payload.error = {
        code: "AUTOMATION_INTERRUPTED",
        message: "插件重启，运行已中断；请到平台确认结果后再决定是否重试",
      };
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    } catch (error) {
      // A damaged record is not a reason to fail plugin startup.
    }
  }
}

reconcileStaleRuns();

function newRunId(automationId: string): string {
  return `${automationId}-${Date.now().toString(36)}-${crypto
    .randomBytes(3)
    .toString("hex")}`;
}

/**
 * Queue one run. `task` receives a progress callback, the run identity and an
 * AbortSignal that `cancel` trips.
 */
function submit(
  {
    automationId,
    name,
    platform,
    kind,
    sessionId = "",
  }: {
    automationId: string;
    name: string;
    platform: string;
    kind?: string;
    sessionId?: string;
  },
  task: (
    progress: (value: unknown) => void,
    meta: TaskMeta,
  ) => Promise<{ context?: unknown; files?: unknown[] } | unknown>,
): Record<string, unknown> {
  const runId = newRunId(automationId);
  const artifactDir = artifactDirFor(runId);
  const controller = new AbortController();
  const record: RunRecord = {
    runId,
    automationId,
    name,
    platform,
    kind: kind || "collect",
    sessionId,
    status: "queued",
    progress: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    artifactDir,
    result: null,
    files: [],
    error: null,
  };
  runs.set(runId, record);
  controllers.set(runId, controller);
  prune();
  persist(record);

  const key = sessionId || GLOBAL_QUEUE;
  const previous = chains.get(key) ?? Promise.resolve();
  const work = async () => {
    if (controller.signal.aborted || record.status === "cancelled") {
      record.status = "cancelled";
      record.finishedAt = record.finishedAt ?? new Date().toISOString();
      record.error = record.error ?? {
        code: "ABORTED",
        message: "运行已取消",
      };
      persist(record);
      return;
    }
    record.status = "running";
    record.startedAt = new Date().toISOString();
    persist(record);
    try {
      const value = (await task(
        (progress) => {
          record.progress = progress;
        },
        { runId, artifactDir, signal: controller.signal },
      )) as { context?: unknown; files?: unknown[] };
      if (controller.signal.aborted) {
        record.status = "cancelled";
        record.error = { code: "ABORTED", message: "运行已取消" };
      } else {
        record.result = value && value.context ? value.context : value;
        record.files = Array.isArray(value.files)
          ? value.files.map((item) => String(item))
          : [];
        record.status = "succeeded";
      }
    } catch (error) {
      const failure = error as Error & {
        code?: string;
        details?: Record<string, unknown>;
      };
      const message = String(failure?.message || error);
      const code = String(failure?.code || "");
      // A user takeover is not a failure: the run stopped because control
      // moved to the user, and the next run is unaffected.
      const handedOff =
        code === "HANDOFF_REQUIRED" || message.includes("用户已接管");
      const aborted = controller.signal.aborted || code === "ABORTED";
      record.status = handedOff || aborted ? "cancelled" : "failed";
      record.error = {
        code: handedOff
          ? "HANDOFF_REQUIRED"
          : aborted
            ? "ABORTED"
            : code || "AUTOMATION_FAILED",
        message,
        ...(failure?.details ? { details: failure.details } : {}),
      };
    } finally {
      record.finishedAt = new Date().toISOString();
      persist(record);
      controllers.delete(runId);
    }
  };
  if (runExecutor) {
    runExecutor(work);
  } else {
    const current = previous.then(work);
    const settled = current
      .catch(() => {})
      .finally(() => {
        if (chains.get(key) === settled) chains.delete(key);
      });
    chains.set(key, settled);
  }
  return snapshot(record);
}

/**
 * Ask one run to stop.
 *
 * A queued run is marked cancelled immediately and never starts. A running
 * run becomes `cancelling` until its task reaches the next abort check; the
 * browser operations also check the same signal, so a long publish stops
 * before its next click.
 */
function cancel(runId: string): Record<string, unknown> | null {
  const raw = String(runId || "");
  if (!RUN_ID_PATTERN.test(raw)) return null;
  const record = runs.get(raw);
  if (!record) return null;
  if (record.status !== "queued" && record.status !== "running") {
    return snapshot(record);
  }
  const controller = controllers.get(raw);
  controller?.abort();
  if (record.status === "queued") {
    record.status = "cancelled";
    record.finishedAt = new Date().toISOString();
    record.error = { code: "ABORTED", message: "运行已取消" };
  } else {
    record.status = "cancelling";
  }
  persist(record);
  return snapshot(record);
}

function get(runId: string): Record<string, unknown> | null {
  const raw = String(runId || "");
  if (!RUN_ID_PATTERN.test(raw)) return null;
  const record = runs.get(raw);
  if (record) return snapshot(record);
  try {
    const payload = JSON.parse(
      fs.readFileSync(path.join(artifactDirFor(raw), "run.json"), "utf8"),
    );
    return payload && payload.runId === raw ? payload : null;
  } catch (error) {
    return null;
  }
}

function list() {
  return [...runs.values()].map(snapshot);
}

function active(sessionId?: string) {
  return [...runs.values()].find(
    (record) =>
      (record.status === "running" ||
        record.status === "queued" ||
        record.status === "cancelling") &&
      (sessionId === undefined || record.sessionId === sessionId),
  );
}

/** Forget in-memory records; files under the data directory stay. */
function clearMemory() {
  for (const controller of controllers.values()) controller.abort();
  runs.clear();
  controllers.clear();
  chains.clear();
}

export {
  MAX_RETAINED_RUNS,
  RUN_ID_PATTERN,
  active,
  artifactDirFor,
  cancel,
  clearMemory,
  get,
  list,
  submit,
};
export type { RunStatus, TaskMeta };
