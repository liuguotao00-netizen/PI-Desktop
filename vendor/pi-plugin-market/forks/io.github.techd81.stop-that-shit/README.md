# Stop That Shit — 别再造史了

A task-boundary guard for PI-Desktop: every tool call is checked against an explicit
contract you declared in the first line of the turn, and the calls the contract forbids
are refused before they run. Everything the Guard decides is written to a local,
metadata-only audit record that the bundled panel reads back.

This repository is the PI-Desktop build of [lennney/stop-that-shit](https://github.com/lennney/stop-that-shit):
the same Skill, the same Guard decisions, and the same audit record, wired to the
PI-Desktop extension surface instead of the Pi CLI hooks.

## What it refuses

| Action | Default once the Guard is armed |
| --- | --- |
| Write during `review`, `answer`, or `monitor` | Blocked |
| Write outside `files=` | Blocked |
| Add a dependency | Approval; `deps=allow` permits it |
| Recognized hash operation | Blocked; `hash=allow` permits it |
| Subagent launch beyond `agents=N` | Blocked |
| Any tool whose target path cannot be proven | Approval |

A block is a denial handed back to the agent: PI-Desktop decides whether the tool
actually stopped, so the record keeps `hostEffect: unobserved`. Nothing is blocked
until a directive arms the Guard — a fresh session starts `unobserved / unconfirmed`.

## Quick start

Install the plugin from the plugin center, enable it, and start a new chat (an agent
extension loads at the session's next turn boundary). The `/stop-that-shit` and `/sts`
composer templates install themselves when the plugin loads: they are written into
`~/.pi/agent/prompts`, and a template whose shipped text changed is replaced, with the
displaced text kept once as `.md.bak`. An upgrade therefore reaches users who never run
anything. The same write is available from a checkout:

```powershell
npm run prompts:desktop
```

Send a directive as the **first line** of the turn:

```text
/stop-that-shit review -- Review this diff. Report findings; do not edit.
/stop-that-shit change -- Fix the failing config test.
/stop-that-shit lock change files=src/config.cjs|test/config.test.cjs -- Fix this behavior.
/stop-that-shit change deps=allow -- Add the requested parser dependency.
/stop-that-shit watch -- Observe only.
```

Fields: `answer | review | monitor | change | open`, `watch | guard | lock | off`,
`agents=N`, `hash=deny|ask|allow`, `files=a|b|**`, `deps=deny|ask|allow`. The head is
also read in its raw forms: `/stop-that-shit …`, `/sts …`, `$sts …`, `/skill:sts …`,
with `:` as the separator (`/sts:status`). A directive that does not start the first
line is reported as `DIRECTIVE_NOT_ARMED` instead of being silently ignored.

## Queries

```text
/sts                 same as /sts status
/sts status          contract, authority source, delegation capacity
/sts runtime [all]   checked actions, Guard responses, label counts
/sts explain evt_…   one recorded decision, with its reason code
/sts label evt_… correct|incorrect|inconclusive
/sts doctor          data directory, damaged records, stale locks, panel/extension agreement
```

## Panel

`别再造史了` sits in the `+ 新建` menu beside 浏览器 / 文件管理器 / PI Canvas, and the
same page also opens as a standalone window from the command palette. It shows the
active contract, per-session contracts, the audit event list, one decision's detail,
label buttons, and the doctor report. The `EN` / `中` button switches the interface
language and remembers the choice; reason codes, tool names, and policy values stay in
their recorded form.

Data lives in `%USERPROFILE%\.pi-desktop\plugins\data\io.github.techd81.stop-that-shit`:

```text
sessions\<session>.json     contract + delegation ledger (no code, no prompts)
runtime\<session>.jsonl     metadata-only decision events
runtime\annotations.jsonl   human labels
runtime\extension.json      which host API the agent extension registered with
```

Records keep tool names, mutability, reason codes, and counts. They never keep file
contents, prompts, or conversation text. No network access, no telemetry.

## Development

```powershell
npm test                 # check:desktop + every test/*.test.cjs
npm run check:desktop    # manifest and declared files
npm run eval:desktop     # 24 upstream Bad/Good cases through this adapter
npm run pack:desktop     # dist/io.github.techd81.stop-that-shit-<version>.piplug
```

[PI-DESKTOP.md](PI-DESKTOP.md) documents the host mapping, the panel, and the known
limits (links and junctions compared by name, shell write targets never proven, a
detached `Task` keeping its reservation for the session).

## 中文说明

插件装好后启用，**另起一个新会话**（agent extension 在下一个回合边界加载）。`/stop-that-shit`
与 `/sts` 两个补全模板在插件加载时自动写进 `~/.pi/agent/prompts`；模板文案随版本变化时直接
覆盖，被替换的旧文本另存为 `.md.bak`，所以升级后用户不用做任何事。在仓库里也能手动触发同一
处写入：

```powershell
npm run prompts:desktop
```

在**第一行**写契约，剩下的才交给 Agent：

```text
/stop-that-shit review -- 只审这次改动，报问题，别动手改。
/stop-that-shit change -- 修好这个失败的配置测试。
/stop-that-shit lock change files=src/config.cjs|test/config.test.cjs -- 只准改这两个文件。
```

没写契约就不拦任何东西（`unobserved / unconfirmed`）。拦下来的是"回给 Agent 的拒绝"，
宿主最终是否真的没执行并不被观测，所以记录里写 `hostEffect: unobserved`。

面板在 `+ 新建` 菜单里叫「别再造史了」，右上角 `EN` / `中` 切换界面语言；审计记录只存
工具名、可变性、原因码和计数，不存代码、不存对话、不联网。

## License

MIT. Upstream © lennney; PI-Desktop port © Techd81.
