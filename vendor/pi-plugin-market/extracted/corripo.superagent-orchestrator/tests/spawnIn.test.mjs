import test from "node:test";
import assert from "node:assert/strict";

import { CTX, createActions, fakeRuntime, hostError, makeStore, receipt } from "./helpers.mjs";

async function setup(overrides = {}) {
  const { store } = await makeStore();
  const runtime = fakeRuntime({ store, ...overrides });
  return { store, runtime, actions: createActions(runtime) };
}

const operations = (runtime) => runtime.calls.filter((entry) => entry.kind === "operation");
const collaborations = (runtime) => runtime.calls.filter((entry) => entry.kind === "call");

test("spawnIn without projectPath degrades to the ordinary spawn and says so", async () => {
  const { runtime, actions } = await setup({
    call: { spawn: () => receipt("worker-1") },
  });

  const result = await actions.execute({ action: "spawnIn", task: "run the tests", title: "tests" }, CTX);

  assert.equal(result.action, "spawnIn");
  assert.equal(result.spawned, "spawn");
  assert.equal(result.degraded, "spawn-no-project-path");
  assert.equal(result.projectPath, null);
  assert.equal(result.sessionId, "worker-1");
  assert.equal(result.messageId, "worker-1-msg-1");
  assert.equal(result.status, "queued");
  // The degrade must not touch session/create at all.
  assert.equal(operations(runtime).length, 0);
  assert.deepEqual(collaborations(runtime).map((entry) => entry.action), ["spawn"]);
});

test("an empty or blank projectPath counts as missing", async () => {
  const { runtime, actions } = await setup({ call: { spawn: () => receipt("worker-1") } });

  const result = await actions.execute({ action: "spawnIn", task: "t", projectPath: "   " }, CTX);

  assert.equal(result.spawned, "spawn");
  assert.equal(operations(runtime).length, 0);
});

test("spawnIn creates the session with projectPath, then delivers the task", async () => {
  const { store, runtime, actions } = await setup({
    invokeOperation: {
      "session/create": ([input]) => {
        assert.equal(input.projectPath, "/work/other");
        assert.equal(input.title, "other project");
        assert.equal(input.providerId, undefined);
        return { session: { id: "worker-9", projectPath: "/work/other" } };
      },
    },
    call: { send: () => receipt("worker-9") },
  });

  const result = await actions.execute(
    { action: "spawnIn", task: "fix the build", title: "other project", projectPath: "/work/other" },
    CTX,
  );

  assert.equal(result.action, "spawnIn");
  assert.equal(result.spawned, "session-create");
  assert.equal(result.projectPath, "/work/other");
  assert.equal(result.sessionId, "worker-9");
  assert.equal(result.accepted, true);
  assert.equal(result.degraded, undefined);
  // Order matters: create first, deliver second.
  assert.deepEqual(runtime.calls.filter((entry) => entry.kind !== "remember").map((entry) => entry.operation || entry.action),
    ["session/create", "send"]);

  const [worker] = store.list();
  assert.equal(worker.sessionId, "worker-9");
  assert.equal(worker.projectPath, "/work/other");
  assert.equal(worker.status, "queued");
  assert.deepEqual(worker.referencedBy, ["main-session"]);
});

test("spawnIn resolves an explicit model into providerId/modelId", async () => {
  const { runtime, actions } = await setup({
    invokeOperation: {
      "session/create": ([input]) => {
        assert.equal(input.providerId, "prov");
        assert.equal(input.modelId, "m1");
        return { session: { id: "worker-2" } };
      },
    },
    call: { send: () => receipt("worker-2") },
  });

  const result = await actions.execute(
    { action: "spawnIn", task: "t", projectPath: "/work/a", model: "prov/m1" },
    CTX,
  );

  assert.equal(result.requestedModel, "prov/m1");
  assert.equal(result.modelSelection, "explicit");
  assert.equal(operations(runtime).length, 1);
});

test("a failed session/create is reported and never falls back to a plain spawn", async () => {
  const { store, runtime, actions } = await setup({
    invokeOperation: {
      "session/create": () => {
        throw hostError("INVALID_ARGUMENT", "project not found: /nope");
      },
    },
  });

  await assert.rejects(
    actions.execute({ action: "spawnIn", task: "t", projectPath: "/nope" }, CTX),
    (error) => {
      assert.equal(error.code, "SPAWN_IN_FAILED");
      assert.equal(error.details.projectPath, "/nope");
      assert.equal(error.details.cause, "INVALID_ARGUMENT");
      assert.match(error.message, /project not found: \/nope/);
      return true;
    },
  );

  assert.equal(collaborations(runtime).length, 0, "no delivery and no spawn fallback");
  assert.equal(store.list().length, 0, "no worker is recorded for a session that was never created");
});

test("session/create without a session id is an internal error", async () => {
  const { runtime, actions } = await setup({
    invokeOperation: { "session/create": () => ({ session: {} }) },
  });

  await assert.rejects(
    actions.execute({ action: "spawnIn", task: "t", projectPath: "/work/a" }, CTX),
    (error) => error.code === "INTERNAL",
  );
  assert.equal(collaborations(runtime).length, 0);
});

test("a failed delivery keeps the created worker so the caller can retry with send", async () => {
  const { store, runtime, actions } = await setup({
    invokeOperation: { "session/create": () => ({ session: { id: "worker-3" } }) },
    call: {
      send: () => {
        throw hostError("CONFLICT", "session is not ready");
      },
    },
  });

  await assert.rejects(
    actions.execute({ action: "spawnIn", task: "t", projectPath: "/work/a" }, CTX),
    (error) => {
      assert.equal(error.code, "DELIVERY_FAILED");
      assert.equal(error.details.sessionId, "worker-3");
      assert.equal(error.details.cause, "CONFLICT");
      return true;
    },
  );

  const [worker] = store.list();
  assert.equal(worker.sessionId, "worker-3");
  assert.equal(worker.projectPath, "/work/a");
  // A delivery failure must not leave a worker stuck on "queued".
  assert.equal(worker.status, "failed");
  assert.match(worker.lastResult, /投递失败/);
});

test("spawnIn rejects a task that is not a non-empty string", async () => {
  const { runtime, actions } = await setup({ call: { spawn: () => receipt() } });

  await assert.rejects(
    actions.execute({ action: "spawnIn", task: "  ", projectPath: "/work/a" }, CTX),
    (error) => error.code === "INVALID_ARGUMENT",
  );
  assert.equal(runtime.calls.length, 0);
});

test("workers returns cached rows without host calls when refresh is false", async () => {
  const { store, runtime, actions } = await setup({
    call: { spawn: () => receipt("worker-4") },
  });
  await actions.execute({ action: "spawn", task: "t", title: "W" }, CTX);
  runtime.calls.length = 0;

  const result = await actions.execute({ action: "workers", refresh: false }, CTX);

  assert.equal(result.action, "workers");
  assert.equal(result.live, false);
  assert.equal(result.count, 1);
  assert.equal(result.workers[0].sessionId, "worker-4");
  assert.equal(result.workers[0].title, "W");
  assert.equal(runtime.calls.length, 0);
});

test("workers merges live host status and keeps the cached row when one read fails", async () => {
  const { store, runtime, actions } = await setup({
    call: {
      spawn: () => receipt("worker-5"),
      status: ({ sessionId }) => {
        if (sessionId === "worker-5") {
          return { sessionId, status: "running", currentTask: { messageId: "m5", turnId: "t5" } };
        }
        throw hostError("NOT_FOUND", "gone");
      },
    },
  });
  await actions.execute({ action: "spawn", task: "t", title: "Five" }, CTX);
  await store.remember("worker-6", "main-session", "Six", { status: "completed" });
  runtime.calls.length = 0;

  const result = await actions.execute({ action: "workers" }, CTX);

  assert.equal(result.live, true);
  const byId = Object.fromEntries(result.workers.map((row) => [row.sessionId, row]));
  assert.equal(byId["worker-5"].status, "running");
  assert.equal(byId["worker-6"].status, "completed");
  assert.equal(store.get("worker-5").status, "running");
});
test("a live refresh keeps every row and stops rewriting activity once state is known", async () => {
  const { store, runtime, actions } = await setup({
    call: {
      status: ({ sessionId }) => ({ sessionId, status: "running", currentTask: { messageId: `m-${sessionId}`, turnId: `t-${sessionId}` } }),
    },
  });
  // More rows than the old 24-row view cap, so a dropped tail would be visible.
  for (let index = 0; index < 30; index += 1) {
    await store.remember(`worker-${index}`, "main-session", `W${index}`, { status: "running" });
  }

  const first = await actions.execute({ action: "workers" }, CTX);
  assert.equal(first.live, true);
  assert.equal(first.workers.length, 30, "no worker may disappear from a refresh");
  assert.equal(first.workers[0].sessionId, "worker-29");
  // The first pass learns each delivery's identity, which is real new information.
  const known = store.get("worker-3");
  assert.equal(known.lastMessageId, "m-worker-3");
  assert.equal(known.lastTurnId, "t-worker-3");

  runtime.calls.length = 0;
  const second = await actions.execute({ action: "workers" }, CTX);
  assert.equal(second.workers.length, 30);
  assert.equal(runtime.calls.filter((entry) => entry.kind === "call" && entry.action === "status").length, 30);
  // Nothing changed, so merely looking again must not claim the worker just acted.
  assert.equal(store.get("worker-3").lastActivityAt, known.lastActivityAt);
});

test("waiting_permission is a first-class status, not unknown", async () => {
  const { store, actions } = await setup({
    call: {
      spawn: () => receipt("worker-7"),
      status: ({ sessionId }) => ({ sessionId, status: "waiting_permission" }),
    },
  });
  await actions.execute({ action: "spawn", task: "t", title: "Needs approval" }, CTX);

  const result = await actions.execute({ action: "workers" }, CTX);

  assert.equal(result.workers[0].status, "waiting_permission");
  assert.equal(store.get("worker-7").status, "waiting_permission");
});

test("an unsupported action is rejected with the action name", async () => {
  const { actions } = await setup();
  await assert.rejects(
    actions.execute({ action: "teleport" }, CTX),
    (error) => error.code === "INVALID_ARGUMENT" && /teleport/.test(error.message),
  );
});
