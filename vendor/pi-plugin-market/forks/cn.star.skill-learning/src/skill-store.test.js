"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("./skill-store.js");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "learned-"));
}

const SAMPLE = `---
name: deploy-staging
description: Deploy the staging app with the checked command sequence.
---

# Deploy staging

Deploy the staging app the way this repo actually ships. Do not use this for production deploys or for apps that are not this workspace.

## When to Use

- User asks to deploy staging, ship to staging, or rerun the staging pipeline.
- A previous staging deploy failed and you need the known-good command sequence.

Don't use for: production, one-off file edits, or guessing a host that was not in the session.

## Procedure

1. Confirm the workspace is the app repo (look for Makefile / docker-compose.staging.yml).
2. Use \`bash\` to run \`make deploy-staging\`.
3. If that target is missing, run \`bash scripts/deploy.sh staging\`.
4. Wait for the command to print a URL or "deployed". Do not assume success from exit 0 alone if the script always exits 0.

## Pitfalls

- A green CI badge is not a staging deploy. Staging is the make/script above.
- Do not reuse production kube context. The staging kubeconfig is \`~/.kube/staging\`.

## Verification

The command output contains a staging URL, and curling that URL returns HTTP 200.
`;

test("create then patch a learned skill", () => {
  const root = tmpRoot();
  const created = store.createSkill(root, { name: "deploy-staging", content: SAMPLE, createdBy: "agent" });
  assert.equal(created.ok, true);
  assert.ok(fs.existsSync(created.path));
  assert.match(fs.readFileSync(created.path, "utf8"), /tags:\s*\[.*"自习"/);
  const patched = store.patchSkill(root, {
    name: "deploy-staging",
    oldString: "make deploy-staging",
    newString: "scripts/deploy.sh staging",
  });
  assert.equal(patched.ok, true);
  const body = fs.readFileSync(created.path, "utf8");
  assert.match(body, /scripts\/deploy\.sh staging/);
});

test("refuses names outside learned class-level shape", () => {
  const root = tmpRoot();
  assert.throws(() => store.createSkill(root, { name: "Fix Issue", content: SAMPLE }), /invalid skill name/);
  assert.throws(() => store.createSkill(root, { name: "../etc", content: SAMPLE }), /invalid skill name/);
});

test("refuses duplicate create", () => {
  const root = tmpRoot();
  store.createSkill(root, { name: "deploy-staging", content: SAMPLE });
  assert.throws(() => store.createSkill(root, { name: "deploy-staging", content: SAMPLE }), /already exists/);
});

test("patch requires unique old_string", () => {
  const root = tmpRoot();
  store.createSkill(root, { name: "deploy-staging", content: SAMPLE });
  assert.throws(
    () => store.patchSkill(root, { name: "deploy-staging", oldString: "not-in-file", newString: "x" }),
    /not found/,
  );
});

test("write_file only allows support dirs", () => {
  const root = tmpRoot();
  store.createSkill(root, { name: "deploy-staging", content: SAMPLE });
  assert.throws(
    () => store.writeSupportFile(root, { name: "deploy-staging", filePath: "../secret.md", content: "no" }),
    /file_path/,
  );
  const w = store.writeSupportFile(root, {
    name: "deploy-staging",
    filePath: "references/env.md",
    content: "STAGING_HOST=example",
  });
  assert.equal(w.ok, true);
  assert.ok(fs.existsSync(w.path));
});

test("delete archives instead of unlinking", () => {
  const root = tmpRoot();
  store.createSkill(root, { name: "deploy-staging", content: SAMPLE });
  const archived = store.archiveSkill(root, "deploy-staging");
  assert.ok(fs.existsSync(archived.archived));
  assert.equal(fs.existsSync(path.join(root, "deploy-staging")), false);
  const restored = store.restoreSkill(root, "deploy-staging");
  assert.equal(restored.ok, true);
  assert.ok(fs.existsSync(store.readSkill && path.join(root, "deploy-staging", "SKILL.md")));
});

test("applyOps continues after a failed op", () => {
  const root = tmpRoot();
  const results = store.applyOps(root, [
    { action: "patch", name: "missing", old_string: "a", new_string: "b" },
    { action: "create", name: "deploy-staging", content: SAMPLE },
  ]);
  assert.ok(results[0].error.includes("not found") || results[0].error.includes("not managed"));
  assert.equal(results[1].result.ok, true);
});

test("packMessages respects budget and newest-first", () => {
  const messages = [];
  for (let i = 0; i < 50; i += 1) {
    messages.push({ role: "user", content: `msg-${i}-${"x".repeat(200)}` });
  }
  const packed = store.packMessages(messages, 5000);
  assert.ok(packed.truncated);
  assert.ok(packed.messages.length < 50);
  assert.match(packed.messages[packed.messages.length - 1].content, /msg-49/);
});

test("refuses to patch a skill we did not create", () => {
  const root = tmpRoot();
  const foreign = path.join(root, "user-owned", "SKILL.md");
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, SAMPLE);
  assert.throws(
    () => store.patchSkill(root, { name: "user-owned", oldString: "Deploy staging", newString: "x" }),
    /not managed/,
  );
});

test("rejects a thin create without required sections", () => {
  const root = tmpRoot();
  const thin = `---
name: thin-skill
description: Too short to be a real skill.
---

# Thin

## Procedure
1. Do the thing.
`;
  assert.throws(() => store.createSkill(root, { name: "thin-skill", content: thin }), /too thin/);
});

test("migrates nested learned/ into the Skills UI layout", () => {
  const root = tmpRoot();
  const nested = path.join(root, "learned", "deploy-staging");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "SKILL.md"), SAMPLE);
  const result = store.migrateNestedLearned(root);
  assert.deepEqual(result.moved, ["deploy-staging"]);
  assert.ok(fs.existsSync(path.join(root, "deploy-staging", "SKILL.md")));
  assert.equal(store.listSkills(root).length, 1);
});

test("normalizeMaxSkills handles default, custom, zero, and invalid inputs", () => {
  assert.equal(store.normalizeMaxSkills(undefined), 80);
  assert.equal(store.normalizeMaxSkills(null), 80);
  assert.equal(store.normalizeMaxSkills(""), 80);
  assert.equal(store.normalizeMaxSkills("  "), 80);
  assert.equal(store.normalizeMaxSkills(NaN), 80);
  assert.equal(store.normalizeMaxSkills(Infinity), 80);
  assert.equal(store.normalizeMaxSkills(-1), 80);
  assert.equal(store.normalizeMaxSkills(0), 0);
  assert.equal(store.normalizeMaxSkills("0"), 0);
  assert.equal(store.normalizeMaxSkills(25), 25);
  assert.equal(store.normalizeMaxSkills("25"), 25);
  assert.equal(store.normalizeMaxSkills(25.9), 25);
  assert.equal(store.normalizeMaxSkills(0.4), 1);
});

test("enforces default 80 skill limit and allows patch when full", () => {
  const root = tmpRoot();
  for (let i = 0; i < 80; i += 1) {
    const name = `skill-${i}`;
    const res = store.createSkill(root, { name, content: SAMPLE.replace(/deploy-staging/g, name) });
    assert.equal(res.ok, true);
  }
  assert.equal(store.listManaged(root).length, 80);
  assert.throws(
    () => store.createSkill(root, { name: "skill-80", content: SAMPLE.replace(/deploy-staging/g, "skill-80") }),
    /already have 80 learned skills/,
  );
  const patched = store.patchSkill(root, {
    name: "skill-0",
    oldString: "make skill-0",
    newString: "make deploy-skill-0",
  });
  assert.equal(patched.ok, true);
});

test("enforces custom maxSkills from config or option, and unblocks after archive", () => {
  const root = tmpRoot();
  store.saveConfig(root, { maxSkills: 2 });
  assert.equal(store.loadConfig(root).maxSkills, 2);
  store.createSkill(root, { name: "skill-a", content: SAMPLE.replace(/deploy-staging/g, "skill-a") });
  store.createSkill(root, { name: "skill-b", content: SAMPLE.replace(/deploy-staging/g, "skill-b") });
  assert.throws(
    () => store.createSkill(root, { name: "skill-c", content: SAMPLE.replace(/deploy-staging/g, "skill-c") }),
    /already have 2 learned skills/,
  );
  const opsRes = store.applyOps(
    root,
    [{ action: "create", name: "skill-c", content: SAMPLE.replace(/deploy-staging/g, "skill-c") }],
    "agent",
    { maxSkills: 2 },
  );
  assert.match(opsRes[0].error, /already have 2 learned skills/);
  store.archiveSkill(root, "skill-b");
  const createdAfterArchive = store.createSkill(root, {
    name: "skill-c",
    content: SAMPLE.replace(/deploy-staging/g, "skill-c"),
  });
  assert.equal(createdAfterArchive.ok, true);
});

test("maxSkills = 0 disables the limit (unlimited)", () => {
  const root = tmpRoot();
  store.saveConfig(root, { maxSkills: 0 });
  assert.equal(store.loadConfig(root).maxSkills, 0);
  for (let i = 0; i < 85; i += 1) {
    const name = `unlimited-${i}`;
    const res = store.createSkill(root, { name, content: SAMPLE.replace(/deploy-staging/g, name) });
    assert.equal(res.ok, true);
  }
  assert.equal(store.listManaged(root).length, 85);
});

test("loadEffectiveConfig inherits global maxSkills when project config is absent", () => {
  const globalRoot = tmpRoot();
  const projectRoot = tmpRoot();
  store.saveConfig(globalRoot, { scope: "project", maxSkills: 0 });
  const eff = store.loadEffectiveConfig(projectRoot, globalRoot);
  assert.equal(eff.scope, "project");
  assert.equal(eff.maxSkills, 0);
});
