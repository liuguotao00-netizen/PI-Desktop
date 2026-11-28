const test = require("node:test");
const assert = require("node:assert/strict");
const { MerchantRunner } = require("../compiled/bridge/runner");

test("merchant runner calls the host browser directly with the session", async () => {
  const calls = [];
  const browser = {
    async reveal(input) { calls.push(["reveal", input]); },
    async navigate(input) { calls.push(["navigate", input]); },
    async evaluateNative(input) {
      calls.push(["evaluateNative", input]);
      return { isJson: true, cateLevel1Id: "123" };
    },
  };
  const runner = new MerchantRunner({ browser, sessionId: "session-1", tabId: "tab-1" });
  const result = await runner.checkSession();
  assert.deepEqual(result, { ok: true, cateLevel1Id: "123" });
  assert.deepEqual(calls[0], ["reveal", { sessionId: "session-1", tabId: "tab-1" }]);
  assert.deepEqual(calls[1], [
    "navigate",
    { url: "https://sycm.taobao.com", sessionId: "session-1", tabId: "tab-1" },
  ]);
  assert.equal(calls[2][0], "evaluateNative");
  assert.equal(calls[2][1].sessionId, "session-1");
  assert.equal(calls[2][1].tabId, "tab-1");
  assert.match(calls[2][1].expression, /location\.origin/);
  assert.match(calls[3][1].expression, /cateLevel1Id/);
  await runner.open();
  assert.equal(calls.length, 4, "an open runner does not navigate again");
  await runner.close();
  await runner.open();
  assert.equal(calls.length, 6, "close releases the tab, so the next open navigates");
});
