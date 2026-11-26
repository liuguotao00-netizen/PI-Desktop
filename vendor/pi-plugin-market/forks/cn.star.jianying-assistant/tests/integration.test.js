"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

// Explicit opt-in: this test installs packages from PyPI into a scratch-only venv.
test("public plugin workflow: setup, probe, validate, build, backup and import twice", {
  skip: !process.env.JY_INTEGRATION_PYTHON,
  timeout: 600000,
}, async () => {
  assert.ok(process.env.PI_SCRATCH_DIR, "PI_SCRATCH_DIR is required");
  const workspace = path.join(process.env.PI_SCRATCH_DIR, `jy-integration-${randomUUID()}`);
  const drafts = path.join(workspace, "模拟剪映草稿");
  await fs.mkdir(drafts, { recursive: true });
  await fs.writeFile(path.join(drafts, "existing.txt"), "must remain unchanged");
  const video = path.join(workspace, "中文 视频.mp4");
  const audio = path.join(workspace, "背景音.wav");
  const env = { ...process.env, TEMP: workspace, TMP: workspace };
  for (const args of [
    ["-f", "lavfi", "-i", "color=c=blue:s=160x120:r=30", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", video],
    ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "6", audio],
  ]) {
    const run = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { env, encoding: "utf8", timeout: 30000, shell: false });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
  }
  let settings = { pythonPath: process.env.JY_INTEGRATION_PYTHON, draftRoot: drafts, jianyingPath: "", workDir: "Jianying" };
  const tools = new Map();
  global.pi = {
    workspace: { get: async () => ({ path: workspace }) },
    plugin: { getSettings: async () => settings, setSettings: async value => { settings = { ...settings, ...value }; } },
    commands: { register: async () => {}, unregister: async () => {} },
    ui: { openPanel: async () => {} },
    agent: { registerTool: async tool => tools.set(tool.name, tool), unregisterTool: async name => tools.delete(name) },
  };
  const api = require("../main");
  async function invoke(name, args = {}) {
    const result = await tools.get(name).execute(args);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  }
  try {
    await api.onLoad();
    assert.equal((await api.onPanelInvoke("jy.settings", settings)).ok, true);
    const before = await invoke("check_environment");
    assert.equal(before.python.available, true);
    assert.equal(before.ready, false);
    await invoke("setup_environment", { confirmed: true });
    assert.equal((await invoke("check_environment")).ready, true);
    const media = await invoke("inspect_media", { path: video });
    assert.ok(media.hasVideo);
    assert.ok(Math.abs(media.duration - 6) < 0.1);
    const timeline = {
      title: "中文集成测试", width: 1080, height: 1920, fps: 30,
      clips: [{ path: "中文 视频.mp4", start: 1, duration: 2 }, { path: video, start: 0, duration: 4, speed: 2, volume: 0.5 }],
      audio: [{ path: audio, start: 0, duration: 4, at: 0, volume: 0.2 }],
      texts: [{ text: "第一行", start: 0, duration: 3, color: "#EA868F" }, { text: "重叠字幕", start: 1, duration: 2 }],
    };
    const validation = await invoke("validate_timeline", { timeline });
    assert.equal(validation.timeline.texts[0].fontSize, 8);
    assert.equal(validation.timeline.texts[1].fontSize, 8);
    assert.equal(validation.duration, 4);
    const built = await invoke("create_draft", { timeline });
    assert.equal(built.duration, 4);
    const source = JSON.parse(await fs.readFile(path.join(built.draftDir, "draft_content.json"), "utf8"));
    assert.equal(source.duration, 4000000);
    const videoTrack = source.tracks.find(track => track.type === "video");
    assert.equal(videoTrack.segments.length, 2);
    assert.equal(videoTrack.segments[1].source_timerange.duration, 4000000);
    assert.equal(videoTrack.segments[1].target_timerange.duration, 2000000);
    assert.equal(source.tracks.filter(track => track.type === "text").length, 2);
    assert.equal((await api.onPanelInvoke("jy.state")).lastResult.jobDir, built.jobDir);
    const first = await invoke("import_draft", { jobDir: built.jobDir, confirmed: true });
    const second = await invoke("import_draft", { jobDir: built.jobDir, confirmed: true });
    assert.notEqual(first.importedDir, second.importedDir);
    assert.equal(await fs.readFile(path.join(drafts, "existing.txt"), "utf8"), "must remain unchanged");
    assert.equal(await fs.readFile(path.join(first.backupDir, "draft_content.json"), "utf8"), await fs.readFile(path.join(built.draftDir, "draft_content.json"), "utf8"));
    const metadata1 = JSON.parse(await fs.readFile(path.join(first.importedDir, "draft_meta_info.json"), "utf8"));
    const metadata2 = JSON.parse(await fs.readFile(path.join(second.importedDir, "draft_meta_info.json"), "utf8"));
    assert.equal(path.resolve(metadata1.draft_fold_path), first.importedDir, "Imported metadata must not retain source location");
    assert.notEqual(metadata1.draft_id, metadata2.draft_id, "Repeated imports must have distinct project identities");
    console.log(`Integration artifacts retained in ${workspace}`);
  } finally {
    await api.onUnload();
    delete global.pi;
  }
});
