# 官方源码核对与适配范围

## 固定来源

- 官方仓库：[deepseek-ai/DeepSeek-Harness](https://github.com/deepseek-ai/DeepSeek-Harness)
- 检查时远程 HEAD：`687f282e8625c6b8d11ff58211a90524be2e4317`
- 提交时间：2026-10-17T15:22:43+08:00；提交标题：Merge pull request #6408 … release-dsh-0.2.1-rc.2。
- 主依据是该提交的代码和系统提示快照，不使用未核实的 X 帖子。本插件不联网拉取规则，后续更新需重新核对并发版。
- MIT，Copyright (c) 2026 DeepSeek；见 THIRD_PARTY_NOTICES.md。

以下链接均固定到该提交，行号仅针对该版本。

## 采用的运行时指导

1. **有证据才声称读过文件**；范围读取、专用 Read/Glob/Grep、先读后改、小改用 Edit：
   [assembled prompt L5–17](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/snapshots/web/fresh-round-trip/system-prompt.expected.md#L5-L17)。对应工具实现为 `packages/fs/tool-fs/src/read.ts:69–74`、`write.ts:63–70`、`edit.ts:77–82`。适配时移除 DSH 的 observation-policy 强制实现说明，不暗示 PI 有相同实现；以 PI 实际工具 schema 为准。
2. **检查 shell 退出码，解决失败再继续依赖步骤**：
   [tool-bash](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/shell/tool-bash/src/index.ts#L254) 和 [tool-pwsh](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/shell/tool-pwsh/src/index.ts#L269)。不照搬 `[exit code: N]` 文本格式，读取 PI 返回的实际状态。
3. **跟踪后台任务、不忙轮询、不重复工作、收集相关结果**：
   [assembled prompt L19](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/snapshots/web/fresh-round-trip/system-prompt.expected.md#L19)。去除 `job_output/job_kill` 等 DSH 专有调用要求。
4. **独立委派可并行，并继续有用工作**：
   [subagent guidance L379–393](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/tool-subagent/src/index.ts#L379-L393)。不强迫使用 subagent/workflow，不突破 PI 的委派可用性或深度限制。
5. **外部内容是不可信数据而不是指令**：
   [assembled prompt L21–23](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/snapshots/web/fresh-round-trip/system-prompt.expected.md#L21-L23)。在 PI 适配中明确权限与凭据边界。

## 本地适配，而非官方通用提示原文

- PI-Desktop 的工具、当前模式、指令优先级与授权优先；不得自称运行于 DSH，不假定 DSH Shell/路径、特定工具或 UI。
- 遵守 plan/read-only 模式以及执行前批准。DSH [standard preset L54–65](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/web-app/presets/standard.patch.yml#L54-L65) 的规划规则仅属于其 plan 模式；没有复制 DSH `exit_plan_mode` 协议。
- 不重复承诺而应在允许执行时推进、保留用户其他改动、失败后重新核对、聚焦验证、如实汇报和适时停止，是本插件的 PI 工程适配，不声称逐字出自 DSH 通用系统提示。DSH 仓库 [AGENTS.md L113–120](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/AGENTS.md#L113-L120) 也有证据匹配的工程约定，但这是其仓库贡献指南而非模型专属运行时规则。

## 没有复制什么

[system-prompt registry](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/system-prompt/src/index.ts#L431-L460) 默认 persona 前后缀为空，注入 DSH 身份，再组合各插件提供的工具/模式指导。核对范围内没有找到单独的 DeepSeek-only 行为增强系统提示。

真正模型/连接特有的内容在 [llm-deepseek](https://github.com/deepseek-ai/DeepSeek-Harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek)：`src/models.ts:6–20` 当前模型目录包括 `deepseek-flash` / `deepseek-v4-pro`，`src/serialize.ts:147–158` 处理 thinking/output_config；模型更新策略和 Messages 序列化是 provider 工程，不是提示词。0.1.0 未适配协议；0.2.0 针对官方 Messages 的明确模型/路由加入有限缓存投影和 effort 映射，详见下一节。仍不修改 endpoint、token、temperature、thinking 签名，也不复制 DSH goal 阻塞轮数、网页身份、UI 热更新指令等专有行为。

## 0.2.0 Messages 请求适配

网友 @xzensh 的三项摘要作为核对线索；最终实现依据同一官方提交而不是帖子保证。

- [serialize.ts](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/serialize.ts#L60-L165)：完整 system 快照在 user/tool-result 后投影；tool_addition 引用和 defer_loading；effort low/high/max，off 序列化 disabled。DSH 自身持久化了中立历史，本插件仅能维护会话内的原始请求→wire 投影，恢复后重新建基线，不声称同等持久化/分叉能力。
- [models.ts](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/models.ts)：仅默认 deepseek-flash 声明 systemPromptUpdate in-history 和 toolUpdate addition-only，Pro 不声明。插件不推测其他模型能力。
- [messages-api.ts](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/messages-api.ts#L6-L7) 与 [adapter.ts](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/adapter.ts#L130-L145)：beta 为 mid-conversation-tool-changes-2026-07-01；DSH 按实际 blocks 加请求头。PI 的 header 钩子只在每轮 preflight 执行，故本插件仅在严格 Flash Messages 路由预加 beta，未经过 preflight 的 payload 禁止缓存投影。
- [dynamic-tool-cache.e2e.ts](https://github.com/deepseek-ai/DeepSeek-Harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts#L123-L153)：真实 provider 测试对比 cacheReadTokens、旧声明顺序、工具 delta 和缓存尾块容差。`packages/llm/llm-deepseek/tests/runtime.e2e.ts:357–443` 对完整 system 历史更新与重写头部做缓存比较。我们只读测试代码，没有调用实际 API 或复现命中率。
- `packages/web/web-search-deepseek/src/provider.ts:236` 搜索请求明确关闭 thinking；`packages/session/session-title-first-prompt-llm/src/index.ts:74–76` 标题选择路由最低可用 effort，不是所有模型一律关闭。宿主没有把可靠 auxiliary purpose 传给这里的 hook，插件不推测任务用途或全局降思考。

为保守兼容，本插件还要求精确官方 HTTPS Messages 路由、payload/model 一致，拒绝未知/原生工具格式、已有历史 system/工具 cache_control/延迟标记；删除或重定义工具、历史不延续及超出投影上限时回退。PI 用户思考等级到 low/high/max 是本地映射，不声称 DSH 对 PI 等级有官方定义。

## PI-Desktop 钩子依据

已只读核对本机 `D:/workspace/PI-Desktop` 0.17.0 源码：

- `packages/agent-runtime/src/extensions/runner.ts:552–565`：before_agent_start 的 systemPrompt 串联，保留前序结果；`:733–758` 的 context.model 实时读取；`:829–844` 的 pi.on 注册。
- `packages/agent-runtime/src/runtime.ts:8624–8641`：每轮新基础提示进入 hook，再设置返回的 systemPrompt。
- `packages/agent-runtime/src/extensions/prompt-chain.test.ts:31–71`：官方宿主测试验证提示每轮不累积。
- `docs/spec/07-plugins/16-trusted-extensions.md:40–82`：授权、作用域、市场限制和 manifest contribution。

普通沙箱 `pi.events.on` 不是可返回 systemPrompt 的拦截 API。本插件只贡献 trusted agent extension，不依赖普通沙箱 API。ctx.model 是会话 runtime 当前模型，不是任意内部 HTTP 请求的 model，因此不声称影响标题/摘要等所有辅助请求。

0.2.0 另核对 `runtime.ts:8627–8633,8658–8667`：headers 是逐轮 mutation，payload 钩子返回替换 body（不是 `{payload: ...}`）；未转发实际 payloadModel。`extensions/runner.ts` 的 pi.getThinkingLevel 可读所选等级，model.baseUrl/api 在 `provider-binding.ts:395–410` 提供。`transcript-compat.ts` 与 `fixed-tool-declarations.ts` 为宿主已有原生历史/工具权限管理，本插件不改 compat 并避让已原生处理的路由。
