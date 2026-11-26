"use strict";

/**
 * 工具定义（JSON Schema + execute）。
 *
 * 语义约定：**只有 agent 显式调用某个工具时才会动作**。插件加载时不注册任何
 * 定时器、不监听输入、不在后台截图。
 */

const path = require("node:path");
const { CuError, asResult } = require("./errors.js");
const { resolveEnvironment } = require("./backends.js");
const { run, childEnv, which, detectSession } = require("./session.js");
const {
  planMove,
  planClick,
  planScroll,
  planType,
  planKey,
  BUTTONS,
} = require("./actions.js");
const {
  defaultOutDir,
  shotPath,
  planScreenshot,
  clampRegion,
  ensureDir,
  fileSize,
  probeScreenSize,
  readPngBase64,
} = require("./capture.js");

const MAX_INLINE_BYTES = 6 * 1024 * 1024;

/* ------------------------------------------------------------------ 运行时 */

function createRuntime(overrides = {}) {
  const env = overrides.env || process.env;
  const deps = { env, which: overrides.which || which };
  const resolved = overrides.environment || resolveEnvironment(deps);
  const exec = overrides.run || run;
  return {
    env,
    session: resolved.session,
    input: resolved.input,
    screenshot: resolved.screenshot,
    run: (argv, options) => exec(argv, { session: resolved.session, env: childEnv(resolved.session), ...options }),
    boundsCache: { at: 0, size: null },
    overrides,
    sleep: overrides.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    imeRestoreAttempts: overrides.imeRestoreAttempts || 20,
    imeRestoreDelayMs: overrides.imeRestoreDelayMs || 100,
  };
}

function requireBackend(backend, what) {
  if (backend && backend.kind) return backend;
  const message = backend && backend.message ? backend.message : `没有可用的${what}后端`;
  throw new CuError(backend && backend.reason ? backend.reason : "no_backend", message, backend && backend.hint);
}

function failRun(res, hint) {
  const detail = (res && (res.stderr || res.message)) || "命令执行失败";
  const code = res && res.code === "ENOENT" ? "dependency_missing" : "command_failed";
  throw new CuError(code, detail.trim().split("\n").slice(-3).join(" ").slice(0, 400), hint);
}

/** 屏幕尺寸（缓存 60s）；拿不到就返回 null，不阻断输入动作 */
function screenBounds(rt) {
  const now = Date.now();
  if (rt.boundsCache.size && now - rt.boundsCache.at < 60000) return rt.boundsCache.size;
  if (!rt.screenshot.kind) return null;
  const probe = probeScreenSize(rt.screenshot, rt.run, { dir: defaultOutDir(rt.env) });
  if (!probe.ok) return null;
  rt.boundsCache = { at: now, size: probe.size };
  return probe.size;
}

function validatePoint(rt, x, y) {
  for (const [name, value] of [
    ["x", x],
    ["y", y],
  ]) {
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value)) {
      throw new CuError("invalid_coordinate", `${name} 必须是整数，收到 ${JSON.stringify(value)}`);
    }
    if (value < 0) {
      throw new CuError("invalid_coordinate", `${name} 不能为负，收到 ${value}`);
    }
  }
  const bounds = screenBounds(rt);
  if (bounds && Number.isInteger(x) && Number.isInteger(y)) {
    if (x >= bounds.width || y >= bounds.height) {
      throw new CuError(
        "coordinate_out_of_bounds",
        `坐标 (${x}, ${y}) 超出屏幕范围 ${bounds.width}x${bounds.height}`,
        "坐标原点是屏幕左上角，x 取 0..width-1，y 取 0..height-1。"
      );
    }
  }
  return bounds;
}

function runAll(rt, commands) {
  const results = [];
  for (const argv of commands) {
    const res = rt.run(argv);
    results.push({ argv: argv.slice(0, 6), ok: res.ok, status: res.status });
    if (!res.ok) return { ok: false, res, results };
  }
  return { ok: true, results };
}

/* ------------------------------------------------------------------ 各工具 */

async function toolScreenshot(rt, args = {}) {
  const backend = requireBackend(rt.screenshot, "截图");
  const dir = args.dir ? path.resolve(String(args.dir)) : defaultOutDir(rt.env);
  ensureDir(dir);
  const bounds = args.region ? screenBounds(rt) : null;
  const region = clampRegion(args.region || null, bounds);
  const outPath = args.path ? path.resolve(String(args.path)) : shotPath(dir, args.label);

  const argv = planScreenshot(backend, outPath, region);
  const res = rt.run(argv);
  if (!res.ok) failRun(res, "截图命令失败");

  const bytes = fileSize(outPath);
  if (!bytes) {
    throw new CuError("empty_capture", "截图命令返回成功，但没有生成文件。", "检查输出路径是否可写。");
  }

  const out = {
    ok: true,
    path: outPath,
    bytes,
    backend: backend.kind,
    sessionType: rt.session.type,
    region: region || null,
  };

  const png = readPngBase64(outPath);
  if (png && png.size) {
    out.width = png.size.width;
    out.height = png.size.height;
  }
  const inline = args.inline !== false;
  if (inline && bytes <= MAX_INLINE_BYTES && png) {
    out.images = [{ data: png.data, mimeType: "image/png" }];
  } else if (inline) {
    out.inlineSkipped = `截图 ${bytes} 字节，超过 ${MAX_INLINE_BYTES} 的内联上限，只返回路径`;
  }
  return out;
}

async function toolMouseMove(rt, args = {}) {
  const backend = requireBackend(rt.input, "输入");
  if (backend.kind === "wtype") {
    throw new CuError(
      "unsupported_on_backend",
      "当前只有 wtype，它只能输入文本，不能移动鼠标。",
      "装 ydotool 并启动 ydotoold 才能控制鼠标。"
    );
  }
  validatePoint(rt, args.x, args.y);
  const cmds = planMove(backend, args);
  const r = runAll(rt, cmds);
  if (!r.ok) failRun(r.res);
  return { ok: true, action: "mouse_move", x: args.x, y: args.y, backend: backend.kind };
}

async function toolMouseClick(rt, args = {}) {
  const backend = requireBackend(rt.input, "输入");
  if (backend.kind === "wtype") {
    throw new CuError(
      "unsupported_on_backend",
      "当前只有 wtype，它只能输入文本，不能点击鼠标。",
      "装 ydotool 并启动 ydotoold 才能控制鼠标。"
    );
  }
  if (args.x !== undefined || args.y !== undefined) {
    if (args.x === undefined || args.y === undefined) {
      throw new CuError("invalid_coordinate", "给了 x 就必须同时给 y。");
    }
    validatePoint(rt, args.x, args.y);
  }
  const cmds = planClick(backend, args);
  const r = runAll(rt, cmds);
  if (!r.ok) failRun(r.res);
  return {
    ok: true,
    action: "mouse_click",
    button: args.button || "left",
    count: args.count || 1,
    x: args.x,
    y: args.y,
    backend: backend.kind,
  };
}

async function toolMouseScroll(rt, args = {}) {
  const backend = requireBackend(rt.input, "输入");
  try {
    const cmds = planScroll(backend, args);
    const r = runAll(rt, cmds);
    if (!r.ok) failRun(r.res);
    return {
      ok: true,
      action: "mouse_scroll",
      direction: args.direction || "down",
      amount: args.amount || 1,
      backend: backend.kind,
    };
  } catch (err) {
    if (err && err.unsupported) {
      throw new CuError("unsupported_on_backend", "当前后端不支持滚轮。", err.hint);
    }
    throw err;
  }
}

async function toolTypeText(rt, args = {}) {
  const backend = requireBackend(rt.input, "输入");
  const text = args.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new CuError("invalid_argument", "text 必须是非空字符串。");
  }
  if (text.length > 20000) {
    throw new CuError("invalid_argument", "text 超过 20000 字符，请分段输入。");
  }
  const guarded = rt.session.type === "wayland" && inputMethodRunning(rt);
  if (guarded && args.allowImeSuspend !== true) {
    throw new CuError(
      "input_blocked_by_ime",
      "fcitx5 正在运行；未显式允许暂时暂停输入法，因此未执行输入。",
      "仅在可接受输入法短暂中断及状态变化时，显式传 allowImeSuspend: true。"
    );
  }
  if (!guarded) {
    const r = runAll(rt, planType(backend, args));
    if (!r.ok) failRun(r.res);
    return { ok: true, action: "type_text", chars: text.length, backend: backend.kind, imeSuspended: false, imeRestored: true };
  }

  let suspended = false;
  let inputError;
  let restored = false;
  try {
    const stopped = rt.run(["pkill", "-x", "fcitx5"]);
    suspended = true;
    if (!stopped.ok) throw new CuError("input_blocked_by_ime", "无法确认 fcitx5 已暂停，未执行输入。", "检查 pkill 权限及 fcitx5 进程状态。");
    if (inputMethodRunning(rt)) throw new CuError("input_blocked_by_ime", "fcitx5 主进程仍在运行，未执行输入。", "检查 fcitx5 是否可被当前用户停止。");
    const r = runAll(rt, planType(backend, args));
    if (!r.ok) failRun(r.res);
  } catch (err) {
    inputError = err;
  } finally {
    restored = await restoreInputMethod(rt);
  }

  if (!restored) {
    throw new CuError("ime_restore_failed", "fcitx5 未能确认恢复；请立即执行恢复命令。", "恢复后输入法状态未知，可能需要手动切回原中英状态。", {
      recoveryCommand: "fcitx5 -d --replace",
      imeSuspended: suspended,
      imeRestored: false,
    });
  }
  if (inputError) throw inputError;
  return {
    ok: true, action: "type_text", chars: text.length, backend: backend.kind,
    imeSuspended: true, imeRestored: true,
    warning: "fcitx5 已重启；中英/输入法状态未知，可能与调用前不同。",
  };
}

function inputMethodProcesses(rt) {
  const result = rt.run(["pgrep", "-a", "-x", "fcitx5"]);
  if (!result.ok) return [];
  return (result.stdout || "").split("\n").filter((line) => /^\s*\d+\s+fcitx5(?:\s|$)/.test(line));
}

function inputMethodRunning(rt) {
  return inputMethodProcesses(rt).length > 0;
}

async function restoreInputMethod(rt) {
  rt.run(["nohup", "fcitx5", "-d", "--replace"]);
  for (let attempt = 0; attempt < rt.imeRestoreAttempts; attempt++) {
    const main = inputMethodProcesses(rt);
    const backend = rt.run(["pgrep", "-a", "-f", "^fcitx5-.*(?: |$)"]);
    if (main.length && backend.ok && (backend.stdout || "").trim()) return true;
    await rt.sleep(rt.imeRestoreDelayMs);
  }
  return false;
}


async function toolKeyPress(rt, args = {}) {
  const backend = requireBackend(rt.input, "输入");
  if (rt.session.type === "wayland" && inputMethodRunning(rt)) {
    throw new CuError(
      "input_blocked_by_ime",
      "fcitx5 正在运行；Wayland 合成组合键未能可靠到达目标窗口。",
      "使用应用自身的快捷键入口，或关闭 fcitx5 后重试。"
    );
  }
  const cmds = planKey(backend, args);
  const r = runAll(rt, cmds);
  if (!r.ok) failRun(r.res);
  const keys = Array.isArray(args.keys) ? args.keys : [args.key];
  return { ok: true, action: "key_press", keys, backend: backend.kind };
}

function windowListX11(rt) {
  const wmctrl = which("wmctrl", rt.env);
  if (wmctrl) {
    const res = rt.run([wmctrl, "-l"]);
    if (!res.ok) failRun(res);
    const windows = res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\S+)\s+(.*)$/);
        if (!m) return { raw: line };
        return {
          id: m[1],
          desktop: Number(m[2]),
          host: m[3],
          title: m[4],
        };
      });
    return { ok: true, backend: "wmctrl", windows };
  }
  const xdotool = which("xdotool", rt.env);
  if (xdotool) {
    const ids = rt.run([xdotool, "search", "--onlyvisible", "--name", ""]);
    if (!ids.ok) failRun(ids);
    const windows = ids.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200)
      .map((id) => {
        const name = rt.run([xdotool, "getwindowname", id]);
        return { id, title: name.ok ? name.stdout.trim() : null };
      });
    return { ok: true, backend: "xdotool", windows };
  }
  throw new CuError(
    "no_window_backend",
    "X11 下需要 wmctrl 或 xdotool 才能列出窗口，两者都没有装。",
    "pacman -S wmctrl（或 xdotool）"
  );
}

function windowListNiri(rt) {
  const niri = which("niri", rt.env);
  if (!niri) return null;
  const res = rt.run([niri, "msg", "--json", "windows"]);
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout || "[]");
    return {
      ok: true,
      backend: "niri",
      windows: parsed.map((w) => ({
        id: w.id,
        title: w.title,
        app_id: w.app_id,
        workspace_id: w.workspace_id,
        is_focused: w.is_focused,
      })),
    };
  } catch {
    return null;
  }
}

async function toolWindowList(rt) {
  if (rt.session.type === "x11") return windowListX11(rt);
  if (rt.session.type === "wayland") {
    const niri = windowListNiri(rt);
    if (niri) return niri;
    throw new CuError(
      "no_window_backend",
      "Wayland 不提供窗口枚举的通用协议，当前合并不是 niri（或 niri CLI 不可用），无法列出窗口。",
      "可用 screenshot 看整屏；X11 会话下可用 wmctrl。这也是 Wayland 的既有设计限制，不是插件缺陷。"
    );
  }
  throw new CuError("no_graphical_session", `没有图形会话（${rt.session.type}）。`);
}

async function toolScreenInfo(rt) {
  const size = rt.screenshot.kind ? screenBounds(rt) : null;
  const deps = {};
  for (const bin of ["grim", "import", "scrot", "ydotool", "xdotool", "wtype", "wmctrl", "niri"]) {
    deps[bin] = Boolean(which(bin, rt.env));
  }
  return {
    ok: true,
    sessionType: rt.session.type,
    evidence: rt.session.evidence,
    display: {
      wayland: rt.session.waylandDisplay,
      x11: rt.session.x11Display,
      runtimeDir: rt.session.xdgRuntimeDir,
    },
    screen: size ? { width: size.width, height: size.height } : null,
    screenshotBackend: rt.screenshot.kind || null,
    screenshotReason: rt.screenshot.kind ? null : rt.screenshot.message,
    inputBackend: rt.input.kind || null,
    inputNote: rt.input.note || null,
    inputReason: rt.input.kind ? null : rt.input.message,
    inputHint: rt.input.kind ? null : rt.input.hint,
    deps,
  };
}

/* ------------------------------------------------------------------ 描述符 */

const SCHEMA_POINT = {
  type: "object",
  properties: {
    x: { type: "integer", minimum: 0, description: "屏幕左上角为原点的 x 像素坐标" },
    y: { type: "integer", minimum: 0, description: "屏幕左上角为原点的 y 像素坐标" },
  },
};

const TOOL_DEFS = [
  {
    name: "cu_screenshot",
    description:
      "截取当前桌面屏幕（可选区域），保存为 PNG 并返回文件路径；同时把图片内联返回给模型。" +
      "Wayland 用 grim，X11 用 ImageMagick import 或 scrot。",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "保存路径（可选，默认写到系统临时目录）" },
        label: { type: "string", description: "文件名标签，便于区分多张截图" },
        inline: {
          type: "boolean",
          description: "是否把图片数据内联返回（默认 true；只想要路径时设 false）",
        },
        region: {
          type: "object",
          description: "可选：只截取一块区域",
          properties: {
            x: { type: "integer", minimum: 0 },
            y: { type: "integer", minimum: 0 },
            width: { type: "integer", minimum: 1 },
            height: { type: "integer", minimum: 1 },
          },
          required: ["x", "y", "width", "height"],
        },
      },
    },
    execute: toolScreenshot,
  },
  {
    name: "cu_mouse_move",
    description:
      "把鼠标移到绝对坐标 (x, y)。坐标以屏幕左上角为原点，单位像素。" +
      "Wayland 用 ydotool（需 ydotoold），X11 用 xdotool。",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: 0, description: "x 像素坐标" },
        y: { type: "integer", minimum: 0, description: "y 像素坐标" },
      },
      required: ["x", "y"],
    },
    execute: toolMouseMove,
  },
  {
    name: "cu_mouse_click",
    description:
      "点击鼠标。可选先移动到 (x, y)；支持左/中/右键与单击/双击/三击。",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: 0, description: "可选：点击前先移动到的 x" },
        y: { type: "integer", minimum: 0, description: "可选：点击前先移动到的 y" },
        button: { type: "string", enum: BUTTONS, description: "鼠标键，默认 left" },
        count: { type: "integer", minimum: 1, maximum: 3, description: "点击次数，默认 1（2=双击）" },
      },
    },
    execute: toolMouseClick,
  },
  {
    name: "cu_mouse_scroll",
    description: "滚轮滚动。Wayland 的 ydotool 1.x 没有滚轮子命令，此工具在 Wayland 下会返回不支持。",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"], description: "滚动方向" },
        amount: { type: "integer", minimum: 1, maximum: 20, description: "滚动格数，默认 1" },
        x: { type: "integer", minimum: 0, description: "可选：滚动前先把指针移到该 x" },
        y: { type: "integer", minimum: 0, description: "可选：滚动前先把指针移到该 y" },
      },
      required: ["direction"],
    },
    execute: toolMouseScroll,
  },
  {
    name: "cu_type_text",
    description:
      "把一段文本输入到当前焦点窗口（不经过剪贴板）。Unicode 文本由 ydotool type / xdotool type 处理。",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要输入的文本，最多 20000 字符" },
        delayMs: { type: "integer", minimum: 0, maximum: 2000, description: "可选：X11 下每个字符之间的延时毫秒" },
        allowImeSuspend: { type: "boolean", description: "默认 false。Wayland + fcitx5 时仅 true 才会短暂暂停并重启 fcitx5；输入法状态可能变化。" },
      },
      required: ["text"],
    },
    execute: toolTypeText,
  },
  {
    name: "cu_key_press",
    description:
      '按下一个组合键，例如 "ctrl+c"、"ctrl+shift+t"、"Return"、"Escape"。' +
      "一次可给多个按键依次按下（keys 数组）。",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        key: { type: "string", description: '单个组合键，如 "ctrl+c"' },
        keys: {
          type: "array",
          items: { type: "string" },
          description: '依次按下的组合键数组，如 ["ctrl+a", "Delete"]',
        },
      },
    },
    execute: toolKeyPress,
  },
  {
    name: "cu_screen_info",
    description:
      "只读探测：会话类型（X11/Wayland）、屏幕尺寸、当前可用的截图与输入后端、以及各依赖是否安装。" +
      "在动手前先用它确认环境。",
    risk: "low",
    schema: { type: "object", properties: {} },
    execute: toolScreenInfo,
  },
  {
    name: "cu_window_list",
    description: "列出当前窗口标题与 id。X11 用 wmctrl/xdotool；Wayland 仅在 niri 下可用。",
    risk: "low",
    schema: { type: "object", properties: {} },
    execute: toolWindowList,
  },
];

function descriptor(def) {
  return {
    name: def.name,
    description: def.description,
    risk: def.risk,
    schema: def.schema,
  };
}

/** 生成注册到宿主用的 execute（构造错误一律回成结构化结果，不让宿主看到裸异常） */
function makeExecutor(def, runtimeFactory) {
  return (args) => asResult(() => def.execute(runtimeFactory(), args || {}));
}

module.exports = {
  MAX_INLINE_BYTES,
  TOOL_DEFS,
  SCHEMA_POINT,
  createRuntime,
  descriptor,
  makeExecutor,
  toolScreenshot,
  toolMouseMove,
  toolMouseClick,
  toolMouseScroll,
  toolTypeText,
  toolKeyPress,
  toolScreenInfo,
  toolWindowList,
};
