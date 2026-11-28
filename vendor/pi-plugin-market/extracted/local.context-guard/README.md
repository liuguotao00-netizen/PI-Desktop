# 上下文管家 · Pi Desktop

轻量可信扩展：移植 pi-better-auto-compact 的“双阈值取低、保留原生兜底”思路，并加入可恢复、分批的请求上下文折叠。不修改 Pi 安装文件、provider 元数据或完整会话。

## 默认行为

- 原生压缩请求阈值：`min(160000 tokens, Desktop 安全窗口 × 70%)`。Desktop 返回的是扣除预留后的安全窗口，不能与 CLI 的原始窗口混用。
- 从该阈值的 50% 开始折叠；下一批至少增长 16000 tokens 才触发，已有折叠保持稳定。改变历史会使缓存后缀重建，因此不会每轮重新裁剪。
- 完整保留用户消息、助手正文/结论、工具调用 ID/参数；保留最近 12 条消息、至少最近 6 个工具结果。错误输出和原文检索结果不折叠。
- 工具结果至少经过一次 `context` 投影才允许折叠。仅折叠不少于 2000 字符的旧结果和未签名思考。带 `signature`、`thinkingSignature`、加密/遮蔽的思考保持原样；不破坏 Gemini/Claude 校验。
- 先成功落盘再替换成检索标记；磁盘错误或单条归档超过 16MiB 时保留原文。全部折叠规则均为确定性规则，不额外调用模型。
- 压缩由 Pi 原生逻辑和原模型完成。插件只排队请求，在下一安全模型边界消费；不等待 CLI 风格回调、不伪称已完成。失败后暂停自动重试，等待手动 retry；成功后仍有 180 秒冷却。
- Desktop 原生压缩需保持开启。插件不覆盖它。达到原生 90% 安全窗口阈值时交回原生处理。

## 安装与权限

这是 `agent.extension` 可信扩展，运行在 Agent sidecar，具有 Node 权限，不是受限 UI 插件。安装/加载须确认权限。源码不主动联网，只读写本地配置和归档。通过 Desktop 的“导入 Pi 扩展”选择 `extension.mjs`，或在支持的版本中导入 `.piplug`。可信扩展的市场分发依宿主签名策略而定，打包成功不等于市场上架通过。

当前有任务运行时，不应强制重启或重新加载所有任务；先完成正在进行的任务再加载。

## 使用

- `/context-guard status`：当前开关、折叠数、移出字符数（估算量，不是计费 tokens）、压缩请求/失败状态、配置路径。
- `/context-guard off` / `on`：持久开关；关闭后原始会话重新正常投影。
- `/context-guard reload`：修改设置后重新读取；也会清空该运行实例的折叠计划，下一次重新评估。
- `/context-guard retry`：解除压缩失败保护；不强制立刻压缩。
- Agent 看到折叠标记后可使用 `context_guard_recall`，传 ref、offset、limit，按页找回**同一会话**原文。单页不超过 12000 字符；图片仅返回类型提示，需要重新调用原图片工具查看，避免重新注入大图。

本机设置：`~/.pi-desktop/plugin-data/local.context-guard/settings.json`。可调 `usedTokensThreshold` 和 `percentThreshold` 等。非法配置值回退默认，JSON 损坏时禁用该运行实例，不悄悄应用意外值。环境变量 `PI_CONTEXT_GUARD_DIR` 可指定私有目录，测试使用隔离临时目录。

归档：同目录 `archive/<session-sha256>/<content-ref>.json`。目录 0700，文件 0600；可能包含敏感工具结果和图片，不上传云端。无自动删除，关闭/卸载不删归档。单条上限不是整个磁盘配额；总体积会随被折叠内容累计。

## 边界

- 提前压缩依据 Desktop 的原始用量估算，不冒充投影后的实际 token 计数；所以折叠有效时仍可能保守地请求原生摘要。
- `context` 只改变本次发给模型的视图；本地历史和运行时原始消息还在，插件不承诺降低 Pi 的全部内存占用。
- 不自动判定用户指令过时，不进行语义去重，也不保证任意模型不会超限。单条巨型用户输入、模型元数据错误、上游排队/限流仍可导致错误或慢请求。
- 归档不是语义摘要；模型需要时须实际检索证据。native compact 以后原始完整会话仍在，但摘要是否保留所有归档 ref 取决于宿主；不会额外注入无限增长的索引。
- 不建议和其他改写 context/控制 compact 的扩展叠加。Desktop 当前 context hook 的多个返回值可能互相覆盖。

## 开发与验证

`npm ci --ignore-scripts && npm run build && npm test`。无运行时 npm 依赖；build 使用 esbuild，宿主提供 TypeBox。`test/host.integration.test.ts` 使用本机 Desktop 源码工作树验证实际加载器、清单、投影、原文分页及压缩事件，不能等同真实模型性能验收。

## 来源

- [fishcat37/pi-better-auto-compact](https://github.com/fishcat37/pi-better-auto-compact)：双阈值与原生兜底思路，MIT；Desktop 的队列/事件机制重新实现，不照搬 CLI SettingsManager、完成回调或 TUI。
- [Middlewatch/context-fold](https://github.com/Middlewatch/context-fold)：可恢复折叠及批量更新的设计参考；本插件折叠算法独立实现，未引入其完整机制。
