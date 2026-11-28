# User Profile

PI-Desktop 插件。把 Hermes 那套本地 `USER.md` / `MEMORY.md` 接到 Pi：有字符上限、agent 用 `memory` 工具写、每轮注入系统提示。

不接 Honcho，不封装 `modelcontextprotocol/server-memory`。流程类知识继续走 `cn.star.skill-learning`。

## 安装

须用 **0.1.7** 的 `.piplug`。导入后彻底退出 PI（含托盘）再开。

打包：

```bash
python scripts/pack-piplug.py
```

必须是 store-only zip（不压缩）。用普通 zip 打出来会被安装器拒。

不要走 Settings → MCP / 技能。那两处不装插件。

档案写在 `%USERPROFILE%\.pi\agent\user-profile\`（`USER.md`、`MEMORY.md`、`config.json`）。卸载插件不会删这些文件。

## 和 MCP memory 的关系

已安装的 knowledge-graph MCP **不是**本插件后端。用户习惯只写 `USER.md`。不要再用 MCP `create_entities` 记「我喜欢…」。

## 冒烟（P0）

准备：Agent 模式，新开一轮。建议同时启用 `cn.star.skill-learning` 做第 9 条。

| # | 操作 | 过 | 不过 |
|---|---|---|---|
| 1 | 让模型列出可用工具 | 有名为 `memory` 的工具 | 只有 `plugin_cn_star_*` 或没有 |
| 2 | 「记住我希望回复末尾只留一行用时」 | `%USERPROFILE%\.pi\agent\user-profile\USER.md` 出现对应陈述句 | 只口头答应、写到 MCP jsonl、或写到 skill 目录 |
| 3 | **再新开一轮**（不要靠同一轮上下文）问「我有什么回复偏好」 | 不调 `read` 也能答对 | 必须读文件或答不知道 |
| 4 | 同一会话再 `memory add` 一条，紧接着下一条用户消息 | 能用到**新**条目 | 要关 session 才看见 |
| 5 | 设置里把 USER.md limit 改成 80，新开一轮再 add 长条目 | 工具失败，返回 usage + current_entries，文件几乎不变长 | 截断写入或插件崩溃 |
| 6 | 先加两条都含同一词的条目，再用那个词 replace | 失败，要求更具体的 old_text | 两条一起被改 |
| 7 | 设置 Enable = off，新开一轮 | 提示词无 `USER PROFILE (who the user is)`；`memory` 拒绝写入 | 仍注入或仍能写 |
| 8 | Plan 模式 | 无 `memory` 工具 | 能在 Plan 里写档案 |
| 9 | 与 Skill Learning 同时开 | 同一轮里 Skill learning nudge **和** USER PROFILE 块都在 | 只剩其中一段 |

命令面板 **User Profile: Status** 会 toast 当前容量。第 3 条是注入是否生效的硬标准。

## 单测

```bash
node --test src/memory-store.test.js
```

## P0 未做

面板、从 Hermes 导入、项目级 MEMORY.md、超限 toast、nudge 计数。见 `PLAN.md`。
