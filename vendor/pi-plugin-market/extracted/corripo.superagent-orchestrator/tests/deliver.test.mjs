import test from "node:test";
import assert from "node:assert/strict";

import { cards, createDeliverer, fakeRuntime, hostError, makeStore } from "./helpers.mjs";

const { resultCard } = cards;

const CARD = resultCard({ title: "Worker one", sessionId: "worker-1", summary: "12 tests passed" });

async function setup(callHost) {
  const { store } = await makeStore();
  const runtime = fakeRuntime({ store, callHost });
  return { store, runtime, deliverer: createDeliverer({ runtime }) };
}

test("a permitted appendMessage is the first channel and wins", async () => {
  const { runtime, deliverer } = await setup({
    "session.appendMessage": ([input]) => {
      assert.equal(input.sessionId, "main-session");
      assert.equal(input.message.role, "assistant");
      return { messageId: "card-1" };
    },
  });

  const result = await deliverer.deliver(CARD, { target: "main-session" });

  assert.equal(result.delivered, "message");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].messageId, "card-1");
  assert.deepEqual(runtime.hostCalls.map((entry) => entry.path), ["session.appendMessage"]);
});

test("a missing session.update.all degrades to composer.suggest and is not retried", async () => {
  let appends = 0;
  const { runtime, deliverer } = await setup({
    "session.appendMessage": () => {
      appends += 1;
      throw hostError("PERMISSION_DENIED", "session.update.all is not granted");
    },
    "composer.suggest": ([input]) => {
      assert.equal(input.sessionId, "main-session");
      assert.ok(input.text.length > 0);
      return { shown: true };
    },
  });

  const first = await deliverer.deliver(CARD, { target: "main-session" });
  assert.equal(first.delivered, "suggest");
  assert.deepEqual(first.attempts.map((entry) => entry.channel), ["message", "suggest"]);
  assert.equal(first.attempts[0].code, "PERMISSION_DENIED");

  const second = await deliverer.deliver(CARD, { target: "main-session" });
  assert.equal(second.delivered, "suggest");
  assert.equal(second.attempts[0].skipped, "PERMISSION_DENIED");
  assert.equal(appends, 1, "a refused grant costs exactly one call per process");
  assert.deepEqual(deliverer.disabled(), { message: "PERMISSION_DENIED" });
  assert.equal(runtime.hostCalls.filter((entry) => entry.path === "session.appendMessage").length, 1);
});

test("a suggestion that cannot be shown falls through to a toast", async () => {
  const { runtime, deliverer } = await setup({
    "composer.suggest": () => ({ shown: false, reason: "session-not-visible" }),
    "ui.showToast": ([message, level]) => {
      assert.match(message, /Worker one/);
      assert.equal(level, "info");
      return { ok: true };
    },
  });

  const result = await deliverer.deliver(CARD, { target: "main-session" });

  assert.equal(result.delivered, "toast");
  assert.deepEqual(result.attempts.map((entry) => entry.channel), ["message", "suggest", "toast"]);
  assert.equal(result.attempts[0].code, "UNSUPPORTED");
  assert.equal(result.attempts[1].code, "NOT_SHOWN");
  assert.equal(runtime.hostCalls.at(-1).path, "ui.showToast");
});

test("without a known main session only the session-less channel runs", async () => {
  const { runtime, deliverer } = await setup({
    "ui.showToast": () => ({ ok: true }),
  });

  const result = await deliverer.deliver(CARD, { target: "" });

  assert.equal(result.delivered, "toast");
  assert.deepEqual(runtime.hostCalls.map((entry) => entry.path), ["ui.showToast"]);
});

test("when every channel refuses the card is reported as not shown", async () => {
  const { deliverer } = await setup({
    "composer.suggest": () => {
      throw hostError("PERMISSION_DENIED", "composer.suggest is not granted");
    },
    "ui.showToast": () => {
      throw hostError("INTERNAL", "renderer gone");
    },
  });

  const result = await deliverer.deliver(CARD, { target: "main-session" });

  assert.equal(result.delivered, null);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.attempts[2].code, "INTERNAL");
  // INTERNAL is not a grant problem, so the channel stays enabled.
  assert.deepEqual(deliverer.disabled(), { message: "UNSUPPORTED", suggest: "PERMISSION_DENIED" });
});

test("an explicit order is honoured", async () => {
  const { runtime, deliverer } = await setup({
    "ui.showToast": () => ({ ok: true }),
  });

  const result = await deliverer.deliver(CARD, { target: "main-session", order: ["toast"] });

  assert.equal(result.delivered, "toast");
  assert.deepEqual(runtime.hostCalls.map((entry) => entry.path), ["ui.showToast"]);
});

test("a transient NOT_FOUND does not disable a channel for the rest of the process", async () => {
  let suggestCalls = 0;
  const { deliverer } = await setup({
    "composer.suggest": () => {
      suggestCalls += 1;
      // The host answers NOT_FOUND while a freshly created session is not ready.
      if (suggestCalls === 1) throw hostError("NOT_FOUND", "session is not ready");
      return { shown: true };
    },
    "ui.showToast": () => ({ ok: true }),
  });

  const first = await deliverer.deliver(CARD, { target: "main-session" });
  assert.equal(first.delivered, "toast");
  assert.equal(first.attempts[1].code, "NOT_FOUND");
  assert.deepEqual(deliverer.disabled(), { message: "UNSUPPORTED" }, "NOT_FOUND must not be a permanent refusal");

  const second = await deliverer.deliver(CARD, { target: "main-session" });
  assert.equal(second.delivered, "suggest");
  assert.equal(suggestCalls, 2);
});

test("a missing suggest grant is still remembered as permanent", async () => {
  const { deliverer } = await setup({
    "composer.suggest": () => {
      throw hostError("PERMISSION_DENIED", "composer.suggest is not granted");
    },
    "ui.showToast": () => ({ ok: true }),
  });

  await deliverer.deliver(CARD, { target: "main-session" });
  const second = await deliverer.deliver(CARD, { target: "main-session" });

  assert.equal(second.delivered, "toast");
  assert.equal(second.attempts[1].skipped, "PERMISSION_DENIED");
});
