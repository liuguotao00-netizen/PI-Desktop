"use strict";

/**
 * Git Workbench — git runner and parsers.
 *
 * Safety rails
 * - Every git call is spawn("git", ["-c", "core.quotePath=false", "-C",
 *   repoRoot, ...args]): an argument array, never a shell string, so a crafted
 *   path or ref cannot become a command. quotePath=false keeps non-ASCII
 *   (e.g. Chinese) paths readable instead of C-style octal escapes.
 * - Paths and branch names are validated before they reach git.
 * - GIT_TERMINAL_PROMPT=0 and GIT_EDITOR=true keep git from blocking a
 *   detached plugin process on credentials or an editor. A consequence is
 *   that git cannot answer ssh's "yes" for an unknown host key, so
 *   ssh.js confirms it with the user before the push instead.
 *
 * The parsers are pure functions over git output.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const ssh = require("./ssh");

const DEFAULT_TIMEOUT_MS = 20_000;
const NETWORK_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_STDERR = 256 * 1024;
/* A commit body is only shown in the expanded property table. */
const MAX_BODY_CHARS = 2000;

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    LANGUAGE: "C",
  };
}

function gitError(message, extra = {}) {
  const error = new Error(message);
  error.name = "GitError";
  error.code = extra.code || "GIT_FAILED";
  error.exitCode = extra.exitCode === undefined ? null : extra.exitCode;
  error.stderr = extra.stderr || "";
  return error;
}

/**
 * Failure kinds the panel explains, in match order.
 * "Could not read from remote repository" is emitted for a host-key failure,
 * a missing repository and a network error alike, so the specific causes come
 * first and a bare transport complaint stays GIT_FAILED.
 */
const FAILURE_PATTERNS = [
  {
    code: "HOST_KEY_CHANGED",
    test: /remote host identification has changed|host key for .* has changed|offending .* key in/i,
  },
  {
    code: "HOST_KEY_UNKNOWN",
    test: /host key verification failed|no [a-z0-9-]+ host key is known for|the authenticity of host/i,
  },
  {
    code: "AUTH_FAILED",
    test: /permission denied \(publickey|authentication failed|could not read username|could not read password|invalid username or password|terminal prompts disabled/i,
  },
  {
    code: "NO_UPSTREAM",
    test: /has no upstream branch|there is no tracking information for the current branch|upstream branch of your current branch does not match/i,
  },
  {
    code: "NON_FAST_FORWARD",
    test: /non-fast-forward|fetch first|remote contains work that you do not have/i,
  },
  {
    code: "REPO_NOT_FOUND",
    test: /repository not found|does not appear to be a git repository|remote: .*not found/i,
  },
  {
    code: "NETWORK",
    test: /could not resolve host|connection timed out|connection refused|network is unreachable|operation timed out|connection reset|early eof/i,
  },
];

/** Map a git failure onto the code the panel turns into an actionable message. */
function classifyFailure(stderr) {
  const detail = String(stderr || "");
  for (const failure of FAILURE_PATTERNS) {
    if (failure.test.test(detail)) return failure.code;
  }
  return "GIT_FAILED";
}

function firstLine(text) {
  return String(text || "").trim().split("\n").find((line) => line.trim().length > 0) || "";
}

function summarizeFailure(args, code, stderr) {
  const detail = String(stderr || "").trim();
  const command = `git ${args[0] || ""}`.trim();
  if (!detail) {
    return `${command} 执行失败（退出码 ${code}）`;
  }
  // Git writes the useful sentence first; hints and advice follow it.
  const lines = detail.split("\n").filter((line) => line.trim() && !/^hint:/i.test(line.trim()));
  const head = lines.slice(0, 4).join("\n").trim() || firstLine(detail);
  return `${command} 执行失败：${head}`;
}

/**
 * Run git against an explicit repository root.
 * Resolves { stdout, stderr, code } for exit codes listed in allowExitCodes.
 */
function runGit(repoRoot, args, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const allowExitCodes = options.allowExitCodes || [0];

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let stdout = "";
    let stderr = "";
    let timer = null;

    // quotePath=false: keep 中文/emoji paths as UTF-8 instead of \351\235… escapes.
    const child = spawn("git", ["-c", "core.quotePath=false", "-C", repoRoot, ...args], {
      env: gitEnv(),
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      settle(value);
    };

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      if (overflowed) return;
      stdout += chunk;
      if (stdout.length > MAX_BUFFER) {
        overflowed = true;
        child.kill("SIGKILL");
      }
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR) stderr += chunk;
    });

    child.on("error", (error) => {
      finish(reject, gitError(`无法启动 git：${error.message}`, { code: "GIT_MISSING" }));
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish(
          reject,
          gitError(
            `git ${args[0] || ""} 超时（${Math.round(timeoutMs / 1000)} 秒），已中止`,
            { code: "TIMEOUT", exitCode: code, stderr },
          ),
        );
        return;
      }
      if (overflowed) {
        finish(
          reject,
          gitError("git 输出超过 32 MiB，已中止", { code: "OUTPUT_TOO_LARGE", exitCode: code, stderr }),
        );
        return;
      }
      if (!allowExitCodes.includes(code)) {
        finish(
          reject,
          gitError(summarizeFailure(args, code, stderr), {
            code: classifyFailure(stderr),
            exitCode: code,
            stderr,
          }),
        );
        return;
      }
      finish(resolve, { stdout, stderr, code });
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(String(options.input));
    }
  });
}

/** Resolve the repository root for a directory, or null when it is not a repo. */
async function resolveRepoRoot(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  try {
    const { stdout } = await runGit(candidate, ["rev-parse", "--show-toplevel"], {
      timeoutMs: 8000,
    });
    return String(stdout).trim() || null;
  } catch (error) {
    if (/not a git repository/i.test(error.message || "")) return null;
    throw error;
  }
}

/** A repository-relative path this plugin is willing to hand to git. */
function isSafeRelativePath(rel) {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (rel.includes("\u0000")) return false;
  if (path.isAbsolute(rel)) return false;
  if (/^[A-Za-z]:[\\/]/.test(rel)) return false;
  const normalized = path.normalize(rel);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return false;
  return true;
}

/** A branch name safe for `git push -u origin <name>`. */
function isSafeBranchName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
  if (name === "HEAD" || name.startsWith("-")) return false;
  if (name.includes("..") || name.includes("@{")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name);
}
/**
 * A commit-ish this plugin is willing to hand to git as one argument.
 * Callers only ever get here with a sha the plugin itself printed.
 */
function isSafeSha(value) {
  return typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value);
}

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------

const C_ESCAPES = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "\\": "\\",
};

/**
 * git wraps paths it considers "unusual" in double quotes — including
 * non-ASCII names even with core.quotePath=false (`"新增 笔记.md"`). Strip the
 * wrapper and decode the remaining C escapes so the panel shows the real name.
 */
function unquotePath(value) {
  const text = String(value || "");
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;

  const body = text.slice(1, -1);
  const bytes = [];
  let out = "";
  const flush = () => {
    if (bytes.length === 0) return;
    out += Buffer.from(bytes.splice(0, bytes.length)).toString("utf8");
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      flush();
      out += ch;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += octal[0].length;
      continue;
    }
    const escaped = body[i + 1];
    if (escaped === undefined) {
      flush();
      out += "\\";
      break;
    }
    flush();
    out += C_ESCAPES[escaped] ?? escaped;
    i += 1;
  }
  flush();
  return out;
}

/** Index of the ` -> ` rename separator that is not inside a quoted path. */
function renameArrowIndex(text) {
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted && ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && ch === " " && text.startsWith(" -> ", i)) return i;
  }
  return -1;
}

function parseStatusPorcelain(output) {
  const result = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    detached: false,
    entries: [],
  };

  for (const line of String(output || "").split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const header = line.slice(3);
      const bracket = header.indexOf(" [");
      const branchPart = bracket === -1 ? header : header.slice(0, bracket);
      const tail = bracket === -1 ? "" : header.slice(bracket + 2, header.length - 1);
      if (/^HEAD \(no branch\)/.test(branchPart)) {
        result.detached = true;
        result.branch = null;
      } else {
        const [local, upstream] = branchPart.split("...");
        result.branch = local || null;
        result.upstream = upstream || null;
      }
      if (/gone/i.test(tail)) result.gone = true;
      const aheadMatch = tail.match(/ahead (\d+)/);
      const behindMatch = tail.match(/behind (\d+)/);
      if (aheadMatch) result.ahead = Number(aheadMatch[1]);
      if (behindMatch) result.behind = Number(behindMatch[1]);
      continue;
    }
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    let pathPart = line.slice(3);
    let origPath = null;
    const arrow = renameArrowIndex(pathPart);
    if (arrow !== -1) {
      origPath = unquotePath(pathPart.slice(0, arrow));
      pathPart = unquotePath(pathPart.slice(arrow + 4));
    } else {
      pathPart = unquotePath(pathPart);
    }
    result.entries.push({ x, y, path: pathPart, origPath });
  }

  return result;
}

const CONFLICT_CODES = /^(DD|AU|UD|UA|DU|AA|UU)$/;
const UNTRACKED_CODE = "??";

function statusLetter(code, fallback) {
  const first = (code || "").trim()[0];
  return first || fallback;
}

/**
 * Split porcelain entries into the two lists the panel renders: what is
 * already in the index, and what is still only in the working tree.
 */
function buildFileGroups(status) {
  const staged = [];
  const changes = [];
  let stagedTruncated = false;
  let changesTruncated = false;

  for (const entry of status.entries || []) {
    const code = `${entry.x}${entry.y}`;
    const base = { path: entry.path, origPath: entry.origPath || null };

    if (CONFLICT_CODES.test(code) || entry.x === "U" || entry.y === "U") {
      changes.push({ ...base, letter: "U", code, conflict: true, staged: false });
      continue;
    }
    if (code === UNTRACKED_CODE) {
      changes.push({ ...base, letter: "U", code, untracked: true, staged: false });
      continue;
    }
    if (entry.x !== " " && entry.x !== "?") {
      staged.push({ ...base, letter: statusLetter(entry.x, "M"), code, staged: true });
    }
    if (entry.y !== " ") {
      changes.push({ ...base, letter: statusLetter(entry.y, "M"), code, staged: false });
    }
  }

  return { staged, changes, stagedTruncated, changesTruncated };
}

/**
 * Parse a NUL/unit-separator delimited `git log` run.
 * - "subjects": `%s` per record
 * - "history" : `%H %h %s %an %aI %cn %cI %p %b` per record
 * - legacy    : `%h %s %ad`
 */
function parseLogRecords(output, format) {
  const records = [];
  for (const part of String(output || "").split("\x1e")) {
    const text = part.replace(/^\r?\n/, "");
    if (!text) continue;
    const fields = text.split("\x1f");
    if (format === "subjects") {
      records.push({ subject: fields[0] || "" });
      continue;
    }
    if (format === "history") {
      if (fields.length < 9) continue;
      records.push({
        sha: fields[0],
        shortSha: fields[1],
        subject: fields[2],
        author: fields[3],
        authorDate: fields[4],
        committer: fields[5],
        commitDate: fields[6],
        parents: fields[7]
          .split(" ")
          .map((sha) => sha.trim())
          .filter(Boolean),
        body: fields[8] || "",
      });
      continue;
    }
    if (fields.length < 3) continue;
    records.push({ shortSha: fields[0], subject: fields[1], authorDate: fields[2] });
  }
  return records;
}

/** `git show --name-status` rows → [{ letter, path, origPath }]. */
function parseNameStatus(output) {
  const files = [];
  for (const line of String(output || "").split("\n")) {
    const row = line.trim();
    if (!row) continue;
    const parts = row.split("\t");
    if (parts.length < 2) continue;
    const letter = parts[0].trim()[0];
    if (!letter) continue;
    if ((letter === "R" || letter === "C") && parts.length >= 3) {
      files.push({ letter, path: unquotePath(parts[2]), origPath: unquotePath(parts[1]) });
      continue;
    }
    files.push({ letter, path: unquotePath(parts[1]), origPath: null });
  }
  return files;
}

// ---------------------------------------------------------------------------
// repository state
// ---------------------------------------------------------------------------

async function status(root) {
  const { stdout } = await runGit(root, [
    "status",
    "--porcelain=v1",
    "-b",
    "--untracked-files=all",
  ]);
  return parseStatusPorcelain(stdout);
}

async function headCommit(root) {
  const { stdout } = await runGit(root, [
    "log",
    "-1",
    "--no-color",
    "--format=%h%x1f%s",
  ]).catch(() => ({ stdout: "" }));
  const [shortSha, subject] = String(stdout).trim().split("\x1f");
  if (!shortSha) return null;
  return { shortSha, subject: subject || "" };
}

async function hasCommits(root) {
  try {
    await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function remoteNames(root) {
  const { stdout } = await runGit(root, ["remote"]).catch(() => ({ stdout: "" }));
  return String(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Remote names with the URL `git push` would use, credentials redacted. */
async function remoteList(root) {
  const names = await remoteNames(root);
  const list = [];
  for (const name of names) {
    const { stdout } = await runGit(root, ["remote", "get-url", "--push", name]).catch(() => ({
      stdout: "",
    }));
    const url = String(stdout).trim().split("\n")[0].trim();
    list.push({ name, url: redactRemoteUrl(url) });
  }
  return list;
}

/**
 * The raw push URL of one remote. Never sent to the panel: it can carry an
 * http(s) token, and only the ssh helper needs it — to read host and port.
 */
async function remotePushUrl(root, name) {
  const remote = String(name || "").trim();
  const names = await remoteNames(root);
  if (!names.includes(remote)) {
    throw gitError(`未知远端 ${remote || "(空)"}。`, { code: "INVALID_ARGUMENT" });
  }
  const { stdout } = await runGit(root, ["remote", "get-url", "--push", remote]);
  const url = String(stdout).trim().split("\n")[0].trim();
  if (!url) throw gitError(`无法读取远端 ${remote} 的地址。`, { code: "NO_REMOTE" });
  return url;
}

/** Hide userinfo inside an http(s) remote URL before it reaches the panel. */
function redactRemoteUrl(url) {
  return String(url || "").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1***@");
}

/** "origin/main" → ["origin", "main"]; a remote name never contains "/". */
function splitUpstream(upstream) {
  const text = String(upstream || "");
  const index = text.indexOf("/");
  if (index <= 0 || index === text.length - 1) return [null, null];
  return [text.slice(0, index), text.slice(index + 1)];
}

async function recentSubjects(root, count = 8) {
  const { stdout } = await runGit(root, [
    "log",
    `-n`,
    String(count),
    "--no-color",
    "--format=%s%x1e",
  ]).catch(() => ({ stdout: "" }));
  return parseLogRecords(stdout, "subjects")
    .map((record) => record.subject.trim())
    .filter(Boolean);
}

/**
 * The most recent commits, newest first, with the properties the panel shows
 * for each one. `body` is capped so a long commit message cannot bloat the
 * payload; the subject is what the collapsed row displays.
 */
async function log(root, limit = 30) {
  const count = Math.min(Math.max(Number(limit) || 30, 1), 200);
  if (!(await hasCommits(root))) return [];
  const { stdout } = await runGit(root, [
    "log",
    "-n",
    String(count),
    "--no-color",
    "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%cn%x1f%cI%x1f%p%x1f%b%x1e",
  ]);
  return parseLogRecords(stdout, "history").map((record) => ({
    ...record,
    subject: record.subject.trim(),
    body: record.body.trim().slice(0, MAX_BODY_CHARS),
  }));
}

/** Files a single commit touched, with their status letters. */
async function commitFiles(root, sha) {
  if (!isSafeSha(sha)) throw gitError("提交 ID 不合法", { code: "INVALID_ARGUMENT" });
  const { stdout } = await runGit(root, [
    "show",
    "--name-status",
    "--find-renames",
    "--no-color",
    "--format=",
    sha,
  ]);
  return parseNameStatus(stdout);
}

/** The patch of one file inside one commit. */
async function commitDiff(root, sha, filePath) {
  if (!isSafeSha(sha)) throw gitError("提交 ID 不合法", { code: "INVALID_ARGUMENT" });
  if (!isSafeRelativePath(filePath)) throw gitError("文件路径不合法", { code: "INVALID_ARGUMENT" });
  const { stdout } = await runGit(root, [
    "show",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    "--format=",
    sha,
    "--",
    filePath,
  ]);
  return stdout;
}

// ---------------------------------------------------------------------------
// diffs
// ---------------------------------------------------------------------------

async function fileDiff(root, filePath, staged, entry) {
  const isUntracked = Boolean(entry && entry.untracked);
  if (isUntracked) {
    const { stdout } = await runGit(
      root,
      ["diff", "--no-color", "--no-index", "--", "/dev/null", filePath],
      { allowExitCodes: [0, 1] },
    );
    return { patch: stdout, untracked: true, staged: false };
  }
  const args = ["diff", "--no-color"];
  if (staged) args.push("--cached");
  args.push("--", filePath);
  const { stdout } = await runGit(root, args);
  return { patch: stdout, untracked: false, staged: Boolean(staged) };
}

async function diffForCommit(root, mode) {
  const args = ["diff", "--no-color"];
  if (mode === "staged") args.push("--cached");
  else if (mode === "head") args.push("HEAD");
  const { stdout } = await runGit(root, args);
  return stdout;
}

async function diffStat(root, mode) {
  const args = ["diff", "--no-color", "--stat"];
  if (mode === "staged") args.push("--cached");
  else if (mode === "head") args.push("HEAD");
  const { stdout } = await runGit(root, args);
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// index and working tree operations
// ---------------------------------------------------------------------------

async function stage(root, paths) {
  await runGit(root, ["add", "--", ...paths]);
}

async function unstage(root, paths) {
  const tracked = await hasCommits(root);
  if (!tracked) {
    await runGit(root, ["rm", "--cached", "-r", "-q", "--", ...paths]);
    return;
  }
  await runGit(root, ["reset", "-q", "HEAD", "--", ...paths]);
}

async function stageAll(root) {
  await runGit(root, ["add", "--all"]);
}

async function unstageAll(root) {
  if (!(await hasCommits(root))) {
    await runGit(root, ["rm", "--cached", "-r", "-q", "--", "."]);
    return;
  }
  await runGit(root, ["reset", "-q", "HEAD", "--"]);
}

/** Restore tracked paths from HEAD and delete untracked ones. Callers confirm first. */
async function discard(root, paths) {
  const current = await status(root);
  const untracked = new Set(
    current.entries.filter((entry) => `${entry.x}${entry.y}` === UNTRACKED_CODE).map((e) => e.path),
  );
  // A file added to the index but absent from HEAD cannot be restored: unstage
  // it first, then let the untracked-file path delete it.
  const addedToIndex = new Set(
    current.entries.filter((entry) => entry.x === "A").map((entry) => entry.path),
  );
  const toClean = paths.filter((filePath) => untracked.has(filePath) || addedToIndex.has(filePath));
  const toRestore = paths.filter((filePath) => !untracked.has(filePath) && !addedToIndex.has(filePath));
  const toUnstage = paths.filter((filePath) => addedToIndex.has(filePath));

  if (toRestore.length > 0) {
    await runGit(root, ["restore", "--worktree", "--source=HEAD", "--", ...toRestore]);
    await runGit(root, ["reset", "-q", "--", ...toRestore]).catch(() => {});
  }
  if (toUnstage.length > 0) {
    await runGit(root, ["rm", "--cached", "-q", "--", ...toUnstage]);
  }
  if (toClean.length > 0) {
    await runGit(root, ["clean", "-f", "-d", "--", ...toClean]);
  }
}

// ---------------------------------------------------------------------------
// commit / pull / push
// ---------------------------------------------------------------------------

function ensureMessage(message) {
  const text = String(message ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) throw gitError("提交信息不能为空", { code: "INVALID_ARGUMENT" });
  if (text.length > 10000) throw gitError("提交信息超过 10000 个字符", { code: "INVALID_ARGUMENT" });
  return `${text}\n`;
}

async function commit(root, message, options = {}) {
  const input = ensureMessage(message);
  const args = ["commit", "-F", "-"];
  if (options.signOff) args.push("--signoff");
  if (options.amend) args.push("--amend");
  const { stdout } = await runGit(root, args, { input, timeoutMs: 120_000 });
  return { output: stdout.trim(), commit: await headCommit(root) };
}

async function pull(root) {
  const branches = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({ stdout: "" }));
  const branch = String(branches.stdout).trim();
  if (!branch || branch === "HEAD") {
    throw gitError("当前处于游离 HEAD 状态，无法拉取。请先切换分支。", { code: "DETACHED_HEAD" });
  }
  const remotes = await remoteNames(root);
  if (remotes.length === 0) {
    throw gitError("该仓库没有配置远端，无法拉取。", { code: "NO_REMOTE" });
  }
  const { stdout, stderr } = await runGit(root, ["pull", "--no-rebase", "--no-edit"], {
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  return { output: [stdout, stderr].filter((text) => text.trim()).join("\n").trim(), branch };
}

/**
 * What a push is about to do, so the panel can ask before it does it:
 * - which remote and remote branch this would use,
 * - whether the branch still needs an upstream (`git push -u`),
 * - whether that remote is an ssh host whose key is not known yet.
 * Throws the same DETACHED_HEAD / NO_REMOTE / INVALID_ARGUMENT a push would.
 */
async function pushPreflight(root) {
  const current = await status(root);
  if (current.detached || !current.branch) {
    throw gitError("当前处于游离 HEAD 状态，无法推送。请先切换分支。", { code: "DETACHED_HEAD" });
  }
  if (!isSafeBranchName(current.branch)) {
    throw gitError(`分支名 ${current.branch} 无法用于推送。`, { code: "INVALID_ARGUMENT" });
  }
  const remotes = await remoteList(root);
  if (remotes.length === 0) {
    throw gitError("该仓库没有配置远端，无法推送。", { code: "NO_REMOTE" });
  }

  const [upstreamRemote, upstreamBranch] = splitUpstream(current.upstream);
  const selected =
    remotes.find((item) => item.name === upstreamRemote) ||
    remotes.find((item) => item.name === "origin") ||
    remotes[0];
  /* A deleted upstream branch has to be re-established by the next push. */
  const needsUpstream = !current.upstream || current.gone;

  let host = null;
  try {
    /* The ssh check needs the real URL; the panel only ever sees the redacted one. */
    const rawUrl = await remotePushUrl(root, selected.name);
    host = await ssh.preflight(rawUrl);
  } catch (error) {
    host = {
      supported: false,
      known: false,
      code: error?.code || "SSH_FAILED",
      error: error?.message || String(error),
    };
  }

  return {
    branch: current.branch,
    upstream: current.upstream,
    gone: current.gone,
    ahead: current.ahead,
    behind: current.behind,
    needsUpstream,
    remote: selected.name,
    remoteBranch: needsUpstream ? current.branch : upstreamBranch || current.branch,
    remoteUrl: selected.url,
    remotes,
    ssh: host,
  };
}

/**
 * Push the current branch.
 * With no options this keeps the old behaviour: `git push`, or `git push -u`
 * onto origin when the branch has no upstream yet. The panel passes what the
 * user confirmed instead: a remote, a remote branch and `setUpstream`.
 */
async function push(root, options = {}) {
  const current = await status(root);
  const branch = current.branch;
  if (current.detached || !branch) {
    throw gitError("当前处于游离 HEAD 状态，无法推送。请先切换分支。", { code: "DETACHED_HEAD" });
  }
  if (!isSafeBranchName(branch)) {
    throw gitError(`分支名 ${branch} 无法用于推送。`, { code: "INVALID_ARGUMENT" });
  }
  const remotes = await remoteNames(root);
  if (remotes.length === 0) {
    throw gitError("该仓库没有配置远端，无法推送。", { code: "NO_REMOTE" });
  }

  const remote = options.remote ? String(options.remote) : null;
  const remoteBranch = options.branch ? String(options.branch) : null;
  if (remote && !remotes.includes(remote)) {
    throw gitError(`未知远端 ${remote}，无法推送。`, { code: "INVALID_ARGUMENT" });
  }
  if (remoteBranch && !isSafeBranchName(remoteBranch)) {
    throw gitError(`分支名 ${remoteBranch} 无法用于推送。`, { code: "INVALID_ARGUMENT" });
  }

  let args;
  if (remote) {
    const target = remoteBranch || branch;
    /* A different name on the remote needs an explicit refspec. */
    const refspec = target === branch ? branch : `${branch}:${target}`;
    args = options.setUpstream === true
      ? ["push", "--set-upstream", remote, refspec]
      : ["push", remote, refspec];
  } else if (current.upstream) {
    args = ["push"];
  } else {
    args = ["push", "-u", remotes.includes("origin") ? "origin" : remotes[0], branch];
  }

  const { stdout, stderr } = await runGit(root, args, { timeoutMs: NETWORK_TIMEOUT_MS });
  return {
    output: [stdout, stderr].filter((text) => text.trim()).join("\n").trim(),
    remote: remote || splitUpstream(current.upstream)[0] || (remotes.includes("origin") ? "origin" : remotes[0]),
    branch,
    setUpstream: options.setUpstream === true || !current.upstream,
  };
}

/** Record the host keys the user just confirmed for one remote. */
async function trustHostKey(url, fingerprints) {
  return ssh.trustHostKey(url, fingerprints);
}

module.exports = {
  runGit,
  resolveRepoRoot,
  isSafeRelativePath,
  isSafeBranchName,
  isSafeSha,
  unquotePath,
  parseStatusPorcelain,
  buildFileGroups,
  parseLogRecords,
  parseNameStatus,
  status,
  headCommit,
  recentSubjects,
  log,
  commitFiles,
  commitDiff,
  fileDiff,
  diffForCommit,
  diffStat,
  stage,
  unstage,
  stageAll,
  unstageAll,
  discard,
  commit,
  pull,
  push,
  pushPreflight,
  remoteList,
  remotePushUrl,
  splitUpstream,
  redactRemoteUrl,
  trustHostKey,
  ensureMessage,
  __test: { summarizeFailure, statusLetter, gitError, classifyFailure },
};
