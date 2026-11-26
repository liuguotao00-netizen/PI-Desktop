"use strict";

// Load and unload: persona install and removal, tool registration, and the manifest staying in
// step with the code and the persona files.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, loadMain, sandbox, fakePi, withHome, frontmatter } = require("./helpers.js");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function setup() {
  const dirs = sandbox();
  const restore = withHome(dirs.home);
  cleanups.push(() => {
    restore();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  });
  const pi = fakePi(dirs);
  const main = loadMain(pi);
  const target = path.join(dirs.home, ".agents", "subagents");
  return { dirs, pi, main, t: main.__t, target };
}

describe("personas", () => {
  it("are installed on load, refreshed when outdated, and removed on unload", async () => {
    const { pi, main, t, target } = setup();
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "council-member.md"), `---\nname: council-member\ndescription: old. ${t.MARKER}\n---\n`);
    fs.writeFileSync(path.join(target, "council-mine.md"), "---\nname: council-mine\ndescription: the user's own\n---\n");
    fs.writeFileSync(path.join(target, "council-chairman.md"), "outdated");
    await main.onLoad();
    const names = fs.readdirSync(target).sort();
    assert.deepEqual(names, [...Object.values(t.SEAT_AGENT).map((a) => `${a}.md`), "council-mine.md"].sort());
    for (const agent of Object.values(t.SEAT_AGENT)) {
      assert.deepEqual(fs.readFileSync(path.join(target, `${agent}.md`)), fs.readFileSync(path.join(ROOT, "subagents", `${agent}.md`)));
    }
    assert.equal(pi.tools.size, 1);
    // the user edits one persona: it survives unload, the others go
    fs.appendFileSync(path.join(target, "council-chairman.md"), "\nmy tweak\n");
    await main.onUnload();
    assert.deepEqual(fs.readdirSync(target).sort(), ["council-chairman.md", "council-mine.md"]);
    assert.deepEqual(pi.unregistered.sort(), ["council"]);
  });

  it("a failed install does not break loading; council get reports it", async () => {
    const { pi, main, dirs } = setup();
    fs.writeFileSync(path.join(dirs.home, ".agents"), "a file where the directory should be");
    await main.onLoad();
    const out = await pi.call("council", {});
    assert.match(out.personas, /could not install/);
    await main.onUnload();
  });

  it("are complete, pin no model, and share identical Stage 2 and Output sections", () => {
    const { t } = setup();
    const shared = new Set();
    for (const [seat, agent] of Object.entries(t.SEAT_AGENT)) {
      const text = fs.readFileSync(path.join(ROOT, "subagents", `${agent}.md`), "utf8");
      const { fields, dups } = frontmatter(text);
      assert.deepEqual(dups, [], agent);
      for (const k of ["name", "description", "tools", "thinkinglevel", "permission", "idletimeout", "maxduration"]) {
        assert.ok(fields[k], `${agent}: ${k}`);
      }
      assert.ok(!("model" in fields) && !("fallbackmodels" in fields), `${agent} pins a model`);
      assert.ok(!/\b(Opus|Sonnet|Haiku|Gemini|GPT|Grok|Llama|Mistral)\b/.test(fields.description), `${agent} names a model`);
      assert.equal(fields.name, agent);
      assert.ok(fields.description.includes(t.MARKER), agent);
      if (t.ADVISOR_SEATS.includes(seat)) shared.add(text.slice(text.indexOf("## Stage 2: review")));
    }
    assert.equal(shared.size, 1, "advisor Stage 2/Output sections must be identical");
  });
});

describe("manifest", () => {
  it("declares exactly the tools main.js registers, with the same schema", async () => {
    const { pi, main } = setup();
    await main.onLoad();
    const declared = manifest.contributes.agentTools;
    assert.deepEqual(declared.map((d) => d.name).sort(), [...pi.tools.keys()].sort());
    for (const d of declared) {
      const tool = pi.tools.get(d.name);
      assert.equal(d.description, tool.description, d.name);
      assert.equal(d.risk, tool.risk, d.name);
      assert.deepEqual(d.schema, tool.schema, d.name);
    }
    await main.onUnload();
  });

  it("asks for the permissions the code uses, with scopes limited to the run directories", () => {
    assert.deepEqual(manifest.permissions.slice().sort(), ["agent.extension", "agent.prompt.inject", "agent.tool.register", "fs.read", "fs.write"]);
    assert.deepEqual(manifest.contributes.agentExtensions, ["extension/council-guard.js"]);
    for (const f of manifest.contributes.agentExtensions) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
    assert.deepEqual(manifest.fs.read.scope, [".llm-council/**"]);
    assert.deepEqual(manifest.fs.write.scope, [".llm-council/**"]);
    assert.deepEqual(manifest.contributes.settings.map((s) => s.key).sort(), ["cast", "excludeModels", "modelNotes"]);
    assert.equal(manifest.license, "Apache-2.0");
  });
});
