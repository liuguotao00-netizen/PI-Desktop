# 变更日志

本文件记录 Git Workbench 的用户可见变更，格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-02-24

推送不再因为「没有上游」或「主机密钥未确认」直接失败，改为在面板里确认后再推。

### 新增

- 推送预检：点「推送」先读当前分支、上游、ahead/behind、全部远端（地址已脱敏）与 SSH 主机指纹状态；只有需要确认时才弹窗，已关联上游且主机可信时仍是一键推送。
- 推送确认弹窗：可改远端（下拉列出全部远端及地址）、改远端分支名、查看 `本地分支 → 远端/分支`，并看到「是否设置上游」的说明；确认后按 `git push <remote> <branch>`（需要时 `--set-upstream`，远端分支名不同时用 `local:remote` refspec）执行。
- SSH 主机指纹确认：主机密钥不在 `known_hosts` 时，列出主机、端口、密钥类型与完整 `SHA256:` 指纹（默认全选、可逐条取消），用户核对后只把勾选且与重新扫描结果一致的键写入 `~/.ssh/known_hosts`（文件 0600、目录 0700）；扫描结果与展示不一致时整批拒绝，返回 `HOST_KEY_CHANGED`。
- 新的面板通道：`git.pushPreflight`、`git.trustSshHost`；`git.push` 接受 `{ remote, branch, setUpstream }`。
- 新增 `ssh.js`：远端 URL 解析（`ssh://`、`git+ssh://`、scp 风格）、`ssh -G` 解析主机别名/端口、`ssh-keygen -F` 查询 `known_hosts`、`ssh-keyscan` 读键、自算指纹与信任写入。

### 改进

- git 失败按 stderr 分类：`HOST_KEY_UNKNOWN`、`HOST_KEY_CHANGED`、`AUTH_FAILED`、`NO_UPSTREAM`、`NON_FAST_FORWARD`、`REPO_NOT_FOUND`、`NETWORK`、`GIT_FAILED`，面板据此给出可操作提示，不再只显示一段英文 fatal。
- 「提交后立即推送」失败时提交仍然保留：面板单独报推送错误（`pushError`），不再把整个提交动作报成失败。
- 命令面板的 `git-workbench.push` 在需要确认时提示并打开面板，不再直接抛出 git 错误。

### 安全

- 指纹先展示后写入，写入走独立通道并重新扫描比对；插件不读私钥、不改 `~/.ssh` 下其它文件。
- 新增的 `ssh` / `ssh-keygen` / `ssh-keyscan` 调用同样使用参数数组，不经 shell；主机名与端口来自远端 URL 并做字符校验。

## [0.1.0] - 2026-02-24

首个公开版本。
### 新增

- 右侧 Git 工作面板：当前分支、仓库名、`↑ahead ↓behind`，顶栏内置拉取、推送、刷新。
- 提交框：手写提交信息（`⌘/Ctrl + Enter` 提交）、随内容自动增高；AI 按钮用已配置模型流式生成提交信息；提交下拉菜单支持「仅暂存 / 全部更改 / 提交后推送 / `--signoff`」。
- 文件列表：「已暂存」与「更改」两组，文件类型徽标、路径与状态字母（M/A/D/R/U）；行内暂存、取消暂存、放弃更改；分组标题右侧常驻「全部暂存 / 全部放弃 / 全部取消暂存」，无文件时置灰不可点。
- 左右分栏差异：点击文件在面板内右半屏查看该文件 diff（新增/删除/上下文/块头着色 + `+N −M` 统计），未跟踪文件同样可看；分隔条可拖拽、双击复位、方向键微调、`Esc` 或 ✕ 关闭。
- 提交历史：面板底部可折叠列表，显示短哈希、说明、作者与相对时间；展开可看属性表（完整哈希、作者、作者时间、提交时间、父提交、说明正文）与该提交的改动文件，点文件查看这份提交里的 diff；滚动到底部自动加载下一批（每次 30 条，上限 200 条），也可用「⋯」手动加载与失败重试。
- 底部状态栏：暂存/未暂存计数与最近一次提交。

### 支持

- 主题跟随：读取宿主 `app.getAppearance` 与 `appearance:changed`，把插件主题的 `--ds-*` 令牌映射进面板调色板；宿主 accent 为中性色时保留面板自带强调色。
- 中英双语：跟随宿主 locale（`zh*` 中文，其余英文），文案集中在 `renderer/panel.js` 的 `STRINGS`，相对时间用 `Intl.RelativeTimeFormat`。
- 非 ASCII 路径：git 以 `core.quotePath=false` 输出，解析时还原双引号与 C 转义，中文路径可正常展示与操作。

### 安全

- 所有 git 调用均为 `spawn("git", [...])` 参数数组，不经 shell；仓库根由当前工作区解析；路径校验仓库相对路径，提交 ID 按 `[0-9a-f]{7,40}` 校验。
- 子进程设置 `GIT_TERMINAL_PROMPT=0`、`GIT_EDITOR=true`、`GIT_MERGE_AUTOEDIT=no`，不会卡在凭据或编辑器交互；插件不读取、不存储任何凭据。
- AI 生成提交信息只在用户点击时触发一次，只发送本次要提交的 diff、变更文件列表与最近提交标题，不读对话历史。

[0.1.0]: https://plugins.aiuo.net/plugins/local.git-workbench
