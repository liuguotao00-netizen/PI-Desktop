"use strict";

/**
 * Pi-CLI session adapter.
 *
 * Source files: `~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<session id>.jsonl`
 * (one JSON object per line, format v3).
 *
 * Recognised entries:
 * - `{ "type": "session", "id", "cwd" }`            → header (session id + project)
 * - `{ "type": "message", "message": { "role": "assistant", "usage": {...},
 *      "provider", "model", "timestamp", "responseId" } }` → one assistant record
 * - `{ "type": "compaction" | "branch_summary", "usage": {...} }` → one summary record
 *   (no model of its own; the scan's `lastModel` names the session model that ran it)
 *
 * Usage payload: `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { total } }`.
 */

const {
  createRecord,
  isObject,
  parseTimestampMs,
  readCostTotal,
  COST_RECORDED,
  COST_UNKNOWN,
} = require("../lib/normalize.js");

const SOURCE = "cli";

/**
 * Upper bound for the fallback duration: a line written more than a day after
 * its request was dispatched is clock skew or a resumed session, not a
 * generation time.
 */
const MAX_WALL_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a JSON line without throwing.
 * @param {string} line
 * @returns {unknown}
 */
function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Session header → identity + project path (Pi-CLI stores `cwd` in it).
 * @param {unknown} parsed
 * @returns {{ sessionId: string, projectPath: string | null } | null}
 */
function parseHeader(parsed) {
  if (!isObject(parsed) || parsed.type !== "session") return null;
  const sessionId =
    typeof parsed.id === "string" && parsed.id !== ""
      ? parsed.id
      : typeof parsed.sessionId === "string"
        ? parsed.sessionId
        : "";
  if (sessionId === "") return null;
  return {
    sessionId,
    projectPath: typeof parsed.cwd === "string" && parsed.cwd !== "" ? parsed.cwd : null,
  };
}

/**
 * One JSONL entry → zero or more records.
 *
 * @param {unknown} parsed
 * @param {{ sessionId: string, projectPath: string | null, fallbackTimestampMs: number, lastModel?: string, lastProvider?: string }} ctx
 * @returns {import("../lib/normalize.js").UsageRecord[]}
 */
function parseEntry(parsed, ctx) {
  if (!isObject(parsed)) return [];

  if (parsed.type === "compaction" || parsed.type === "branch_summary") {
    const usage = parsed.usage;
    if (!isObject(usage)) return [];
    const timestampMs =
      parseTimestampMs(parsed.timestamp) ?? parseTimestampMs(parsed.createdAt) ?? ctx.fallbackTimestampMs;
    const entryId =
      typeof parsed.id === "string" && parsed.id !== "" ? parsed.id : `summary:${timestampMs}`;
    const costUsd = readCostTotal(usage.cost);
    const record = createRecord({
      source: SOURCE,
      sessionId: ctx.sessionId,
      entryId,
      timestampMs,
      // A compaction row records what it spent but not who spent it: the CLI
      // writes `usage` only, and the row runs on the session's own model. Naming
      // that model keeps the tokens out of an "unknown model" slice that no
      // price could ever be matched to.
      provider: ctx.lastProvider ?? "",
      model: ctx.lastModel ?? "",
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      costUsd,
      costStatus: costUsd === null ? COST_UNKNOWN : COST_RECORDED,
      projectPath: ctx.projectPath,
      kind: "summary",
    });
    return record ? [record] : [];
  }

  if (parsed.type !== "message") return [];
  const message = parsed.message;
  if (!isObject(message) || message.role !== "assistant") return [];
  const usage = message.usage;
  if (!isObject(usage)) return [];

  const timestampMs =
    parseTimestampMs(message.timestamp) ?? parseTimestampMs(parsed.timestamp) ?? ctx.fallbackTimestampMs;
  const entryId = assistantEntryId(message, parsed, timestampMs);

  const costUsd = readCostTotal(usage.cost);
  // Pi writes the provider's rejection as text: "500: {json}". The leading code
  // is the HTTP status the provider answered with, when it wrote one.
  const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "";
  const statusMatch = /^\s*(\d{3})\b/.exec(errorMessage);
  // The CLI records the wall-clock duration on most (not all) rows. Where it is
  // missing, "line written − request dispatched" is the same quantity: on the
  // 6,269 rows that carry both, the ratio is 0.9974 / 0.9993 / 0.9998
  // (p10 / p50 / p90), so this is a fill-in, not a different metric.
  const writtenMs = parseTimestampMs(parsed.timestamp);
  const dispatchMs = typeof message.timestamp === "number" ? message.timestamp : null;
  const wallMs =
    dispatchMs !== null && writtenMs !== null && writtenMs > dispatchMs && writtenMs - dispatchMs <= MAX_WALL_MS
      ? writtenMs - dispatchMs
      : null;
  const durationMs = typeof message.durationMs === "number" ? message.durationMs : wallMs;
  const record = createRecord({
    source: SOURCE,
    sessionId: ctx.sessionId,
    entryId,
    timestampMs,
    provider: typeof message.provider === "string" ? message.provider : "",
    model: typeof message.model === "string" ? message.model : "",
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    costUsd,
    // Pi reports the cost for CLI turns; without a cost object the record is
    // flagged "unknown" so an aggregate can show that its total has a gap.
    costStatus: costUsd === null ? COST_UNKNOWN : COST_RECORDED,
    projectPath: ctx.projectPath,
    kind: "assistant",
    // The CLI writes the turn's wall-clock duration on most (not all) assistant
    // rows, and names the outcome in `stopReason`.
    durationMs,
    status: parsed.isError === true ? "error" : message.stopReason,
    statusCode: statusMatch ? Number(statusMatch[1]) : undefined,
  });
  return record ? [record] : [];
}

/**
 * Stable identity for one finalized assistant message: the provider response id
 * when present, otherwise the session entry id, otherwise a timestamp bucket.
 *
 * @param {Record<string, any>} message
 * @param {Record<string, any>} entry
 * @param {number} timestampMs
 * @returns {string}
 */
function assistantEntryId(message, entry, timestampMs) {
  if (typeof message.responseId === "string" && message.responseId !== "") return message.responseId;
  if (typeof entry.id === "string" && entry.id !== "") return entry.id;
  return `message:${timestampMs}`;
}

module.exports = {
  SOURCE,
  safeParse,
  parseHeader,
  parseEntry,
  assistantEntryId,
};
