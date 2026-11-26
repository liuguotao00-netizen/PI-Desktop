# 终端（pi.terminal）

在 PI-Desktop 右侧工作面板里打开**当前项目**的本地终端：点侧边栏「新建 → 终端」即得，
工作目录就是打开的项目根目录。

- **多终端标签**：工具栏「新终端」（＋）开新标签，每个标签一个独立 shell 会话，
  关掉面板 shell 继续跑，标签上的圆点标示会话是否退出。
- **shell 随便选**：工具栏右侧下拉框列出系统里探测到的 shell（zsh / bash / sh /
  fish……含 Homebrew 路径），新标签与「重启」都用选中的 shell。
- 完整 ANSI 颜色与 TUI 支持（vim、htop 等），中文输入、Cmd+C 复制选中 / Cmd+V 粘贴、
  面板尺寸变化自动重排（TUI 跟随 SIGWINCH）。
- Finder/GUI 启动的应用 PATH 很短，插件给 shell 子进程前置了
  `/opt/homebrew/bin` 与 `/usr/local/bin`，Homebrew 装的工具直接可用。

## 使用

1. PI-Desktop → 设置 → 插件 → 从文件安装（或开发模式加载本目录）。
2. 侧边栏「新建」菜单 →「终端」。
3. 工具栏：新终端 / 重启当前标签 / 清屏；下拉框选 shell；标签栏切换与关闭。

## 结构

```
manifest.json          视图声明（contributes.views）与权限
main.js                插件主进程：多会话管理 + 本地 SSE 输出流服务
bin/pty-bridge.py      PTY 桥（python3 pty.fork，含 fd3 resize 控制通道）
renderer/index.html    面板（内嵌 vendored xterm.js 6.0.0 + addon-fit 0.11.0，均 MIT）
```

## 工作原理（为什么是这样）

- **PTY**：插件包零 npm 依赖，宿主进程没有控制终端（macOS 的 `script(1)` 在此直接
  失败），所以用系统 python3 跑 `bin/pty-bridge.py`：`pty.fork()` 后 `exec <shell> -il`，
  stdin → pty、pty → stdout，fd3 收 `resize COLS ROWS` 控制命令（ioctl TIOCSWINSZ，
  内核自动向前台进程组发 SIGWINCH）。找不到 python3 时退化为管道直连（无回显、无
  TUI，仅应急；macOS 装了 Xcode CLT 就有 python3）。
- **输出流**：宿主没有「插件 → 面板」的推送通道，所以插件在 `127.0.0.1` 随机端口起
  SSE 服务（带 `Access-Control-Allow-Origin: *`，面板页是 origin 为 null 的 file://
  沙箱），每条标签一条流（断线按 cursor 续传，缓冲每会话 2 MiB）；SSE 被环境拦下时
  自动退回 200ms 轮询。输入/resize/新建/关闭/重启走 `bridge.invoke`（term.* 通道）。
- **安全**：SSE 每个请求必须带随机 token（仅经宿主桥交给本插件视图），远端必须回环；
  外部传入的 shell 路径必须真实存在且可执行；插件不声明任何 fs 权限。

## 通道一览（onPanelInvoke，全部带 `sid`）

| 通道 | 说明 |
| --- | --- |
| `term.hello` | 端口/token + 现存会话列表 + 可用 shell 列表；没有会话时建第一个 |
| `term.new` | 新建会话（新标签），可指定 shell |
| `term.close` | 结束并移除会话 |
| `term.input` | 键入（≤64 KiB/次） |
| `term.resize` | 面板尺寸变化 → fd3 控制命令 |
| `term.poll` | 轮询兜底（cursor 续传，≤256 KiB/次） |
| `term.restart` | 同一 sid 上换新 shell（标签身份不变） |

## 已知边界

- 多文件夹项目：会话起在主文件夹（`pi.workspace.get()` 的主根），需要别的子目录就 `cd`。
- 面板重开时重放输出缓冲（每会话 ≤2 MiB），更早的历史在 xterm 的 5000 行 scrollback 里。
- 插件重载 / 应用退出会结束所有 shell 会话。
- Windows 无 pty（管道降级）；以 macOS / Linux 为准。
