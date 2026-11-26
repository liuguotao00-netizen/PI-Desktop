"use strict";

/**
 * Pure rendering helpers. Nothing here touches the host, so every card and row
 * this plugin shows can be unit tested without a running PI-Desktop.
 */

const SUMMARY_CHARS = 300;
const ONE_LINE_CHARS = 180;
const OUTCOME_LABELS = {
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
  unknown: "结束",
};
const CANCELLED_REASONS = new Set(["aborted", "cancelled", "canceled", "interrupted", "user_aborted", "stopped"]);
const FAILED_REASONS = new Set(["error", "failed", "failure", "timeout"]);

function collapse(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clip(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** First `limit` characters of a worker's final report, with whitespace folded. */
function summarize(value, limit = SUMMARY_CHARS) {
  return clip(collapse(value), limit);
}

/**
 * The worker's own status contract, read out of its final report.
 *
 * A free-text summary cannot tell an orchestrator whether it may stop or whether
 * the person has to decide something. Workers are asked to end their report with
 * two fields:
 *
 *   state: ready | blocked | failed
 *   human_action: none | <one concrete thing the person must do>
 *
 * This parser is deliberately forgiving about presentation (markdown emphasis,
 * full-width colon, casing, surrounding bullets) and deliberately strict about
 * meaning: a state word it does not recognise is dropped rather than guessed, so
 * an unrecognised report keeps the old free-text card instead of being labelled
 * with a status nobody verified.
 */
const STATUS_STATES = new Set(["ready", "blocked", "failed"]);
const NO_ACTION = new Set(["none", "no", "n/a", "na", "nothing", "-"]);
// `**State:** blocked` puts the colon inside the emphasis, so closing markers are
// allowed on both sides of it.
const STATUS_LINE = /^[\s>*_`\-]*\**(state|human_action)\**\s*[:：]\s*\**\s*(.*)$/i;

/**
 * Read the status contract from a report body.
 *
 * Returns `{}` when neither field is present, or when the state word is not one
 * the contract defines. `humanAction` is `"none"` only when the worker explicitly
 * said so; a blocked state with no readable action stays blocked with no action,
 * which the card renders as a generic request for the person rather than
 * inventing specifics.
 */
function readStatusContract(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let state;
  let humanAction;
  for (const line of lines) {
    const match = STATUS_LINE.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = collapse(match[2]).replace(/^["'`]+|["'`]+$/g, "");
    if (field === "state") {
      const word = value.toLowerCase().split(/[\s,;（(]/)[0];
      if (STATUS_STATES.has(word)) state = word;
    } else if (!humanAction) {
      humanAction = value;
    }
  }
  // A state field whose value is not one the contract defines voids the whole
  // contract: the worker tried to declare a status and we cannot read it, so
  // trusting the rest of its fields would mean guessing at the one thing this
  // parser exists to be strict about. No state means the old free-text card.
  if (!state) return {};
  const out = { state };
  if (humanAction) out.humanAction = NO_ACTION.has(humanAction.toLowerCase()) ? "none" : humanAction;
  return out;
}

/**
 * True when the person has to do something before this work can continue.
 *
 * `blocked` means the worker could not proceed on its own, whatever it managed to
 * name; the card therefore always asks the person, and only uses `humanAction`
 * to say what. `ready` and `failed` never need a decision to *read* the report.
 */
function needsPerson(state) {
  return state === "blocked";
}

/**
 * A host turn reason is one of the Agent runtime's finish reasons; the host
 * itself maps them onto completed/failed/interrupted. Anything unknown is
 * treated as completed because the turn did settle.
 */
function turnOutcome(reason) {
  const value = String(reason ?? "").trim().toLowerCase();
  if (CANCELLED_REASONS.has(value)) return "cancelled";
  if (FAILED_REASONS.has(value)) return "failed";
  if (!value) return "unknown";
  return "completed";
}

/**
 * A settled turn gets a card unless it was cancelled: an unrecognised host
 * reason is still a settle, and dropping the card there would lose the result
 * the whole feature exists to surface.
 */
function shouldCard(outcome) {
  return outcome !== "cancelled";
}

function outcomeLabel(outcome) {
  return OUTCOME_LABELS[outcome] || OUTCOME_LABELS.unknown;
}

function relativeTime(iso, now = Date.now()) {
  const at = Date.parse(String(iso ?? ""));
  if (Number.isNaN(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(at).toISOString().slice(0, 10);
}

/** One row for the Workers view and for the `workers` action. */
function workerRow(entry, now = Date.now()) {
  const record = entry && typeof entry === "object" ? entry : {};
  const sessionId = String(record.sessionId ?? "");
  const lastActivityAt = record.lastActivityAt || record.updatedAt || record.createdAt || "";
  return {
    sessionId,
    title: String(record.title || sessionId),
    status: String(record.status || "unknown"),
    lastActivityAt,
    lastActivity: relativeTime(lastActivityAt, now),
    ...(record.projectPath ? { projectPath: String(record.projectPath) } : {}),
    ...(record.lastResult ? { result: summarize(record.lastResult, SUMMARY_CHARS) } : {}),
    ...(record.lastTurnId ? { turnId: String(record.lastTurnId) } : {}),
  };
}

function workerRows(entries, now = Date.now()) {
  return (Array.isArray(entries) ? entries : []).map((entry) => workerRow(entry, now));
}

/**
 * The card that lands in the main session when a worker's turn ends.
 *
 * `text` is the message body (markdown-ish); `oneLine` is the bounded fallback a
 * composer suggestion or a toast can carry.
 *
 * The status contract decides how loud the card is. A `blocked` worker puts the
 * concrete human action on the first line, because that is the only part the
 * person has to read. A `ready` worker keeps the old compact shape. No readable
 * state (older workers, or a report that forgot the contract) renders exactly
 * what it always did — the card must never lose a result to a missing field.
 */
function resultCard({ title, sessionId, summary, outcome = "completed", projectPath, status } = {}) {
  const id = String(sessionId ?? "").trim();
  const name = collapse(title) || id;
  const label = outcomeLabel(outcome);
  const body = summarize(summary, SUMMARY_CHARS);
  const contract = status && typeof status === "object" ? status : readStatusContract(summary);
  const state = contract.state;
  const action = contract.humanAction;

  if (needsPerson(state)) {
    const ask = action && action !== "none"
      ? `需要你决定：${action}`
      : "需要你决定：worker 受阻，但它没写清要你做什么——先读下面的报告再定。";
    const lines = [
      `【子会话${label} · 需要你决定】${name}`,
      ask,
      ...(body ? [body] : ["（没有可读的结果摘要）"]),
      ...(projectPath ? [`项目：${projectPath}`] : []),
      `sessionId: ${id}`,
    ];
    return {
      sessionId: id,
      title: name,
      outcome,
      state,
      ...(action ? { humanAction: action } : {}),
      summary: body,
      text: lines.join("\n"),
      oneLine: clip(`子会话${label}·需要你决定：${name}`, ONE_LINE_CHARS),
    };
  }

  const lines = [
    `【子会话${label}${state ? ` · ${state}` : ""}】${name}`,
    ...(body ? [body] : ["（没有可读的结果摘要）"]),
    ...(projectPath ? [`项目：${projectPath}`] : []),
    `sessionId: ${id}`,
  ];
  return {
    sessionId: id,
    title: name,
    outcome,
    ...(state ? { state } : {}),
    ...(action && action !== "none" ? { humanAction: action } : {}),
    summary: body,
    text: lines.join("\n"),
    oneLine: clip(`子会话${label}：${name}（${id}）`, ONE_LINE_CHARS),
  };
}

function matchWorker(payload, entries) {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
  if (!sessionId) return undefined;
  return (Array.isArray(entries) ? entries : []).find((entry) => entry?.sessionId === sessionId);
}

function alreadyCarded(entry, turnId) {
  const turn = typeof turnId === "string" ? turnId.trim() : "";
  if (!turn) return false;
  return Array.isArray(entry?.cardedTurns) && entry.cardedTurns.includes(turn);
}

/**
 * The `session.appendMessage` body for one card. The card text names the worker;
 * `target` is the session the message is written into (the main session).
 */
function appendMessageInput(card, target, now = new Date()) {
  return {
    sessionId: String(target || card.sessionId),
    message: {
      role: "assistant",
      content: card.text,
      createdAt: new Date(now).toISOString(),
    },
  };
}

module.exports = {
  SUMMARY_CHARS,
  appendMessageInput,
  alreadyCarded,
  collapse,
  matchWorker,
  needsPerson,
  outcomeLabel,
  readStatusContract,
  relativeTime,
  resultCard,
  shouldCard,
  summarize,
  turnOutcome,
  workerRow,
  workerRows,
};
