import test from "node:test";
import assert from "node:assert/strict";

import { cards } from "./helpers.mjs";

const {
  appendMessageInput,
  alreadyCarded,
  matchWorker,
  relativeTime,
  resultCard,
  shouldCard,
  summarize,
  turnOutcome,
  workerRow,
} = cards;

test("summarize folds whitespace and clips to 300 characters", () => {
  assert.equal(summarize("  a\n\n b\tc  "), "a b c");
  const long = "x".repeat(400);
  const out = summarize(long);
  assert.equal(out.length, 300);
  assert.ok(out.endsWith("…"));
  assert.equal(summarize(undefined), "");
});

test("turnOutcome maps host finish reasons", () => {
  assert.equal(turnOutcome("completed"), "completed");
  assert.equal(turnOutcome("stop"), "completed");
  assert.equal(turnOutcome("aborted"), "cancelled");
  assert.equal(turnOutcome("error"), "failed");
  assert.equal(turnOutcome(""), "unknown");
  assert.equal(turnOutcome(undefined), "unknown");
  assert.equal(shouldCard("completed"), true);
  assert.equal(shouldCard("failed"), true);
  assert.equal(shouldCard("cancelled"), false);
  assert.equal(shouldCard("unknown"), true);
});

test("resultCard is a stable text block naming the worker", () => {
  const card = resultCard({
    title: "  修复登录  ",
    sessionId: "worker-1",
    summary: "12 tests passed\nno regressions",
    outcome: "completed",
    projectPath: "/work/app",
  });
  assert.equal(card.sessionId, "worker-1");
  assert.equal(card.title, "修复登录");
  assert.equal(card.summary, "12 tests passed no regressions");
  assert.equal(
    card.text,
    ["【子会话完成】修复登录", "12 tests passed no regressions", "项目：/work/app", "sessionId: worker-1"].join("\n"),
  );
  assert.ok(card.oneLine.includes("修复登录"));
  assert.ok(card.oneLine.includes("worker-1"));
});

test("resultCard has an explicit empty-summary line and a failed label", () => {
  const card = resultCard({ title: "T", sessionId: "w", summary: "", outcome: "failed" });
  assert.match(card.text, /【子会话失败】/);
  assert.match(card.text, /没有可读的结果摘要/);
  assert.equal(card.oneLine, "子会话失败：T（w）");
});

test("resultCard keeps the first 300 characters of a long report", () => {
  const card = resultCard({ title: "T", sessionId: "w", summary: "y".repeat(1000) });
  assert.equal(card.summary.length, 300);
  assert.equal(card.summary, `${"y".repeat(299)}…`);
});

test("appendMessageInput targets the main session and names the worker in the body", () => {
  const card = resultCard({ title: "T", sessionId: "worker-1", summary: "done" });
  const input = appendMessageInput(card, "main-session", new Date("2026-01-02T03:04:05.000Z"));
  assert.equal(input.sessionId, "main-session");
  assert.equal(input.message.role, "assistant");
  assert.equal(input.message.createdAt, "2026-01-02T03:04:05.000Z");
  assert.match(input.message.content, /sessionId: worker-1/);
  // Without a target the card falls back to its own session, never to empty.
  assert.equal(appendMessageInput(card, "").sessionId, "worker-1");
});

test("matchWorker and alreadyCarded only accept the plugin's own workers", () => {
  const entries = [{ sessionId: "w1", cardedTurns: ["t1"] }, { sessionId: "w2" }];
  assert.equal(matchWorker({ sessionId: "w2" }, entries).sessionId, "w2");
  assert.equal(matchWorker({ sessionId: "other" }, entries), undefined);
  assert.equal(matchWorker({}, entries), undefined);
  assert.equal(matchWorker({ sessionId: " w1 " }, entries).sessionId, "w1");
  assert.equal(alreadyCarded(entries[0], "t1"), true);
  assert.equal(alreadyCarded(entries[0], "t2"), false);
  assert.equal(alreadyCarded(entries[1], "t1"), false);
  assert.equal(alreadyCarded(entries[0], ""), false);
});

test("workerRow exposes title, status and last activity", () => {
  const now = Date.parse("2026-01-02T04:00:00.000Z");
  const row = workerRow({
    sessionId: "w1",
    title: "Worker one",
    status: "running",
    lastActivityAt: "2026-01-02T03:40:00.000Z",
    projectPath: "/work/app",
    lastResult: "  half\nway  ",
    lastTurnId: "t9",
  }, now);
  assert.deepEqual(row, {
    sessionId: "w1",
    title: "Worker one",
    status: "running",
    lastActivityAt: "2026-01-02T03:40:00.000Z",
    lastActivity: "20 分钟前",
    projectPath: "/work/app",
    result: "half way",
    turnId: "t9",
  });
});

test("workerRow tolerates a bare record", () => {
  const row = workerRow({ sessionId: "w1" }, Date.parse("2026-01-02T04:00:00.000Z"));
  assert.equal(row.title, "w1");
  assert.equal(row.status, "unknown");
  assert.equal(row.lastActivity, "");
});

test("relativeTime buckets and rejects invalid timestamps", () => {
  const now = Date.parse("2026-01-02T04:00:00.000Z");
  assert.equal(relativeTime("2026-01-02T03:59:50.000Z", now), "刚刚");
  assert.equal(relativeTime("2026-01-02T02:00:00.000Z", now), "2 小时前");
  assert.equal(relativeTime("2025-12-20T04:00:00.000Z", now), "13 天前");
  assert.equal(relativeTime("2025-01-02T04:00:00.000Z", now), "2025-01-02");
  assert.equal(relativeTime("not-a-date", now), "");
});
