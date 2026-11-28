# 下一句推荐 / Next Reply Suggestion

在每轮回答结束后，基于当前已加载会话的近期消息（最多 12 条、12,000 字符），调用当前会话模型（或插件设置中指定的 `modelKey`）预测用户下一步可能输入的回复，并显示在输入框中。

- **Tab**：将推荐内容填入输入框作为可编辑草稿（不会自动发送）
- **Esc**：忽略并清除当前推荐
- **手动触发**：命令面板执行「生成下一句建议」
- **完全独立**：仅包含下一句推荐逻辑，不依赖任何本地文件打开组件或平台原生二进制，跨平台通用。

## English

After each assistant turn, predicts a natural next user reply from recent visible conversation context (up to 12 messages and 12,000 characters) using the active session model or a configured `modelKey`.

- **Tab**: Insert the suggestion into the composer as an editable draft (never auto-sent)
- **Esc**: Dismiss the suggestion
- **Manual command**: Run `生成下一句建议` from the command palette
- **Standalone**: Pure reply suggestion plugin with no file-opening dependency or platform-specific binary.
