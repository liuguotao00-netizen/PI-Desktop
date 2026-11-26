var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// pi-context-guard/src/core.cjs
var require_core = __commonJS({
  "pi-context-guard/src/core.cjs"(exports, module) {
    "use strict";
    var crypto = __require("node:crypto");
    var DEFAULTS = Object.freeze({ enabled: true, percentThreshold: 70, usedTokensThreshold: 16e4, foldEnabled: true, foldAtRatio: 0.5, foldStepTokens: 16e3, keepRecentMessages: 12, keepRecentToolResults: 6, minFoldChars: 2e3, cooldownSeconds: 180, maxArchiveBytes: 16 * 1024 * 1024 });
    function config(raw = {}) {
      const c = { ...DEFAULTS };
      for (const k of ["enabled", "foldEnabled"]) if (typeof raw[k] === "boolean") c[k] = raw[k];
      const bounds = { percentThreshold: [10, 90], usedTokensThreshold: [16e3, 1e6], foldAtRatio: [0.25, 0.9], foldStepTokens: [4e3, 64e3], keepRecentMessages: [6, 100], keepRecentToolResults: [2, 50], minFoldChars: [500, 1e5], cooldownSeconds: [30, 3600], maxArchiveBytes: [1048576, 33554432] };
      for (const [k, [lo, hi]] of Object.entries(bounds)) if (Number.isFinite(raw[k]) && raw[k] >= lo && raw[k] <= hi) c[k] = raw[k];
      return c;
    }
    var hash = (v) => crypto.createHash("sha256").update(v).digest("hex");
    function threshold(c, window) {
      return Number.isFinite(window) && window > 0 ? Math.floor(Math.min(c.usedTokensThreshold, window * c.percentThreshold / 100)) : null;
    }
    function textSize(content) {
      return Array.isArray(content) ? content.reduce((n, b) => n + (b.type === "text" ? String(b.text || "").length : b.type === "thinking" ? String(b.thinking || "").length : b.type === "image" ? String(b.data || "").length : 0), 0) : typeof content === "string" ? content.length : 0;
    }
    function refFor(kind, id, content) {
      return hash(JSON.stringify([kind, id, content])).slice(0, 32);
    }
    function signed(b) {
      return !!(b.thinkingSignature || b.signature || b.encrypted_content) || b.type === "redactedThinking";
    }
    function createPolicy(c, store) {
      let seen = /* @__PURE__ */ new Set(), folded = /* @__PURE__ */ new Map(), lastBatch = 0, pending = false, lastCompact = 0, blocked = false, lastStats = {};
      function project(messages, usage, now = Date.now()) {
        if (!c.enabled || !c.foldEnabled) return messages;
        const limit = threshold(c, usage?.contextWindow), tokens = usage?.tokens;
        const keys = [];
        const candidates = [];
        let toolCount = 0;
        for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "toolResult") toolCount++;
        let toolsRemaining = toolCount;
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i], old = i < messages.length - c.keepRecentMessages;
          if (m.role === "toolResult") {
            const key = refFor("tool", m.toolCallId, m.content);
            keys.push(key);
            const eligible = old && toolsRemaining > c.keepRecentToolResults && m.toolName !== "context_guard_recall" && !m.isError && textSize(m.content) >= c.minFoldChars;
            if (eligible && seen.has(key) && !folded.has(key)) candidates.push({ key, index: i, kind: "tool", id: m.toolCallId, content: m.content });
            toolsRemaining--;
          } else if (m.role === "assistant" && Array.isArray(m.content)) {
            for (let j = 0; j < m.content.length; j++) {
              const b = m.content[j];
              if (b.type !== "thinking" || signed(b)) continue;
              const key = refFor("thinking", m.timestamp + ":" + j, b);
              keys.push(key);
              if (old && seen.has(key) && !folded.has(key) && textSize([b]) >= c.minFoldChars) candidates.push({ key, index: i, block: j, kind: "thinking", content: b });
            }
          }
        }
        if (Number.isFinite(tokens) && limit && tokens >= limit * c.foldAtRatio && (!lastBatch || tokens >= lastBatch + c.foldStepTokens)) {
          let count = 0;
          for (const item of candidates) {
            try {
              if (store.put(item.key, { version: 1, kind: item.kind, content: item.content }) !== false) {
                folded.set(item.key, { kind: item.kind });
                count++;
              }
            } catch {
            }
          }
          if (count) lastBatch = tokens;
        }
        const out = messages.map((m) => {
          if (m.role === "toolResult") {
            const key = refFor("tool", m.toolCallId, m.content);
            if (folded.has(key)) return { ...m, content: [{ type: "text", text: `[Archived tool output ${key}; tool=${m.toolName || "unknown"}. Original history preserved. Use context_guard_recall(ref="${key}", offset=0) for evidence; do not infer its contents.]` }], details: void 0 };
          } else if (m.role === "assistant" && Array.isArray(m.content)) {
            let changed = false;
            const content = m.content.map((b, j) => {
              if (b.type !== "thinking" || signed(b)) return b;
              const key = refFor("thinking", m.timestamp + ":" + j, b);
              if (!folded.has(key)) return b;
              changed = true;
              return { type: "text", text: `[Older unsigned reasoning archived: ${key}; recall with context_guard_recall if required.]` };
            });
            if (changed) return { ...m, content };
          }
          return m;
        });
        seen = new Set(keys);
        const active = new Set(keys);
        for (const key of folded.keys()) if (!active.has(key)) folded.delete(key);
        lastStats = { folded: folded.size, estimatedCharsRemoved: Math.max(0, messages.reduce((n, m) => n + textSize(m.content), 0) - out.reduce((n, m) => n + textSize(m.content), 0)), lastBatchTokens: lastBatch };
        return out;
      }
      function shouldCompact(usage, now = Date.now()) {
        const t = threshold(c, usage?.contextWindow);
        if (!c.enabled || !t || !Number.isFinite(usage?.tokens) || usage.tokens < t || usage.tokens >= usage.contextWindow * 0.9 || pending || blocked || now - lastCompact < c.cooldownSeconds * 1e3) return false;
        pending = true;
        lastCompact = now;
        return true;
      }
      function completed(ok) {
        pending = false;
        blocked = !ok;
        lastBatch = 0;
        seen.clear();
        folded.clear();
      }
      return { project, shouldCompact, completed, clearFailure: () => {
        blocked = false;
        pending = false;
      }, stats: () => ({ ...lastStats, pending, blocked, thresholdConfig: { percent: c.percentThreshold, tokens: c.usedTokensThreshold } }) };
    }
    module.exports = { DEFAULTS, config, threshold, hash, refFor, textSize, createPolicy };
  }
});

// pi-context-guard/src/extension.js
var import_core = __toESM(require_core());
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
function extension_default(pi) {
  const root = process.env.PI_CONTEXT_GUARD_DIR || join(homedir(), ".pi-desktop", "plugin-data", "local.context-guard");
  mkdirSync(root, { recursive: true, mode: 448 });
  chmodSync(root, 448);
  const settings = join(root, "settings.json");
  if (!existsSync(settings)) writeFileSync(settings, JSON.stringify(import_core.default.DEFAULTS, null, 2) + "\n", { mode: 384 });
  let c = import_core.default.config(), policy, session = "", archive = "";
  function init(ctx) {
    const id = ctx.sessionManager.getSessionId();
    if (!id) throw new Error("Session identity unavailable; context guard disabled.");
    if (session === id && policy) return;
    session = id;
    try {
      c = import_core.default.config(JSON.parse(readFileSync(settings, "utf8")));
    } catch {
      c = import_core.default.config({ enabled: false });
    }
    archive = join(root, "archive", import_core.default.hash(id));
    mkdirSync(archive, { recursive: true, mode: 448 });
    policy = import_core.default.createPolicy(c, { put(ref, record) {
      const dest = join(archive, ref + ".json");
      if (existsSync(dest)) return true;
      const bytes = JSON.stringify(record);
      if (Buffer.byteLength(bytes) > c.maxArchiveBytes) return false;
      const tmp = dest + "." + process.pid + ".tmp";
      writeFileSync(tmp, bytes, { mode: 384, flag: "wx" });
      renameSync(tmp, dest);
      return true;
    } });
  }
  const check = (_event, ctx) => {
    init(ctx);
    if (policy.shouldCompact(ctx.getContextUsage())) ctx.compact();
  };
  pi.on("session_start", (_e, ctx) => init(ctx));
  pi.on("before_agent_start", check);
  pi.on("agent_settled", check);
  pi.on("turn_end", check);
  pi.on("session_compact", () => policy?.completed(true));
  pi.on("session_compact_failed", () => policy?.completed(false));
  pi.on("context", (event, ctx) => {
    init(ctx);
    return { messages: policy.project(event.messages, ctx.getContextUsage()) };
  });
  pi.registerCommand("context-guard", { description: "\u4E0A\u4E0B\u6587\u7BA1\u5BB6\uFF1Astatus / on / off / retry / reload", handler: async (args, ctx) => {
    init(ctx);
    const action = String(args || "status").trim();
    if (action === "on" || action === "off") {
      c.enabled = action === "on";
      writeFileSync(settings, JSON.stringify(c, null, 2) + "\n", { mode: 384 });
      session = "";
      init(ctx);
    }
    if (action === "reload") {
      session = "";
      init(ctx);
    }
    if (action === "retry") policy.clearFailure();
    ctx.ui.notify(JSON.stringify({ enabled: c.enabled, ...policy.stats(), settings }), "info");
  } });
  pi.registerTool({
    name: "context_guard_recall",
    label: "\u627E\u56DE\u5DF2\u6298\u53E0\u539F\u6587",
    description: "Retrieve archived evidence from THIS session. Use the exact ref printed by an archived output marker. Returns a bounded text page, never invent missing evidence. Images are described; re-read their source with the image tool if needed.",
    parameters: Type.Object({ ref: Type.String({ pattern: "^[a-f0-9]{32}$" }), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12e3 })) }),
    async execute(_id, args, _signal, _update, ctx) {
      init(ctx);
      if (!/^[a-f0-9]{32}$/.test(args.ref)) throw new Error("Invalid archive ref");
      const path = join(archive, args.ref + ".json");
      if (!existsSync(path)) throw new Error("Archive not found in this session. Do not infer contents.");
      if (statSync(path).size > c.maxArchiveBytes) throw new Error("Archive exceeds safe read limit");
      const record = JSON.parse(readFileSync(path, "utf8"));
      const blocks = Array.isArray(record.content) ? record.content : [record.content];
      const text = blocks.map((b) => b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : b.type === "image" ? `[Image ${b.mimeType}; use original image reader to inspect pixels.]` : "[Non-text block retained in original history]").join("\n");
      const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0, limit = Math.min(12e3, Math.max(1, args.limit || 8e3));
      return { content: [{ type: "text", text: JSON.stringify({ ref: args.ref, offset, totalChars: text.length, nextOffset: offset + limit < text.length ? offset + limit : null, text: text.slice(offset, offset + limit) }) }], details: { ref: args.ref } };
    }
  });
}
export {
  extension_default as default
};
