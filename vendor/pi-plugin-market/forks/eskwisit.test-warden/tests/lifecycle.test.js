"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setup, ROOT } = require("./helpers");

const target = (home, name) => path.join(home, ".agents", "subagents", name);

test("onLoad installs the writer agent; onUnload removes it unless edited", async () => {
  const s = await setup();
  const file = target(s.dirs.home, "test-warden-writer.md");
  assert.equal(fs.readFileSync(file, "utf8"), fs.readFileSync(path.join(ROOT, "subagents/test-warden-writer.md"), "utf8"));
  const status = await s.pi.call("warden_profile", {});
  assert.match(status.agent, /installed/);
  await s.done();
  assert.equal(fs.existsSync(file), false);
});

test("an edited agent survives unload; an orphaned old agent with the marker is removed", async () => {
  const s = await setup();
  const file = target(s.dirs.home, "test-warden-writer.md");
  fs.writeFileSync(file, "my edits");
  const orphan = target(s.dirs.home, "test-warden-old.md");
  fs.writeFileSync(orphan, `old\n${s.t.MARKER}\n`);
  const foreign = target(s.dirs.home, "test-warden-mine.md");
  fs.writeFileSync(foreign, "a user agent without the marker");
  await s.main.onUnload();
  assert.equal(fs.readFileSync(file, "utf8"), "my edits");
  const changed = s.t.installAgents();
  assert.deepEqual(changed.sort(), ["-test-warden-old.md", "test-warden-writer.md"]);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(foreign), true);
  await s.done();
});

test("the writer agent declares the marker, its tools and strict JSON output", () => {
  const body = fs.readFileSync(path.join(ROOT, "subagents/test-warden-writer.md"), "utf8");
  assert.match(body, /^---\nname: test-warden-writer\n/);
  assert.match(body, /Use only from the test-warden skill\./);
  assert.match(body, /tools: \[Read, Glob, Grep, Edit, Write, Bash\]/);
  assert.match(body, /"files_written"/);
});

test("the skill has front matter within the host limits", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills/test-warden.md"), "utf8");
  const m = skill.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
  assert.ok(m);
  assert.ok(m[2].length <= 240, `description is ${m[2].length} chars`);
  for (const tool of ["warden_profile", "warden_check", "warden_gate", "warden_lessons", "test-warden-writer"]) assert.match(skill, new RegExp(tool));
});
