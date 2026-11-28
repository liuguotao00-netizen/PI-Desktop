# DeepSeek Harness 优化 · 0.2.0

PI-Desktop 的 DeepSeek 条件提示词与**限定路由的 Messages 协议适配**。默认 ID 为 `adoin.deepseek-harness`，由根命名空间配置生成。第三方插件，不是 DeepSeek 官方插件或完整 DSH runtime。

## 0.2.0 对应的三项优化

| 项目 | 实现范围 |
| --- | --- |
| 历史中追加完整 system | 仅精确 `deepseek-flash` + 官方 Anthropic Messages 路由；保持第一份顶层 system，在连续历史末尾的 user/tool-result 轮次之后追加完整的新提示快照，不发文本差分 |
| 新工具不重写旧声明前缀 | 同一路由，且仅普通工具纯新增；旧声明顺序稳定，新声明追加并带 `defer_loading: true`，历史追加 `tool_addition/tool_reference`。每轮预处理合并 `anthropic-beta: mid-conversation-tool-changes-2026-07-01`，保留已有 beta |
| 思考强度适配 | 精确 `deepseek-flash` 或 `deepseek-v4-pro` + 官方 Messages 路由；读取宿主所选 thinking level，映射为 DeepSeek 的 effort/disabled。不会猜测标题或搜索任务并统一关闭思考 |

协议路由必须同时满足 `ctx.model.api === anthropic-messages`，官方 HTTPS 主机 `api.deepseek.com`，baseUrl 路径 `/anthropic` 或 `/anthropic/v1`（可带末尾斜杠），无账号、查询、片段或非标准端口，请求 `payload.model` 与当前模型 ID 完全一致。其他服务商、网关、OpenAI Chat Completions/Responses、旧模型或自定义别名**不修改请求协议**。只有行为提示词仍按原有 DeepSeek 家族识别。

缓存是复用旧前缀的机会，不保证每次命中或省多少 token；需要真实 API 的 `cacheReadTokens` 等用量对照才能确认。没有把 OpenAI 格式转换成 Messages；使用普通 `/v1` 配置不会自动获得这里的协议优化。

### 安全回退和宿主原生能力

- PI-Desktop 已有 verified transcript 能力。如果模型声明原生 mid-conversation system/tool 支持，本插件不再管理其缓存历史，不修改 model compat，不绕过宿主工具激活/执行权限。
- 工具删除、改 schema/description、历史编辑/分叉/压缩或模型/端点切换，重新建立原请求基线，不保留撤销的工具或强行承诺缓存。新会话无历史投影；相同请求重试不重复插入消息。
- 缺少 system、无法解析的消息、已有 system 历史/原生 `defer_loading`、带工具 `cache_control`、服务端内置工具等不支持格式，放弃缓存投影，保留原有历史。支持文本 system 字符串或文本块数组。投影大小上限约 200 万字符，超过后回退原请求，避免会话内存无界增长。
- 工具 beta 在每轮 header 预处理发送；请求若没有经过对应路由的 header 预处理，不启用缓存投影。宿主按注册顺序处理其他扩展；后序插件若重写请求/请求头，可能改变最终结果，不承诺与任意请求重写插件自动合并。
- 不改 assistant thinking/signature、tool_use/tool_result 内容，不重排工具结果。原始持久化聊天不变；只在本会话内保存有限请求投影，shutdown 清理。恢复/重新打开会话重新建基线，不复用旧进程缓存。

### 思考强度

`off → thinking: disabled`；`minimal/low → output_config.effort: low`；`medium/high → high`；`xhigh/max → max`。启用时使用 `thinking: enabled`，替代 Anthropic 的 adaptive/budget 表达，保留 max_tokens 等其他请求字段。

已有合法 wire effort（low/high/max）或显式 `thinking: disabled` 优先保留；未知强度、未知 thinking 结构或非法已有 effort 不猜测转换。Pro 只参与 effort 适配，不启用 Flash 缓存能力。

宿主不会把辅助调用的可靠 purpose/请求目标模型完整传给该钩子。标题/搜索可能走独立 pipeline，所以**未实现“所有辅助任务关思考”**，也不会根据用户文字猜任务。主任务的推理强度由用户选择，不擅自降低。

## 保留的行为提示词

每轮 `before_agent_start` 读取实时模型 ID，向宿主系统提示追加一次 DSH-inspired 指导：专用文件工具、先读后改、检查退出状态、独立工作并行、收集后台结果、外部内容信任边界。PI 的模式、权限、工具 schema 和用户范围优先，不替换原有系统提示，不修改用户消息。

识别 ID 家族：`deepseek-chat/reasoner/flash`、`deepseek-v数字…`、`deepseek-r1…`、`deepseek-coder…`，大小写不敏感；路由 ID 取最后一段，如 `deepseek/deepseek-r1:free`。未知别名和含 `distill` 的模型不注入；供应商名/显示昵称不是模型证明。这项行为指导与上面的严格协议路由判定不同。

追加不足 3200 字符，会增加模型输入 token；没有发现官方独立的 DeepSeek-only 万能行为提示，也不声称单元测试证明模型能力提升。

## 安装和权限

安装 `.artifacts/releases/adoin.deepseek-harness-0.2.0.piplug`，或开发加载 `.artifacts/plugins/deepseek-harness/` 这个单插件运行目录。审核并授权 **agent.extension**，启用并设置项目作用域，重新打开会话以重建 runtime。停用并重新打开可恢复默认行为。

这是在 Agent sidecar 执行的高信任权限，不受普通插件沙箱隔离。代码无外部网络/磁盘访问、无 API Key 读取/遥测，不增加工具。请求只交回宿主，由宿主发送。PI-Desktop 0.17 源码规格允许本地包/开发加载；市场可能受签名和高信任权限限制，打包成功不等于可市场上架。

## 来源及测试

固定官方 DSH 提交 `687f282e8625c6b8d11ff58211a90524be2e4317`，MIT。逐条来源、宿主依据及边界见 [SOURCES.md](SOURCES.md)，许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。规则不联网自动更新，须核对发版。

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm run stage deepseek-harness
pnpm test:workspace
```

测试源码与最终 ESM 模块的模型隔离、原提示保留、system 快照、工具声明与 delta、重试、分叉/压缩/撤销回退、beta 合并、effort、会话隔离及 shutdown。属于基于宿主真实钩子契约的模拟测试；**未调用真实 DeepSeek API，没有测缓存命中或效果提升**。无 UI，browser 任务为空。官方 PluginCheck/PluginPack 后运行 `pnpm release:collect deepseek-harness`，产物仅在根 `.artifacts/`。
