"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("./memory-store.js");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "user-profile-"));
}

function cfg(extra) {
  return store.clampConfig({ ...store.DEFAULT_CONFIG, ...extra });
}

test("parseEntries splits on section sign and trims", () => {
  const entries = store.parseEntries("# Star\nprefers concise\n§\n  second  \n§\n\n");
  assert.deepEqual(entries, ["# Star\nprefers concise", "second"]);
});

test("add then replace by unique substring", () => {
  const root = tmpRoot();
  const c = cfg();
  const added = store.applyAction(root, c, {
    action: "add",
    target: "user",
    content: "User prefers Codex-style replies that fold thinking into 用时.",
  });
  assert.equal(added.success, true);
  assert.equal(added.current_entries.length, 1);
  const replaced = store.applyAction(root, c, {
    action: "replace",
    target: "user",
    old_text: "Codex-style",
    content: "User prefers a one-line 用时 footer and no recap.",
  });
  assert.equal(replaced.success, true);
  assert.match(replaced.current_entries[0], /one-line/);
  assert.equal(fs.existsSync(path.join(root, "USER.md")), true);
});

test("exact duplicate add is success without writing a second copy", () => {
  const root = tmpRoot();
  const c = cfg();
  const content = "User is 耀星.";
  store.applyAction(root, c, { action: "add", target: "user", content });
  const again = store.applyAction(root, c, { action: "add", target: "user", content: `  ${content}  ` });
  assert.equal(again.success, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.current_entries.length, 1);
});

test("add over the char limit is rejected and the file is unchanged", () => {
  const root = tmpRoot();
  const c = cfg({ userCharLimit: 40 });
  store.applyAction(root, c, { action: "add", target: "user", content: "User prefers short replies." });
  const before = fs.readFileSync(path.join(root, "USER.md"), "utf8");
  const overflow = store.applyAction(root, c, {
    action: "add",
    target: "user",
    content: "User also wants a very long extra preference that will not fit.",
  });
  assert.equal(overflow.success, false);
  assert.match(overflow.error, /exceed/);
  assert.ok(Array.isArray(overflow.current_entries));
  assert.match(overflow.usage, /^\d+\/40$/);
  assert.equal(fs.readFileSync(path.join(root, "USER.md"), "utf8"), before);
});

test("replace that would overflow is rejected", () => {
  const root = tmpRoot();
  const c = cfg({ userCharLimit: 50 });
  store.applyAction(root, c, { action: "add", target: "user", content: "User prefers pnpm." });
  const before = store.readEntries(root, "user");
  const overflow = store.applyAction(root, c, {
    action: "replace",
    target: "user",
    old_text: "pnpm",
    content: "User prefers pnpm, yarn, npm, bun, and a paragraph of extra detail.",
  });
  assert.equal(overflow.success, false);
  assert.deepEqual(store.readEntries(root, "user"), before);
});

test("replace/remove require a unique old_text", () => {
  const root = tmpRoot();
  const c = cfg();
  store.applyAction(root, c, { action: "add", target: "user", content: "User prefers dark mode in VS Code." });
  store.applyAction(root, c, { action: "add", target: "user", content: "User prefers dark mode in the terminal." });
  const multi = store.applyAction(root, c, {
    action: "replace",
    target: "user",
    old_text: "dark mode",
    content: "User prefers light mode.",
  });
  assert.equal(multi.success, false);
  assert.match(multi.error, /2 user entries/);
  const missing = store.applyAction(root, c, {
    action: "remove",
    target: "user",
    old_text: "no-such-fact",
  });
  assert.equal(missing.success, false);
  const removed = store.applyAction(root, c, {
    action: "remove",
    target: "user",
    old_text: "VS Code",
  });
  assert.equal(removed.success, true);
  assert.equal(removed.current_entries.length, 1);
  assert.match(removed.current_entries[0], /terminal/);
});

test("disabled plugin and disabled target refuse writes", () => {
  const root = tmpRoot();
  const off = store.applyAction(root, cfg({ enabled: false }), {
    action: "add",
    target: "user",
    content: "User is 耀星.",
  });
  assert.equal(off.success, false);
  assert.match(off.error, /disabled/);
  assert.equal(fs.existsSync(path.join(root, "USER.md")), false);
  const targetOff = store.applyAction(root, cfg({ userProfileEnabled: false }), {
    action: "add",
    target: "user",
    content: "User is 耀星.",
  });
  assert.equal(targetOff.success, false);
  const mem = store.applyAction(root, cfg({ userProfileEnabled: false }), {
    action: "add",
    target: "memory",
    content: "Workspace plugins live in D:\\\\data\\\\Agent插件.",
  });
  assert.equal(mem.success, true);
  assert.equal(fs.existsSync(path.join(root, "MEMORY.md")), true);
});

test("buildInjection includes both stores, policy, and capacity; enabled=false is empty", () => {
  const root = tmpRoot();
  const c = cfg();
  store.applyAction(root, c, { action: "add", target: "user", content: "User is 耀星." });
  const block = store.buildInjection(root, c);
  assert.match(block, /USER PROFILE \(who the user is\)/);
  assert.match(block, /MEMORY \(agent notes\)/);
  assert.match(block, /耀星/);
  assert.match(block, /\(empty\)/);
  assert.match(block, /Memory policy/);
  assert.equal(store.buildInjection(root, cfg({ enabled: false })), "");
  assert.equal(store.alreadyInjected(block), true);
  assert.equal(store.alreadyInjected("hello"), false);
});

test("user and memory are separate files", () => {
  const root = tmpRoot();
  const c = cfg();
  store.applyAction(root, c, { action: "add", target: "user", content: "User prefers pnpm." });
  store.applyAction(root, c, { action: "add", target: "memory", content: "This machine is Windows 11." });
  assert.deepEqual(store.readEntries(root, "user"), ["User prefers pnpm."]);
  assert.deepEqual(store.readEntries(root, "memory"), ["This machine is Windows 11."]);
});

test("saveConfig then loadConfig round-trips flags", () => {
  const root = tmpRoot();
  store.saveConfig(root, { enabled: false, userCharLimit: 80 });
  const loaded = store.loadConfig(root);
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.userCharLimit, 80);
  assert.equal(loaded.memoryEnabled, true);
});

test("nudge becomes pending every N non-memory tools and injects once", () => {
  const root = tmpRoot();
  const c = cfg({ nudgeInterval: 3 });
  store.applyAction(root, c, { action: "add", target: "user", content: "User is 耀星." });
  store.bumpToolCount(root, c, "Read");
  store.bumpToolCount(root, c, "Read");
  assert.equal(store.loadNudgeState(root).pending, false);
  store.bumpToolCount(root, c, "Bash");
  assert.equal(store.loadNudgeState(root).pending, true);
  store.bumpToolCount(root, c, "memory");
  assert.equal(store.loadNudgeState(root).toolCount, 3);
  const first = store.buildFullInjection(root, c);
  assert.match(first, /memory-nudge: v1/);
  assert.match(first, /create_entities/);
  const second = store.buildFullInjection(root, c);
  assert.equal(second.includes("memory-nudge: v1"), false);
});

test("nudgeInterval 0 never pending", () => {
  const root = tmpRoot();
  const c = cfg({ nudgeInterval: 0 });
  store.bumpToolCount(root, c, "Read");
  store.bumpToolCount(root, c, "Read");
  assert.equal(store.loadNudgeState(root).pending, false);
  assert.equal(store.consumeNudge(root, c), "");
});

test("parseSkillLearningNudge reads templates without require()", () => {
  const src = [
    "const AUTHORING = `",
    "quality bar",
    "`.trim();",
    "const NUDGE = `",
    "## Skill learning",
    "You have a \\`skill_manage\\` tool.",
    "${AUTHORING}",
    "`.trim();",
  ].join("\n");
  const out = store.parseSkillLearningNudge(src);
  assert.match(out, /## Skill learning/);
  assert.match(out, /skill_manage/);
  assert.match(out, /quality bar/);
  assert.equal(out.includes("${AUTHORING}"), false);
});

test("loadSkillLearningNudge prefers prompt.d markdown", () => {
  const home = tmpRoot();
  const dir = path.join(home, ".pi", "agent", "prompt.d");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cn.star.skill-learning.md"), "## Skill learning\nfrom prompt.d\n", "utf8");
  const out = store.loadSkillLearningNudge(home);
  assert.match(out, /from prompt\.d/);
});
