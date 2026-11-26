import test from "node:test";
import assert from "node:assert/strict";

import { createWatcher } from "../watcher.js";
import { makeStore } from "./helpers.mjs";

/**
 * The status contract has to survive the trip through the store.
 *
 * `worker()` rebuilds every row from a fixed field list, so a field the store
 * does not know about is dropped silently — the watcher would write it, read
 * nothing back, and the Workers view would keep showing an undifferentiated
 * result. These tests pin the persistence, not just the parsing.
 */

function runtimeStub(result) {
  return {
    async call() {
      return result;
    },
  };
}

function delivererStub() {
  const delivered = [];
  return {
    delivered,
    async deliver(card) {
      delivered.push(card);
      return { delivered: "message", attempts: [{ channel: "message", ok: true }] };
    },
  };
}

async function run({ summary, reason = "completed" }) {
  const { store } = await makeStore();
  await store.remember("worker-1", "main-1", "任务", { status: "running" });
  const deliverer = delivererStub();
  const watcher = createWatcher({
    runtime: runtimeStub({
      ready: true,
      message: { id: "m1", status: "completed", result: summary, targetSessionId: "worker-1" },
    }),
    store,
    deliverer,
    now: () => Date.parse("2026-11-16T00:00:00Z"),
  });
  const outcome = await watcher.handleTurnEnded({ sessionId: "worker-1", turnId: "t1", reason });
  return { entry: store.get("worker-1"), outcome, card: deliverer.delivered[0] };
}

test("a blocked report persists its state and human action on the worker row", async () => {
  const { entry, card } = await run({
    summary: "做了一半。\nstate: blocked\nhuman_action: 确认是否保留旧字段",
  });

  // Persisted, so the Workers view and `workers` can see it without re-parsing.
  assert.equal(entry.workerState, "blocked");
  assert.equal(entry.humanAction, "确认是否保留旧字段");
  // And the card that landed reflects it.
  assert.equal(card.state, "blocked");
  assert.match(card.text, /需要你决定：确认是否保留旧字段/);
});

test("a ready report persists its state and records that nothing is needed", async () => {
  const { entry, card } = await run({ summary: "全绿。\nstate: ready\nhuman_action: none" });

  assert.equal(entry.workerState, "ready");
  // An explicit "none" is kept as a value, not blanked: "the worker said nobody
  // has to act" is different from "the worker never answered".
  assert.equal(entry.humanAction, "none");
  assert.equal(card.state, "ready");
  assert.doesNotMatch(card.text, /需要你决定/);
});


test("a report without the contract leaves the row and the card untouched", async () => {
  const { entry, card } = await run({ summary: "旧格式报告，没有状态字段。" });

  assert.equal(entry.workerState, "");
  assert.equal(entry.humanAction, "");
  assert.equal(card.state, undefined);
  assert.match(card.text, /旧格式报告/);
});

test("an unreadable state leaves the row empty rather than guessing", async () => {
  const { entry, card } = await run({ summary: "state: 搞定了\nhuman_action: none" });

  assert.equal(entry.workerState, "");
  assert.equal(card.state, undefined);
});
