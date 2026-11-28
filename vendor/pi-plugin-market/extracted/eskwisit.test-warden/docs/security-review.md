# Test Warden: security review notes

Material for the PI-Desktop plugin center review ([SECURITY.md], "Review procedure", step 8).
Plugin `eskwisit.test-warden`, unreleased. Everything here was checked against `main.js`,
`manifest.json`, `skills/test-warden.md` and `subagents/test-warden-writer.md` in this repository.
Functions are named rather than given line numbers, so the notes stay correct while the code
changes.

## Summary

| | |
|---|---|
| Risk tier | **High**: the plugin requests `agent.prompt.inject`, `agent.tool.register` and `fs.write` |
| Runtime files | `manifest.json`, `main.js`, `skills/test-warden.md`, `subagents/test-warden-writer.md`, `README.md`, `CHANGELOG.md`, `LICENSE` |
| Dependencies | None: no `package.json`, and no vendored, generated, minified or native code. Node built-ins `fs`, `os`, `path`, `crypto` only |
| Network | None |
| Process execution by the plugin | None. The tools write bash scripts that the **agent** runs with its own Bash tool, under the user's Bash approval (see Findings 1) |
| Dynamic code | None in the plugin: no `eval`, `new Function` or dynamic `import()`. The generated scripts `eval` the project's verified test command (see Findings 2) |
| File system, host API | `pi.fs.readText`, `pi.fs.list`, `pi.fs.stat` over the workspace (`fs.read` scope `**/*`). `pi.fs.writeText` scoped by `manifest.fs` to `.test-warden/**` |
| File system, Node `fs` | One fixed location: `~/.agents/subagents/test-warden-writer.md` |
| Persistence | Workspace files under `.test-warden/`: `profile.json`, `lessons.json`, and `runs/<id>/` (git-ignored). Plugin settings `maxWriters`, `writerModel`, `runTimeout` |
| Data leaving the machine | Nothing through the plugin. Test files, diffs and logs reach the models the user configured, through PI-Desktop's own agent and delegation |
| Activation | `onStartup`, so the tools are registered and the writer is installed before the skill runs |
| Required reviewers | Two independent maintainers (to be named on the plugin center) |

## Risk tier

- `agent.prompt.inject` indexes one skill, `skills/test-warden.md`. The skill tells the agent how
  to:
  - verify the project's test command;
  - call the four plugin tools and run the scripts they write;
  - delegate to the writer.

  It forbids editing the code under test.
- `agent.tool.register` adds four tools (below). Each declares `risk: "low"`: none writes outside
  `.test-warden/`, deletes anything, runs a process or reaches the network. The host still applies
  the Agent permission policy, audits every call, and hides them in Plan mode.
- `fs.write` lets the tools write the profile, the lessons and each run's files. Its scope is
  `.test-warden/**`, never the whole tree.
- `fs.read` covers the workspace. The plugin needs it to read the project's own declarations
  (manifests, configs, CI files) and to map changed files to their tests. The host refuses
  credential files (`.env*`, `.ssh/`, `.git/`, `*.pem`, …) whatever the scope says.

## Permissions matrix

| Permission | Used for | Host calls | Where |
|---|---|---|---|
| `agent.prompt.inject` | The Test Warden skill in the agent's skill catalog | none at runtime (`contributes.skills`) | `manifest.json` |
| `agent.tool.register` | `warden_profile`, `warden_check`, `warden_gate`, `warden_lessons` | `pi.agent.registerTool`, `pi.agent.unregisterTool` | `onLoad()`, `onUnload()` |
| `fs.read` (workspace, `**/*`) | Root manifests and test configs, CI files, the test-file walk, test files read for import mapping (capped at 400 per plan), the files to snapshot, results and logs | `pi.fs.readText`, `pi.fs.list`, `pi.fs.stat` | `readFile()`, `list()`, `walk()`, `exists()`, `rootConfig()`, `snapshotFiles()` |
| `fs.write` (`.test-warden/**`) | `profile.json`, `lessons.json`, `.gitignore`, and per run: `plan.json`, `snapshot.json`, `snapshot/**`, `check.sh`, `gate.json`, `gate.sh`, `verdict.json`, `gate-verdict.json` | `pi.fs.writeText` | `writeFile()`, called from `ensureProfile()`, `profileSet()`, `checkPlan()`, `checkVerdict()`, `gatePlan()`, `gateVerdict()`, `saveLessons()`, `ensureGitignore()` |

Host APIs called without a permission of their own:

| Call | Purpose | Where | On failure |
|---|---|---|---|
| `pi.plugin.getSettings()` | `maxWriters`, `writerModel`, `runTimeout` (declared in `contributes.settings`) | `settings()` | The tool call fails with the host's error |

## Node `fs` outside the host gateway

PI-Desktop loads sub-agents only from `~/.agents/subagents`, which the host file API cannot reach.
The plugin uses Node `fs` for that alone, with fixed paths and no path taken from tool input:

| What | Path | Operations | Where | Bounds |
|---|---|---|---|---|
| Writer install | `~/.agents/subagents/` (`os.homedir()`) | `mkdir`; write `test-warden-writer.md` shipped in `subagents/` when it is missing or different | `installAgents()`, from `onLoad()` | Fixed file name. Errors are caught, and the status is reported by `warden_profile` |
| Obsolete agents | same | Delete a `test-warden-*.md` that is not shipped **and** contains the marker "Use only from the test-warden skill." | `installAgents()` | Only files this plugin shipped in an earlier version |
| Writer removal | same | Delete `test-warden-writer.md` **only if its content equals the shipped file** | `removeAgents()`, from `onUnload()` | A writer the user edited is kept |

## Agent tools

| Tool | Input | Reads | Writes | Returns |
|---|---|---|---|---|
| `warden_profile` | `get` (`refresh`) or `set` (`stack`, `suite`, `file`, `verified`, `patterns`) | Root config and CI files, the workspace walk, `profile.json` | `profile.json`, `.gitignore` | The profile, settings, lesson count, writer status |
| `warden_check` | `plan` (`mode`, `changed`, `base`) or `verdict` (`run`) | Test files, `plan.json`, `check.tsv`, `logs/` | `plan.json`, `snapshot.json`, `snapshot/**`, `check.sh`, `verdict.json` | Map, uncovered files, suggestions, command; or the verdict |
| `warden_gate` | `plan` (`run`, `kind`, `tests`, `bugs`, `written`, `base`) or `verdict` (`run`) | The targets and their snapshot, `gate.json`, `gate.tsv`, `logs/` | `gate.json`, `gate.sh`, `gate-verdict.json` | Changed protected files, violations, restore and undo commands, the verdict |
| `warden_lessons` | `get`, `add` (`lessons`), `remove` (`ids`) | `lessons.json`, evidence paths (existence only) | `lessons.json` | The lessons, counts, rejections |

Input validation before any file call:

- **`run`** must match `^\.test-warden/runs/[A-Za-z0-9][A-Za-z0-9._-]*$` after normalisation
  (`runPath()`).
- **Workspace paths** pass through `relPath()`, which rejects absolute paths, drive letters and
  `..`.
- **`base`** is rejected if it contains whitespace, `;&|`$<>'"\` or starts with `-`
  (`checkRef()`).
- **Commands** saved by `set` must be one line of 1–400 characters, and a per-file command must
  contain `{file}` or `{dir}` (`cmdArg()`, `profileSet()`).
- **Lessons** must be 10–200 characters, cite an existing workspace path, and are capped at 30.

## Generated scripts

`buildScript()` writes `check.sh` and `gate.sh` into the run folder. Every path, key, ref and
command embedded in them is quoted with `q()`, POSIX single quotes with embedded quotes escaped.
The scripts:

- Derive the workspace from their own location, and the repository and prefix from `git
  rev-parse`, so they work when the workspace is a folder inside a larger repository.
- Run old or altered code only in temporary `git worktree`s under `$TMPDIR`. A `trap … EXIT`
  removes them and runs `git worktree prune`, even when a test fails or the script is
  interrupted.
- Write only:
  - inside those worktrees: copied test files, an overlay of the working tree's uncommitted
    files, deleted bug files, and emptied targets (`: >`) for the suite gate;
  - inside the run folder: `*.tsv` results and `logs/`.

  They never write to the working tree.
- Symlink `node_modules`, `.venv`, `venv` and `vendor` into the worktrees, read-only use only.
  `git worktree remove` unlinks these and does not follow them.
- Never install packages: they export `pnpm_config_verify_deps_before_run=false` (and the
  `npm_config_` form for pnpm 10), so `pnpm <script>` does not run `pnpm install` first. Such an
  install can hang offline and, in a worktree, target the linked `node_modules` of the working
  tree; pnpm refuses that and fails, which would be read as a test failure.
- Run each test command in its own process group with a watchdog: after `runTimeout` seconds
  (default 600) the whole group is killed and the run is recorded as `timeout`. Verdicts list it
  in `timedOut` and `incomplete`, never as a failure. A `TERM`/`INT`/`HUP` to the script kills
  the running group too.

Undo and restore are returned as **commands for the agent to run**, never run by the plugin
(`undoCommand()`):

- **Snapshotted files** are copied back with `cp` from `snapshot/`, only if the snapshot file
  exists. Nothing is truncated first.
- **Files absent at plan time** are removed.
- **Files without a usable snapshot** (too large, unreadable, or past the 80-file cap): an
  untracked one is removed, and a tracked one is never touched. It is listed in `manualReview`.
  There is no fallback to `git checkout`, which would discard uncommitted work.

## Untrusted text

Test files, configs, CI files, failure logs and lessons are project or model text.

- The plugin only matches regexes against them and returns short excerpts: at most 15 lines of
  200 characters per failure.
- Only one kind of text becomes part of a script: commands taken from the project's own
  declarations. The skill requires the agent to verify such a command and save it with `set`, and
  `requireVerified()` refuses to plan with an unverified one.
- A malicious repository could declare a harmful test command. Running it is no different from
  the user running the project's tests, and it still goes through the agent's Bash approval.

## Negative paths (tests)

`node --test tests/` runs against a fake host in temporary directories (workspace and `HOME`), and
against real git repositories created in `$TMPDIR`. It never touches the real ones. The tests
check that:

- Run paths with `..`, nested or absolute paths are rejected, and so are hostile `base` refs
  (`HEAD; rm -rf /`, `--output=x`).
- `set` rejects multi-line commands, per-file commands without `{file}`, invalid stack ids, and
  "verified" stacks with no command. A changed command loses its verified flag.
- `warden_check` refuses to plan without a verified command, and `suite` mode refuses test or
  helper targets.
- Each generated script variant passes `bash -n`, and hostile names (quotes, `$`) are quoted.
- Run for real, the scripts leave `git status` of the working tree and the worktree list
  unchanged.
- A target changed by a "writer" that did not report it is detected by content. The restore
  command brings back the user's uncommitted version byte for byte.
- An undo with a missing snapshot leaves the file untouched; an untracked unsnapshotted file is
  removed; a tracked one is listed for manual review.
- Incomplete runs (interrupted or `absent`) are reported as incomplete, not as failures.
- A hanging run is killed with its whole process tree after the timeout, leaves no process
  behind, and is reported as `timedOut`, not as a regression.
- Writer install refreshes an outdated file and removes only marker-bearing obsolete agents.
  Unload keeps a writer the user edited.
- The manifest's `agentTools` equal the registered tools; the plugin writes only under
  `.test-warden/`; and no framework name drives the logic in `main.js`.

## Findings and mitigations

1. **Skill-driven shell use.** Unlike llm-council, the skill does have the agent run shell
   commands: `git diff`, the generated `check.sh` and `gate.sh`, and the project's test command.
   Running tests is the plugin's purpose, and the plugin itself still runs no process.
   Mitigations:
   - The scripts are deterministic, generated from validated input, and quoted.
   - They only write in temporary worktrees and the run folder.
   - Every run goes through the agent's Bash tool and the user's approval settings.
2. **`eval` of the test command inside `run()`.** This is needed so that a command such as
   `npm run test -- --watch=false` keeps its own shell syntax. The command comes from the pinned
   profile, which is set by the agent after verification (or by the user) and is never taken from
   tool output or test files.
3. **The writer sub-agent has `Edit`, `Write` and `Bash`.**
   - A sub-agent's file tools cannot be scoped by path.
   - The gate therefore enforces the rules afterwards. Targets are compared by sha256 with the
     snapshot taken before the writer ran, so an unreported edit is caught too, and reported
     writes outside the test files are flagged.
   - Exact restore commands are returned. The skill and the writer's own instructions forbid
     editing the code under test, and bugs are reported, not fixed.
4. **Node `fs` outside the gateway.** Needed for the sub-agent directory only (see the table
   above). The path is fixed and documented in `safetyNotes`.
5. **Broad `fs.read`.** Scope `**/*` is needed to discover the project's tests. Writes stay
   limited to `.test-warden/**`, and the host's credential deny-list applies.

## Known limits

- **Agent mode only.** PI-Desktop hides plugin tools and delegation in Plan and Goal mode.
- **A git workspace is required.** The worktrees need it.
- **Snapshot caps.** At most 80 files per run, 512 KiB per file and 4 MiB in total. Larger files
  are reported for manual review instead of being restored automatically.
- **Sub-agent limit.** PI-Desktop loads at most 16 sub-agent definitions; Test Warden uses 1.

## Commands run

```console
$ node --test tests/
ℹ tests 50
ℹ pass 50
ℹ fail 0
$ node --check main.js
```

```console
$ grep -nE "require\(|child_process|fetch\(|XMLHttpRequest|WebSocket|eval|Function\(|import\(" main.js
34:const fs = require("node:fs");
35:const os = require("node:os");
36:const path = require("node:path");
37:const crypto = require("node:crypto");
778:  L.push('  ( cd "$dir" && export PYTHONPATH="$dir/src:$dir${PYTHONPATH:+:$PYTHONPATH}" && eval "$cmd" ) > "$log" 2>&1 < /dev/null');
```

Line 778 is the shell `eval` written into the generated script (Findings 2). It is a string, not
JavaScript `eval`.

PluginCheck (PI-Desktop) passes with one warning: the high-risk permissions `agent.prompt.inject`,
`agent.tool.register` and `fs.write` need an explicit user grant. The release workflow packages
only the tracked runtime files: `LICENSE`, `README.md`, `main.js`, `manifest.json`, `CHANGELOG.md`,
`skills/test-warden.md` and `subagents/test-warden-writer.md`.

The catalog's `scripts/security_audit.py` has not been run yet. It lives in the plugin center
repository; run it on a scratch copy before submitting.

[SECURITY.md]: https://github.com/vastsa/pi-desktop-plugins/blob/main/SECURITY.md
