"use strict";

/**
 * 后端选择：把「当前会话 + 装了哪些命令」映射成「用哪个工具干活」。
 *
 * 缺依赖时这里给出的错误文案就是用户看到的全部信息，所以要写清楚缺什么、装什么、
 * 以及在当前会话类型下这个工具到底能不能用。
 */

const fs = require("node:fs");
const { detectSession, which: defaultWhich, runtimeDir } = require("./session.js");

const PACKAGE_HINTS = {
  grim: "pacman -S grim（wlroots 系合成器）/ apt install grim",
  import: "pacman -S imagemagick / apt install imagemagick",
  scrot: "pacman -S scrot / apt install scrot",
  ydotool: "pacman -S ydotool / apt install ydotool，然后启动 ydotoold 守护进程",
  xdotool: "pacman -S xdotool / apt install xdotool",
  wtype: "pacman -S wtype / apt install wtype",
  wmctrl: "pacman -S wmctrl / apt install wmctrl",
};

function packageHint(bin) {
  return PACKAGE_HINTS[bin] ? `${bin}: ${PACKAGE_HINTS[bin]}` : `${bin} 未安装`;
}

/** ydotoold 的 socket 位置（ydotool 客户端靠它连守护进程） */
function ydotooldSocket(env = process.env) {
  if (env.YDOTOOL_SOCKET) return env.YDOTOOL_SOCKET;
  const candidates = ["/tmp/.ydotool_socket"];
  const rd = runtimeDir(env);
  if (rd) candidates.push(`${rd}/.ydotool_socket`);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isSocket()) return c;
    } catch {
      /* 不存在就继续找 */
    }
  }
  return null;
}

/**
 * 输入后端。
 * Wayland: ydotool（需要 ydotoold 在跑）> wtype（只能打文本）
 * X11:     xdotool
 */
function pickInputBackend(session, deps = {}) {
  const which = deps.which || defaultWhich;
  const env = deps.env || process.env;

  if (session.type === "wayland") {
    const ydotoolPath = which("ydotool", env);
    if (ydotoolPath) {
      const sock = ydotooldSocket(env);
      if (!sock) {
        return {
          kind: null,
          reason: "ydotoold_not_running",
          message: "已装 ydotool，但找不到 ydotoold 的 socket（/tmp/.ydotool_socket）。",
          hint:
            "Wayland 下注入输入必须先跑守护进程：systemctl --user start ydotoold，" +
            "或手动 `ydotoold &`（默认 socket 为 /tmp/.ydotool_socket）。",
        };
      }
      return { kind: "ydotool", bin: ydotoolPath, socket: sock, note: "ydotool（Wayland）" };
    }
    const wtypePath = which("wtype", env);
    if (wtypePath) {
      return {
        kind: "wtype",
        bin: wtypePath,
        note: "wtype（Wayland，只能输入文本，不能点鼠标/按组合键）",
      };
    }
    return {
      kind: null,
      reason: "no_input_backend",
      message: "Wayland 会话下既没有 ydotool 也没有 wtype，无法注入任何输入。",
      hint:
        packageHint("ydotool") +
        "。注意 xdotool 在 Wayland 下无效（只能作用于 XWayland 窗口，不是全局输入）。",
    };
  }

  if (session.type === "x11") {
    const xdotoolPath = which("xdotool", env);
    if (xdotoolPath) {
      return { kind: "xdotool", bin: xdotoolPath, note: "xdotool（X11）" };
    }
    return {
      kind: null,
      reason: "no_input_backend",
      message: "X11 会话下没有 xdotool，无法注入输入。",
      hint: packageHint("xdotool"),
    };
  }

  return {
    kind: null,
    reason: "no_graphical_session",
    message: `没有可用的图形会话（检测到 ${session.type}）。`,
    hint: "输入注入需要 X11 或 Wayland 会话；纯 tty / SSH 下不可用。",
  };
}

/**
 * 截图后端。
 * Wayland: grim；X11: ImageMagick 的 import 或 scrot。
 */
function pickScreenshotBackend(session, deps = {}) {
  const which = deps.which || defaultWhich;
  const env = deps.env || process.env;

  if (session.type === "wayland") {
    const grimPath = which("grim", env);
    if (grimPath) {
      return { kind: "grim", bin: grimPath, note: "grim（Wayland）" };
    }
    return {
      kind: null,
      reason: "no_screenshot_backend",
      message: "Wayland 会话下没有 grim，无法截图。",
      hint:
        packageHint("grim") +
        "。Wayland 出于安全设计不允许任意程序读屏，grim 走 wlr-screencopy 协议。",
    };
  }

  if (session.type === "x11") {
    const importPath = which("import", env);
    if (importPath) {
      return { kind: "import", bin: importPath, note: "ImageMagick import（X11）" };
    }
    const scrotPath = which("scrot", env);
    if (scrotPath) {
      return { kind: "scrot", bin: scrotPath, note: "scrot（X11）" };
    }
    return {
      kind: null,
      reason: "no_screenshot_backend",
      message: "X11 会话下既没有 import（ImageMagick）也没有 scrot，无法截图。",
      hint: `${packageHint("import")}；或 ${packageHint("scrot")}`,
    };
  }

  return {
    kind: null,
    reason: "no_graphical_session",
    message: `没有可用的图形会话（检测到 ${session.type}）。`,
    hint: "截图需要 X11 或 Wayland 会话。",
  };
}

function resolveEnvironment(deps = {}) {
  const session = deps.session || detectSession(deps.env || process.env);
  return {
    session,
    input: pickInputBackend(session, deps),
    screenshot: pickScreenshotBackend(session, deps),
  };
}

module.exports = {
  PACKAGE_HINTS,
  packageHint,
  ydotooldSocket,
  pickInputBackend,
  pickScreenshotBackend,
  resolveEnvironment,
};
