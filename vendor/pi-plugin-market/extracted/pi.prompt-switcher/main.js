/**
 * 提示词切换器 (Prompt Switcher) — PI-Desktop 插件
 *
 * 功能点：
 * 1. 拓展界面设置面板：配置本地提示词目录，读取目录下所有 .md 文件并展示文件名与启用复选框。
 * 2. 首轮 / 快速切换提示词：在对话开始时输入 / 自动列出已启用的提示词，点击发送后将文件内容作为提示词发给大模型（类似 agents.md）。
 * 3. 历史对话约束：仅在会话初始无历史时生效，有历史记录时自动无视该提示词。
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PLUGIN_ID = "pi.prompt-switcher";
const DEFAULT_SETTINGS = {
  directory: "prompts",
  enabledFiles: {},
  syncedFiles: [],
};

// 动态注册的 command id 集合
const registeredCommandIds = new Set();

/**
 * 获取当前工作区根路径
 */
async function getWorkspaceRoot() {
  try {
    if (typeof pi?.workspace?.get === "function") {
      const ws = await pi.workspace.get();
      if (ws && ws.path) return ws.path;
    }
  } catch (_) {}
  return process.cwd();
}

/**
 * 解析用户配置的提示词本地绝对路径
 */
async function resolvePromptsDir(configuredDir) {
  const wsRoot = await getWorkspaceRoot();
  let dir = (configuredDir || "").trim();
  if (!dir) {
    dir = path.join(wsRoot, "prompts");
  } else if (!path.isAbsolute(dir)) {
    dir = path.resolve(wsRoot, dir);
  }
  return dir;
}

/**
 * 将任意字符串写成安全的 YAML 单行标量（避免 description 含冒号导致解析失败）
 */
function yamlQuote(value) {
  return JSON.stringify(String(value ?? "").replace(/\r\n/g, " ").replace(/\n/g, " ").trim());
}

/**
 * 拆分 Markdown 的 YAML frontmatter。即使缺少闭合 ---，也会尽量提取头部 key: value。
 */
function splitPromptDocument(content) {
  const trimmed = String(content || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!trimmed.startsWith("---")) {
    return { yaml: "", body: trimmed, hadFrontmatter: false, closed: false };
  }

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex !== -1) {
    return {
      yaml: trimmed.slice(4, endIndex).replace(/^\n/, "").replace(/\n$/, ""),
      body: trimmed.slice(endIndex + 4).replace(/^\n+/, ""),
      hadFrontmatter: true,
      closed: true,
    };
  }

  const rest = trimmed.slice(3).replace(/^\n/, "");
  const lines = rest.split("\n");
  const yamlLines = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      break;
    }
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) {
      yamlLines.push(line);
      i += 1;
      continue;
    }
    break;
  }
  return {
    yaml: yamlLines.join("\n"),
    body: lines.slice(i).join("\n").replace(/^\n+/, ""),
    hadFrontmatter: yamlLines.length > 0,
    closed: false,
  };
}

function fieldFromYaml(yaml, key) {
  const match = String(yaml || "").match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function upsertYamlField(yaml, key, value) {
  const line = `${key}: ${yamlQuote(value)}`;
  const re = new RegExp(`^${key}:\\s*.*$`, "m");
  if (yaml && re.test(yaml)) return yaml.replace(re, line);
  return yaml ? `${line}\n${yaml}` : line;
}

function stripExistingGuard(body) {
  return String(body || "")
    .replace(/<!-- PROMPT_SWITCHER_GUARD_START -->[\s\S]*?<!-- PROMPT_SWITCHER_GUARD_END -->\s*/g, "")
    .trimStart();
}

/**
 * 提取 .md 文件的 frontmatter 与描述
 */
function parsePromptMetadata(content) {
  const { yaml, body } = splitPromptDocument(content);
  let title = fieldFromYaml(yaml, "name");
  let description = fieldFromYaml(yaml, "description");

  if (!description) {
    const lines = body.split("\n");
    for (const l of lines) {
      const s = l.trim().replace(/^#+\s*/, "");
      if (s && !s.startsWith("---") && !s.startsWith("<!--") && !/^[A-Za-z0-9_-]+\s*:/.test(s)) {
        description = s.slice(0, 120);
        break;
      }
    }
  }

  return {
    title: title || "",
    description: description || "无描述",
  };
}

/**
 * 扫描指定目录下的全部 .md 文件
 */
async function scanPromptsDirectory(targetDir) {
  if (!targetDir || !fs.existsSync(targetDir)) {
    return {
      ok: false,
      error: `目录不存在: ${targetDir}`,
      files: [],
      dir: targetDir,
    };
  }

  try {
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: `指定的路径不是文件夹: ${targetDir}`,
        files: [],
        dir: targetDir,
      };
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const fullPath = path.join(targetDir, entry.name);
        try {
          const fileStat = fs.statSync(fullPath);
          const rawContent = fs.readFileSync(fullPath, "utf8");
          const meta = parsePromptMetadata(rawContent);

          files.push({
            name: entry.name,
            baseName: entry.name.replace(/\.md$/i, ""),
            path: fullPath,
            size: fileStat.size,
            mtime: fileStat.mtimeMs,
            title: meta.title || entry.name.replace(/\.md$/i, ""),
            description: meta.description,
            preview: rawContent.slice(0, 400),
          });
        } catch (readErr) {
          files.push({
            name: entry.name,
            baseName: entry.name.replace(/\.md$/i, ""),
            path: fullPath,
            error: String(readErr),
          });
        }
      }
    }

    // 按文件名自然排序
    files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

    return {
      ok: true,
      files,
      dir: targetDir,
    };
  } catch (err) {
    return {
      ok: false,
      error: `读取目录失败: ${err.message}`,
      files: [],
      dir: targetDir,
    };
  }
}

/**
 * 构造注入了“仅在会话最开始生效，已有历史记录时无视”约束的模板正文
 */
function buildGuardedPromptContent(rawContent, fileName) {
  const baseName = fileName.replace(/\.md$/i, "");
  const guard = `<!-- PROMPT_SWITCHER_GUARD_START -->
> **【提示词切换器 · 生效约束规则】**
> 此提示词为全局系统与角色引导指令（类似 agents.md）。**仅在当前会话最开始（首轮交互、没有任何历史对话记录）时生效**。
> 如果当前会话中已经存在之前的对话历史或交互记录，则本提示词的所有角色、规则和前置指令均视为无效并直接无视（Ignore），请继续保持原有的会话上下文进行回答。
<!-- PROMPT_SWITCHER_GUARD_END -->

`;

  const split = splitPromptDocument(rawContent);
  const meta = parsePromptMetadata(rawContent);
  let yaml = split.yaml;
  yaml = upsertYamlField(yaml, "name", baseName);
  yaml = upsertYamlField(yaml, "description", meta.description || baseName);
  const body = stripExistingGuard(split.body || String(rawContent || "").trim());
  return `---\n${yaml.trim()}\n---\n\n${guard}${body}`;
}

/**
 * 同步已启用的提示词文件到系统模板目录
 */
async function syncEnabledPrompts(settings) {
  const currentSettings = settings || (await pi.plugin.getSettings()) || DEFAULT_SETTINGS;
  const promptsDir = await resolvePromptsDir(currentSettings.directory);
  const scanResult = await scanPromptsDirectory(promptsDir);

  if (!scanResult.ok) {
    return { ok: false, error: scanResult.error, count: 0 };
  }

  const enabledMap = currentSettings.enabledFiles || {};
  const wsRoot = await getWorkspaceRoot();

  // 两个目标模板目录：
  // 1. 用户全局模板目录 ~/.pi/agent/prompts
  // 2. 工作区项目模板目录 <workspace>/.pi/prompts
  const targetDirs = [
    path.join(os.homedir(), ".pi", "agent", "prompts"),
  ];
  if (wsRoot && fs.existsSync(wsRoot)) {
    targetDirs.push(path.join(wsRoot, ".pi", "prompts"));
  }

  for (const dir of targetDirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
  }

  const newlySynced = [];
  const enabledFiles = scanResult.files.filter((f) => enabledMap[f.name] === true);

  // 同步每个启用的文件
  for (const file of enabledFiles) {
    try {
      const rawContent = fs.readFileSync(file.path, "utf8");
      const guardedContent = buildGuardedPromptContent(rawContent, file.name);

      for (const dir of targetDirs) {
        const destFile = path.join(dir, file.name);
        fs.writeFileSync(destFile, guardedContent, "utf8");
      }
      newlySynced.push(file.name);
    } catch (err) {
      // 单个文件写入失败不中断全局
    }
  }

  // 清理之前同步过但现在未启用的文件
  const prevSynced = currentSettings.syncedFiles || [];
  for (const prevName of prevSynced) {
    if (!newlySynced.includes(prevName)) {
      for (const dir of targetDirs) {
        const destFile = path.join(dir, prevName);
        try {
          if (fs.existsSync(destFile)) {
            // 校验是否由本插件写入
            const content = fs.readFileSync(destFile, "utf8");
            if (content.includes("PROMPT_SWITCHER_GUARD")) {
              fs.unlinkSync(destFile);
            }
          }
        } catch (_) {}
      }
    }
  }

  // 不再注册 /prompt-<文件名>：真正生效的是同步到原生模板后的 /<文件名>
  await unregisterPromptCommands([
    ...newlySynced,
    ...prevSynced,
    ...Object.keys(enabledMap),
    ...scanResult.files.map((f) => f.name),
  ]);

  // 保存最新的已同步清单
  await pi.plugin.setSettings({
    syncedFiles: newlySynced,
  });

  return { ok: true, count: newlySynced.length, files: newlySynced };
}

function promptCommandId(fileName) {
  const baseName = String(fileName || "").replace(/\.md$/i, "").trim();
  return baseName ? `prompt-${baseName}` : "";
}

/**
 * 卸载旧版动态注册的 /prompt-<文件名> 空命令，避免与原生 /<文件名> 模板重复且无效。
 */
async function unregisterPromptCommands(fileNames) {
  const ids = new Set(registeredCommandIds);
  for (const name of fileNames || []) {
    const id = promptCommandId(name);
    if (id) ids.add(id);
  }
  for (const cmdId of ids) {
    try {
      await pi.commands.unregister(cmdId);
    } catch (_) {}
  }
  registeredCommandIds.clear();
}

/**
 * 插件生命周期：加载
 */
async function onLoad() {
  // 初始化并合并配置
  let settings = (await pi.plugin.getSettings()) || {};
  if (!settings || typeof settings !== "object") {
    settings = { ...DEFAULT_SETTINGS };
    await pi.plugin.setSettings(settings);
  }

  // 注册打开面板命令
  await pi.commands.register({
    id: "open-prompt-switcher",
    title: "提示词切换: 打开设置面板",
    keywords: ["prompt", "switcher", "提示词", "设置", "面板"],
    category: "Chat",
    run: async () => {
      await pi.ui.openPanel({
        title: "提示词切换设置",
        width: 720,
        height: 660,
      });
    },
  });

  // 注册立即同步命令
  await pi.commands.register({
    id: "sync-prompt-switcher",
    title: "提示词切换: 立即同步已启用提示词",
    keywords: ["prompt", "sync", "同步", "刷新"],
    category: "Chat",
    run: async () => {
      const res = await syncEnabledPrompts();
      if (res.ok) {
        await pi.ui.showToast(`已成功同步 ${res.count} 个已启用提示词至模板库`);
      } else {
        await pi.ui.showToast(`同步失败: ${res.error}`, "error");
      }
    },
  });

  // 启动时自动执行一次扫描与同步
  try {
    await syncEnabledPrompts(settings);
  } catch (_) {}
}

/**
 * 插件生命周期：卸载
 */
async function onUnload() {
  try {
    await pi.commands.unregister("open-prompt-switcher");
    await pi.commands.unregister("sync-prompt-switcher");
    const settings = (await pi.plugin.getSettings()) || {};
    await unregisterPromptCommands([
      ...(settings.syncedFiles || []),
      ...Object.keys(settings.enabledFiles || {}),
    ]);
  } catch (_) {}
}

/**
 * 面板桥接处理函数 (由 renderer/index.html 通过 window.pluginBridge.invoke 调用)
 */
async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "getSettings": {
      const settings = (await pi.plugin.getSettings()) || DEFAULT_SETTINGS;
      const wsRoot = await getWorkspaceRoot();
      const resolvedDir = await resolvePromptsDir(settings.directory);
      return {
        ok: true,
        settings,
        workspaceRoot: wsRoot,
        resolvedDirectory: resolvedDir,
      };
    }

    case "saveSettings": {
      const current = (await pi.plugin.getSettings()) || DEFAULT_SETTINGS;
      const updated = {
        ...current,
        directory: typeof payload?.directory === "string" ? payload.directory : current.directory,
        enabledFiles: payload?.enabledFiles && typeof payload.enabledFiles === "object" ? payload.enabledFiles : current.enabledFiles,
      };
      await pi.plugin.setSettings(updated);
      const syncResult = await syncEnabledPrompts(updated);
      return {
        ok: true,
        settings: updated,
        syncResult,
      };
    }

    case "scanDirectory": {
      const dirToScan = payload?.directory ? await resolvePromptsDir(payload.directory) : await resolvePromptsDir();
      return scanPromptsDirectory(dirToScan);
    }

    case "syncNow": {
      const settings = (await pi.plugin.getSettings()) || DEFAULT_SETTINGS;
      return syncEnabledPrompts(settings);
    }

    case "requestDirectory": {
      try {
        if (typeof pi?.fs?.requestDirectory === "function") {
          const picked = await pi.fs.requestDirectory();
          if (picked && picked.path) {
            return { ok: true, path: picked.path, name: picked.name };
          }
        }
      } catch (err) {
        return { ok: false, error: err.message };
      }
      return { ok: false, error: "未选择目录" };
    }

    default:
      return { ok: false, error: `未知的操作指令: ${channel}` };
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
