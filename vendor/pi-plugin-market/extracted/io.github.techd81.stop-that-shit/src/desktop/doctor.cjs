'use strict';

// Metadata-only self check for the plugin's own data directory.
// It never creates or repairs state; recovery stays in the shared core.

const fs = require('node:fs');
const path = require('node:path');
const { dataRoot } = require('../state.cjs');
const { decodeState } = require('../state-schema.cjs');
const { readRuntime } = require('../runtime-audit.cjs');

const LOCK_STALE_MS = 10000;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function describeContract(contract) {
  return {
    mode: contract.mode,
    level: contract.level,
    agentBudget: contract.agentBudget,
    hashPolicy: contract.hashPolicy,
    dependencyPolicy: contract.dependencyPolicy,
    allowedPaths: contract.allowedPaths,
    source: contract.source
  };
}

function scanSessions(dataDir) {
  const dir = path.join(dataDir, 'sessions');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { total: 0, damaged: 0, sessions: [], locks: 0, staleLocks: 0 };
    // A sessions path that exists but cannot be listed is damage this report
    // names. A self check must answer while the data directory is broken.
    return { total: 1, damaged: 1, sessions: [], locks: 0, staleLocks: 0, unreadable: error.code || 'EUNKNOWN' };
  }
  const sessions = [];
  let damaged = 0;
  let locks = 0;
  let staleLocks = 0;
  const now = Date.now();
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.lock')) {
        locks += 1;
        const stat = fs.statSync(path.join(dir, entry.name), { throwIfNoEntry: false });
        if (stat && now - stat.mtimeMs > LOCK_STALE_MS) staleLocks += 1;
      }
      continue;
    }
    if (entry.name.endsWith('.lock')) {
      locks += 1;
      const stat = fs.statSync(path.join(dir, entry.name), { throwIfNoEntry: false });
      if (stat && now - stat.mtimeMs > LOCK_STALE_MS) staleLocks += 1;
      continue;
    }
    if (!entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    try {
      const state = decodeState(readJson(file));
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      sessions.push({
        key: entry.name.replace(/\.json$/, ''),
        contract: describeContract(state.contract),
        updatedAt: stat ? stat.mtime.toISOString() : null,
        directiveError: state.directiveError || null
      });
    } catch {
      damaged += 1;
    }
  }
  sessions.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  return { total: sessions.length + damaged, damaged, sessions, locks, staleLocks };
}

// The probe is written by the agent extension when the host loads it. Its
// absence means the extension has not run in this data directory yet, which
// the panel reports instead of implying the Guard is active.
function readExtensionProbe(dataDir) {
  const file = path.join(dataDir, 'runtime', 'extension.json');
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      registeredAt: record.registeredAt || null,
      pluginVersion: record.pluginVersion || null,
      commandApi: (record.host && record.host.commandApi) || 'unknown',
      members: Array.isArray(record.host && record.host.members) ? record.host.members : [],
      dataDir: typeof record.dataDir === 'string' ? record.dataDir : null
    };
  } catch {
    return null;
  }
}

function buildDoctorReport(options = {}) {
  const dataDir = dataRoot(options.dataDir);
  const checks = [];
  let exists = false;
  try {
    exists = fs.statSync(dataDir).isDirectory();
  } catch {
    exists = false;
  }
  const record = scanSessions(dataDir);
  const runtime = readRuntime({}, { dataDir });
  const probe = readExtensionProbe(dataDir);
  // The probe sits inside the directory the extension actually guards, so a
  // missing probe here plus one in the plugin's default directory is the real
  // mismatch: this report would read a directory the Guard never writes.
  const fallbackDir = options.fallbackDataDir ? dataRoot(options.fallbackDataDir) : null;
  const elsewhere = probe || !fallbackDir ? null : readExtensionProbe(fallbackDir);
  // `data` carries the numbers the panel needs to write the row in either
  // language; `detail` stays the English sentence used by the text reports.
  checks.push({ id: 'dataDir', ok: exists, detail: dataDir, data: { path: dataDir } });
  checks.push({
    id: 'stateFiles',
    ok: record.damaged === 0,
    detail: `${record.total} file(s), ${record.damaged} damaged${record.unreadable ? ` (${record.unreadable})` : ''}`,
    data: { total: record.total, damaged: record.damaged, unreadable: record.unreadable || null }
  });
  checks.push({
    id: 'runtimeRecords',
    ok: runtime.summary.damagedRecords === 0,
    detail: `${runtime.events.length} event(s), ${runtime.summary.damagedRecords} damaged`,
    data: { events: runtime.events.length, damaged: runtime.summary.damagedRecords }
  });
  checks.push({
    id: 'locks',
    ok: record.staleLocks === 0,
    detail: `${record.locks} lock(s), ${record.staleLocks} older than 10s`,
    data: { count: record.locks, stale: record.staleLocks }
  });
  checks.push({
    id: 'extensionDataDir',
    ok: !elsewhere,
    detail: elsewhere
      ? `the extension registered in ${fallbackDir} while this report reads ${dataDir}`
      : 'this report and the extension share a directory, or the extension has not registered yet',
    data: { elsewhere: Boolean(elsewhere), dataDir, fallbackDir }
  });
  const lastEvent = runtime.events.reduce((latest, event) => (
    !latest || String(event.occurredAt) > latest ? String(event.occurredAt) : latest
  ), null);
  return {
    dataDir,
    exists,
    version: options.version || null,
    sessions: { total: record.total, damaged: record.damaged, list: record.sessions.slice(0, 20) },
    runtime: { events: runtime.events.length, damagedRecords: runtime.summary.damagedRecords, lastEventAt: lastEvent },
    locks: { count: record.locks, stale: record.staleLocks },
    extension: probe,
    checks,
    ok: checks.every((check) => check.ok)
  };
}

function formatDoctorReport(report) {
  return [
    `Stop That Shit doctor (${report.ok ? 'ok' : 'attention'})`,
    `Data directory: ${report.dataDir}${report.exists ? '' : ' (missing)'}`,
    ...report.checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.detail}`)
  ].join('\n');
}

module.exports = { buildDoctorReport, describeContract, formatDoctorReport, scanSessions };
