/*
 * Wrapped in an IIFE: the view page runs this as a classic script, so
 * top-level declarations would otherwise share the global lexical scope with
 * any other script the host or another plugin injects.
 */
(function () {
"use strict";

/**
 * Git Workbench — work-panel view.
 *
 * The page has no Node access: every action is one of this plugin's own
 * onPanelInvoke channels (git.state / git.stage / git.commit / …), so payloads
 * are validated in the plugin process, not here.
 */

const $ = (id) => document.getElementById(id);

const els = {
  shell: $("shell"),
  branchName: $("branchName"),
  repoName: $("repoName"),
  syncCount: $("syncCount"),
  refreshBtn: $("refreshBtn"),
  pullBtn: $("pullBtn"),
  pushBtn: $("pushBtn"),
  message: $("message"),
  genBtn: $("genBtn"),
  commitBtn: $("commitBtn"),
  commitLabel: $("commitLabel"),
  commitMenuBtn: $("commitMenuBtn"),
  commitMenu: $("commitMenu"),
  optPush: $("optPush"),
  optSignoff: $("optSignoff"),
  banner: $("banner"),
  lists: $("lists"),
  statusRepo: $("statusRepo"),
  statusLast: $("statusLast"),
  history: $("history"),
  historyHead: $("historyHead"),
  historyToggle: $("historyToggle"),
  historyCount: $("historyCount"),
  historyMore: $("historyMore"),
  historyBody: $("historyBody"),
  historyFoot: $("historyFoot"),
  commits: $("commits"),
  historyEmpty: $("historyEmpty"),
  overlay: $("overlay"),
  sheetTitle: $("sheetTitle"),
  sheetSub: $("sheetSub"),
  sheetBody: $("sheetBody"),
  sheetFoot: $("sheetFoot"),
  sheetBack: $("sheetBack"),
  sheetClose: $("sheetClose"),
  toasts: $("toasts"),
  split: $("split"),
  splitter: $("splitter"),
  diffPane: $("diffPane"),
  diffTitle: $("diffTitle"),
  diffSub: $("diffSub"),
  diffStat: $("diffStat"),
  diffBody: $("diffBody"),
  diffClose: $("diffClose"),
};

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const MOD_KEY = IS_MAC ? "⌘" : "Ctrl+";

/* The panel asks for one page at a time and caps growth like git.log does. */
const HISTORY_PAGE = 30;
const HISTORY_MAX = 200;

/* The composer grows up to this many lines, then scrolls. */
const MESSAGE_MAX_ROWS = 8;
let messageStream = null;

/* Split pane: the diff keeps at least DIFF_MIN, the work panel keeps MAIN_MIN. */
const DIFF_MIN = 200;
const MAIN_MIN = 200;
const DIFF_STEP = 24;

const state = {
  data: null,
  signature: "",
  busy: null,
  collapsed: { staged: false, changes: false },
  sheet: { mode: null, resolve: null, collect: null },
  pollTimer: null,
  history: {
    repoRoot: null,
    commits: [],
    limit: HISTORY_PAGE,
    truncated: false,
    expanded: null,
    files: new Map(),
    loading: false,
    loaded: false,
    collapsed: false,
    error: "",
  },

  /* The right-hand diff pane: the target it shows, plus a load token so a slow
   * response for an older target can never overwrite a newer one. */
  diff: {
    open: false,
    path: "",
    staged: false,
    sha: null,
    token: 0,
    width: 0,
  },
};

const CHEVRON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" class="ico"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DISCARD =
  '<svg viewBox="0 0 16 16" aria-hidden="true" class="ico"><path d="M6.5 3.3 3.9 5.9l2.6 2.6M3.9 5.9h5.4a3.2 3.2 0 0 1 0 6.4H5.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const FILE_TYPES = {
  ts: ["TS", "#3b82c4"],
  tsx: ["TS", "#3b82c4"],
  mts: ["TS", "#3b82c4"],
  cts: ["TS", "#3b82c4"],
  js: ["JS", "#d6b23a"],
  jsx: ["JS", "#d6b23a"],
  mjs: ["JS", "#d6b23a"],
  cjs: ["JS", "#d6b23a"],
  json: ["{ }", "#b5b53f"],
  css: ["CSS", "#7b5ea7"],
  scss: ["SCSS", "#c6538c"],
  less: ["LESS", "#5b83b5"],
  html: ["<>", "#c9603a"],
  vue: ["VUE", "#41b883"],
  svelte: ["SV", "#ff3e00"],
  md: ["MD", "#5c9dc4"],
  mdx: ["MDX", "#5c9dc4"],
  py: ["PY", "#3f6ea8"],
  go: ["GO", "#3aa7c4"],
  rs: ["RS", "#b9734c"],
  java: ["JV", "#9b5b3f"],
  kt: ["KT", "#8a6fc4"],
  rb: ["RB", "#a3443c"],
  php: ["PHP", "#5b62a0"],
  c: ["C", "#5c7c9d"],
  h: ["H", "#5c7c9d"],
  cpp: ["C++", "#5c7c9d"],
  cs: ["C#", "#4b8a4b"],
  swift: ["SW", "#d2763a"],
  sh: ["SH", "#6fae52"],
  zsh: ["SH", "#6fae52"],
  bash: ["SH", "#6fae52"],
  yml: ["YML", "#a44b4b"],
  yaml: ["YML", "#a44b4b"],
  toml: ["TML", "#94603c"],
  ini: ["INI", "#7a7a7a"],
  sql: ["SQL", "#b0873a"],
  lock: ["LCK", "#777777"],
  svg: ["SVG", "#c99a3a"],
  png: ["IMG", "#7c5cc4"],
  jpg: ["IMG", "#7c5cc4"],
  jpeg: ["IMG", "#7c5cc4"],
  gif: ["IMG", "#7c5cc4"],
  webp: ["IMG", "#7c5cc4"],
  ico: ["ICO", "#7c5cc4"],
  txt: ["TXT", "#7a7a7a"],
};

/* --------------------------------------------------------------------- i18n */

/*
 * The host owns the language: `app.getAppearance()` reports its locale and
 * `appearance:changed` fires when the user switches. Anything that is not
 * Chinese falls back to English, so a French or Japanese host gets English
 * instead of mixed text.
 */

const STRINGS = {
  zh: {
    "app.title": "Git Workbench",
    "time.now": "刚刚",
    "head.detached": "游离 HEAD",
    "head.unknown": "（未知）",
    "composer.hint": "消息({0}Enter 在“{1}”提交)",
    "composer.placeholder": "消息",
    "summary.counts": "{0} 个已暂存 · {1} 个未暂存",
    "banner.conflict": "存在未解决的合并冲突：解决冲突并暂存文件后再提交。",
    "commit.label": "提交",
    "commit.busy": "提交中…",
    "commit.root": "（根提交）",
    "commit.noSubject": "（无提交说明）",
    "commit.origPath": "原路径 {0}",
    "commit.filesLoading": "读取改动文件…",
    "commit.filesEmpty": "该提交没有文件改动。",
    "empty.title": "尚未打开项目",
    "empty.notRepo": "当前文件夹不是 git 仓库",
    "empty.body": "在 PI-Desktop 中打开一个 git 仓库所在的文件夹，然后返回这里。",
    "group.staged": "已暂存",
    "group.changes": "更改",
    "group.empty.staged": "没有已暂存的更改",
    "group.empty.changes": "没有未提交的更改",
    "collapse.aria": "折叠或展开{0}",
    "act.stage": "暂存",
    "act.unstage": "取消暂存",
    "act.discard": "放弃更改",
    "act.stageAll": "暂存全部更改",
    "act.unstageAll": "全部取消暂存",
    "act.discardAll": "放弃全部更改",
    "prop.commit": "提交",
    "prop.author": "作者",
    "prop.authorDate": "作者时间",
    "prop.commitDate": "提交时间",
    "prop.parents": "父提交",
    "prop.body": "说明",
    "history.title": "提交历史",
    "history.collapse": "折叠或展开提交历史",
    "history.more": "加载更多提交",
    "history.loadingMore": "正在加载更多提交…",
    "history.empty": "此仓库还没有提交记录。",
    "history.loading": "读取提交历史…",
    "diff.commitSub": "{0} · 提交差异",
    "diff.staged": "已暂存",
    "diff.worktree": "工作区",
    "diff.untracked": "未跟踪文件",
    "diff.conflict": "存在冲突",
    "patch.loading": "读取差异…",
    "patch.empty": "没有可显示的差异。",
    "patch.emptyUntracked": "该未跟踪文件没有可显示的文本差异。",
    "patch.emptyCommitFile": "该提交对这个文件没有可显示的文本差异。",
    "patch.truncated": "已截断：仅显示前 {0} 行（共 {1} 行）。",
    "confirm.cancel": "取消",
    "discard.title": "放弃更改",
    "discard.body": "放弃 {0} 的本地改动？此操作不可撤销。",
    "discard.files": "这 {0} 个文件",
    "toast.discarded": "已放弃更改",
    "toast.needMessage": "请先填写提交信息，或点右上角的 AI 按钮让模型写一条。",
    "toast.committed": "已提交 {0}",
    "toast.pushed": "已推送到远端",
    "toast.pushedShort": "已推送",
    "toast.upToDate": "已是最新",
    "gen.basedStaged": "已根据已暂存的改动生成提交信息",
    "gen.basedAll": "已根据全部改动生成提交信息",
    "err.generic": "操作失败。",
    "err.bridge": "pluginBridge 不可用：请在 PI-Desktop 面板中打开此页面。",
    "err.NO_WORKSPACE": "请先打开一个项目文件夹。",
    "err.NOT_A_REPO": "当前文件夹不是 git 仓库。",
    "err.NOTHING_TO_COMMIT": "没有可提交的改动。",
    "err.NO_MODEL": "请先在「设置 → 模型」中配置一个模型。",
    "err.EMPTY_COMPLETION": "模型没有返回内容，请重试。",
    "err.PROVIDER_UNAUTHORIZED": "模型未授权，请检查该服务在设置中的密钥。",
    "err.PROVIDER_RATE_LIMITED": "模型服务限流，请稍后重试。",
    "err.RATE_LIMITED": "操作太频繁，请稍后重试。",
    "err.TIMEOUT": "操作超时，请稍后重试。",
    "err.GIT_MISSING": "找不到 git，请确认已安装并已加入 PATH。",
    "err.NO_REMOTE": "仓库没有配置远端。",
    "err.DETACHED_HEAD": "当前处于游离 HEAD 状态，请先切换分支。",
    "err.PERMISSION_DENIED": "权限不足：请在插件页面授予所需权限后重新加载。",
    "err.INVALID_ARGUMENT": "参数不合法。",
    "err.HOST_KEY_UNKNOWN": "尚未信任该主机的主机密钥：请在推送窗口中核对该主机的指纹后再推送。",
    "err.HOST_KEY_CHANGED": "主机密钥与已记录的不一致，已拒绝写入。请确认远程主机没有被中间人替换。",
    "err.AUTH_FAILED": "认证失败：请确认 SSH 密钥或凭据对该仓库有推送权限。",
    "err.NO_UPSTREAM": "当前分支没有上游分支，请在推送窗口中确认远端分支。",
    "err.NON_FAST_FORWARD": "远端存在本地没有的提交：请先拉取（git pull）再推送。",
    "err.REPO_NOT_FOUND": "远端仓库不存在或没有访问权限，请检查远端地址。",
    "err.NETWORK": "无法连接远端：请检查网络、代理或 SSH 端口。",
    "err.SSH_UNAVAILABLE": "找不到 ssh、ssh-keygen 或 ssh-keyscan，无法确认主机指纹。",
    "err.SSH_SCAN_FAILED": "未能从远端读取主机密钥，请检查网络后重试。",
    "err.NO_KNOWN_HOSTS": "无法确定 known_hosts 文件的位置。",
    "err.SSH_FAILED": "检查 SSH 主机指纹时出错。",
    "err.GIT_FAILED": "git 操作失败。",
    "push.title": "推送到远端",
    "push.remote": "远端",
    "push.remoteBranch": "远端分支",
    "push.noUrl": "（未配置地址）",
    "push.setUpstreamNew": "推送后会把该远端分支设为上游（git push --set-upstream）。",
    "push.keepUpstream": "当前分支已关联上游；若改动远端或分支名，会一并更新上游。",
    "push.hostTrusted": "主机 {0} 的主机密钥已在 known_hosts 中，无需再次确认。",
    "push.hostKeyTitle": "确认主机 {0} 的指纹",
    "push.hostKeyNote": "以下密钥由 ssh-keyscan 读取。请与托管方公布的指纹逐字核对；确认后只把这几个密钥写入 {0}。",
    "push.hostKeyEmpty": "未能从该主机读取到主机密钥。",
    "push.sshUnsupported": "无法检查主机指纹：{0}。推送仍可能因为主机密钥校验失败而中断。",
    "push.branchInvalid": "分支名包含不允许的字符。",
    "push.needKey": "请至少勾选一个要信任的主机指纹。",
    "push.confirm": "确认并推送",
    "push.busy": "推送中…",
    "push.afterCommitFailed": "已提交，但推送失败：{0}",
    "html.branch": "当前分支",
    "html.pull": "拉取",
    "html.pullTip": "拉取（git pull）",
    "html.push": "推送",
    "html.pushTip": "推送（git push）",
    "html.refresh": "刷新",
    "html.message": "提交信息",
    "html.ai": "用 AI 生成提交信息",
    "html.commit": "提交",
    "html.more": "更多提交选项",
    "html.menuStaged": "仅提交已暂存",
    "html.menuAll": "提交全部更改",
    "html.menuPush": "提交后立即推送",
    "html.menuSignoff": "添加 Signed-off-by",
    "html.splitter": "调整差异面板宽度（双击恢复一半）",
    "html.diff": "文件差异",
    "html.diffClose": "关闭差异（Esc）",
    "html.back": "返回",
    "html.close": "关闭",
  },
  en: {
    "app.title": "Git Workbench",
    "time.now": "just now",
    "head.detached": "detached HEAD",
    "head.unknown": "(unknown)",
    "composer.hint": "Message ({0}Enter commits to \"{1}\")",
    "composer.placeholder": "Message",
    "summary.counts": "{0} staged · {1} unstaged",
    "banner.conflict": "Unresolved merge conflicts: resolve them and stage the files before committing.",
    "commit.label": "Commit",
    "commit.busy": "Committing…",
    "commit.root": "(root commit)",
    "commit.noSubject": "(no commit message)",
    "commit.origPath": "was {0}",
    "commit.filesLoading": "Reading changed files…",
    "commit.filesEmpty": "This commit changes no files.",
    "empty.title": "No project open",
    "empty.notRepo": "Not a git repository",
    "empty.body": "Open a folder that contains a git repository in PI-Desktop, then come back here.",
    "group.staged": "Staged",
    "group.changes": "Changes",
    "group.empty.staged": "No staged changes",
    "group.empty.changes": "No uncommitted changes",
    "collapse.aria": "Collapse or expand {0}",
    "act.stage": "Stage",
    "act.unstage": "Unstage",
    "act.discard": "Discard changes",
    "act.stageAll": "Stage all changes",
    "act.unstageAll": "Unstage all",
    "act.discardAll": "Discard all changes",
    "prop.commit": "Commit",
    "prop.author": "Author",
    "prop.authorDate": "Authored",
    "prop.commitDate": "Committed",
    "prop.parents": "Parents",
    "prop.body": "Message",
    "history.title": "Commit history",
    "history.collapse": "Collapse or expand commit history",
    "history.more": "Load more commits",
    "history.loadingMore": "Loading more commits…",
    "history.empty": "No commits in this repository yet.",
    "history.loading": "Reading commit history…",
    "diff.commitSub": "{0} · commit diff",
    "diff.staged": "Staged",
    "diff.worktree": "Working tree",
    "diff.untracked": "Untracked file",
    "diff.conflict": "Conflict",
    "patch.loading": "Reading diff…",
    "patch.empty": "No diff to show.",
    "patch.emptyUntracked": "No textual diff for this untracked file.",
    "patch.emptyCommitFile": "No textual diff for this file in this commit.",
    "patch.truncated": "Truncated: showing the first {0} of {1} lines.",
    "confirm.cancel": "Cancel",
    "discard.title": "Discard changes",
    "discard.body": "Discard local changes in {0}? This cannot be undone.",
    "discard.files": "these {0} files",
    "toast.discarded": "Changes discarded",
    "toast.needMessage": "Write a commit message first, or use the AI button at the top right.",
    "toast.committed": "Committed {0}",
    "toast.pushed": "Pushed to remote",
    "toast.pushedShort": "Pushed",
    "toast.upToDate": "Already up to date",
    "gen.basedStaged": "Generated from the staged changes",
    "gen.basedAll": "Generated from all changes",
    "err.generic": "Something went wrong.",
    "err.bridge": "pluginBridge unavailable: open this page inside a PI-Desktop panel.",
    "err.NO_WORKSPACE": "Open a project folder first.",
    "err.NOT_A_REPO": "This folder is not a git repository.",
    "err.NOTHING_TO_COMMIT": "Nothing to commit.",
    "err.NO_MODEL": "Configure a model in Settings → Models first.",
    "err.EMPTY_COMPLETION": "The model returned nothing. Try again.",
    "err.PROVIDER_UNAUTHORIZED": "Model not authorized. Check the service key in Settings.",
    "err.PROVIDER_RATE_LIMITED": "The model service is rate limiting. Try again later.",
    "err.RATE_LIMITED": "Too many requests. Try again later.",
    "err.TIMEOUT": "The operation timed out. Try again.",
    "err.GIT_MISSING": "git not found. Make sure it is installed and on PATH.",
    "err.NO_REMOTE": "This repository has no remote configured.",
    "err.DETACHED_HEAD": "HEAD is detached. Switch to a branch first.",
    "err.PERMISSION_DENIED": "Permission denied. Grant the permission on the Plugins page and reload.",
    "err.INVALID_ARGUMENT": "Invalid argument.",
    "err.HOST_KEY_UNKNOWN": "This host's key is not trusted yet: check its fingerprints in the push dialog first.",
    "err.HOST_KEY_CHANGED": "The host key does not match the recorded one, so nothing was written. Make sure the remote is not being impersonated.",
    "err.AUTH_FAILED": "Authentication failed: check that your SSH key or credentials may push to this repository.",
    "err.NO_UPSTREAM": "This branch has no upstream branch. Confirm the remote branch in the push dialog.",
    "err.NON_FAST_FORWARD": "The remote has commits you do not have: pull first, then push.",
    "err.REPO_NOT_FOUND": "The remote repository does not exist or you have no access. Check the remote URL.",
    "err.NETWORK": "Cannot reach the remote: check your network, proxy or SSH port.",
    "err.SSH_UNAVAILABLE": "ssh, ssh-keygen or ssh-keyscan was not found, so host keys cannot be confirmed.",
    "err.SSH_SCAN_FAILED": "Could not read the host keys from this host. Check the network and try again.",
    "err.NO_KNOWN_HOSTS": "Could not determine where the known_hosts file lives.",
    "err.SSH_FAILED": "Checking the SSH host key failed.",
    "err.GIT_FAILED": "The git command failed.",
    "push.title": "Push to remote",
    "push.remote": "Remote",
    "push.remoteBranch": "Remote branch",
    "push.noUrl": "(no URL configured)",
    "push.setUpstreamNew": "This push also sets the remote branch as upstream (git push --set-upstream).",
    "push.keepUpstream": "This branch already tracks an upstream; changing the remote or the branch name updates it too.",
    "push.hostTrusted": "The host key of {0} is already in known_hosts, so nothing is asked.",
    "push.hostKeyTitle": "Confirm the fingerprints of {0}",
    "push.hostKeyNote": "These keys were read with ssh-keyscan. Compare them character by character with the fingerprints your host publishes; only the ticked keys are written to {0}.",
    "push.hostKeyEmpty": "No host key could be read from this host.",
    "push.sshUnsupported": "The host key cannot be checked: {0}. The push may still fail on host key verification.",
    "push.branchInvalid": "The branch name contains characters that are not allowed.",
    "push.needKey": "Tick at least one host key fingerprint to trust.",
    "push.confirm": "Confirm and push",
    "push.busy": "Pushing…",
    "push.afterCommitFailed": "Committed, but the push failed: {0}",
    "html.branch": "Current branch",
    "html.pull": "Pull",
    "html.pullTip": "Pull (git pull)",
    "html.push": "Push",
    "html.pushTip": "Push (git push)",
    "html.refresh": "Refresh",
    "html.message": "Commit message",
    "html.ai": "Generate the commit message with AI",
    "html.commit": "Commit",
    "html.more": "More commit options",
    "html.menuStaged": "Commit staged only",
    "html.menuAll": "Commit all changes",
    "html.menuPush": "Push after committing",
    "html.menuSignoff": "Add Signed-off-by",
    "html.splitter": "Resize the diff pane (double-click to reset)",
    "html.diff": "File diff",
    "html.diffClose": "Close the diff (Esc)",
    "html.back": "Back",
    "html.close": "Close",
  },
};

const ERROR_CODES = new Set(
  Object.keys(STRINGS.zh)
    .filter((key) => /^err\.[A-Z]/.test(key))
    .map((key) => key.slice(4)),
);

let UI_LANG = "zh";
let languageApplied = false;

function t(key, ...args) {
  const table = STRINGS[UI_LANG] || STRINGS.zh;
  const text = table[key] ?? STRINGS.zh[key] ?? key;
  return args.length
    ? args.reduce((out, arg, index) => out.split(`{${index}}`).join(String(arg)), text)
    : text;
}

/** Static markup carries data-i18n* hooks so it follows the same table. */
function applyStaticStrings() {
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll("[data-i18n-title]")) {
    node.title = t(node.dataset.i18nTitle);
  }
  for (const node of document.querySelectorAll("[data-i18n-aria]")) {
    node.setAttribute("aria-label", t(node.dataset.i18nAria));
  }
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }
}

function makeRelativeTime() {
  return typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat === "function"
    ? new Intl.RelativeTimeFormat(UI_LANG === "zh" ? "zh-CN" : "en", { numeric: "auto" })
    : null;
}

function setLanguage(locale) {
  const next = typeof locale === "string" && /^zh\b/i.test(locale) ? "zh" : "en";
  const changed = languageApplied && next !== UI_LANG;
  UI_LANG = next;
  RELATIVE_TIME = makeRelativeTime();
  document.documentElement.lang = typeof locale === "string" && locale ? locale : next;
  document.title = t("app.title");
  applyStaticStrings();
  if (changed) {
    renderHeader();
    renderLists();
    renderHistory();
  }
  languageApplied = true;
}

// --------------------------------------------------------------------- utils

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function bridge() {
  const api = window.pluginBridge;
  if (!api || typeof api.invoke !== "function") {
    throw Object.assign(new Error(t("err.bridge")), {
      code: "NO_BRIDGE",
    });
  }
  return api;
}

function invoke(channel, payload) {
  return bridge().invoke(channel, payload || {});
}

function errorText(error) {
  const raw = String(error?.message || error || "");
  const code =
    error?.errorCode ||
    error?.code ||
    (raw.match(/^([A-Z][A-Z0-9_]{2,}):/) || [])[1] ||
    "";
  if (ERROR_CODES.has(code)) return t(`err.${code}`);
  const cleaned = raw.replace(/^[A-Z][A-Z0-9_]{2,}:\s*/, "").trim();
  return cleaned || t("err.generic");
}

function fileBadge(filePath) {
  const name = String(filePath).slice(String(filePath).lastIndexOf("/") + 1);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const entry = FILE_TYPES[ext];
  if (entry) return { label: entry[0], color: entry[1] };
  return { label: ext ? ext.slice(0, 2).toUpperCase() : "·", color: "#7a7a7a" };
}

function splitPath(filePath) {
  const index = filePath.lastIndexOf("/");
  if (index === -1) return { name: filePath, dir: "" };
  return { name: filePath.slice(index + 1), dir: filePath.slice(0, index) };
}

function firstLine(text, limit = 220) {
  const line = String(text || "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) return "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

// ------------------------------------------------------------------ history

/*
 * Commit history is a separate read-only view: it never takes part in
 * applyState()'s signature check, so staging files does not repaint it.
 */

let RELATIVE_TIME = makeRelativeTime();

const TIME_UNITS = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

function parseTime(iso) {
  const time = Date.parse(iso || "");
  return Number.isFinite(time) ? time : null;
}

function absoluteTime(iso) {
  const time = parseTime(iso);
  if (time === null) return "";
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** "3 days ago" style, localised via Intl.RelativeTimeFormat for the UI language. */
function relativeTime(iso) {
  const time = parseTime(iso);
  if (time === null) return "";
  const seconds = (time - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 45) return t("time.now");
  for (const [unit, size] of TIME_UNITS) {
    if (abs < size && unit !== "minute") continue;
    const value = Math.round(seconds / size);
    return RELATIVE_TIME ? RELATIVE_TIME.format(value, unit) : absoluteTime(iso);
  }
  return absoluteTime(iso);
}
function toast(text, kind = "info") {
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.kind = kind;
  node.textContent = text;
  els.toasts.appendChild(node);
  setTimeout(() => {
    node.remove();
  }, kind === "error" ? 6000 : 3200);
}

function showBanner(text, kind = "error") {
  if (!text) {
    els.banner.hidden = true;
    els.banner.textContent = "";
    return;
  }
  els.banner.hidden = false;
  els.banner.dataset.kind = kind;
  els.banner.textContent = text;
}

// ----------------------------------------------------------------- appearance

/*
 * A panel is its own document, so the host never hands us its `--ds-*` design
 * tokens. `app.getAppearance()` does return the active theme, and a plugin theme
 * carries that theme's CSS text, so the panel mirrors every palette family it
 * can: surfaces, borders, text and the semantic state colours. Whatever a theme
 * does not define keeps the `:root` literal in panel.css, which already tracks
 * the host's own palette.
 */

const THEME_TOKENS = {
  "--bg": ["bg-primary"],
  "--bg-soft": ["bg-secondary"],
  "--surface": ["bg-tertiary", "bg-secondary"],
  "--surface-hover": ["bg-hover", "tile-hover", "bg-elevated"],
  "--field": ["field-inset-bg", "bg-inset"],
  "--border": ["border-default"],
  "--border-soft": ["border-subtle"],
  "--fg": ["text-primary"],
  "--fg-strong": ["text-primary"],
  "--muted": ["text-muted", "text-secondary"],
  "--muted-dim": ["text-faint", "text-tertiary"],
  "--add": ["success"],
  "--del": ["error"],
  "--danger": ["error"],
  "--mod": ["warning"],
  "--conflict": ["warning"],
};

function themeTokensFromCss(css) {
  const tokens = new Map();
  if (typeof css !== "string" || !css) return tokens;
  for (const match of css.matchAll(/--ds-([a-z0-9-]+)\s*:\s*([^;{}]+)/gi)) {
    const value = match[2].trim();
    // `var(--gray-0)` chains would resolve to nothing in this document.
    if (value && !/var\(/i.test(value)) tokens.set(match[1].toLowerCase(), value);
  }
  return tokens;
}

const NEUTRAL_COLORS = new Set(["white", "black", "gray", "grey", "silver", "transparent"]);

/*
 * White / black / grey. The host's own accent is `#fff` in dark and ink
 * `#1a1c1f` in light, which would flatten our highlight into a neutral, so an
 * accent token only lands when it actually carries a hue.
 */
function isNeutralColor(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return true;
  if (NEUTRAL_COLORS.has(raw)) return true;
  let rgb = null;
  const hex = /^#([0-9a-f]{3,8})$/.exec(raw);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map((digit) => digit + digit).join("");
    }
    if (digits.length < 6) return false;
    rgb = [0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16));
  } else {
    const fn = /^rgba?\(([^)]+)\)$/.exec(raw);
    if (!fn) return false;
    rgb = fn[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((part) => (part.endsWith("%") ? (parseFloat(part) * 255) / 100 : parseFloat(part)));
    if (rgb.length !== 3 || rgb.some((channel) => !Number.isFinite(channel))) return false;
  }
  const [r, g, b] = rgb;
  return Math.max(r, g, b) - Math.min(r, g, b) <= 12;
}

function applyThemeTokens(appearance) {
  const tokens = themeTokensFromCss(appearance?.pluginTheme?.css);
  const root = document.documentElement;
  const overrides = new Map();
  for (const [name, candidates] of Object.entries(THEME_TOKENS)) {
    const value = candidates.map((key) => tokens.get(key)).find(Boolean);
    if (value) overrides.set(name, value);
  }
  const accent = tokens.get("accent");
  if (accent && !isNeutralColor(accent)) overrides.set("--accent", accent);
  // Primary action pair kept for the commit button: text-primary on bg-primary.
  const primary = tokens.get("text-primary") || accent;
  const surface = tokens.get("bg-primary");
  if (primary) overrides.set("--theme-primary", primary);
  if (surface) overrides.set("--theme-primary-fg", surface);
  for (const name of [...Object.keys(THEME_TOKENS), "--accent", "--theme-primary", "--theme-primary-fg"]) {
    if (overrides.has(name)) root.style.setProperty(name, overrides.get(name));
    else root.style.removeProperty(name);
  }
}

function applyAppearance(appearance) {
  const base = appearance?.base;
  document.documentElement.dataset.base =
    base === "light" || base === "dark"
      ? base
      : window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  applyThemeTokens(appearance);
  setLanguage(appearance?.locale);
}

// ------------------------------------------------------------------- rendering

function signatureOf(data) {
  if (!data) return "";
  return JSON.stringify([
    data.repo?.root || null,
    data.branch,
    data.upstream,
    data.ahead,
    data.behind,
    data.detached,
    (data.staged || []).map((entry) => `${entry.path}:${entry.letter}:${entry.code}`),
    (data.changes || []).map((entry) => `${entry.path}:${entry.letter}:${entry.code}`),
  ]);
}

function applyState(data, options = {}) {
  if (!data) return;
  state.data = data;
  const signature = signatureOf(data);
  renderHeader();

  // Another repository invalidates the history and its cached file lists.
  const repoRoot = data?.repo?.root || null;
  if (state.history.repoRoot !== repoRoot) {
    state.history.repoRoot = repoRoot;
    resetHistory();
    renderHistory();
  }

  if (options.quiet && signature === state.signature) return;
  state.signature = signature;
  renderLists();
}

function renderHeader() {
  const data = state.data;
  const hasRepo = Boolean(data && data.repo);
  const branch = hasRepo ? (data.detached ? t("head.detached") : data.branch || t("head.unknown")) : "—";

  els.branchName.textContent = branch;
  els.repoName.textContent = hasRepo
    ? data.repo.name
    : data?.workspace?.name || "";
  els.repoName.title = hasRepo ? data.repo.root : "";

  els.message.placeholder = hasRepo
    ? t("composer.hint", MOD_KEY, branch)
    : t("composer.placeholder");

  const tracking = [];
  if (hasRepo && data.ahead > 0) tracking.push(`↑${data.ahead}`);
  if (hasRepo && data.behind > 0) tracking.push(`↓${data.behind}`);
  els.syncCount.hidden = tracking.length === 0;
  els.syncCount.textContent = tracking.join(" ");

  const totals = data?.counts || { staged: 0, changes: 0, total: 0 };
  els.statusRepo.textContent = hasRepo
    ? t("summary.counts", totals.staged, totals.changes)
    : "";
  els.statusLast.textContent = hasRepo && data.lastCommit
    ? `${data.lastCommit.shortSha} ${data.lastCommit.subject}`
    : "";
  els.statusLast.title = els.statusLast.textContent;

  if (data?.hasConflicts) {
    showBanner(t("banner.conflict"), "error");
  } else {
    showBanner("");
  }

  refreshButtons();
}

function refreshButtons() {
  const data = state.data;
  const busy = Boolean(state.busy);
  const hasRepo = Boolean(data && data.repo);
  const dirty = Boolean(hasRepo && data.counts && data.counts.total > 0);

  els.pullBtn.disabled = busy || !hasRepo;
  els.pushBtn.disabled = busy || !hasRepo;
  els.refreshBtn.disabled = busy || !hasRepo;
  els.commitBtn.disabled = busy || !hasRepo || !dirty;
  els.commitMenuBtn.disabled = busy || !hasRepo;
  els.genBtn.disabled = busy || !hasRepo || !dirty;
  els.genBtn.dataset.busy = state.busy === "generate" ? "true" : "false";

  els.commitLabel.textContent = state.busy === "commit" ? t("commit.busy") : t("commit.label");
  els.pullBtn.dataset.busy = state.busy === "pull" ? "true" : "false";
  els.pushBtn.dataset.busy = state.busy === "push" ? "true" : "false";
}

function renderLists() {
  const data = state.data;

  if (!data || !data.repo) {
    const title = data?.reason === "NOT_A_REPO" ? t("empty.notRepo") : t("empty.title");
    els.lists.innerHTML = `<div class="empty"><strong>${title}</strong> ${t("empty.body")}</div>`;
    return;
  }

  const parts = [];
  if (data.staged.length > 0) {
    parts.push(groupHtml("staged", t("group.staged"), data.staged, true));
  }
  parts.push(groupHtml("changes", t("group.changes"), data.changes, false));
  els.lists.innerHTML = parts.join("");
}

function groupHtml(key, title, entries, staged) {
  const collapsed = state.collapsed[key];
  // The icons stay on screen even for an empty group, so they read as
  // unavailable instead of disappearing.
  const idle = entries.length === 0 ? " disabled" : "";
  const actions = staged
    ? `<button class="mini"${idle} data-act="unstage-all" title="${t("act.unstageAll")}" aria-label="${t("act.unstageAll")}">−</button>`
    : `<button class="mini"${idle} data-act="stage-all" title="${t("act.stageAll")}" aria-label="${t("act.stageAll")}">＋</button>` +
      `<button class="mini"${idle} data-act="discard-all" title="${t("act.discardAll")}" aria-label="${t("act.discardAll")}">${DISCARD}</button>`;
  const rows = entries.map((entry) => fileRow(entry, staged)).join("");
  const body = collapsed
    ? ""
    : `<ul class="files">${
        rows ||
        `<li class="empty">${
        key === "changes" ? t("group.empty.changes") : t("group.empty.staged")
        }</li>`
      }</ul>`;

  return `<section class="group">
    <header class="group-head">
      <button class="collapse" data-toggle="${key}" data-collapsed="${collapsed}" aria-expanded="${!collapsed}" aria-label="${t("collapse.aria", title)}">${CHEVRON}</button>
      <h2>${title}</h2>
      ${entries.length > 0 ? `<span class="count">${entries.length}</span>` : ""}
      <div class="group-actions">${actions}</div>
    </header>
    ${body}
  </section>`;
}

function fileRow(entry, staged) {
  const badge = fileBadge(entry.path);
  const { name, dir } = splitPath(entry.path);
  const path = escapeHtml(entry.path);
  const actions = staged
    ? `<button class="mini" data-act="unstage" data-path="${path}" title="${t("act.unstage")}" aria-label="${t("act.unstage")}">−</button>`
    : `<button class="mini" data-act="stage" data-path="${path}" title="${t("act.stage")}" aria-label="${t("act.stage")}">＋</button>` +
      (entry.conflict
        ? ""
        : `<button class="mini" data-act="discard" data-path="${path}" title="${t("act.discard")}" aria-label="${t("act.discard")}">${DISCARD}</button>`);

  return `<li class="file" data-path="${path}" data-staged="${staged ? "1" : "0"}" data-untracked="${
    entry.untracked ? "1" : "0"
  }" data-conflict="${entry.conflict ? "1" : "0"}" tabindex="0" role="button" title="${path}">
    <span class="ftype" style="--ft:${badge.color}">${escapeHtml(badge.label)}</span>
    <span class="ftext"><span class="fname">${escapeHtml(name)}</span>${
      dir ? `<span class="fdir">${escapeHtml(dir)}</span>` : ""
    }</span>
    <span class="factions">${actions}</span>
    <span class="fstat stat-${entry.letter}">${escapeHtml(entry.letter)}</span>
  </li>`;
}

// ------------------------------------------------------------- commit history

function resetHistory() {
  const history = state.history;
  history.commits = [];
  history.limit = HISTORY_PAGE;
  history.truncated = false;
  history.expanded = null;
  history.files.clear();
  history.loading = false;
  history.loaded = false;
  history.error = "";
}

function commitPropsHtml(commit) {
  const parents = commit.parents.length
    ? commit.parents.map((sha) => `<span class="mono">${escapeHtml(sha.slice(0, 7))}</span>`).join(" ")
    : t("commit.root");
  const committer =
    commit.committer && commit.committer !== commit.author
      ? `<span class="props-rel">${escapeHtml(commit.committer)}</span>`
      : "";
  const rows = [
    [t("prop.commit"), `<span class="mono">${escapeHtml(commit.sha)}</span>`],
    [t("prop.author"), escapeHtml(commit.author)],
    [
      t("prop.authorDate"),
      `${escapeHtml(absoluteTime(commit.authorDate))}<span class="props-rel">${escapeHtml(
        relativeTime(commit.authorDate),
      )}</span>`,
    ],
    [t("prop.commitDate"), `${escapeHtml(absoluteTime(commit.commitDate))}${committer}`],
    [t("prop.parents"), parents],
  ];
  if (commit.body) rows.push([t("prop.body"), `<span class="props-body">${escapeHtml(commit.body)}</span>`]);

  return `<dl class="props">${rows
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`)
    .join("")}</dl>`;
}

function commitFileRow(sha, file) {
  const badge = fileBadge(file.path);
  const { name, dir } = splitPath(file.path);
  const path = escapeHtml(file.path);
  return `<li class="commit-file" data-sha="${escapeHtml(sha)}" data-path="${path}" tabindex="0" role="button" title="${path}">
    <span class="ftype" style="--ft:${badge.color}">${escapeHtml(badge.label)}</span>
    <span class="ftext"><span class="fname">${escapeHtml(name)}</span>${
      dir ? `<span class="fdir">${escapeHtml(dir)}</span>` : ""
    }</span>
    ${
      file.origPath
        ? `<span class="corig" title="${t("commit.origPath", escapeHtml(file.origPath))}">← ${escapeHtml(file.origPath)}</span>`
        : ""
    }
    <span class="fstat stat-${escapeHtml(file.letter)}">${escapeHtml(file.letter)}</span>
  </li>`;
}

function commitFilesHtml(sha) {
  const entry = state.history.files.get(sha);
  if (!entry) return `<div class="commit-files-note">${t("commit.filesLoading")}</div>`;
  if (entry.error) return `<div class="commit-files-note">${escapeHtml(entry.error)}</div>`;
  if (entry.files.length === 0) return `<div class="commit-files-note">${t("commit.filesEmpty")}</div>`;
  return `<ul class="commit-files">${entry.files
    .map((file) => commitFileRow(sha, file))
    .join("")}</ul>`;
}

function commitRowHtml(commit) {
  const expanded = state.history.expanded === commit.sha;
  const subject = commit.subject || t("commit.noSubject");
  const title = `${subject} — ${commit.author} · ${absoluteTime(commit.authorDate)}`;
  return `<li class="commit" data-sha="${escapeHtml(commit.sha)}" data-expanded="${expanded ? "1" : "0"}">
    <div class="commit-line" role="button" tabindex="0" aria-expanded="${expanded}" title="${escapeHtml(title)}">
      <span class="csha">${escapeHtml(commit.shortSha)}</span>
      <span class="csub">${escapeHtml(subject)}</span>
      <span class="cauthor">${escapeHtml(commit.author)}</span>
      <span class="ctime">· ${escapeHtml(relativeTime(commit.authorDate))}</span>
    </div>
    ${expanded ? `<div class="commit-detail">${commitPropsHtml(commit)}${commitFilesHtml(commit.sha)}</div>` : ""}
  </li>`;
}

function renderHistory() {
  const history = state.history;
  const hasRepo = Boolean(state.data && state.data.repo);
  els.history.hidden = !hasRepo;
  if (!hasRepo) {
    els.commits.innerHTML = "";
    els.historyEmpty.hidden = true;
    return;
  }

  els.historyToggle.dataset.collapsed = history.collapsed ? "true" : "false";
  els.history.dataset.collapsed = history.collapsed ? "true" : "false";
  els.historyToggle.setAttribute("aria-expanded", String(!history.collapsed));
  els.historyBody.hidden = history.collapsed;
  syncHistoryFoot();
  els.historyCount.hidden = history.commits.length === 0;
  els.historyCount.textContent = String(history.commits.length);

  // Keep the reader where they were when only the expanded row changed.
  const scrollTop = els.historyBody.scrollTop;
  els.commits.innerHTML = history.commits.map(commitRowHtml).join("");
  els.historyBody.scrollTop = scrollTop;

  if (history.commits.length > 0) {
    els.historyEmpty.hidden = true;
    return;
  }
  els.historyEmpty.hidden = false;
  els.historyEmpty.textContent =
    history.error || (history.loaded ? t("history.empty") : t("history.loading"));
}

/* The header button and the footer both follow "there is another page", not
 * the raw flag: git may still report truncation once the cap is reached. */
function canLoadMoreHistory(history) {
  return !history.collapsed && history.truncated && history.limit < HISTORY_MAX;
}

function syncHistoryFoot() {
  const history = state.history;
  const more = canLoadMoreHistory(history);
  els.historyMore.hidden = !more || history.loading;
  els.historyFoot.hidden = !more || !history.loading;
  els.historyFoot.textContent = els.historyFoot.hidden ? "" : t("history.loadingMore");
}

/*
 * Reaching the bottom of the list loads the next page by itself. The header
 * button stays for keyboard users and as the retry after a failed load, and a
 * page that lands short of the pane asks for the next one until it scrolls.
 */
const HISTORY_AUTOLOAD_GAP = 48;
let historyCheckFrame = 0;

function maybeLoadMoreHistory() {
  const history = state.history;
  if (history.loading || history.error) return;
  if (!canLoadMoreHistory(history)) return;
  const body = els.historyBody;
  if (body.hidden) return;
  if (body.scrollHeight - body.scrollTop - body.clientHeight > HISTORY_AUTOLOAD_GAP) return;
  loadMoreHistory();
}

function scheduleHistoryCheck() {
  if (historyCheckFrame) return;
  historyCheckFrame = requestAnimationFrame(() => {
    historyCheckFrame = 0;
    maybeLoadMoreHistory();
  });
}

async function loadHistory(options = {}) {
  const history = state.history;
  if (history.loading) return;
  if (!state.data || !state.data.repo) {
    history.commits = [];
    renderHistory();
    return;
  }

  const limit = Math.min(Math.max(Number(options.limit) || history.limit, 1), HISTORY_MAX);
  history.loading = true;
  if (!history.loaded) renderHistory();
  else syncHistoryFoot();

  try {
    const result = await invoke("git.log", { limit });
    const previousCount = history.commits.length;
    history.commits = Array.isArray(result?.commits) ? result.commits : [];
    history.limit = Number(result?.limit) || limit;
    // A page that adds nothing means git has nothing left to give: stop
    // offering another one instead of asking again on every scroll.
    history.truncated = Boolean(result?.truncated) && history.commits.length > previousCount;
    history.error = "";
    history.loaded = true;

    // Drop cached file lists for commits that fell out of the current page.
    const present = new Set(history.commits.map((commit) => commit.sha));
    if (history.expanded && !present.has(history.expanded)) history.expanded = null;
    for (const sha of [...history.files.keys()]) {
      if (!present.has(sha)) history.files.delete(sha);
    }
  } catch (error) {
    history.error = errorText(error);
    history.loaded = true;
    if (history.commits.length === 0) toast(history.error, "error");
  } finally {
    history.loading = false;
    renderHistory();
    // A page shorter than the pane leaves it unscrollable: fill it right away.
    scheduleHistoryCheck();
  }
}

function loadMoreHistory() {
  const history = state.history;
  const next = Math.min(history.limit + HISTORY_PAGE, HISTORY_MAX);
  if (next <= history.limit) return;
  // Clearing the last failure lets the header button retry the page the
  // auto-load gave up on.
  history.error = "";
  loadHistory({ limit: next });
}

async function loadCommitFiles(sha) {
  try {
    const result = await invoke("git.commitFiles", { sha });
    state.history.files.set(sha, {
      files: Array.isArray(result?.files) ? result.files : [],
      error: "",
    });
  } catch (error) {
    state.history.files.set(sha, { files: [], error: errorText(error) });
  }
  if (state.history.expanded === sha) renderHistory();
}

async function toggleCommit(sha) {
  const history = state.history;
  if (!sha) return;
  if (history.expanded === sha) {
    history.expanded = null;
    renderHistory();
    return;
  }
  history.expanded = sha;
  renderHistory();
  const row = els.commits.querySelector(`.commit[data-sha="${sha}"] .commit-line`);
  if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  if (!history.files.has(sha)) await loadCommitFiles(sha);
}

/** One file inside one commit, shown in the same split pane the working diff uses. */
function openCommitDiff(sha, filePath) {
  const short = String(sha).slice(0, 7);
  const token = beginDiff({ path: filePath, sha });
  openDiffPane({
    title: filePath,
    sub: t("diff.commitSub", short),
    body: `<div class="patch-note">${t("patch.loading")}</div>`,
  });

  return invoke("git.commitDiff", { sha, path: filePath }).then(
    (result) => showPatch(token, result?.patch, `<div class="patch-note">${t("patch.emptyCommitFile")}</div>`),
    (error) => {
      if (state.diff.token !== token) return;
      els.diffBody.innerHTML = `<div class="patch-note">${escapeHtml(errorText(error))}</div>`;
    },
  );
}

// ---------------------------------------------------------------- split pane

function splitBounds() {
  const total = els.split.clientWidth || 0;
  const max = Math.max(total - MAIN_MIN, 0);
  return { total, min: Math.min(DIFF_MIN, max), max };
}

/** Clamp the requested diff width and hand it to CSS; the pane reads it back. */
function setDiffWidth(width) {
  const { total, min, max } = splitBounds();
  if (!total) return;
  const next = Math.round(Math.min(Math.max(Number(width) || 0, min), max));
  if (next === state.diff.width && els.split.style.getPropertyValue("--diff-width")) return;
  state.diff.width = next;
  els.split.style.setProperty("--diff-width", `${next}px`);
  els.splitter.setAttribute("aria-valuemin", String(min));
  els.splitter.setAttribute("aria-valuemax", String(max));
  els.splitter.setAttribute("aria-valuenow", String(next));
}

function openDiffPane({ title, sub, body }) {
  els.diffTitle.textContent = title || "";
  els.diffTitle.title = title || "";
  els.diffSub.textContent = sub || "";
  els.diffSub.hidden = !sub;
  els.diffStat.hidden = true;
  els.diffStat.textContent = "";
  els.diffBody.innerHTML = body || "";
  els.diffBody.scrollTop = 0;
  els.diffPane.hidden = false;
  els.splitter.hidden = false;
  state.diff.open = true;
  setDiffWidth(state.diff.width || splitBounds().total / 2);
}

function closeDiffPane() {
  state.diff.token += 1; // drop any in-flight load
  state.diff.open = false;
  state.diff.path = "";
  state.diff.staged = false;
  state.diff.sha = null;
  els.diffPane.hidden = true;
  els.splitter.hidden = true;
  els.diffBody.innerHTML = "";
  els.diffStat.hidden = true;
  els.diffStat.textContent = "";
  els.diffTitle.textContent = "";
  els.diffSub.textContent = "";
  els.split.style.removeProperty("--diff-width");
}

/** Point the pane at a new target, and return the token that guards its load. */
function beginDiff(target) {
  state.diff.token += 1;
  state.diff.path = target.path || "";
  state.diff.staged = Boolean(target.staged);
  state.diff.sha = target.sha || null;
  return state.diff.token;
}

function patchStat(patch) {
  let add = 0;
  let del = 0;
  for (const line of String(patch).split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add += 1;
    else if (line.startsWith("-")) del += 1;
  }
  return { add, del };
}

function showDiffStat(stat) {
  if (!stat || (!stat.add && !stat.del)) {
    els.diffStat.hidden = true;
    els.diffStat.textContent = "";
    return;
  }
  els.diffStat.innerHTML = `<span class="dstat-add">+${stat.add}</span><span class="dstat-del">−${stat.del}</span>`;
  els.diffStat.hidden = false;
}

/** Render a patch unless the pane has already moved on to another target. */
function showPatch(token, patch, emptyHtml) {
  if (state.diff.token !== token) return;
  const text = String(patch || "");
  if (!text.trim()) {
    showDiffStat(null);
    els.diffBody.innerHTML = emptyHtml;
    return;
  }
  showDiffStat(patchStat(text));
  els.diffBody.innerHTML = patchHtml(text);
  els.diffBody.scrollTop = 0;
}

function onSplitterDown(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  const right = els.split.getBoundingClientRect().right;
  els.splitter.dataset.dragging = "true";
  document.body.classList.add("is-resizing");
  if (typeof els.splitter.setPointerCapture === "function") {
    els.splitter.setPointerCapture(event.pointerId);
  }

  const move = (moveEvent) => setDiffWidth(right - moveEvent.clientX);
  const stop = () => {
    els.splitter.removeEventListener("pointermove", move);
    els.splitter.removeEventListener("pointerup", stop);
    els.splitter.removeEventListener("pointercancel", stop);
    delete els.splitter.dataset.dragging;
    document.body.classList.remove("is-resizing");
  };

  els.splitter.addEventListener("pointermove", move);
  els.splitter.addEventListener("pointerup", stop);
  els.splitter.addEventListener("pointercancel", stop);
}

function onSplitterKey(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  // ArrowLeft pulls the divider left, which gives the diff pane more room.
  const step = (event.shiftKey ? 64 : DIFF_STEP) * (event.key === "ArrowLeft" ? 1 : -1);
  setDiffWidth(state.diff.width + step);
}

// ----------------------------------------------------------------------- sheet

function openSheet({ title, sub, body, footer, mode, collect }) {
  els.sheetTitle.textContent = title || "";
  els.sheetSub.textContent = sub || "";
  els.sheetSub.hidden = !sub;
  els.sheetBody.innerHTML = body || "";
  els.sheetBody.scrollTop = 0;
  if (footer) {
    els.sheetFoot.innerHTML = footer;
    els.sheetFoot.hidden = false;
  } else {
    els.sheetFoot.innerHTML = "";
    els.sheetFoot.hidden = true;
  }
  state.sheet.mode = mode || "info";
  state.sheet.collect = typeof collect === "function" ? collect : null;
  els.overlay.dataset.mode = state.sheet.mode;
  els.overlay.hidden = false;
  els.sheetBack.focus();
}

function closeSheet(result) {
  els.overlay.hidden = true;
  delete els.overlay.dataset.mode;
  state.sheet.mode = null;
  const resolve = state.sheet.resolve;
  const collect = state.sheet.collect;
  state.sheet.resolve = null;
  state.sheet.collect = null;
  if (!resolve) return;
  if (result && collect) {
    /* A form sheet resolves with what the user filled in, not with `true`. */
    let value = null;
    try {
      value = collect();
    } catch {
      value = null;
    }
    resolve(value);
    return;
  }
  resolve(Boolean(result));
}

function confirmAction(title, bodyHtml, confirmLabel) {
  return new Promise((resolve) => {
    state.sheet.resolve = resolve;
    openSheet({
      title,
      sub: "",
      body: `<div class="confirm-body">${bodyHtml}</div>`,
      footer: `<button class="btn" data-answer="0">${t("confirm.cancel")}</button><button class="btn btn-danger" data-answer="1">${escapeHtml(
        confirmLabel,
      )}</button>`,
      mode: "confirm",
    });
  });
}

function patchHtml(patch) {
  const lines = String(patch).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const LIMIT = 4000;
  const shown = lines.slice(0, LIMIT);

  const body = shown
    .map((line) => {
      let kind = "ctx";
      if (
        line.startsWith("+++") ||
        line.startsWith("---") ||
        line.startsWith("diff --git") ||
        line.startsWith("index ") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode") ||
        line.startsWith("similarity ") ||
        line.startsWith("rename ") ||
        line.startsWith("\\ No newline")
      ) {
        kind = "meta";
      } else if (line.startsWith("@@")) {
        kind = "hunk";
      } else if (line.startsWith("+")) {
        kind = "add";
      } else if (line.startsWith("-")) {
        kind = "del";
      }
      return `<span class="line ${kind}">${line ? escapeHtml(line) : " "}</span>`;
    })
    .join("");

  const note =
    lines.length > LIMIT
      ? `<div class="patch-note">${t("patch.truncated", LIMIT, lines.length)}</div>`
      : "";

  return `<pre class="patch">${body}</pre>${note}`;
}

async function openDiff(filePath, staged) {
  const token = beginDiff({ path: filePath, staged });
  openDiffPane({
    title: filePath,
    sub: staged ? t("diff.staged") : t("diff.worktree"),
    body: `<div class="patch-note">${t("patch.loading")}</div>`,
  });

  try {
    const result = await invoke("git.diff", { path: filePath, staged });
    if (state.diff.token !== token) return;
    const sub = [staged ? t("diff.staged") : t("diff.worktree")];
    if (result.untracked) sub.push(t("diff.untracked"));
    if (result.conflict) sub.push(t("diff.conflict"));
    els.diffSub.textContent = sub.join(" · ");
    els.diffSub.hidden = false;
    showPatch(
      token,
      result.patch,
      `<div class="patch-note">${
        result.untracked ? t("patch.emptyUntracked") : t("patch.empty")
      }</div>`,
    );
  } catch (error) {
    if (state.diff.token !== token) return;
    els.diffBody.innerHTML = `<div class="patch-note">${escapeHtml(errorText(error))}</div>`;
  }
}

// --------------------------------------------------------------------- actions

async function withBusy(label, fn) {
  if (state.busy) return null;
  state.busy = label;
  refreshButtons();
  try {
    return await fn();
  } catch (error) {
    toast(errorText(error), "error");
    return null;
  } finally {
    state.busy = null;
    refreshButtons();
  }
}

async function loadState(options = {}) {
  const result = await withBusy("refresh", () => invoke("git.state"));
  if (result) applyState(result, options);
  // History is a separate read-only call, so the 6 s poll never pays for it.
  if (result?.repo) await loadHistory();
  return result;
}

async function pollState() {
  if (state.busy || document.hidden || !els.overlay.hidden) return;
  try {
    const result = await invoke("git.state");
    if (result && result.ok) applyState(result, { quiet: true });
  } catch {
    /* polling is best-effort */
  }
}

async function stagePaths(paths, staged) {
  const result = await withBusy(staged ? "unstage" : "stage", () =>
    invoke(staged ? "git.unstage" : "git.stage", { paths }),
  );
  if (result) applyState(result.state);
}

async function stageAll(staged) {
  const result = await withBusy(staged ? "unstage-all" : "stage-all", () =>
    invoke(staged ? "git.unstageAll" : "git.stageAll"),
  );
  if (result) applyState(result.state);
}

async function discardPaths(paths) {
  if (paths.length === 0) return;
  const what =
    paths.length === 1
      ? `<code>${escapeHtml(paths[0])}</code>`
      : t("discard.files", paths.length);
  const ok = await confirmAction(
    t("discard.title"),
    t("discard.body", what),
    t("discard.title"),
  );
  if (!ok) return;
  const result = await withBusy("discard", () => invoke("git.discard", { paths }));
  if (result) {
    applyState(result.state);
  toast(t("toast.discarded"), "success");
  }
}

async function commit(forceAll) {
  const data = state.data;
  if (!data || !data.repo) return;
  const message = els.message.value.trim();
  if (!message) {
    toast(t("toast.needMessage"), "error");
    els.message.focus();
    return;
  }
  if (!data.counts || data.counts.total === 0) {
  toast(t("err.NOTHING_TO_COMMIT"), "error");
    return;
  }

  const stageAllChanges =
    forceAll === true || (forceAll !== false && data.staged.length === 0);

  const result = await withBusy("commit", () =>
    invoke("git.commit", {
      message,
      stageAll: stageAllChanges,
      push: els.optPush.checked,
      signOff: els.optSignoff.checked,
    }),
  );
  if (!result) return;

  els.message.value = "";
  autosizeMessage();
  applyState(result.state);
  loadHistory();
  const sha = result.commit?.shortSha ? `${result.commit.shortSha} ` : "";
  toast(`${t("toast.committed", sha)}${result.commit?.subject || ""}`.trim(), "success");
  if (result.pushError) {
    /* The commit is already in: report the push problem without hiding it. */
    toast(t("push.afterCommitFailed", errorText(result.pushError)), "error");
  } else if (result.pushOutput !== null && result.pushOutput !== undefined) {
    toast(firstLine(result.pushOutput) || t("toast.pushed"), "success");
  }
}

// The composer grows with its content, but never past a readable size; the
// cap is also bounded by the panel so the lists above keep usable height.
function autosizeMessage() {
  const el = els.message;
  const styles = getComputedStyle(el);
  const lineHeight = parseFloat(styles.lineHeight) || 18;
  const padding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  const borders = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
  const minHeight = Math.round(lineHeight * 3 + padding + borders);
  const maxHeight = Math.max(
    minHeight,
    Math.round(
      Math.min(lineHeight * MESSAGE_MAX_ROWS + padding + borders, window.innerHeight * 0.42),
    ),
  );
  el.style.height = "auto";
  const content = el.scrollHeight + borders;
  el.style.height = `${Math.min(Math.max(content, minHeight), maxHeight)}px`;
  el.style.overflowY = content > maxHeight ? "auto" : "hidden";
}

/** Abort an in-flight typewriter fill and release the pending promise. */
function stopMessageStream() {
  const stream = messageStream;
  if (!stream) return;
  messageStream = null;
  cancelAnimationFrame(stream.raf);
  stream.resolve();
}

/**
 * Write the generated message character by character so the reasoning trail is
 * visible and the composer grows as lines arrive. Resolves when finished or
 * cancelled; prefers-reduced-motion fills in one go.
 */
function streamMessage(text) {
  stopMessageStream();
  const value = String(text || "");
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (!value || reduceMotion) {
    els.message.value = value;
    autosizeMessage();
    return Promise.resolve();
  }

  els.message.value = "";
  autosizeMessage();
  els.message.focus();

  return new Promise((resolve) => {
    const chars = Array.from(value);
    const duration = Math.min(1100, Math.max(320, chars.length * 12));
    const started = performance.now();
    const stream = { raf: 0, resolve };
    messageStream = stream;

    const tick = (now) => {
      if (messageStream !== stream) return;
      const progress = Math.min(1, (now - started) / duration);
      els.message.value = chars.slice(0, Math.round(chars.length * progress)).join("");
      autosizeMessage();
      if (progress < 1) {
        stream.raf = requestAnimationFrame(tick);
        return;
      }
      messageStream = null;
      els.message.setSelectionRange(chars.length, chars.length);
      resolve();
    };
    stream.raf = requestAnimationFrame(tick);
  });
}

async function generateMessage() {
  const result = await withBusy("generate", async () => {
    const generated = await invoke("git.generateMessage");
    await streamMessage(generated && generated.message);
    return generated;
  });
  if (!result) return;
  toast(
    result.basedOn === "staged" ? t("gen.basedStaged") : t("gen.basedAll"),
    "success",
  );
}

async function pull() {
  const result = await withBusy("pull", () => invoke("git.pull"));
  if (!result) return;
  applyState(result.state);
  loadHistory();
  toast(firstLine(result.output) || t("toast.upToDate"), "success");
}

/* ---------------------------------------------------------------------- push */

/* The alphabet git.js accepts; the host checks it again before running git. */
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,120}$/;

function hostLabel(info) {
  const host = info?.host || "";
  return info?.port && info.port !== 22 ? `${host}:${info.port}` : host;
}

/** The ssh preflight result, rendered inside the push sheet. */
function hostKeyHtml(info) {
  if (!info) return "";
  if (info.supported === false) {
    /* The mapped error already ends a sentence; the template adds its own. */
    const reason = errorText({ code: info.code || "SSH_FAILED", message: info.error || "" }).replace(
      /[.。\s]+$/,
      "",
    );
    return `<p class="push-note warn">${escapeHtml(t("push.sshUnsupported", reason))}</p>`;
  }
  if (info.known) {
    return `<p class="push-note ok">${escapeHtml(t("push.hostTrusted", hostLabel(info)))}</p>`;
  }
  const keys = Array.isArray(info.keys) ? info.keys : [];
  if (keys.length === 0) {
    return `<p class="push-note warn">${escapeHtml(t("push.hostKeyEmpty"))}</p>`;
  }
  const rows = keys
    .map(
      (key) =>
        `<label class="push-key"><input type="checkbox" data-fingerprint value="${escapeHtml(
          key.fingerprint,
        )}" checked><span class="push-key-type">${escapeHtml(key.type)}</span>` +
        `<span class="push-key-fp mono">${escapeHtml(key.fingerprint)}</span></label>`,
    )
    .join("");
  return [
    `<div class="push-host">`,
    `<div class="push-host-title">${escapeHtml(t("push.hostKeyTitle", hostLabel(info)))}</div>`,
    `<p class="push-note">${escapeHtml(t("push.hostKeyNote", info.knownHostsFile || ""))}</p>`,
    `<div class="push-keys">${rows}</div>`,
    `</div>`,
  ].join("");
}

/**
 * Ask for the remote, the remote branch and — when the host key is unknown —
 * which fingerprints to trust. Resolves null when the user backs out.
 */
function confirmPushPlan(plan) {
  const upstreamRemote = String(plan.upstream || "").split("/")[0] || "";
  const options = (Array.isArray(plan.remotes) ? plan.remotes : [])
    .map(
      (item) =>
        `<option value="${escapeHtml(item.name)}"${item.name === plan.remote ? " selected" : ""}>` +
        `${escapeHtml(item.name)} — ${escapeHtml(item.url || t("push.noUrl"))}</option>`,
    )
    .join("");
  const target = `${plan.remote}/${plan.remoteBranch}`;
  const body = [
    `<div class="confirm-body push-confirm">`,
    `<div class="push-grid">`,
    `<label class="push-field"><span class="push-label">${t("push.remote")}</span>`,
    `<select class="field" id="pushRemote">${options}</select></label>`,
    `<label class="push-field"><span class="push-label">${t("push.remoteBranch")}</span>`,
    `<input class="field mono" id="pushBranch" value="${escapeHtml(plan.remoteBranch)}" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="${t(
      "push.remoteBranch",
    )}"></label>`,
    `</div>`,
    `<p class="push-target"><code class="mono">${escapeHtml(plan.branch)}</code>` +
      `<span class="push-arrow">→</span><code class="mono" id="pushPreview">${escapeHtml(target)}</code></p>`,
    `<p class="push-note">${plan.needsUpstream ? t("push.setUpstreamNew") : t("push.keepUpstream")}</p>`,
    hostKeyHtml(plan.ssh),
    `<p class="push-note warn" id="pushHint" hidden></p>`,
    `</div>`,
  ].join("");

  const footer = [
    `<button class="btn" data-answer="0">${t("confirm.cancel")}</button>`,
    `<button class="btn btn-primary" id="pushConfirm" data-answer="1">${t("push.confirm")}</button>`,
  ].join("");

  return new Promise((resolve) => {
    state.sheet.resolve = resolve;
    openSheet({
      title: t("push.title"),
      sub: plan.remoteUrl || "",
      body,
      footer,
      mode: "push",
      collect: () => {
        const remote = els.sheetBody.querySelector("#pushRemote")?.value || plan.remote;
        const typed = String(els.sheetBody.querySelector("#pushBranch")?.value || "").trim();
        const trust = Array.from(
          els.sheetBody.querySelectorAll("input[data-fingerprint]:checked"),
        ).map((node) => node.value);
        return {
          remote,
          branch: typed || plan.branch,
          /* Keep tracking when the upstream moves, is gone, or was never set. */
          setUpstream:
            plan.needsUpstream || (Boolean(upstreamRemote) && remote !== upstreamRemote),
          trust,
        };
      },
    });
    wirePushSheet(plan);
  });
}

/** Live feedback: an impossible remote branch or an unticked host key blocks OK. */
function wirePushSheet(plan) {
  const remote = els.sheetBody.querySelector("#pushRemote");
  const branch = els.sheetBody.querySelector("#pushBranch");
  const hint = els.sheetBody.querySelector("#pushHint");
  const preview = els.sheetBody.querySelector("#pushPreview");
  const confirm = els.sheetFoot.querySelector("#pushConfirm");
  if (!branch || !confirm) return;
  /* An untrusted host must be ticked, otherwise the push fails on verification. */
  const mustTrust = plan.ssh?.supported !== false && plan.ssh?.known === false;

  const validate = () => {
    const value = branch.value.trim();
    let message = "";
    if (!BRANCH_RE.test(value)) {
      message = t("push.branchInvalid");
    } else if (mustTrust && !els.sheetBody.querySelector("input[data-fingerprint]:checked")) {
      message = t("push.needKey");
    }
    confirm.disabled = Boolean(message);
    if (hint) {
      hint.textContent = message;
      hint.hidden = !message;
    }
    if (preview) preview.textContent = `${remote?.value || plan.remote}/${value || plan.branch}`;
  };

  branch.addEventListener("input", validate);
  if (remote) remote.addEventListener("change", validate);
  els.sheetBody.addEventListener("change", (event) => {
    if (event.target?.matches?.("input[data-fingerprint]")) validate();
  });
  validate();
}

async function push() {
  const preflight = await withBusy("push", () => invoke("git.pushPreflight"));
  if (!preflight?.plan) return;
  const plan = preflight.plan;
  /*
   * Ask only when the answer changes the command: a branch that already tracks
   * its remote on a trusted host pushes without a dialog.
   */
  const needsConfirm =
    plan.needsUpstream || plan.ssh?.supported === false || plan.ssh?.known === false;
  let choice = { remote: plan.remote, branch: plan.remoteBranch, setUpstream: false, trust: [] };
  if (needsConfirm) {
    const answer = await confirmPushPlan(plan);
    if (!answer) return;
    choice = answer;
  }

  const result = await withBusy("push", async () => {
    if (choice.trust.length > 0) {
      await invoke("git.trustSshHost", { remote: choice.remote, fingerprints: choice.trust });
    }
    return invoke("git.push", {
      remote: choice.remote,
      branch: choice.branch,
      setUpstream: choice.setUpstream,
    });
  });
  if (!result) return;
  applyState(result.state);
  loadHistory();
  toast(firstLine(result.output) || t("toast.pushedShort"), "success");
}

// ---------------------------------------------------------------------- events

function closeMenu() {
  if (els.commitMenu.hidden) return;
  els.commitMenu.hidden = true;
  els.commitMenuBtn.setAttribute("aria-expanded", "false");
}

function toggleMenu() {
  const next = els.commitMenu.hidden;
  els.commitMenu.hidden = !next;
  els.commitMenuBtn.setAttribute("aria-expanded", String(next));
}

function bindEvents() {
  els.refreshBtn.addEventListener("click", () => loadState());
  els.pullBtn.addEventListener("click", pull);
  els.pushBtn.addEventListener("click", push);
  els.commitBtn.addEventListener("click", () => commit(undefined));
  els.genBtn.addEventListener("click", generateMessage);

  // User edits win over a running typewriter fill.
  els.message.addEventListener("input", () => {
    stopMessageStream();
    autosizeMessage();
  });

  // Same for the history header: the whole strip collapses, minus its actions.
  els.historyHead.addEventListener("click", (event) => {
    if (event.target.closest(".group-actions")) return;
    state.history.collapsed = !state.history.collapsed;
    renderHistory();
  });
  els.historyMore.addEventListener("click", loadMoreHistory);
  els.historyBody.addEventListener("scroll", scheduleHistoryCheck, { passive: true });

  els.commits.addEventListener("click", (event) => {
    const file = event.target.closest(".commit-file");
    if (file) {
      event.stopPropagation();
      openCommitDiff(file.dataset.sha, file.dataset.path);
      return;
    }
    const row = event.target.closest(".commit-line");
    if (!row) return;
    const item = row.closest(".commit");
    if (item) toggleCommit(item.dataset.sha);
  });

  els.commits.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest(".commit-line, .commit-file");
    if (!target) return;
    event.preventDefault();
    target.click();
  });

  els.commitMenuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu();
  });

  els.commitMenu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-menu]");
    if (!item) return;
    closeMenu();
    if (item.dataset.menu === "commit-staged") commit(false);
    if (item.dataset.menu === "commit-all") commit(true);
  });

  document.addEventListener("click", (event) => {
    if (!els.commitMenu.hidden && !event.target.closest(".composer")) closeMenu();
  });

  els.lists.addEventListener("click", (event) => {
    const row = event.target.closest(".file");
    const action = event.target.closest("[data-act]");
    // The whole group header toggles collapse, but its own actions must not.
    const toggle = event.target.closest(".group-actions")
      ? null
      : event.target.closest(".group-head")?.querySelector("[data-toggle]") ||
        event.target.closest("[data-toggle]");

    if (action) {
      event.stopPropagation();
      const act = action.dataset.act;
      if (act === "stage-all") return void stageAll(false);
      if (act === "unstage-all") return void stageAll(true);
      if (act === "discard-all") {
        const changes = state.data?.changes || [];
        return void discardPaths(changes.filter((entry) => !entry.conflict).map((entry) => entry.path));
      }
      const filePath = action.dataset.path;
      if (!filePath) return;
      if (act === "stage") return void stagePaths([filePath], false);
      if (act === "unstage") return void stagePaths([filePath], true);
      if (act === "discard") return void discardPaths([filePath]);
      return;
    }

    if (toggle) {
      const key = toggle.dataset.toggle;
      state.collapsed[key] = !state.collapsed[key];
      renderLists();
      return;
    }

    if (row) {
      const filePath = row.dataset.path;
      const staged = row.dataset.staged === "1";
      if (filePath) openDiff(filePath, staged);
    }
  });

  els.lists.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".file");
    if (!row) return;
    event.preventDefault();
    openDiff(row.dataset.path, row.dataset.staged === "1");
  });

  els.sheetBack.addEventListener("click", () => closeSheet(false));
  els.sheetClose.addEventListener("click", () => closeSheet(false));

  els.diffClose.addEventListener("click", () => closeDiffPane());
  els.splitter.addEventListener("pointerdown", onSplitterDown);
  els.splitter.addEventListener("dblclick", () => setDiffWidth(splitBounds().total / 2));
  els.splitter.addEventListener("keydown", onSplitterKey);

  els.sheetFoot.addEventListener("click", (event) => {
    const button = event.target.closest("[data-answer]");
    if (!button) return;
    closeSheet(button.dataset.answer === "1");
  });

  els.overlay.addEventListener("click", (event) => {
    if (event.target !== els.overlay) return;
    if (state.sheet.mode === "confirm" || state.sheet.mode === "push") closeSheet(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!els.overlay.hidden) {
        closeSheet(false);
        return;
      }
      // The diff is a pane, not a dialog: Esc closes it before anything else.
      if (state.diff.open) {
        closeDiffPane();
        return;
      }
      closeMenu();
      return;
    }
    const withMod = IS_MAC ? event.metaKey : event.ctrlKey;
    if (withMod && event.key === "Enter") {
      event.preventDefault();
      commit(event.shiftKey ? true : undefined);
    }
  });

  // ⌘/Ctrl + Enter from the composer reaches the document handler above; a
  // second handler here would fire the commit twice for one keystroke.
}

async function init() {
  autosizeMessage();
  bindEvents();
  applyAppearance(null);
  renderHistory();

  if (typeof ResizeObserver === "function") {
    // The host can resize the work panel at any time: keep the stored width legal.
    const observer = new ResizeObserver(() => {
      if (state.diff.open) setDiffWidth(state.diff.width || splitBounds().total / 2);
    });
    observer.observe(els.split);
  }

  if (window.pluginBridge?.on) {
    window.pluginBridge.on("appearance:changed", applyAppearance);
    window.pluginBridge.on("workspace:changed", () => {
      loadState();
    });
    window.pluginBridge.on("view:open", () => {
      loadState();
    });
  }

  try {
    const appearance = await invoke("app.getAppearance");
    applyAppearance(appearance || null);
  } catch {
    /* older hosts keep the system palette */
  }

  try {
    await loadState();
  } catch (error) {
    showBanner(errorText(error));
  }

  document.documentElement.dataset.bootReady = "true";
  state.pollTimer = setInterval(pollState, 6000);
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    showBanner(errorText(error));
    refreshButtons();
  });
});
})();
