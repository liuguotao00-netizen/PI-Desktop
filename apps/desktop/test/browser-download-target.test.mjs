import assert from "node:assert/strict";
import test from "node:test";
import { resolveDownloadPlan, expandHome } from "../electron/main/browser/download-target.ts";

test("downloads fall back to the session scratch folder", () => {
  const plan = resolveDownloadPlan({ filename: "a.pdf", scratch: "/tmp/scratch" });
  assert.equal(plan.mode, "save");
  assert.ok(plan.path.startsWith("/tmp/scratch/"));
  assert.ok(plan.path.endsWith("-a.pdf"));
});

test("a configured directory wins over scratch", () => {
  const plan = resolveDownloadPlan({
    filename: "a.pdf",
    scratch: "/tmp/scratch",
    settings: { downloadDirectory: "/Users/me/Downloads" },
  });
  assert.equal(plan.mode, "save");
  assert.ok(plan.path.startsWith("/Users/me/Downloads/"));
});

test("ask-where-to-save keeps no save path and carries a default", () => {
  const plan = resolveDownloadPlan({
    filename: "a.pdf",
    scratch: "/tmp/scratch",
    settings: { downloadPrompt: true, downloadDirectory: "/Users/me/Downloads" },
  });
  assert.deepEqual(plan, { mode: "prompt", defaultPath: "/Users/me/Downloads/a.pdf" });
});

test("without scratch or settings the platform default applies", () => {
  assert.deepEqual(resolveDownloadPlan({ filename: "a.pdf" }), { mode: "default" });
});

test("home is expanded", () => {
  assert.equal(expandHome("~/Downloads").endsWith("/Downloads"), true);
  assert.equal(expandHome("  "), "");
});
