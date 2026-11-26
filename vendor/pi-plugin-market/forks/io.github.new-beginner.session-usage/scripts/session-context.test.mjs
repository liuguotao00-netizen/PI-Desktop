import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readContext, onLoad, onUnload } from '../renderer/session-context.mjs';

function marker(id, visible = true, row = false) {
  return {
    id, visible, row, nodeType: 1,
    getAttribute(name) { return name === 'data-session-pane' || name === 'data-sidebar-session-row' ? this.id : null; },
    matches() { return true; }, querySelector() { return null; },
    get textContent() { throw new Error('must not read message text'); },
    get innerHTML() { throw new Error('must not read message HTML'); },
  };
}
function docFixture({ panes = [], rows = [], shell = true } = {}) {
  const doc = {
    panes, rows, shell, hidden: false, documentElement: {}, listeners: new Map(),
    querySelectorAll(selector) { return selector.includes('data-session-pane') ? this.panes.filter(x => x.visible) : this.rows; },
    querySelector() { return this.shell ? {} : null; },
    addEventListener(name, fn) { this.listeners.set(name, fn); },
    removeEventListener(name) { this.listeners.delete(name); },
  };
  return doc;
}

test('visible pane wins over hidden retained panes and an already-selected destination row', () => {
  const doc = docFixture({ panes: [marker('A'), marker('B', false)], rows: [marker('B', true, true)] });
  assert.deepEqual(readContext(doc), { status: 'active', sessionId: 'A' });
  doc.panes[0].visible = false; doc.panes[1].visible = true;
  assert.deepEqual(readContext(doc), { status: 'active', sessionId: 'B' });
});
test('blank conversation uses selected row, duplicate row IDs are harmless', () => {
  assert.deepEqual(readContext(docFixture({ rows: [marker('blank'), marker('blank')] })), { status: 'active', sessionId: 'blank' });
});
test('no conversation, missing markers and ambiguity are explicit, never guessed', () => {
  assert.deepEqual(readContext(docFixture()), { status: 'none', sessionId: '' });
  assert.deepEqual(readContext(docFixture({ shell: false })), { status: 'unavailable', sessionId: '' });
  assert.deepEqual(readContext(docFixture({ panes: [marker('A'), marker('B')] })), { status: 'ambiguous', sessionId: '' });
  assert.deepEqual(readContext(docFixture({ rows: [marker('A'), marker('B')] })), { status: 'ambiguous', sessionId: '' });
});
test('invalid identity cannot become a file path', () => {
  for (const id of ['../private', 'A/B', 'C:private', 'A..B', 'A\\B', 'x'.repeat(129), '']) {
    assert.equal(readContext(docFixture({ panes: [marker(id)] })).status, 'unavailable');
  }
});

function environment(t, dispatch = async () => ({ accepted: true })) {
  const original = new Map();
  const replace = (name, value) => { original.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  const doc = docFixture({ panes: [marker('A'), marker('B', false)] });
  const win = { listeners: new Map(), addEventListener(n, f) { this.listeners.set(n, f); }, removeEventListener(n) { this.listeners.delete(n); } };
  const timers = new Map();
  const calls = [];
  let now = 0, timerId = 0, observer;
  const originalNow = Date.now;
  Date.now = () => now;
  replace('document', doc); replace('window', win);
  replace('MutationObserver', class {
    constructor(fn) { this.fn = fn; observer = this; }
    observe(_node, options) { this.options = options; this.connected = true; }
    disconnect() { this.connected = false; }
  });
  replace('setTimeout', (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; });
  replace('clearTimeout', id => timers.delete(id));
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  async function flush() {
    await drain();
    for (let i = 0; timers.size && i < 30; i++) {
      const [id, task] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(id); now = task.at; task.fn(); await drain();
    }
    assert.equal(timers.size, 0, 'timer retry budget must be bounded');
  }
  const pi = { dispatch: async (action, payload) => {
    assert.equal(action, 'plugin.call'); assert.equal(payload.method, 'usage.setContext');
    assert.deepEqual(Object.keys(payload.args).sort(), ['instance', 'sequence', 'sessionId', 'status']);
    calls.push({ ...payload.args, at: now }); return dispatch(payload.args);
  } };
  onLoad(pi);
  t.after(() => {
    onUnload(); Date.now = originalNow;
    for (const [name, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  const change = id => {
    doc.panes.forEach(pane => { pane.visible = pane.id === id; });
    observer.fn([{ type: 'attributes', target: doc.panes[0], addedNodes: [], removedNodes: [] }]);
  };
  return { doc, win, timers, calls, flush, drain, change, pi, observer: () => observer };
}

test('initial identity, A → B → A, deduplication and send rate are correct', async t => {
  const e = environment(t); await e.flush();
  assert.equal(e.calls[0].sessionId, 'A');
  assert.deepEqual(e.observer().options.attributeFilter, ['data-session-pane', 'data-visible', 'data-sidebar-session-row', 'class', 'aria-hidden']);
  e.change('A'); await e.flush(); assert.equal(e.calls.length, 1);
  e.change('B'); await e.flush(); e.change('A'); await e.flush();
  assert.deepEqual(e.calls.map(x => x.sessionId), ['A', 'B', 'A']);
  assert.deepEqual(e.calls.map(x => x.sequence), [1, 2, 3]);
  assert.ok(e.calls[1].at - e.calls[0].at >= 150);
});
test('rapid switches coalesce to final visible ID, not a streamed background node', async t => {
  const e = environment(t); await e.flush();
  e.change('B'); e.change('A'); e.change('B'); await e.flush();
  assert.deepEqual(e.calls.map(x => x.sessionId), ['A', 'B']);
  e.observer().fn([{ type: 'childList', addedNodes: [{ nodeType: 3 }], removedNodes: [] }]);
  await e.flush(); assert.equal(e.calls.length, 2);
});
test('A → B → A while B acknowledgement is delayed resends A', async t => {
  let release;
  const e = environment(t, args => args.sessionId === 'B' ? new Promise(resolve => { release = resolve; }) : { accepted: true });
  await e.flush(); e.change('B'); await e.flush();
  assert.equal(typeof release, 'function'); e.change('A'); await e.flush();
  release({ accepted: true }); await e.flush();
  assert.deepEqual(e.calls.map(x => x.sessionId), ['A', 'B', 'A']);
});
test('failed relay retries at most three times, focus can retry, changed identity gets fresh budget', async t => {
  let fails = true;
  const e = environment(t, () => { if (fails) throw new Error('synthetic relay unavailable'); return { accepted: true }; });
  await e.flush(); assert.equal(e.calls.length, 4);
  fails = false; e.win.listeners.get('focus')(); await e.flush(); assert.equal(e.calls.length, 5);
  e.change('B'); await e.flush(); assert.equal(e.calls.at(-1).sessionId, 'B');
});
test('unload disconnects observers/listeners and drops queued or late sends', async t => {
  const e = environment(t); await e.flush(); e.change('B'); await e.drain();
  onUnload(); await e.flush();
  assert.equal(e.calls.length, 1); assert.equal(e.observer().connected, false);
  assert.equal(e.win.listeners.size, 0); assert.equal(e.doc.listeners.size, 0);
});
test('renderer reload sends fresh initial identity with a new instance', async t => {
  const e = environment(t); await e.flush(); const old = e.calls[0].instance;
  onUnload(); e.doc.panes[0].visible = false; e.doc.panes[1].visible = true;
  onLoad(e.pi); await e.flush(); assert.equal(e.calls.at(-1).sessionId, 'B');
  assert.notEqual(e.calls.at(-1).instance, old); assert.equal(e.calls.at(-1).sequence, 1);
});
