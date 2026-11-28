import assert from "node:assert/strict";
import test from "node:test";
import { CuaRuntime } from "../electron/main/cua/runtime.ts";
import { CuaSessions } from "../electron/main/cua/session.ts";
import { TabLifecycle } from "../electron/main/browser/lifecycle.ts";

const grant = {
  grantId: "g1",
  revision: 4,
  scope: "desktop",
  targetId: "w1",
  targetLabel: "Notes",
  appKey: "com.apple.Notes",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  inputPolicy: "autonomous-in-scope",
  capture: "a11y-only",
  remainingBudget: 20,
  sessionId: "s1",
  createdAt: "2026-01-01T00:00:00Z",
  expiresAt: "2026-01-01T01:00:00Z",
  state: "active",
};

function setup() {
  const calls = [];
  const host = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "settings.get") return { computerUse: { enabled: true } };
      if (method === "computer.grantDescribe") return { grant };
      if (method === "computer.capabilities") return { platform: "darwin", backend: "macos-ax", fidelity: "full", accessibility: "granted", capture: "granted" };
      if (method === "computer.inspect") return { grantId: "g1", revision: 4, bounds: grant.bounds, fidelity: "full", nodes: [], truncated: false, secureInput: false };
      if (method === "computer.act") return { grantId: "g1", revision: 4, remainingBudget: 19, dispatched: "accessibility-action" };
      throw new Error(`unexpected ${method}`);
    },
  };
  const sessions = new CuaSessions({
    router: { state: () => ({ backendId: "embedded", kind: "embedded", tabId: null, capabilities: [], transportStatus: null }) },
    getHost: () => host,
    claims: new TabLifecycle(),
  });
  sessions.bind("s1", { targetId: "w1", tabId: "t1" });
  const browserCalls = [];
  const browser = {
    async tabs(input) {
      browserCalls.push(["tabs", input]);
      return input.action === "list"
        ? { tabs: [{ tabId: "t1", title: "Tab", url: "https://example.test", active: true }] }
        : { ok: true };
    },
    async click(uid, sessionId, tabId) { browserCalls.push(["click", uid, sessionId, tabId]); },
    async fill(uid, text, sessionId, tabId) { browserCalls.push(["fill", uid, text, sessionId, tabId]); },
    async navigate(input, sessionId, tabId) { browserCalls.push(["navigate", input, sessionId, tabId]); },
    async snapshot() { return { tree: "", url: "", title: "" }; },
    async screenshot(input, sessionId, tabId) { browserCalls.push(["screenshot", input, sessionId, tabId]); },
    async evaluate(expression, sessionId, tabId) { browserCalls.push(["evaluate", expression, sessionId, tabId]); },
    console() { return { messages: [] }; },
    action(action, sessionId, tabId) { browserCalls.push(["action", action, sessionId, tabId]); },
    async reveal() {},
  };
  const runtime = new CuaRuntime({
    sessions,
    browser,
    getHost: () => host,
    confirmClaim: async () => true,
  });
  return { runtime, calls, browserCalls };
}

test("app action uses the bound desktop target and the live grant revision", async () => {
  const { runtime, calls } = setup();
  await runtime.act("s1", { surface: "app", action: "click", uid: "e1" });
  const act = calls.find((call) => call.method === "computer.act");
  assert.equal(act.params.grantId, "g1");
  assert.equal(act.params.expectedRevision, 4);
  assert.deepEqual(act.params.action, { kind: "click", uid: "e1" });
});

test("browser action uses the bound tab", async () => {
  const { runtime, browserCalls } = setup();
  await runtime.act("s1", { surface: "browser", action: "click", uid: "e2" });
  assert.deepEqual(browserCalls, [["click", "e2", "s1", "t1"]]);
});

test("app observation returns nodes and grant budget", async () => {
  const { runtime } = setup();
  const state = await runtime.app("s1");
  assert.equal(state.targetId, "w1");
  assert.equal(state.remainingBudget, 20);
  assert.equal(state.revision, 4);
});

test("a claimed tab overrides the selection until released", async () => {
  const { runtime, browserCalls } = setup();
  await runtime.claimTab("s1", "t2");
  await runtime.act("s1", { surface: "browser", action: "click", uid: "e3" });
  runtime.releaseTab("s1");
  await runtime.act("s1", { surface: "browser", action: "click", uid: "e4" });
  assert.deepEqual(browserCalls.filter((call) => call[0] !== "tabs"), [
    ["click", "e3", "s1", "t2"],
    ["click", "e4", "s1", "t1"],
  ]);
});
