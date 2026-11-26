'use strict';

// Panel query layer for the plugin's own data directory.
// Every channel is read-only except `sts.label`, which appends one human label.

const os = require('node:os');
const path = require('node:path');
const { readRuntime } = require('../runtime-audit.cjs');
const { recordAnnotation } = require('../runtime-annotations.cjs');
const { buildDoctorReport, scanSessions } = require('./doctor.cjs');

const PLUGIN_ID = 'io.github.techd81.stop-that-shit';
const EVENT_LIMIT = 200;

function fallbackDataDir() {
  return process.env.STS_DESKTOP_DATA
    || path.join(os.homedir(), '.pi-desktop', 'plugins', 'data', PLUGIN_ID);
}

async function resolveDataDir(pi) {
  try {
    const resolver = pi && pi.plugin && pi.plugin.getDataPath;
    if (typeof resolver === 'function') {
      const resolved = await pi.plugin.getDataPath();
      if (typeof resolved === 'string' && resolved.trim()) return resolved.trim();
    }
  } catch {
    // Fall through to the host's own layout.
  }
  return fallbackDataDir();
}

const SORTS = new Map([['asc', 1], ['desc', -1]]);

function sortEvents(events, direction = 'desc') {
  const factor = SORTS.get(direction) || -1;
  return [...events].sort((left, right) => factor * String(left.occurredAt || '').localeCompare(String(right.occurredAt || '')));
}

function createPanelBackend(options = {}) {
  const pi = options.pi;
  // Callers may pin the fallback directory; the panel then compares against it
  // instead of guessing from the environment.
  const fallbackDir = options.fallbackDataDir || fallbackDataDir();
  let dataDirPromise = null;

  function dataDir() {
    if (!dataDirPromise) dataDirPromise = resolveDataDir(pi);
    return dataDirPromise;
  }

  async function overview() {
    const dir = await dataDir();
    const sessions = scanSessions(dir);
    const runtime = readRuntime({}, { dataDir: dir });
    return {
      ok: true,
      dataDir: dir,
      sessions: {
        total: sessions.total,
        damaged: sessions.damaged,
        list: sessions.sessions.slice(0, 25)
      },
      runtime: { summary: runtime.summary, damagedRecords: runtime.summary.damagedRecords },
      locks: { count: sessions.locks, stale: sessions.staleLocks }
    };
  }

  async function events(payload = {}) {
    const dir = await dataDir();
    const query = {};
    if (typeof payload.sessionId === 'string' && payload.sessionId.trim()) query.sessionId = payload.sessionId.trim();
    const runtime = readRuntime(query, { dataDir: dir });
    const ordered = sortEvents(runtime.events, payload.sort)
      .slice(0, Number.isInteger(payload.limit) && payload.limit > 0 ? Math.min(payload.limit, EVENT_LIMIT) : EVENT_LIMIT);
    return {
      ok: true,
      events: ordered,
      summary: runtime.summary,
      damagedRecords: runtime.summary.damagedRecords
    };
  }

  async function explain(payload = {}) {
    const eventId = String(payload.eventId || '').trim();
    if (!/^evt_[0-9a-f-]+$/i.test(eventId)) return { ok: false, code: 'INVALID_EVENT_ID', message: 'Event IDs look like evt_<uuid>.' };
    const dir = await dataDir();
    const runtime = readRuntime({ eventId }, { dataDir: dir });
    if (runtime.events.length === 0) return { ok: false, code: 'NOT_FOUND', message: `No runtime event with id ${eventId}.` };
    return { ok: true, event: runtime.events[0] };
  }

  async function label(payload = {}) {
    const eventId = String(payload.eventId || '').trim();
    const value = String(payload.label || '').trim();
    if (!/^evt_[0-9a-f-]+$/i.test(eventId)) return { ok: false, code: 'INVALID_EVENT_ID', message: 'Event IDs look like evt_<uuid>.' };
    if (!['correct', 'incorrect', 'inconclusive'].includes(value)) {
      return { ok: false, code: 'INVALID_LABEL', message: 'Label must be correct, incorrect, or inconclusive.' };
    }
    const dir = await dataDir();
    try {
      const annotation = recordAnnotation(eventId, value, { dataDir: dir });
      return { ok: Boolean(annotation), eventId, label: value };
    } catch (error) {
      return { ok: false, code: 'LABEL_FAILED', message: error && error.message ? error.message : String(error) };
    }
  }

  async function doctor() {
    const dir = await dataDir();
    // The fallback lets the report notice an extension that registered in the
    // plugin's default directory instead of the one the host handed us.
    return { ok: true, report: buildDoctorReport({ dataDir: dir, fallbackDataDir: fallbackDir }) };
  }

  async function invoke(channel, payload = {}) {
    switch (String(channel || '')) {
      case 'sts.overview': return overview();
      case 'sts.events': return events(payload || {});
      case 'sts.explain': return explain(payload || {});
      case 'sts.label': return label(payload || {});
      case 'sts.doctor': return doctor();
      default:
        return { ok: false, code: 'UNKNOWN_CHANNEL', message: `Unsupported channel: ${channel}` };
    }
  }

  return { invoke, dataDir };
}

module.exports = { PLUGIN_ID, createPanelBackend, fallbackDataDir, resolveDataDir, sortEvents };
