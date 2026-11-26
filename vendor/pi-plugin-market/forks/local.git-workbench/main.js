"use strict";

/**
 * Git Workbench — PI-Desktop plugin entry.
 *
 * Plugin id : local.git-workbench
 * View      : work-panel view "changes" (contributes.views)
 * Channels  : git.state / git.log / git.diff / git.commitFiles / git.commitDiff /
 *             git.stage / git.unstage / git.stageAll / git.unstageAll /
 *             git.discard / git.commit / git.pull / git.push / git.generateMessage /
 *             git.pushPreflight / git.trustSshHost
 *
 * Design notes
 * - All git access lives in ./git.js: spawn("git", [...]) with argument
 *   arrays against the repository root resolved from the open workspace.
 * - Commit messages are written with `git commit -F -` over stdin, so no
 *   message text ever becomes a command argument.
 * - "Generate message" uses the host's one-shot completion API
 *   (pi.models.list + pi.agent.complete) and only sees the diff of the
 *   changes being committed — never the chat transcript.
 *
 * Permissions
 * - ui.view          the work-panel view
 * - models.list      list the user's ready models for the picker
 * - agent.complete   generate the commit message
 */

const path = require("node:path");
const git = require("./git");

const MAX_PATHS = 500;
const MAX_PROMPT_DIFF_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 8_000;
const HISTORY_PAGE = 30;
const MAX_HISTORY = 200;

const TEXT = {
  en: {
    noWorkspace: "Open a project folder first.",
    notARepo: "The open folder is not a git repository.",
    nothingToCommit: "There are no changes to commit.",
    noModel: "Configure a model in Settings → Models first.",
    generateFailed: "Could not generate the commit message: {0}",
    unknownError: "unknown error",
    emptyCompletion: "The model returned nothing. Try again.",
    notInChanges: "{0} is not part of the current changes.",
    openPanel: "Open the work panel from a conversation first",
    upToDate: "Already up to date",
    pushed: "Pushed",
    pushNeedsConfirm: "Confirm the remote and the SSH host key in the Git panel first.",
    pushFailed: "Push failed: {0}",
  },
  "zh-CN": {
    noWorkspace: "请先打开一个项目文件夹。",
    notARepo: "当前文件夹不是 git 仓库。",
    nothingToCommit: "没有可提交的改动。",
    noModel: "请先在“设置 → 模型”中配置一个模型。",
    generateFailed: "生成提交信息失败：{0}",
    unknownError: "未知错误",
    emptyCompletion: "模型没有返回内容，请重试。",
    notInChanges: "{0} 不在当前改动中。",
    openPanel: "请先在对话中打开右侧工作面板",
    upToDate: "已是最新",
    pushed: "已推送",
    pushNeedsConfirm: "请先在 Git 面板中确认远端与 SSH 主机指纹。",
    pushFailed: "推送失败：{0}",
  },
};

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isZh(locale) {
  return String(locale || "").toLowerCase().startsWith("zh");
}

async function hostLocale() {
  try {
    if (typeof pi.app?.getLocale === "function") {
      return await pi.app.getLocale();
    }
  } catch {
    /* older hosts */
  }
  try {
    const active = await pi.session?.getActive?.();
    if (active && active.locale) return active.locale;
  } catch {
    /* ignore */
  }
  return "en";
}

async function strings() {
  return isZh(await hostLocale()) ? TEXT["zh-CN"] : TEXT.en;
}

function requirePaths(payload, { allowEmpty = false } = {}) {
  const list = Array.isArray(payload?.paths) ? payload.paths : [];
  if (!allowEmpty && list.length === 0) {
    throw fail("INVALID_ARGUMENT", "No files were given.");
  }
  if (list.length > MAX_PATHS) {
    throw fail("INVALID_ARGUMENT", `At most ${MAX_PATHS} files per call.`);
  }
  return list.map((entry) => {
    const filePath = String(entry ?? "");
    if (!git.isSafeRelativePath(filePath)) {
      throw fail("INVALID_ARGUMENT", `Not a repository-relative path: ${filePath}`);
    }
    return filePath;
  });
}

/** A commit id the panel obtained from git.log; never interpolated into a shell. */
function requireSha(payload) {
  const sha = String(payload?.sha ?? "");
  if (!git.isSafeSha(sha)) {
    throw fail("INVALID_ARGUMENT", `Not a commit id: ${sha}`);
  }
  return sha;
}

const SAFE_REMOTE = /^[A-Za-z0-9._-]{1,120}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{40,50}={0,2}$/;

/** A remote name the panel read from `git remote`; never interpolated into a shell. */
function requireRemoteName(payload) {
  const remote = String(payload?.remote ?? "").trim();
  if (!SAFE_REMOTE.test(remote) || remote === "." || remote === "..") {
    throw fail("INVALID_ARGUMENT", `Not a remote name: ${remote}`);
  }
  return remote;
}

/** Only the fingerprints the user was shown and approved reach the ssh helper. */
function requireFingerprints(payload) {
  const list = Array.isArray(payload?.fingerprints) ? payload.fingerprints : [];
  if (list.length === 0) {
    throw fail("INVALID_ARGUMENT", "No host key fingerprint was confirmed.");
  }
  if (list.length > 16) {
    throw fail("INVALID_ARGUMENT", "Too many host keys in one call.");
  }
  return list.map((entry) => {
    const value = String(entry ?? "").trim();
    if (!FINGERPRINT.test(value)) {
      throw fail("INVALID_ARGUMENT", `Not a SHA256 host key fingerprint: ${value}`);
    }
    return value;
  });
}

async function repoContext() {
  const workspace = await pi.workspace.get();
  if (!workspace || !workspace.path) {
    throw fail("NO_WORKSPACE", (await strings()).noWorkspace);
  }
  const root = await git.resolveRepoRoot(workspace.path);
  if (!root) {
    throw fail("NOT_A_REPO", (await strings()).notARepo);
  }
  return { workspace, root };
}

async function readState() {
  let workspace = null;
  try {
    workspace = await pi.workspace.get();
  } catch {
    workspace = null;
  }
  if (!workspace || !workspace.path) {
    return { ok: true, repo: null, reason: "NO_WORKSPACE" };
  }

  let root = null;
  try {
    root = await git.resolveRepoRoot(workspace.path);
  } catch {
    root = null;
  }
  if (!root) {
    return {
      ok: true,
      repo: null,
      reason: "NOT_A_REPO",
      workspace: { path: workspace.path, name: workspace.name || path.basename(workspace.path) },
    };
  }

  const status = await git.status(root);
  const groups = git.buildFileGroups(status);
  const staged = groups.staged;
  const changes = groups.changes;

  return {
    ok: true,
    repo: { root, name: path.basename(root) },
    workspace: { path: workspace.path, name: workspace.name || path.basename(workspace.path) },
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    gone: status.gone,
    detached: status.detached,
    lastCommit: await git.headCommit(root),
    staged,
    changes,
    counts: { staged: staged.length, changes: changes.length, total: staged.length + changes.length },
    clean: staged.length === 0 && changes.length === 0,
    hasConflicts: changes.some((entry) => entry.conflict),
  };
}

// ---------------------------------------------------------------------------
// LLM commit message
// ---------------------------------------------------------------------------

function buildPrompt(state, diffText, statText, untracked, recent, language) {
  const describe = (entry) =>
    `${entry.letter}  ${entry.path}${entry.origPath ? ` (was ${entry.origPath})` : ""}`;

  const files = [
    ...state.staged.map(describe),
    ...state.changes.map(describe),
  ];

  const sections = [
    `Branch: ${state.branch || "(detached HEAD)"}`,
    "",
    "Changed files:",
    ...files.slice(0, 200),
  ];

  if (statText) {
    sections.push("", "Diffstat:", statText);
  }
  if (untracked.length > 0) {
    sections.push("", "Untracked (new) files:", ...untracked.slice(0, 50));
  }
  if (recent.length > 0) {
    sections.push("", "Recent commit subjects (match this style, do not copy):", ...recent.map((line) => `- ${line}`));
  }

  const trimmedDiff =
    diffText.length > MAX_PROMPT_DIFF_CHARS
      ? `${diffText.slice(0, MAX_PROMPT_DIFF_CHARS)}\n… (diff truncated)`
      : diffText;

  sections.push("", "Diff:", "```diff", trimmedDiff || "(no textual diff)", "```");

  return [
    sections.join("\n"),
    "",
    `Write the ${language === "简体中文" ? "提交信息" : "commit message"} for exactly these changes.`,
  ].join("\n");
}

function cleanCompletion(text) {
  let value = String(text || "").trim();
  value = value.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```\s*$/m, "");
  value = value.replace(/^(commit message|提交信息)\s*[:：]\s*/i, "");
  value = value.replace(/^["'`](.*)["'`]$/s, "$1").trim();
  if (value.length > MAX_MESSAGE_CHARS) value = value.slice(0, MAX_MESSAGE_CHARS).trim();
  return value;
}

async function generateMessage() {
  const messages = await strings();
  const { root } = await repoContext();
  const status = await git.status(root);
  const groups = git.buildFileGroups(status);
  if (groups.staged.length === 0 && groups.changes.length === 0) {
    throw fail("NOTHING_TO_COMMIT", messages.nothingToCommit);
  }

  const useStaged = groups.staged.length > 0;
  const mode = useStaged ? "staged" : "worktree";
  const [diffText, statText, recent] = await Promise.all([
    git.diffForCommit(root, mode).catch(() => ""),
    git.diffStat(root, mode).catch(() => ""),
    git.recentSubjects(root, 8),
  ]);
  const untracked = groups.changes.filter((entry) => entry.untracked).map((entry) => entry.path);
  const language = isZh(await hostLocale()) ? "简体中文" : "English";

  const models = await pi.models.list();
  const model = models.find((item) => item.isDefault) ?? models[0];
  if (!model) throw fail("NO_MODEL", messages.noModel);

  const state = {
    branch: status.branch,
    staged: groups.staged,
    changes: groups.changes,
  };

  const system = [
    "You write Git commit messages for a developer who is about to commit.",
    `Reply in ${language}.`,
    "Only output the commit message: no code fences, no quotes, no explanation, no trailing notes.",
    "First line: imperative subject, at most 72 characters, Conventional Commits format `type(scope): summary`.",
    "If the change is not trivial, add one blank line and at most four bullet points describing what and why.",
    "Use only facts visible in the diff; never invent files, features, or issue numbers.",
  ].join("\n");

  const user = buildPrompt(state, diffText, statText, untracked, recent, language);

  let completion;
  try {
    completion = await pi.agent.complete({
      modelKey: model.key,
      system,
      messages: [{ role: "user", content: user }],
    });
  } catch (error) {
    const code = error?.errorCode || error?.code || "AGENT_FAILED";
    const text = await strings();
    throw fail(code, text.generateFailed.replace("{0}", error?.message || text.unknownError));
  }

  const message = cleanCompletion(completion?.text);
  if (!message) throw fail("EMPTY_COMPLETION", (await strings()).emptyCompletion);

  return {
    ok: true,
    message,
    modelKey: model.key,
    basedOn: useStaged ? "staged" : "all",
    files: groups.staged.length + groups.changes.length,
  };
}

// ---------------------------------------------------------------------------
// panel bridge
// ---------------------------------------------------------------------------

async function onPanelInvoke(channel, payload) {
  const input = payload && typeof payload === "object" ? payload : {};

  switch (channel) {
    case "git.state":
      return readState();

    case "git.log": {
      const { root } = await repoContext();
      const requested = Number(input.limit);
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(Math.trunc(requested), 1), MAX_HISTORY)
        : HISTORY_PAGE;
      const commits = await git.log(root, limit);
      return { ok: true, commits, limit, truncated: commits.length >= limit };
    }

    case "git.commitFiles": {
      const sha = requireSha(input);
      const { root } = await repoContext();
      return { ok: true, sha, files: await git.commitFiles(root, sha) };
    }

    case "git.commitDiff": {
      const sha = requireSha(input);
      const [filePath] = requirePaths({ paths: [input.path] });
      const { root } = await repoContext();
      return { ok: true, sha, path: filePath, patch: await git.commitDiff(root, sha, filePath) };
    }

    case "git.diff": {
      const [filePath] = requirePaths({ paths: [input.path] });
      const { root } = await repoContext();
      const status = await git.status(root);
      const groups = git.buildFileGroups(status);
      const entry =
        groups.staged.find((item) => item.path === filePath && Boolean(input.staged)) ||
        groups.changes.find((item) => item.path === filePath) ||
        groups.staged.find((item) => item.path === filePath) ||
        null;
      if (!entry) throw fail("NOT_FOUND", (await strings()).notInChanges.replace("{0}", filePath));
      const result = await git.fileDiff(root, filePath, Boolean(input.staged), entry);
      return {
        ok: true,
        path: filePath,
        staged: Boolean(input.staged),
        untracked: result.untracked,
        conflict: Boolean(entry.conflict),
        patch: result.patch,
      };
    }

    case "git.stage": {
      const { root } = await repoContext();
      await git.stage(root, requirePaths(input));
      return { ok: true, state: await readState() };
    }

    case "git.stageAll": {
      const { root } = await repoContext();
      await git.stageAll(root);
      return { ok: true, state: await readState() };
    }

    case "git.unstage": {
      const { root } = await repoContext();
      await git.unstage(root, requirePaths(input));
      return { ok: true, state: await readState() };
    }

    case "git.unstageAll": {
      const { root } = await repoContext();
      await git.unstageAll(root);
      return { ok: true, state: await readState() };
    }

    case "git.discard": {
      const { root } = await repoContext();
      await git.discard(root, requirePaths(input));
      return { ok: true, state: await readState() };
    }

    case "git.commit": {
      const { root } = await repoContext();
      if (input.stageAll === true) {
        await git.stageAll(root);
      }
      const result = await git.commit(root, input.message, {
        signOff: input.signOff === true,
        amend: input.amend === true,
      });
      let pushOutput = null;
      let pushError = null;
      if (input.push === true) {
        try {
          pushOutput = (await git.push(root)).output;
        } catch (error) {
          /* The commit itself landed; the panel decides how to finish the push. */
          pushError = {
            code: error?.code || "GIT_FAILED",
            message: error?.message || String(error),
          };
        }
      }
      return {
        ok: true,
        output: result.output,
        commit: result.commit,
        pushOutput,
        pushError,
        state: await readState(),
      };
    }

    case "git.pull": {
      const { root } = await repoContext();
      const result = await git.pull(root);
      return { ok: true, output: result.output, branch: result.branch, state: await readState() };
    }

    case "git.pushPreflight": {
      const { root } = await repoContext();
      return { ok: true, plan: await git.pushPreflight(root) };
    }

    case "git.trustSshHost": {
      const { root } = await repoContext();
      const remote = requireRemoteName(input);
      const fingerprints = requireFingerprints(input);
      const url = await git.remotePushUrl(root, remote);
      const result = await git.trustHostKey(url, fingerprints);
      return { ok: true, remote, ...result };
    }

    case "git.push": {
      const { root } = await repoContext();
      const remote = input.remote ? requireRemoteName(input) : undefined;
      const branch = input.branch ? String(input.branch) : undefined;
      if (branch && !git.isSafeBranchName(branch)) {
        throw fail("INVALID_ARGUMENT", `Not a branch name: ${branch}`);
      }
      const result = await git.push(root, {
        remote,
        branch,
        setUpstream: input.setUpstream === true,
      });
      return {
        ok: true,
        output: result.output,
        remote: result.remote,
        branch: result.branch,
        setUpstream: result.setUpstream,
        state: await readState(),
      };
    }

    case "git.generateMessage":
      return generateMessage();

    default:
      throw fail("UNSUPPORTED", `Unsupported channel: ${channel}`);
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function registerCommands() {
  const zh = isZh(await hostLocale());
  const title = (en, cn) => (zh ? cn : en);

  await pi.commands.register({
    id: "git-workbench.open",
    title: title("Git Workbench: Open", "Git Workbench：打开"),
    keywords: ["git", "commit", "push", "pull", "提交", "推送", "拉取"],
    run: async () => {
      try {
        await pi.ui.revealView({ viewId: "changes" });
      } catch (error) {
        const fallback = (await strings()).openPanel;
        await pi.ui.showToast(error?.message || fallback).catch(() => {});
      }
    },
  });

  await pi.commands.register({
    id: "git-workbench.pull",
    title: title("Git Workbench: Pull", "Git Workbench：拉取"),
    keywords: ["git", "pull", "拉取", "更新"],
    run: async () => {
      const { root } = await repoContext();
      const result = await git.pull(root);
      await pi.ui.showToast(result.output || (await strings()).upToDate).catch(() => {});
      await pi.ui.revealView({ viewId: "changes" }).catch(() => {});
    },
  });

  await pi.commands.register({
    id: "git-workbench.push",
    title: title("Git Workbench: Push", "Git Workbench：推送"),
    keywords: ["git", "push", "推送", "上传"],
    run: async () => {
      const text = await strings();
      try {
        const { root } = await repoContext();
        const plan = await git.pushPreflight(root);
        /*
         * A branch without an upstream, or a host whose key is not trusted yet,
         * is confirmed in the panel instead of failing here.
         */
        const needsConfirm =
          plan.needsUpstream || plan.ssh?.supported === false || plan.ssh?.known === false;
        if (needsConfirm) {
          await pi.ui.showToast(text.pushNeedsConfirm).catch(() => {});
          await pi.ui.revealView({ viewId: "changes" }).catch(() => {});
          return;
        }
        const result = await git.push(root, { remote: plan.remote, branch: plan.remoteBranch });
        await pi.ui.showToast(result.output || text.pushed).catch(() => {});
      } catch (error) {
        await pi.ui.showToast(error?.message || String(error)).catch(() => {});
      }
    },
  });
}

async function onLoad() {
  await registerCommands();
}

async function onUnload() {
  const ids = ["git-workbench.open", "git-workbench.pull", "git-workbench.push"];
  await Promise.all(ids.map((id) => pi.commands.unregister(id).catch(() => {})));
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  __test: { cleanCompletion, buildPrompt, readState, requirePaths },
};
