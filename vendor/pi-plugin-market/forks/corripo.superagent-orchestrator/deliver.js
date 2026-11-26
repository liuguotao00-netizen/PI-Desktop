"use strict";

const { appendMessageInput } = require("./cards.js");

/**
 * Where a worker's result card lands.
 *
 * There is no host API that writes a message into *another* session without the
 * wide `session.update.all` grant, so the channel is chosen at runtime rather
 * than assumed at build time:
 *
 *   1. `session.appendMessage` — a real assistant message in the main session.
 *      Needs `session.update.all` (message-level writes have no `.own` form).
 *   2. `composer.suggest` — one dismissible line above the composer. Needs
 *      `composer.suggest`; the host answers `{ shown: false, reason }` when the
 *      session is not the one on screen.
 *   3. `ui.showToast` — no grant required, always available.
 *
 * A refusal is remembered for the life of the process so a missing grant costs
 * one failed call, not one per turn. The card itself is never lost: it is also
 * stored on the worker record the Workers view reads.
 */

const DEFAULT_ORDER = ["message", "suggest", "toast"];
// Only a missing grant or a missing host API is permanent. `NOT_FOUND` is not:
// the host answers it while a freshly created session is not ready yet, and
// disabling the channel on that would silence every later card in this process.
const DISABLE_CODES = new Set(["PERMISSION_DENIED", "UNSUPPORTED", "CONFIRMATION_REQUIRED"]);
const SUGGEST_TTL_MS = 120_000;

function codeOf(error) {
  return String(error?.code || error?.errorCode || "UNKNOWN");
}

function createDeliverer({ runtime, order = DEFAULT_ORDER, log = () => {} } = {}) {
  const disabled = new Map();

  const strategies = {
    async message(card, target) {
      const result = await runtime.callHost("session.appendMessage", [appendMessageInput(card, target)]);
      return { ok: true, channel: "message", ...(result?.messageId ? { messageId: result.messageId } : {}) };
    },
    async suggest(card, target) {
      const result = await runtime.callHost("composer.suggest", [{
        sessionId: target,
        text: card.oneLine,
        ttlMs: SUGGEST_TTL_MS,
      }]);
      if (!result?.shown) return { ok: false, channel: "suggest", code: "NOT_SHOWN", reason: result?.reason };
      return { ok: true, channel: "suggest" };
    },
    async toast(card) {
      await runtime.callHost("ui.showToast", [card.oneLine, "info"]);
      return { ok: true, channel: "toast" };
    },
  };

  async function deliver(card, { target, order: requested } = {}) {
    const attempts = [];
    const destination = typeof target === "string" ? target.trim() : "";
    // Without a known main session only the session-less channel is safe: the
    // host would refuse a message or a suggestion with an empty sessionId.
    const plan = destination ? (requested || order) : ["toast"];
    for (const name of plan) {
      const strategy = strategies[name];
      if (!strategy) {
        attempts.push({ channel: name, ok: false, code: "UNKNOWN_CHANNEL" });
        continue;
      }
      if (disabled.has(name)) {
        attempts.push({ channel: name, ok: false, skipped: disabled.get(name) });
        continue;
      }
      try {
        const result = await strategy(card, destination);
        attempts.push(result);
        if (result.ok) return { delivered: result.channel, attempts };
      } catch (error) {
        const code = codeOf(error);
        attempts.push({ channel: name, ok: false, code, message: String(error?.message || error).slice(0, 200) });
        if (DISABLE_CODES.has(code)) {
          disabled.set(name, code);
          log("info", `result card channel ${name} disabled: ${code}`);
        }
      }
    }
    return { delivered: null, attempts };
  }

  return {
    deliver,
    disabled: () => Object.fromEntries(disabled),
    order,
  };
}

module.exports = { DEFAULT_ORDER, createDeliverer };
