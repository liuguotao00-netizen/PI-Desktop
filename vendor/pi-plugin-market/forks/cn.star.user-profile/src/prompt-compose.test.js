"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const compose = require("./prompt-compose.js");

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prompt-d-"));
}

test("last writer concatenates every fragment onto the host prompt", () => {
  const home = tmpHome();
  compose.writeFragment("cn.star.skill-learning", "## Skill learning\nnudge", home);
  const out = compose.applyFragment(
    "HOST PROMPT",
    "cn.star.user-profile",
    "USER PROFILE (who the user is) [1% — 1/1,375 chars]",
    home,
  );
  assert.match(out, /HOST PROMPT/);
  assert.match(out, /## Skill learning/);
  assert.match(out, /USER PROFILE \(who the user is\)/);
});

test("disabled plugin deletes its fragment and still keeps the other", () => {
  const home = tmpHome();
  compose.writeFragment("cn.star.skill-learning", "## Skill learning\nnudge", home);
  compose.writeFragment("cn.star.user-profile", "USER PROFILE (who the user is)", home);
  const out = compose.applyFragment("HOST", "cn.star.user-profile", "", home);
  assert.match(out, /## Skill learning/);
  assert.equal(out.includes("USER PROFILE (who the user is)"), false);
});

test("does not double-inject when the host already chained a fragment", () => {
  const home = tmpHome();
  const block = "## Skill learning\nnudge";
  compose.writeFragment("cn.star.skill-learning", block, home);
  const out = compose.compose(`HOST\n\n${block}`, home);
  assert.equal(out.split("## Skill learning").length - 1, 1);
});
