"use strict";

const manifest = require("./manifest.json");
const { MAX_WORKERS, createWorkerStore } = require("./state.js");
const { SESSION_OPEN, createRuntime } = require("./runtime.js");
const { createActions } = require("./actions.js");
const { createDeliverer } = require("./deliver.js");
const { createWatcher } = require("./watcher.js");
const { workerRows } = require("./cards.js");

const TOOL_NAME = "SessionTask";
// A view refresh walks every cached row, but all reads share one deadline so a
// 128-row list still answers inside the host's 30 s bridge call. Rows past the
// deadline keep their cached value instead of vanishing from the list.
const VIEW_REFRESH_BUDGET_MS = 20_000;
let current;
// The plugin host process exposes no logger, so diagnostics go to its stdout;
// nothing here ever carries a transcript, a credential or a task body.
function log(level, message) {
  try {
    const line = `[superagent-orchestrator] ${String(message)}`;
    if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    // Logging must never be the reason a turn fails.
  }
}

function rowsOf(store) {
  return workerRows(store.list(undefined, MAX_WORKERS));
}

async function onLoad() {
  const store = await createWorkerStore(pi.plugin);
  const runtime = createRuntime(store, pi);
  const actions = createActions(runtime);
  const deliverer = createDeliverer({ runtime, log });
  const watcher = createWatcher({ runtime, store, deliverer, events: pi.events, log });
  const active = { store, runtime, actions, deliverer, watcher };
  try {
    await pi.agent.registerTool({ ...manifest.contributes.agentTools[0], execute: actions.execute });
    watcher.start();
    current = active;
  } catch (error) {
    watcher.stop();
    runtime.dispose();
    await Promise.allSettled([pi.agent.unregisterTool(TOOL_NAME)]);
    throw error;
  }
}

async function onUnload() {
  const active = current;
  current = undefined;
  active?.watcher.stop();
  active?.runtime.dispose();
  await Promise.allSettled([pi.agent.unregisterTool(TOOL_NAME)]);
  // A failed history write must not make unloading throw.
  if (active) {
    try {
      await active.store.flush();
    } catch {
      // Best effort: rows are UI history, not execution state.
    }
  }
}

/**
 * The Workers view talks to the host through its own channels; everything else
 * a view sends is refused, so the page can only list workers, refresh their
 * live status, and open one.
 */
async function onPanelInvoke(channel, payload) {
  const active = current;
  if (!active) throw Object.assign(new Error("plugin is not loaded"), { code: "UNAVAILABLE" });
  switch (channel) {
    case "workers.list":
      return {
        workers: rowsOf(active.store),
        cached: true,
        cardChannels: active.deliverer.disabled(),
        cardOrder: active.deliverer.order,
      };
    case "workers.refresh": {
      // Refresh every cached row: a list that silently dropped its tail on 刷新
      // would be worse than a slow one.
      const entries = active.store.list(undefined, MAX_WORKERS);
      try {
        const workers = await active.actions.refreshWorkers(entries, {
          deadline: Date.now() + VIEW_REFRESH_BUDGET_MS,
        });
        return {
          workers,
          cached: false,
          live: true,
          refreshedAt: new Date().toISOString(),
          cardChannels: active.deliverer.disabled(),
        };
      } catch (error) {
        return {
          workers: workerRows(entries),
          cached: true,
          live: false,
          error: String(error?.message || error).slice(0, 200),
        };
      }
    }
    case "workers.open": {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
      if (!sessionId) throw Object.assign(new Error("sessionId is required"), { code: "INVALID_ARGUMENT" });
      await active.runtime.invokeOperation(SESSION_OPEN, [sessionId], { read: false });
      return { ok: true, sessionId };
    }
    default:
      throw Object.assign(new Error(`unsupported channel: ${String(channel)}`), { code: "UNSUPPORTED" });
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
