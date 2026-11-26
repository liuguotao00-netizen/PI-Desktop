/**
 * 提示词注入 · 插件主进程（PI-Desktop plugin entry，CommonJS）
 *
 * 职责：
 *  1. 保存 / 读取「模型 → 提示词」绑定（data/injections.json）。
 *  2. 给面板提供 RPC（宿主会把未识别的面板通道转发到 onPanelInvoke）。
 *  3. 注册命令，向用户暴露启用 / 停用与打开面板。
 *
 * 真正的注入动作在 extensions/inject.js（运行在 agent 进程内），
 * 它直接读取本文件写下的同一个配置，因此面板改完保存后无需重启会话。
 *
 * 权限（manifest.json）：ui.panel / notify / models.list / agent.extension
 */

const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_ID = "io.github.cydione.prompt-injector";
const PLUGIN_DIR = __dirname;
const DATA_DIR = path.join(PLUGIN_DIR, "data");
const CONFIG_PATH = path.join(DATA_DIR, "injections.json");
const LOG_PATH = path.join(DATA_DIR, "injections.log");
const LOG_ROTATE_BYTES = 256 * 1024;

const MAX_BINDINGS = 200;
const MAX_MODELS_PER_BINDING = 100;
const MAX_PROMPT_CHARS = 40000;
const MAX_TEMPLATE_CHARS = 4000;
const SCOPES = new Set(["session", "first"]);
const POSITIONS = new Set(["append", "prepend"]);

/** 默认配置：总开关打开、无绑定。 */
function emptyConfig() {
  return {
    schemaVersion: 1,
    enabled: true,
    template: "",
    updatedAt: null,
    bindings: [],
  };
}

function str(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return typeof max === "number" && trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** 一项绑定 = 一份提示词 + 一组模型（模型只能来自本机模型列表）。 */
function normalizeBinding(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const models = [];
  for (const entry of Array.isArray(raw.models) ? raw.models : []) {
    const key = str(entry, 300);
    if (key && !models.includes(key)) models.push(key);
  }
  if (models.length === 0) return null;
  return {
    id: str(raw.id, 80),
    models: models.slice(0, MAX_MODELS_PER_BINDING),
    enabled: raw.enabled !== false,
    prompt: typeof raw.prompt === "string" ? raw.prompt.slice(0, MAX_PROMPT_CHARS) : "",
    scope: SCOPES.has(raw.scope) ? raw.scope : "session",
    position: POSITIONS.has(raw.position) ? raw.position : "append",
  };
}

/** 配置归一化：面板 / 磁盘上的任何脏数据都在这里被收敛；一个模型只属于一项。 */
function normalizeConfig(raw) {
  const config = emptyConfig();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config;
  config.enabled = raw.enabled !== false;
  config.template = typeof raw.template === "string" ? raw.template.slice(0, MAX_TEMPLATE_CHARS) : "";
  config.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : null;
  const usedModels = new Set();
  const usedIds = new Set();
  for (const entry of Array.isArray(raw.bindings) ? raw.bindings : []) {
    if (config.bindings.length >= MAX_BINDINGS) break;
    const binding = normalizeBinding(entry);
    if (!binding) continue;
    binding.models = binding.models.filter((key) => !usedModels.has(key));
    if (binding.models.length === 0) continue;
    for (const key of binding.models) usedModels.add(key);
    // id 在模型定稿之后再派生，保证它始终描述项里真正的模型集合
    const derivedId = binding.id || binding.models.join("|");
    let id = derivedId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${derivedId}-${suffix++}`;
    binding.id = id;
    usedIds.add(id);
    config.bindings.push(binding);
  }
  return config;
}


function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 原子写：先写临时文件再改名，避免面板保存与 agent 读取撞车。 */
function writeFileAtomic(target, contents) {
  ensureDataDir();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** 读配置：文件不存在时落一份默认配置，坏 JSON 不覆盖但报错。 */
function loadConfig() {
  try {
    ensureDataDir();
  } catch (error) {
    return { config: emptyConfig(), error: `无法创建数据目录: ${String(error && error.message)}` };
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    const config = emptyConfig();
    try {
      writeFileAtomic(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
    } catch (error) {
      return { config, error: `无法写入配置文件: ${String(error && error.message)}` };
    }
    return { config, error: null };
  }
  let text;
  try {
    text = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    return { config: emptyConfig(), error: `无法读取配置文件: ${String(error && error.message)}` };
  }
  try {
    return { config: normalizeConfig(JSON.parse(text)), error: null };
  } catch (error) {
    return {
      config: emptyConfig(),
      error: `配置文件不是合法 JSON（未覆盖原文件）: ${String(error && error.message)}`,
    };
  }
}

function saveConfig(config) {
  const normalized = normalizeConfig(config);
  normalized.updatedAt = new Date().toISOString();
  writeFileAtomic(CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function clearLogFile() {
  try {
    if (fs.existsSync(LOG_PATH)) fs.rmSync(LOG_PATH, { force: true });
  } catch {
    // 日志清理失败不影响主流程
  }
}

/** 读取末尾 N 条日志（JSONL，一行一条）。 */
function readLogEntries(limit) {
  const max = Math.max(1, Math.min(500, Number(limit) || 60));
  let text = "";
  try {
    if (fs.existsSync(LOG_PATH)) {
      const stats = fs.statSync(LOG_PATH);
      const start = Math.max(0, stats.size - LOG_ROTATE_BYTES);
      if (start > 0) {
        const fd = fs.openSync(LOG_PATH, "r");
        try {
          const buffer = Buffer.alloc(stats.size - start);
          fs.readSync(fd, buffer, 0, buffer.length, start);
          text = buffer.toString("utf8");
          const firstBreak = text.indexOf("\n");
          if (firstBreak !== -1) text = text.slice(firstBreak + 1);
        } finally {
          fs.closeSync(fd);
        }
      } else {
        text = fs.readFileSync(LOG_PATH, "utf8");
      }
    }
  } catch {
    return { entries: [], error: "读取日志失败" };
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const entries = [];
  for (const line of lines.slice(-max)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // 跳过被截断的残行
    }
  }
  return { entries: entries.reverse(), error: null };
}

/** 本地模型 / 已登录模型列表（models.list）。 */
async function listModels() {
  try {
    const listed = await pi.models.list();
    const models = (Array.isArray(listed) ? listed : [])
      .map((entry) => {
        const model = entry && typeof entry === "object" ? entry : {};
        const providerId = str(model.providerId, 200);
        const modelId = str(model.modelId, 300);
        const key = str(model.key, 400) || (providerId && modelId ? `${providerId}/${modelId}` : modelId);
        return {
          key,
          providerId,
          providerName: str(model.providerName, 200),
          modelId,
          label: str(model.label, 300) || modelId || key,
          alias: str(model.alias, 200),
          isDefault: model.isDefault === true,
        };
      })
      .filter((model) => Boolean(model.key));
    return { models, error: null };
  } catch (error) {
    return { models: [], error: `无法读取模型列表: ${String(error && error.message)}` };
  }
}

function pluginVersion() {
  try {
    const manifest = pi.plugin.getManifest();
    return str(manifest && manifest.version, 32) || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function statePayload() {
  const { config, error } = loadConfig();
  const { models, error: modelsError } = await listModels();
  return {
    pluginId: PLUGIN_ID,
    pluginVersion: pluginVersion(),
    pluginDir: PLUGIN_DIR,
    configPath: CONFIG_PATH,
    logPath: LOG_PATH,
    config,
    configError: error,
    models,
    modelsError,
  };
}

/**
 * 面板自定义 RPC。宿主先处理自己的通道（models.list / ui.* / fs.* ...），
 * 其余通道以 panel.invoke 转发到这里。
 */
async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "injector.state":
      return await statePayload();
    case "injector.models": {
      const { models, error } = await listModels();
      return { models, modelsError: error };
    }
    case "injector.save": {
      const saved = saveConfig(payload && payload.config);
      return { config: saved, configPath: CONFIG_PATH };
    }
    case "injector.log":
      return await statePayloadLog(payload);
    default:
      throw new Error(`提示词注入: 不支持的通道「${String(channel)}」`);
  }
}

async function statePayloadLog(payload) {
  const { entries, error } = readLogEntries(payload && payload.limit);
  if (payload && payload.clear === true) clearLogFile();
  return { entries, logPath: LOG_PATH, error };
}

async function runOpenPanel() {
  await pi.ui.openPanel({ title: "提示词注入" });
}

async function runToggle() {
  const { config } = loadConfig();
  saveConfig({ ...config, enabled: config.enabled === false });
}

async function onLoad() {
  // 首次加载落一份默认配置，agent 侧的扩展从第一次运行起就有东西可读。
  loadConfig();
  await pi.commands.register({
    id: "prompt-injector.open",
    title: "提示词注入: 打开配置面板",
    keywords: ["prompt-injector", "提示词", "inject"],
    run: runOpenPanel,
  });
  await pi.commands.register({
    id: "prompt-injector.toggle",
    title: "提示词注入: 启用 / 停用",
    keywords: ["prompt-injector", "toggle"],
    run: runToggle,
  });
}

async function onUnload() {
  await pi.commands.unregister("prompt-injector.open");
  await pi.commands.unregister("prompt-injector.toggle");
}

module.exports = { onLoad, onUnload, onPanelInvoke };
