"use strict";

/**
 * USER.md / MEMORY.md store. Sidecar and plugin process both require this file.
 * Writes live under ~/.pi/agent/user-profile/ so uninstalling the plugin
 * does not delete the profile. Do not use ~/.pi/agent/memory/ (pi-mem).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_USER_LIMIT = 1375;
const DEFAULT_MEMORY_LIMIT = 2200;
const MARKER = "USER PROFILE (who the user is)";
const MEMORY_MARKER = "MEMORY (agent notes)";

const DEFAULT_CONFIG = {
  enabled: true,
  userProfileEnabled: true,
  memoryEnabled: true,
  userCharLimit: DEFAULT_USER_LIMIT,
  memoryCharLimit: DEFAULT_MEMORY_LIMIT,
  nudgeInterval: 10,
  memoryScope: "global",
  writeApproval: "notify",
};

const POLICY = [
  "## Memory policy",
  "Save durable identity, communication style, and stable habits to target=user.",
  "Save machine/project conventions and reproducible tool quirks to target=memory.",
  "Skip one-off tasks, session logs, secrets, and reusable procedures (those belong in skills).",
  "Do not save identity or preferences via MCP memory / create_entities / knowledge-graph tools — those are a different store.",
  "Write declarative facts, not imperatives (\"User prefers concise replies\", not \"Always be concise\").",
  "There is no read action — this block is the snapshot. Use memory (add|replace|remove).",
  "If a store is over 80% capacity, replace/remove to consolidate before add. Over-limit writes are rejected, never truncated.",
].join("\n");

function homedir() {
  return os.homedir();
}

function defaultRoot() {
  return path.join(homedir(), ".pi", "agent", "user-profile");
}

function configPath(root) {
  return path.join(root, "config.json");
}

function fileFor(root, target) {
  const name = target === "memory" ? "MEMORY.md" : "USER.md";
  return path.join(root, name);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  try {
    fs.unlinkSync(file);
  } catch {
    // first write
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.copyFileSync(tmp, file);
      fs.unlinkSync(tmp);
    } catch (err2) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err2 || err;
    }
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadConfig(root) {
  return clampConfig(readJson(configPath(root), {}));
}

function saveConfig(root, config) {
  const next = clampConfig({
    ...loadConfig(root),
    ...(config && typeof config === "object" ? config : {}),
  });
  atomicWrite(configPath(root), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function clampConfig(raw) {
  const merged = { ...DEFAULT_CONFIG, ...(raw && typeof raw === "object" ? raw : {}) };
  merged.userCharLimit = positiveInt(merged.userCharLimit, DEFAULT_USER_LIMIT);
  merged.memoryCharLimit = positiveInt(merged.memoryCharLimit, DEFAULT_MEMORY_LIMIT);
  merged.nudgeInterval = Number(merged.nudgeInterval) === 0 ? 0 : positiveInt(merged.nudgeInterval, 10);
  merged.memoryScope = merged.memoryScope === "project" ? "project" : "global";
  merged.writeApproval = merged.writeApproval === "off" ? "off" : "notify";
  merged.enabled = merged.enabled !== false;
  merged.userProfileEnabled = merged.userProfileEnabled !== false;
  merged.memoryEnabled = merged.memoryEnabled !== false;
  return merged;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function charCount(text) {
  return [...String(text || "")].length;
}

function parseEntries(text) {
  const raw = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
  if (!raw.trim()) return [];
  return raw
    .split("§")
    .map((part) => part.replace(/^\s+|\s+$/g, ""))
    .filter(Boolean);
}

function serializeEntries(entries) {
  const parts = (Array.isArray(entries) ? entries : [])
    .map((e) => String(e).replace(/^\s+|\s+$/g, ""))
    .filter(Boolean);
  if (!parts.length) return "";
  return `${parts.join("\n§\n")}\n`;
}

function limitFor(config, target) {
  return target === "memory" ? config.memoryCharLimit : config.userCharLimit;
}

function usageString(used, limit) {
  const pct = limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  return `${pct}% — ${used.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars`;
}

function readEntries(root, target) {
  const file = fileFor(root, target);
  if (!fs.existsSync(file)) return [];
  return parseEntries(fs.readFileSync(file, "utf8"));
}

function writeEntries(root, target, entries) {
  const file = fileFor(root, target);
  const body = serializeEntries(entries);
  if (!body) {
    ensureDir(root);
    atomicWrite(file, "");
    return file;
  }
  atomicWrite(file, body);
  return file;
}

function snapshot(root, target, config) {
  const entries = readEntries(root, target);
  const body = serializeEntries(entries);
  const used = charCount(body);
  const limit = limitFor(config, target);
  return {
    target,
    entries,
    used,
    limit,
    usage: `${used}/${limit}`,
    usageLabel: usageString(used, limit),
    path: fileFor(root, target),
  };
}

function fail(snap, error, extra) {
  return {
    success: false,
    error,
    current_entries: snap.entries,
    usage: snap.usage,
    usageLabel: snap.usageLabel,
    target: snap.target,
    ...extra,
  };
}

function ok(snap, extra) {
  return {
    success: true,
    current_entries: snap.entries,
    usage: snap.usage,
    usageLabel: snap.usageLabel,
    target: snap.target,
    path: snap.path,
    ...extra,
  };
}

function findHits(entries, oldText) {
  const needle = String(oldText || "");
  const hits = [];
  entries.forEach((entry, i) => {
    if (entry.includes(needle)) hits.push(i);
  });
  return hits;
}

function targetEnabled(config, target) {
  if (target === "memory") return config.memoryEnabled;
  return config.userProfileEnabled;
}

function applyAction(root, rawConfig, params) {
  const config = clampConfig(rawConfig || loadConfig(root));
  const action = String(params?.action || "").trim();
  const target = String(params?.target || "").trim();
  const content = params?.content == null ? "" : String(params.content);
  const oldText = params?.old_text == null ? "" : String(params.old_text);

  if (!config.enabled) {
    return { success: false, error: "user-profile plugin is disabled in settings" };
  }
  if (target !== "user" && target !== "memory") {
    return { success: false, error: 'target must be "user" or "memory"' };
  }
  if (!targetEnabled(config, target)) {
    return {
      success: false,
      error: `target=${target} is disabled in settings`,
      target,
    };
  }
  if (!["add", "replace", "remove"].includes(action)) {
    return { success: false, error: 'action must be "add", "replace", or "remove"' };
  }

  ensureDir(root);
  const before = snapshot(root, target, config);
  const entries = before.entries.slice();
  const limit = before.limit;

  if (action === "add") {
    const next = content.replace(/^\s+|\s+$/g, "");
    if (!next) return fail(before, "content is required for add");
    if (entries.some((e) => e === next)) {
      return ok(before, { duplicate: true, message: "no duplicate added" });
    }
    const proposed = serializeEntries(entries.concat([next]));
    const used = charCount(proposed);
    if (used > limit) {
      return fail(
        before,
        `${target} at ${before.usage}. Adding this entry (${charCount(next)} chars) would exceed the limit. Consolidate now: use replace to merge overlapping entries or remove stale ones (see current_entries), then retry this add.`,
        { would_be: `${used}/${limit}` },
      );
    }
    writeEntries(root, target, entries.concat([next]));
    return ok(snapshot(root, target, config), { added: true });
  }

  if (!oldText) {
    return fail(before, "old_text is required for replace/remove and must uniquely identify one entry");
  }
  const hits = findHits(entries, oldText);
  if (hits.length === 0) {
    return fail(before, `old_text did not match any ${target} entry`);
  }
  if (hits.length > 1) {
    return fail(
      before,
      `old_text matched ${hits.length} ${target} entries; use a more specific substring`,
    );
  }
  const idx = hits[0];

  if (action === "remove") {
    entries.splice(idx, 1);
    writeEntries(root, target, entries);
    return ok(snapshot(root, target, config), { removed: true });
  }

  const next = content.replace(/^\s+|\s+$/g, "");
  if (!next) return fail(before, "content is required for replace");
  entries[idx] = next;
  const proposed = serializeEntries(entries);
  const used = charCount(proposed);
  if (used > limit) {
    return fail(
      before,
      `${target} at ${before.usage}. Replacing this entry would be ${used}/${limit}. Shorten the new content or remove another entry first.`,
      { would_be: `${used}/${limit}` },
    );
  }
  writeEntries(root, target, entries);
  return ok(snapshot(root, target, config), { replaced: true });
}

function renderStoreBlock(title, marker, snap, enabled) {
  if (!enabled) return "";
  const body = snap.entries.length ? snap.entries.join("\n§\n") : "(empty)";
  const warn = snap.limit > 0 && snap.used / snap.limit >= 0.8
    ? "\n(over 80% — consolidate with replace/remove before add)"
    : "";
  return [
    "══════════════════════════════════════════════",
    `${title} [${snap.usageLabel}]${warn}`,
    "══════════════════════════════════════════════",
    body,
  ].join("\n");
}

function buildInjection(root, rawConfig) {
  const config = clampConfig(rawConfig || loadConfig(root));
  if (!config.enabled) return "";
  if (!config.userProfileEnabled && !config.memoryEnabled) return "";
  const userSnap = snapshot(root, "user", config);
  const memSnap = snapshot(root, "memory", config);
  const parts = [];
  const userBlock = renderStoreBlock(
    MARKER,
    MARKER,
    userSnap,
    config.userProfileEnabled,
  );
  const memBlock = renderStoreBlock(
    MEMORY_MARKER,
    MEMORY_MARKER,
    memSnap,
    config.memoryEnabled,
  );
  if (userBlock) parts.push(userBlock);
  if (memBlock) parts.push(memBlock);
  if (!parts.length) return "";
  parts.push(POLICY);
  return parts.join("\n\n");
}

function alreadyInjected(systemPrompt) {
  return String(systemPrompt || "").includes(MARKER);
}

function skillLearningFragmentPath(home) {
  return path.join(home || homedir(), ".pi", "agent", "prompt.d", "cn.star.skill-learning.md");
}

function skillLearningNudgePath(home) {
  return path.join(
    home || homedir(),
    ".pi-desktop",
    "plugins",
    "installed",
    "cn.star.skill-learning",
    "src",
    "review-prompt.js",
  );
}

function skillLearningEnabled() {
  try {
    const raw = readJson(path.join(homedir(), ".agents", "skills", ".skill-learning", "config.json"), {});
    return raw.enabled !== false;
  } catch {
    return true;
  }
}

function extractConstTemplate(src, name) {
  const re = new RegExp("const " + name + " = `([\\s\\S]*?)`\\.trim\\(\\)");
  const match = String(src || "").match(re);
  return match ? match[1] : "";
}

function parseSkillLearningNudge(src) {
  const authoring = extractConstTemplate(src, "AUTHORING");
  let nudge = extractConstTemplate(src, "NUDGE");
  if (!nudge) return "";
  nudge = nudge.replace(/\\`/g, "`").replace(/\$\{AUTHORING\}/g, authoring).replace(/^\s+|\s+$/g, "");
  return nudge.includes("## Skill learning") ? nudge : "";
}

function loadSkillLearningNudge(home) {
  if (!skillLearningEnabled()) return "";
  try {
    const md = fs.readFileSync(skillLearningFragmentPath(home), "utf8").replace(/^\s+|\s+$/g, "");
    if (md.includes("## Skill learning")) return md;
  } catch {
    /* missing prompt.d fragment */
  }
  try {
    const src = fs.readFileSync(skillLearningNudgePath(home), "utf8");
    return parseSkillLearningNudge(src);
  } catch {
    return "";
  }
}

function stampBoot(root, version) {
  try {
    atomicWrite(path.join(root, "_boot.txt"), `${version} ${new Date().toISOString()}\n`);
  } catch {
    /* ignore */
  }
}

const NUDGE_MARKER = "memory-nudge: v1";

const NUDGE_LINE = [
  NUDGE_MARKER,
  "If the last few tool calls produced a durable fact, call the memory tool (target=user for identity/preferences, target=memory for environment/conventions).",
  "Do not write those facts with MCP memory, create_entities, or other knowledge-graph tools.",
  "Skip one-offs, secrets, and procedures (skills).",
].join("\n");

function nudgeStatePath(root) {
  return path.join(root, "nudge-state.json");
}

function loadNudgeState(root) {
  const raw = readJson(nudgeStatePath(root), {});
  return {
    toolCount: Number.isFinite(Number(raw.toolCount)) ? Math.max(0, Math.floor(Number(raw.toolCount))) : 0,
    pending: raw.pending === true,
  };
}

function saveNudgeState(root, state) {
  ensureDir(root);
  atomicWrite(nudgeStatePath(root), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function bumpToolCount(root, rawConfig, toolName) {
  const config = clampConfig(rawConfig || loadConfig(root));
  if (!config.enabled || !config.nudgeInterval) return loadNudgeState(root);
  if (String(toolName || "").toLowerCase() === "memory") return loadNudgeState(root);
  const state = loadNudgeState(root);
  state.toolCount += 1;
  if (state.toolCount % config.nudgeInterval === 0) {
    state.pending = true;
    try {
      atomicWrite(path.join(root, "nudge.md"), `${NUDGE_LINE}\n`);
    } catch {
      /* ignore */
    }
  }
  return saveNudgeState(root, state);
}

function consumeNudge(root, rawConfig) {
  const config = clampConfig(rawConfig || loadConfig(root));
  const state = loadNudgeState(root);
  if (!config.enabled || !config.nudgeInterval || !state.pending) return "";
  state.pending = false;
  saveNudgeState(root, state);
  try {
    fs.unlinkSync(path.join(root, "nudge.md"));
  } catch {
    /* missing */
  }
  return NUDGE_LINE;
}

function buildFullInjection(root, rawConfig) {
  const own = buildInjection(root, rawConfig);
  const extra = loadSkillLearningNudge();
  const nudge = consumeNudge(root, rawConfig);
  return [own, extra, nudge].filter(Boolean).join("\n\n");
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_USER_LIMIT,
  DEFAULT_MEMORY_LIMIT,
  MARKER,
  MEMORY_MARKER,
  POLICY,
  homedir,
  defaultRoot,
  configPath,
  fileFor,
  ensureDir,
  atomicWrite,
  loadConfig,
  saveConfig,
  clampConfig,
  charCount,
  parseEntries,
  serializeEntries,
  readEntries,
  writeEntries,
  snapshot,
  applyAction,
  buildInjection,
  alreadyInjected,
  loadSkillLearningNudge,
  parseSkillLearningNudge,
  stampBoot,
  NUDGE_MARKER,
  NUDGE_LINE,
  bumpToolCount,
  consumeNudge,
  loadNudgeState,
  buildFullInjection,
};
