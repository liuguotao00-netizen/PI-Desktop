"use strict";

/**
 * Git Workbench — SSH host keys for git remotes.
 *
 * A repository that just got its first `git remote add origin git@host:...`
 * cannot push: the host key is not in known_hosts yet and ssh needs an
 * interactive "yes". A plugin process has no terminal, so the panel asks
 * instead: it reads the candidate keys with `ssh-keyscan`, shows their
 * SHA-256 fingerprints for the user to compare against the provider's
 * published values, and only after an explicit confirmation appends the
 * accepted keys to the user's known_hosts.
 *
 * Safety rails
 * - Every call is spawn(binary, [...]) with an argument array, never a shell,
 *   so a remote URL cannot become a command.
 * - Hosts and paths are validated before they reach ssh/ssh-keygen.
 * - Nothing is written before the caller passes back the fingerprints the
 *   user saw; the scan is repeated and only matching keys are appended, so a
 *   key swap between preview and confirmation is refused.
 * - Private keys, credentials and passphrases are never read or requested.
 *
 * The fingerprint maths is pure: SHA-256 over the base64 key blob, which is
 * exactly what `ssh-keygen -l` prints as SHA256:...
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROBE_TIMEOUT_MS = 8_000;
const SCAN_TIMEOUT_MS = 15_000;
const MAX_HOST_KEYS = 8;
const MAX_KNOWN_HOSTS_BYTES = 4 * 1024 * 1024;
/* ssh-keyscan -T: seconds before it gives up on one host. */
const SCAN_CONNECT_TIMEOUT = "5";
const KEY_TYPES = "rsa,ecdsa,ed25519";

/* The plugin process may run with a trimmed PATH; these are the usual homes. */
const ABSOLUTE_BINARIES = {
  ssh: ["/usr/bin/ssh", "/bin/ssh"],
  "ssh-keygen": ["/usr/bin/ssh-keygen", "/bin/ssh-keygen"],
  "ssh-keyscan": ["/usr/bin/ssh-keyscan", "/bin/ssh-keyscan"],
};

function sshError(message, code) {
  const error = new Error(message);
  error.name = "SshError";
  error.code = code || "SSH_FAILED";
  return error;
}

function runOnce(binary, args, options = {}) {
  const timeoutMs = options.timeoutMs || PROBE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" },
        windowsHide: true,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(String(options.input));
    }
  });
}

/** Run one of the OpenSSH tools, falling back to its absolute path. */
async function runTool(name, args, options) {
  try {
    return await runOnce(name, args, options);
  } catch (error) {
    const absolute = ABSOLUTE_BINARIES[name];
    if (error && error.code === "ENOENT" && absolute) {
      for (const candidate of absolute) {
        if (!fs.existsSync(candidate)) continue;
        return runOnce(candidate, args, options);
      }
      throw sshError(`找不到 ${name}，无法确认 SSH 主机指纹。`, "SSH_UNAVAILABLE");
    }
    throw sshError(`无法运行 ${name}：${error?.message || error}`, "SSH_UNAVAILABLE");
  }
}

// ---------------------------------------------------------------------------
// remote URLs
// ---------------------------------------------------------------------------

/**
 * Classify a git remote URL.
 * Returns { protocol: "ssh", user, host, port, path } for ssh remotes and
 * { protocol: "other" } for https/git/file/local paths, which need no host key.
 */
function parseRemoteUrl(value) {
  const text = String(value || "").trim();
  if (!text) return { protocol: "other" };

  if (/^ssh:\/\//i.test(text) || /^git\+ssh:\/\//i.test(text)) {
    try {
      const parsed = new URL(text.replace(/^git\+/i, ""));
      const port = parsed.port ? Number(parsed.port) : 22;
      return {
        protocol: "ssh",
        user: parsed.username ? decodeURIComponent(parsed.username) : null,
        host: parsed.hostname.replace(/^\[|\]$/g, ""),
        port: Number.isFinite(port) && port > 0 ? port : 22,
        path: parsed.pathname,
      };
    } catch {
      return { protocol: "other" };
    }
  }

  /* Anything else with a scheme (https, git, file, …) is not an ssh remote. */
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return { protocol: "other" };

  /* scp-like: [user@]host:path — but not a Windows drive or UNC path. */
  const scp = /^(?:([^@/\s]+)@)?(\[[^\]\s]+\]|[^:/\s]+):(.+)$/.exec(text);
  if (scp) {
    const host = scp[2].replace(/^\[|\]$/g, "");
    const remotePath = scp[3];
    if (/^[A-Za-z]$/.test(host)) return { protocol: "other" };
    if (remotePath.startsWith("\\")) return { protocol: "other" };
    return { protocol: "ssh", user: scp[1] || null, host, port: 22, path: remotePath };
  }

  return { protocol: "other" };
}

function isSafeHost(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 255) return false;
  if (host.startsWith("-")) return false;
  return /^[A-Za-z0-9._:-]+$/.test(host);
}

// ---------------------------------------------------------------------------
// ssh_config resolution and known_hosts
// ---------------------------------------------------------------------------

function expandPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text.replace(/%d/g, os.homedir());
}

function defaultKnownHostsFile() {
  return path.join(os.homedir(), ".ssh", "known_hosts");
}

/**
 * Ask ssh itself for the effective settings, so an ssh_config alias
 * (`Host gh` → github.com, port 443) is honoured instead of guessed.
 */
async function resolveHost(host, port) {
  const fallback = {
    hostname: host,
    port: Number(port) || 22,
    user: null,
    knownHostsFiles: [defaultKnownHostsFile()],
    resolved: false,
  };
  if (!isSafeHost(host)) throw sshError(`远端主机名不合法：${host}`, "INVALID_ARGUMENT");

  const { stdout, code } = await runTool("ssh", ["-G", "-p", String(Number(port) || 22), host], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (code !== 0) return fallback;

  const values = new Map();
  for (const line of stdout.split("\n")) {
    const index = line.indexOf(" ");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!key || !value) continue;
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(value);
  }

  const hostname = values.get("hostname")?.[0];
  const resolvedPort = Number(values.get("port")?.[0]);
  const files = (values.get("userknownhostsfile") || [])
    .join(" ")
    .split(/\s+/)
    .map((item) => expandPath(item))
    .filter(Boolean);

  return {
    hostname: hostname && isSafeHost(hostname) ? hostname : host,
    port: Number.isFinite(resolvedPort) && resolvedPort > 0 ? resolvedPort : fallback.port,
    user: values.get("user")?.[0] || null,
    knownHostsFiles: files.length > 0 ? files : fallback.knownHostsFiles,
    resolved: true,
  };
}

function knownHostQuery(hostname, port) {
  return Number(port) === 22 ? hostname : `[${hostname}]:${port}`;
}

/** Files to consult: an explicit override, otherwise ssh's own list. */
function knownHostsList(options, resolved) {
  const explicit = options && options.knownHostsFile ? expandPath(String(options.knownHostsFile)) : "";
  if (explicit && isUsableKnownHostsFile(explicit)) return [explicit];
  return resolved.knownHostsFiles;
}

/** Whether any known_hosts ssh would consult already pins this host. */
async function lookupKnownHost(hostname, port, files) {
  const query = knownHostQuery(hostname, port);
  const list =
    Array.isArray(files) && files.length > 0 ? files : (await resolveHost(hostname, port)).knownHostsFiles;
  for (const file of list) {
    if (!isUsableKnownHostsFile(file)) continue;
    if (!fs.existsSync(file)) continue;
    try {
      const { code } = await runTool("ssh-keygen", ["-F", query, "-f", file], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (code === 0) return { known: true, file };
    } catch {
      /* an unreadable file simply does not pin the host */
    }
  }
  return { known: false, file: null };
}

function isUsableKnownHostsFile(file) {
  if (!file) return false;
  if (!path.isAbsolute(file)) return false;
  if (file.startsWith("/dev/") || file.startsWith("/proc/")) return false;
  return true;
}

/** First known_hosts file we may append to; null when every candidate is off limits. */
function pickKnownHostsFile(files) {
  for (const candidate of files || []) {
    if (!isUsableKnownHostsFile(candidate)) continue;
    try {
      const dir = path.dirname(candidate);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fs.existsSync(candidate)) {
        fs.accessSync(candidate, fs.constants.W_OK);
      }
      return candidate;
    } catch {
      continue;
    }
  }
  const fallback = defaultKnownHostsFile();
  try {
    if (!fs.existsSync(path.dirname(fallback))) {
      fs.mkdirSync(path.dirname(fallback), { recursive: true, mode: 0o700 });
    }
    return fallback;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// keys and fingerprints
// ---------------------------------------------------------------------------

/** ssh-keygen -l style SHA-256 fingerprint of a base64 SSH public key blob. */
function fingerprintOf(blob) {
  try {
    const raw = Buffer.from(String(blob || ""), "base64");
    if (raw.length === 0) return null;
    const digest = crypto.createHash("sha256").update(raw).digest("base64");
    return `SHA256:${digest.replace(/=+$/, "")}`;
  } catch {
    return null;
  }
}

/** One ssh-keyscan run, parsed into distinct keys. */
async function scanOnce(hostname, port) {
  const args = ["-T", SCAN_CONNECT_TIMEOUT, "-p", String(port), "-t", KEY_TYPES, hostname];
  const { stdout, stderr, code } = await runTool("ssh-keyscan", args, {
    timeoutMs: SCAN_TIMEOUT_MS,
  });

  const keys = [];
  const seen = new Set();
  for (const line of stdout.split("\n")) {
    const row = line.trim();
    if (!row || row.startsWith("#")) continue;
    const parts = row.split(/\s+/);
    if (parts.length < 3) continue;
    const [hostField, type, blob] = parts;
    const fingerprint = fingerprintOf(blob);
    if (!fingerprint || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    keys.push({ host: hostField, type, key: blob, fingerprint });
    if (keys.length >= MAX_HOST_KEYS) break;
  }

  if (keys.length === 0) {
    const detail = String(stderr || "").trim().split("\n")[0] || `退出码 ${code}`;
    throw sshError(`无法读取 ${hostname}:${port} 的主机密钥：${detail}`, "SSH_SCAN_FAILED");
  }
  return keys;
}

/**
 * The keys a host offers, deduplicated by fingerprint.
 * A keyscan that hits a transient connection problem is retried once, so a
 * momentary network hiccup does not look like an untrusted host.
 */
async function scanHostKeys(hostname, port) {
  if (!isSafeHost(hostname)) throw sshError(`远端主机名不合法：${hostname}`, "INVALID_ARGUMENT");
  try {
    return await scanOnce(hostname, port);
  } catch (error) {
    if (error?.code === "INVALID_ARGUMENT") throw error;
    return scanOnce(hostname, port);
  }
}

function normalizeFingerprint(value) {
  return String(value || "")
    .trim()
    .replace(/^SHA256:/i, "")
    .replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * What the panel needs before pushing: is this an ssh remote whose host key is
 * still unknown, and which keys would the user be trusting?
 * Returns null for remotes that need no host key (https, file, local path).
 * `options.knownHostsFile` points the check at an explicit store instead of
 * the one ssh reports (used by tests and by callers that manage their own).
 */
async function preflight(url, options = {}) {
  const remote = parseRemoteUrl(url);
  if (!remote || remote.protocol !== "ssh") return null;
  if (!isSafeHost(remote.host)) {
    return { supported: false, code: "INVALID_ARGUMENT", error: `无法解析远端主机：${remote.host}` };
  }

  try {
    const resolved = await resolveHost(remote.host, remote.port);
    const files = knownHostsList(options, resolved);
    const lookup = await lookupKnownHost(resolved.hostname, resolved.port, files);
    const knownHostsFile = lookup.known ? lookup.file : pickKnownHostsFile(files);
    if (lookup.known) {
      return {
        supported: true,
        known: true,
        host: resolved.hostname,
        port: resolved.port,
        user: resolved.user,
        knownHostsFile,
        keys: [],
      };
    }

    const keys = await scanHostKeys(resolved.hostname, resolved.port);
    return {
      supported: true,
      known: false,
      host: resolved.hostname,
      port: resolved.port,
      user: resolved.user,
      knownHostsFile,
      keys,
    };
  } catch (error) {
    return {
      supported: false,
      known: false,
      code: error?.code || "SSH_FAILED",
      error: error?.message || String(error),
      host: remote.host,
      port: remote.port,
    };
  }
}

/**
 * Append the keys the user confirmed to known_hosts.
 * The scan is repeated and only keys whose fingerprint the caller passed back
 * are written, so what lands on disk is exactly what was reviewed.
 */
async function trustHostKey(url, fingerprints, options = {}) {
  const remote = parseRemoteUrl(url);
  if (!remote || remote.protocol !== "ssh") {
    throw sshError("该远端不是 SSH 地址，不需要确认主机指纹。", "NOT_APPLICABLE");
  }
  const wanted = new Set(
    (Array.isArray(fingerprints) ? fingerprints : []).map(normalizeFingerprint).filter(Boolean),
  );
  if (wanted.size === 0) throw sshError("没有已确认的主机指纹。", "INVALID_ARGUMENT");

  const resolved = await resolveHost(remote.host, remote.port);
  const keys = await scanHostKeys(resolved.hostname, resolved.port);
  const accepted = keys.filter((item) => wanted.has(normalizeFingerprint(item.fingerprint)));
  if (accepted.length === 0) {
    throw sshError(
      `${resolved.hostname} 当前的主机密钥与确认时不一致，已拒绝写入。请核对指纹或检查网络。`,
      "HOST_KEY_CHANGED",
    );
  }

  const file = pickKnownHostsFile(knownHostsList(options, resolved));
  if (!file) throw sshError("没有可写入的 known_hosts 文件。", "NO_KNOWN_HOSTS");

  const hostField = knownHostQuery(resolved.hostname, resolved.port);
  let existing = "";
  try {
    const stat = fs.statSync(file);
    if (stat.size <= MAX_KNOWN_HOSTS_BYTES) existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = "";
  }

  const lines = [];
  for (const item of accepted) {
    if (existing.includes(item.key)) continue;
    lines.push(`${hostField} ${item.type} ${item.key}`);
  }
  if (lines.length > 0) {
    fs.appendFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* a shared path may refuse chmod; the append already worked */
    }
  }

  return {
    file,
    host: resolved.hostname,
    port: resolved.port,
    added: lines.length,
    fingerprints: accepted.map((item) => item.fingerprint),
  };
}

module.exports = {
  parseRemoteUrl,
  resolveHost,
  lookupKnownHost,
  pickKnownHostsFile,
  fingerprintOf,
  scanHostKeys,
  preflight,
  trustHostKey,
  defaultKnownHostsFile,
};
