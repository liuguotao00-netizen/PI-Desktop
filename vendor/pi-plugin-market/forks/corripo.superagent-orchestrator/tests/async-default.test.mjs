import test from "node:test";
import assert from "node:assert/strict";

import { CTX, createActions, fakeRuntime, makeStore, receipt } from "./helpers.mjs";

/**
 * Delegation is asynchronous by default.
 *
 * A caller that delegates work must not then sit in the same turn polling for
 * the outcome. The plugin therefore asks the host for a completion callback
 * unless the caller explicitly opts out. These tests pin that default so a
 * later refactor cannot quietly return it to pull mode.
 */

async function setup(overrides = {}) {
  const { store } = await makeStore();
  const runtime = fakeRuntime({ store, ...overrides });
  return { store, runtime, actions: createActions(runtime) };
}

const delivered = (runtime, action) => runtime.calls.find((entry) => entry.kind === "call" && entry.action === action);

test("spawn asks the host for a completion callback by default", async () => {
  const { runtime, actions } = await setup({ call: { spawn: () => receipt("worker-1") } });

  await actions.execute({ action: "spawn", task: "run the tests" }, CTX);

  assert.equal(delivered(runtime, "spawn").input.notifyOnCompletion, true);
});

test("spawnIn asks for a completion callback by default on both hops", async () => {
  const { runtime, actions } = await setup({
    invokeOperation: { "session/create": () => ({ session: { id: "worker-9" } }) },
    call: { send: () => receipt("worker-9") },
  });

  await actions.execute({ action: "spawnIn", task: "go", projectPath: "/work/a" }, CTX);

  assert.equal(delivered(runtime, "send").input.notifyOnCompletion, true);
});

test("send asks for a completion callback by default", async () => {
  const { runtime, actions } = await setup({ call: { send: () => receipt("worker-1") } });

  await actions.execute({ action: "send", sessionId: "worker-1", message: "next step" }, CTX);

  assert.equal(delivered(runtime, "send").input.notifyOnCompletion, true);
});

test("supervise inherits the same default across its fan-out", async () => {
  const { runtime, actions } = await setup({ call: { send: () => receipt("worker-1") } });

  await actions.execute({ action: "supervise", sessionIds: ["worker-1", "worker-2"], message: "status?" }, CTX);

  const sends = runtime.calls.filter((entry) => entry.kind === "call" && entry.action === "send");
  assert.equal(sends.length, 2);
  for (const entry of sends) assert.equal(entry.input.notifyOnCompletion, true);
});

test("an explicit false still opts out, for callers reading the outcome in-turn", async () => {
  const { runtime, actions } = await setup({ call: { spawn: () => receipt("worker-1") } });

  await actions.execute({ action: "spawn", task: "run the tests", notifyOnCompletion: false }, CTX);

  assert.equal(delivered(runtime, "spawn").input.notifyOnCompletion, false);
});

test("an explicit true is preserved rather than being overridden", async () => {
  const { runtime, actions } = await setup({ call: { spawn: () => receipt("worker-1") } });

  await actions.execute({ action: "spawn", task: "run the tests", notifyOnCompletion: true }, CTX);

  assert.equal(delivered(runtime, "spawn").input.notifyOnCompletion, true);
});

test("a non-boolean notifyOnCompletion is still rejected", async () => {
  const { actions } = await setup({ call: { spawn: () => receipt("worker-1") } });

  await assert.rejects(
    actions.execute({ action: "spawn", task: "run the tests", notifyOnCompletion: "yes" }, CTX),
    (error) => {
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    },
  );
});
