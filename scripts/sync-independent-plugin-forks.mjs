/**
 * Independent-fork mode for plugin sources.
 *
 * Each plugin gets its own Git checkout and its own bare `origin`, with the
 * upstream repository kept as a separate remote. `--apply` fetches upstream,
 * fast-forwards or merges the fork branch, pushes the fork branch to `origin`,
 * and exports the resulting tree back into the tracked snapshot directory.
 *
 * Forks live outside the main checkout (default:
 * `~/.pi-desktop-dev/plugin-forks/<id>`) so no nested `.git` is committed.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const forks = join(root, "vendor/pi-plugin-market/forks");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const apply = flag("--apply");
const only = value("--only", "").split(",").map((item) => item.trim()).filter(Boolean);
const stateHome = value("--state", join(homedir(), ".pi-desktop-dev/plugin-forks"));
const concurrency = Math.max(1, Math.min(12, Number(value("--concurrency", "8")) || 8));
const gitTimeout = Math.max(30_000, Number(value("--git-timeout", "180000")) || 180_000);
const bootstrapMonorepos = flag("--bootstrap-monorepos");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    timeout: gitTimeout,
  }).trim();
}

async function defaultBranch(checkout) {
  try {
    const output = git(checkout, ["ls-remote", "--symref", "upstream", "HEAD"]);
    const match = /^ref:\s+refs\/heads\/([^\t]+)\tHEAD$/m.exec(output);
    if (match) return match[1];
  } catch {
    // Fall back to the remote HEAD ref below.
  }
  try {
    const ref = git(checkout, ["symbolic-ref", "refs/remotes/upstream/HEAD"]);
    return ref.replace("refs/remotes/upstream/", "");
  } catch {
    return "main";
  }
}

async function bootstrapSnapshot(id, upstream, base, checkout, origin) {
  await mkdir(checkout, { recursive: true });
  for (const child of await readdir(join(forks, id))) {
    if (child === "UPSTREAM.json") continue;
    await cp(join(forks, id, child), join(checkout, child), { recursive: true, force: true });
  }
  git(checkout, ["init", "-b", "pi-fork"]);
  git(checkout, ["-c", "user.name=PI Plugin Fork", "-c", "user.email=plugin-forks@local", "add", "."]);
  git(checkout, [
    "-c", "user.name=PI Plugin Fork",
    "-c", "user.email=plugin-forks@local",
    "commit", "-m", `snapshot ${id}`,
  ]);
  git(checkout, ["remote", "add", "upstream", upstream.repository]);
  if (origin.startsWith("http")) {
    git(checkout, ["remote", "add", "origin", origin]);
  } else {
    if (!existsSync(origin)) git(base, ["init", "--bare", origin]);
    git(base, ["-C", origin, "config", "receive.shallowUpdate", "true"]);
    git(checkout, ["remote", "add", "origin", origin]);
  }
  return { checkout, origin, branch: "pi-fork", remoteRef: null, bootstrapped: true };
}

async function ensureCheckout(id, upstream) {
  const base = join(stateHome, id);
  const checkout = join(base, "repo");
  const origin = String(upstream.forkOrigin && upstream.forkOrigin.startsWith("http")
    ? upstream.forkOrigin
    : join(base, "origin.git"));
  await mkdir(base, { recursive: true });
  if (!existsSync(join(checkout, ".git"))) {
    if (bootstrapMonorepos && upstream.sourceRoot) {
      if (existsSync(checkout)) await rm(checkout, { recursive: true, force: true });
      return bootstrapSnapshot(id, upstream, base, checkout, origin);
    }
    if (existsSync(checkout)) await rm(checkout, { recursive: true, force: true });
    const explicitBranch = upstream.branch && upstream.branch !== "HEAD" ? upstream.branch : "";
    git(base, [
      "clone", "--filter=blob:none", "--depth=1", "--no-checkout",
      ...(explicitBranch ? ["--branch", explicitBranch, "--single-branch"] : []),
      upstream.repository, checkout,
    ]);
    git(checkout, ["remote", "rename", "origin", "upstream"]);
    if (origin.startsWith("http")) {
      git(checkout, ["remote", "add", "origin", origin]);
    } else {
      if (!existsSync(origin)) git(base, ["init", "--bare", origin]);
      git(base, ["-C", origin, "config", "receive.shallowUpdate", "true"]);
      git(checkout, ["remote", "add", "origin", origin]);
    }
  }
  try {
    git(checkout, ["remote", "get-url", "upstream"]);
  } catch {
    git(checkout, ["remote", "add", "upstream", upstream.repository]);
  }
  try {
    const current = git(checkout, ["remote", "get-url", "origin"]);
    if (current !== origin) git(checkout, ["remote", "set-url", "origin", origin]);
  } catch {
    if (origin.startsWith("http")) {
      git(checkout, ["remote", "add", "origin", origin]);
    } else {
      if (!existsSync(origin)) git(base, ["init", "--bare", origin]);
      git(base, ["-C", origin, "config", "receive.shallowUpdate", "true"]);
      git(checkout, ["remote", "add", "origin", origin]);
    }
  }
  if (!origin.startsWith("http")) {
    git(base, ["-C", origin, "config", "receive.shallowUpdate", "true"]);
  }
  git(checkout, ["fetch", "upstream", "--depth=1", "--prune"]);
  const branch = upstream.branch && upstream.branch !== "HEAD"
    ? upstream.branch
    : await defaultBranch(checkout);
  const sourceRoot = String(upstream.sourceRoot ?? "");
  if (sourceRoot) {
    try {
      git(checkout, ["sparse-checkout", "init", "--cone"]);
      git(checkout, ["sparse-checkout", "set", sourceRoot]);
    } catch {
      // Older Git builds may not support cone mode; a full checkout still works.
    }
  }
  const remoteRef = `upstream/${branch}`;
  try {
    git(checkout, ["rev-parse", "--verify", remoteRef]);
  } catch {
    git(checkout, [
      "fetch",
      "upstream",
      "--depth=1",
      `+refs/heads/${branch}:refs/remotes/upstream/${branch}`,
    ]);
  }
  git(checkout, ["rev-parse", "--verify", remoteRef]);
  const hasFork = (() => {
    try { git(checkout, ["rev-parse", "--verify", "refs/heads/pi-fork"]); return true; } catch { return false; }
  })();
  if (!hasFork) {
    git(checkout, ["checkout", "-B", "pi-fork", remoteRef]);
  } else {
    git(checkout, ["checkout", "pi-fork"]);
  }
  return { base, checkout, origin, branch, remoteRef };
}

async function exportSnapshot(id, checkout, upstream, branch, revision) {
  const target = join(forks, id);
  await mkdir(target, { recursive: true });
  const sourceRoot = String(upstream.sourceRoot ?? "");
  const archive = join(tmpdir(), `pi-fork-${id.replace(/[^a-z0-9._-]/gi, "_")}.tar`);
  try {
    git(checkout, ["archive", "--format=tar", `--output=${archive}`, sourceRoot ? `HEAD:${sourceRoot}` : "HEAD"]);
    for (const child of await readdir(target)) {
      if (child === "UPSTREAM.json") continue;
      await rm(join(target, child), { recursive: true, force: true });
    }
    execFileSync("tar", ["-xf", archive, "-C", target], { stdio: "ignore" });
  } finally {
    await rm(archive, { force: true });
  }
  let version = upstream.version ?? "";
  for (const name of ["manifest.json", "package.json"]) {
    const file = join(target, name);
    if (!existsSync(file)) continue;
    try { version = String(JSON.parse(await readFile(file, "utf8")).version ?? version); } catch {}
  }
  const next = {
    ...upstream,
    branch,
    commit: revision,
    version,
    fetchedAt: new Date().toISOString(),
    syncMode: "independent-fork",
  };
  await writeFile(join(target, "UPSTREAM.json"), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

const ids = (await readdir(forks, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((id) => !only.length || only.includes(id));

let changed = 0;
let failed = 0;
let cursor = 0;

async function materialize(id) {
  const file = join(forks, id, "UPSTREAM.json");
  if (!existsSync(file)) return;
  const upstream = JSON.parse(await readFile(file, "utf8"));
  try {
    const info = await ensureCheckout(id, upstream);
    const { checkout, origin, branch, remoteRef } = info;
    if (info.bootstrapped) {
      const revision = git(checkout, ["rev-parse", "HEAD"]);
      if (apply) {
        git(checkout, ["push", "origin", "pi-fork"]);
        const file = join(forks, id, "UPSTREAM.json");
        const current = JSON.parse(await readFile(file, "utf8"));
        await writeFile(
          file,
          JSON.stringify({
            ...current,
            branch,
            commit: revision,
            fetchedAt: new Date().toISOString(),
            syncMode: "independent-fork",
            bootstrap: "snapshot",
          }, null, 2) + "\n",
          "utf8",
        );
        console.log(`[applied-bootstrap] ${id} ${revision.slice(0, 9)} (origin ${origin})`);
        changed += 1;
      }
      return;
    }
    const behind = Number(git(checkout, ["rev-list", "--count", `HEAD..${remoteRef}`]));
    const ahead = Number(git(checkout, ["rev-list", "--count", `${remoteRef}..HEAD`]));
    if (!behind && !ahead && upstream.syncMode === "independent-fork") {
      console.log(`[ok] ${id} ${branch} ${git(checkout, ["rev-parse", "--short", "HEAD"])}`);
      return;
    }
    console.log(`[update] ${id} ${branch} behind=${behind} ahead=${ahead}`);
    if (!apply) { changed += 1; return; }
    if (ahead === 0) git(checkout, ["reset", "--hard", remoteRef]);
    else git(checkout, ["merge", "--no-edit", remoteRef]);
    const revision = git(checkout, ["rev-parse", "HEAD"]);
    if (upstream.sourceRoot) {
      // Pushing a partial clone of a monorepo forces Git to fetch every blob
      // in the repository just to fill the local fork. The checkout remains a
      // valid independent fork; sync exports only the plugin subtree.
      console.log(`[push-skip] ${id}: monorepo sourceRoot`);
    } else {
      git(checkout, ["push", "origin", "pi-fork"]);
    }
    await exportSnapshot(id, checkout, upstream, branch, revision);
    console.log(`[applied] ${id} ${revision.slice(0, 9)} (origin ${origin})`);
    changed += 1;
  } catch (error) {
    failed += 1;
    console.warn(`[fail] ${id}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

await Promise.all(
  Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= ids.length) return;
      await materialize(ids[index]);
    }
  }),
);

console.log(`done: ${ids.length} forks, ${changed} changed, ${failed} failed`);
process.exit(failed ? 1 : 0);
