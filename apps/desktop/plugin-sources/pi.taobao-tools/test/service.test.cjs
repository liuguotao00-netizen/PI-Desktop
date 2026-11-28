const test = require("node:test");
const assert = require("node:assert/strict");
const runs = require("../compiled/bridge/automation/runs");

test("resident service owns queued work after submit returns", async () => {
  let work = null;
  runs.setRunExecutor((next) => { work = next; });
  let started = false;
  const record = runs.submit(
    { automationId: "service-test", name: "Service test", platform: "test" },
    async () => {
      started = true;
      return { context: { ok: true }, files: [] };
    },
  );
  assert.equal(record.status, "queued");
  assert.equal(started, false);
  assert.equal(typeof work, "function");
  await work();
  assert.equal(started, true);
  assert.equal(runs.get(record.runId).status, "succeeded");
  runs.setRunExecutor(null);
});
