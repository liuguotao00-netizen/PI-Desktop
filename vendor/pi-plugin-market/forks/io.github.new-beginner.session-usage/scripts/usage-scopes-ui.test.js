"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const decode = value => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Minimal executable DOM: real renderer, real delegated change/click/pointer/focus
// handlers and number rendering. No installed browser/DOM packages are required.
function ui() {
  const listeners = new Map(), nodes = new Map();
  let bars = [], numbers = [];
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); };
  const fire = (name, target) => { for (const fn of listeners.get(name) || []) fn({ target }); };
  function element(id = "", dataset = {}) {
    return { id, dataset, innerHTML: "", textContent: "", title: "", attributes: {},
      classList: { toggle() {} }, setAttribute(k, v) { this.attributes[k] = v; },
      addEventListener: on, querySelectorAll: selector => selector === ".history-bar" ? bars : [],
      closest(selector) { return selector === "button[data-scope-part]" ? (dataset.scopePart ? this : null) : selector.startsWith(".history-bar") && dataset.replyKey ? this : null; },
      matches: () => true, focus() { fire("focusin", this); } };
  }
  const root = element("root");
  let markup = "";
  Object.defineProperty(root, "innerHTML", { get: () => markup, set(value) {
    markup = value;
    for (const id of [...nodes.keys()]) if (!["root", "heading", "refresh"].includes(id)) nodes.delete(id);
    bars = []; numbers = [];
    for (const m of value.matchAll(/<button type="button" data-scope-part="([^"]+)" data-scope-value="([^"]+)" aria-pressed="([^"]+)">/g)) {
      const node = element(`scope-${m[1]}-${m[2]}`, { scopePart: m[1], scopeValue: m[2] });
      node.attributes['aria-pressed'] = m[3]; nodes.set(node.id, node);
    }
    const detail = value.match(/<section id="reply-detail">([\s\S]*?)<\/section>/);
    if (detail) { const node = element("reply-detail"); node.innerHTML = detail[1]; nodes.set(node.id, node); }
    if (value.includes('id="history-scroll"')) {
      const node = element("history-scroll"); node.scrollLeft = 0; node.scrollWidth = 1000; nodes.set(node.id, node);
    }
    for (const m of value.matchAll(/class="history-bar" data-reply-key="([^"]+)"/g)) bars.push(element("", { replyKey: decode(m[1]) }));
    for (const m of value.matchAll(/class="num" data-metric="([^"]+)" data-kind="([^"]+)" data-shown="([^"]*)"/g)) numbers.push(element("", { metric: m[1], kind: m[2], shown: m[3] }));
  } });
  root.querySelectorAll = selector => selector === ".num" ? numbers : selector === ".history-bar" ? bars : [];
  nodes.set("root", root); nodes.set("heading", element()); nodes.set("refresh", element());
  const document = { documentElement: { addEventListener: on, dataset: {} }, addEventListener: on,
    getElementById: id => nodes.get(id), querySelectorAll: root.querySelectorAll,
    querySelector: selector => { const m = selector.match(/#scope-(\w+) \[data-scope-value="([^"]+)"\]/); return m ? nodes.get(`scope-${m[1]}-${m[2]}`) : null; } };
  const context = vm.createContext({ document, window: { addEventListener: on, matchMedia: () => ({ matches: true }) },
    requestAnimationFrame: fn => { fn(); return 1; }, cancelAnimationFrame() {}, performance: { now: () => 0 } });
  new vm.Script(script); // Check the complete inline script, including async loading code.
  vm.runInContext(script.slice(0, script.indexOf("      const contextKey =")) + `
    globalThis.draw = r => render(r, { fromZero: false });
    globalThis.inspect = () => ({ selected: { ...scopeSelection.selected },
      history: historySelection.selection(), detail: historySelection.selection(),
      historyReport, detailReport, totals: scopeSelection.project('totals'), models: scopeSelection.project('models') });
  `, context);
  return { draw: context.draw, inspect: context.inspect, nodes, root,
    choose(part, value) { const node = nodes.get(`scope-${part}-${value}`); assert.ok(node, `missing ${part}/${value} button`); fire("click", node); },
    hover(index) { assert.ok(bars[index]); fire("pointermove", bars[index]); },
    focus(index) { assert.ok(bars[index]); fire("focusin", bars[index]); },
    leave() { fire("pointerleave"); },
    metric(key) { return numbers.find(n => n.dataset.metric === key)?.textContent; },
    detail: () => nodes.get("reply-detail")?.innerHTML,
    panel(part) { return markup.split(`<section id="scope-${part}-panel">`)[1]?.split('<section id="scope-')[0] || ""; },
  };
}
function metrics(n) {
  return { input: n, cacheRead: n * 2, cacheWrite: n, cacheWrite5m: n, cacheWrite1h: 0,
    output: n, reasoning: 1, prompt: n * 4, total: n * 5, hitRate: 0.5 };
}
function scope(id, n, count = 3, extra = {}) {
  const history = Array.from({ length: count }, (_, i) => ({ id: `reply-${i}`, key: `key-${i}`, sequence: i + 1,
    modelId: `model-${id}`, agentId: id.startsWith("agent:") ? id : "main", providerId: "provider", tokens: metrics(n + i) }));
  return { id, kind: id.startsWith("agent:") ? "agent" : id, name: "same agent", delegationId: id.slice(6),
    complete: true, unavailable: false, replies: count, totals: metrics(n), history, last: history.at(-1) || null,
    byModel: count ? [{ modelId: `model-${id}`, replies: count, tokens: metrics(n) }] : [], running: false, issues: [], ...extra };
}
function report(id = "parent-A", locale = "en") {
  const scopes = [scope("all", 100), scope("main", 10), scope("subagents", 90), scope("agent:call-A", 40), scope("agent:call-B", 50)];
  scopes[0].byModel = [{ modelId: "model-main", replies: 3, tokens: metrics(10) }, { modelId: "shared-child-model", replies: 6, tokens: metrics(90) }];
  return { ...scopes[0], ok: true, locale, session: { id, title: "Parent session", running: true }, recentSessions: [], scopes };
}

const childA = "agent:call-A", childB = "agent:call-B";
const model = id => `model:${encodeURIComponent(id)}`;
function mainOnly(id = "solo", locale = "en") {
  const main = scope("main", 10);
  const all = { ...main, id: "all", kind: "all" };
  return { ...all, ok: true, locale, session: { id, title: "Solo session" }, recentSessions: [], scopes: [all, main, scope("subagents", 0, 0)] };
}

test("dynamic child controls and independent model controls replace fixed agent categories", () => {
  const a = ui(); a.draw(report());
  assert.doesNotMatch(a.root.innerHTML, /<select |scope-apply|data-scope-part="detail"/);
  assert.equal((a.root.innerHTML.match(/data-scope-part="global"/g) || []).length, 5);
  for (const part of ["totals", "history"]) assert.equal((a.root.innerHTML.match(new RegExp(`data-scope-part="${part}"`, 'g')) || []).length, 4);
  assert.equal((a.root.innerHTML.match(/data-scope-part="models"/g) || []).length, 3);
  assert.match(a.root.innerHTML, /aria-pressed="false">Subagent 1<\/button>/);
  assert.match(a.root.innerHTML, /aria-pressed="false">Subagent 2<\/button>/);
  assert.doesNotMatch(a.root.innerHTML, /same agent| · call-A| · call-B/);
  assert.doesNotMatch(a.panel("models"), /data-scope-value="main"|data-scope-value="agent:/);
  a.choose("totals", "main"); assert.equal(a.metric("totals.input"), "10"); assert.equal(a.metric("totals.hitRate"), "50.0%");
  assert.equal(a.inspect().selected.global, "custom");
  a.choose("history", childA); assert.equal(a.inspect().historyReport.totals.input, 40);
  assert.match(a.detail(), /Subagent 1/); assert.match(a.detail(), /model-agent:call-A/);
  a.choose("models", model("shared-child-model")); assert.equal(a.inspect().models.byModel.length, 1);
  assert.equal(a.inspect().models.byModel[0].tokens.input, 90);
  const before = JSON.stringify(a.inspect().selected), markup = a.root.innerHTML;
  a.choose("global", "custom"); assert.equal(JSON.stringify(a.inspect().selected), before); assert.equal(a.root.innerHTML, markup);
  for (const value of ["all", "main", childA, childB]) {
    a.choose("global", value);
    assert.equal(a.inspect().selected.totals, value); assert.equal(a.inspect().selected.history, value);
    assert.equal(a.inspect().selected.models, model("shared-child-model"));
    assert.equal(a.nodes.get(`scope-global-${value}`).attributes['aria-pressed'], 'true');
  }
});

test("no children means no agent selector or redundant total; one model means no model selector", () => {
  const a = ui(); a.draw(mainOnly());
  assert.doesNotMatch(a.root.innerHTML, /data-scope-part=|scope-global|Subagent/);
  assert.equal(a.metric("totals.input"), "10"); assert.equal(a.inspect().selected.totals, "main");
  assert.equal(a.inspect().models.byModel.length, 1); assert.equal(a.inspect().models.byModel[0].tokens.input, 10);
});

test("a newly created child appears before usage and remains after completion", () => {
  const a = ui(), r = mainOnly(); a.draw(r);
  r.scopes.push(scope(childA, 0, 0, { running: true, unavailable: true, status: "running" }));
  a.draw(r); assert.ok(a.nodes.get(`scope-global-${childA}`)); assert.ok(a.nodes.get("scope-global-all"));
  assert.equal(a.inspect().selected.history, "all");
  a.choose("global", childA); assert.match(a.panel("totals"), /No usage available/);
  r.scopes[3] = scope(childA, 40, 3, { status: "completed" });
  a.draw(r); assert.ok(a.nodes.get(`scope-global-${childA}`)); assert.equal(a.metric("totals.input"), "40");
  assert.equal(a.inspect().selected.history, childA);
});

test("zero-token unassigned requests keep total/main buttons without inventing a child", () => {
  const a = ui(), r = mainOnly();
  r.reconciliation = { summaryOnly: false, unknown: { replies: 1, totals: { total: 0 } } };
  a.draw(r); assert.ok(a.nodes.get("scope-global-all")); assert.ok(a.nodes.get("scope-global-main"));
  assert.doesNotMatch(a.root.innerHTML, /data-scope-value="agent:|data-scope-value="subagents"/);
});

test("refresh and A/B/A switch retain per-session selection without phantom child buttons", () => {
  const a = ui(); a.draw(report()); a.choose("global", childB); a.choose("models", model("model-main"));
  a.draw(report()); assert.equal(a.inspect().selected.history, childB);
  a.draw(mainOnly()); assert.equal(a.metric("totals.input"), "10"); assert.equal(a.inspect().selected.history, "main");
  assert.doesNotMatch(a.root.innerHTML, /data-scope-value="agent:/);
  a.draw(report()); assert.equal(a.inspect().selected.history, childB); assert.equal(a.inspect().selected.models, model("model-main"));
  assert.equal(a.metric("totals.input"), "50");
});

test("stable numbering survives reorder, missing identity enrichment and resume scope aliases", () => {
  const a = ui(), r = report(); r.scopes[3].delegationId = ""; a.draw(r); a.choose("global", childA);
  const enriched = report(); enriched.scopes[3].delegationId = "same-delegation";
  enriched.scopes = [...enriched.scopes.slice(0, 3), enriched.scopes[4], enriched.scopes[3]];
  a.draw(enriched); assert.match(a.nodes.get(`scope-global-${childA}`) ? a.root.innerHTML : "", />Subagent 1<\/button>/);
  const resumed = report(); resumed.scopes[3].id = "agent:resume"; resumed.scopes[3].delegationId = "same-delegation";
  a.draw(resumed); assert.equal(a.inspect().selected.history, "agent:resume");
  assert.match(a.root.innerHTML, />Subagent 1<\/button>/);
});

test("unavailable and partial data stay selected without invented zeros", () => {
  const a = ui(), r = report(); r.scopes[0].unavailable = true; r.scopes[0].complete = false; a.draw(r);
  assert.equal(a.metric("totals.input"), undefined); assert.equal(a.detail(), ""); assert.match(a.panel("totals"), /No usage available/);
  const partial = report(); partial.scopes[1].complete = false; partial.scopes[1].issues = ["missing_usage", "partition_incomplete", "unknown_usage_identity"];
  a.draw(partial); a.choose("global", "main"); assert.equal(a.metric("totals.input"), "10");
  assert.doesNotMatch(a.root.innerHTML, /Incomplete statistics|missing_usage|partition_incomplete|unknown_usage_identity|scope-status warning/);
  partial.scopes[1].unavailable = true; a.draw(partial);
  assert.equal(a.inspect().selected.totals, "main"); assert.equal(a.metric("totals.input"), undefined);
  const empty = mainOnly(); empty.scopes = [scope("all", 0, 0), scope("main", 0, 0), scope("subagents", 0, 0)];
  a.draw(empty); assert.equal(a.detail(), ""); assert.equal(a.nodes.get("history-scroll"), undefined);
  assert.doesNotMatch(a.root.innerHTML, /data-scope-part=/);
});

test("details follow chart and sticky hover/focus; model and total choices preserve selection and scrolling", () => {
  const a = ui(); a.draw(report()); a.hover(0); a.leave(); assert.match(a.detail(), /data-reply-sequence="1"/);
  a.nodes.get("history-scroll").scrollLeft = 321;
  a.draw(report()); assert.match(a.detail(), /data-reply-sequence="1"/); assert.equal(a.nodes.get("history-scroll").scrollLeft, 321);
  a.choose("history", "main"); a.hover(1); assert.match(a.detail(), /model-main/); assert.match(a.detail(), /data-reply-sequence="2"/);
  a.root.scrollTop = 456; a.choose("totals", childB); a.choose("models", model("model-main")); assert.equal(a.root.scrollTop, 456);
  assert.match(a.detail(), /model-main/); assert.match(a.detail(), /data-reply-sequence="2"/);
  a.focus(0); assert.match(a.detail(), /data-reply-sequence="1"/);
  for (const id of ["all", childA, childB, "main"]) {
    a.choose("history", id); assert.equal(a.inspect().detailReport._scopeId, id);
    a.hover(1); assert.match(a.detail(), new RegExp(`model-${id}`)); assert.equal(a.inspect().history.row.key, a.inspect().detail.row.key);
  }
});

test("new completed rows reset only corresponding child history/detail while parent runs", () => {
  const a = ui(); a.draw(report()); a.choose("global", childA); a.hover(0); a.nodes.get("history-scroll").scrollLeft = 123;
  const next = report(); next.scopes[1] = scope("main", 10, 4, { running: true }); a.draw(next);
  assert.equal(a.inspect().history.row.sequence, 1); assert.equal(a.nodes.get("history-scroll").scrollLeft, 123);
  next.scopes[3] = scope(childA, 40, 4, { running: true }); a.draw(next);
  assert.equal(a.inspect().history.row.sequence, 4); assert.equal(a.nodes.get("history-scroll").scrollLeft, 1000);
  assert.match(a.detail(), /model-agent:call-A/);
});

test("Chinese/English labels, single-model and legacy reports remain supported", () => {
  const a = ui(); a.draw(report("parent-A", "zh-CN"));
  for (const text of ["总和", "主代理", "子代理1", "子代理2", "自定义"]) assert.match(a.root.innerHTML, new RegExp(text));
  a.draw(report()); assert.match(a.root.innerHTML, /Agent scope/); assert.match(a.root.innerHTML, /Custom/);
  const legacy = report(); delete legacy.scopes; a.draw(legacy); assert.equal(a.metric("totals.input"), "100");
  assert.doesNotMatch(a.root.innerHTML, /data-scope-part="global"|data-scope-part="totals"/);
  a.draw({ ok: false, error: "read failed", locale: "en" }); assert.match(a.root.innerHTML, /read failed/);
});

test("unknown model labels are escaped and filtered by exact model identity", () => {
  const a = ui(), r = mainOnly();
  const id = 'custom/provider/model "A" <b>';
  r.scopes[0].byModel = [{ modelId: id, replies: 1, tokens: metrics(5) }, { modelId: "unknown", replies: 1, tokens: metrics(5) }];
  r.locale = "zh-CN"; a.draw(r); assert.match(a.panel("models"), /未知模型/); assert.doesNotMatch(a.panel("models"), /<b>/);
  a.choose("models", model(id)); assert.equal(a.inspect().models.byModel.length, 1); assert.equal(a.inspect().models.byModel[0].modelId, id);
  a.choose("models", model("unknown")); assert.equal(a.inspect().models.byModel[0].modelId, "unknown");
});

test("model disappearance resets its selection to total, never hides remaining usage", () => {
  const a = ui(), r = report(); a.draw(r); a.choose("models", model("shared-child-model"));
  r.scopes[0].byModel = [r.scopes[0].byModel[0]]; a.draw(r);
  assert.equal(a.inspect().selected.models, "all"); assert.equal(a.inspect().models.byModel.length, 1);
  assert.doesNotMatch(a.panel("models"), /data-scope-part="models"/);
});

test("watcher diagnostics stay out of UI; exact reconciliation is independent of both dimensions", () => {
  const a = ui(), r = report("A", "zh-CN"); r.updateError = "watch_unavailable";
  for (const s of r.scopes) { s.complete = false; s.issues = ["partition_incomplete", "unknown_usage_identity", "unreadable_database", "retained_usage"]; }
  r.reconciliation = { summaryOnly: false,
    all: { replies: 255, totals: { total: 100001 } }, main: { replies: 141, totals: { total: 40001 } },
    subagents: { replies: 113, totals: { total: 12965 } }, unknown: { replies: 1, totals: { total: 47035 } } };
  a.draw(r); assert.equal(a.metric("totals.input"), "100");
  assert.doesNotMatch(a.root.innerHTML, /统计不完整|partition_incomplete|unknown_usage_identity|unreadable_database|retained_usage|watch_unavailable|warning/);
  assert.doesNotMatch(a.panel("detail"), /data-scope-part/);
  const notice = () => a.root.innerHTML.match(/<div id="usage-reconciliation"[\s\S]*?<\/div>/)?.[0] || "";
  const before = notice(); assert.match(before, /100,001/); assert.match(before, /47,035/); assert.match(before, /未归属/);
  for (const count of [255, 141, 113, 1]) assert.match(before, new RegExp(`${count}次`));
  assert.match(before, /不是用户提问轮数/);
  a.choose("global", childA); a.choose("models", model("model-main")); assert.equal(notice(), before);
  r.locale = "en"; a.draw(r); assert.match(notice(), /Unassigned/); assert.match(notice(), /requests/); assert.doesNotMatch(notice(), /\d+ turns/);
  a.draw(report("B", "zh-CN")); assert.doesNotMatch(a.root.innerHTML, /47,035|usage-reconciliation/);
});

test("aggregate-only reconciliation retains total/main but no invented child or model selectors", () => {
  const a = ui(), r = mainOnly("A", "zh-CN");
  r.reconciliation = { summaryOnly: true, all: { replies: null, totals: { total: 12345 } } };
  a.draw(r); assert.match(a.root.innerHTML, /仅有回合汇总/); assert.match(a.root.innerHTML, /次数及主\/子代理归属不可确认/);
  assert.ok(a.nodes.get("scope-global-all")); assert.ok(a.nodes.get("scope-global-main"));
  assert.doesNotMatch(a.root.innerHTML, /data-scope-value="agent:|总和 0次/);
});

test("Chinese child buttons and detail contain only the short numbered label", () => {
  const a = ui(); a.draw(report("short-labels", "zh-CN"));
  for (const part of ["global", "totals", "history"]) {
    const buttons = [...a.root.innerHTML.matchAll(new RegExp(`data-scope-part="${part}" data-scope-value="agent:[^"]+" aria-pressed="[^"]+">([^<]+)</button>`, 'g'))];
    assert.deepEqual(buttons.map(match => match[1]), ["子代理1", "子代理2"]);
  }
  a.choose("history", childA);
  assert.match(a.detail(), /class="last-meta">子代理1 ·/);
  assert.doesNotMatch(a.detail(), /same agent|same-delegation|子代理1 · call-A/);
});
