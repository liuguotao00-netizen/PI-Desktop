"use strict";

/**
 * 笔记（Notes）— PI-Desktop 插件主进程
 *
 * 视图：contributes.views[0] → views/index.html（右侧工作面板）
 * 数据：pi.plugin.getDataPath() 下的 notes.json + snapshots/ 自动快照
 *
 * 为什么用原生 node:fs：宿主的 pi.fs 网关拒绝一切落在 PI-Desktop 数据目录里的
 * 路径，而插件私有目录正在其中；同时便签需要无授权弹窗、无 scope 摩擦地连续写。
 * 因此这里只碰自己的数据目录：路径由 getDataPath() 给出，本文件不拼接任何其他
 * 位置，也不接受面板传来的路径参数——面板只能传来标题、正文和 id。
 *
 * 面板永远拿到的是副本：读接口不回传内部的活跃对象，写接口按 id 合并单条笔记，
 * 未知字段一律丢弃。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PLUGIN_ID = "io.github.g1oow.sidebar-note";
const VIEW_ID = "note";
const COMMAND_ID = "note.open";

const NOTES_FILE = "notes.json";
const SNAPSHOT_DIR = "snapshots";
/**
 * 每个项目「正在打开的笔记」单独存一份：宿主的 docked 视图按 pluginId/viewId
 * 只缓存一份页面，切换项目时不会重建它，所以视图要靠这份记忆自己换内容。
 * 独立文件是为了不动 notes.json 的结构——那里只存笔记本身。
 */
const PROJECT_MEMORY_FILE = "project-state.json";
const MAX_PROJECT_MEMORY = 200;
const MAX_SNAPSHOTS = 5;
const MAX_NOTES = 5000;
const MAX_TITLE = 200;
const MAX_BODY = 200000;
const WRITE_DEBOUNCE_MS = 250;
const SNAPSHOT_MIN_INTERVAL_MS = 10 * 60 * 1000;
const TRASH_TTL_MS = 60 * 1000;
const MAX_COPY_CHARS = 400000;

const SCOPES = new Set(["inbox", "project", "all"]);

let dataDir = null;
let store = { schema: 1, updatedAt: null, notes: [] };
let writeTimer = null;
let lastSnapshotAt = 0;
const trash = new Map();

// ── 小工具 ──────────────────────────────────────────────────────────────────

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function log(message) {
  console.log(`[${PLUGIN_ID}] ${message}`);
}

/**
 * 调试模式：面板把真实布局（面板宽度、缩放、滚动尺寸）写进数据目录的
 * diagnostics.log。宿主里的面板宽度只有页面自己知道，出问题时读文件即可定位，
 * 不用靠截图猜。只落白名单字段，笔记内容永远不进这个文件。
 */
const DIAG_FILE = "diagnostics.log";
const DIAG_MAX_BYTES = 64 * 1024;
const DIAG_FIELDS = [
  "panelWidth",
  "bodyWidth",
  "innerWidth",
  "visualWidth",
  "bodyHeight",
  "innerHeight",
  "docScrollWidth",
  "docScrollHeight",
  "shellClientWidth",
  "shellScrollWidth",
  "zoom",
  "dpr",
  "narrow",
  "tiny",
  "tight",
];
/**
 * 写入一条诊断记录：payload = { event, values, viewport }。
 * values 只接受 DIAG_FIELDS 里的数值/布尔值，viewport 只记 UA（区分宿主与本地预览）。
 */
function writeDiag(payload) {
  if (!dataDir) return { ok: false, reason: "no-data-dir" };
  const source = payload && typeof payload === "object" ? payload : {};
  const values = source.values && typeof source.values === "object" ? source.values : {};
  const row = { t: nowIso(), event: clampText(String(source.event || "?"), 32) };
  for (const key of DIAG_FIELDS) {
    const value = values[key];
    if (typeof value === "boolean") row[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) {
      row[key] = Math.round(value * 100) / 100;
    }
  }
  if (typeof source.viewport === "string") row.viewport = clampText(source.viewport, 240);
  try {
    const file = path.join(dataDir, DIAG_FILE);
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
    if (fs.statSync(file).size > DIAG_MAX_BYTES) {
      const text = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, text.slice(Math.floor(text.length / 2)), "utf8");
      fs.appendFileSync(file, `${JSON.stringify({ t: nowIso(), event: "rotated" })}\n`, "utf8");
    }
    return { ok: true };
  } catch (error) {
    log(`diagnostics write failed: ${error?.message || error}`);
    return { ok: false, reason: "write-failed" };
  }
}


function nowIso() {
  return new Date().toISOString();
}

function clampText(value, max) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\r\n?/g, "\n");
  return text.length > max ? text.slice(0, max) : text;
}

/** 工作区路径 → 稳定的项目键：小写入、正斜杠、去掉尾部分隔符。 */
function normalizeProjectKey(value) {
  if (typeof value !== "string") return "";
  const key = value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return key === "/" ? "" : key;
}

/** 摘要展示用：去掉标题井号、列表符号、任务框、引用符与常见行内标记。 */
function plainLine(line) {
  return String(line || "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/\[([^\]]*)\]\([^)\s]+\)/g, "$1")
    .replace(/(\*\*|__|~~|`)(.*?)\1/g, "$2")
    .trim();
}

/** 摘要用的“可见行”：跳过代码围栏整段，其余行去掉标记后返回。 */
function visibleLines(text) {
  const out = [];
  let inFence = false;
  for (const line of String(text || "").split("\n")) {
    if (/^\s{0,3}(```+|~~~+)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const plain = plainLine(line);
    if (plain) out.push(plain);
  }
  return out;
}

function firstLine(text) {
  const lines = visibleLines(text);
  return lines.length ? lines[0] : "";
}

function excerptOf(title, body) {
  const seen = new Set([plainLine(title)]);
  const parts = [];
  for (const plain of visibleLines(body)) {
    if (seen.has(plain)) continue;
    seen.add(plain);
    parts.push(plain);
    if (parts.join(" ").length > 160) break;
  }
  return parts.join(" ").slice(0, 160);
}

// ── 持久化 ──────────────────────────────────────────────────────────────────

function notesFile() {
  return path.join(dataDir, NOTES_FILE);
}

function snapshotDir() {
  return path.join(dataDir, SNAPSHOT_DIR);
}

function sanitizeNote(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id ? raw.id : null;
  if (!id) return null;
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : nowIso();
  return {
    id,
    title: clampText(raw.title, MAX_TITLE),
    body: clampText(raw.body, MAX_BODY),
    projectKey: normalizeProjectKey(raw.projectKey),
    projectName: typeof raw.projectName === "string" ? raw.projectName.slice(0, 120) : "",
    pinned: raw.pinned === true,
    createdAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt,
  };
}

function normalizeStore(raw) {
  const notes = Array.isArray(raw?.notes) ? raw.notes.map(sanitizeNote).filter(Boolean) : [];
  return {
    schema: 1,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : null,
    notes: notes.slice(0, MAX_NOTES),
  };
}

function readJson(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) return null;
  return JSON.parse(text);
}

function listSnapshots() {
  try {
    return fs
      .readdirSync(snapshotDir())
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** notes.json 读不出来时退回最近一份可用快照，绝不静默清空用户笔记。 */
function restoreFromSnapshots() {
  for (const name of listSnapshots()) {
    try {
      const parsed = readJson(path.join(snapshotDir(), name));
      const restored = normalizeStore(parsed);
      log(`notes.json unreadable, restored ${restored.notes.length} note(s) from ${name}`);
      return restored;
    } catch {
      /* 换下一份 */
    }
  }
  return null;
}

function loadStore() {
  try {
    const parsed = readJson(notesFile());
    store = normalizeStore(parsed);
  } catch (error) {
    const restored = error?.code === "ENOENT" ? null : restoreFromSnapshots();
    store = restored || normalizeStore(null);
    if (!restored && error?.code !== "ENOENT") {
      log(`notes.json unreadable and no snapshot available: ${error?.message || error}`);
    }
  }
  if (store.notes.length) {
    const newest = store.notes.reduce(
      (latest, note) => (note.updatedAt > latest ? note.updatedAt : latest),
      store.notes[0].updatedAt,
    );
    lastSnapshotAt = Date.parse(newest) || 0;
  }
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function writeSnapshot(force) {
  const stamp = Date.now();
  if (!force && stamp - lastSnapshotAt < SNAPSHOT_MIN_INTERVAL_MS) return;
  try {
    fs.mkdirSync(snapshotDir(), { recursive: true });
    const name = `${new Date(stamp).toISOString().replace(/[:.]/g, "-")}.json`;
    atomicWrite(path.join(snapshotDir(), name), JSON.stringify(store, null, 2));
    lastSnapshotAt = stamp;
    const names = listSnapshots();
    for (const stale of names.slice(MAX_SNAPSHOTS)) {
      try {
        fs.unlinkSync(path.join(snapshotDir(), stale));
      } catch {
        /* 清理失败不影响保存 */
      }
    }
  } catch (error) {
    log(`snapshot failed: ${error?.message || error}`);
  }
}

function persistNow(options) {
  if (!dataDir) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (options?.snapshot !== false) writeSnapshot(options?.forceSnapshot === true);
    store.updatedAt = nowIso();
    atomicWrite(notesFile(), JSON.stringify(store, null, 2));
  } catch (error) {
    log(`save failed: ${error?.message || error}`);
    throw fail("UNSUPPORTED", `笔记保存失败：${error?.message || error}`);
  }
}

function schedulePersist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      persistNow({});
    } catch {
      /* 已在 persistNow 里记日志 */
    }
  }, WRITE_DEBOUNCE_MS);
}

function flushPersist() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  persistNow({});
}

// ── 每个项目「正在打开的笔记」 ──────────────────────────────────────────────

/**
 * 宿主的 docked 视图按 pluginId/viewId 只缓存一份页面：切换项目时页面不会重建，
 * 也不会重新执行 boot()。所以「这个项目上次在看哪条笔记」必须自己记住并主动换内容，
 * 否则切到另一个项目后面板还在显示上一个项目的笔记。
 *
 * 记忆按项目键（规范化工作区路径，收件箱为 ""）分开，与笔记的归属无关：
 * 在项目 A 里打开一条收件箱笔记，记住的是「A 在看这条」。
 * 只存笔记 id，不存标题 / 正文，损坏时直接丢掉重建，不影响 notes.json。
 */
let projectMemory = { schema: 1, projects: {} };

function projectMemoryFile() {
  return path.join(dataDir, PROJECT_MEMORY_FILE);
}

/** 按更新时间保留最近 MAX_PROJECT_MEMORY 个项目，超出的直接丢弃。 */
function pruneProjectMemory(projects) {
  const entries = Object.entries(projects).sort((a, b) =>
    a[1].updatedAt < b[1].updatedAt ? 1 : a[1].updatedAt > b[1].updatedAt ? -1 : 0,
  );
  const kept = {};
  for (const [key, entry] of entries.slice(0, MAX_PROJECT_MEMORY)) kept[key] = entry;
  return kept;
}

function normalizeProjectMemory(raw) {
  const source =
    raw && typeof raw === "object" && raw.projects && typeof raw.projects === "object"
      ? raw.projects
      : {};
  const projects = {};
  for (const [rawKey, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.activeNoteId !== "string" || !entry.activeNoteId) continue;
    projects[normalizeProjectKey(rawKey)] = {
      activeNoteId: entry.activeNoteId,
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : nowIso(),
    };
  }
  return { schema: 1, projects: pruneProjectMemory(projects) };
}

function loadProjectMemory() {
  let raw = null;
  try {
    raw = readJson(projectMemoryFile());
    projectMemory = normalizeProjectMemory(raw);
  } catch (error) {
    projectMemory = normalizeProjectMemory(null);
    if (error?.code !== "ENOENT") {
      log(`project-state.json unreadable, reset: ${error?.message || error}`);
    }
    return;
  }
  // 读入时裁掉的条目要落盘，否则每启动一次都要重算一遍上限
  const before = raw?.projects && typeof raw.projects === "object" ? Object.keys(raw.projects).length : 0;
  if (before !== Object.keys(projectMemory.projects).length) saveProjectMemory();
}

function saveProjectMemory() {
  if (!dataDir) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    atomicWrite(projectMemoryFile(), JSON.stringify(projectMemory, null, 2));
  } catch (error) {
    log(`project memory save failed: ${error?.message || error}`);
  }
}

/**
 * 项目记忆里的笔记：必须仍然存在，而且要么属于这个项目、要么是跨项目的收件箱笔记。
 * 对不上就当没有记忆（顺手清掉过期条目），面板退回列表，绝不显示另一个项目的笔记。
 */
function rememberedNoteFor(projectKey) {
  const key = normalizeProjectKey(projectKey);
  const entry = projectMemory.projects[key];
  if (!entry) return null;
  const note = findNote(entry.activeNoteId);
  if (!note || (note.projectKey && note.projectKey !== key)) {
    delete projectMemory.projects[key];
    saveProjectMemory();
    return null;
  }
  return note;
}

/** 删掉 / 撤销删除时同步清理指向这条笔记的记忆。 */
function forgetNoteEverywhere(id) {
  let changed = false;
  for (const [key, entry] of Object.entries(projectMemory.projects)) {
    if (entry.activeNoteId !== id) continue;
    delete projectMemory.projects[key];
    changed = true;
  }
  if (changed) saveProjectMemory();
}

/**
 * 记下「这个项目正在看哪条笔记」。id 为空表示回到列表、没有打开的笔记。
 * 项目键一律由插件进程自己取，不接受面板传来的路径。
 */
async function rememberNote(payload) {
  const id = typeof payload?.id === "string" ? payload.id : "";
  const project = await currentProject();
  const key = project.key;
  if (id) {
    const note = findNote(id);
    if (!note) throw fail("NOT_FOUND", "这条笔记不存在或已被删除。");
    // 只记「属于这个项目」或「跨项目收件箱」的笔记：在项目 B 里从「全部」打开
    // 项目 A 的笔记不应变成 B 的记忆，否则切回 B 时会显示别人项目的笔记。
    if (note.projectKey && note.projectKey !== key) {
      return { projectKey: key, activeNoteId: "", changed: false };
    }
    const previous = projectMemory.projects[key];
    if (previous?.activeNoteId === id) {
      return { projectKey: key, activeNoteId: id, changed: false };
    }
    projectMemory.projects[key] = { activeNoteId: id, updatedAt: nowIso() };
    projectMemory.projects = pruneProjectMemory(projectMemory.projects);
    saveProjectMemory();
    return { projectKey: key, activeNoteId: id, changed: true };
  }
  if (!projectMemory.projects[key]) {
    return { projectKey: key, activeNoteId: "", changed: false };
  }
  delete projectMemory.projects[key];
  saveProjectMemory();
  return { projectKey: key, activeNoteId: "", changed: true };
}

// ── 查询 ────────────────────────────────────────────────────────────────────

async function currentProject() {
  try {
    const workspace = await pi.workspace.get();
    if (!workspace || typeof workspace !== "object") return { key: "", name: "" };
    const roots = Array.isArray(workspace.roots) ? workspace.roots : [];
    const primary = roots.find((root) => root && root.primary === true && typeof root.path === "string");
    const rawPath = primary?.path || workspace.path || "";
    const name =
      (typeof workspace.name === "string" && workspace.name) ||
      (rawPath ? path.basename(String(rawPath).replace(/[\\/]+$/, "")) : "");
    return { key: normalizeProjectKey(rawPath), name };
  } catch {
    return { key: "", name: "" };
  }
}

function findNote(id) {
  return store.notes.find((note) => note.id === id) || null;
}

function matchesQuery(note, needle) {
  if (!needle) return true;
  return (
    note.title.toLowerCase().includes(needle) || note.body.toLowerCase().includes(needle)
  );
}

function metaOf(note) {
  return {
    id: note.id,
    title: note.title,
    displayTitle: note.title.trim() || firstLine(note.body) || "",
    excerpt: excerptOf(note.title, note.body),
    projectKey: note.projectKey,
    projectName: note.projectName,
    pinned: note.pinned,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    size: note.body.length,
  };
}

function sortNotes(notes) {
  return notes.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  });
}

function projectIndex() {
  const byKey = new Map();
  for (const note of store.notes) {
    if (!note.projectKey) continue;
    const entry = byKey.get(note.projectKey) || {
      key: note.projectKey,
      name: note.projectName || note.projectKey,
      count: 0,
    };
    entry.count += 1;
    if (!entry.name && note.projectName) entry.name = note.projectName;
    byKey.set(note.projectKey, entry);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function listNotes(payload) {
  const scope = SCOPES.has(payload?.scope) ? payload.scope : "project";
  const query = typeof payload?.query === "string" ? payload.query.trim().toLowerCase() : "";
  const project = await currentProject();
  const effectiveScope = scope === "project" && !project.key ? "inbox" : scope;

  let pool;
  if (effectiveScope === "inbox") pool = store.notes.filter((note) => !note.projectKey);
  else if (effectiveScope === "project") pool = store.notes.filter((note) => note.projectKey === project.key);
  else pool = store.notes;

  const items = sortNotes(pool.filter((note) => matchesQuery(note, query))).map(metaOf);
  const counts = {
    inbox: store.notes.filter((note) => !note.projectKey).length,
    project: project.key
      ? store.notes.filter((note) => note.projectKey === project.key).length
      : 0,
    all: store.notes.length,
  };

  // 项目记忆里的那篇「正在打开的笔记」：面板切换项目后靠它换内容。
  // 只回报当前范围（含搜索词）里真的能看到的那条，视图拿到就直接恢复。
  const remembered = rememberedNoteFor(project.key);
  const restorable = remembered && items.some((item) => item.id === remembered.id);

  return {
    scope: effectiveScope,
    requestedScope: scope,
    query,
    items,
    counts,
    project,
    hasProject: Boolean(project.key),
    projects: projectIndex(),
    activeNoteId: restorable ? remembered.id : "",
    limits: { notes: MAX_NOTES, title: MAX_TITLE, body: MAX_BODY, total: store.notes.length },
  };
}

function readNote(payload) {
  const note = findNote(String(payload?.id || ""));
  if (!note) throw fail("NOT_FOUND", "这条笔记不存在或已被删除。");
  return { note: { ...note } };
}

async function createNote(payload) {
  if (store.notes.length >= MAX_NOTES) {
    throw fail("LIMIT_EXCEEDED", `笔记数量已达上限（${MAX_NOTES} 条）。`);
  }
  const scope = SCOPES.has(payload?.scope) ? payload.scope : "project";
  const project = scope === "inbox" ? { key: "", name: "" } : await currentProject();
  const stamp = nowIso();
  const note = {
    id: crypto.randomUUID(),
    title: clampText(payload?.title, MAX_TITLE),
    body: clampText(payload?.body, MAX_BODY),
    projectKey: project.key,
    projectName: project.name,
    pinned: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
  store.notes.unshift(note);
  schedulePersist();
  return { note: { ...note } };
}

function saveNote(payload) {
  const note = findNote(String(payload?.id || ""));
  if (!note) throw fail("NOT_FOUND", "这条笔记不存在或已被删除。");
  const title = clampText(payload?.title, MAX_TITLE);
  const body = clampText(payload?.body, MAX_BODY);
  if (title === note.title && body === note.body) {
    return { id: note.id, updatedAt: note.updatedAt, unchanged: true };
  }
  note.title = title;
  note.body = body;
  note.updatedAt = nowIso();
  schedulePersist();
  return {
    id: note.id,
    updatedAt: note.updatedAt,
    unchanged: false,
    meta: metaOf(note),
  };
}

function pinNote(payload) {
  const note = findNote(String(payload?.id || ""));
  if (!note) throw fail("NOT_FOUND", "这条笔记不存在或已被删除。");
  note.pinned = payload?.pinned === true;
  note.updatedAt = nowIso();
  schedulePersist();
  return { id: note.id, pinned: note.pinned, updatedAt: note.updatedAt, meta: metaOf(note) };
}

function deleteNote(payload) {
  const id = String(payload?.id || "");
  const index = store.notes.findIndex((note) => note.id === id);
  if (index < 0) throw fail("NOT_FOUND", "这条笔记不存在或已被删除。");
  const [note] = store.notes.splice(index, 1);
  trash.set(id, { note, at: Date.now() });
  forgetNoteEverywhere(id);
  schedulePersist();
  return { id, meta: metaOf(note) };
}

function undoDelete(payload) {
  const id = String(payload?.id || "");
  const entry = trash.get(id);
  if (!entry) throw fail("NOT_FOUND", "没有可撤销的删除。");
  if (Date.now() - entry.at > TRASH_TTL_MS) {
    trash.delete(id);
    throw fail("TIMEOUT", "撤销窗口已过期。");
  }
  trash.delete(id);
  store.notes.push(entry.note);
  entry.note.updatedAt = nowIso();
  schedulePersist();
  return { id, meta: metaOf(entry.note) };
}

async function copyText(payload) {
  const text = clampText(payload?.text, MAX_COPY_CHARS);
  if (!text) throw fail("INVALID_ARGUMENT", "没有可复制的内容。");
  await pi.clipboard.writeText(text);
  return { copied: text.length };
}

async function onPanelInvoke(channel, payload) {
  try {
    switch (channel) {
      case "note:list":
        return await listNotes(payload);
      case "note:read":
        return readNote(payload);
      case "note:create":
        return await createNote(payload);
      case "note:save":
        return saveNote(payload);
      case "note:pin":
        return pinNote(payload);
      case "note:delete":
        return deleteNote(payload);
      case "note:undoDelete":
        return undoDelete(payload);
      case "note:copy":
        return await copyText(payload);
      case "note:remember":
        return await rememberNote(payload);
      case "note:diag":
        return writeDiag(payload);
      default:
        throw fail("UNSUPPORTED", `未知通道：${String(channel)}`);
    }
  } catch (error) {
    log(`panel call ${String(channel)} failed: ${error?.code || ""} ${error?.message || error}`);
    throw error;
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

function commandTitle(locale) {
  return String(locale || "").toLowerCase().startsWith("zh") ? "笔记：打开笔记" : "Notes: Open notes";
}

async function openView() {
  try {
    await pi.ui.revealView({ viewId: VIEW_ID });
  } catch (error) {
    await pi.ui.showToast(
      error?.message || "无法打开笔记：请先打开一个会话，再从工作面板的“新建”菜单里选择“笔记”。",
      "warn",
    );
  }
}

async function onLoad() {
  try {
    dataDir = await pi.plugin.getDataPath();
    fs.mkdirSync(dataDir, { recursive: true });
    loadStore();
    loadProjectMemory();
  } catch (error) {
    dataDir = null;
    log(`data directory unavailable: ${error?.message || error}`);
  }

  let locale = "en";
  try {
    locale = await pi.app.getLocale();
  } catch {
    /* 保持英文 */
  }

  await pi.commands.register({
    id: COMMAND_ID,
    title: commandTitle(locale),
    keywords: ["note", "notes", "笔记", "memo"],
    run: openView,
  });
}

function onUnload() {
  try {
    flushPersist();
  } catch {
    /* unload 是尽力而为，失败已记日志 */
  }
  trash.clear();
  try {
    pi.commands.unregister(COMMAND_ID);
  } catch {
    /* 宿主卸载时会自行清理 */
  }
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
};