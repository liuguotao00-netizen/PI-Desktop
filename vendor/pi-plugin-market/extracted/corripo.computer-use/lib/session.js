"use strict";

/**
 * 会话探测 + 可执行文件查找 + 子进程执行。
 *
 * 为什么不直接读 process.env：PI-Desktop 把插件进程跑在一个不保证带宿主环境变量
 * 的隔离进程里。所以这里做「先信 env，缺了就自己推」：
 *   - XDG_RUNTIME_DIR 缺省为 /run/user/<uid>
 *   - WAYLAND_DISPLAY 缺省从 /run/user/<uid>/wayland-* 里挑一个
 *   - DISPLAY 缺省从 /tmp/.X11-unix/X* 里挑一个
 * 推出结论后，再把这些变量显式注入子进程，grim/ydotool 才认得路。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const FALLBACK_PATH = [
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/local/sbin",
  "/usr/sbin",
  "/sbin",
  "/run/current-system/sw/bin",
];

function uid() {
  try {
    return typeof process.getuid === "function" ? process.getuid() : null;
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function socketCandidates(dir, prefix) {
  return listDir(dir)
    .filter((e) => e.name.startsWith(prefix))
    .map((e) => e.name)
    .filter((n) => !n.endsWith(".lock"))
    .sort();
}

function runtimeDir(env = process.env) {
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
  const id = uid();
  return id === null ? null : `/run/user/${id}`;
}

function waylandDisplay(env = process.env) {
  if (env.WAYLAND_DISPLAY) return env.WAYLAND_DISPLAY;
  const dir = runtimeDir(env);
  if (!dir) return null;
  const found = socketCandidates(dir, "wayland-");
  return found.length ? found[found.length - 1] : null;
}

function x11Display(env = process.env) {
  if (env.DISPLAY) return env.DISPLAY;
  const found = listDir("/tmp/.X11-unix")
    .map((e) => e.name)
    .filter((n) => /^X\d+$/.test(n))
    .map((n) => ":" + n.slice(1))
    .sort();
  return found.length ? found[found.length - 1] : null;
}

/**
 * 判定会话类型。显式 env 优先；没有 env 就靠 socket 存在性推断：
 * 同时存在 Wayland 与 XWayland 时，以 XDG_SESSION_TYPE=wayland 的语义优先 Wayland
 * （XWayland 只是兼容层，注入到 Wayland 会话才有效）。
 */
function detectSession(env = process.env) {
  const declared = (env.XDG_SESSION_TYPE || "").trim().toLowerCase();
  const wl = waylandDisplay(env);
  const x11 = x11Display(env);
  const evidence = [];

  let type;
  if (declared === "wayland" || declared === "x11" || declared === "tty") {
    type = declared;
    evidence.push(`XDG_SESSION_TYPE=${declared}`);
  } else if (wl) {
    type = "wayland";
    evidence.push(`wayland socket ${wl}`);
  } else if (x11) {
    type = "x11";
    evidence.push(`x11 socket ${x11}`);
  } else {
    type = "unknown";
    evidence.push("no wayland socket, no x11 socket");
  }

  if (wl) evidence.push(`wayland socket ${wl}`);
  if (x11) evidence.push(`x11 socket ${x11}`);

  return {
    type, // wayland | x11 | tty | unknown
    waylandDisplay: wl,
    x11Display: x11,
    xdgRuntimeDir: runtimeDir(env),
    evidence,
  };
}

function searchPath(env = process.env) {
  const fromEnv = (env.PATH || "").split(":").filter(Boolean);
  return fromEnv.length ? fromEnv : FALLBACK_PATH;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function which(bin, env = process.env) {
  if (!bin || bin.includes("/")) {
    return isExecutable(bin) ? bin : null;
  }
  for (const dir of searchPath(env)) {
    const full = path.join(dir, bin);
    if (isExecutable(full)) return full;
  }
  return null;
}
/**
 * niri 的 IPC socket。`niri msg` 靠 NIRI_SOCKET 找合成器；
 * 插件进程不保证带这个变量，所以从运行目录里按名字找。
 */
function niriSocket(env = process.env) {
  if (env.NIRI_SOCKET) return env.NIRI_SOCKET;
  const dir = runtimeDir(env);
  if (!dir) return null;
  const found = socketCandidates(dir, "niri.");
  return found.length ? `${dir}/${found[0]}` : null;
}

function childEnv(session, extra) {
  const env = {
    PATH: searchPath().join(":"),
    HOME: os.homedir(),
    LANG: process.env.LANG || "C.UTF-8",
  };
  if (session && session.xdgRuntimeDir) env.XDG_RUNTIME_DIR = session.xdgRuntimeDir;
  if (session && session.waylandDisplay) env.WAYLAND_DISPLAY = session.waylandDisplay;
  if (session && session.x11Display) env.DISPLAY = session.x11Display;
  if (process.env.XAUTHORITY) env.XAUTHORITY = process.env.XAUTHORITY;
  if (process.env.YDOTOOL_SOCKET) env.YDOTOOL_SOCKET = process.env.YDOTOOL_SOCKET;
  const niri = niriSocket(process.env);
  if (niri) env.NIRI_SOCKET = niri;
  return Object.assign(env, extra || {});
}

/**
 * 跑一个命令。永远不抛异常：把 exitCode / stdout / stderr / 超时 都交给调用者判断，
 * 这样「缺依赖」「权限被拒」「没有这个参数」可以被区分开。
 */
function run(argv, options = {}) {
  const [bin, ...args] = argv;
  const res = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: options.timeoutMs || 15000,
    env: options.env || childEnv(options.session),
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
  });
  if (res.error) {
    return {
      ok: false,
      code: res.error.code || "spawn_failed",
      message: String(res.error.message || res.error),
      stdout: "",
      stderr: "",
      status: null,
    };
  }
  return {
    ok: res.status === 0,
    code: res.status === 0 ? null : "exit_" + res.status,
    message: null,
    status: res.status,
    stdout: res.stdout || "",
    stderr: (res.stderr || "").trim(),
  };
}

module.exports = {
  FALLBACK_PATH,
  detectSession,
  which,
  searchPath,
  runtimeDir,
  niriSocket,
  waylandDisplay,
  x11Display,
  childEnv,
  run,
  isExecutable,
};
