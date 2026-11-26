# 发布到 PI-Desktop 插件市场（plugins.aiuo.net）

本目录已准备好的发布材料：

- `dist/pi.terminal-0.2.2.piplug` — 待上传的安装包（版本号 0.2.2 从 manifest 读取）
- git 仓库已初始化，tag `v0.2.2` 已打在当前提交上

## 步骤

### 1. 推送源码到 GitHub

市场要求绑定源码仓库（用于 provenance 与审计）：
```bash
cd /Users/wnjie/Workspace/py/pi-terminal
git push -u origin main
git push origin v0.2.2
```

仓库：<https://github.com/WnJee/pi-desktop-plugin-terminal>（由 `gh` 创建并推送）

### 2. 注册 / 登录开发者控制台

打开 <https://plugins.aiuo.net>，用 GitHub / Gitee / CNB 任一方式登录
（浏览和下载不需要账号，发布需要）。

### 3. 控制台创建插件并上传

进入 **控制台 → 创建插件**：

- 上传 `dist/pi.terminal-0.2.2.piplug`（版本号从包内读取，不可手填；
  同一版本号不能重复上传，改版要先把 manifest 里的 `version` 升上去重新打包）
- 绑定已授权的源码仓库，填源码 tag：`v0.2.2`
- 更新说明（可直接粘贴）：

```
首个上架版本。

- 多终端标签：面板内可开多个独立 shell 会话（最多 8 个），关掉面板会话继续运行
- 每个 shell 可选：自动探测系统已装的 zsh / bash / sh / fish（含 Homebrew 路径），
  无效路径自动回退登录 shell
- 真 PTY：插件自带零依赖 python 桥（pty.fork + fd3 resize 控制通道），
  vim / htop 等 TUI 程序可用，面板尺寸变化自动重排
- 输出经仅回环 SSE 推送（token 门禁 + 按游标续传），被环境拦截时自动退回轮询
- Finder 启动的 GUI 应用 PATH 很短，插件为 shell 前置 /opt/homebrew/bin 与
  /usr/local/bin，Homebrew 工具直接可用
- 工作目录即当前打开的项目根目录
```

### 4. 等待审核

提交后进入审核队列，结果会发到站内通知。审核通过后插件会出现在
市场目录（`catalog.json`），PI-Desktop 插件页即可搜到并安装。

## 以后发新版本

1. 改代码，升 `manifest.json` 里的 `version`
2. 本地校验 + 打包（或让仓库维护者跑）：`npx pi-plugin check . && npx pi-plugin pack .`
3. git commit + 打新 tag（如 `v0.3.0`）并推送
4. 控制台「发布新版本」上传新 `.piplug`，填新 tag 与更新说明
```
