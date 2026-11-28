"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { onPanelInvoke } = require("../main");

function fixture() {
  let selected = "parent";
  let settings = {};
  let denied = false;
  let failPrompt = false;
  const messages = [
    { id: "u1", role: "user", content: "Inherited question" },
    { id: "a1", role: "assistant", content: "First settled reply", status: "complete" },
    { id: "a2", role: "assistant", content: "Still generating", status: "streaming" },
  ];
  const sessions = new Map([["parent", { id: "parent", mode: "agent", title: "Main", messages }]]);
  const calls = [];
  const running = new Set();
  const pending = new Map();
  global.pi = {
    session: { getActive: async () => selected ? { sessionId: selected } : null },
    plugin: {
      getSettings: async () => structuredClone(settings),
      setSettings: async patch => { settings = { ...settings, ...structuredClone(patch) }; },
    },
    desktop: { invoke: async request => {
      calls.push(request);
      const [input] = request.args;
      switch (request.operation) {
        case "session/get": return { session: sessions.get(input.id) };
        case "session/create": {
          assert.deepEqual(input, {
            title: "Explain this", mode: "agent", projectPath: undefined, providerId: undefined, modelId: undefined,
          });
          const id = "child-" + sessions.size;
          const child = { id, title: input.title, messageCount: 0, messages: [] };
          sessions.set(id, child);
          return { session: child };
        }
        case "session/fork": {
          const id = "child-" + sessions.size;
          const child = { id, title: input.title, messageCount: 2, messages: structuredClone(messages.slice(0, 2)) };
          sessions.set(id, child);
          return { session: child };
        }
        case "agent/prompt": {
          if (failPrompt) {
            failPrompt = false;
            throw new Error("Provider unavailable");
          }
          const target = sessions.get(input.sessionId);
          target.messages.push({ id: "side", role: "user", content: input.content });
          target.messageCount = target.messages.length;
          running.add(input.sessionId);
          return { accepted: true };
        }
        case "agent/getStatus": return { status: { isRunning: running.has(input) } };
        case "agent/abort": running.delete(input.sessionId); return { ok: true };
        case "agent/pendingInteractive": return pending.get(input.sessionId) ?? { asks: [], permissions: [] };
        case "session/delete": {
          assert.equal(request.confirm, true);
          if (denied) throw new Error("User declined");
          sessions.delete(input);
          return { ok: true };
        }
        case "tool/resolvePermission":
          assert.equal(request.confirm, true);
          return { ok: true };
        default: assert.fail("Unexpected operation " + request.operation);
      }
    } },
  };
  return {
    calls, running, sessions, pending,
    select: id => { selected = id; },
    deny: () => { denied = true; },
    failNextPrompt: () => { failPrompt = true; },
  };
}

const action = (name, payload) => onPanelInvoke("sideQuestions." + name, payload);
const create = (draftId = "draft") => action("create", { parentId: "parent", anchorId: "a1", draftId, title: "Explain this" });

test("reopens an anchored branch and targets only its turns", async () => {
  const f = fixture();
  const context = await action("context");
  assert.deepEqual(context.anchors.map(anchor => anchor.id), ["a1"]);
  assert.equal(f.sessions.size, 1);
  await assert.rejects(action("create", { parentId: "parent", anchorId: "a2", draftId: "stream", title: "Wait" }), /completed/);
  const branch = await create();
  assert.deepEqual(await create(), branch);
  assert.deepEqual((await action("context")).branches, [branch]);
  assert.deepEqual(f.calls.find(call => call.operation === "session/fork").args,
    [{ sessionId: "parent", throughMessageId: "a1", title: "Explain this" }]);
  assert.deepEqual((await action("read", { id: branch.id })).rows, []);
  const sibling = await create("another");
  await action("send", { id: branch.id, content: "Side question" });
  await action("send", { id: sibling.id, content: "Another question" });
  assert.deepEqual((await action("read", { id: branch.id })).rows,
    [{ id: "side", role: "user", content: "Side question", error: undefined }]);
  await action("stop", { id: branch.id });
  assert.ok(f.running.has(sibling.id));
  assert.equal(f.running.has(branch.id), false);
  assert.equal(f.sessions.get("parent").messages.length, 3);
  f.select("different");
  await assert.rejects(action("send", { id: branch.id, content: "Wrong owner" }), /not available/);
});

test("keeps history after canceled deletion and rejects stale tool approvals", async () => {
  const f = fixture();
  const branch = await create();
  f.deny();
  await assert.rejects(action("delete", { id: branch.id }), /declined/);
  assert.equal((await action("context")).branches.length, 1);
  const request = { requestId: "r1", sessionId: branch.id, toolName: "Read" };
  f.pending.set(branch.id, { asks: [], permissions: [request] });
  await assert.rejects(action("permission", { id: branch.id, requestId: "elsewhere", decision: "allow-once" }), /changed/);
  await action("permission", { id: branch.id, requestId: "r1", decision: "allow-once" });
  assert.deepEqual(f.calls.at(-1).args, [{ sessionId: branch.id, requestId: "r1", decision: "allow-once" }]);
});

test("starts a fresh session with the full pasted text only on the first turn", async () => {
  const f = fixture();
  const draft = { parentId: "parent", anchorId: "a1", referenceOnly: true, draftId: "paste", title: "Explain this" };
  const branch = await action("create", draft);
  assert.equal(branch.inheritedCount, 0);
  assert.equal(branch.anchor, "");
  assert.deepEqual(await action("create", draft), branch);
  assert.equal(f.calls.some(call => call.operation === "session/fork"), false);
  assert.equal((await action("read", { id: branch.id })).canReference, true);
  const reference = "😀".repeat(36) + "  Keep this whole line\n\n> And this line\n";
  const prompt = { id: branch.id, content: "Explain it", reference };
  f.failNextPrompt();
  await assert.rejects(action("send", prompt), /unavailable/);
  assert.deepEqual(f.sessions.get(branch.id).messages, []);
  await action("send", prompt);
  assert.deepEqual(f.sessions.get(branch.id).messages.map(message => message.content), [
    "Reference excerpt (quoted text):\n" + reference.split("\n").map(line => "> " + line).join("\n") + "\n\nExplain it",
  ]);
  const read = await action("read", { id: branch.id });
  assert.equal(read.canReference, false);
  assert.deepEqual(read.rows, [{ id: "side", role: "user", content: "Explain it", reference: "😀".repeat(36) + "…", error: undefined }]);
  await assert.rejects(action("send", prompt), /only start/);
  await assert.rejects(action("send", { ...prompt, id: (await create()).id }), /only start/);
  assert.equal(f.sessions.get("parent").messages.length, 3);
});
