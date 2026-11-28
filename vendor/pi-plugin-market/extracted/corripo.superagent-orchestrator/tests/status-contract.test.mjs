import test from "node:test";
import assert from "node:assert/strict";

import { needsPerson, readStatusContract, resultCard } from "../cards.js";

/**
 * The worker status contract.
 *
 * A free-text summary cannot tell an orchestrator whether it may stop. These
 * tests cover the three things the contract has to do: surface a blocked worker
 * loudly, keep a ready one quiet, and never lose a result when the worker
 * forgot to write the fields or wrote them oddly.
 */

test("a blocked worker puts its human action on the card's second line", () => {
  const card = resultCard({
    title: "迁移检查",
    sessionId: "worker-1",
    summary: "查完了大部分文件。\n\nstate: blocked\nhuman_action: 需要你确认新版 schema 是否保留旧字段",
    outcome: "completed",
  });

  assert.equal(card.state, "blocked");
  assert.equal(card.humanAction, "需要你确认新版 schema 是否保留旧字段");
  const lines = card.text.split("\n");
  assert.match(lines[0], /需要你决定/);
  assert.match(lines[1], /^需要你决定：需要你确认新版 schema 是否保留旧字段$/);
  // The report body still follows, so nothing is hidden from the person.
  assert.match(card.text, /查完了大部分文件/);
  assert.match(card.oneLine, /需要你决定/);
});

test("a blocked worker with no readable action still asks, without inventing one", () => {
  const card = resultCard({
    title: "部署",
    sessionId: "worker-2",
    summary: "state: blocked\nhuman_action: none",
    outcome: "completed",
  });

  assert.equal(card.state, "blocked");
  const lines = card.text.split("\n");
  assert.match(lines[1], /没写清要你做什么/);
  // An explicit "none" must not be echoed as if it were an instruction.
  assert.doesNotMatch(card.text, /需要你决定：none/);
});

test("a ready worker stays compact and never claims a decision is needed", () => {
  const card = resultCard({
    title: "跑测试",
    sessionId: "worker-3",
    summary: "38/38 通过。\n\nstate: ready\nhuman_action: none",
    outcome: "completed",
  });

  assert.equal(card.state, "ready");
  assert.doesNotMatch(card.text, /需要你决定/);
  assert.match(card.text, /子会话完成 · ready/);
  assert.equal(card.humanAction, undefined);
});

test("a report with no contract falls back to the original card shape", () => {
  const card = resultCard({
    title: "调研",
    sessionId: "worker-4",
    summary: "这是旧格式的报告，没有 state 字段。",
    outcome: "completed",
  });

  assert.equal(card.state, undefined);
  assert.equal(card.humanAction, undefined);
  assert.equal(card.text.split("\n")[0], "【子会话完成】调研");
  assert.match(card.text, /这是旧格式的报告/);
});

test("a garbled contract is dropped rather than guessed at", () => {
  // An unknown state word must not become a status nobody verified.
  assert.deepEqual(readStatusContract("state: 大概好了\nhuman_action: 无"), {});
  assert.deepEqual(readStatusContract("state: done\nhuman_action: none"), {});
  // Neither half of the contract present.
  assert.deepEqual(readStatusContract("就是一段普通文字"), {});
  assert.deepEqual(readStatusContract(""), {});
});

test("the parser tolerates real-world formatting", () => {
  // Markdown emphasis, list bullet, full-width colon, upper case, indentation.
  assert.deepEqual(
    readStatusContract("**State:** blocked\n- **human_action**: 补充 token"),
    { state: "blocked", humanAction: "补充 token" },
  );
  assert.deepEqual(
    readStatusContract("  * STATE: READY\n  * human_action : none"),
    { state: "ready", humanAction: "none" },
  );
  // Chinese full-width colon.
  assert.deepEqual(
    readStatusContract("state：failed\nhuman_action：none"),
    { state: "failed", humanAction: "none" },
  );
  // Trailing prose after the state word is ignored, the word itself is read.
  assert.deepEqual(readStatusContract("state: blocked, 缺 API key"), { state: "blocked" });
});

test("only blocked needs a decision", () => {
  assert.equal(needsPerson("blocked"), true);
  assert.equal(needsPerson("ready"), false);
  assert.equal(needsPerson("failed"), false);
  assert.equal(needsPerson(undefined), false);
});

test("a supplied contract wins over parsing the summary", () => {
  // The watcher parses once and passes the result through, so an already-read
  // contract must not be re-derived from (possibly truncated) summary text.
  const card = resultCard({
    title: "t",
    sessionId: "s",
    summary: "正文没有状态字段",
    status: { state: "blocked", humanAction: "确认一下" },
  });
  assert.equal(card.state, "blocked");
  assert.equal(card.humanAction, "确认一下");
  assert.match(card.text, /需要你决定：确认一下/);
});

test("a failed worker with the contract keeps its failure label", () => {
  const card = resultCard({
    title: "构建",
    sessionId: "worker-5",
    summary: "state: failed\nhuman_action: none",
    outcome: "failed",
  });
  assert.equal(card.outcome, "failed");
  assert.equal(card.state, "failed");
  assert.match(card.text, /子会话失败/);
});
