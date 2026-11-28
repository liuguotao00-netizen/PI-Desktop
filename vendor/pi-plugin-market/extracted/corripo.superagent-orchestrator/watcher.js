"use strict";

const { alreadyCarded, readStatusContract, resultCard, shouldCard, summarize, turnOutcome } = require("./cards.js");

const TURN_ENDED = "session:turnEnded";
const RESULT_SUMMARY_LIMIT = 2_000;
// Mirrors actions.readResult: a delivery is settled only in a terminal status.
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const IN_FLIGHT_STATUSES = new Set(["queued", "running"]);

function lastOwner(entry) {
  const owners = Array.isArray(entry?.referencedBy) ? entry.referencedBy : [];
  return owners.length ? owners[owners.length - 1] : "";
}

/**
 * Read and validate one delivery outcome.
 *
 * `ready` is the host's own settle signal. The shape checks are the same ones
 * `actions.readResult` enforces, so the card and the tool answer can never
 * disagree about what the host said. Anything that fails them is reported as
 * invalid — never as a completed card.
 */
function readDelivery(value, sessionId) {
  const invalid = (reason) => ({ shape: "invalid", reason, settled: false, status: "unknown", summary: "" });
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("no-value");
  if (typeof value.ready !== "boolean") return invalid("no-ready-flag");
  const message = value.message;
  if (!message) return { shape: "empty", reason: "no-delivery", settled: value.ready === true, status: "unknown", summary: "" };
  if (typeof message.id !== "string" || !message.id) return invalid("no-message-id");
  const known = IN_FLIGHT_STATUSES.has(message.status) || TERMINAL_STATUSES.has(message.status);
  if (typeof message.status !== "string" || !known) return invalid("unknown-status");
  if (message.result !== undefined && typeof message.result !== "string") return invalid("bad-result");
  if (IN_FLIGHT_STATUSES.has(message.status)) {
    return { shape: "ok", reason: "in-flight", settled: false, status: message.status, summary: "" };
  }
  if (!value.ready) return invalid("unsettled-terminal");
  if (message.targetSessionId !== undefined && message.targetSessionId !== sessionId) {
    return invalid("other-session");
  }
  // The contract is read from the raw report, before `summarize` folds the
  // newlines away: the parser is line-oriented, and a collapsed summary would
  // never match. The summary itself stays folded for display.
  const raw = typeof message.result === "string" ? message.result : "";
  return {
    shape: "ok",
    settled: true,
    status: message.status,
    summary: raw ? summarize(raw, RESULT_SUMMARY_LIMIT) : "",
    contract: raw ? readStatusContract(raw) : {},
    ...(typeof message.turnId === "string" && message.turnId ? { turnId: message.turnId } : {}),
    messageId: message.id,
  };
}

/**
 * Turns `session:turnEnded` into a fixed landing place for a worker's result.
 *
 * The host broadcasts the event to every loaded plugin process, so the only
 * filter is the plugin's own worker store: a session this plugin never created
 * is ignored. `reason` decides whether a card is due — an aborted turn updates
 * the row and stops there. A delivery the host has not settled gets a status
 * update and no card, so a turn that ended before its delivery settled (a
 * queued follow-up, say) is never announced as a finished report.
 */
function createWatcher({ runtime, store, deliverer, events, log = () => {}, now = Date.now } = {}) {
  let started = false;
  const inflight = new Set();

  async function observe(sessionId) {
    let value;
    try {
      value = await runtime.call("result", { sessionId });
    } catch (error) {
      log("warn", `worker result read failed: ${String(error?.message || error).slice(0, 200)}`);
      return { shape: "invalid", reason: "read-failed", settled: false, status: "unknown", summary: "" };
    }
    return readDelivery(value, sessionId);
  }

  async function update(sessionId, patch) {
    try {
      await store.update(sessionId, patch);
    } catch (error) {
      log("warn", `worker row update failed: ${String(error?.message || error).slice(0, 200)}`);
    }
  }

  async function handleTurnEnded(payload) {
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    const turnId = typeof payload?.turnId === "string" ? payload.turnId.trim() : "";
    if (!sessionId) return { action: "ignored", reason: "no-session" };
    const entry = store.get(sessionId);
    if (!entry) return { action: "ignored", reason: "not-a-worker", sessionId };
    if (alreadyCarded(entry, turnId)) return { action: "ignored", reason: "already-carded", sessionId, turnId };

    const outcome = turnOutcome(payload?.reason);
    const observed = await observe(sessionId);
    // A host status wins. A cancelled or failed turn names its own outcome; an
    // unrecognised reason keeps whatever the row already said.
    const status = observed.status !== "unknown"
      ? observed.status
      : outcome === "unknown" ? entry.status : outcome;
    // The worker's own status contract, already read from the raw report by
    // readDelivery. Absent or unreadable fields simply stay out of the row and
    // the card keeps its old shape — a missing contract never costs the result.
    const contract = observed.contract || {};
    await update(sessionId, {
      status,
      lastActivityAt: new Date(now()).toISOString(),
      ...(observed.turnId || turnId ? { lastTurnId: observed.turnId || turnId } : {}),
      ...(observed.messageId ? { lastMessageId: observed.messageId } : {}),
      ...(observed.summary ? { lastResult: observed.summary } : {}),
      ...(contract.state ? { workerState: contract.state } : {}),
      ...(contract.humanAction ? { humanAction: contract.humanAction } : {}),
    });

    // A cancelled turn is not a report: the row is updated above and nothing is
    // announced.
    if (!shouldCard(outcome)) return { action: "status-only", sessionId, turnId, outcome, reason: observed.reason };
    // The turn settled; the delivery may not have. Announcing an unsettled
    // delivery as a finished report is the one thing a result card must not do.
    if (observed.shape !== "ok" || !observed.settled) {
      if (observed.shape !== "ok") {
        log("warn", `worker ${sessionId} result rejected (${observed.reason}); no card`);
      }
      return { action: "not-settled", sessionId, turnId, outcome, reason: observed.reason || "unsettled" };
    }

    const card = resultCard({
      title: entry.title,
      sessionId,
      summary: observed.summary,
      outcome: observed.status === "failed" || outcome === "failed" ? "failed" : "completed",
      projectPath: entry.projectPath,
      status: contract,
    });
    const target = lastOwner(entry);
    const delivery = await deliverer.deliver(card, { target });
    if (turnId) {
      try {
        await store.markCarded(sessionId, turnId, delivery.delivered || "none");
      } catch (error) {
        log("warn", `card marker not saved: ${String(error?.message || error).slice(0, 200)}`);
      }
    }
    return {
      action: delivery.delivered ? "card" : "card-not-shown",
      sessionId,
      turnId,
      outcome: card.outcome,
      target: target || null,
      delivered: delivery.delivered,
      attempts: delivery.attempts,
    };
  }

  function listener(payload) {
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    const turnId = typeof payload?.turnId === "string" ? payload.turnId.trim() : "";
    const key = `${sessionId}:${turnId}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    // An event handler must never throw into the host's broadcast loop.
    void handleTurnEnded(payload)
      .catch((error) => log("warn", `turn-ended handling failed: ${String(error?.message || error).slice(0, 200)}`))
      .finally(() => inflight.delete(key));
  }

  function start() {
    if (started) return true;
    if (!events || typeof events.on !== "function") {
      log("warn", "pi.events is unavailable; worker result cards are disabled");
      return false;
    }
    events.on(TURN_ENDED, listener);
    started = true;
    return true;
  }

  function stop() {
    if (!started) return;
    started = false;
    try {
      events?.off?.(TURN_ENDED, listener);
    } catch (error) {
      log("warn", `turn-ended unsubscribe failed: ${String(error?.message || error).slice(0, 200)}`);
    }
  }

  return { handleTurnEnded, listener, start, stop, started: () => started };
}

module.exports = { RESULT_SUMMARY_LIMIT, TURN_ENDED, createWatcher, readDelivery };
