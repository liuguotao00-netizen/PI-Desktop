"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "main.js"), "utf8");
const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 300,
  cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 },
  reasoning_output_tokens: 10,
};

function reply(id, tokens = usage, modelId = "test-model") {
  return JSON.stringify({
    type: "message", role: "assistant", id,
    createdAt: "2026-10-01T12:00:00.000Z",
    content: "SYNTHETIC_MESSAGE_BODY_MUST_NOT_BE_RETURNED",
    meta: { usage: tokens, modelId, responseDurationMs: 1000 },
  }) + "\n";
}

function host(t, { locale = "zh-CN", empty = false, toastFails = false } = {}) {
  // Only synthetic files under the session scratch (or OS temp when run outside PI).
  const scratch = process.env.PI_SCRATCH_DIR || os.tmpdir();
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "session-usage-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, "plugins", "data", "io.github.new-beginner.session-usage");
  const sessions = path.join(dir, "sessions");
  fs.mkdirSync(dataPath, { recursive: true });
  fs.mkdirSync(sessions);
  const db = new DatabaseSync(path.join(dir, "pi.sqlite"));
  db.exec(`
    create table sessions (id text primary key, title text, model_id text,
      provider_id text, thinking_level text, updated_at text, created_at text, deleted_at text);
    create table turns (session_id text, status text, input_tokens integer,
      output_tokens integer, usage_json text);
  `);
  if (!empty) {
    const insert = db.prepare("insert into sessions values (?, ?, ?, '', '', ?, ?, null)");
    insert.run("idle-session", "Idle session", "test-model", "2026-10-01", "2026-10-01");
    insert.run("busy-session", "Busy session", "busy-model", "2026-10-02", "2026-10-02");
    insert.run("blank-session", "Blank session", "test-model", "2026-09-01", "2026-09-01");
    const turn = db.prepare("insert into turns values (?, ?, ?, ?, ?)");
    turn.run("idle-session", "completed", 100, 20, JSON.stringify(usage));
    turn.run("busy-session", "running", 0, 0, null);
    fs.writeFileSync(path.join(sessions, "idle-session.jsonl"), reply("idle-1"));
    fs.writeFileSync(path.join(sessions, "busy-session.jsonl"), reply("busy-1", { input: 12, output: 3 }, "busy-model"));
  }
  db.close();

  const commands = new Map();
  const timers = new Set();
  const toasts = [];
  let settings = {};
  let panelOpens = 0;
  const writes = [];
  let readGate = null;
  let writeGate = null;
  function gate() {
    let release, enter;
    const promise = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { enter = resolve; });
    return { release, enter, promise, entered };
  }
  const context = vm.createContext({
    require,
    module: { exports: {} },
    setTimeout, clearTimeout,
    setInterval: (fn, ms) => {
      const timer = { fn, ms };
      timers.add(timer);
      return timer;
    },
    clearInterval: (timer) => timers.delete(timer),
    pi: {
      app: { getLocale: async () => locale, getAppearance: async () => ({ locale, base: "dark" }) },
      plugin: {
        getDataPath: async () => {
          if (readGate) { const g = readGate; readGate = null; g.enter(); await g.promise; }
          return dataPath;
        },
        getSettings: async () => settings,
        setSettings: async (value) => {
          assert.notEqual(typeof value.lastReport?.then, "function", "never persist a Promise");
          assert.equal(typeof value.lastReport?.ok, "boolean", "persist a complete report");
          if (writeGate) { const g = writeGate; writeGate = null; g.enter(); await g.promise; }
          writes.push(JSON.parse(JSON.stringify(value.lastReport)));
          settings = JSON.parse(JSON.stringify(value));
        },
      },
      commands: {
        register: async (cmd) => commands.set(cmd.id, cmd),
        unregister: async (id) => commands.delete(id),
      },
      ui: {
        openPanel: async () => { panelOpens += 1; },
        showToast: async (message) => {
          if (toastFails) throw new Error("toast unavailable");
          toasts.push(message);
        },
      },
    },
  });
  new vm.Script(source, { filename: "main.js" }).runInContext(context);
  const plugin = context.module.exports;
  t.after(() => plugin.onUnload());
  return {
    plugin, commands, timers, toasts, sessions,
    report: () => settings.lastReport,
    panelOpens: () => panelOpens,
    writes,
    context: () => plugin.onPanelInvoke("usage.context"),
    switchTo: (sessionId, sequence = 1, instance = "test-renderer", status = "active") =>
      plugin.onRendererCall("usage.setContext", { sessionId, sequence, instance, status }),
    holdRead: () => (readGate = gate()),
    holdWrite: () => (writeGate = gate()),
  };
}

async function tick(h) {
  assert.equal(h.timers.size, 0, "no usage polling timer");
  await new Promise(resolve => setTimeout(resolve, 90));
}
async function waitReport(h, predicate) {
  const start = performance.now();
  while (!predicate(h.report()) && performance.now() - start < 950) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(h.report()), "completed usage must arrive within one second");
  return performance.now() - start;
}

test("manifest grants only the docked view and the whitelisted identity relay", () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(m.id, "io.github.new-beginner.session-usage");
  assert.equal(m.version, "1.6.4"); assert.equal(m.engines.piDesktop, ">=0.17.0");
  for (const locale of ["en", "zh-CN"]) {
    assert.deepEqual(Object.keys(m.i18n[locale]).sort(), ["description", "name", "safetyNotes"]);
    for (const value of Object.values(m.i18n[locale])) assert.ok(value.trim());
  }
  assert.deepEqual(m.permissions, ["ui.view", "renderer.extension"]);
  assert.deepEqual(m.rendererActions, ["plugin.call"]);
  assert.deepEqual(m.rendererCallMethods, ["usage.setContext"]);
  assert.equal(m.renderer, "renderer/session-context.mjs");
  assert.ok(fs.existsSync(path.join(root, m.renderer))); assert.equal(m.ui, undefined);
  assert.equal(m.contributes.views[0].entry, "renderer/index.html");
});

test("HTML script parses without window chrome or persisted-report fallback", () => {
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1); assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
  assert.doesNotMatch(html, /pi-plugin-titlebar-height|app-region|plugin.getSettings/);
  assert.match(html, /usage.context/);
});

for (const locale of ["zh-CN", "en"]) {
  test(`/usage follows actual ID, even while generating (${locale})`, async t => {
    const h = host(t, { locale }); await h.plugin.onLoad(); h.switchTo("busy-session");
    await h.commands.get("usage").run();
    assert.equal(h.panelOpens(), 0); assert.equal(h.report().session.id, "busy-session");
    assert.equal(h.report().session.running, true); assert.equal(h.report().locale, locale);
    assert.equal(h.report().context.mode, "follow");
    assert.match(h.toasts[0], locale === "zh-CN" ? /右侧工作面板菜单/ : /Right work panel menu/);
  });
}

test("token statistics, cache creation parts and no message return are preserved", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("idle-session");
  const r = await h.plugin.onPanelInvoke("usage.get");
  assert.equal(r.totals.input, 100); assert.equal(r.totals.cacheRead, 300);
  assert.equal(r.totals.cacheWrite, 100); assert.equal(r.totals.cacheWrite5m, 40);
  assert.equal(r.totals.cacheWrite1h, 60); assert.equal(r.totals.reasoning, 10);
  assert.equal(r.totals.total, 530); assert.equal(r.totals.hitRate, 0.6);
  assert.equal(r.turns.completed, 1); assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_MESSAGE_BODY/);
});

test("A → B → A and background changes never steal current session", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("idle-session", 1);
  await h.plugin.onPanelInvoke("usage.get");
  fs.appendFileSync(path.join(h.sessions, "busy-session.jsonl"), reply("busy-2"));
  await tick(h); assert.equal(h.report().session.id, "idle-session");
  h.switchTo("busy-session", 2); assert.equal((await h.plugin.onPanelInvoke("usage.get")).session.id, "busy-session");
  h.switchTo("idle-session", 3); assert.equal((await h.plugin.onPanelInvoke("usage.get")).session.id, "idle-session");
});

test("actual file notifications update each continuous output and child output while parent running", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("busy-session"); await h.plugin.onPanelInvoke("usage.get");
  const file = path.join(h.sessions, "busy-session.jsonl");
  for (const count of [2, 3, 4]) {
    fs.appendFileSync(file, reply(`busy-${count}`, { input: 50, output: 10 }));
    await waitReport(h, r => r?.replies === count);
    assert.equal(h.report().session.running, true); assert.equal(h.report().unavailable, false);
  }
  fs.appendFileSync(file, JSON.stringify({ type: "message", role: "assistant", id: "child-1", meta: {
    status: "complete", parentToolCallId: "call-child", agentName: "fixer", modelId: "busy-model", usage: { inputTokens: 7, outputTokens: 2 } } }) + '\n');
  await waitReport(h, r => r?.replies === 5);
  assert.equal(h.report().scopes.find(s => s.id === 'subagents').totals.input, 7);
  const before = h.writes.length, duplicate = fs.readFileSync(file, 'utf8').trim().split('\n').at(-1);
  fs.appendFileSync(file, duplicate + '\n'); await tick(h);
  assert.equal(h.report().replies, 5); assert.equal(h.writes.length, before, 'duplicate records/notifications do not republish');
});

test("watch survives file creation and atomic replacement without reading other sessions", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("blank-session"); await h.plugin.onPanelInvoke("usage.get");
  const file = path.join(h.sessions, "blank-session.jsonl"); fs.writeFileSync(file, reply('blank-1'));
  await waitReport(h, r => r?.replies === 1);
  const replacement = path.join(h.sessions, 'replace.tmp'); fs.writeFileSync(replacement, reply('blank-1') + reply('blank-2'));
  fs.renameSync(replacement, file); await waitReport(h, r => r?.replies === 2);
  const before = h.writes.length; fs.appendFileSync(path.join(h.sessions, 'idle-session.jsonl'), reply('other'));
  await tick(h); assert.equal(h.writes.length, before);
});

test("late file-triggered scan cannot overwrite a newly selected session", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("idle-session"); await h.plugin.onPanelInvoke("usage.get");
  const gate = h.holdRead(); fs.appendFileSync(path.join(h.sessions, "idle-session.jsonl"), reply('late'));
  await gate.entered; h.switchTo("busy-session", 2); gate.release();
  await waitReport(h, r => r?.session?.id === 'busy-session');
  assert.equal(h.report().replies, 1); assert.equal(h.report().totals.input, 12);
});

test("fixed mode remains pinned until follow or /usage restores actual context", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("idle-session", 1);
  const fixed = await h.plugin.onPanelInvoke("usage.refresh", { sessionId: "busy-session" });
  assert.equal(fixed.context.mode, "fixed"); h.switchTo("blank-session", 2); await tick(h);
  assert.equal(h.report().session.id, "busy-session");
  const follow = await h.plugin.onPanelInvoke("usage.refresh", { follow: true });
  assert.equal(follow.session.id, "blank-session"); assert.equal(follow.context.mode, "follow");
  await h.plugin.onPanelInvoke("usage.refresh", { sessionId: "busy-session" });
  h.switchTo("idle-session", 3); await h.commands.get("usage").run();
  assert.equal(h.report().session.id, "idle-session"); assert.equal(h.report().context.mode, "follow");
});

test("blank session reports zero instead of previous session usage", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("blank-session");
  const r = await h.plugin.onPanelInvoke("usage.get");
  assert.equal(r.ok, true); assert.equal(r.replies, 0); assert.equal(r.totals.total, 0); assert.equal(r.last, null);
});

test("waiting/no session/unsupported markers never guess a recently used ID", async t => {
  const h = host(t, { toastFails: true }); await h.plugin.onLoad();
  assert.equal(h.report().ok, false); assert.match(h.report().error, /renderer.extension/);
  for (const [i, status] of ["none", "unavailable", "ambiguous"].entries()) {
    h.switchTo("", i + 1, "test-renderer", status);
    const r = await h.plugin.onPanelInvoke("usage.get");
    assert.equal(r.ok, false); assert.equal(r.session, undefined); assert.equal(r.context.status, status);
  }
  await assert.doesNotReject(() => h.commands.get("usage").run()); assert.equal(h.panelOpens(), 0);
});

test("context acknowledges immediately and slow A cannot overwrite B", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("idle-session", 1);
  await h.plugin.onPanelInvoke("usage.get"); const gate = h.holdRead();
  const old = h.plugin.onPanelInvoke("usage.refresh"); await gate.entered;
  const ack = h.switchTo("busy-session", 2); assert.equal(typeof ack.then, "undefined");
  assert.equal((await h.context()).sessionId, "busy-session");
  gate.release(); assert.equal((await old).stale, true);
  const next = await h.plugin.onPanelInvoke("usage.get");
  assert.equal(next.session.id, "busy-session"); assert.equal(h.report().session.id, "busy-session");
});

test("serialized settings publishes end with newest revision after rapid switches", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("idle-session", 1);
  await h.plugin.onPanelInvoke("usage.get");
  const gate = h.holdWrite(); fs.appendFileSync(path.join(h.sessions, "idle-session.jsonl"), reply('changed-before-write'));
  const old = h.plugin.onPanelInvoke("usage.refresh"); await gate.entered;
  h.switchTo("busy-session", 2); h.switchTo("blank-session", 3); h.switchTo("idle-session", 4);
  const next = h.plugin.onPanelInvoke("usage.get"); gate.release();
  assert.equal((await old).stale, true); const r = await next;
  assert.equal(r.session.id, "idle-session"); assert.equal(r.context.revision, (await h.context()).revision);
  assert.equal(h.writes.at(-1).context.revision, r.context.revision);
});

test("stale sequence and retired renderer load cannot reset identity", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("idle-session", 1); h.switchTo("busy-session", 2);
  assert.equal(h.switchTo("idle-session", 1).accepted, false);
  assert.equal(h.switchTo("idle-session", 1, "new-renderer").accepted, true);
  assert.equal(h.switchTo("busy-session", 99, "test-renderer").accepted, false);
  assert.equal((await h.context()).sessionId, "idle-session");
});

test("illegal IDs and manual path escapes are rejected", async t => {
  const h = host(t); await h.plugin.onLoad();
  for (const id of ["../secret", "a/b", "a\\b", "C:secret", "a..b", "", "x".repeat(129)]) {
    assert.throws(() => h.switchTo(id), /invalid/);
    if (id) await assert.rejects(() => h.plugin.onPanelInvoke("usage.refresh", { sessionId: id }), /invalid/);
  }
  assert.throws(() => h.switchTo("idle-session", -1), /invalid/);
  assert.equal((await h.context()).status, "waiting");
});

test("unload releases watcher and prevents late cached reports; reload waits for identity", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("idle-session");
  await h.plugin.onPanelInvoke("usage.get"); const gate = h.holdRead();
  const old = h.plugin.onPanelInvoke("usage.refresh"); await gate.entered;
  await h.plugin.onUnload(); gate.release(); assert.equal((await old).stale, true);
  assert.equal(h.timers.size, 0); assert.equal(h.commands.size, 0);
  assert.equal((await h.plugin.onPanelInvoke("unknown")).ok, false);
  await h.plugin.onLoad(); assert.equal(h.report().ok, false); assert.equal(h.report().context.status, "waiting");
});

test("history contains ordered metadata only, with last matching the final reply", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("idle-session");
  fs.appendFileSync(path.join(h.sessions, "idle-session.jsonl"),
    '{bad json}\n' + JSON.stringify({ type: 'message', role: 'user', content: 'SECRET_USER_TEXT' }) + '\n' +
    JSON.stringify({ type: 'compaction' }) + '\n' +
    reply('idle-2', { input: 0, output: 8, cached_tokens: 92, total_tokens: 100 }, 'other-model'));
  const r = await h.plugin.onPanelInvoke("usage.get");
  assert.equal(r.history.length, 2); assert.equal(r.replies, 2);
  assert.deepEqual(Array.from(r.history, row => row.id), ['idle-1', 'idle-2']);
  assert.deepEqual(Array.from(r.history, row => row.sequence), [1, 2]);
  assert.deepEqual(r.last, r.history.at(-1));
  assert.equal(r.history[0].tokens.hitRate, 0.6);
  assert.equal(r.history[0].tokens.cacheWrite5m, 40);
  assert.equal(r.history[1].tokens.hitRate, 1);
  assert.equal(r.history[1].tokens.total, 100);
  assert.equal(r.totals.total, 630); assert.equal(r.turns.tokens.total, 530);
  assert.equal(r.malformed, 1); assert.equal(r.compactCount, 1);
  assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_MESSAGE_BODY|SECRET_USER_TEXT|content|toolArguments/);
  assert.deepEqual(Object.keys(r.history[0]).sort(), ['agentId', 'agentName', 'agentOrdinal', 'createdAt', 'delegationId', 'durationMs', 'id', 'key', 'modelId', 'operationId', 'providerId', 'sequence', 'source', 'tokens']);
});

test("history survives missing timestamps/IDs and appends without replacing previous keys", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("idle-session");
  const before = await h.plugin.onPanelInvoke("usage.get");
  const missing = JSON.stringify({ type: 'message', role: 'assistant', meta: { usage: { output_tokens: 3 } } }) + '\n';
  fs.appendFileSync(path.join(h.sessions, "idle-session.jsonl"), missing + missing);
  const r = await h.plugin.onPanelInvoke("usage.refresh");
  assert.equal(r.history[0].key, before.history[0].key);
  assert.equal(r.history.length, 3);
  assert.notEqual(r.history[1].key, r.history[2].key);
  assert.equal(r.last.createdAt, null); assert.equal(r.last.durationMs, null);
  assert.equal(r.last.modelId, 'unknown'); assert.equal(r.last.tokens.hitRate, null);
  h.switchTo("blank-session", 2);
  const blank = await h.plugin.onPanelInvoke("usage.get");
  assert.equal(blank.history.length, 0); assert.equal(blank.last, null);
});

test("usage wait channel wakes on child completion, deduplicates notifications and switches identity", async t => {
  const h = host(t); await h.plugin.onLoad(); h.switchTo("busy-session"); await h.plugin.onPanelInvoke("usage.get");
  let notice = await h.plugin.onPanelInvoke("usage.watch", { after: 0 });
  const start = performance.now(), waiting = h.plugin.onPanelInvoke("usage.watch", { after: notice.version });
  const row = JSON.stringify({ type: "message", role: "assistant", id: "child-watch", meta: {
    status: "complete", parentToolCallId: "child-call", agentName: "fixer", modelId: "busy-model", usage: { inputTokens: 17, outputTokens: 3 } } }) + '\n';
  fs.appendFileSync(path.join(h.sessions, "busy-session.jsonl"), row);
  notice = await waiting; assert.equal(notice.changed, true); assert.ok(performance.now() - start < 1000);
  assert.deepEqual(Object.keys(notice).sort(), ['changed', 'context', 'version']);
  assert.equal(h.report().scopes.find(s => s.id === 'subagents').totals.input, 17);
  let settled = false;
  const duplicateWait = h.plugin.onPanelInvoke("usage.watch", { after: notice.version }).then(n => { settled = true; return n; });
  fs.appendFileSync(path.join(h.sessions, "busy-session.jsonl"), row); await tick(h); assert.equal(settled, false);
  h.switchTo("idle-session", 2); const switched = await duplicateWait;
  assert.equal(switched.context.sessionId, 'idle-session'); assert.ok(switched.version > notice.version);
  await h.plugin.onPanelInvoke("usage.get"); const latest = await h.plugin.onPanelInvoke("usage.watch", { after: 0 });
  const onUnload = h.plugin.onPanelInvoke("usage.watch", { after: latest.version }); await h.plugin.onUnload();
  assert.equal((await onUnload).changed, true);
  await assert.rejects(() => h.plugin.onPanelInvoke("usage.watch", { after: -1 }), /invalid usage version/);
});
