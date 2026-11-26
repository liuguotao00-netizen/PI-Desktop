# Plugins with no public source repository

8 of 130 catalog entries publish only a compiled `.piplug` artifact.

| plugin | version | trust | permissions | description |
| --- | --- | --- | --- | --- |
| `adoin.deepseek-harness` | 0.2.0 | community | agent.extension | 让DeepSeek的模型在pi-desktop上使用更接近dsh：提示词优化、请求协议、缓存和推理参数优化。 |
| `com.github.yy568821795-max.session-recorder` | 0.3.0 | community | agent.tool.register, background.service, desktop.control, ui.panel | Local session recorder: archiving every conversation and tool call into per-session JSONL files, marking gaps and truncation, and exporting JSONL or Markdown. Data stays on this... |
| `local.mac-file-open` | 1.0.0 | community | clipboard.write, renderer.extension | macOS 专用本地文件链接右键菜单增强：支持在 Finder 中显示、使用默认应用打开、选择系统关联应用（打开方式）、应用内预览及复制完整或相对路径。仅支持 macOS，目前内置原生助手仅编译了 Apple Silicon (arm64) 版本。 |
| `local.next-reply` | 1.0.0 | community | agent.complete, composer.suggest, models.list, renderer.extension | 回答结束后基于近期对话智能推荐用户的下一句回复，支持 Tab 填入可编辑草稿、Esc 忽略或通过命令手动生成，完全独立运行，无需文件打开组件。 |
| `local.pi-canvas` | 0.1.5 | community | agent.prompt.inject, agent.tool.register, clipboard.write, fs.read, ui.view | Right-side local Canvas for PI-Desktop with isolated React views, versioned source and persistent state. |
| `local.remote-tools` | 0.1.0 | community | agent.extension | SSH 远程读取、写入、编辑与命令执行；适配 @oresk/pi-remote-tools。需要已配置的密钥和可信主机。 |
| `local.task-board` | 0.3.9 | community | desktop.control, notify, ui.panel, ui.view | 一个只读任务看板：一屏看清谁在等你批计划或回答、谁在跑、有哪些待审批、谁刚跑完。侧栏四列 + 置顶浮窗两种形态，刷新按活跃度自适应，会话清单缓存复用。点行直达会话，双击唤起主窗。全程只读，不读正文、不写文件、不联网。 alt+space搜索任务看板，点击后可以呼出悬浮面板，默认置顶。 |
| `pi.agents-anywhere` | 1.0.3 | community | desktop.control, net.fetch, net.websocket, ui.view | 基于 Agents Anywhere 平台实现手机端对 Pi Desktop 的远程查看、发问与控制。 |
