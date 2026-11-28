"use strict";

const MAX_WORKERS = 128;
const MAX_CARDED_TURNS = 8;
const MAX_RESULT_SUMMARY_CHARS = 2_000;
const MAX_ACCEPTANCES = 256;
const MAX_ACCEPTANCE_NOTE_CHARS = 4_096;
// `waiting_permission` is a real collaboration status: the host reports it while
// a worker has pending tool confirmations, and it is not terminal.
const STATUSES = new Set([
  "queued", "running", "waiting_permission", "completed", "failed",
  "cancelled", "interrupted", "idle", "unknown",
]);

function bounded(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function timestamp(value) {
  const raw = bounded(value, 64);
  if (!raw) return "";
  return Number.isNaN(Date.parse(raw)) ? "" : raw;
}

function status(value) {
  const raw = bounded(value, 32).toLowerCase();
  return STATUSES.has(raw) ? raw : "unknown";
}

function owners(value) {
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((id) => bounded(id, 256)).filter(Boolean))].slice(-16);
}

/**
 * One worker record. Everything here is a UI reference: the host's collaboration
 * ledger stays the authority for execution state, and a cached row only ever
 * describes what the plugin last observed.
 */
function worker(value) {
  if (!value || typeof value !== "object") return null;
  const sessionId = bounded(value.sessionId || value.workerSessionId, 256);
  if (!sessionId) return null;
  const now = new Date().toISOString();
  const carded = Array.isArray(value.cardedTurns)
    ? [...new Set(value.cardedTurns.map((turn) => bounded(turn, 256)).filter(Boolean))].slice(-MAX_CARDED_TURNS)
    : [];
  const createdAt = timestamp(value.createdAt) || now;
  const lastActivityAt = timestamp(value.lastActivityAt) || timestamp(value.updatedAt) || createdAt;
  return {
    sessionId,
    title: bounded(value.title, 160) || sessionId,
    referencedBy: owners(value.referencedBy ?? value.parentSessionId),
    projectPath: bounded(value.projectPath, 4_096),
    status: status(value.status),
    createdAt,
    updatedAt: timestamp(value.updatedAt) || lastActivityAt,
    lastActivityAt,
    lastMessageId: bounded(value.lastMessageId, 256),
    lastTurnId: bounded(value.lastTurnId, 256),
    lastResult: bounded(value.lastResult, MAX_RESULT_SUMMARY_CHARS),
    cardedTurns: carded,
    cardChannel: bounded(value.cardChannel, 32),
    // The worker's own status contract. Persisted so the Workers view and the
    // `workers` action can tell "needs a decision" from "done" without
    // re-parsing a possibly truncated summary.
    workerState: bounded(value.workerState, 16),
    humanAction: bounded(value.humanAction, 300),
  };
}

function acceptance(value) {
  if (!value || typeof value !== "object") return null;
  const sessionId = bounded(value.sessionId, 256);
  const messageId = bounded(value.messageId, 256);
  const acceptedBySessionId = bounded(value.acceptedBySessionId, 256);
  if (!sessionId || !messageId || !acceptedBySessionId) return null;
  return {
    sessionId,
    messageId,
    acceptedBySessionId,
    acceptedAt: bounded(value.acceptedAt, 64) || new Date().toISOString(),
    ...(value.note ? { note: bounded(value.note, MAX_ACCEPTANCE_NOTE_CHARS) } : {}),
  };
}

const SETTINGS_VERSION = 4;

/** Worker references and review notes are UI history, never session authorization. */
async function createWorkerStore(api = pi.plugin) {
  const settings = (await api.getSettings()) || {};
  let workers = new Map();
  const loaded = settings.version >= 3 ? settings.sessions ?? settings.workers : settings.workers;
  for (const raw of Array.isArray(loaded) ? loaded : []) {
    const entry = worker(raw);
    if (entry) workers.set(entry.sessionId, entry);
  }
  workers = new Map([...workers].slice(-MAX_WORKERS));
  let acceptances = (Array.isArray(settings.acceptances) ? settings.acceptances : [])
    .map(acceptance).filter(Boolean).slice(-MAX_ACCEPTANCES);
  let writes = Promise.resolve();

  function payload(nextWorkers, nextAcceptances) {
    return {
      version: SETTINGS_VERSION,
      sessions: [...nextWorkers.values()],
      acceptances: nextAcceptances,
      // Retire stale 0.3 execution snapshots without discarding their Session IDs.
      workers: [],
    };
  }

  function change(mutate) {
    const operation = writes.catch(() => undefined).then(async () => {
      const draft = {
        workers: new Map(workers),
        acceptances: [...acceptances],
      };
      mutate(draft);
      draft.workers = new Map([...draft.workers].slice(-MAX_WORKERS));
      draft.acceptances = draft.acceptances.slice(-MAX_ACCEPTANCES);
      await api.setSettings(payload(draft.workers, draft.acceptances));
      workers = draft.workers;
      acceptances = draft.acceptances;
    });
    writes = operation;
    return operation;
  }

  function merge(draft, sessionId, owner, title, patch) {
    const previous = draft.workers.get(sessionId);
    const now = new Date().toISOString();
    const next = worker({
      ...previous,
      ...(patch && typeof patch === "object" ? patch : {}),
      sessionId,
      title: title || patch?.title || previous?.title || sessionId,
      referencedBy: [...(previous?.referencedBy || []), ...(owner ? [owner] : [])],
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      lastActivityAt: patch?.lastActivityAt || previous?.lastActivityAt || now,
      cardedTurns: patch?.cardedTurns || previous?.cardedTurns || [],
    });
    draft.workers.delete(sessionId);
    draft.workers.set(sessionId, next);
    return next;
  }

  if (settings.version !== SETTINGS_VERSION) await api.setSettings(payload(workers, acceptances));

  return {
    list(owner, limit = MAX_WORKERS) {
      return [...workers.values()].reverse()
        .filter((entry) => !owner || entry.referencedBy.includes(owner))
        .slice(0, limit)
        .map((entry) => ({ ...entry, referencedBy: [...entry.referencedBy], cardedTurns: [...entry.cardedTurns] }));
    },
    get(sessionId) {
      const entry = workers.get(bounded(sessionId, 256));
      return entry ? { ...entry, referencedBy: [...entry.referencedBy], cardedTurns: [...entry.cardedTurns] } : undefined;
    },
    size() {
      return workers.size;
    },
    remember(sessionId, owner, title, patch) {
      return change((draft) => {
        merge(draft, sessionId, owner, title, patch);
      });
    },
    update(sessionId, patch) {
      const id = bounded(sessionId, 256);
      if (!workers.has(id)) return Promise.resolve(undefined);
      return change((draft) => {
        merge(draft, id, undefined, undefined, patch);
      });
    },
    markCarded(sessionId, turnId, channel) {
      const id = bounded(sessionId, 256);
      const turn = bounded(turnId, 256);
      if (!workers.has(id) || !turn) return Promise.resolve(undefined);
      return change((draft) => {
        const previous = draft.workers.get(id);
        const cardedTurns = [...new Set([...(previous.cardedTurns || []), turn])].slice(-MAX_CARDED_TURNS);
        merge(draft, id, undefined, undefined, { cardedTurns, cardChannel: channel });
      });
    },
    accept(entries) {
      return change((draft) => {
        for (const raw of entries) {
          const entry = acceptance(raw);
          if (!entry) throw new Error("Invalid message acceptance");
          draft.acceptances = draft.acceptances.filter((item) =>
            item.messageId !== entry.messageId ||
            item.acceptedBySessionId !== entry.acceptedBySessionId);
          draft.acceptances.push(entry);
        }
      });
    },
    accepted(sessionId, messageId, owner) {
      const entry = acceptances.find((item) => item.sessionId === sessionId &&
        item.messageId === messageId && item.acceptedBySessionId === owner);
      return entry ? { ...entry } : undefined;
    },
    flush: () => writes,
  };
}

module.exports = {
  MAX_ACCEPTANCE_NOTE_CHARS,
  MAX_CARDED_TURNS,
  MAX_RESULT_SUMMARY_CHARS,
  MAX_WORKERS,
  SETTINGS_VERSION,
  createWorkerStore,
};
