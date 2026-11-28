/**
 * 提示词注入 · agent 进程内扩展（manifest.contributes.agentExtensions）
 *
 * 它在 agent 运行时里注册 `before_agent_start`：每一轮用户消息发出之前，
 * 宿主会把「即将发给模型的系统提示词」交给扩展，扩展可以返回替换后的版本。
 *
 * 本扩展的行为：
 *   1. 读取 <插件目录>/data/injections.json（由插件主进程 / 面板写入）；
 *   2. 用当前运行时的模型 provider/id 去匹配绑定；
 *   3. 命中的会话在第一轮把提示词拼进系统提示词：
 *        - scope = "session"：首轮注入并在此后每轮保持（宿主每轮都会重算系统提示词，
 *          所以必须每轮附上；同样的文本不会重复叠加）；
 *        - scope = "first"  ：只在第一轮出现，后续轮次恢复原始系统提示词。
 *   4. 每次真正注入都往 data/injections.log 追加一条 JSONL，面板可直接查看。
 *
 * 只使用 Node 内置能力读取本地文件，不发起任何网络请求。
 */

const EXTENSION_ID = "io.github.cydione.prompt-injector";
const LOG_ROTATE_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

/** `${sessionId}|${bindingKey}` -> { at, count }；一个 runtime 内长期存活。 */
const injectedBySession = new Map();
/** `${sessionId}|${modelKey}` -> true；同一会话同一模型的诊断只写一次，避免刷日志。 */
const debuggedBySession = new Map();
/** 配置文件缓存，按「内容 + mtime + size」失效，所以面板保存后下一轮就生效。 */
const configCache = { value: null, raw: null, mtimeMs: -1, size: -1 };

// ---------------------------------------------------------------------------
// Node 内置模块的懒加载
// 真实运行环境里扩展会被 jiti 编译成 CJS（require 可用）；为了在任何加载方式
// 下都能拿到 fs，这里依次尝试 process.getBuiltinModule / require / module.require，
// 最后再用动态 import 兜底。
// ---------------------------------------------------------------------------

let fsModuleCache = null;

function loadNodeModule(name) {
  try {
    if (typeof process !== "undefined" && typeof process.getBuiltinModule === "function") {
      const loaded = process.getBuiltinModule(name);
      if (loaded) return loaded;
    }
  } catch {
    // 继续尝试下一种方式
  }
  const requesters = [];
  try {
    if (typeof require === "function") requesters.push(require);
  } catch {
    // ignore
  }
  try {
    if (typeof module !== "undefined" && module && typeof module.require === "function") {
      requesters.push(module.require.bind(module));
    }
  } catch {
    // ignore
  }
  for (const request of requesters) {
    try {
      const loaded = request(name);
      if (loaded) return loaded;
    } catch {
      // 尝试下一种取用方式
    }
  }
  return null;
}

/** 同步取 fs；拿不到则返回 null（调用方自行降级）。 */
function nodeFs() {
  if (fsModuleCache) return fsModuleCache;
  const loaded = loadNodeModule("node:fs") || loadNodeModule("fs") || null;
  if (loaded) fsModuleCache = loaded;
  return loaded;
}

/** 异步兜底：纯 ESM 环境（没有 require）下用动态 import 拿 fs。 */
async function nodeFsAsync() {
  const sync = nodeFs();
  if (sync) return sync;
  try {
    const imported = await import("node:fs");
    const candidate = imported && typeof imported.readFileSync === "function"
      ? imported
      : imported && imported.default && typeof imported.default.readFileSync === "function"
        ? imported.default
        : null;
    if (candidate) {
      fsModuleCache = candidate;
      return candidate;
    }
  } catch {
    // 拿不到就只能放弃注入
  }
  return null;
}

function dirname(target) {
  if (typeof target !== "string" || !target) return "";
  const index = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  return index > 0 ? target.slice(0, index) : target;
}

/** 扩展文件位于 <插件目录>/extensions/inject.js，因此插件目录要上跳两级。 */
function resolvePluginDir() {
  try {
    if (typeof __filename === "string" && __filename) return dirname(dirname(__filename));
  } catch {
    // 不是 CJS 环境
  }
  try {
    const url = typeof import.meta === "object" && import.meta ? import.meta.url : "";
    if (typeof url === "string" && url.startsWith("file:")) {
      const urlModule = loadNodeModule("node:url");
      if (urlModule && typeof urlModule.fileURLToPath === "function") {
        return dirname(dirname(urlModule.fileURLToPath(url)));
      }
      return dirname(dirname(decodeURIComponent(url.replace(/^file:\/\/\/?/, "").split("?")[0])));
    }
  } catch {
    // import.meta 不可用
  }
  const fromEnv = typeof process !== "undefined" ? process.env && process.env.PI_PROMPT_INJECTOR_DIR : "";
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  return typeof process !== "undefined" && process.cwd ? process.cwd() : "";
}

const PLUGIN_DIR = resolvePluginDir();
// 用 node:path 拼路径，与 main.js 的 path.join 保持同一种写法（Windows 下都是反斜杠），
// 这样面板显示的路径和扩展实际读写的路径完全一致。拿不到 node:path 时退回手工拼接。
function joinPath(...segments) {
  const pathModule = loadNodeModule("node:path") || loadNodeModule("path");
  const parts = segments.filter((segment) => typeof segment === "string" && segment);
  if (pathModule && typeof pathModule.join === "function") return pathModule.join(...parts);
  const separator = parts[0] && parts[0].includes("\\") ? "\\" : "/";
  return parts
    .map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(separator);
}

const DATA_DIR = joinPath(PLUGIN_DIR, "data");
const CONFIG_PATH = joinPath(DATA_DIR, "injections.json");
const LOG_PATH = joinPath(DATA_DIR, "injections.log");

// ---------------------------------------------------------------------------
// 配置：与 main.js 保持完全一致的收敛规则
// ---------------------------------------------------------------------------

function text(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return typeof max === "number" && trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** 一项绑定 = 一份提示词 + 一组模型（模型只能来自本机模型列表）。 */
function normalizeBinding(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const models = [];
  for (const entry of Array.isArray(raw.models) ? raw.models : []) {
    const key = text(entry, 300);
    if (key && !models.includes(key)) models.push(key);
  }
  if (models.length === 0) return null;
  return {
    id: text(raw.id, 80),
    models,
    enabled: raw.enabled !== false,
    prompt: typeof raw.prompt === "string" ? raw.prompt.slice(0, 40000) : "",
    scope: raw.scope === "first" ? "first" : "session",
    position: raw.position === "prepend" ? "prepend" : "append",
  };
}

/** 一个模型只能属于一项：后出现的项会失去重复的模型，空项被丢弃。 */
function normalizeConfig(raw) {
  const config = { schemaVersion: 1, enabled: true, template: "", bindings: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config;
  config.enabled = raw.enabled !== false;
  config.template = typeof raw.template === "string" ? raw.template : "";
  const usedModels = new Set();
  const usedIds = new Set();
  for (const entry of Array.isArray(raw.bindings) ? raw.bindings : []) {
    const binding = normalizeBinding(entry);
    if (!binding) continue;
    binding.models = binding.models.filter((key) => !usedModels.has(key));
    if (binding.models.length === 0) continue;
    for (const key of binding.models) usedModels.add(key);
    // id 在模型定稿之后再派生，保证它始终描述项里真正的模型集合
    let id = binding.id || binding.models.join("|");
    let suffix = 2;
    while (usedIds.has(id)) id = `${binding.id || binding.models.join("|")}-${suffix++}`;
    binding.id = id;
    usedIds.add(id);
    config.bindings.push(binding);
  }
  return config;
}

function renderBlock(config, binding, vars) {
  const prompt = text(binding && binding.prompt);
  if (!prompt) return "";
  const template = text(config && config.template);
  if (!template || !/\{\{\s*prompt\s*\}\}/.test(template)) return prompt;
  return template
    .replace(/\{\{\s*prompt\s*\}\}/g, () => prompt)
    .replace(/\{\{\s*model\s*\}\}/g, () => vars.modelId || "")
    .replace(/\{\{\s*provider\s*\}\}/g, () => vars.providerId || "")
    .replace(/\{\{\s*modelKey\s*\}\}/g, () => vars.modelKey || "");
}


// ---------------------------------------------------------------------------
// 读取「即将发给模型的系统提示词」
//
// 宿主在 before_agent_start 的 payload 上挂了 `systemPrompt`（访问器），但它返回的
// 不一定就是字符串：
//   - 多数情况下是 `getCurrentSystemMessage()` 的返回值 —— 一个 system 消息对象，
//     真正的文本在 message.content 里（纯字符串，或 [{ type: "text", text }] 数组）；
//   - 某些版本直接给 `{ content: "..." }`。
// 只要按字符串去读，就会永远读到空值：命中模型也拼不出内容，注入静默失效。
// 这里把几种形态都收一遍，并顺带显示生效时到底读到的是哪种（写进注入日志）。
// ---------------------------------------------------------------------------

/** 字符串 | 内容块数组 → 文本；其他形态返回 ""。 */
function readText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts = [];
  for (const part of value) {
    if (typeof part === "string") parts.push(part);
    else if (part && typeof part === "object" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

/** 访问器可能抛错（宿主 assertActive），逐个候选值试，取第一个非空文本。 */
function readCandidate(value, read) {
  let current;
  try {
    current = typeof read === "function" ? read(value) : value;
  } catch {
    return "";
  }
  if (typeof current === "string") {
    return current;
  }
  if (current && typeof current === "object") {
    const nested = readText(current.content);
    if (nested) return nested;
  }
  return "";
}

/** @returns {{ base: string, source: string }} 读不到的候选不参与，source 只是诊断用。 */
function resolveSystemPrompt(payload) {
  const candidates = [
    ["systemPrompt", () => (payload && payload.systemPrompt)],
    ["systemPrompt.content", () => (payload && payload.systemPrompt && payload.systemPrompt.content)],
    ["systemPromptOptions.forceSystemPrompt", () => {
      const options = payload && payload.systemPromptOptions;
      return options ? options.forceSystemPrompt : "";
    }],
    ["systemPromptOptions.appendSystemPrompt", () => {
      const options = payload && payload.systemPromptOptions;
      return options ? options.appendSystemPrompt : "";
    }],
  ];
  for (const [source, read] of candidates) {
    const base = readCandidate(payload, read);
    if (base) return { base, source };
  }
  return { base: "", source: "empty" };
}
// ---------------------------------------------------------------------------
// 文件读写：配置读取 + JSONL 日志追加
// ---------------------------------------------------------------------------

function appendLog(entry) {
  const fsModule = nodeFs();
  if (!fsModule) return;
  try {
    fsModule.mkdirSync(DATA_DIR, { recursive: true });
    try {
      const stats = fsModule.statSync(LOG_PATH);
      if (stats.size > LOG_ROTATE_BYTES) {
        try {
          fsModule.rmSync(`${LOG_PATH}.old`, { force: true });
        } catch {
          // ignore
        }
        fsModule.renameSync(LOG_PATH, `${LOG_PATH}.old`);
      }
    } catch {
      // 日志文件还不存在
    }
    fsModule.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // 日志永远不能影响一轮对话
  }
}

/**
/**
 * 读取配置。返回 { config, error }：
 *  - 文件不存在 → config 为 null（尚未配置任何绑定）
 *  - JSON 坏掉 → 返回上一份可用配置，并记录一次错误日志
 *
 * 缓存判据是「内容 + mtime + size」：只比 mtime/size 会漏掉「同一秒内两次等长保存」
 * （面板连续保存同一份绑定、或只翻总开关时就会这样），那会让改完不生效。
 */
async function readConfig() {
  const fsModule = await nodeFsAsync();
  if (!fsModule) return { config: null, error: "node:fs 不可用，无法读取注入配置" };
  let stats;
  try {
    stats = fsModule.statSync(CONFIG_PATH);
  } catch {
    return { config: null, error: null };
  }
  let raw;
  try {
    raw = fsModule.readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    return { config: configCache.value, error: `读取注入配置失败: ${String(error && error.message)}` };
  }
  if (configCache.value && configCache.raw === raw && configCache.mtimeMs === stats.mtimeMs && configCache.size === stats.size) {
    return { config: configCache.value, error: null };
  }
  try {
    const config = normalizeConfig(JSON.parse(raw));
    configCache.value = config;
    configCache.raw = raw;
    configCache.mtimeMs = stats.mtimeMs;
    configCache.size = stats.size;
    return { config, error: null };
  } catch (error) {
    return { config: configCache.value, error: `注入配置不是合法 JSON: ${String(error && error.message)}` };
  }
}

// ---------------------------------------------------------------------------
// 注入逻辑
// ---------------------------------------------------------------------------

/**
 * 找命中项。两边的模型 key 不总是同一个字符串，所以分两级匹配：
 *   1. `exact`    —— 整串 `provider/model` 完全相等（面板列出的 key 就是整串形态）；
 *   2. `model_id` —— 只比模型 id：运行时的 `ctx.model.provider` 是本机 provider 的
 *                    vendorKey（本机两个 provider 都是 `custom`），也可能是别的写法，
 *                    而面板存的是 provider 的 uuid，整串永远对不上，所以必须有这一级。
 * 模型 id 本身可能带 `/`（`cline-pass/deepseek-v4.1-flash`），所以只削掉第一段 provider。
 * 优先整串命中，避免「同一模型挂在两个 provider」时挑错项。
 * @returns {{ binding: object|null, rules: string[], disabled: object|null }}
 */
function resolveBinding(bindings, modelKey) {
  const empty = { binding: null, rules: [], disabled: null };
  if (!Array.isArray(bindings) || !modelKey) return empty;
  const slash = modelKey.lastIndexOf("/");
  // 模型 id 可能本身还带 "/"（`cline-pass/deepseek-v4.1-flash`），所以只削掉第一段 provider
  const modelId = slash >= 0 ? modelKey.slice(slash + 1) : modelKey;
  const hits = { exact: null, model_id: null };
  let disabled = null;
  for (const binding of bindings) {
    if (!binding || !Array.isArray(binding.models)) continue;
    const matched = binding.models.filter((candidate) => (
      candidate === modelKey || (slash > 0 && candidate.endsWith(`/${modelId}`))
    ));
    if (matched.length === 0) continue;
    const rule = matched.includes(modelKey) ? "exact" : "model_id";
    const usable = binding.enabled !== false && typeof binding.prompt === "string" && binding.prompt.trim();
    if (!usable) {
      if (!disabled) disabled = { binding, rule };
      continue;
    }
    if (!hits[rule]) hits[rule] = { binding, rule };
  }
  for (const rule of ["exact", "model_id"]) {
    if (hits[rule]) return { binding: hits[rule].binding, rules: [rule], disabled: null };
  }
  return { binding: null, rules: [], disabled: disabled ? disabled.binding : null };
}

function readSessionId(ctx) {
  try {
    const value = ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionId === "function"
      ? ctx.sessionManager.getSessionId()
      : "";
    return typeof value === "string" && value ? value : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 把「这一轮为什么没注入」写进日志（同一会话同一模型只写一次）。
 * 没有这一步，模型 key 不匹配 / 绑定提示词为空都会表现为完全静默，无从排查。
 */
function logDiagnosis(sessionId, modelKey, providerId, modelId, details) {
  const entries = Object.entries(details).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return;
  const key = `${sessionId}|${modelKey}`;
  if (debuggedBySession.has(key)) return;
  if (debuggedBySession.size > 500) debuggedBySession.clear();
  debuggedBySession.set(key, true);
  const entry = { ts: new Date().toISOString(), event: "debug", session: sessionId, model: modelKey, provider: providerId, modelId };
  for (const [name, value] of entries) entry[name] = value;
  appendLog(entry);
}

async function onBeforeAgentStart(payload, ctx) {
  try {
    // 诊断：每个会话（含子任务会话）第一次进入回调时记一条，用来确认钩子是否真的被宿主调用
    const turnSession = readSessionId(ctx);
    const turnKey = `${turnSession}|turn`;
    if (!debuggedBySession.has(turnKey)) {
      debuggedBySession.set(turnKey, true);
      const turnModel = ctx && ctx.model ? ctx.model : {};
      appendLog({
        ts: new Date().toISOString(),
        event: "turn",
        session: turnSession,
        provider: turnModel.provider || "",
        modelId: turnModel.id || "",
        hasSystemPrompt: Boolean(resolveSystemPrompt(payload).base),
      });
    }
    const { config, error } = await readConfig();
    if (error) appendLog({ ts: new Date().toISOString(), event: "config_error", message: error });
    if (!config || config.enabled === false) return undefined;

    const model = ctx && typeof ctx === "object" ? ctx.model : null;
    const providerId = model && typeof model.provider === "string" ? model.provider : "";
    const modelId = model && typeof model.id === "string" ? model.id : "";
    const modelKey = providerId && modelId ? `${providerId}/${modelId}` : modelId || providerId || "unknown";

    const sessionId = readSessionId(ctx);
    const resolved = resolveBinding(config.bindings, modelKey);
    if (!resolved.binding) {
      const matchedButDisabled = resolved.disabled
        ? config.bindings.filter((entry) => entry.enabled === false).map((entry) => entry.id)
        : [];
      logDiagnosis(sessionId, modelKey, providerId, modelId, {
        reason: "no_match",
        enabledBindings: config.bindings.filter((entry) => entry.enabled !== false).length,
        boundModels: config.bindings.reduce((total, entry) => total + (Array.isArray(entry.models) ? entry.models.length : 0), 0),
        configuredModels: config.bindings.map((entry) => (Array.isArray(entry.models) ? entry.models.join(" , ") : "")).filter(Boolean).join(" ; ") || "(无)",
        disabledMatches: matchedButDisabled.length > 0 ? matchedButDisabled.join(" , ") : undefined,
      });
      return undefined;
    }

    const binding = resolved.binding;
    const { base, source } = resolveSystemPrompt(payload);
    const block = renderBlock(config, binding, { providerId, modelId, modelKey });
    if (!block) {
      logDiagnosis(sessionId, modelKey, providerId, modelId, {
        reason: "empty_block",
        binding: binding.id,
        promptChars: typeof binding.prompt === "string" ? binding.prompt.trim().length : 0,
        hasTemplate: Boolean(config.template && config.template.trim()),
      });
      return undefined;
    }
    if (base && base.includes(block)) return undefined;

    const recordKey = `${sessionId}|${binding.id}`;
    const record = injectedBySession.get(recordKey);
    if (binding.scope === "first" && record) return undefined;

    if (!record) {
      injectedBySession.set(recordKey, { at: Date.now(), count: 1 });
      appendLog({
        ts: new Date().toISOString(),
        event: "inject",
        session: sessionId,
        model: modelKey,
        binding: binding.id,
        matchedBy: resolved.rules[0],
        scope: binding.scope,
        position: binding.position,
        baseSource: source,
        baseChars: base.length,
        chars: block.length,
        promptChars: binding.prompt.trim().length,
      });
    } else {
      record.count += 1;
      record.at = Date.now();
    }

    // 没有宿主系统提示词时，只发这一项，不留下多余的换行
    const next = !base
      ? block
      : binding.position === "prepend"
        ? `${block}\n\n${base}`
        : `${base}\n\n${block}`;
    return { systemPrompt: next };
  } catch (error) {
    appendLog({
      ts: new Date().toISOString(),
      event: "error",
      message: String((error && error.message) || error),
    });
    return undefined;
  }
}

/** 扩展工厂：宿主会用 `api` 调用它一次，之后按事件回调。 */
export default function promptInjectorExtension(api) {
  api.on("before_agent_start", onBeforeAgentStart);
  nodeFsAsync()
    .then(() =>
      appendLog({
        ts: new Date().toISOString(),
        event: "ready",
        extension: EXTENSION_ID,
        pluginDir: PLUGIN_DIR,
        configPath: CONFIG_PATH,
      })
    )
    .catch(() => undefined);
}
