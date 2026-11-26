"use strict";
// PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome node scripts/usage-browser-check.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const { pathToFileURL } = require("node:url");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const root = path.resolve(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version;
const scratch = process.env.PI_SCRATCH_DIR || os.tmpdir();
const screenshots = path.join(root, "output/playwright");
fs.mkdirSync(screenshots, { recursive: true });
const dir = fs.mkdtempSync(path.join(scratch, "usage-browser-"));
const sessions = path.join(dir, "sessions");
fs.mkdirSync(sessions);
const dataPath = path.join(dir, "plugins/data/io.github.new-beginner.session-usage");
fs.mkdirSync(dataPath, { recursive: true });
const task = (callId, status = "completed") => ({ type: "message", role: "tool", toolName: "Task", blocks: [{ type: "tool_call", name: "Task", callId,
  result: { details: { delegationId: `delegate-${callId}`, agent: "fixer", status } } }] });
const reply = (id, input, output, parent) => ({ type: "message", role: "assistant", id, createdAt: "2026-10-11T10:00:00Z",
  meta: { status: "complete", modelId: parent === "b" ? "other-model" : "same-model", ...(parent ? { parentToolCallId: parent, agentName: "fixer" } : {}),
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: input * 2, reasoningTokens: 2 } } });
const rows = {
  A: [task("a", "running"), task("b"), ...Array.from({ length: 60 }, (_, i) => reply(`m${i}`, 1, i + 1)),
    reply("a1", 10, 11, "a"), reply("b1", 20, 21, "b"), reply("a2", 10, 12, "a"), reply("b2", 20, 22, "b")],
  B: [reply("b-main", 777, 3)], empty: [], missing: [reply("known", 5, 1), task("unavailable")],
  pending: [{ type: "message", role: "assistant", id: "pending", meta: { status: "streaming" } }],
  failed: ["{damaged"], database: [], aggregate: [], queue: [], checkpoint: [],
};
const write = id => fs.writeFileSync(path.join(sessions, id + ".jsonl"), [JSON.stringify({ type: "session", sessionId: id }),
  ...rows[id].map(r => typeof r === "string" ? r : JSON.stringify(r))].join("\n") + "\n");
Object.keys(rows).forEach(write);
const db = new DatabaseSync(path.join(dir, "pi.sqlite"));
db.exec("pragma journal_mode=wal; pragma wal_autocheckpoint=0;");
db.exec(`create table sessions (id text primary key, title text, model_id text, provider_id text, thinking_level text, updated_at text, created_at text, deleted_at text);
  create table turns (session_id text, status text, input_tokens integer, output_tokens integer, usage_json text);`);
for (const id of Object.keys(rows)) {
  db.prepare("insert into sessions values (?, ?, 'same-model', '', 'high', '', '', null)").run(id, `Synthetic ${id}`);
  db.prepare("insert into turns values (?, 'running', 0, 0, null)").run(id);
}
const dbOperation = (id, inputTokens, outputTokens) => ({ operationId: id, modelId: "same-model", providerId: "local", inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
const putDatabase = (id, operations, status = "running", summary) => {
  const unique = [...new Map(operations.map(op => [op.operationId, op])).values()];
  const usage = summary || { aggregation: "aggregate", inputTokens: unique.reduce((n, op) => n + op.inputTokens, 0), outputTokens: unique.reduce((n, op) => n + op.outputTokens, 0), totalTokens: unique.reduce((n, op) => n + op.totalTokens, 0), operations };
  db.prepare("update turns set status=?, input_tokens=?, output_tokens=?, usage_json=? where session_id=?").run(status, usage.inputTokens, usage.outputTokens, JSON.stringify(usage), id);
};
const databaseOperations = [dbOperation("db-one", 23423, 34)];
putDatabase("database", databaseOperations, "completed");
putDatabase("aggregate", [], "completed", { aggregation: "aggregate", inputTokens: 80, outputTokens: 9, totalTokens: 89 });
const queueFile = path.join(dir, "session-message-outbox.json");
const putQueue = entries => { fs.writeFileSync(queueFile + ".tmp", JSON.stringify(entries)); fs.renameSync(queueFile + ".tmp", queueFile); };
const queuedReply = (id, usage, parent) => ({ key: `message:queue:${id}`, sessionId: "queue", turnId: "queue-turn",
  message: { id, role: "assistant", status: "complete", modelId: "same-model", usage,
    ...(parent ? { parentToolCallId: parent, agentName: "fixer" } : {}) } });
let look = { locale: "zh-CN", base: "light" }, settings = {}, publications = 0, readGate = null;
const context = vm.createContext({ require, module: { exports: {} }, setTimeout, clearTimeout,
  pi: { app: { getLocale: async () => look.locale, getAppearance: async () => look },
    plugin: { getDataPath: async () => {
      if (readGate) { const gate = readGate; readGate = null; gate.enter(); await gate.promise; }
      return dataPath;
    }, setSettings: async value => { settings = JSON.parse(JSON.stringify(value)); publications++; } },
    commands: { register: async () => {}, unregister: async () => {} }, ui: { showToast: async () => {} } } });
vm.runInContext(fs.readFileSync(path.join(root, "main.js"), "utf8"), context);
const plugin = context.module.exports;
let sequence = 0;
const switchTo = id => plugin.onRendererCall("usage.setContext", { instance: "browser-check", sequence: ++sequence, status: "active", sessionId: id });
(async () => {
  let browser;
  try {
    await plugin.onLoad(); switchTo("A");
    const initial = JSON.parse(JSON.stringify(await plugin.onPanelInvoke("usage.get")));
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 420, height: 960 }, reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", error => errors.push(String(error)));
    await page.exposeFunction("__invoke", (channel, payload) => channel === "app.getAppearance" ? look : plugin.onPanelInvoke(channel, payload));
    await page.addInitScript(() => {
      window.__handlers = {};
      window.pluginBridge = { invoke: (channel, payload) => window.__invoke(channel, payload),
        on(event, handler) { window.__handlers[event] = handler; return () => delete window.__handlers[event]; } };
    });
    await page.goto(pathToFileURL(path.join(root, "renderer/index.html")).href);
    await page.waitForSelector("#scope-global");
    const selections = () => page.locator('.scope-control button[aria-pressed="true"]').evaluateAll(nodes => Object.fromEntries(nodes.map(n => [n.dataset.scopePart, n.dataset.scopeValue])));
    const choose = (part, value) => page.locator(`#scope-${part} [data-scope-value="${value}"]`).click();
    const input = () => page.locator('[data-metric="totals.input"]').getAttribute("data-shown").then(Number);
    const output = () => page.locator('[data-reply-metric="output"]').textContent();
    const allSelected = value => ({ global: value, totals: value, history: value, models: "all" });
    assert.deepEqual(await selections(), allSelected("all")); assert.equal(await input(), initial.totals.input);
    assert.equal(await page.locator("select, #scope-apply").count(), 0);
    assert.equal(await page.locator("#scope-global button").count(), 5);
    for (const part of ["global", "totals", "history"]) {
      assert.deepEqual(await page.locator(`#scope-${part} [data-scope-value^="agent:"]`).allTextContents(), ["子代理1", "子代理2"]);
    }
    for (const part of ["totals", "history"]) assert.equal(await page.locator(`#scope-${part} button`).count(), 4);
    assert.equal(await page.locator("#scope-models button").count(), 3);
    assert.equal(await page.locator('#scope-detail, [data-scope-part="detail"]').count(), 0);
    assert.equal(await page.locator("#usage-view").count(), 1);
    const modelBefore = await page.locator('#scope-models-panel').textContent();
    for (const id of ["all", "main", "agent:a", "agent:b"]) {
      const s = initial.scopes.find(s => s.id === id); await choose("global", id);
      assert.deepEqual(await selections(), allSelected(id)); assert.equal(await input(), s.totals.input);
      assert.equal(await page.locator(".history-bar").count(), s.replies); assert.equal(await output(), String(s.last.tokens.output));
      assert.equal(await page.locator('#scope-models-panel').textContent(), modelBefore);
    }
    await choose("totals", "main"); await choose("history", "agent:a");
    assert.deepEqual(await selections(), { global: "custom", totals: "main", history: "agent:a", models: "all" });
    assert.equal(await output(), "12"); assert.match(await page.locator('#reply-detail').textContent(), /子代理1/);
    const beforeCustom = await page.locator("#usage-view").innerHTML(); await choose("global", "custom");
    assert.equal(await page.locator("#usage-view").innerHTML(), beforeCustom);
    await page.locator(".history-bar").first().hover(); assert.equal(await output(), "11");
    await choose("models", "model:other-model"); assert.equal(await output(), "11");
    assert.equal(await page.locator('#scope-models-panel .model').count(), 1);
    assert.equal(await page.locator('#scope-models-panel .model-name').textContent(), "other-model");
    await choose("history", "agent:b"); assert.equal(await output(), "22");
    await page.locator(".history-bar").first().hover(); assert.equal(await output(), "21");
    await choose("models", "all");
    console.log("PASS numbered child controls, independent model filter, custom no-op and sticky chart-linked details");

    await choose("global", "all"); await page.locator(".history-bar").first().hover(); assert.equal(await output(), "1");
    await page.evaluate(() => { document.getElementById("history-scroll").scrollLeft = 250; });
    await choose("totals", "main");
    const before = await selections();
    await page.locator("#refresh").click(); assert.deepEqual(await selections(), before); assert.equal(await output(), "1");
    assert.equal(await page.locator("#history-scroll").evaluate(el => el.scrollLeft), 250);
    const delays = [];
    for (const [id, parent, expected] of [["new-main-1", null, 77], ["new-main-2", null, 78], ["new-child", "a", 79]]) {
      const start = performance.now(); rows.A.push(reply(id, 7, expected, parent)); write("A");
      await page.waitForFunction(expected => document.querySelector('[data-reply-metric="output"]')?.textContent === String(expected), expected, { timeout: 950, polling: 10 });
      delays.push(Math.round(performance.now() - start));
      assert.equal(settings.lastReport.session.running, true);
      assert.equal(await page.locator("#history-scroll").evaluate(el => el.scrollLeft >= el.scrollWidth - el.clientWidth - 1), true);
      assert.deepEqual(await selections(), before);
    }
    assert.ok(delays.every(ms => ms < 1000));
    await page.locator(".history-bar").first().hover();
    const published = publications; rows.A.push(rows.A.at(-1)); write("A"); await page.waitForTimeout(120);
    assert.equal(publications, published); assert.equal(await output(), "1");
    console.log(`PASS file → backend wait → Chrome updates while parent running: ${delays.join("/")}ms; duplicate does not jump`);

    await choose("global", "all");
    await page.locator('#scope-global [data-scope-value="all"]').focus();
    await page.keyboard.press("Tab"); await page.keyboard.press("Enter");
    assert.deepEqual(await selections(), allSelected("main"));
    assert.equal(await page.locator('#scope-global [data-scope-value="main"]').evaluate(el => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none"), true);
    await page.keyboard.press("Tab"); await page.keyboard.press("Space"); assert.deepEqual(await selections(), allSelected("agent:a"));
    console.log("PASS keyboard Enter/Space and visible focus");

    switchTo("B"); await page.waitForSelector('#usage-view[data-session="B"]');
    assert.deepEqual(await selections(), {}); assert.equal(await input(), 777);
    assert.equal(await page.locator('#scope-global, #scope-totals, #scope-history, #scope-models').count(), 0);
    await page.screenshot({ path: path.join(screenshots, `usage-${version}-main-only.png`), fullPage: true });
    rows.A.push(reply("late-old-session", 9999, 999)); write("A"); await page.waitForTimeout(100);
    assert.equal(await input(), 777); assert.equal(await page.locator("#usage-view").getAttribute("data-session"), "B");
    await page.locator("#session-trigger").click(); await page.locator('.session-option[data-session="empty"]').click();
    await page.waitForSelector('#usage-view[data-session="empty"]');
    assert.match(await page.locator("#context-status").textContent(), /固定查看/);
    assert.equal(await page.locator(".history-bar").count(), 0); assert.equal(await page.locator('.scope-control').count(), 0);
    await page.locator("#follow").click(); await page.waitForSelector('#usage-view[data-session="B"]');
    console.log("PASS session switch rejects old data; session picker and follow/fixed behavior retained");

    switchTo("missing"); await page.waitForSelector('#usage-view[data-session="missing"]'); await choose("global", "all");
    assert.equal(await input(), 5); assert.equal(await page.locator("#scope-totals-panel .scope-status").count(), 0);
    assert.doesNotMatch(await page.locator("#usage-view").textContent(), /统计不完整|partition_incomplete|unknown_usage_identity|missing_agent_usage/);
    await choose("global", "agent:unavailable"); assert.equal(await page.locator(".num").count(), 0);
    assert.match(await page.locator("#scope-totals-panel").textContent(), /暂无可显示的用量/);
    switchTo("pending"); await page.waitForSelector('#usage-view[data-session="pending"]');
    assert.match(await page.locator("#scope-totals-panel").textContent(), /暂无可显示的用量/);
    switchTo("failed"); await page.waitForSelector('#usage-view[data-session="failed"]');
    assert.match(await page.locator("#scope-totals-panel").textContent(), /暂无可显示的用量/);
    assert.equal(await page.locator('.scope-notice').count(), 0);
    assert.equal(await page.locator('.scope-status').evaluateAll(nodes => {
      const probe = document.createElement('span'); probe.style.color = 'var(--muted)'; document.body.append(probe);
      const muted = getComputedStyle(probe).color; probe.remove();
      return nodes.every(node => getComputedStyle(node).color === muted);
    }), true);
    console.log("PASS known/partial/pending/failed/no-child data states, no invented zero");

    switchTo("database"); await page.waitForSelector('#usage-view[data-session="database"]'); await choose("global", "all");
    assert.equal(await input(), 23423); assert.equal(await output(), "34");
    assert.equal(await page.locator(".history-bar").count(), 1); assert.match(await page.locator("#reply-detail").textContent(), /归属未知/);
    assert.equal(await page.locator("#scope-models-panel .model-name").textContent(), "same-model");
    for (const part of ["totals", "history", "detail", "models"]) assert.doesNotMatch(await page.locator(`#scope-${part}-panel`).textContent(), /暂无带用量/);
    await choose("global", "main"); assert.equal(await page.locator(".num").count(), 0); assert.match(await page.locator("#scope-totals-panel").textContent(), /暂无可显示的用量/);
    assert.match(await page.locator('#usage-reconciliation').textContent(), /总和 1次 \/ 23,457 Token = 主代理 0次 \/ 0 Token \+ 子代理 0次 \/ 0 Token \+ 未归属 1次 \/ 23,457 Token/);
    assert.match(await page.locator('#usage-reconciliation').textContent(), /不是用户提问轮数/);
    console.log('PASS database-only residual remains visible while Main scope has no attributable usage');
    await choose("global", "all");
    const jsonlBefore = fs.readFileSync(path.join(sessions, "database.jsonl"), "utf8"), jsonlMtime = fs.statSync(path.join(sessions, "database.jsonl")).mtimeMs;
    const databaseDelays = [];
    for (let i = 2; i <= 4; i++) {
      const start = performance.now(); databaseOperations.push(dbOperation(`db-${i}`, i * 10, i)); putDatabase("database", databaseOperations);
      await page.waitForFunction(i => document.querySelectorAll(".history-bar").length === i && document.querySelector('[data-reply-metric="output"]')?.textContent === String(i), i, { timeout: 950, polling: 10 });
      databaseDelays.push(Math.round(performance.now() - start)); assert.equal(settings.lastReport.session.running, true);
    }
    assert.equal(fs.readFileSync(path.join(sessions, "database.jsonl"), "utf8"), jsonlBefore); assert.equal(fs.statSync(path.join(sessions, "database.jsonl")).mtimeMs, jsonlMtime);
    const databasePublished = publications, databaseTotal = settings.lastReport.totals.input;
    await page.locator(".history-bar").first().hover();
    putDatabase("database", [...databaseOperations, databaseOperations[0]]); await page.waitForTimeout(150);
    assert.equal(publications, databasePublished); assert.equal(await output(), "34"); assert.equal(await input(), databaseTotal);
    rows.database.push({ ...reply("late-disk", 23423, 34, "verified-child"), meta: {
      ...reply("late-disk", 23423, 34, "verified-child").meta, usage: databaseOperations[0] } }); write("database");
    await page.waitForFunction(() => document.getElementById("reply-detail").textContent.includes("数据库 operation") && !document.getElementById("reply-detail").textContent.includes("归属未知"));
    assert.equal(await page.locator(".history-bar").count(), 4); assert.equal(await input(), databaseTotal); assert.equal(await output(), "34");
    console.log(`PASS SQLite/WAL → backend wait → Chrome, unchanged JSONL: ${databaseDelays.join("/")}ms; duplicates and later JSONL do not recount/reset history`);

    switchTo("queue"); await page.waitForSelector('#usage-view[data-session="queue"]');
    const queueJsonl = fs.readFileSync(path.join(sessions, "queue.jsonl"), "utf8"), queueEntries = [], queueDelays = [];
    for (let i = 1; i <= 4; i++) {
      const start = performance.now(), usage = dbOperation(`queue-${i}`, i * 10, i);
      queueEntries.push({ sessionId: "queue", turnId: "queue-turn", key: `usage-${i}`, usage }, queuedReply("m" + i, usage, i % 2 ? undefined : "child"));
      putQueue(queueEntries);
      await page.waitForFunction(i => document.querySelectorAll('.history-bar').length === i && document.querySelector('[data-reply-metric="output"]')?.textContent === String(i), i, { timeout: 950, polling: 10 });
      queueDelays.push(Math.round(performance.now() - start));
      assert.equal(await input(), i * (i + 1) * 5);
      assert.equal(await page.locator('#scope-models-panel .model-name').textContent(), "same-model");
      assert.equal(await page.locator('#scope-models-panel .model-sub').textContent(), String(i * (i + 1) * 5));
      assert.equal(settings.lastReport.session.running, true);
    }
    assert.equal(fs.readFileSync(path.join(sessions, "queue.jsonl"), "utf8"), queueJsonl);
    assert.equal(settings.lastReport.sourceCoverage.databaseOperations, 0);
    await choose("history", "main"); assert.equal(await page.locator('.history-bar').count(), 2); assert.equal(await output(), "3");
    await page.locator('.history-bar').first().hover(); assert.equal(await output(), "1");
    await choose("history", "agent:child"); assert.equal(await page.locator('.history-bar').count(), 2); assert.equal(await output(), "4");
    await page.locator('.history-bar').first().hover(); assert.equal(await output(), "2");
    putQueue([]); await page.waitForTimeout(100); assert.equal(await input(), 100); assert.equal(await output(), "2");
    assert.doesNotMatch(await page.locator('#usage-view').textContent(), /统计不完整|partition_incomplete|unknown_usage_identity|unreadable_usage_queue/);
    console.log(`PASS queue-only → backend wait → Chrome all regions, main/child chart-linked details: ${queueDelays.join("/")}ms; drained queue preserves measurements`);
    switchTo("checkpoint"); await page.waitForSelector('#usage-view[data-session="checkpoint"]');
    putQueue(Array.from({ length: 1024 }, (_, i) => ({ sessionId: "other", key: "full-" + i })));
    const checkpointTranscript = fs.readFileSync(path.join(sessions, "checkpoint.jsonl"), "utf8");
    const fullQueue = fs.readFileSync(queueFile, "utf8"), checkpointDelays = [];
    const checkpointFile = path.join(sessions, "checkpoint.inflight.json");
    const checkpointOperations = [];
    for (let i = 1; i <= 4; i++) {
      const usage = dbOperation("checkpoint-" + i, i * 10, i); checkpointOperations.push(usage);
      const started = performance.now();
      fs.writeFileSync(checkpointFile + ".tmp", JSON.stringify({ schema: 1, sessionId: "checkpoint", turnId: "checkpoint-turn",
        savedAt: new Date().toISOString(), message: { id: "checkpoint-message-" + i, role: "assistant",
          blocks: [{ type: "text", text: "PRIVATE_CHECKPOINT_BODY" }], meta: { status: "complete", modelId: "same-model", usage } } }));
      fs.renameSync(checkpointFile + ".tmp", checkpointFile);
      await page.waitForFunction(n => document.querySelectorAll('.history-bar').length === n, i);
      assert.equal(await input(), i * (i + 1) * 5); assert.equal(await output(), String(i));
      assert.equal(await page.locator('#scope-models-panel .model').count(), 1);
      assert.equal(await page.locator('.history-bar[aria-current="true"]').getAttribute('data-reply-key'), JSON.stringify(["operation", usage.operationId]));
      checkpointDelays.push(Math.round(performance.now() - started));
    }
    assert.equal(fs.readFileSync(path.join(sessions, "checkpoint.jsonl"), "utf8"), checkpointTranscript);
    assert.equal(fs.readFileSync(queueFile, "utf8"), fullQueue);
    assert.equal(db.prepare("select usage_json from turns where session_id='checkpoint'").get().usage_json, null);
    assert.ok(checkpointDelays.every(delay => delay < 2000));
    assert.equal(await page.locator('.history-bar').count(), 4);
    assert.equal(await page.locator('#scope-global, #scope-totals, #scope-history, #scope-models').count(), 0);
    putDatabase("checkpoint", checkpointOperations, "running");
    rows.checkpoint.push(...checkpointOperations.map((usage, i) => ({ type: "message", role: "assistant", id: "checkpoint-message-" + (i + 1), meta: { status: "complete", modelId: "same-model", usage } })));
    write("checkpoint"); await page.waitForTimeout(150);
    assert.equal(await page.locator('.history-bar').count(), 4); assert.equal(await input(), 100);
    assert.doesNotMatch(JSON.stringify(settings), /PRIVATE_CHECKPOINT_BODY|blocks|thinking"/);
    console.log(`PASS checkpoint-only → backend wait → Chrome with full unchanged outbox while parent running: ${checkpointDelays.join("/")}ms; main scope and late durable deduplication`);
    putQueue([]);
    switchTo("database"); await page.waitForSelector('#usage-view[data-session="database"]'); await choose("global", "all");

    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
    readGate = { enter, promise: held };
    databaseOperations.push(dbOperation("late-db-response", 9999, 999)); putDatabase("database", databaseOperations);
    await entered; switchTo("B"); release(); await page.waitForSelector('#usage-view[data-session="B"]');
    assert.equal(await input(), 777); assert.equal(await page.locator(".history-bar").count(), 1);
    switchTo("aggregate"); await page.waitForSelector('#usage-view[data-session="aggregate"]');
    assert.equal(await input(), 80); assert.equal(await page.locator(".history-bar, .last-card, #scope-models-panel .model").count(), 0);
    assert.equal(await page.locator('#scope-totals-panel .scope-status, #scope-detail-panel button').count(), 0);
    assert.match(await page.locator('#usage-reconciliation').textContent(), /仅有回合汇总/);
    assert.doesNotMatch(await page.locator("#usage-view").textContent(), /aggregate_only_usage|统计不完整|partition_incomplete/);
    console.log("PASS late database scan rejected after session switch; aggregate-only cumulative coverage without fabricated replies");

    switchTo("A"); await page.waitForSelector('#usage-view[data-session="A"]'); await choose("global", "all");
    for (const base of ["light", "dark"]) {
      look = { locale: "zh-CN", base };
      await page.evaluate(look => window.__handlers["appearance:changed"](look), look);
      for (const width of [320, 420, 590]) {
        await page.setViewportSize({ width, height: 960 });
        const layout = await page.evaluate(() => {
          const root = document.getElementById("root");
          const controls = [...document.querySelectorAll('.scope-control button')];
          const rects = controls.map(el => el.getBoundingClientRect());
          const countRect = document.querySelector('#scope-totals-panel .scope-row .badges').getBoundingClientRect();
          const optionsRect = document.querySelector('#scope-totals').getBoundingClientRect();
          return { overflow: root.scrollWidth > root.clientWidth + 1 || document.body.scrollWidth > innerWidth + 1,
            clipped: controls.some(el => el.scrollWidth > el.clientWidth + 1) || rects.some(r => r.left < -1 || r.right > innerWidth + 1),
            overlap: rects.some((a, i) => rects.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)),
            countBadgeBeforeOptions: countRect.left < optionsRect.left || countRect.bottom <= optionsRect.top + 1 };
        });
        assert.equal(layout.overflow, false, `${base}/${width}: no page overflow`);
        assert.equal(layout.clipped, false, `${base}/${width}: labels fit`); assert.equal(layout.overlap, false, `${base}/${width}: controls do not overlap`);
        assert.equal(layout.countBadgeBeforeOptions, true);
        await page.setViewportSize({ width, height: 1800 });
        const screenshot = path.join(screenshots, `usage-${version}-${base}-${width}.png`);
        await page.screenshot({ path: screenshot, fullPage: true }); console.log(`Screenshot: ${screenshot}`);
      }
    }
    look = { locale: "en", base: "dark" }; await page.locator("#refresh").click();
    await page.waitForFunction(() => document.getElementById("scope-global").textContent.includes("Custom"));
    await choose("global", "main");
    const beforeAnimated = settings.lastReport.scopes.find(s => s.id === "main").totals.input;
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const animationStart = performance.now(); rows.A.push(reply("animated-main", 23, 5)); write("A");
    await page.waitForFunction(expected => Number(document.querySelector('[data-metric="totals.input"]')?.dataset.shown) === expected,
      beforeAnimated + 23, { timeout: 950, polling: 10 });
    const animatedDelay = Math.round(performance.now() - animationStart); assert.ok(animatedDelay < 1000);
    console.log(`PASS default animation reaches final accumulated value in ${animatedDelay}ms`);
    switchTo("database"); await page.waitForSelector('#usage-view[data-session="database"]'); await choose("global", "all");
    const dbAnimatedBefore = settings.lastReport.totals.input, dbAnimationStart = performance.now();
    databaseOperations.push(dbOperation("animated-db", 23, 5)); putDatabase("database", databaseOperations);
    await page.waitForFunction(expected => Number(document.querySelector('[data-metric="totals.input"]')?.dataset.shown) === expected,
      dbAnimatedBefore + 23, { timeout: 950, polling: 10 });
    console.log(`PASS database-only default animation final accumulated value in ${Math.round(performance.now() - dbAnimationStart)}ms`);

    if (process.env.USAGE_REAL_HOST_ROOT && process.env.USAGE_REAL_SESSION_ID) {
      const { readRealReport, evidence } = require("./usage-real-check.cjs");
      const realReport = await readRealReport(process.env.USAGE_REAL_HOST_ROOT, process.env.USAGE_REAL_SESSION_ID);
      const realPage = await browser.newPage({ viewport: { width: 420, height: 1800 }, reducedMotion: "reduce" });
      realPage.on("pageerror", error => errors.push(String(error)));
      await realPage.exposeFunction("__realInvoke", channel => {
        if (channel === "app.getAppearance") return { locale: "zh-CN", base: "light" };
        if (channel === "usage.context") return realReport.context;
        if (channel === "usage.watch") return new Promise(() => {});
        return realReport;
      });
      await realPage.addInitScript(() => { window.pluginBridge = { invoke: (channel, payload) => window.__realInvoke(channel, payload), on: () => () => {} }; });
      await realPage.goto(pathToFileURL(path.join(root, "renderer/index.html")).href);
      await realPage.waitForSelector(".last-card");
      for (const key of ["input", "output", "total"]) {
        assert.equal(Number(await realPage.locator(`[data-metric="totals.${key}"]`).getAttribute("data-shown")), realReport.totals[key]);
      }
      assert.equal(await realPage.locator(".history-bar").count(), realReport.replies);
      await realPage.locator(`[data-reply-key="${realReport.verification.targetKey}"]`).hover();
      for (const [key, expected] of [["input", 23423], ["output", 34], ["total", 23457]]) {
        assert.equal(Number(await realPage.locator(`[data-reply-metric="${key}"]`).getAttribute("data-reply-value")), expected);
      }
      assert.match(await realPage.locator("#reply-detail").textContent(), /数据库 operation.*归属未知/);
      assert.equal(await realPage.locator("#scope-models-panel .model-name").textContent(), "gpt-6.1-sol");
      for (const part of ["totals", "history", "detail", "models"]) assert.doesNotMatch(await realPage.locator(`#scope-${part}-panel`).textContent(), /暂无带用量/);
      await realPage.screenshot({ path: path.join(screenshots, `usage-${version}-real-metadata.png`), fullPage: true });
      console.log("PASS actual read-only sample in all four Total regions", JSON.stringify(evidence(realReport)));
      await realPage.close();
    }
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log("PASS light/dark × 320/420/590 layouts, English, no script errors. Browser checks passed.");
  } finally {
    await plugin.onUnload(); await browser?.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
