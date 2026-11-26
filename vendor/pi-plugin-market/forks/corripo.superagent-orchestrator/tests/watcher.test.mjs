import test from "node:test";
import assert from "node:assert/strict";

import { TURN_ENDED, createWatcher, fakeRuntime, hostError, makeStore } from "./helpers.mjs";

function fakeDeliverer(result = { delivered: "toast", attempts: [{ channel: "toast", ok: true }] }) {
  const delivered = [];
  return {
    delivered,
    async deliver(card, options) {
      delivered.push({ card, options });
      return result;
    },
  };
}

async function setup({ result, deliverer = fakeDeliverer(), events = null } = {}) {
  const { store } = await makeStore();
  await store.remember("worker-1", "main-session", "Worker one", { status: "running" });
  const runtime = fakeRuntime({ store, call: { result } });
  const watcher = createWatcher({ runtime, store, deliverer, events, log: () => {} });
  return { store, runtime, watcher, deliverer };
}

const completedResult = () => ({
  ready: true,
  message: {
    id: "m1",
    turnId: "t1",
    status: "completed",
    result: "12 tests passed",
    targetSessionId: "worker-1",
  },
});

test("a completed worker turn lands one card in the main session", async () => {
  const { store, watcher, deliverer } = await setup({ result: completedResult });

  const outcome = await watcher.handleTurnEnded({ sessionId: "worker-1", turnId: "t1", reason: "completed" });

  assert.equal(outcome.action, "card");
  assert.equal(outcome.delivered, "toast");
  assert.equal(outcome.target, "main-session");
  assert.equal(deliverer.delivered.length, 1);
  const [{ card, options }] = deliverer.delivered;
  assert.equal(card.sessionId, "worker-1");
  assert.equal(card.title, "Worker one");
  assert.equal(card.summary, "12 tests passed");
  assert.equal(card.outcome, "completed");
  assert.equal(options.target, "main-session");

  const entry = store.get("worker-1");
  assert.equal(entry.status, "completed");
  assert.equal(entry.lastResult, "12 tests passed");
  assert.deepEqual(entry.cardedTurns, ["t1"]);
});

test("the same turn never produces a second card", async () => {
  const { watcher, deliverer } = await setup({ result: completedResult });

  await watcher.handleTurnEnded({ sessionId: "worker-1", turnId: "t1", reason: "completed" });
  const second = await watcher.handleTurnEnded({ sessionId: "worker-1", turnId: "t1", reason: "completed" });

  assert.equal(second.action, "ignored");
  assert.equal(second.reason, "already-carded");
  assert.equal(deliverer.delivered.length, 1);
});

test("an aborted turn updates the row and shows no card", async () => {
  const { store, watcher, deliverer } = await setup({
    result: () => {
      throw hostError("NOT_FOUND", "no delivery");
    },
  });

  const outcome = await watcher.handleTurnEnded({ sessionId: "worker-1", turnId: "t1", reason: "aborted" });

  assert.equal(outcome.action, "status-only");
  assert.equal(outcome.outcome, "cancelled");
  assert.equal(deliverer.delivered.length, 0);
  assert.equal(store.get("worker-1").status, "cancelled");
});

test("a session this plugin never created is ignored", async () => {
  const { watcher, deliverer } = await setup({ result: completedResult });

  const outcome = await watcher.handleTurnEnded({ sessionId: "someone-else", turnId: "t1", reason: "completed" });

  assert.equal(outcome.action, "ignored");
  assert.equal(outcome.reason, "not-a-worker");
  assert.equal(deliverer.delivered.length, 0);
});

test("a payload without a session id is ignored", async () => {
  const { watcher } = await setup({ result: completedResult });
  assert.deepEqual(await watcher.handleTurnEnded({ turnId: "t1", reason: "completed" }), {
    action: "ignored",
    reason: "no-session",
  });
});

test("a failed result read updates the row and announces nothing", async () => {
  const { store, watcher, deliverer } = await setup({
    result: () => {
      throw hostError("TIMEOUT", "host read timed out");
    },
  });

  const outcome = await watcher.handleTurnEnded({ sessionId: "worker-1", turnId: "t1", reason: "completed" });

  assert.equal(outcome.action, "not-settled");
  assert.equal(outcome.reason, "read-failed");
  assert.equal(deliverer.delivered.length, 0, "an unreadable result is never announced as a report");
  // The turn itself still settled, so the row reflects it.
  assert.equal(store.get("worker-1").status, "completed");
});

test("an unsettled delivery is not carded", async () => {
  const { store, watcher, deliverer } = await setup({
    result: () => ({
      ready: false,
      message: { id: "m1", turnId: "t1", status: "queued", targetSessionId: "worker-1" },
    }),
  });

  const outcome = await watcher.handleTurnEnded({ sessionId: "worker-1", turnId: "t1", reason: "completed" });
  assert.equal(outcome.action, "not-settled");
  assert.equal(outcome.reason, "in-flight");
  assert.equal(deliverer.delivered.length, 0);
  assert.equal(store.get("worker-1").status, "queued");
});

test("a malformed result or another session's delivery is rejected, not carded", async () => {
  const cases = [
    { value: { ready: true }, expected: "no-delivery" },
    { value: { ready: true, message: { id: "m1", status: "completed", targetSessionId: "someone-else" } }, expected: "other-session" },
    { value: { ready: "yes", message: { id: "m1", status: "completed", targetSessionId: "worker-1" } }, expected: "no-ready-flag" },
    { value: { ready: true, message: { id: "m1", status: "completed", result: 42, targetSessionId: "worker-1" } }, expected: "bad-result" },
  ];
  for (const { value, expected } of cases) {
    const { watcher, deliverer } = await setup({ result: () => value });
    const outcome = await watcher.handleTurnEnded({ sessionId: "worker-1", turnId: "t1", reason: "completed" });
    assert.equal(outcome.action, "not-settled", JSON.stringify(value));
    assert.equal(outcome.reason, expected, JSON.stringify(value));
    assert.equal(deliverer.delivered.length, 0);
  }
});

test("a host-reported failure is labelled failed even when the turn stopped normally", async () => {
  const { watcher, deliverer } = await setup({
    result: () => ({
      ready: true,
      message: { id: "m1", turnId: "t1", status: "failed", targetSessionId: "worker-1", error: "boom" },
    }),
  });

  const outcome = await watcher.handleTurnEnded({ sessionId: "worker-1", turnId: "t1", reason: "completed" });

  assert.equal(outcome.outcome, "failed");
  assert.match(deliverer.delivered[0].card.text, /【子会话失败】/);
});

test("an unknown reason is treated as settled and still carded", async () => {
  const { watcher, deliverer } = await setup({ result: completedResult });

  const outcome = await watcher.handleTurnEnded({ sessionId: "worker-1", turnId: "t1" });

  assert.equal(outcome.action, "card");
  assert.equal(deliverer.delivered.length, 1);
});

test("start subscribes once and stop unsubscribes the same handler", async () => {
  const handlers = new Map();
  const events = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    off(event, handler) {
      if (handlers.get(event) === handler) handlers.delete(event);
    },
  };
  const { watcher, deliverer } = await setup({ result: completedResult, events });

  assert.equal(watcher.start(), true);
  assert.equal(watcher.start(), true);
  assert.equal(handlers.size, 1);
  assert.equal(typeof handlers.get(TURN_ENDED), "function");

  handlers.get(TURN_ENDED)({ sessionId: "worker-1", turnId: "t1", reason: "completed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deliverer.delivered.length, 1);

  watcher.stop();
  assert.equal(handlers.size, 0);
});

test("without an events API the watcher reports that cards are disabled", async () => {
  const { watcher } = await setup({ result: completedResult });
  assert.equal(watcher.start(), false);
  assert.equal(watcher.started(), false);
});
