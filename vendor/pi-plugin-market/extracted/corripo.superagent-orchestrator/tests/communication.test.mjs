import test from "node:test";
import assert from "node:assert/strict";

import {
  CTX,
  createActions,
  fakeRuntime,
  makeStore,
} from "./helpers.mjs";
import { NOTICE_MARKER, noticeContent } from "../actions.js";
import { SESSION_ABORT } from "../runtime.js";

const WORKER = "worker-live";
const MAIN = "main-session";
const CTX_WORKER = { sessionId: WORKER, turnId: "worker-turn" };

async function setup({ clock = 0, interval, settings = {}, ...overrides } = {}) {
  const { store } = await makeStore();
  await store.remember(WORKER, MAIN, "long worker", { status: "running" });
  const runtime = fakeRuntime({ store, ...overrides });
  runtime.settings = async () => settings;
  const actions = createActions(runtime, { now: () => (typeof clock === "object" ? clock.now : clock), ...(interval === undefined ? {} : { notifyIntervalMs: interval }) });
  return { store, runtime, actions };
}

const events = (runtime, kind) => runtime.calls.filter((entry) => entry.kind === kind);
function deliveryOf(runtime) {
  return events(runtime, "call").find((entry) => entry.action === "send");
}

function resultOf(runtime, messageId, status, turnId = "") {
  return {
    ready: status !== "queued" && status !== "running",
    message: {
      id: messageId,
      status,
      targetSessionId: WORKER,
      ...(turnId ? { turnId } : {}),
    },
  };
}

test("notify resolves the parent from the worker's provenance and delivers a marked, non-completion message", async () => {
  const { runtime, actions } = await setup({
    call: { send: () => ({ sessionId: MAIN, messageId: "n1", status: "queued" }) },
  });

  const answer = await actions.execute({ action: "notify", kind: "progress", text: "已处理 30%" }, CTX_WORKER);

  assert.equal(answer.delivered, true);
  assert.equal(answer.targetSessionId, MAIN);
  assert.equal(answer.notifyOnCompletion, false);
  assert.equal(answer.throttled, false);
  const call = deliveryOf(runtime);
  assert.equal(call.input.sessionId, MAIN);
  assert.equal(call.input.kind, "message");
  assert.equal(call.input.notifyOnCompletion, false);
  assert.ok(call.input.content.startsWith(`${NOTICE_MARKER}progress]`));
  assert.match(call.input.content, /30%/);
  assert.match(call.input.content, /中途上报/);
  assert.notEqual(call.input.idempotencyKey, undefined);
});

test("notify honours an explicit recipient and the question/blocked kinds", async () => {
  const { runtime, actions } = await setup({
    call: { send: () => ({ sessionId: "other-main", messageId: "n2", status: "queued" }) },
  });

  const answer = await actions.execute({
    action: "notify", kind: "blocked", text: "需要 key", sessionId: "other-main",
  }, CTX_WORKER);

  assert.equal(answer.kind, "blocked");
  assert.equal(answer.targetSessionId, "other-main");
  assert.ok(deliveryOf(runtime).input.content.startsWith(`${NOTICE_MARKER}blocked]`));
  await assert.rejects(
    actions.execute({ action: "notify", kind: "random", text: "x" }, CTX_WORKER),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});

test("notify throttles repeated reports of the same kind inside the minimum interval", async () => {
  let sends = 0;
  const clock = { now: 1000 };
  const { actions } = await setup({
    clock,
    interval: 5_000,
    settings: { notifyMinIntervalMs: 100 },
    call: { send: () => ({ sessionId: MAIN, messageId: `n${++sends}`, status: "queued" }) },
  });

  const first = await actions.execute({ action: "notify", kind: "progress", text: "one" }, CTX_WORKER);
  assert.equal(first.delivered, true);
  const second = await actions.execute({ action: "notify", kind: "progress", text: "two" }, CTX_WORKER);
  assert.equal(second.delivered, false);
  assert.equal(second.throttled, true);
  assert.equal(second.retryAfterMs, 5_000);
  assert.equal(sends, 1, "a throttled report must not produce a host delivery");

  // A different kind has its own bucket.
  const question = await actions.execute({ action: "notify", kind: "question", text: "which?" }, CTX_WORKER);
  assert.equal(question.delivered, true);
  assert.equal(sends, 2);

  clock.now += 5_001;
  const third = await actions.execute({ action: "notify", kind: "progress", text: "three" }, CTX_WORKER);
  assert.equal(third.delivered, true);
  assert.equal(sends, 3);
});

test("notify uses the configured minimum interval when no test override is given", async () => {
  let sends = 0;
  const { runtime, actions } = await setup({
    settings: { notifyMinIntervalMs: 600 },
    call: { send: () => ({ sessionId: MAIN, messageId: `n${++sends}`, status: "queued" }) },
  });
  await actions.execute({ action: "notify", text: "one" }, CTX_WORKER);
  const second = await actions.execute({ action: "notify", text: "two" }, CTX_WORKER);
  assert.equal(second.retryAfterMs, 600);
  assert.equal(events(runtime, "call").filter((entry) => entry.action === "send").length, 1);
});

test("noticeContent always names the worker and says the report is not a completion", () => {
  const body = noticeContent({ kind: "question", body: "选 A 还是 B？", workerSessionId: WORKER, title: "  " });
  assert.ok(body.startsWith(`${NOTICE_MARKER}question] ${WORKER}`));
  assert.match(body, /不是任务完成回执/);
  assert.match(body, /仍在运行/);
});

// --- interrupt: deliver first, abort only the old turn, read back --------------------

function busyStatus() {
  return {
    sessionId: WORKER,
    status: "running",
    currentTask: { messageId: "old-msg", turnId: "old-turn" },
  };
}

function steerSetup({ resultStatus = "running", abortValue = { aborted: true }, ...overrides } = {}) {
  let sendCount = 0;
  const statuses = [busyStatus()];
  return setup({
    call: {
      status: () => statuses.shift() || busyStatus(),
      send: () => {
        sendCount += 1;
        return { sessionId: WORKER, messageId: `new-msg-${sendCount}`, status: "queued" };
      },
      result: ({ messageId }) => resultOf(null, messageId, resultStatus, "new-turn"),
      cancel: () => ({ cancelled: true, sessionRetained: true }),
    },
    invokeOperation: { [SESSION_ABORT]: () => abortValue },
    ...overrides,
  }).then((ctx) => ({ ...ctx, sendCount: () => sendCount }));
}

test("send with interrupt defaults to true, delivers before aborting the old turn, and reports evidence", async () => {
  const order = [];
  const { runtime, actions } = await setup({
    call: {
      status: () => busyStatus(),
      send: () => { order.push("send"); return { sessionId: WORKER, messageId: "new-msg", status: "queued" }; },
      result: ({ messageId }) => resultOf(null, messageId, "running", "new-turn"),
      cancel: () => { order.push("cancel"); return { cancelled: true }; },
    },
    invokeOperation: {
      [SESSION_ABORT]: () => { order.push("abort"); return { aborted: true }; },
    },
  });

  const answer = await actions.execute({ action: "send", sessionId: WORKER, message: "换方向" }, CTX);

  assert.deepEqual(order, ["send", "abort"]);
  assert.equal(answer.interruptRequested, true);
  assert.equal(answer.interrupted, true);
  assert.equal(answer.delivered, true);
  assert.equal(answer.status, "running");
  assert.equal(answer.turnId, "new-turn");
  assert.equal(answer.messageId, "new-msg");
  assert.equal(answer.attempts, 1);
  assert.equal(answer.withdrawnRetried, false);
  const abortCall = events(runtime, "operation").find((entry) => entry.operation === SESSION_ABORT);
  assert.deepEqual(abortCall.args, [{ sessionId: WORKER, turnId: "old-turn" }]);
  assert.equal(events(runtime, "call").some((entry) => entry.action === "cancel" && !entry.input.messageId), false,
    "a cancel without a messageId would withdraw the instruction just sent");
});

test("send(interrupt:false) only queues and never calls an interrupt operation", async () => {
  const { runtime, actions } = await setup({
    call: {
      send: () => ({ sessionId: WORKER, messageId: "new-msg", status: "queued" }),
      result: ({ messageId }) => resultOf(null, messageId, "queued"),
    },
  });

  const answer = await actions.execute({ action: "send", sessionId: WORKER, message: "排队", interrupt: false }, CTX);

  assert.equal(answer.interruptRequested, false);
  assert.equal(answer.interrupted, false);
  assert.equal(answer.delivered, true, "queued is not withdrawn");
  assert.equal(answer.verified, false, "a still-queued message is not proof of delivery");
  assert.equal(events(runtime, "operation").some((entry) => entry.operation === SESSION_ABORT), false);
  assert.equal(events(runtime, "call").some((entry) => entry.action === "cancel"), false);
});

test("invalid interrupt values are rejected", async () => {
  const { actions } = await setup({ call: { send: () => ({ sessionId: WORKER, messageId: "m", status: "queued" }) } });
  await assert.rejects(
    actions.execute({ action: "send", sessionId: WORKER, message: "x", interrupt: "yes" }, CTX),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});

// --- withdrawn race: read-back and retry with a fresh idempotency key ---------------

test("a withdrawn new message is re-delivered under a new key and reported as retried", async () => {
  const keys = [];
  const statuses = ["cancelled", "cancelled", "running"];
  const { runtime, actions } = await setup({
    call: {
      status: () => busyStatus(),
      send: (input) => { keys.push(input.idempotencyKey); return { sessionId: WORKER, messageId: `new-${keys.length}`, status: "queued" }; },
      result: ({ messageId }) => resultOf(null, messageId, statuses[Number(messageId.slice(-1)) - 1], "new-turn"),
    },
    invokeOperation: { [SESSION_ABORT]: () => ({ aborted: true }) },
  });

  const answer = await actions.execute({ action: "send", sessionId: WORKER, message: "重试我", idempotencyKey: "stable-key" }, CTX);

  assert.equal(answer.delivered, true);
  assert.equal(answer.attempts, 3);
  assert.equal(answer.withdrawnRetried, true);
  assert.equal(answer.status, "running");
  assert.equal(answer.messageId, "new-3");
  assert.deepEqual(keys, ["stable-key", "stable-key#r2", "stable-key#r3"]);
  assert.equal(events(runtime, "operation").filter((entry) => entry.operation === SESSION_ABORT).length, 1,
    "the old turn is interrupted once, never once per retry");
  assert.equal(answer.interrupted, true);
});

test("three withdrawals fail loudly instead of being reported as accepted", async () => {
  const { actions } = await setup({
    call: {
      status: () => busyStatus(),
      send: () => ({ sessionId: WORKER, messageId: "new-msg", status: "queued" }),
      result: ({ messageId }) => resultOf(null, messageId, "cancelled"),
    },
    invokeOperation: { [SESSION_ABORT]: () => ({ aborted: true }) },
  });

  const answer = await actions.execute({ action: "send", sessionId: WORKER, message: "x" }, CTX);

  assert.equal(answer.delivered, false);
  assert.equal(answer.accepted, false);
  assert.equal(answer.reason, "withdrawn");
  assert.equal(answer.attempts, 3);
  assert.equal(answer.withdrawnRetried, true);
});

// --- status machine / stale interrupt -----------------------------------------------

test("an abort refused as stale is reported, while the new delivery still proceeds", async () => {
  const { actions } = await steerSetup({ resultStatus: "running", abortValue: { aborted: false } });

  const answer = await actions.execute({ action: "send", sessionId: WORKER, message: "x" }, CTX);

  assert.equal(answer.delivered, true);
  assert.equal(answer.interrupted, false);
  assert.equal(answer.interruption.reason, "old-turn-already-finished");
});

test("a busy session with no visible turn id is not interrupted; delivery still proceeds", async () => {
  const { runtime, actions } = await setup({
    call: {
      status: () => ({ sessionId: WORKER, status: "running", currentTask: {} }),
      send: () => ({ sessionId: WORKER, messageId: "m", status: "queued" }),
      result: ({ messageId }) => resultOf(null, messageId, "running", "new-turn"),
    },
  });

  const answer = await actions.execute({ action: "send", sessionId: WORKER, message: "x" }, CTX);

  assert.equal(answer.delivered, true);
  assert.equal(answer.interrupted, false);
  assert.ok(["no-target", "session-idle"].includes(answer.interruption.reason));
  assert.equal(events(runtime, "call").some((entry) => entry.action === "cancel"), false);
});

test("a completed new delivery counts as started, a queued one does not", async () => {
  const queued = await steerSetup({ resultStatus: "queued" });
  const q = await queued.actions.execute({ action: "send", sessionId: WORKER, message: "x" }, CTX);
  assert.equal(q.started, false);
  assert.equal(q.status, "queued");

  const done = await steerSetup({ resultStatus: "completed" });
  const d = await done.actions.execute({ action: "send", sessionId: WORKER, message: "x" }, CTX);
  assert.equal(d.status, "completed");
});

test("an abort failure falls back to a message-scoped cancel, never a blanket cancel", async () => {
  const calls = [];
  const { runtime, actions } = await setup({
    call: {
      status: () => busyStatus(),
      send: () => { calls.push("send"); return { sessionId: WORKER, messageId: "m", status: "queued" }; },
      result: ({ messageId }) => resultOf(null, messageId, "running", "new-turn"),
      cancel: (input) => { calls.push(`cancel:${input.messageId}`); return { cancelled: true }; },
    },
    invokeOperation: {
      [SESSION_ABORT]: () => { calls.push("abort"); throw Object.assign(new Error("unsupported"), { code: "UNSUPPORTED" }); },
    },
  });

  const answer = await actions.execute({ action: "send", sessionId: WORKER, message: "x" }, CTX);

  assert.equal(answer.delivered, true);
  assert.deepEqual(calls, ["send", "abort", "cancel:old-msg"]);
  assert.equal(answer.interruption.channel, "cancel");
});
