"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const shared = script.slice(0, script.indexOf("      let pickerOpen"));
const helpers = script.slice(script.indexOf("      // HISTORY_HELPERS_START"), script.indexOf("      // HISTORY_HELPERS_END"));
function api() {
  const context = vm.createContext({});
  vm.runInContext(shared + helpers + "\nglobalThis.api = { createHistorySelection, historyChart, replyDetail, chartTotal, copy };", context);
  return context.api;
}
function row(sequence, tokens = {}) {
  return { key: `${sequence}:reply-${sequence}`, id: `reply-${sequence}`, sequence,
    modelId: `model-${sequence}`, createdAt: '2026-10-11T12:00:00Z', durationMs: 4700,
    tokens: { input: sequence * 10, cacheRead: 200, cacheWrite: 20, output: 12, reasoning: 8,
      total: sequence * 10 + 240, hitRate: 200 / (sequence * 10 + 220), ...tokens } };
}
function report(count = 3, id = "A") {
  const history = Array.from({ length: count }, (_, i) => row(i + 1));
  return { ok: true, locale: 'zh-CN', session: { id }, replies: count, history, last: history.at(-1) || null };
}

test('default latest, hover changes selection, leave/gap keeps last viewed record', () => {
  const a = api(), state = a.createHistorySelection(), r = report();
  const before = JSON.stringify(r); state.setReport(r);
  assert.equal(state.selection().row.sequence, 3); assert.equal(state.selection().inspecting, false);
  state.hover(r.history[0].key); assert.equal(state.selection().row.sequence, 1);
  state.hover(r.history[1].key); assert.equal(state.selection().row.sequence, 2);
  state.hover(null); assert.equal(state.selection().row.sequence, 2);
  assert.equal(state.selection().inspecting, true); assert.equal(JSON.stringify(r), before);
});

test('keyboard and pointer each select; blur or leaving does not undo last selection', () => {
  const state = api().createHistorySelection(), r = report(); state.setReport(r);
  state.focus(r.history[0].key); assert.equal(state.selection().row.sequence, 1);
  state.hover(r.history[1].key); assert.equal(state.selection().row.sequence, 2);
  state.hover(null); assert.equal(state.selection().row.sequence, 2);
  state.focus(null); assert.equal(state.selection().row.sequence, 2);
});

test('same-session refresh keeps selection; completed new reply resets to latest once', () => {
  const state = api().createHistorySelection(), r = report(); state.setReport(r);
  state.hover(r.history[0].key);
  const same = report(3); same.history[0].tokens.output = 99;
  assert.equal(state.setReport(same), false); assert.equal(state.latestCompleted(), false);
  assert.equal(state.selection().row.sequence, 1); assert.equal(state.selection().row.tokens.output, 99);
  const next = report(4); state.setReport(next);
  assert.equal(state.latestCompleted(), true); assert.equal(state.selection().row.sequence, 4);
  assert.equal(state.selection().inspecting, false);
  state.hover(next.history[0].key); state.setReport(report(4));
  assert.equal(state.latestCompleted(), false); assert.equal(state.selection().row.sequence, 1);
  state.hover(next.history[3].key); state.setReport(report(1));
  assert.equal(state.selection().row.sequence, 1); assert.equal(state.selection().inspecting, false);
});

test('every completed reply resets to latest while the session is still running', () => {
  const state = api().createHistorySelection(), r = report(); state.setReport(r); state.hover(r.history[0].key);
  const next = report(4); next.session.running = true;
  state.setReport(next); assert.equal(state.latestCompleted(), true); assert.equal(state.selection().row.sequence, 4);
  state.hover(next.history[0].key);
  const continuous = report(5); continuous.session.running = true;
  state.setReport(continuous); assert.equal(state.latestCompleted(), true); assert.equal(state.selection().row.sequence, 5);
  state.hover(continuous.history[0].key); state.setReport(report(5));
  assert.equal(state.latestCompleted(), false); assert.equal(state.selection().row.sequence, 1);
});

test('whole-turn completion without new model output is an ordinary refresh', () => {
  const state = api().createHistorySelection(), r = report(); r.turns = { completed: 1 }; state.setReport(r); state.focus(r.history[0].key);
  const next = report(); next.turns = { completed: 2 }; state.setReport(next);
  assert.equal(state.latestCompleted(), false); assert.equal(state.selection().row.sequence, 1);
  assert.equal(state.focusedKey(), r.history[0].key);
});

test('stack segments use explicit cumulative offsets and omit zeros', () => {
  const a = api(), r = report(1); r.history[0].tokens = { input: 25, cacheRead: 50, cacheWrite: 0, output: 25 };
  const chart = a.historyChart(r, a.copy('zh-CN'));
  assert.match(chart, /data-segment="input" style="bottom:0%;height:25%/);
  assert.match(chart, /data-segment="cacheRead" style="bottom:25%;height:50%/);
  assert.match(chart, /data-segment="output" style="bottom:75%;height:25%/);
  assert.doesNotMatch(chart, /data-segment="cacheWrite"/);
  assert.match(html, /grid-template-columns: minmax\(0, 1fr\); grid-template-rows: 140px/);
  assert.match(html, /\.history-bar\.active::after/);
});

test('session switch, empty and error clear history focus and hover even with same reply keys', () => {
  const state = api().createHistorySelection(), r = report(); state.setReport(r);
  state.focus(r.history[0].key); state.hover(r.history[1].key);
  assert.equal(state.setReport(report(3, 'B')), true);
  assert.equal(state.selection().row.sequence, 3); assert.equal(state.selection().inspecting, false);
  state.setReport(report(0, 'B')); assert.equal(state.selection().row, null);
  state.setReport({ ok: false, error: 'missing' }); assert.equal(state.selection().row, null);
});

test('chart keeps every reply, exactly four stacked categories, scale excludes reasoning', () => {
  const a = api(), r = report(120), chart = a.historyChart(r, a.copy('zh-CN'));
  assert.equal((chart.match(/class="history-bar"/g) || []).length, 120);
  assert.equal((chart.match(/data-reply-key=/g) || []).length, 120);
  assert.match(chart, /history-axis/); assert.match(chart, /history-sequence/);
  assert.match(chart, /min-width:1924px/); assert.match(chart, /第 120 次回复/);
  assert.equal(a.chartTotal(row(1, { reasoning: 99999 })), 242);
  assert.doesNotMatch(chart, /--chart-reasoning|NaN|Infinity/);
  assert.equal(a.historyChart(report(0), a.copy('en')), '');
});

test('single, zero and missing categories render safely; no HTML injection', () => {
  const a = api(), r = report(1);
  r.history[0].tokens = { output: 0, hitRate: null };
  r.history[0].modelId = '<img src=x onerror="fail">';
  r.history[0].createdAt = 'invalid'; r.history[0].durationMs = undefined;
  const chart = a.historyChart(r, a.copy('en'));
  assert.equal((chart.match(/class="history-bar"/g) || []).length, 1);
  assert.match(chart, /height:0%/); assert.doesNotMatch(chart, /NaN|Infinity|<img/);
  const detail = a.replyDetail(r.last, true, 'en', a.copy('en'));
  assert.match(detail, /Reply 1/); assert.match(detail, /&lt;img/);
  assert.doesNotMatch(detail, /NaN|Infinity|Invalid Date|last-meta/);
  assert.equal((detail.match(/data-reply-metric=/g) || []).length, 6);
  assert.equal(a.replyDetail(null, false, 'en', a.copy('en')), '');
});

test('detail shows actual metadata, cache TTL, reasoning, total and instant values', () => {
  const a = api(), r = row(2, { cacheWrite5m: 20, cacheWrite1h: 40 });
  const detail = a.replyDetail(r, true, 'zh-CN', a.copy('zh-CN'));
  assert.match(detail, /第 2 次回复/); assert.match(detail, /model-2/); assert.match(detail, /4.7s/);
  assert.match(detail, /命中 83.3%/); assert.match(detail, /5m 20 · 1h 40/);
  assert.match(detail, /data-reply-metric="reasoning">8/);
  assert.match(detail, /data-reply-metric="total">260/);
  assert.doesNotMatch(detail, /class="num"/);
  assert.match(a.replyDetail(r, false, 'en', a.copy('en')), /Last reply/);
});

test('stationary pointer reconciliation never changes sticky selection; scroll restore works', () => {
  const listeners = new Map(), root = { addEventListener() {} }, bars = [];
  let hit = null, focusCalls = 0;
  const target = { innerHTML: '' };
  const scroller = { scrollLeft: 0, scrollWidth: 1000, addEventListener(name, cb) { listeners.set(name, cb); },
    querySelectorAll: () => bars };
  const document = { documentElement: { addEventListener(name, cb) { listeners.set(name, cb); } },
    addEventListener(name, cb) { listeners.set(name, cb); },
    getElementById: id => ({ root, 'reply-detail': target, 'history-scroll': scroller }[id]),
    querySelectorAll: () => bars, elementFromPoint: () => hit };
  const context = vm.createContext({ document, window: { addEventListener(name, cb) { listeners.set(name, cb); } } });
  const controller = script.slice(script.indexOf('      const historySelection ='), script.indexOf('      function render('));
  vm.runInContext(shared + helpers + controller + '\nglobalThis.controls = { set(r) { historyReport = r; historySelection.setReport(r); detailSignature = ""; }, restoreHistory, reconcileHistoryPointer };', context);
  const r = report();
  for (const row of r.history) bars.push({ dataset: { replyKey: row.key },
    closest: () => bars.find(b => b.dataset.replyKey === row.key), matches: () => true,
    classList: { toggle() {} }, setAttribute() {}, focus() { focusCalls++; } });
  context.controls.set(r); context.controls.restoreHistory(null, null, true);
  assert.equal(scroller.scrollLeft, 1000); assert.match(target.innerHTML, /最近一次请求/);
  hit = bars[0]; listeners.get('pointermove')({ clientX: 100, clientY: 100, target: hit });
  assert.match(target.innerHTML, /第 1 次回复/);
  hit = bars[1]; context.controls.reconcileHistoryPointer(); assert.match(target.innerHTML, /第 1 次回复/);
  listeners.get('pointermove')({ clientX: 110, clientY: 100, target: hit });
  assert.match(target.innerHTML, /第 2 次回复/);
  hit = null; context.controls.reconcileHistoryPointer(); assert.match(target.innerHTML, /第 2 次回复/);
  context.controls.restoreHistory(321, r.history[0].key, false);
  assert.equal(scroller.scrollLeft, 321); assert.equal(focusCalls, 1);
  hit = bars[0]; listeners.get('pointermove')({ clientX: 100, clientY: 100, target: hit });
  listeners.get('pointerleave')(); assert.match(target.innerHTML, /第 1 次回复/);
});

test('DOM replacement focusout cannot cache old detail and skip rendering selected reply', () => {
  const listeners = new Map();
  let target = { innerHTML: '' }, onReplace = () => {};
  const root = { addEventListener() {}, querySelectorAll: () => [],
    set innerHTML(value) {
      onReplace(); // Browser focusout is synchronous while old nodes still exist.
      target = { innerHTML: 'replacement template contains latest reply' };
    } };
  const chrome = { setAttribute() {}, textContent: '', title: '' };
  const scroller = { scrollLeft: 12, scrollWidth: 100, querySelectorAll: () => [] };
  const document = { documentElement: { addEventListener() {}, lang: 'zh-CN' },
    addEventListener(name, cb) { listeners.set(name, cb); }, querySelectorAll: () => [],
    getElementById: id => id === 'root' ? root : id === 'reply-detail' ? target : id === 'history-scroll' ? scroller : chrome };
  const context = vm.createContext({ document, window: { addEventListener() {} }, requestAnimationFrame: () => 1 });
  const rendering = script.slice(script.indexOf('      const historySelection ='), script.indexOf('      const contextKey ='));
  vm.runInContext(shared + helpers + rendering + `
    function restorePicker() {} function playNumbers() {} function sessionSelect() { return ''; }
    globalThis.setup = r => { historyReport = r; historySelection.setReport(r); historySelection.focus(r.history[0].key); historySelection.hover(r.history[1].key); };
    globalThis.draw = r => render(r, { fromZero: false });
  `, context);
  const r = report(); context.setup(r);
  onReplace = () => listeners.get('focusout')({ target: { closest: () => ({}) } });
  context.draw(report());
  assert.match(target.innerHTML, /第 2 次回复/);
  assert.match(target.innerHTML, /data-reply-sequence="2"/);
});

test('child detail uses short numbered or unknown label without agent name or ID', () => {
  const a = api(), r = row(1, {});
  r.agentId = 'agent:17515e09'; r.agentName = 'explorer'; r.agentOrdinal = 1;
  for (const [locale, label] of [['zh-CN', '子代理1'], ['en', 'Subagent 1']]) {
    const detail = a.replyDetail(r, false, locale, a.copy(locale));
    assert.ok(detail.includes(`class="last-meta">${label} ·`));
    assert.doesNotMatch(detail, /explorer|17515e09/);
  }
  delete r.agentOrdinal;
  assert.match(a.replyDetail(r, false, 'zh-CN', a.copy('zh-CN')), /class="last-meta">子代理？ ·/);
  assert.match(a.replyDetail(r, false, 'en', a.copy('en')), /class="last-meta">Subagent \? ·/);
});
