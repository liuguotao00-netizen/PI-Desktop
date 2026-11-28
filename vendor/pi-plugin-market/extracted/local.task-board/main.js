"use strict";
/**
 * task-board 宿主插件主进程入口（M1：只读看板）。
 *
 * 三条纪律（与 RULE-PI-DESKTOP-PLUGIN / 既有插件一致）：
 *   · 宿主在装载前把 API 挂在 globalThis.pi 上、**不传参调用 onLoad**，因此不写形参；
 *   · 一切对外副作用只走宿主 desktop 控制面，且只调只读操作；
 *   · 每个入口 fail-open：本插件异常只让某一列降级，绝不阻断用户会话。
 *
 * 数据口径（字段名取自本机已在真机跑通的 project-tree/lib/facts.js 实测映射）：
 *   session/list → { sessions|items|rows|list: [{ sessionId|id, title|name|label,
 *                    projectId, projectPath|workspacePath|path, updatedAt|... }] }
 */

const state = {
  pi: null,
  lastSnapshot: null,
  commandId: "",
  /** 共享快照：侧栏视图与置顶浮窗是两个页面、各自轮询，靠这一层去重。 */
  snapshotCache: null,
  snapshotInflight: null,
  /** 上一轮仍在跑的会话 id：只用来捕捉「刚刚跑完」这一次跃迁。 */
  prevRunning: null,
  /** 「刚完成」跨轮保留表：sessionId -> { ...行数据, finishedAt }，超过 DONE_WINDOW_MS 清掉。 */
  recentlyDone: new Map(),
  /** 会话清单缓存：`session/list` 全量结果在 SESSIONS_TTL_MS 内复用，命中时不重拉不重映射。 */
  sessionsCache: null,
};

const SESSION_ROW_KEYS = ["sessions", "items", "rows", "list"];
const PROJECT_ROW_KEYS = ["projects", "items", "rows", "list"];
const PLAN_ROW_KEYS = ["plans", "approvals", "items", "rows", "list"];

const SESSION_ID_KEYS = ["sessionId", "id"];
const SESSION_TITLE_KEYS = ["title", "name", "label"];
const SESSION_UPDATED_KEYS = ["updatedAt", "updated_at", "lastTurnAt", "lastOpenedAt", "createdAt", "created_at"];
const SESSION_PROJECT_PATH_KEYS = ["projectPath", "workspacePath", "path"];
const SESSION_PROJECT_ID_KEYS = ["projectId", "project_id"];
const SESSION_MODE_KEYS = ["mode", "permissionMode", "permission_mode"];

const PLAN_ID_KEYS = ["requestId", "request_id", "id", "toolCallId"];
const PLAN_TITLE_KEYS = ["title", "name", "question", "summary"];
const PLAN_KIND_KEYS = ["kind", "type"];
const PLAN_STATUS_KEYS = ["status", "state"];
const PLAN_CREATED_KEYS = ["createdAt", "created_at", "requestedAt", "ts"];
const PLAN_SESSION_KEYS = ["sessionId", "session_id"];

/** 降级原因只记错误码，不记任何会话内容或路径（诊断纪律）。 */
function codeOf(error) {
  if (!error) return "UNKNOWN";
  return String(error.code || error.message || error);
}

function pick(row, keys) {
  if (!row || typeof row !== "object") return undefined;
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function toMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e11 ? Math.round(value) : Math.round(value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && value.trim().length >= 10) return toMillis(asNumber);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function asRows(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** 唯一对外通道：宿主 desktop 控制面。参数按数组直传。 */
async function control(operation, args) {
  const pi = state.pi;
  if (!pi || !pi.desktop || typeof pi.desktop.invoke !== "function") {
    const error = new Error("desktop control unavailable");
    error.code = "UNSUPPORTED";
    throw error;
  }
  return pi.desktop.invoke({ operation, args: Array.isArray(args) ? args : [] });
}

function normalizeSessions(payload) {
  const out = [];
  for (const row of asRows(payload, SESSION_ROW_KEYS)) {
    const sessionId = String(pick(row, SESSION_ID_KEYS) ?? "").trim();
    if (!sessionId) continue;
    out.push({
      sessionId,
      title: String(pick(row, SESSION_TITLE_KEYS) ?? "").trim() || "(无标题会话)",
      projectPath: String(pick(row, SESSION_PROJECT_PATH_KEYS) ?? ""),
      projectId: String(pick(row, SESSION_PROJECT_ID_KEYS) ?? ""),
      mode: String(pick(row, SESSION_MODE_KEYS) ?? ""),
      updatedAt: toMillis(pick(row, SESSION_UPDATED_KEYS)),
    });
  }
  return out;
}

function normalizeProjects(payload) {
  const out = new Map();
  for (const row of asRows(payload, PROJECT_ROW_KEYS)) {
    const id = String(pick(row, ["projectId", "project_id", "id"]) ?? "");
    const path = String(pick(row, ["path", "projectPath"]) ?? "");
    const name = String(pick(row, ["name", "title"]) ?? "");
    if (!name) continue;
    if (id) out.set(`id:${id}`, name);
    if (path) out.set(`path:${path.toLowerCase()}`, name);
  }
  return out;
}

function normalizePlans(payload) {
  const out = [];
  for (const row of asRows(payload, PLAN_ROW_KEYS)) {
    const requestId = String(pick(row, PLAN_ID_KEYS) ?? "").trim();
    const title = String(pick(row, PLAN_TITLE_KEYS) ?? "").trim();
    if (!requestId && !title) continue;
    out.push({
      requestId,
      title: title || "未命名待审批",
      kind: String(pick(row, PLAN_KIND_KEYS) ?? "plan"),
      status: String(pick(row, PLAN_STATUS_KEYS) ?? "pending"),
      createdAt: toMillis(pick(row, PLAN_CREATED_KEYS)),
      sessionId: String(pick(row, PLAN_SESSION_KEYS) ?? ""),
    });
  }
  return out;
}

/** 「刚完成」的观察窗口：检测到会话停下后，在这个窗口内持续展示（0.3.5 起跨轮保留）。 */
const DONE_WINDOW_MS = 5 * 60 * 1000;

/** 会话清单缓存窗口：`session/list` 返回全量，2s 一轮没必要跟着重拉。 */
const SESSIONS_TTL_MS = 10000;


/**
 * 读某个会话的 asktool 反问（Agent 主动提问、等用户回答）。
 *
 * 通道取证（2026-11-19 在 `app.asar` 里定位）：`agent/pendingInteractive` 是宿主
 * 公开的 **read** 操作，risk 级别 read、scopes 只含 `input`；渲染层的
 * `restorePendingInteractive` 就调它拿 `{ asks, permissions }`。每个 ask 形如
 * `{ requestId, questions: [{ question, options, multiSelect }] }`。
 *
 * 这里只取**题数**，不读题干与选项文本 —— 守住「不读消息内容」这条只读边界。
 * 任何异常返回 null，由调用方按「没有反问」处理（fail-open）。
 */
async function readInteractive(sessionId) {
  try {
    const payload = await control("agent/pendingInteractive", [{ sessionId }]);
    const asks = payload && Array.isArray(payload.asks) ? payload.asks : [];
    let askCount = 0;
    for (const ask of asks) {
      const questions = ask && Array.isArray(ask.questions) ? ask.questions : null;
      askCount += questions && questions.length ? questions.length : 1;
    }
    return { askCount };
  } catch (error) {
    return null;
  }
}
/**
 * 逐会话读 `agent/getStatus`，分成三类：等待人工介入 / 执行中 / 刚完成。
 *
 * 字段口径取证自本机 sidecar（`resources/agent-runtime/sidecar.js` 的 getStatus()）：
 *   { sessionId, isRunning, currentTurnId, modelId, pendingToolConfirmations,
 *     planningState, pendingPlanId?, activity? }
 *
 * 两个必须记住的事实（0.3.0 修的就是它们）：
 *   · **`pendingToolConfirmations` 在桌面原生 runtime 里恒为 0** —— 0.2.x 用它判断
 *     「等你确认」永远不会成立，那是个失效标签，本轮删掉换真实信号；
 *   · **「等待人工介入」真正可观测的是 `planningState`**：模型产出计划后置为
 *     `awaiting_approval`，同时会带 `pendingPlanId`，等用户批准才继续。
 *
 * 拿不到的：asktool 反问（Agent 主动问用户问题）。宿主 getStatus 里没有
 * pendingInputs / asks 字段，它们只活在宿主内部 racp 状态与渲染层 IPC
 * `agent/pendingInteractive` 里，插件侧无通道 —— 这类会话仍归「执行中」，如实标注不猜。
 *
 * 仍然只探最近 24h 活跃的前 20 个（宿主没有「列出全部运行中会话」的接口），分批 5 并发。
 */
async function readStatuses(sessions, degraded, prevRunning) {
  const MAX = 20;
  const BATCH = 5;
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const candidates = (sessions || []).filter((s) => (s.updatedAt || 0) >= dayAgo).slice(0, MAX);
  const out = { waiting: [], running: [], done: [], probed: 0 };
  if (!candidates.length) return out;

  const live = new Map();
  let failures = 0;

  for (let i = 0; i < candidates.length; i += BATCH) {
    const chunk = candidates.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(async (session) => {
        try {
          const payload = await control("agent/getStatus", [session.sessionId]);
          const status = (payload && (payload.status || payload)) || {};
          return { session, status };
        } catch (error) {
          failures += 1;
          return null;
        }
      })
    );
    for (const item of results) if (item) live.set(item.session.sessionId, item);
  }

  out.probed = live.size;
  const now = Date.now();

  // 先清掉超出观察窗口的「刚完成」，避免 Map 无限增长。
  for (const [id, entry] of state.recentlyDone) {
    if (now - entry.finishedAt > DONE_WINDOW_MS) state.recentlyDone.delete(id);
  }

  const runningNow = [];
  for (const [sessionId, item] of live) {
    const { session, status } = item;
    const isRunning = status.isRunning === true || status.running === true;
    const activity = status.activity && typeof status.activity === "object" ? status.activity : null;
    const base = {
      sessionId,
      title: session.title,
      projectName: session.projectName || "",
      updatedAt: session.updatedAt,
      activityPhase: activity ? String(activity.phase || "") : "",
      activitySince: activity && Number.isFinite(Number(activity.since)) ? Number(activity.since) : 0,
      planningState: String(status.planningState || ""),
    };

    // 「等待人工介入」的第一个来源：计划审批。
    // **顺序是关键**：`awaiting_approval` 时回合已经结束（`isRunning === false`），
    // 若把这个判定写在下面 `!isRunning` 的 `continue` 之后，这一路永远捕获不到 ——
    // 0.3.0~0.3.7 正是这个错（由 0.3.8 的行为测试发现：mock 一个 awaiting_approval
    // 且 isRunning=false 的会话，等待列仍是空）。
    const awaitingApproval = base.planningState === "awaiting_approval" || Boolean(status.pendingPlanId);
    if (awaitingApproval) {
      state.recentlyDone.delete(sessionId);
      out.waiting.push({ ...base, waitingFor: "plan-approval" });
      continue;
    }

    if (!isRunning) {
      // 只在「上一轮还在跑、这一轮停了」这一刻记一次完成时刻，然后**把它记住**。
      // 0.3.4 及之前只靠 prevRunning 判跃迁，而 prevRunning 每轮都被重写成当前
      // 在跑集合 ⇒ 条目只在跃迁那一轮出现、下一轮 wasRunning=false 直接消失
      // （2s 活跃节奏下等于只显示 2 秒），与「5 分钟内完成」的文案完全不符。
      const wasRunning = !!(prevRunning && prevRunning.has(sessionId));
      if (wasRunning && !state.recentlyDone.has(sessionId)) {
        state.recentlyDone.set(sessionId, { ...base, finishedAt: now });
      }
      continue;
    }

    // 会话又跑起来了 → 从「刚完成」里移除，避免同一任务同时出现在两段。
    state.recentlyDone.delete(sessionId);

    // 第二个来源（asktool 反问）留到循环后按在跑集合补查：
    //   `agent/pendingInteractive` 是公开的 **read** 操作（risk=read，scopes 只含
    //   `input`），入参 `{ sessionId }`，返回 `{ asks, permissions }`；宿主渲染层的
    //   `restorePendingInteractive` 就用它恢复待答问题。**0.3.1~0.3.7 那句「宿主未对
    //   插件开放」是错的** —— 当时搜的是主进程内部变量名 `pendingInteractiveRequests`，
    //   漏了 operation handle 本身。反问只在会话在跑时发生，故放到循环后查。
    runningNow.push(base);
  }

  // 补查 asktool 反问。`permissions`（工具权限确认）**故意不并入**：宿主对它有自己的
  // 原生弹窗，插件再报一条只会让用户以为有两处要填，属于重复提醒。
  let askFailures = 0;
  for (let i = 0; i < runningNow.length; i += BATCH) {
    const chunk = runningNow.slice(i, i + BATCH);
    const probed = await Promise.all(
      chunk.map(async (item) => ({ item, interactive: await readInteractive(item.sessionId) }))
    );
    for (const entry of probed) {
      if (!entry.interactive) askFailures += 1;
      if (entry.interactive && entry.interactive.askCount > 0) {
        out.waiting.push({ ...entry.item, waitingFor: "ask", askCount: entry.interactive.askCount });
      } else {
        out.running.push(entry.item);
      }
    }
  }
  if (runningNow.length && askFailures >= runningNow.length) {
    degraded.push({ code: "ASK_PROBE_UNAVAILABLE", detail: `agent/pendingInteractive 全部失败（${askFailures} 次）` });
  }

  // 跨轮汇总：只要还在观察窗口内就继续展示，不再依赖「上一轮在跑」这个一次性跃迁。
  // 即使某轮 `agent/getStatus` 失败或该会话被挤出前 20 个候选，已记下的完成也会照常显示。
  for (const entry of state.recentlyDone.values()) out.done.push(entry);

  out.done.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  if (failures && failures >= candidates.length) {
    degraded.push({ code: "AGENT_STATUS_UNAVAILABLE", detail: `agent/getStatus 全部失败（${failures} 次）` });
  }
  return out;
}

/**
 * 一次快照：三个只读通道各自独立 try/catch。
 * 任一通道失败只把原因写进 degraded，其余照常返回（fail-open）。
 */
async function buildSnapshot(input) {
  const limit = clamp(input && input.limit, 1, 200, 60);
  const degraded = [];
  const snapshot = {
    generatedAt: Date.now(),
    limit,
    sessions: [],
    plans: [],
    waiting: [],
    running: [],
    recentDone: [],
    projects: [],
    degraded,
  };

  let projectNames = new Map();
  try {
    projectNames = normalizeProjects(await control("project/list", []));
  } catch (error) {
    degraded.push({ code: "PROJECTS_UNAVAILABLE", detail: codeOf(error) });
  }

  let sessionRows = [];
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  try {
    // 会话清单降频（0.3.7）：`session/list` 一次返回**全量**（本机 395 行），
    // 而 2s 一轮里真正需要每轮变的是 agent/getStatus（sidecar 内存读）。这里把
    // 清单缓存 10s，命中时连 normalize/排序/项目名映射都不做 —— 省掉每轮 395 行
    // 的跨进程序列化与映射，这是这份看板真正的大头开销。
    const cached = state.sessionsCache;
    if (!cached || Date.now() - cached.at > SESSIONS_TTL_MS) {
      const sessions = normalizeSessions(await control("session/list", []));
      sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      // 项目名必须先落到全量行上：执行中列与待审批列都要用它，
      // 只在展示切片里映射会让那两列永远拿到空 projectName（0.1.2 的真 bug）。
      const rows = sessions.map((session) => {
        const byId = session.projectId ? projectNames.get(`id:${session.projectId}`) : "";
        const byPath = session.projectPath ? projectNames.get(`path:${session.projectPath.toLowerCase()}`) : "";
        return { ...session, projectName: byId || byPath || "" };
      });
      state.sessionsCache = {
        at: Date.now(),
        rows,
        total: sessions.length,
        activeToday: rows.filter((row) => (row.updatedAt || 0) >= dayAgo).length,
      };
    }
    const cache = state.sessionsCache;
    sessionRows = cache.rows;
    snapshot.sessionTotal = cache.total;
    snapshot.activeToday = cache.activeToday;
    // 只把 24h 内活跃的行发给页面：「更早」列已删除（0.3.7），历史行只留统计用途，
    // 不再跨进程搬运。
    snapshot.sessions = sessionRows
      .filter((row) => (row.updatedAt || 0) >= dayAgo)
      .slice(0, limit);
  } catch (error) {
    degraded.push({ code: "SESSIONS_UNAVAILABLE", detail: codeOf(error) });
    snapshot.sessionTotal = 0;
    snapshot.activeToday = 0;
  }

  try {
    const plans = normalizePlans(await control("plans/pending", [{}]));
    plans.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    // 待审批条目只带 sessionId，项目名按会话反查；查不到留空，由视图显示「未归属项目」。
    const bySession = new Map(sessionRows.map((session) => [session.sessionId, session]));
    const decorated = plans.map((plan) => {
      const owner = plan.sessionId ? bySession.get(plan.sessionId) : null;
      return {
        ...plan,
        projectName: owner ? owner.projectName : "",
        sessionTitle: owner ? owner.title : "",
      };
    });
    snapshot.plans = decorated.slice(0, limit);
    snapshot.planTotal = plans.length;
  } catch (error) {
    degraded.push({ code: "PLANS_UNAVAILABLE", detail: codeOf(error) });
    snapshot.planTotal = 0;
  }

  const statuses = await readStatuses(sessionRows, degraded, state.prevRunning);
  snapshot.waiting = statuses.waiting;
  snapshot.running = statuses.running;
  snapshot.recentDone = statuses.done;
  snapshot.probed = statuses.probed;
  // 新一轮的「在跑」集合：下一轮据此判断谁刚刚停下，从而给出「5 分钟内完成」。
  state.prevRunning = new Set([...statuses.waiting, ...statuses.running].map((item) => item.sessionId));

  // 自适应节奏：把「下一轮该多久来」跟着结果一起发给页面，页面照它调度定时器。
  snapshot.nextPollMs = pollIntervalFor(snapshot);
  state.lastSnapshot = snapshot;
  return snapshot;
}

/**
 * 共享快照入口（侧栏视图 + 置顶浮窗共用）。
 *
 * 两个页面是两份独立渲染文档，各自轮询等于把 session/list + plans/pending +
 * 每个活跃会话的 agent/getStatus 跑两遍。这里做两件事：
 *   1. TTL 复用 —— 缓存 TTL 直接取上一份快照算出的 nextPollMs；
 *   2. 并发合并 —— 两个页面恰好同时请求时只跑一次 buildSnapshot。
 *
 * 节奏为什么自适应：本机实测 341 个活会话、24h 活跃只有 10 个 ——
 * 每轮 agent/getStatus 实际约 10 次，而且是 sidecar 里 `F.get(id).getStatus()` 的内存读；
 * 真正贵的是 session/list 那 341 行。所以只在「有人等你 / 有人在跑」时付全量代价，
 * 全空闲就退回 15 秒 —— 提及时性但不让空闲时段持续烧 IPC。
 */
const POLL_ACTIVE_MS = 2000;   // 有等待人工介入或执行中
const POLL_RECENT_MS = 5000;   // 只剩「5 分钟内刚完成」
const POLL_IDLE_MS = 15000;    // 全空闲

function pollIntervalFor(snapshot) {
  const busy = (snapshot.waiting || []).length + (snapshot.running || []).length;
  if (busy > 0) return POLL_ACTIVE_MS;
  if ((snapshot.recentDone || []).length > 0) return POLL_RECENT_MS;
  return POLL_IDLE_MS;
}

function getSnapshot(input) {
  const cache = state.snapshotCache;
  const ttl = cache && Number(cache.ttl) > 0 ? Number(cache.ttl) : POLL_IDLE_MS;
  if (cache && Date.now() - cache.at < ttl) return Promise.resolve(cache.value);
  if (state.snapshotInflight) return state.snapshotInflight;

  const pending = buildSnapshot(input)
    .then((value) => {
      // TTL 跟着下一轮节奏走：页面按 nextPollMs 回来时缓存正好过期，拿到的是新数据。
      const next = Number(value.nextPollMs) || POLL_IDLE_MS;
      state.snapshotCache = { at: Date.now(), value, ttl: next };
      return value;
    })
    .catch((error) => {
      // 不缓存失败：下一个请求应能立刻重试，而不是继续吃一份坏结果。
      throw error;
    })
    .finally(() => {
      if (state.snapshotInflight === pending) state.snapshotInflight = null;
    });

  state.snapshotInflight = pending;
  return pending;
}

/**
 * 呼起主窗口（浮窗双击任务时调用）。
 *
 * **取证结论：插件没有任何窗口控制 API。** 72 个 desktop operation 里没有
 * `window/show`、`window/focus`、`window/restore`（唯一的 `window/closeBehavior/get`
 * 是读关闭行为设置），host API 白名单里也没有；插件主进程还跑在宿主派生的隔离进程里
 * （`handleInit` 通过消息传 pluginPath 再 require），`require("electron")` 拿不到主进程的
 * BrowserWindow。所以"双击直接把窗口从最小化拉起来"在纯插件侧做不到。
 *
 * 唯一能让宿主自己 restore 的现成路径是**原生通知的 click handler**——宿主内部那段
 * 代码写死了 `isMinimized() -> restore() -> show() -> focus()`。因此这里发一条通知：
 * 用户点一下即恢复并聚焦主窗口，而会话在前一步已经切好了。
 * 未授权 `notify` 时降级为「只切会话」，不抛错也不打断用户。
 */
async function wakeMainWindow() {
  const ui = state.pi && state.pi.ui;
  if (!ui || typeof ui.showNativeNotification !== "function") return { ok: true, wake: "unsupported" };
  try {
    const result = await ui.showNativeNotification({
      title: "任务看板",
      body: "点击恢复并显示 PI-Desktop 窗口",
    });
    const shown = !!(result && result.shown);
    return {
      ok: true,
      wake: shown ? "notification" : "denied",
      permission: result && result.permission ? String(result.permission) : "",
    };
  } catch (error) {
    // fail-open：叫不醒窗口也不能影响「已经跳过去了」这件事。
    return { ok: true, wake: "failed", code: codeOf(error) };
  }
}

/** 面板/视图页只有 window.pluginBridge.invoke → 宿主转发到这里。 */
async function onPanelInvoke(channel, payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  try {
    if (channel === "board.snapshot") return await getSnapshot(input);
    if (channel === "board.openSession") {
      const sessionId = String(input.sessionId || "").trim();
      if (!sessionId) return { ok: false, code: "INVALID_ARGUMENT" };
      await control("session/open", [sessionId]);
      return { ok: true };
    }
    if (channel === "board.wakeSession") {
      // 浮窗专用：切会话 + 试图把最小化的主窗口叫回来。
      const sessionId = String(input.sessionId || "").trim();
      if (!sessionId) return { ok: false, code: "INVALID_ARGUMENT" };
      await control("session/open", [sessionId]);
      return await wakeMainWindow();
    }
    if (channel === "board.openSidebar") {
      if (!state.pi || !state.pi.ui || typeof state.pi.ui.revealView !== "function") {
        return { ok: false, code: "UNSUPPORTED" };
      }
      // 契约取证自宿主 app.asar 的 revealWorkPanelView()：
      //   · 需要 ui.view 权限（本插件已声明）；
      //   · 只声明一个 view 时 viewId 可省，这里仍显式给，避免以后加 view 变成歧义；
      //   · sessionId 一律不传 —— 传了就必须等于「用户当前正在看的会话」，
      //     否则宿主直接 INVALID_ARGUMENT（the session is no longer the active one）；
      //     不传则宿主回落到当前活跃会话，正是我们要的行为。
      await state.pi.ui.revealView({ viewId: "board" });
      return { ok: true };
    }
    return { ok: false, code: "UNKNOWN_CHANNEL", channel: String(channel) };
  } catch (error) {
    // 任何通道异常都返回结构化降级，页面据此显示原因，不抛到宿主。
    return { ok: false, code: codeOf(error), degraded: true };
  }
}

/**
 * 命令三件套：manifest `contributes.commands` 声明 + 这里运行期注册 + 对应授权。
 * 缺任一件就静默失效（RULE-006）。注册失败只记日志，不拖垮视图与浮窗。
 */
async function registerCommands(pi) {
  if (!pi.commands || typeof pi.commands.register !== "function") return;
  const id = "taskboard.openWidget";
  try {
    await pi.commands.register({
      id,
      title: "任务看板：打开浮窗",
      run: async () => {
        try {
          await pi.ui.openPanel({ title: "任务看板 · 浮窗" });
        } catch (error) {
          try {
            pi.ui.showToast("任务看板：无法打开浮窗，请检查 ui.panel 授权", "error");
          } catch (ignored) {
            /* toast 也不可用时静默，不影响宿主 */
          }
        }
      },
    });
    state.commandId = id;
  } catch (error) {
    // fail-open：命令不可用不阻断插件其它表面。
    console.warn(`[task-board] command register failed: ${codeOf(error)}`);
  }
}

async function onLoad() {
  const pi = globalThis.pi;
  if (!pi) throw new Error("task-board: host api missing");
  state.pi = pi;
  await registerCommands(pi);
}

async function onUnload() {
  try {
    if (state.commandId && state.pi && state.pi.commands && typeof state.pi.commands.unregister === "function") {
      await state.pi.commands.unregister(state.commandId);
    }
  } catch (error) {
    /* 退出预算很紧，反注册失败只放弃，不做重试 */
  }
  state.commandId = "";
  state.pi = null;
  state.lastSnapshot = null;
  state.snapshotCache = null;
  state.snapshotInflight = null;
  state.prevRunning = null;
  state.recentlyDone.clear();
  state.sessionsCache = null;
}

module.exports = { onLoad, onUnload, onPanelInvoke };
