"use strict";

const { randomUUID } = require("node:crypto");

// Live status reads per batch in the Workers view. Eight parallel reads fit the
// host's 5 s read budget and keep a 128-row refresh inside the 30 s bridge call.
const REFRESH_BATCH_SIZE = 8;
// `workers` is a tool call (110 s budget), so it can afford every row; the
// deadline keeps one call bounded even with a full list.
// Default delivery mode for spawn / spawnIn / send / supervise.
//
// Completion callbacks are on by default: a delegation is asynchronous work,
// and an async delegator must not sit on status/wait polling. The host answers
// a completed turn with a result card in the calling session, which is the
// landing place the caller reads. Pass notifyOnCompletion: false only when the
// caller is deliberately staying in the same turn to read the outcome.
const DEFAULT_NOTIFY_ON_COMPLETION = true;
// A correction is expected to take effect now, so `send` interrupts the turn
// that was running before it unless the caller sets `interrupt: false`.
const DEFAULT_INTERRUPT = true;
const TOOL_REFRESH_BUDGET_MS = 60_000;
// Read-back budget for one steered delivery: 10 x 200 ms. The host settles a
// queued message into a turn within a poll or two, so this is a safety net, not
// a wait for work.
const VERIFY_ATTEMPTS = 10;
const VERIFY_INTERVAL_MS = 200;
// A delivery the host withdrew is re-sent under a fresh idempotency key. Three
// attempts is the documented ceiling; a fourth withdrawal is reported, not hidden.
const MAX_WITHDRAW_RETRIES = 3;
const NOTICE_KINDS = new Set(["progress", "question", "blocked"]);
const MAX_NOTICE_CHARS = 8_000;
const MAX_NOTICE_SUMMARY_CHARS = 300;
const DEFAULT_NOTIFY_MIN_INTERVAL_MS = 5_000;
const MAX_NOTIFY_MIN_INTERVAL_MS = 600_000;
// Statuses in which a session is doing work right now.
const BUSY_STATUSES = new Set(["running", "waiting_permission"]);
// What counts as "the new instruction actually reached a turn".
const STARTED_STATUSES = new Set(["running", "completed", "failed", "interrupted"]);

const {
  MAX_SELECTED_SESSIONS,
  POLL_INTERVAL_MS,
  PREFIX,
  SESSION_ABORT,
  SESSION_CREATE,
  TERMINAL_STATUSES,
  contextSessionId,
  deliveryOptions,
  optionalText,
  optionalProjectPath,
  selectedSessionIds,
  targetSessionId,
  taskError,
  text,
  waitTimeout,
} = require("./runtime.js");
const { MAX_ACCEPTANCE_NOTE_CHARS, MAX_WORKERS } = require("./state.js");
const { catalog, selectModel } = require("./models.js");
const { collapse, workerRow, workerRows } = require("./cards.js");

function resultSelector(args, sessionId) {
  const messageId = optionalText(args.messageId, "messageId");
  const turnId = optionalText(args.turnId, "turnId");
  return { sessionId, ...(messageId ? { messageId } : {}), ...(turnId ? { turnId } : {}) };
}

function resultWorker(sessionId, result) {
  const message = result.message;
  return {
    sessionId,
    status: message?.status || "idle",
    ...(message ? { messageId: message.id, task: String(message.content || "").slice(0, 240), title: message.targetTitle } : {}),
    ...(message?.turnId ? { turnId: message.turnId } : {}),
    ...(message?.status === "completed" && message.result ? { report: message.result } : {}),
    ...(message?.error ? { error: message.error } : {}),
  };
}

/**
 * The marker that separates a worker's mid-turn report from a completion
 * receipt. The host's completion notice arrives as its own delivery with a
 * `completion` kind and a result card, so a report that carries this prefix is
 * never mistaken for one.
 */
const NOTICE_MARKER = "[worker-report:";

function noticeKind(value) {
  if (value === undefined || value === null || value === "") return "progress";
  if (!NOTICE_KINDS.has(value)) {
    throw taskError("INVALID_ARGUMENT", "kind for notify must be progress, question or blocked");
  }
  return value;
}

/**
 * The body of one mid-turn report.
 *
 * It names the worker and says it is still running, because the receiving agent
 * decides whether to steer, wait, or ignore it — and it must not read this as
 * "the worker is done". `notifyOnCompletion` is false on the delivery itself, so
 * no completion callback is created for it.
 */
function noticeContent({ kind, body, workerSessionId, title }) {
  return [
    `${NOTICE_MARKER}${kind}] ${collapse(title) || workerSessionId} (${workerSessionId})`,
    body,
    "",
    "（这是 worker 的中途上报，不是任务完成回执；它此刻仍在运行。要改方向或打断它，用 SessionTask send，interrupt 默认 true。）",
  ].join("\n");
}

function createActions(runtime, options = {}) {
  const store = runtime.store;
  const now = typeof options.now === "function" ? options.now : Date.now;

  function withAcceptance(summary, owner) {
    const messageId = summary.currentTask?.messageId || summary.result?.messageId;
    const accepted = messageId ? store.accepted(summary.sessionId, messageId, owner) : undefined;
    return {
      ...summary,
      acceptanceStatus: accepted ? "accepted" : "pending",
      ...(accepted ? { acceptance: accepted } : {}),
    };
  }

  async function readStatus(sessionId, options) {
    const value = await runtime.call("status", { sessionId }, options);
    if (!value || value.sessionId !== sessionId || typeof value.status !== "string") {
      throw taskError("INTERNAL", "Host returned an invalid session status");
    }
    return value;
  }

  async function readResult(selector, options) {
    const value = await runtime.call("result", selector, options);
    if (!value || typeof value.ready !== "boolean" ||
        (value.ready && !value.message) ||
        (value.message && (typeof value.message.id !== "string" || !value.message.id ||
          !["queued", "running", ...TERMINAL_STATUSES].includes(value.message.status))) ||
        (value.message?.result !== undefined && typeof value.message.result !== "string") ||
        (value.ready && !TERMINAL_STATUSES.has(value.message?.status)) ||
        (value.message && value.message.targetSessionId !== selector.sessionId) ||
        (selector.messageId && value.message && value.message.id !== selector.messageId) ||
        (selector.turnId && value.message && value.message.turnId !== selector.turnId)) {
      throw taskError("INTERNAL", "Host returned a result for a different session delivery");
    }
    return value;
  }

  function validateDelivery(value) {
    if (!value || typeof value.sessionId !== "string" || typeof value.messageId !== "string" ||
        typeof value.status !== "string") throw taskError("INTERNAL", "Host did not return a delivery receipt");
    return value;
  }

  async function spawn(args, ctx) {
    const owner = contextSessionId(ctx);
    const task = text(args.task, "task", 65_536);
    const title = optionalText(args.title, "title", 80);
    const options = deliveryOptions(args);
    await runtime.ensureOperation(PREFIX + "spawn", { signal: ctx.signal });
    const selected = selectModel(await runtime.models({ signal: ctx.signal }), args.model);
    const receipt = validateDelivery(await runtime.call("spawn", {
      task,
      ...(title ? { title } : {}),
      modelKey: selected.model.key,
      ...options,
      notifyOnCompletion: options.notifyOnCompletion ?? DEFAULT_NOTIFY_ON_COMPLETION,
    }, { signal: ctx.signal, read: false }));
    const warning = await runtime.remember(receipt.sessionId, owner, title || task.slice(0, 80), {
      status: receipt.status,
      lastActivityAt: new Date().toISOString(),
    });
    return {
      action: "spawn", ...receipt, accepted: true,
      requestedModel: selected.model.key, modelSelection: selected.selection,
      ...(warning ? { warning } : {}),
    };
  }

  /**
   * Spawn a worker bound to an explicit project.
   *
   * `session/collaboration/spawn` drops `projectPath`, so the session is created
   * with the reviewed `session/create` operation and the task is then delivered
   * with `session/collaboration/send`. A failed create is reported as such: it
   * never falls back to a plain spawn in the caller's own project, because that
   * would silently run the work in the wrong checkout.
   */
  async function spawnIn(args, ctx) {
    const owner = contextSessionId(ctx);
    const task = text(args.task, "task", 65_536);
    const title = optionalText(args.title, "title", 80);
    const project = optionalProjectPath(args.projectPath);
    // No projectPath: the caller asked for the ordinary spawn.
    if (!project) {
      const receipt = await spawn(args, ctx);
      return { ...receipt, action: "spawnIn", spawned: "spawn", projectPath: null, degraded: "spawn-no-project-path" };
    }
    const requestedModel = optionalText(args.model, "model", 512);
    const options = deliveryOptions(args);
    await runtime.ensureOperation(SESSION_CREATE, { signal: ctx.signal });
    const selected = requestedModel
      ? selectModel(await runtime.models({ signal: ctx.signal }), requestedModel)
      : undefined;

    let created;
    try {
      created = await runtime.invokeOperation(SESSION_CREATE, [{
        projectPath: project,
        ...(title ? { title } : {}),
        ...(selected ? { providerId: selected.model.providerId, modelId: selected.model.modelId } : {}),
      }], { signal: ctx.signal, read: false });
    } catch (error) {
      if (error?.code === "ABORTED") throw error;
      throw taskError(
        "SPAWN_IN_FAILED",
        `session/create failed for ${project}: ${String(error?.message || error).slice(0, 300)}`,
        { projectPath: project, cause: error?.code || "UNKNOWN" },
      );
    }
    const sessionId = typeof created?.session?.id === "string" ? created.session.id.trim() : "";
    if (!sessionId) {
      throw taskError("INTERNAL", "session/create did not return a session id", { projectPath: project });
    }
    // Record the session before delivering, so a failed delivery still leaves a
    // visible worker the caller can retry with `send`.
    const createdWarning = await runtime.remember(sessionId, owner, title || task.slice(0, 80), {
      projectPath: project,
      status: "queued",
      lastActivityAt: new Date().toISOString(),
    });

    let receipt;
    try {
      receipt = validateDelivery(await runtime.call("send", {
        sessionId, content: task, kind: "task", ...options,
        notifyOnCompletion: options.notifyOnCompletion ?? DEFAULT_NOTIFY_ON_COMPLETION,
      }, { signal: ctx.signal, read: false }));
    } catch (error) {
      if (error?.code === "ABORTED") throw error;
      // The session exists but got no task: leave a row that says so instead of
      // a worker stuck on "queued" forever.
      try {
        await store.update(sessionId, {
          status: "failed",
          lastActivityAt: new Date().toISOString(),
          lastResult: `投递失败：${String(error?.message || error).slice(0, 300)}`,
        });
      } catch {
        // A history write failure must not mask the delivery error.
      }
      throw taskError(
        "DELIVERY_FAILED",
        `Session ${sessionId} was created but the task could not be delivered: ${String(error?.message || error).slice(0, 300)}`,
        { sessionId, projectPath: project, cause: error?.code || "UNKNOWN" },
      );
    }
    if (receipt.sessionId !== sessionId) throw taskError("INTERNAL", "Host returned a delivery for a different session");
    const warning = await runtime.remember(sessionId, owner, title || task.slice(0, 80), {
      projectPath: project,
      status: receipt.status,
      lastMessageId: receipt.messageId,
      lastActivityAt: new Date().toISOString(),
    });
    return {
      action: "spawnIn", ...receipt, accepted: true,
      projectPath: project,
      spawned: "session-create",
      ...(selected ? { requestedModel: selected.model.key, modelSelection: selected.selection } : {}),
      ...([createdWarning, warning].filter(Boolean).length
        ? { warning: [createdWarning, warning].filter(Boolean).join("; ") }
        : {}),
    };
  }

  /**
   * Read the turn a session is running right now, so an interrupt can name it.
   *
   * Best effort by design: a status read that fails must not block a delivery
   * the host would still accept. `undefined` means "unknown", and the caller
   * reports that instead of guessing at a turn to abort.
   */
  async function readActiveTurn(sessionId, ctx) {
    try {
      const value = await readStatus(sessionId, { signal: ctx.signal });
      const turnId = typeof value.currentTask?.turnId === "string" ? value.currentTask.turnId.trim() : "";
      const messageId = typeof value.currentTask?.messageId === "string" ? value.currentTask.messageId.trim() : "";
      return { status: value.status, turnId, messageId, active: Boolean(turnId) || BUSY_STATUSES.has(value.status) };
    } catch {
      return undefined;
    }
  }

  /**
   * Stop the turn that was running *before* the new instruction was delivered.
   *
   * Ordering matters more than the mechanism. The host exposes two interrupt
   * entries, and both can be aimed at one specific target:
   *
   *   1. `agent/abort` with the old turn id. The host refuses the request unless
   *      that id is still the session's active turn (`{aborted:false}`), so a
   *      turn that already ended — or the turn the new message just started —
   *      can never be hit by a late arrival of this call.
   *   2. `session/collaboration/cancel` naming the old *message* id. The host
   *      only cancels that one queued row and only interrupts the turn bound to
   *      it.
   *
   * A cancel with no message id is the one call that withdraws every queued
   * row of a session, i.e. the instruction we just delivered before the model
   * could read it. There is deliberately no path here that reaches it.
   */
  async function interruptRunningTurn({ sessionId, turnId, messageId }, ctx) {
    const attempts = [];
    const report = (extra) => ({ ...extra, attempts });
    if (turnId) {
      try {
        const value = await runtime.invokeOperation(SESSION_ABORT, [{ sessionId, turnId }], { signal: ctx.signal, read: false });
        const aborted = value?.aborted !== false && value?.ok !== false;
        attempts.push({ channel: SESSION_ABORT, ok: aborted, turnId, ...(aborted ? {} : { reason: "turn-not-active" }) });
        return report(aborted
          ? { interrupted: true, channel: SESSION_ABORT, turnId }
          : { interrupted: false, channel: SESSION_ABORT, turnId, reason: "old-turn-already-finished" });
      } catch (error) {
        attempts.push({
          channel: SESSION_ABORT, ok: false,
          code: error?.code || "UNKNOWN", message: String(error?.message || error).slice(0, 200),
        });
      }
    }
    if (messageId) {
      try {
        await runtime.call("cancel", { sessionId, messageId }, { signal: ctx.signal, read: false });
        // `cancel` answers `cancelled: true` even when it changed nothing, so the
        // only evidence that the turn stopped is a fresh status read.
        const after = await readActiveTurn(sessionId, ctx);
        const stopped = !after || !after.active || (turnId ? after.turnId !== turnId : true);
        attempts.push({ channel: "cancel", ok: stopped, messageId, ...(stopped ? {} : { reason: "turn-still-running" }) });
        return report({
          interrupted: stopped, channel: "cancel", messageId,
          ...(turnId ? { turnId } : {}),
          ...(stopped ? {} : { reason: after ? "turn-still-running" : "unverified" }),
        });
      } catch (error) {
        attempts.push({
          channel: "cancel", ok: false,
          code: error?.code || "UNKNOWN", message: String(error?.message || error).slice(0, 200),
        });
      }
    }
    const last = attempts[attempts.length - 1];
    return report({ interrupted: false, reason: last ? last.code || last.reason || "interrupt-failed" : "no-target" });
  }

  /**
   * Watch one delivery until it leaves `queued`, or the read-back budget ends.
   *
   * `cancelled` is the only status that means the instruction never reached the
   * model: `queued` is still waiting for a turn, `running` and the terminal
   * statuses all mean it was read.
   */
  async function verifyDelivery(sessionId, messageId, ctx) {
    let last;
    let readError;
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      try {
        const value = await readResult({ sessionId, messageId }, { signal: ctx.signal });
        last = value?.message;
        readError = undefined;
        if (last && last.status !== "queued") {
          return { status: last.status, turnId: last.turnId || "", verified: true };
        }
      } catch (error) {
        readError = error?.code || "UNKNOWN";
        if (readError !== "TIMEOUT") break;
      }
      if (attempt < VERIFY_ATTEMPTS - 1) {
        try {
          await runtime.sleep(VERIFY_INTERVAL_MS, { signal: ctx.signal });
        } catch {
          break;
        }
      }
    }
    return {
      status: last?.status || "", turnId: last?.turnId || "", verified: false,
      ...(readError ? { readError } : {}),
    };
  }

  /** Carry the caller's retry identity, but never reuse it for a re-delivery. */
  function attemptKey(base, attempt) {
    return attempt <= 1 ? base : String(`${base}#r${attempt}`).slice(0, 256);
  }

  function interruptEnabled(args) {
    if (args.interrupt === undefined || args.interrupt === null) return DEFAULT_INTERRUPT;
    if (typeof args.interrupt !== "boolean") throw taskError("INVALID_ARGUMENT", "interrupt must be a boolean");
    return args.interrupt;
  }

  /**
   * Deliver one instruction and, unless the caller opted out, interrupt the turn
   * that was running before it.
   *
   * The sequence is always deliver → interrupt → read back, and the interrupt
   * can only name the *old* turn or the *old* message. That is what keeps the
   * new instruction out of the withdrawal race: by the time anything is
   * interrupted, the instruction is already in the host queue under its own
   * row, and nothing this function calls touches that row.
   *
   * The read-back is the safety net for the case where the host still settles
   * the new message as `cancelled`: it is then re-delivered under a fresh
   * idempotency key, up to three attempts, and the caller is told how many
   * attempts it took (`withdrawnRetried`) instead of being handed a silent
   * "sent".
   */
  async function send(args, ctx) {
    const owner = contextSessionId(ctx);
    const sessionId = targetSessionId(args);
    const content = text(args.message, "message", 65_536);
    // Some models materialize every schema key with empty values (#978 in
    // vastsa/PI-Desktop). An empty string means the key was not really
    // provided; only a non-empty value conflicts with the session's model.
    if (args.model !== undefined && args.model !== "") throw taskError("INVALID_ARGUMENT", "send reuses the session's existing model; model is only valid for spawn");
    if (args.kind !== undefined && !["task", "message"].includes(args.kind)) {
      throw taskError("INVALID_ARGUMENT", "kind must be task or message");
    }
    const interrupt = interruptEnabled(args);
    // A caller may name the turn to interrupt; otherwise the live status does.
    const hintTurnId = optionalText(args.turnId, "turnId");
    const options = deliveryOptions(args);
    const callback = options.notifyOnCompletion ?? DEFAULT_NOTIFY_ON_COMPLETION;

    // 1. Name the running turn before anything is queued behind it.
    const before = interrupt ? await readActiveTurn(sessionId, ctx) : undefined;
    const oldTurnId = hintTurnId || before?.turnId || "";
    const oldMessageId = before?.messageId || "";
    const wantedInterrupt = interrupt && (before ? before.active : Boolean(oldTurnId));

    const baseKey = options.idempotencyKey || `steer-${randomUUID()}`;
    let receipt;
    let messageId = "";
    let interruption;
    let verification;
    let attempts = 0;
    let withdrawnRetried = false;
    for (let attempt = 1; attempt <= MAX_WITHDRAW_RETRIES; attempt += 1) {
      attempts = attempt;
      // 2. Deliver first. The message gets its own row and its own key, so it can
      // never share an identity with the turn that is about to be interrupted.
      receipt = validateDelivery(await runtime.call("send", {
        sessionId, content, ...(args.kind ? { kind: args.kind } : {}),
        notifyOnCompletion: callback,
        idempotencyKey: attemptKey(baseKey, attempt),
      }, { signal: ctx.signal, read: false }));
      if (receipt.sessionId !== sessionId) throw taskError("INTERNAL", "Host returned a delivery for a different session");
      messageId = receipt.messageId;
      // 3. Then interrupt the old turn only, and only once.
      if (attempt === 1 && wantedInterrupt && (oldTurnId || oldMessageId)) {
        interruption = await interruptRunningTurn({ sessionId, turnId: oldTurnId, messageId: oldMessageId }, ctx);
      }
      // 4. Read the new delivery back: withdrawn means it must be re-sent.
      verification = await verifyDelivery(sessionId, messageId, ctx);
      if (verification.status !== "cancelled") break;
      withdrawnRetried = true;
    }
    const status = verification?.status || receipt.status;
    const delivered = status !== "cancelled";
    const started = STARTED_STATUSES.has(status);
    const interruptionReport = interruption || (interrupt ? { interrupted: false, reason: before ? "session-idle" : "status-unavailable" } : undefined);
    const warning = await runtime.remember(sessionId, owner, undefined, {
      status,
      lastMessageId: messageId,
      ...(verification?.turnId ? { lastTurnId: verification.turnId } : {}),
      lastActivityAt: new Date(now()).toISOString(),
    });
    return {
      action: "send",
      sessionId,
      messageId,
      status,
      accepted: delivered,
      delivered,
      started,
      interrupted: interruption?.interrupted === true,
      attempts,
      withdrawnRetried,
      verified: verification?.verified === true,
      interruptRequested: interrupt,
      ...(verification?.turnId ? { turnId: verification.turnId } : {}),
      ...(interruptionReport ? { interruption: interruptionReport } : {}),
      ...(delivered ? {} : { reason: status === "cancelled" ? "withdrawn" : "not-delivered" }),
      ...(warning ? { warning } : {}),
    };
  }

  /**
   * The session a worker reports to: the one that delegated it.
   *
   * The plugin's own row answers first — it is written when the worker is
   * spawned or first messaged and survives host restarts. The host's own
   * collaboration provenance is the fallback for a worker this plugin did not
   * create, and an explicit `sessionId` always wins, because the caller may
   * know better than either.
   */
  async function resolveNoticeTarget(workerSessionId, args, ctx) {
    const explicit = optionalText(args.sessionId ?? args.workerId, "sessionId");
    if (explicit) return explicit;
    const entry = store.get(workerSessionId);
    const owners = Array.isArray(entry?.referencedBy) ? entry.referencedBy : [];
    for (let index = owners.length - 1; index >= 0; index -= 1) {
      const owner = owners[index];
      if (owner && owner !== workerSessionId) return owner;
    }
    let summary;
    try {
      summary = await runtime.call("status", { sessionId: workerSessionId }, { signal: ctx.signal });
    } catch {
      summary = undefined;
    }
    const creator = summary?.createdBySession ?? summary?.creator ?? summary?.provenance?.createdBySession;
    const candidate = typeof creator === "string"
      ? creator
      : creator?.sessionId || creator?.id || summary?.createdBySessionId;
    const id = typeof candidate === "string" ? candidate.trim() : "";
    if (id && id !== workerSessionId) return id;
    throw taskError(
      "NO_PARENT",
      "This session has no delegating parent session; pass sessionId to name the recipient",
      { workerSessionId },
    );
  }

  /**
   * How often one worker may report the same kind.
   *
   * Default 5 s, configurable through the plugin setting `notifyMinIntervalMs`
   * (Settings → Plugins) and overridable per instance for tests.
   */
  async function notifyInterval(ctx) {
    if (Number.isFinite(options.notifyIntervalMs)) {
      return Math.max(0, Math.min(MAX_NOTIFY_MIN_INTERVAL_MS, Math.floor(options.notifyIntervalMs)));
    }
    const settings = await runtime.settings({ signal: ctx.signal });
    const configured = Number(settings?.notifyMinIntervalMs);
    if (Number.isFinite(configured) && configured >= 0) {
      return Math.min(MAX_NOTIFY_MIN_INTERVAL_MS, Math.floor(configured));
    }
    return DEFAULT_NOTIFY_MIN_INTERVAL_MS;
  }

  const lastNotices = new Map();

  /**
   * Report progress, a question, or a blocker to the delegating session without
   * ending the caller's own turn.
   *
   * The delivery is one ordinary collaboration message in the other direction,
   * so the caller waits for a single host write and its turn keeps running. It
   * is explicitly *not* a completion: `notifyOnCompletion` is false, the body
   * carries the `[worker-report:<kind>]` marker, and the receiving side reads it
   * as an incoming message rather than as a finished report.
   *
   * Repeats of the same kind inside the minimum interval are dropped with
   * `throttled: true` and a `retryAfterMs`, because a chatty worker must not be
   * able to flood the delegating session.
   */
  async function notify(args, ctx) {
    const workerSessionId = contextSessionId(ctx);
    const kind = noticeKind(args.kind);
    const body = text(args.text ?? args.message, "text", MAX_NOTICE_CHARS);
    const target = await resolveNoticeTarget(workerSessionId, args, ctx);
    if (target === workerSessionId) {
      throw taskError("INVALID_ARGUMENT", "notify cannot target the caller's own session");
    }
    const interval = await notifyInterval(ctx);
    const at = now();
    const key = `${workerSessionId}\u0000${kind}`;
    const previous = lastNotices.get(key);
    if (previous && interval > 0 && at - previous.at < interval) {
      return {
        action: "notify",
        delivered: false,
        throttled: true,
        kind,
        targetSessionId: target,
        retryAfterMs: Math.max(1, previous.at + interval - at),
        lastMessageId: previous.messageId,
        minIntervalMs: interval,
        note: "同一 worker 同一 kind 的上报还在最小间隔内：这次没有投递。把内容攒到下一条里，或等 retryAfterMs 之后再报。",
      };
    }
    const entry = store.get(workerSessionId);
    const receipt = validateDelivery(await runtime.call("send", {
      sessionId: target,
      content: noticeContent({ kind, body, workerSessionId, title: entry?.title }),
      kind: "message",
      notifyOnCompletion: false,
      idempotencyKey: `notice-${randomUUID()}`,
    }, { signal: ctx.signal, read: false }));
    if (receipt.sessionId !== target) throw taskError("INTERNAL", "Host returned a delivery for a different session");
    lastNotices.set(key, { at, messageId: receipt.messageId });
    try {
      await store.update(workerSessionId, {
        lastNotice: body.slice(0, MAX_NOTICE_SUMMARY_CHARS),
        lastNoticeAt: new Date(at).toISOString(),
        lastNoticeKind: kind,
      });
    } catch {
      // The report already landed; a settings write failure is UI history only.
    }
    return {
      action: "notify",
      delivered: true,
      throttled: false,
      kind,
      targetSessionId: target,
      messageId: receipt.messageId,
      status: receipt.status,
      notifyOnCompletion: false,
      minIntervalMs: interval,
      note: receipt.status === "queued"
        ? "上报已进入父会话队列（它在忙时排队等待），你的回合不受影响，继续干活。"
        : "上报已投递给父会话，你的回合继续。",
    };
  }

  async function status(args, ctx, action = "status") {
    const owner = contextSessionId(ctx);
    await runtime.ensureOperation(PREFIX + "status", { signal: ctx.signal });
    const ids = selectedSessionIds(args) || store.list(owner, MAX_SELECTED_SESSIONS).map((entry) => entry.sessionId);
    const workers = await Promise.all(ids.map((id) => readStatus(id, { signal: ctx.signal })));
    return { action, workers: workers.map((entry) => withAcceptance(entry, owner)) };
  }

  async function list(args, ctx) {
    const owner = contextSessionId(ctx);
    await runtime.ensureOperation(PREFIX + "list", { signal: ctx.signal });
    const value = await runtime.call("list", {}, { signal: ctx.signal });
    if (!value || !Array.isArray(value.sessions) || value.sessions.length > 100 || value.sessions.some((entry) => (
      !entry || typeof entry.sessionId !== "string" || !entry.sessionId ||
      typeof entry.title !== "string" || typeof entry.status !== "string"
    ))) {
      throw taskError("INTERNAL", "Host returned an invalid session directory");
    }
    // Keep the legacy workers field for callers that used list() as a recent
    // reference status read. The host-backed sessions field is the authority
    // for discovering independent top-level sessions.
    const ids = store.list(owner, MAX_SELECTED_SESSIONS).map((entry) => entry.sessionId);
    const workers = await Promise.all(ids.map((id) => readStatus(id, { signal: ctx.signal })));
    return {
      action: "list",
      sessions: value.sessions,
      workers: workers.map((entry) => withAcceptance(entry, owner)),
    };
  }

  async function result(args, ctx) {
    const owner = contextSessionId(ctx);
    const sessionId = targetSessionId(args);
    const value = await readResult(resultSelector(args, sessionId), { signal: ctx.signal });
    const warning = await runtime.remember(sessionId, owner, value.message?.targetTitle, {
      ...(value.message?.status ? { status: value.message.status } : {}),
      ...(value.message?.turnId ? { lastTurnId: value.message.turnId } : {}),
      ...(value.message?.id ? { lastMessageId: value.message.id } : {}),
      ...(typeof value.message?.result === "string" && value.message.result
        ? { lastResult: value.message.result }
        : {}),
      lastActivityAt: new Date().toISOString(),
    });
    return {
      action: "result", ...value,
      worker: resultWorker(sessionId, value),
      ...(warning ? { warning } : {}),
    };
  }

  async function wait(args, ctx) {
    const owner = contextSessionId(ctx);
    const ids = selectedSessionIds(args, true);
    if ((args.messageId || args.turnId) && ids.length !== 1) {
      throw taskError("INVALID_ARGUMENT", "A specific messageId or turnId requires one sessionId");
    }
    const deadline = Date.now() + waitTimeout(args.timeoutMs);
    const options = { signal: ctx.signal, deadline };
    async function readUntilDeadline(read) {
      while (true) {
        try {
          return await read();
        } catch (error) {
          if (error.code !== "TIMEOUT" || error.details?.localTimeout !== true) throw error;
          runtime.assertActive(ctx.signal);
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw taskError("WAIT_TIMEOUT", "Session Orchestrator wait timed out", { localTimeout: true });
          await runtime.sleep(Math.min(POLL_INTERVAL_MS, remaining), options);
        }
      }
    }
    let workers = ids.map((sessionId) => ({ sessionId, status: "unknown" }));
    try {
      while (true) {
        runtime.assertActive(ctx.signal);
        if (args.messageId || args.turnId) {
          const value = await readUntilDeadline(() => readResult(resultSelector(args, ids[0]), options));
          workers = [resultWorker(ids[0], value)];
          if (value.ready) {
            return { action: "wait", timedOut: false, workers, results: [value] };
          }
        } else {
          workers = await Promise.all(ids.map((id) => readUntilDeadline(() => readStatus(id, options))));
          runtime.assertActive(ctx.signal);
          if (workers.every((entry) => TERMINAL_STATUSES.has(entry.status) || entry.status === "idle")) {
            const results = await Promise.all(workers.map((entry) => {
              const messageId = entry.currentTask?.messageId || entry.result?.messageId;
              return readUntilDeadline(() => readResult({ sessionId: entry.sessionId, ...(messageId ? { messageId } : {}) }, options));
            }));
            runtime.assertActive(ctx.signal);
            const settled = results.every((result, index) => {
              const status = workers[index];
              const hasNoDelivery = status.status === "idle" && !status.currentTask && !status.result;
              return hasNoDelivery || (result.ready && result.message && TERMINAL_STATUSES.has(result.message.status));
            });
            if (settled) {
              return {
                action: "wait", timedOut: false,
                workers: workers.map((entry, index) => ({
                  ...withAcceptance(entry, owner), ...resultWorker(entry.sessionId, results[index]),
                })),
                results,
              };
            }
          }
        }
        await runtime.sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), options);
      }
    } catch (error) {
      if (error.code !== "WAIT_TIMEOUT" || error.details?.localTimeout !== true) throw error;
      return { action: "wait", timedOut: true, workers };
    }
  }

  async function supervise(args, ctx) {
    contextSessionId(ctx);
    const ids = selectedSessionIds(args, true);
    if (ids.length > 4) throw taskError("LIMIT_EXCEEDED", "Select at most four sessions for supervise");
    text(args.message, "message", 65_536);
    deliveryOptions(args);
    if (args.idempotencyKey) throw taskError("INVALID_ARGUMENT", "Use send with a distinct idempotencyKey for each session");
    const settled = await Promise.allSettled(ids.map((sessionId) => send({ ...args, sessionId, workerId: undefined }, ctx)));
    const workers = [];
    const failures = [];
    settled.forEach((entry, index) => {
      if (entry.status === "fulfilled") {
        const { action, ...receipt } = entry.value;
        workers.push(receipt);
      } else {
        failures.push({ sessionId: ids[index], code: entry.reason?.code || "UNKNOWN", message: String(entry.reason?.message || entry.reason) });
      }
    });
    return { action: "supervise", accepted: failures.length === 0, workers, ...(failures.length ? { failures } : {}) };
  }

  async function accept(args, ctx) {
    const owner = contextSessionId(ctx);
    const ids = selectedSessionIds(args, true);
    if ((args.messageId || args.turnId) && ids.length !== 1) {
      throw taskError("INVALID_ARGUMENT", "A specific messageId or turnId requires one sessionId");
    }
    const note = optionalText(args.note, "note", MAX_ACCEPTANCE_NOTE_CHARS);
    const results = await Promise.all(ids.map((sessionId) => readResult(resultSelector(args, sessionId), { signal: ctx.signal })));
    if (results.some((entry) => !entry.ready || entry.message?.status !== "completed" || !entry.message.result?.trim())) {
      throw taskError("WORKER_NOT_READY", "Only a completed host delivery with a final report can be accepted");
    }
    runtime.assertActive(ctx.signal);
    const acceptedAt = new Date().toISOString();
    const acceptances = results.map((entry, index) => ({
      sessionId: ids[index], messageId: entry.message.id, acceptedBySessionId: owner,
      acceptedAt, ...(note ? { note } : {}),
    }));
    await store.accept(acceptances);
    return {
      action: "accept", accepted: true, acceptances,
      workers: results.map((entry, index) => ({ ...resultWorker(ids[index], entry), acceptanceStatus: "accepted", acceptance: acceptances[index] })),
    };
  }

  async function cancel(args, ctx) {
    contextSessionId(ctx);
    const sessionId = targetSessionId(args);
    const messageId = optionalText(args.messageId, "messageId");
    const cancelled = await runtime.call("cancel", {
      sessionId, ...(messageId ? { messageId } : {}),
    }, { signal: ctx.signal, read: false });
    return { action: "cancel", ...cancelled };
  }

  /**
   * Merge one live host status into the cached row. Best effort: the row is UI only.
   *
   * `lastActivityAt` only moves when the host actually reports something new —
   * otherwise a plain refresh would claim every seen worker was active "just
   * now" and hide the stale queue.
   */
  async function applyStatus(entry, value) {
    const turnId = value.currentTask?.turnId || value.result?.turnId || "";
    const messageId = value.currentTask?.messageId || value.result?.messageId || "";
    const changed = value.status !== entry.status ||
      (turnId !== "" && turnId !== entry.lastTurnId) ||
      (messageId !== "" && messageId !== entry.lastMessageId);
    const patch = {
      status: value.status,
      ...(changed ? { lastActivityAt: new Date().toISOString() } : {}),
      ...(turnId ? { lastTurnId: turnId } : {}),
      ...(messageId ? { lastMessageId: messageId } : {}),
    };
    try {
      await store.update(entry.sessionId, patch);
    } catch {
      // A settings write failure must not hide the live status in the answer.
    }
    return { ...entry, ...patch };
  }

  /**
   * Live status for the given rows; a per-worker failure keeps its cached row.
   *
   * Batched so a full 128-row list still fits inside the host's 30 s bridge
   * budget, and every entry is refreshed: nothing disappears from a list just
   * because the user pressed 刷新.
   */
  async function refreshWorkers(entries, options = {}) {
    const rows = [];
    for (let start = 0; start < entries.length; start += REFRESH_BATCH_SIZE) {
      const batch = entries.slice(start, start + REFRESH_BATCH_SIZE);
      const settled = await Promise.all(batch.map(async (entry) => {
        try {
          return { entry, status: await readStatus(entry.sessionId, options) };
        } catch (error) {
          return { entry, error };
        }
      }));
      for (const item of settled) {
        const entry = item.status ? await applyStatus(item.entry, item.status) : item.entry;
        rows.push(workerRow(entry, Date.now()));
      }
    }
    return rows;
  }

  async function workers(args, ctx) {
    const owner = contextSessionId(ctx);
    const entries = store.list(owner, MAX_WORKERS);
    const live = args.refresh !== false && entries.length > 0;
    if (!live) return { action: "workers", live: false, count: entries.length, workers: workerRows(entries) };
    await runtime.ensureOperation(PREFIX + "status", { signal: ctx.signal });
    const rows = await refreshWorkers(entries, {
      signal: ctx.signal,
      deadline: Date.now() + TOOL_REFRESH_BUDGET_MS,
    });
    return { action: "workers", live: true, count: rows.length, workers: rows };
  }

  async function execute(args, ctx) {
    runtime.assertActive(ctx?.signal);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw taskError("INVALID_ARGUMENT", "SessionTask arguments must be an object");
    const action = text(args.action, "action", 32);
    switch (action) {
      case "spawn": return spawn(args, ctx);
      case "spawnIn": return spawnIn(args, ctx);
      case "send": return send(args, ctx);
      case "notify": return notify(args, ctx);
      case "status": return status(args, ctx);
      case "list": return list(args, ctx);
      case "result": return result(args, ctx);
      case "wait": return wait(args, ctx);
      case "supervise": return supervise(args, ctx);
      case "accept": return accept(args, ctx);
      case "cancel": return cancel(args, ctx);
      case "workers": return workers(args, ctx);
      case "models": {
        contextSessionId(ctx);
        const models = catalog(await runtime.models({ signal: ctx.signal }));
        return { action, models, automaticCandidates: models.filter((row) => row.availableForSubagents), defaultModel: models.find((row) => row.isDefault)?.key || null };
      }
      default: throw taskError("INVALID_ARGUMENT", `Unsupported SessionTask action: ${action}`);
    }
  }
  return { execute, refreshWorkers, readStatus, applyStatus };
}

module.exports = { NOTICE_MARKER, createActions, noticeContent, noticeKind, resultSelector, resultWorker };
