'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const view = require('../views/lib/view-model.js');

const blocked = {
  eventId: 'evt_11111111-1111-4111-8111-111111111111',
  occurredAt: '2026-01-02T03:04:05.000Z',
  controlState: 'armed',
  contract: { mode: 'review', level: 'guard', hashPolicy: 'deny', dependencyPolicy: 'ask', agentBudget: 1 },
  action: { toolName: 'write', mutability: 'write', pathCount: 1 },
  decision: {
    policyOutcome: 'deny_and_explain',
    family: 'I',
    reasonCode: 'MODE_FORBIDS_MUTATION',
    responseOutcome: 'permission_deny_returned',
    hostEffect: 'unobserved',
    explanation: 'Task mode review does not authorize repository mutation.'
  }
};

const allowed = {
  eventId: 'evt_22222222-2222-4222-8222-222222222222',
  occurredAt: '2026-01-02T03:05:05.000Z',
  controlState: 'armed',
  contract: { mode: 'change', level: 'guard' },
  action: { toolName: 'read', mutability: 'read', pathCount: 0 },
  decision: { policyOutcome: 'allow', reasonCode: 'WITHIN_CONTRACT', responseOutcome: 'none', hostEffect: 'unobserved' }
};

test('every contract level maps to one readable state', () => {
  assert.equal(view.controlState({ mode: 'unconfirmed', level: 'watch' }), 'observing');
  assert.equal(view.controlState({ mode: 'review', level: 'watch' }), 'watching');
  assert.equal(view.controlState({ mode: 'review', level: 'guard' }), 'armed');
  assert.equal(view.controlState({ mode: 'change', level: 'lock' }), 'locked');
  assert.equal(view.controlState({ mode: 'change', level: 'off' }), 'off');
  assert.equal(view.headline({ mode: 'review', level: 'guard' }).label, 'armed · review');
});

test('policy rows spell out the effective budget and boundary', () => {
  const rows = view.policyRows({ agentBudget: 2, hashPolicy: 'allow', dependencyPolicy: 'deny', allowedPaths: ['src/**'], source: 'directive' });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row.value]));
  assert.equal(byId.agents, '2');
  assert.equal(byId.hash, 'allow');
  assert.equal(byId.deps, 'deny');
  assert.equal(byId.files, 'src/**');
  assert.equal(byId.source, 'directive');
  assert.equal(view.policyRows({})[0].value, 'unlimited');
});

test('event rows and filters use the recorded decision', () => {
  const row = view.eventRow(blocked);
  assert.equal(row.toolName, 'write');
  assert.equal(row.policyOutcome, 'deny_and_explain');
  assert.equal(row.hostEffect, 'unobserved');
  assert.equal(view.filterEvents([blocked, allowed], { outcome: 'allow' }).length, 1);
  assert.equal(view.filterEvents([blocked, allowed], { query: 'mutation' }).length, 1);
  assert.equal(view.filterEvents([blocked, allowed], { query: 'mode_forbids' }).length, 1);
  assert.equal(view.filterEvents([blocked, allowed], {}).length, 2);
});

test('explain lines keep the decision, the reason, and the host effect', () => {
  const lines = view.explainLines(blocked);
  const text = lines.join('\n');
  assert.match(text, /deny_and_explain \/ MODE_FORBIDS_MUTATION/);
  assert.match(text, /Host effect: unobserved/);
  assert.match(text, /Why: Task mode review/);
  assert.match(text, /Label: unlabeled/);
  assert.deepEqual(view.explainLines(null), []);
});

test('doctor rows and the overview summary degrade cleanly', () => {
  const rows = view.doctorRows({ checks: [{ id: 'dataDir', ok: true, detail: 'C:/x' }, { id: 'locks', ok: false, detail: '1 lock' }] });
  assert.deepEqual(rows.map((row) => row.label), ['WAITING', 'PASS', 'FAIL']);
  const loaded = view.doctorRows({
    checks: [{ id: 'dataDir', ok: true, detail: 'C:/x' }],
    extension: { registeredAt: '2026-01-02T03:04:05.000Z', commandApi: 'registerCommand' }
  });
  assert.equal(loaded[0].label, 'LOADED');
  assert.match(loaded[0].detail, /command API: registerCommand/);
  assert.equal(view.summarize(null).state, 'unavailable');
  const summary = view.summarize({
    ok: true,
    sessions: { total: 2, damaged: 1, list: [{ contract: { mode: 'review', level: 'guard' } }] },
    locks: { count: 0, stale: 0 }
  });
  assert.equal(summary.label, 'armed · review');
  assert.equal(summary.sessions, '2');
  assert.equal(summary.damagedSessions, '1');
});

test('explain lines and doctor rows can be written in another language', () => {
  const table = {
    'explain.event': '事件: ', 'explain.when': '时间: ', 'explain.state': '状态: ',
    'explain.action': '动作: ', 'explain.paths': '；路径数=', 'explain.decision': '判定: ',
    'explain.response': '响应: ', 'explain.hostEffect': '宿主效果: ',
    'explain.policy': '哈希: {hash}；依赖: {deps}；Agents: {agents}',
    'explain.label': '标注: ', 'label.unlabeled': '未标注'
  };
  const t = (key, fallback) => table[key] || fallback || key;
  const lines = view.explainLines(blocked, t).join('\n');
  assert.match(lines, /事件: evt_11111111/);
  assert.match(lines, /判定: deny_and_explain \/ MODE_FORBIDS_MUTATION/);
  assert.match(lines, /哈希: deny；依赖: ask；Agents: 1/);
  assert.match(lines, /标注: 未标注/);

  // The panel needs the key and the numbers, not just the English sentence.
  const rows = view.doctorRows({
    checks: [{ id: 'locks', ok: true, detail: '0 lock(s), 0 older than 10s', data: { count: 0, stale: 0 } }]
  });
  assert.equal(rows[0].labelKey, 'waiting');
  assert.equal(rows[0].detailKey, 'extensionWaiting');
  assert.equal(rows[1].labelKey, 'pass');
  assert.equal(rows[1].detailKey, 'locks');
  assert.deepEqual(rows[1].detailArgs, { count: 0, stale: 0 });
});

test('doctor details are rendered from the numbers in either language', () => {
  const table = {
    'doctor.stateFiles': '{total} 个文件，{damaged} 个损坏{unreadable}',
    'doctor.extensionElsewhere': '扩展注册在 {fallback}，而本报告读取 {dataDir}',
    'doctor.extensionLoaded': '注册于 {time} · 命令 API：{api}'
  };
  const t = (key, fallback) => table[key] || fallback || key;
  assert.equal(
    view.doctorDetail({ detailKey: 'stateFiles', detailArgs: { total: 2, damaged: 1, unreadable: 'ENOTDIR' }, detail: 'x' }, t),
    '2 个文件，1 个损坏 (ENOTDIR)'
  );
  assert.equal(
    view.doctorDetail({ detailKey: 'extensionDataDir', detailArgs: { elsewhere: true, fallback: 'A', dataDir: 'B' }, detail: 'x' }, t),
    '扩展注册在 A，而本报告读取 B'
  );
  assert.equal(
    view.doctorDetail({ detailKey: 'extensionLoaded', detailArgs: { time: 'T', api: 'registerCommand' }, detail: 'x' }, t),
    '注册于 T · 命令 API：registerCommand'
  );
  // A row the panel has no template for keeps the sentence the report recorded.
  assert.equal(view.doctorDetail({ detailKey: 'unknown', detailArgs: {}, detail: 'recorded' }, t), 'recorded');
});
