import assert from "node:assert/strict";
import test from "node:test";
import { CuaSessions } from "../electron/main/cua/session.ts";
import { TabLifecycle } from "../electron/main/browser/lifecycle.ts";

function fakeHost() {
  return {
    calls: [],
    async call(method) {
      this.calls.push(method);
      if (method === "computer.capabilities") {
        return { platform: "darwin", backend: "macos-ax", fidelity: "full", accessibility: "granted", capture: "granted" };
      }
      if (method === "computer.grantDescribe") return { grant: null };
      if (method === "computer.listTargets") return { targets: [{ targetId: "w1", appName: "Notes", title: "Note", appKey: "com.apple.Notes", bounds: { x: 0, y: 0, width: 10, height: 10 } }] };
      throw new Error(`unexpected ${method}`);
    },
  };
}

test("CUA state combines browser binding, computer capabilities and targets", async () => {
  const host = fakeHost();
  const sessions = new CuaSessions({
    router: { state: () => ({ backendId: "embedded", kind: "embedded", tabId: null, capabilities: [], transportStatus: null }) },
    getHost: () => host,
    claims: new TabLifecycle(),
  });
  const state = await sessions.state("s1");
  assert.equal(state.browser.backendId, "embedded");
  assert.equal(state.computer.capabilities.backend, "macos-ax");
  assert.equal(state.computer.targets[0].appName, "Notes");
  assert.deepEqual(host.calls.sort(), ["computer.capabilities", "computer.grantDescribe", "computer.listTargets"]);
});

test("CUA selection persists per session until cleared", async () => {
  const sessions = new CuaSessions({
    router: { state: () => ({ backendId: "embedded", kind: "embedded", tabId: null, capabilities: [], transportStatus: null }) },
    getHost: () => null,
    claims: new TabLifecycle(),
  });
  sessions.bind("s1", { targetId: "w1" });
  sessions.bind("s1", { tabId: "t2" });
  const state = await sessions.state("s1");
  assert.deepEqual(state.selection, { targetId: "w1", tabId: "t2" });
  assert.equal(state.computer.capabilities, null);
  sessions.clear("s1");
  assert.deepEqual((await sessions.state("s1")).selection, {});
});
