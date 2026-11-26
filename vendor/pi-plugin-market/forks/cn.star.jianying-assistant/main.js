"use strict";

const { JianyingRuntime } = require("./runtime");
const manifest = require("./manifest.json");
const COMMAND = "jianying-assistant.open";
const methods = Object.freeze({
  check_environment: "doctor", setup_environment: "setup", inspect_media: "probe",
  validate_timeline: "validate", create_draft: "build", import_draft: "publish", launch_jianying: "launch",
});
let runtime;
let lastResult = null;
let lastWorkspace = null;

async function workspacePath() {
  const workspace = await pi.workspace.get();
  return workspace?.path || "";
}
function getRuntime() {
  if (!runtime) runtime = new JianyingRuntime({
    getSettings: () => pi.plugin.getSettings(), getWorkspace: workspacePath,
  });
  return runtime;
}
function failure(error) {
  return { ok: false, isError: true, error: typeof error?.message === "string" ? error.message : String(error) };
}
async function state() {
  const workspace = await workspacePath();
  if (workspace !== lastWorkspace) { lastResult = null; lastWorkspace = workspace; }
  return { ok: true, version: manifest.version, workspace, settings: await pi.plugin.getSettings(), lastResult };
}
async function perform(method, args) {
  try {
    const workspace = await workspacePath();
    if (workspace !== lastWorkspace) { lastResult = null; lastWorkspace = workspace; }
    const result = await getRuntime()[method](args || {});
    if (method === "build" && result?.ok === true && workspace === await workspacePath()) lastResult = result;
    return result;
  } catch (error) { return failure(error); }
}
async function onLoad() {
  await pi.commands.register({ ...manifest.contributes.commands[0], run: () => pi.ui.openPanel({ title: "剪映助手" }) });
  for (const tool of manifest.contributes.agentTools) {
    await pi.agent.registerTool({ ...tool, execute: args => perform(methods[tool.name], args) });
  }
}
async function onUnload() {
  if (runtime) { await runtime.dispose(); runtime = null; }
  lastResult = null;
  await pi.commands.unregister(COMMAND);
  for (const tool of manifest.contributes.agentTools) await pi.agent.unregisterTool(tool.name);
}
async function onPanelInvoke(channel, payload) {
  try {
    if (channel === "jy.state") return await state();
    if (channel === "jy.settings") {
      const settings = {};
      for (const key of ["pythonPath", "draftRoot", "jianyingPath", "workDir"]) {
        if (typeof payload?.[key] !== "string" || payload[key].length > 4096 || /[\0\r\n]/.test(payload[key])) {
          throw new Error(`设置 ${key} 必须是有效单行路径。`);
        }
        settings[key] = payload[key].trim();
      }
      await pi.plugin.setSettings(settings);
      lastResult = null;
      return await state();
    }
    const method = channel.startsWith("jy.") ? channel.slice(3) : "";
    if (!["doctor", "setup", "probe", "validate", "build", "publish", "launch"].includes(method)) throw new Error(`不支持的面板操作：${channel}`);
    return await perform(method, payload);
  } catch (error) { return failure(error); }
}
module.exports = { onLoad, onUnload, onPanelInvoke };
