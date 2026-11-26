import test from "node:test";
import assert from "node:assert/strict";

import { CTX, createActions, fakeRuntime, makeStore } from "./helpers.mjs";
import { SESSION_CONFIGURE } from "../runtime.js";

const WORKER = "worker-model";
const CTX_WORKER = { sessionId: "main-session", turnId: "main-turn" };
const MODELS = [
  {
    key: "prov/a", providerId: "prov", modelId: "a", providerName: "Prov", label: "A",
    availableForSubagents: true, isDefault: true, thinkingLevels: ["low", "high"],
  },
  {
    key: "prov/b", providerId: "prov", modelId: "b", providerName: "Prov", label: "B",
    availableForSubagents: true, thinkingLevels: ["medium"],
  },
];

async function setup({ status = "idle", currentTask, configured } = {}) {
  const { store } = await makeStore();
  await store.remember(WORKER, "main-session", "model worker", { status });
  const calls = [];
  let statusReads = 0;
  const runtime = fakeRuntime({
    store,
    models: MODELS,
    call: {
      status: () => {
        statusReads += 1;
        const changed = statusReads > 1 && !configured;
        return {
          sessionId: WORKER,
          status,
          ...(currentTask ? { currentTask } : {}),
          providerId: "prov",
          modelId: changed ? "b" : "a",
          thinkingLevel: changed ? "medium" : "low",
        };
      },
    },
    invokeOperation: {
      [SESSION_CONFIGURE]: (args, options) => {
        calls.push({ operation: SESSION_CONFIGURE, args, options });
        return configured || { session: { providerId: "prov", modelId: "b", thinkingLevel: "medium" } };
      },
    },
  });
  const actions = createActions(runtime);
  return { store, runtime, actions, calls };
}

test("setModel configures an idle tracked worker and verifies the returned session", async () => {
  const { actions, calls } = await setup();
  const result = await actions.execute({ action: "setModel", sessionId: WORKER, model: "prov/b", thinkingLevel: "medium" }, CTX_WORKER);

  assert.equal(result.action, "setModel");
  assert.equal(result.verified, true);
  assert.deepEqual(result.requested, { providerId: "prov", modelId: "b", thinkingLevel: "medium" });
  assert.deepEqual(result.before, { providerId: "prov", modelId: "a", thinkingLevel: "low" });
  assert.equal(result.applied.modelId, "b");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], WORKER);
  assert.deepEqual(calls[0].args[1], { providerId: "prov", modelId: "b", thinkingLevel: "medium" });
  assert.equal(calls[0].options.confirm, true, "dangerous operations must carry confirm:true; the host still shows its own dialog");
});

test("setModel rejects an untracked session before calling the host", async () => {
  const { actions, calls } = await setup();
  await assert.rejects(
    actions.execute({ action: "setModel", sessionId: "not-tracked", model: "prov/b" }, CTX_WORKER),
    (error) => error.code === "WORKER_NOT_FOUND",
  );
  assert.equal(calls.length, 0);
});

test("setModel refuses a busy worker so no turn or delivery is lost", async () => {
  const { actions, calls } = await setup({ status: "running", currentTask: { turnId: "t1", messageId: "m1" } });
  await assert.rejects(
    actions.execute({ action: "setModel", sessionId: WORKER, model: "prov/b" }, CTX_WORKER),
    (error) => error.code === "SESSION_BUSY" && error.details.turnId === "t1",
  );
  assert.equal(calls.length, 0);
});

test("setModel requires a ready configured model", async () => {
  const { actions } = await setup();
  await assert.rejects(
    actions.execute({ action: "setModel", sessionId: WORKER, model: "absent" }, CTX_WORKER),
    (error) => error.code === "MODEL_NOT_FOUND",
  );
  await assert.rejects(
    actions.execute({ action: "setModel", sessionId: WORKER }, CTX_WORKER),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});

test("setModel validates thinkingLevel against the target model", async () => {
  const { actions, calls } = await setup();
  await assert.rejects(
    actions.execute({ action: "setModel", sessionId: WORKER, model: "prov/b", thinkingLevel: "high" }, CTX_WORKER),
    (error) => error.code === "INVALID_ARGUMENT",
  );
  assert.equal(calls.length, 0);
});

test("a configure reply that does not echo the target is not reported as success", async () => {
  const { actions } = await setup({ configured: { session: { providerId: "prov", modelId: "a", thinkingLevel: "low" } } });
  await assert.rejects(
    actions.execute({ action: "setModel", sessionId: WORKER, model: "prov/b" }, CTX_WORKER),
    (error) => error.code === "MODEL_CHANGE_UNVERIFIED" && error.details.reported.modelId === "a",
  );
});

test("explicit providerId/modelId pair is accepted when it matches the catalog", async () => {
  const { actions } = await setup();
  const result = await actions.execute({ action: "setModel", sessionId: WORKER, providerId: "prov", modelId: "b" }, CTX_WORKER);
  assert.equal(result.verified, true);
  assert.equal(result.applied.modelId, "b");
});
