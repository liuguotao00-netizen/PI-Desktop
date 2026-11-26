# LLM Council: security review notes

Material for the PI-Desktop plugin center review ([SECURITY.md], "Review procedure", step 8).
Plugin `eskwisit.llm-council`, unreleased. Everything here was checked against `main.js`,
`manifest.json`, `skills/llm-council.md` and `subagents/*.md` in this repository. Functions are
named rather than given line numbers so the notes stay correct while the code changes.

## Summary

| | |
|---|---|
| Risk tier | **High**, because the plugin requests `agent.prompt.inject`, `agent.tool.register` and `fs.write` |
| Runtime files | `manifest.json`, `main.js`, `skills/llm-council.md`, `subagents/*.md` (7 persona documents), `README.md`, `LICENSE` |
| Dependencies | none (no `package.json`, no vendored, generated, minified or native code); Node built-ins `fs`, `os`, `path`, `crypto` only |
| Network | none |
| Process execution | none, and the skill no longer asks the agent to run shell commands (see Findings 1) |
| Dynamic code | none (no `eval`, `new Function`, dynamic `import()`) |
| File system, host API | `pi.fs.readText`, `pi.fs.list`, `pi.fs.writeText`, scoped by `manifest.fs` to `.llm-council/**` in the workspace |
| File system, Node `fs` | two fixed locations: `~/.agents/subagents/council-*.md` (the 7 personas) and the plugin's own data directory from `pi.plugin.getDataPath()` |
| Persistence | plugin settings `cast`, `excludeModels`, `modelNotes`; one JSON file per council run in the data directory, pruned after 30 days; the run files in the workspace |
| Data leaving the machine | nothing through the plugin. The run's question, answers and reviews go to the models the user cast, through PI-Desktop's own delegation |
| Activation | `onStartup`, so the tools are registered and the personas installed before the skill runs |
| Required reviewers | two independent maintainers (to be named on the plugin center) |

## Risk tier

- `agent.prompt.inject` indexes one skill, `skills/llm-council.md`. The skill tells the agent how
  to run a council: cast models, write the question, delegate to the six personas, and call the
  four plugin tools. It contains no shell commands.
- `agent.tool.register` adds four tools (below). Each declares `risk: "low"`: none reads outside
  `.llm-council/`, writes outside it, deletes anything, or reaches the network. The host still
  applies the Agent permission policy, audits every call, and hides them in Plan mode.
- `fs.write` lets the tools write the run's prompts and reports. Its scope is `.llm-council/**`,
  never the whole tree.

## Permissions matrix

| Permission | Used for | Host calls | Where |
|---|---|---|---|
| `agent.prompt.inject` | The LLM Council skill in the agent's skill catalog | none at runtime (`contributes.skills`) | `manifest.json` |
| `agent.tool.register` | `council` (actions `get`, `set`, `anonymize`, `tally`, `report`) | `pi.agent.registerTool`, `pi.agent.unregisterTool` | `onLoad()`, `onUnload()` |
| `fs.read` (scope `.llm-council/**`) | Reading the run's question, answers, reviews, title and verdict | `pi.fs.readText`, `pi.fs.list` | `readFile()`, `readSeatFiles()`, `readQuestion()` |
| `fs.write` (scope `.llm-council/**`) | Writing `stage2_prompt.md`, `aggregate.json`, `stage3_prompt.md`, `report.md`, `transcript.json`; emptying `stage1/<seat>.md` | `pi.fs.writeText` | `councilAnonymize()`, `councilTally()`, `councilReport()` |

Host APIs called without a permission of their own:

| Call | Purpose | Where | On failure |
|---|---|---|---|
| `pi.plugin.getSettings()` / `setSettings()` | The saved cast, exclusions and notes (declared in `contributes.settings`) | `settings()`, `councilConfig()` | The tool call fails with the host's error |
| `pi.plugin.getDataPath()` | The private data directory for run state | `stateDir()` | The tool call fails; `pruneStates()` ignores it |

## Node `fs` outside the host gateway

PI-Desktop's file API reaches only the workspace or a directory the user picks. Two things the
plugin needs are elsewhere, so it uses Node `fs` for them, with fixed paths and no path taken from
tool input:

| What | Path | Operations | Where | Bounds |
|---|---|---|---|---|
| Persona install | `~/.agents/subagents/` (`os.homedir()`), the only place PI-Desktop loads sub-agents from | `mkdir`, write the 6 `council-*.md` files shipped in `subagents/` when missing or different | `installPersonas()`, from `onLoad()` | Fixed file names. Errors are caught; the status is reported by `council get` |
| Obsolete personas | same | delete a `council-*.md` file that is not one of the 7 **and** contains the marker "Use only from the llm-council skill." | `installPersonas()` | Only files this plugin shipped in an earlier version |
| Persona removal | same | delete each of the 7 files **only if its content equals the shipped file** | `removePersonas()`, from `onUnload()` | A persona the user edited is kept |
| Run state | `<getDataPath()>/runs/<sha256(run)[0:16]>.json` | `mkdir` (mode 700), write (mode 600) via a temp file and rename, read, delete files older than 30 days | `saveState()`, `loadState()`, `pruneStates()` | File names are hashes; nothing outside the plugin's data directory |

## Agent tools

| Tool | Input | Reads | Writes | Returns |
|---|---|---|---|---|
| `council get` / `set` | model ids, cast, exclusions, notes | plugin settings | plugin settings (set only); a cast is validated against the given model ids and exclusions first | cast, staleness, exclusions, notes, persona status |
| `council anonymize` | `run`, `stage1` models per seat, `force` | `<run>/question.md`, `<run>/stage1/*.md` | `<run>/stage2_prompt.md`; empties `<run>/stage1/<seat>.md`; run state | counts, warnings |
| `council tally` | `run`, `reviewers` models | `<run>/question.md`, `<run>/stage2/*.md`, run state | `<run>/aggregate.json`, `<run>/stage3_prompt.md`, run state | parsed rankings, average ranks, parse warnings |
| `council report` | `run`, `title`, chairman model, cast, failovers | the run files and run state | `<run>/report.md`, `<run>/transcript.json` | title, paths |

`run` must match `^\.llm-council/runs/[A-Za-z0-9][A-Za-z0-9._-]*$` after a leading `./` and
trailing slashes are removed (`runPath()`), so `..`, absolute paths and nested paths are rejected
before any file call; `pi.fs` enforces the manifest scope again. Stage files are read only when
their name is an advisor seat (`readSeatFiles()`). `council anonymize` refuses to run twice on one
run unless `force: true`, so reviews under way are not reshuffled by accident.

### Untrusted text

The question, answers and reviews are model or user text. The plugin only concatenates them into
Markdown prompts and reports and JSON files; nothing is executed, evaluated or rendered as HTML.
One model's answer does reach the other models as part of the review and chairman prompts, so a
prompt injection in one answer could try to sway the reviewers. The personas tell reviewers to
read only their brief file and to answer only in the required format.

## Negative paths (tests)

`node --test tests/` runs against a fake host in a temporary directory (workspace, data directory
and `HOME`), never the real ones:

- run paths with `..`, absolute paths, nested paths and empty strings are rejected
- an invalid cast (unknown, excluded or missing seat, unknown seat name) is rejected and not saved
- anonymizing twice is refused; `force` redoes it from the hidden answers
- empty answers and files that are not advisor seats are skipped; no answers at all fails
- tally before anonymize fails; a report with no answers says that all models failed
- run state survives unloading and reloading the plugin
- persona install refreshes outdated files, removes only marker-bearing obsolete personas, keeps
  the user's own `council-*.md`; unload keeps a persona the user edited
- a persona install that fails (a file where `~/.agents` should be) does not break loading
- the manifest's `agentTools` equal the registered tools (name, description, risk, schema), and
  the permissions and scopes are exactly those listed here

## Findings and mitigations

1. **Skill-driven shell use, removed.** The previous version's skill had the agent run a bundled
   Python script through the shell, which wrote to `~/.agents/subagents` and `~/.llm-council`.
   That is the pattern PI-Desktop's plugin security spec lists as an open risk for
   `agent.prompt.inject`. The skill now calls declared, audited plugin tools instead and contains
   no shell commands.
2. **Node `fs` outside the gateway.** Needed for the persona directory and the data directory (see
   the table above). Paths are fixed, never taken from input, and documented in `safetyNotes`.
3. **Persona removal on unload.** Limited to files whose bytes equal the shipped personas, so
   user edits survive. Disabling the plugin therefore also removes the personas from the Task
   list and frees their sub-agent slots.
4. **Anonymity is best effort.** Reviewers see only Response A–E, and the Stage 1 files are emptied
   (not moved to the trash) during review. The label map and answers sit in the plugin's data
   directory, which agents can still read if they go looking, and models may recognise their own
   writing. The README says so.
5. **Third-party text.** The review and chairman prompts are written for this plugin; a
   test checks that the upstream templates' sentences are absent.

## Known limits

- Agent mode only: PI-Desktop hides plugin tools and delegation in Plan and Goal mode.
- A workspace must be open; the run files live in it.
- PI-Desktop loads at most 16 sub-agent definitions; the council uses 7.

## Commands run

```console
$ node --test tests/
ℹ tests 31
ℹ pass 31
ℹ fail 0
$ node --check main.js
```

```console
$ python3 scripts/security_audit.py plugins/eskwisit.llm-council
# (catalog repository scripts; run on a scratch copy holding manifest.json, main.js, skills/,
#  subagents/, README.md, LICENSE)
Security audit: 1 plugin source(s), 0 blocker(s), 1 manual-review signal(s)
REVIEW: eskwisit.llm-council/main.js:528: manual review signal: filesystem mutation
Security audit passed automatic checks; maintainer review is still required.
```

The signal is the first `pi.fs.writeText` call; every write is listed in the permissions matrix
and the Node `fs` table above.

```console
$ grep -nE "require\(|child_process|fetch\(|XMLHttpRequest|WebSocket|eval|Function\(|import\(" main.js
25:const fs = require("node:fs");
26:const os = require("node:os");
27:const path = require("node:path");
28:const crypto = require("node:crypto");
```

PluginCheck (PI-Desktop) passes with one warning: the high-risk permissions `agent.prompt.inject`,
`agent.tool.register` and `fs.write` need an explicit user grant. The release workflow packages
the tracked runtime files only: `LICENSE`, `README.md`, `main.js`, `manifest.json`,
`skills/llm-council.md` and the six `subagents/*.md`.

[SECURITY.md]: https://github.com/vastsa/pi-desktop-plugins/blob/main/SECURITY.md
