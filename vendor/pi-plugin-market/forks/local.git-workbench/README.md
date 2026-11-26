# Git Workbench

PI-Desktop 工作面板里的 Git 客户端：看改动、暂存/放弃、写或生成提交信息、提交、拉取、推送，都在右侧面板完成；面板底部还有可折叠的提交历史，点开任一条即可看到它的属性、改动文件与差异。不打开终端，也不离开应用。

- 插件 ID：`local.git-workbench`（`local.` 为本地/私有命名空间；如需强调归属可改成反向域形式，例如 `io.github.<user>.git-workbench`）
- 版本：`0.2.0`　最低宿主版本：PI-Desktop `>=0.8.0`（`manifest.engines.piDesktop`）
- 类型：工作面板视图（`ui.view`），无 Agent 工具、无设置项、无常驻后台服务
- 许可证：[MIT](LICENSE)　变更日志：[CHANGELOG.md](CHANGELOG.md)

## 推送前的确认

刚加好远端、第一次推送时，git 往往会直接失败：`fatal: The current branch main has no upstream branch.` 或 `Host key verification failed.`。面板把这两步变成显式确认，而不是让用户去终端补命令：

1. 点「推送」或执行 `git-workbench.push` 时先跑预检：读当前分支、上游、ahead/behind、所有远端（地址已脱敏）与 SSH 主机指纹状态。
2. 只有**需要确认**时才弹窗：当前分支没有上游（或上游已被删除）、主机密钥不在 `known_hosts`、或无法检查主机密钥。已关联上游且主机可信时保持零摩擦，直接推送。
3. 弹窗里可以改远端（下拉列出全部远端及其地址）、改远端分支名，并逐条勾选要信任的主机指纹（默认全选，可取消）；主机名、端口、密钥类型与完整指纹都原样展示，方便与托管方公布的指纹逐字核对。
4. 确认后先写入指纹（仅勾选的、且与重新扫描结果一致的那几条），再执行 `git push <remote> <branch>`；需要建立上游时加 `--set-upstream`，远端分支名与本地不同时用 `local:remote` refspec。
5. 推送仍失败时，面板按 git 的错误分类给出可操作提示：`HOST_KEY_UNKNOWN`、`HOST_KEY_CHANGED`、`AUTH_FAILED`、`NO_UPSTREAM`、`NON_FAST_FORWARD`、`REPO_NOT_FOUND`、`NETWORK` 等，其余归为通用失败并保留原始 stderr 摘要。
## 功能

| 区域 | 能力 |
| --- | --- |
| 顶栏 | 当前分支、仓库名、`↑ahead ↓behind`，右侧依次是拉取、推送、刷新三个图标按钮 |
| 提交框 | 提交信息（`⌘/Ctrl + Enter` 提交，随内容自动增高到 8 行）、右上角 AI 按钮用当前模型流式生成提交信息、提交下拉菜单（仅暂存 / 全部更改 / 提交后推送 / `--signoff`） |
| 文件列表 | 「已暂存」与「更改」两组；分组标题右侧常驻图标（全部暂存 / 全部放弃 / 全部取消暂存，无文件时置灰不可点）；文件类型徽标、文件名 + 目录、状态字母（M/A/D/R/U）；行内悬停出现暂存、取消暂存、放弃更改 |
| 差异 | 点击文件在原位左右分栏：左侧保留面板内容，右侧显示该文件 diff（新增/删除/上下文/块头着色 + `+N −M` 统计），未跟踪文件同样可看；中间分隔条可拖拽调整宽度，双击恢复一半，聚焦后方向键微调、`Esc` 或 ✕ 关闭 |
| 提交历史 | 文件列表下方的可折叠区域：短哈希 + 说明 + 作者 · 相对时间；展开某条即在下方显示属性表（完整哈希、作者、作者时间、提交时间、父提交、说明正文）和该提交的改动文件，点文件看这份提交里的 diff；滚动到列表底部自动加载下一批（每次 30 条，最多 200 条），加载中底部固定显示「正在加载更多提交…」，也可用「⋯」手动加载，失败后点「⋯」重试 |
| 底部状态栏 | 暂存/未暂存计数、最近一次提交 |

提交语义：提交按钮只提交**已暂存**的改动；若没有任何已暂存改动则自动 `git add -A` 后再提交（与 VS Code 一致）。下拉菜单可强制指定。

## 命令

| 命令 ID | 标题 | 说明 |
| --- | --- | --- |
| `git-workbench.open` | Git Workbench: Open | 打开/聚焦右侧 Git 工作面板；插件激活时也会自动显示该视图 |
| `git-workbench.pull` | Git Workbench: Pull | 对当前仓库执行 `git pull --no-rebase --no-edit`，面板会同步刷新 |
| `git-workbench.push` | Git Workbench: Push | 需要确认（无上游 / 主机指纹未知）时提示到面板确认；否则直接推送 |

## 设置与工具

- **设置项**：无。插件不读写 `plugin.setSettings`。
- **Agent 工具**：无。插件不注册 `agentTools`，Agent 无法直接调用本插件。
- **输入/输出**：没有 CLI 参数、没有 stdin 协议、没有导出文件；面板与主进程之间只走下面「面板通道」里的固定通道。

## 权限

| 权限 | 风险级别 | 用途 | 数据流向 |
| --- | --- | --- | --- |
| `ui.view` | 低 | 声明并显示右侧工作面板视图、注册上面的三条命令 | 仅在本机渲染 |
| `models.list` | 低 | 列出用户已配置的可用模型，用于选择生成提交信息用的模型（默认模型优先） | 只读模型键，不含密钥 |
| `agent.complete` | 高 | 用户点击 AI 按钮时执行一次 `pi.agent.complete` 生成提交信息 | 只发送本次要提交的 diff、变更文件列表、diffstat 与最近 8 条提交标题；不读对话历史、不读文件正文以外的内容、不读凭据 |

`agent.complete` 是配额消耗型高风险权限，行为边界：

- 只在用户点击提交框右上角 AI 按钮时调用，不会自动触发；
- 每次点击只发一次请求，受宿主 90 秒预算与每分钟 8 次上限约束；
- 返回结果以流式写入提交信息框，用户继续编辑或直接改写都会覆盖它；
- 失败（超时、限流、模型不可用）只弹一条 toast，不重试、不循环。

## 外部服务与系统依赖

- **系统 git 可执行文件**：插件用 `spawn("git", [...])` 直接调用用户机器上的 git，没有内置 git 实现；git 不在 `PATH` 中时面板显示 `git 不可用` 类错误。
- **用户已配置的模型服务**：仅通过宿主的 `pi.agent.complete` 间接调用，插件自身不发起任何 HTTP/WebSocket 请求，也没有 `net.*` 权限。
- **远端仓库与凭据**：拉取/推送使用用户已有的 git remote 与 git 自身凭据（SSH key、credential helper）。插件不读取、不存储、不转发任何凭据，并把 `GIT_TERMINAL_PROMPT=0` 等变量设进子进程环境，避免卡在交互式输入。
- **OpenSSH 工具**：推送前的指纹确认调用系统的 `ssh`（解析 `ssh_config` 中的主机别名与端口）、`ssh-keyscan`（读取主机公钥）、`ssh-keygen -F`（查询 `known_hosts`）。缺失时面板降级为「无法检查主机指纹」，推送仍交给 git。用户在弹窗里确认后，插件把**被勾选的那几条**主机公钥追加进 `~/.ssh/known_hosts`（文件 0600、目录 0700），这是插件唯一写入的用户文件，且只发生在用户点「确认并推送」之后。
- 除上面两项外，插件不连接任何第三方服务，不上报任何数据。

## 主题适配

面板是独立文档，宿主**不会**把 `--ds-*` 设计令牌注入进来（只有 `--pi-plugin-titlebar-height` 与页面 locale/theme 启动参数），所以颜色由面板自己声明、自己跟随主题：

- `pluginBridge.invoke("app.getAppearance")` 返回 `{ theme, base, locale, pluginTheme }`：`base` 是 `light`/`dark`（面板据此切 `:root[data-base]` 调色板），`pluginTheme` 在使用插件主题时带 `{ id, base, css }`。
- `appearance:changed` 事件在切换主题/系统外观时推送新的 appearance，面板实时重算。
- `pluginTheme.css` 里的 `--ds-*` 按族映射进面板变量：`bg-primary/secondary/tertiary/inset` → `--bg/--bg-soft/--surface/--field`，`text-primary/muted/faint` → `--fg/--muted/--muted-dim`，`border-default/subtle` → `--border/--border-soft`，`success/error/warning` → `--add/--del/--mod`（`--add-bg/--del-bg` 由 `color-mix` 从状态色派生）。映射表见 `renderer/panel.js` 的 `THEME_TOKENS`。
- `--accent` 有守卫：宿主的 accent 在 dark 是纯白、light 是墨黑，会让高亮变成中性色，所以只有带色相的 accent 才覆盖，否则保留面板内置的蓝（dark `#4a9eff` / light `#0a66c2`）。
- 调色板默认值就是宿主暗/浅主题的真实取值，不装插件主题时与客户端一致。整行贴边、0 圆角；圆角只留给控件（`--radius-sm` 8 / `--radius` 11 / `--radius-pill`，`--radius-lg` 16 仅确认对话框）。

## 多语言

插件不自己保存语言，而是跟随宿主设置：面板通过 `app.getAppearance().locale` 取语言（主进程侧对应 `pi.app.getLocale()`），并用 `appearance:changed` 跟随切换。

- 判定规则：`locale` 以 `zh` 开头 → 中文；其余（`en-US`、`ja-JP`、`fr` …）→ 英文，不会中英混排。
- 文案集中在 `renderer/panel.js` 的 `STRINGS`（`zh` / `en` 两份，键同名，`{0}`/`{1}` 为占位符），取用统一走 `t("key", ...)`；静态标记用 `data-i18n` / `data-i18n-title` / `data-i18n-aria` / `data-i18n-placeholder` 挂接。
- 相对时间由 `Intl.RelativeTimeFormat` 按 `zh-CN` / `en` 生成；主进程侧文案在 `main.js` 的 `TEXT`，命令名用 `title(en, zh)`。
- `manifest.json` 的 `i18n` 提供中英文名称与描述，插件中心据此显示两种语言的条目。

## 面板通道（`onPanelInvoke`）

| 通道 | 说明 |
| --- | --- |
| `git.state` | 仓库、分支、ahead/behind、两组文件、计数、最近提交 |
| `git.diff` | `{ path, staged }` → 该文件的 unified diff（未跟踪文件用 `git diff --no-index`） |
| `git.log` | `{ limit? }` → 最近提交（1–200 条，默认 30）：完整/短哈希、说明、正文（截断 2000 字）、作者与提交时间、父提交 |
| `git.commitFiles` | `{ sha }` → 该提交的改动文件与状态字母（含重命名原路径） |
| `git.commitDiff` | `{ sha, path }` → 该提交中这个文件的 diff |
| `git.stage` / `git.unstage` | `{ paths }` |
| `git.stageAll` / `git.unstageAll` | 全部暂存 / 全部取消暂存 |
| `git.discard` | `{ paths }`：已跟踪文件 `git restore`，未跟踪或新加文件 `git clean` |
| `git.commit` | `{ message, stageAll?, push?, signOff?, amend? }`，信息经 stdin 传给 `git commit -F -` |
| `git.pull` | `git pull --no-rebase --no-edit` |
| `git.push` | `{ remote?, branch?, setUpstream? }` → 按确认结果推送（不同远端分支名用 `local:remote` refspec）；不带参数时保持旧行为：有上游 `git push`，否则 `git push -u <remote> <branch>` |
| `git.pushPreflight` | 无参数 → `{ branch, upstream, needsUpstream, remote, remoteBranch, remoteUrl, remotes }` 与 ssh 检查结果 `{ supported, known, host, port, knownHostsFile, keys[] }`；远端地址中的 userinfo 已脱敏 |
| `git.trustSshHost` | `{ remote, fingerprints[] }` → 重扫主机公钥，只写入与这些 `SHA256:` 指纹匹配的键；指纹对不上返回 `HOST_KEY_CHANGED`，不写入任何内容 |
| `git.generateMessage` | 用默认模型生成提交信息 |

## 安全设计

- 所有 git 调用都是 `spawn("git", ["-c", "core.quotePath=false", "-C", root, ...args])` 的**参数数组**，从不拼接 shell 字符串；`core.quotePath=false` 保证中文等非 ASCII 路径按 UTF-8 输出，解析时再把 git 加的双引号/C 转义还原成真实文件名。
- 路径必须是仓库相对路径（拒绝绝对路径与 `..`），分支名按 git 引用规则校验。
- 仓库根始终由当前工作区经 `git rev-parse --show-toplevel` 解析，插件不会对用户未打开的目录执行 git。
- 设置 `GIT_TERMINAL_PROMPT=0`、`GIT_EDITOR=true`、`GIT_MERGE_AUTOEDIT=no`，避免插件进程卡在凭据输入或编辑器上。
- 放弃更改是不可撤销操作，面板内先弹确认，且冲突文件不提供放弃入口。
- 提交历史只读：`git log` / `git show` 不接受任何写操作；提交 ID 按 `[0-9a-f]{7,40}` 校验，查看某提交里的文件 diff 时路径仍走仓库相对路径校验。
- 主机指纹先展示后写入：`git.pushPreflight` 只读取并计算 `SHA256:` 指纹，弹窗把主机、端口、密钥类型与完整指纹一起列出，用户逐条勾选后才调 `git.trustSshHost`；该通道会重新扫描一次，只写入与确认过的指纹**完全一致**的键，展示与重扫不一致时整批拒绝。插件不读取私钥，也不改 `~/.ssh` 下的其它文件。

## 安装

插件中心安装：在 PI-Desktop「插件」页搜索 Git Workbench 并安装，然后审核上面三项权限。

本地安装包：用「插件 → 右上角菜单 → 安装插件包」选择 `dist/local.git-workbench-<version>.piplug`。

## 开发

插件目录即源码，可直接在 PI-Desktop「插件 → 加载开发插件」中选中本目录，保存后热重载（改 `permissions` 或 `manifest.fs` 除外，需在插件行「更多 → 重新加载」里重新授权）。

```
manifest.json          # 身份、视图/命令贡献、权限、i18n
main.js                # 生命周期、onPanelInvoke 通道、LLM 提交信息
git.js                 # git 执行层与 porcelain 解析器
ssh.js                 # SSH 远端解析、known_hosts 查询、主机指纹扫描与信任写入
renderer/index.html    # 视图页面
renderer/panel.css     # 主题变量与布局
renderer/panel.js      # 交互逻辑、i18n、历史与 diff
```

## 检查与打包

只使用宿主提供的工具链，不要用 `zip`/`tar` 手工打包（安装器只接受 store-only 的 `.piplug`）：

1. `PluginCheck` —— 校验 manifest、引用文件、权限、路径越界、包大小；必须 0 error。已知非阻塞警告：`agent.complete` 为高风险权限，文案见上文「权限」。
2. `PluginPack` —— 生成 `dist/local.git-workbench-<version>.piplug` 并给出 SHA-256；打包产物需在干净的客户端状态下安装、启用、禁用、卸载各验一遍。
3. 发布 —— 走插件中心 plugins.aiuo.net：创建插件 → 绑定源码仓库 → 给版本打 tag → 提交该版本；平台重新解析来源、复核 SHA-256 后发布。
