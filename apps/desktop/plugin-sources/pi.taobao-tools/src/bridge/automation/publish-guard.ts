"use strict";

/**
 * One-attempt memory for publishing, so a retry cannot double-post.
 *
 * `PUBLISH_UNCONFIRMED` is the awkward failure: the post may already be live
 * and the tool could not prove it. The natural next move — run it again — is
 * the one move that publishes twice. A publish is remembered the moment the
 * button is pressed, and the same content cannot be attempted again on that
 * automation inside the script's own `dedupeWindowMs`.
 *
 * The memory is persisted: a restart or a second process must not forget that
 * a post was already attempted.
 *
 * Ported from QiWork's `automation/publish_guard.py`.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodedError } from "./errors";

const DEFAULT_WINDOW_MS = 300_000;
const MAX_ENTRIES = 256;

function dataDir() {
  const root =
    process.env.PI_DESKTOP_DATA_DIR || path.join(os.homedir(), ".pi-desktop");
  return path.join(root, "plugins", "data", "pi.taobao-tools", "automation");
}

function attemptsPath() {
  return path.join(dataDir(), "publish-attempts.json");
}

function readAttempts(): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(attemptsPath(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, number>)
      : {};
  } catch (error) {
    return {};
  }
}

function writeAttempts(attempts: Record<string, number>): void {
  fs.mkdirSync(path.dirname(attemptsPath()), { recursive: true });
  const temporary = `${attemptsPath()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(attempts), "utf8");
  fs.renameSync(temporary, attemptsPath());
}

function prune(attempts: Record<string, number>, windowMs: number): void {
  const now = Date.now();
  for (const [key, started] of Object.entries(attempts)) {
    if (!Number.isFinite(Number(started)) || now - Number(started) >= windowMs) {
      delete attempts[key];
    }
  }
}

/** Stable key-sorted JSON, so two equal parameter sets digest the same. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Stable fingerprint of the parameters that were shown to the user. */
function digestContext(context: unknown): string {
  return crypto
    .createHash("sha256")
    .update(stableStringify(context || {}))
    .digest("hex");
}

function buildKey(automation: string, digest: string): string {
  return `local|${automation}|${digest}`;
}

/** Throw if this exact content was published inside the window. */
function check(
  key: string,
  { windowMs = DEFAULT_WINDOW_MS }: { windowMs?: number } = {},
): void {
  const window = Math.max(0, Number(windowMs) || 0);
  if (window <= 0) return;
  const attempts = readAttempts();
  prune(attempts, window);
  const started = Number(attempts[key]);
  if (!Number.isFinite(started)) return;
  const age = Date.now() - started;
  if (age >= window) return;
  const left = Math.max(1, Math.ceil((window - age) / 1000));
  const error = new Error(
    "这条内容刚刚已经尝试发布过，请先到平台上确认是否已发出；" +
      `${left} 秒后才能再次尝试`,
  ) as CodedError;
  error.code = "PUBLISH_ALREADY_ATTEMPTED";
  error.details = { retryAfterSeconds: left };
  throw error;
}

/** Remember the attempt, before the click rather than after it. */
function record(key: string): void {
  const attempts = readAttempts();
  prune(attempts, DEFAULT_WINDOW_MS);
  attempts[key] = Date.now();
  while (Object.keys(attempts).length >= MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [item, started] of Object.entries(attempts)) {
      if (Number(started) < oldest) {
        oldest = Number(started);
        oldestKey = item;
      }
    }
    if (oldestKey === null) break;
    delete attempts[oldestKey];
  }
  writeAttempts(attempts);
}

function pending(): Record<string, number> {
  return readAttempts();
}

function clear(): void {
  try {
    fs.rmSync(attemptsPath(), { force: true });
  } catch (error) {
    // Already gone.
  }
}

export {
  DEFAULT_WINDOW_MS,
  buildKey,
  check,
  clear,
  digestContext,
  pending,
  record,
};
