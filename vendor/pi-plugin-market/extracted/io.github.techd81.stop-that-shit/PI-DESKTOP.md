# Stop That Shit for PI-Desktop

This is the PI-Desktop build of [Stop That Shit](https://github.com/lennney/stop-that-shit):
the same Skill, the same Guard decisions, and the same audit record, wired to
the PI-Desktop extension surface instead of the Pi CLI hooks.

Plugin id: `io.github.techd81.stop-that-shit`. Permissions: `agent.extension`,
`agent.prompt.inject`, `ui.panel`, `ui.view`.


## What is enforced

| Action | Default when the Guard is armed |
| --- | --- |
| Write during `review`, `answer`, or `monitor` | Blocked |
| Write outside `files=` | Blocked |
| Add a dependency | Approval; `deps=allow` permits it |
| Recognized hash operation | Blocked; `hash=allow` permits it |
| Subagent launch beyond `agents=N` | Blocked |
| Any tool whose target path cannot be proven | Approval |

The Guard starts in `unobserved / unconfirmed`: nothing is blocked until an
explicit directive arms it. `/sts status` shows the active state, the effective
budget, and the reason the last action was decided.

## Slash entry

PI-Desktop resolves `/name` in the composer from prompt templates at
`~/.pi/agent/prompts` (user) and `<project>/.pi/prompts` (project). The manifest has no
contribution for that directory, so the plugin writes the two templates itself on load:
`stop-that-shit.md` and `sts.md` are there right after installation, and a template whose
shipped text changed is replaced, with the displaced text kept once as `.md.bak`; that is
how an upgrade reaches a user who never runs anything. `npm run prompts:desktop` performs
the same write from a checkout.

```text
/stop-that-shit review -- Review this diff. Report findings; do not edit.
/stop-that-shit change -- Fix the failing config test.
/stop-that-shit lock change files=src/config.cjs|test/config.test.cjs -- Fix this behavior.
/stop-that-shit change deps=allow -- Add the requested parser dependency.
/stop-that-shit change hash=allow -- Generate the checksum the release step reads.
/stop-that-shit change agents=1 -- Use one independent test subagent.
/stop-that-shit watch -- Observe only.
```

The template body is `$stop-that-shit $ARGUMENTS`, so the composer expands your
line into the Guard's own head before the turn starts. The Guard also accepts a
raw `/stop-that-shit …`, `/sts …` or `$sts …` (unexpanded), `/skill:sts …`, and
`:` as the separator (`/sts:status`), which keeps scripts, pasted text, and
muscle memory from the `$`-head hosts working. A head on a later line is
reported as `DIRECTIVE_NOT_ARMED` instead of being ignored.

Fields: `answer | review | monitor | change | open`, `watch | guard | lock | off`,
`agents=N`, `hash=deny|ask|allow`, `files=a|b|**`, `deps=deny|ask|allow`.
A directive that does not start the first line, or a malformed one, leaves the
previous contract unchanged and says so.

## Queries

```text
/sts                 same as /sts status
/sts status          contract, authority source, delegation capacity
/sts runtime [all]   checked actions, Guard responses, label counts
/sts explain evt_…   one recorded decision, with its reason code
/sts label evt_… correct|incorrect|inconclusive
/sts doctor          data directory, damaged records, stale locks, panel/extension agreement
```

These work through the same template (`$stop-that-shit $ARGUMENTS`), so they do
not depend on the host exposing extension commands. The equivalent raw forms
work anywhere the composer passes text through, and a bare head is read as
`status`: `/sts`, `/stop-that-shit` and `$stop-that-shit` with no fields all
answer the state query instead of arming nothing.

```text
$stop-that-shit status
$stop-that-shit runtime
$stop-that-shit explain evt_…
$stop-that-shit label evt_… correct
```

The panel's doctor row `extension` states which case you are in: `LOADED` with
the command API name, or `WAITING` when the agent extension has not registered
in that data directory yet. `/sts` never blocks the rest of the plugin.

## Panel

`Stop That Shit: 打开面板` (or the command palette) opens the page as a
work-panel tab, so it sits beside 浏览器 / 文件管理器 / PI Canvas in the `+ 新建`
menu as `别再造史了`. The same page is also the standalone `ui.panel` window: the
command asks for the tab first and falls back to the window when the host cannot
reveal a view or refuses the request. It shows the active contract, per-session
contracts, the audit event list, the decision detail for one event, label
buttons, and the doctor report. It only reads the plugin's own data directory;
labelling appends one annotation.

The toolbar's `EN` / `中` button switches the interface language. The choice is
kept in the panel and overrides the host locale until you switch back; reason
codes, tool names, and policy values stay in their recorded form.

## Where data lives

```text
%USERPROFILE%\.pi-desktop\plugins\data\io.github.techd81.stop-that-shit\
  sessions\<session>.json     contract + delegation ledger (no code, no prompts)
  runtime\<session>.jsonl     metadata-only decision events
  runtime\annotations.jsonl   human labels
  runtime\extension.json      which host API the agent extension registered with
```

Records keep tool names, mutability, reason codes, and counts. They never keep
file contents, prompts, or conversation text.

## How the host surface maps

| PI-Desktop event | What the Guard does |
| --- | --- |
| `before_agent_start` | Reads the turn's prompt, updates the contract, appends the contract block to the system prompt (never replaces what earlier handlers added) |
| `tool_call` | Classifies the host tool, decides, returns `{ block, reason }` for a denial |
| `tool_result` | Releases a settled `Task` reservation; attaches a watch-mode note |
| `session_start` / `session_shutdown` | Session bookkeeping |

Tool classification: `read`/`grep`/`find`/`ls`/`glob`/`Skill` are reads;
`write`/`edit` are writes and contribute their target path; `bash`/`powershell`
go through the shared static shell analysis; `Task` is a delegation (one child
per call); `TaskWait`/`TaskList`/`TaskStop`/`TodoWrite` and the other host control
tools are bookkeeping; everything else is `unknown`, which a read-only contract
does not permit.

## Install

```powershell
npm run check:desktop      # manifest and declared files
npm run eval:desktop       # 24 upstream Bad/Good cases through this adapter
npm run pack:desktop       # dist/io.github.techd81.stop-that-shit-<version>.piplug
```

These scripts live in the repository; the packaged `.piplug` ships the runtime
plus `scripts/install-desktop-prompts.cjs`. A normal installation needs no manual
step: the load-time install writes both templates and refreshes them on upgrade.

Install the `.piplug` from the plugins page, or load the checkout as a local
plugin, then enable it and start a new chat (an extension loads at the session's
next turn boundary).

## Repository layout

This checkout is the plugin only: no other host's adapter, no runtime
dependency to install.

```text
manifest.json     plugin manifest (id, permissions, contributions)
main.js           panel host bridge (onLoad / onUnload / onPanelInvoke)
src/desktop/      PI-Desktop adapter: hooks, classifier, panel, doctor, templates
src/*.cjs         shared decision core (contracts, decision, state, audit)
views/            panel UI (DOM only, no framework)
skills/           the two skills the host indexes
cases/            the 24 Bad/Good cases behind `npm run eval:desktop`
scripts/          check / eval / pack / prompt-template installer / test runner
test/             desktop adapter tests plus the core tests they rely on
```

`npm test` runs `check:desktop` first, then every `test/*.test.cjs`.

## Smoke test

1. Open a new chat and send, as the first line:

   ```text
   $stop-that-shit review -- Inspect this repository and report what you find. Do not edit anything.
   ```

2. Ask the agent to modify any file. It must be refused with
   `MODE_FORBIDS_MUTATION`, and the message must name that contract.
3. Send `/sts status`: State shows `ARMED / review`.
4. Open the panel: the refusal is the newest audit event, and its detail names
   the reason code with `Host effect: unobserved`.
5. Send `$stop-that-shit change -- …` and repeat the edit: it now runs.

## Limits

- A block is a denial handed back to the agent. PI-Desktop decides whether the
  tool actually stopped, so the record keeps `hostEffect: unobserved`.
- `input` handlers do not fire in PI-Desktop, so a directive is read once per
  turn at `before_agent_start` instead of at prompt admission. A directive sent
  mid-turn applies to the next turn.
- A `Task` call that returns is treated as its own completion. A call that
  declares detached work keeps its reservation for the rest of the session:
  session end does not release it, so a session that reconnects under the same
  id still sees the reservation.
- The contributed Skill descriptions are the upstream ones; the host caps skill
  descriptions at 240 characters, so the model sees a truncated tail. The
  trigger sentence is at the start of both descriptions.
- The host derives a skill id from the file stem, so both entries declare an
  explicit `id`. Without it two `SKILL.md` files collapse to one id and the
  second skill is dropped as `DUPLICATE` at load time.
- If the shared reader throws on an unexpected filesystem error (a state file
  replaced by a directory, a locked file), the hook fails open: the turn
  continues, a toast names the failure, and the next call is checked again.
  This is the upstream Pi adapter's behaviour, kept deliberately.
- This is a guardrail, not a sandbox: a tool path the host does not report
  through `tool_call` is outside its reach.
- `files=` is matched against the path the tool reports, as text. A link,
  junction, or hard link that already sits inside the boundary can still point
  outside it; the Guard compares names, not inodes.
- A shell command's write target is never proven, so `files=` and a shell write
  cannot both hold: use `write`/`edit` for a file inside the boundary instead of
  `Set-Content` or a redirection.

- Audit records keep `policyRevision.pluginVersion` from the packaged
  `package.json`, which carries the same version as `manifest.json` (0.2.6).
  The packaged `package.json` keeps only `name`/`version`/`description`/`license`:
  the upstream `main`, `exports`, `bin` and `pi` fields point at the other
  hosts' entry points, which this artifact does not ship.
