"use strict";

/**
 * Sidecar agent extension (spec 16). CJS so jiti does not need import.meta.
 * Tools: execute(toolCallId, params, signal, onUpdate)
 * before_agent_start may return { systemPrompt } (replaces the whole prompt).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

delete require.cache[require.resolve("./memory-store.js")];
const store = require("./memory-store.js");
const PLUGIN_VERSION = "0.1.7";

function grokEnhanceOwnsPrompt() {
  try {
    return fs.existsSync(
      path.join(os.homedir(), ".pi-desktop", "plugins", "installed", "cn.star.grok-enhance", "manifest.json"),
    );
  } catch {
    return false;
  }
}

let Type;
try {
  ({ Type } = require("typebox"));
} catch {
  Type = null;
}

function stringParam(description, optional) {
  if (Type) {
    const t = Type.String({ description });
    return optional ? Type.Optional(t) : t;
  }
  return { type: "string", description };
}

function buildParameters() {
  if (Type) {
    return Type.Object({
      action: stringParam("add | replace | remove"),
      target: stringParam("user (identity/preferences) or memory (environment/conventions)"),
      content: stringParam("Entry text for add/replace. Declarative fact, not an imperative.", true),
      old_text: stringParam("Unique substring of one existing entry (replace/remove)", true),
    });
  }
  return {
    type: "object",
    properties: {
      action: { type: "string", description: "add | replace | remove" },
      target: {
        type: "string",
        description: "user (identity/preferences) or memory (environment/conventions)",
      },
      content: {
        type: "string",
        description: "Entry text for add/replace. Declarative fact, not an imperative.",
      },
      old_text: {
        type: "string",
        description: "Unique substring of one existing entry (replace/remove)",
      },
    },
    required: ["action", "target"],
  };
}

function textResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify({ pluginVersion: PLUGIN_VERSION, ...payload }, null, 2) }],
    details: {},
  };
}

function currentRoot() {
  return store.defaultRoot();
}

function currentConfig(root) {
  store.ensureDir(root);
  return store.loadConfig(root);
}

function userProfileExtension(pi) {
  const seenToolIds = new Set();

  try {
    const root = currentRoot();
    store.stampBoot(root, PLUGIN_VERSION);
  } catch {
    /* ignore */
  }

  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "Save or update durable facts in the local user profile. action=add|replace|remove. target=user (name, communication style, stable habits) or memory (environment, project conventions, tool quirks). replace/remove: old_text uniquely identifies one entry. No read action — the system prompt already contains the snapshot. Do not store secrets, one-off tasks, or procedures (those belong in skills). Do not use MCP memory/create_entities for those facts. Over-limit writes are rejected; consolidate with replace/remove, then retry add.",
    parameters: buildParameters(),
    async execute(_id, params) {
      try {
        const root = currentRoot();
        const cfg = currentConfig(root);
        const result = store.applyAction(root, cfg, params || {});
        return textResult(result);
      } catch (err) {
        return textResult({ success: false, error: String(err && err.message ? err.message : err) });
      }
    },
  });

  function noteTool(event) {
    const id = String((event && (event.toolCallId || event.id)) || "");
    const name = String((event && (event.toolName || event.name)) || "");
    const key = id || `${name}:${Date.now()}`;
    if (seenToolIds.has(key)) return;
    seenToolIds.add(key);
    try {
      store.bumpToolCount(currentRoot(), currentConfig(currentRoot()), name);
    } catch {
      /* ignore */
    }
  }

  pi.on("tool_call", (event) => {
    noteTool(event);
    return undefined;
  });

  pi.on("tool_execution_end", (event) => {
    noteTool(event);
  });

  pi.on("before_agent_start", async (event) => {
    try {
      seenToolIds.clear();
      if (grokEnhanceOwnsPrompt()) return undefined;
      const root = currentRoot();
      const cfg = currentConfig(root);
      store.stampBoot(root, PLUGIN_VERSION);
      const base = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
      if (store.alreadyInjected(base) && String(base).includes("## Skill learning")) {
        return { systemPrompt: base };
      }
      const block = store.buildFullInjection(root, cfg);
      if (!block) return undefined;
      return { systemPrompt: `${base.replace(/\s+$/, "")}\n\n${block}\n` };
    } catch {
      return undefined;
    }
  });
}

module.exports = userProfileExtension;
module.exports.default = userProfileExtension;
