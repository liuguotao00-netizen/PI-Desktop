"use strict";

/**
 * 终端 — PI-Desktop 插件主进程
 *
 * 插件 id: pi.terminal
 * 视图:    contributes.views[0] → renderer/index.html（右侧工作面板）
 *
 * ── PTY 从哪来 ──────────────────────────────────────────────────────────
 * 插件包必须零 npm 依赖，而宿主进程（以及插件进程）没有控制终端，
 * macOS 的 script(1) 在这里会直接失败（它要对**自己的 stdin** 做
 * tcgetattr）。所以 PTY 由插件自带的 bin/pty-bridge.py 提供：
 *
 *   /usr/bin/python3 bin/pty-bridge.py ROWS COLS SHELL
 *     stdin  → pty（用户键入）
 *     stdout ← pty（shell 输出，原样字节流）
 *     fd3    ← 控制命令（"resize COLS ROWS" → ioctl TIOCSWINSZ，
 *               内核自动给前台进程组发 SIGWINCH，vim/htop 跟着重排）
 *
 * pty.fork() 之后 exec 指定的 shell（-il，交互 + 登录），所以
 * zsh/bash/fish 的补全、主题、钩子全部照常。找不到 python3 时退化为
 * 管道直连 shell（无 pty：没有回显、TUI 不可用，仅应急）。
 *
 * Finder/GUI 启动的应用 PATH 很短（/usr/bin:/bin:…），Homebrew 装的
 * fish 等工具会被「command not found」——这里给子进程的 PATH 统一前置
 * /opt/homebrew/bin 与 /usr/local/bin。
 *
 * ── 多会话 ──────────────────────────────────────────────────────────────
 * 一个视图实例（宿主限制：每个插件视图只有一份）里可以开多个终端标签，
 * 每个标签对应这里的一个独立会话（各自的 pty 与 shell）。所有 term.*
 * 通道都带 sid；term.new / term.close 增删会话；term.restart 在**同一个
 * sid** 上换新 shell（标签身份不变）。
 *
 * ── 输出怎么到视图 ──────────────────────────────────────────────────────
 * 宿主没有「插件 → 面板」的推送通道，所以本插件自己起一个仅回环
 * （127.0.0.1，随机端口）的 HTTP 服务：
 *   · 输出 → SSE GET /stream?token=…&sid=…&cursor=N（断线重连从 cursor
 *     续传，缓冲池每会话 2 MiB；SSE 被环境拦下时视图自动退回轮询）
 *   · 输入 / 重排 / 新建 / 关闭 / 重启 → bridge.invoke（term.* 通道）
 * 每个请求都必须带 token（每次插件进程启动随机生成，只经宿主桥交给本
 * 插件自己的沙箱视图），远端地址必须是回环。SSE 响应带
 * Access-Control-Allow-Origin: *——面板页是 file:// 沙箱（origin null），
 * 没有这个头 EventSource 会被跨域策略整个拦掉。
 *
 * 通道：视图 window.pluginBridge.invoke("term.*", payload) → onPanelInvoke。
 */

const { spawn } = require("node:child_process");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ── 上限 ────────────────────────────────────────────────────────────────────

/** 每个会话的输出环形缓冲上限；超过就从头上丢（cursor 语义 = 全局字节偏移）。 */
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
/** 单次 term.input 的最大字符数。 */
const MAX_INPUT_CHARS = 64 * 1024;
/** 单次 term.poll 最多带回去的字节数。 */
const MAX_POLL_BYTES = 256 * 1024;
/** SSE 保活注释间隔。 */
const KEEPALIVE_MS = 15000;
/** SIGKILL 前等旧会话退出的时间。 */
const RESTART_GRACE_MS = 500;
/** 会话数上限（防止手滑开太多）。 */
const MAX_SESSIONS = 8;

const COLS_RANGE = [2, 500];
const ROWS_RANGE = [2, 300];

// ── 模块状态 ────────────────────────────────────────────────────────────────

/** 只给本插件视图的接入令牌；插件进程每次启动重新生成。 */
let accessToken = crypto.randomBytes(24).toString("hex");
let httpServer = null;
let serverReady = null;
/** sid → 会话。 */
const sessions = new Map();
let sessionCounter = 0;

// ── 错误 ────────────────────────────────────────────────────────────────────

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function toFailure(error) {
  return {
    ok: false,
    code: typeof error?.code === "string" ? error.code : "INTERNAL",
    message: String(error?.message ?? error),
  };
}

// ── 环境 ────────────────────────────────────────────────────────────────────

/** GUI 应用的 PATH 很短；给 shell 子进程前置常见的 Homebrew / local 路径。 */
function childPath() {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"];
  const current = process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
  const seen = new Set();
  const parts = [];
  for (const dir of [...extra, ...current.split(path.delimiter)]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    parts.push(dir);
  }
  return parts.join(path.delimiter);
}

function executable(target) {
  try {
    fs.accessSync(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pickShell() {
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash"];
  for (const candidate of candidates) {
    if (candidate && candidate.trim() && executable(candidate.trim())) return candidate.trim();
  }
  return "/bin/bash";
}

/** 外部传入的 shell 路径必须真实存在且可执行，否则回退默认。 */
function pickShellPath(requested) {
  if (typeof requested === "string" && requested.startsWith("/") && executable(requested)) {
    return requested;
  }
  return pickShell();
}

/**
 * 探测系统里可用的 shell（供工具栏下拉框）。按常见位置扫一遍：
 * 系统自带 + Homebrew（Apple silicon / Intel）+ 用户当前 shell。
 */
function detectShells() {
  const candidates = [
    process.env.SHELL,
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
    "/opt/homebrew/bin/fish",
    "/usr/local/bin/fish",
    "/usr/bin/fish",
    "/opt/homebrew/bin/bash",
    "/usr/local/bin/bash",
    "/opt/homebrew/bin/dash",
    "/opt/homebrew/bin/tcsh",
  ];
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const clean = candidate && candidate.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    if (executable(clean)) out.push({ path: clean, name: path.basename(clean) });
  }
  return out;
}

function clampDim(value, [min, max]) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

async function currentCwd() {
  try {
    const workspace = await pi.workspace.get();
    if (workspace?.path) return workspace.path;
  } catch {
    /* 没有打开的项目 → 回退家目录 */
  }
  return os.homedir();
}

// ── 会话 ────────────────────────────────────────────────────────────────────

function spawnSession(cwd, cols, rows, shellPath) {
  const shell = pickShellPath(shellPath);
  const python = findPython();
  const bridgeScript = path.join(__dirname, "bin", "pty-bridge.py");
  sessionCounter += 1;

  const s = {
    id: crypto.randomBytes(8).toString("hex"),
    label: `${path.basename(shell)} ${sessionCounter}`,
    shell,
    cwd,
    child: null,
    /** "python" = pty 桥；"pipe" = 无 pty 直连（降级）。 */
    mode: python ? "python" : "pipe",
    control: null,
    exited: false,
    exitCode: null,
    chunks: [],
    bufferedBytes: 0,
    /** 缓冲区头部对应的全局偏移：头部块被丢弃后增长。 */
    baseOffset: 0,
    totalWritten: 0,
    clients: new Set(),
  };

  const env = {
    ...process.env,
    PATH: childPath(),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };

  try {
    if (s.mode === "python") {
      // stdio 第 4 个（fd3）是控制通道：resize 等命令
      s.child = spawn(python, [bridgeScript, String(rows), String(cols), shell], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
      s.control = s.child.stdio[3];
    } else {
      s.child = spawn(shell, [], { cwd, env });
    }

    const onData = (buf) => appendChunk(s, buf);
    s.child.stdout?.on("data", onData);
    s.child.stderr?.on("data", onData);
  } catch (error) {
    s.exited = true;
    s.exitCode = -1;
    appendChunk(s, Buffer.from(`\r\n[pi.terminal] 无法启动 shell: ${error?.message ?? error}\r\n`, "utf8"));
    return s;
  }

  s.child.on("error", (error) => {
    if (s.exited) return;
    s.exited = true;
    s.exitCode = -1;
    appendChunk(
      s,
      Buffer.from(`\r\n[pi.terminal] shell 进程错误: ${error?.message ?? error}\r\n`, "utf8"),
    );
    if (sessions.get(s.id) === s) broadcast(s, { t: "x", code: s.exitCode });
  });

  s.child.on("close", (code) => {
    if (s.exited) return;
    s.exited = true;
    s.exitCode = typeof code === "number" ? code : null;
    // 被 restart / close 换掉的会话不再向（已被新会话接管的）客户端报退出
    if (sessions.get(s.id) === s) broadcast(s, { t: "x", code: s.exitCode });
  });

  return s;
}

/** 依次探测可用的 python3（Finder 启动的 app PATH 很短，不能只靠 PATH）。 */
function findPython() {
  if (process.platform === "win32") return null;
  const candidates = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"];
  return candidates.find(executable) ?? null;
}

function appendChunk(s, buf) {
  if (!buf || buf.length === 0) return;
  s.chunks.push(buf);
  s.bufferedBytes += buf.length;
  s.totalWritten += buf.length;

  while (s.bufferedBytes > MAX_BUFFER_BYTES && s.chunks.length > 1) {
    const dropped = s.chunks.shift();
    s.bufferedBytes -= dropped.length;
    s.baseOffset += dropped.length;
  }

  if (s.clients.size > 0) {
    const frame = sseOutFrame(buf);
    for (const client of s.clients) {
      try {
        client.res.write(frame);
      } catch {
        /* 写挂了的连接由 close 事件负责清理 */
      }
    }
  }
}

/** cursor（全局字节偏移）之后的缓冲块；丢了头的部分只能给到缓冲区里还留着的。 */
function chunksAfter(s, cursor) {
  const from = Math.max(Number(cursor) || 0, s.baseOffset);
  if (from >= s.totalWritten) return [];
  const out = [];
  let position = s.baseOffset;
  for (const chunk of s.chunks) {
    const end = position + chunk.length;
    if (end > from) {
      const startInChunk = Math.max(0, from - position);
      out.push(chunk.subarray(startInChunk));
    }
    position = end;
  }
  return out;
}

function killSession(s, signal = "SIGKILL") {
  if (!s || s.exited || !s.child) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        s.child?.kill("SIGKILL");
      } catch {
        /* 已经死了 */
      }
      resolve();
    }, RESTART_GRACE_MS);
    s.child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      s.child.kill(signal);
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function sessionInfo(s) {
  return {
    sid: s.id,
    label: s.label,
    shell: s.shell,
    cwd: s.cwd,
    mode: s.mode,
    exited: s.exited,
    exitCode: s.exitCode,
  };
}

/** 取会话：sid 优先；不带 sid（旧视图/兜底）给第一个。 */
function getSession(sid) {
  if (sid && sessions.has(sid)) return sessions.get(sid);
  if (!sid) return [...sessions.values()][0] ?? null;
  return null;
}

// ── SSE 服务 ────────────────────────────────────────────────────────────────

function sseOutFrame(buf) {
  return `data: ${JSON.stringify({ t: "o", d: buf.toString("base64") })}\n\n`;
}

function sseJsonFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function broadcast(s, payload) {
  const frame = sseJsonFrame(payload);
  for (const client of s.clients) {
    try {
      client.res.write(frame);
    } catch {
      /* 忽略 */
    }
  }
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function ensureServer() {
  if (httpServer) return Promise.resolve(httpServer.address().port);
  if (!serverReady) {
    serverReady = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => handleStream(req, res));
      server.on("error", (error) => {
        serverReady = null;
        reject(error);
      });
      server.listen(0, "127.0.0.1", () => {
        httpServer = server;
        resolve(server.address().port);
      });
      const keepalive = setInterval(() => {
        if (!httpServer) {
          clearInterval(keepalive);
          return;
        }
        for (const s of sessions.values()) {
          for (const client of s.clients) {
            try {
              client.res.write(": ka\n\n");
            } catch {
              /* 忽略 */
            }
          }
        }
      }, KEEPALIVE_MS);
      keepalive.unref();
    });
  }
  return serverReady;
}

function handleStream(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch {
    res.writeHead(400).end();
    return;
  }

  if (req.method !== "GET" || url.pathname !== "/stream") {
    res.writeHead(404).end();
    return;
  }
  if (!isLoopback(req.socket?.remoteAddress ?? "") || url.searchParams.get("token") !== accessToken) {
    res.writeHead(403).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Access-Control-Allow-Origin": "*",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 1000\n\n");

  // 每条流绑定一个会话（sid）；会话没了只发 wait，让视图自行处理。
  const s = getSession(url.searchParams.get("sid") || undefined);
  const client = { res };
  if (s) {
    for (const chunk of chunksAfter(s, Number(url.searchParams.get("cursor")) || 0)) {
      res.write(sseOutFrame(chunk));
    }
    if (s.exited) res.write(sseJsonFrame({ t: "x", code: s.exitCode }));
    s.clients.add(client);
  } else {
    // 还没有会话：视图收到 wait 后会走 term.new / hello 建会话并重连
    res.write(sseJsonFrame({ t: "wait" }));
  }
  req.on("close", () => {
    s?.clients.delete(client);
  });
}

// ── 通道 ────────────────────────────────────────────────────────────────────

/** 视图打开：拿端口/token + 现存会话列表 + 可选 shell 列表；必要时建第一个会话。 */
async function handleHello() {
  if (sessions.size === 0) {
    const s = spawnSession(await currentCwd(), 80, 24, pickShell());
    sessions.set(s.id, s);
  }
  const port = await ensureServer();
  return {
    ok: true,
    port,
    token: accessToken,
    sessions: [...sessions.values()].map(sessionInfo),
    shells: detectShells(),
    defaultShell: pickShell(),
  };
}

/** 新建一个终端会话（新标签）。 */
async function handleNew(payload) {
  if (sessions.size >= MAX_SESSIONS) {
    throw fail("TOO_MANY", `at most ${MAX_SESSIONS} terminal sessions`);
  }
  const cols = clampDim(payload?.cols, COLS_RANGE) ?? 80;
  const rows = clampDim(payload?.rows, ROWS_RANGE) ?? 24;
  const s = spawnSession(await currentCwd(), cols, rows, payload?.shell);
  sessions.set(s.id, s);
  return { ok: true, ...sessionInfo(s) };
}

/** 关闭一个会话（关标签）。 */
async function handleClose(payload) {
  const s = getSession(payload?.sid);
  if (!s) return { ok: true, gone: true };
  sessions.delete(s.id);
  await killSession(s);
  return { ok: true };
}

async function handleInput(payload) {
  const s = getSession(payload?.sid);
  const data = payload?.data;
  if (typeof data !== "string" || data.length === 0) return { ok: true };
  if (data.length > MAX_INPUT_CHARS) throw fail("TOO_LARGE", "input chunk too large");
  if (!s || s.exited) return { ok: false, code: "EXITED" };
  if (s.child?.stdin?.writableEnded) return { ok: false, code: "EXITED" };

  return new Promise((resolve) => {
    try {
      s.child.stdin.write(data, "utf8", (error) => {
        if (error) resolve({ ok: false, code: "WRITE_FAILED", message: String(error) });
        else resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, code: "WRITE_FAILED", message: String(error) });
    }
  });
}

/** 面板尺寸变了：控制通道一条命令，内核给前台进程组发 SIGWINCH。 */
async function handleResize(payload) {
  const cols = clampDim(payload?.cols, COLS_RANGE);
  const rows = clampDim(payload?.rows, ROWS_RANGE);
  if (!cols || !rows) return { ok: false, code: "INVALID" };
  const s = getSession(payload?.sid);
  if (!s || s.exited) return { ok: false, code: "NO_SESSION" };
  if (s.mode !== "python" || !s.control?.writable) {
    return { ok: false, code: "NO_PTY" };
  }

  try {
    s.control.write(`resize ${cols} ${rows}\n`);
  } catch (error) {
    return { ok: false, code: "WRITE_FAILED", message: String(error) };
  }
  return { ok: true, cols, rows };
}

async function handlePoll(payload) {
  const s = getSession(payload?.sid);
  if (!s) return { ok: true, data: "", cursor: 0, exited: false, hasSession: false };
  const from = Math.max(Number(payload?.cursor) || 0, s.baseOffset);
  const chunks = chunksAfter(s, from);
  let bytes = 0;
  const kept = [];
  for (const chunk of chunks) {
    if (bytes + chunk.length > MAX_POLL_BYTES) break;
    kept.push(chunk);
    bytes += chunk.length;
  }
  const data = kept.length === 0 ? "" : Buffer.concat(kept).toString("base64");
  return {
    ok: true,
    hasSession: true,
    data,
    cursor: bytes > 0 ? from + bytes : from,
    exited: s.exited,
    exitCode: s.exitCode,
    sid: s.id,
    label: s.label,
    cwd: s.cwd,
    shell: s.shell,
    mode: s.mode,
  };
}

/**
 * 重启一个会话：杀掉旧 shell，在**同一个 sid** 上换新（标签身份、SSE
 * 客户端都不变，只发一帧 {t:"r"} 让视图清屏重放）。
 */
async function handleRestart(payload) {
  const s = getSession(payload?.sid);
  if (!s) return { ok: false, code: "NO_SESSION" };
  const cols = clampDim(payload?.cols, COLS_RANGE) ?? 80;
  const rows = clampDim(payload?.rows, ROWS_RANGE) ?? 24;
  const shell = pickShellPath(payload?.shell);
  const cwd = await currentCwd();

  const clients = [...s.clients];
  const fresh = spawnSession(cwd, cols, rows, shell);
  fresh.id = s.id;
  fresh.label = s.label;
  sessions.set(s.id, fresh);
  await killSession(s);

  for (const client of clients) fresh.clients.add(client);
  broadcast(fresh, { t: "r" });

  return { ok: true, ...sessionInfo(fresh) };
}

const CHANNELS = {
  "term.hello": handleHello,
  "term.new": handleNew,
  "term.close": handleClose,
  "term.input": handleInput,
  "term.resize": handleResize,
  "term.poll": handlePoll,
  "term.restart": handleRestart,
};

async function onPanelInvoke(channel, payload) {
  const handler = CHANNELS[channel];
  if (!handler) return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
  try {
    return await handler(payload ?? {});
  } catch (error) {
    return toFailure(error);
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

async function onUnload() {
  for (const s of [...sessions.values()]) {
    await killSession(s).catch(() => {});
  }
  sessions.clear();
  if (httpServer) {
    const server = httpServer;
    httpServer = null;
    try {
      server.close();
    } catch {
      /* 忽略 */
    }
  }
}

module.exports = { onLoad: async () => {}, onUnload, onPanelInvoke };
