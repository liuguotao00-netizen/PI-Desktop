# PI Computer Use

给 PI-Desktop 的 Linux 桌面 **computer use** 插件（`corripo.computer-use`）：把截屏、鼠标、键盘和窗口/会话探测做成 agent 可直接调用的工具，Wayland 与 X11 双后端，缺依赖时给出明确错误而不是静默失败。

[![version](https://img.shields.io/badge/version-0.1.2-blue)](https://github.com/ProgramerLiang/pi-computer-use/tree/v0.1.2)
[![platform](https://img.shields.io/badge/platform-Linux-lightgrey)](#后端与依赖)
[![plugin id](https://img.shields.io/badge/plugin%20id-corripo.computer--use-8A2BE2)](#安装)
[![PI-Desktop 插件中心](https://img.shields.io/badge/plugin%20center-install-2ea44f)](https://plugins.aiuo.net/plugins/corripo.computer-use)

> **安全提示：** 此插件可以控制桌面。工具只在 agent 显式调用时动作，但可能影响当前焦点窗口。启用前请评估风险；操作敏感会话时不要开放。

## 目录

- [安装](#安装)
- [能力总览](#能力总览)
- [后端与依赖](#后端与依赖)
- [重要行为](#重要行为)
- [错误码](#错误码)
- [开发](#开发)
- [已知限制](#已知限制)
- [社区](#社区)

## 安装

### 从 PI-Desktop 插件中心安装（推荐）

插件已上架 PI-Desktop 插件中心：

**<https://plugins.aiuo.net/plugins/corripo.computer-use>**

1. 打开上面的页面，或直接进 PI-Desktop 的 **Settings → Plugins** 搜索 `corripo.computer-use`。
2. 安装当前版本 **0.1.2**。
3. 批准 manifest 申请的权限 `agent.tool.register`（高权限，注册 agent 工具必须有它，需显式同意）。
4. 新开一个会话，让 agent 先调一次 `cu_screen_info` 确认环境，再动鼠标键盘。

插件 id 与版本以仓库内 [`manifest.json`](manifest.json) 为准；权限清单见同文件 `permissions` 字段。

### 从源码构建 `.piplug`

需要 Node.js（仓库无 npm 运行时依赖，也没有构建脚本，打包由 PI-Desktop 的插件工具完成）：

```bash
git clone git@github.com:ProgramerLiang/pi-computer-use.git
cd pi-computer-use
git checkout v0.1.2        # 或用 main
node --test test/          # 48 个离线单测，不需要真实桌面
```

然后在 **PI-Desktop 的 agent 会话里**（工作目录设为仓库根）依次调用插件工具：

```json
{ "tool": "PluginCheck", "args": { "directory": "." } }
```

```json
{ "tool": "PluginPack", "args": { "directory": "." } }
```

`PluginCheck` 通过时打印 `PluginCheck passed for corripo.computer-use: N file(s) would be packaged.`（只有 `[permission.high-risk]` 警告属预期）；`PluginPack` 成功后产出 `dist/corripo.computer-use-0.1.2.piplug`，并在返回里给出字节数、文件数与 sha256。随后在 PI-Desktop 的 **Settings → Plugins** 用本地插件包入口安装该 `.piplug`，同样需要批准 `agent.tool.register`。

> `PluginCheck` / `PluginPack` 的 `directory` 要传**相对于工作区的路径**（如 `.`），传绝对路径会被二次拼接而报 `manifest.json is missing`。

## 能力总览

8 个工具，全部以 `cu_` 前缀注册；参数与取值上限逐项对应 [`lib/tools.js`](lib/tools.js) 的 `TOOL_DEFS`。

| 工具 | 作用 | 关键参数 | risk |
| --- | --- | --- | --- |
| `cu_screenshot` | 截取整屏或指定区域，保存 PNG 并把图片内联回模型（默认内联，上限 6 MiB） | `path`、`label`、`inline`（默认 `true`）、`region{x,y,width,height}`（四项齐全，`x/y ≥ 0`，`width/height ≥ 1`） | low |
| `cu_mouse_move` | 把鼠标移到屏幕绝对坐标 | `x`、`y`（必填，非负整数） | medium |
| `cu_mouse_click` | 点击；可先移动到 `(x, y)` | `x`、`y`（可选）、`button`（`left`/`middle`/`right`，默认 `left`）、`count`（1–3，默认 1） | medium |
| `cu_mouse_scroll` | 滚轮滚动；Wayland 下明确不支持 | `direction`（`up`/`down`，必填）、`amount`（1–20，默认 1）、`x`、`y`（可选，滚动前先把指针移过去） | medium |
| `cu_type_text` | 向当前焦点窗口输入文本（不经过剪贴板） | `text`（必填，≤ 20000 字符）、`delayMs`（0–2000，X11 逐字符延时）、`allowImeSuspend`（默认 `false`，见[重要行为](#fcitx5-文本注入默认-fail-closed)） | medium |
| `cu_key_press` | 按键或组合键，一次可给多个 | `key`（如 `"ctrl+c"`）、`keys`（如 `["ctrl+a", "Delete"]`） | medium |
| `cu_screen_info` | 只读探测：会话类型、屏幕尺寸、可用截图/输入后端、依赖安装情况 | 无 | low |
| `cu_window_list` | 列出窗口标题与 id（X11 用 `wmctrl`/`xdotool`；Wayland 仅 niri） | 无 | low |

键名走 [`lib/keymap.js`](lib/keymap.js)：修饰键接受 `ctrl`/`control`、`shift`、`alt`/`option`、`super`/`meta`/`win`/`cmd`/`command`/`hyper`；主键覆盖字母、数字、`f1`–`f12`、方向键、`home`/`end`/`pageup`/`pagedown`/`insert`/`delete`、`enter`/`return`、`esc`/`escape`、`tab`、`space` 及常用符号名。无法识别的键名会返回明确错误，不会静默当作无操作。

坐标以屏幕左上角为原点、单位为逻辑像素；niri/Wayland 下区域参数原样传给 grim，grim 按合成器逻辑坐标裁切，PNG 按输出 scale 产生物理像素（例如 scale 1.25 时逻辑 320×180 输出 400×225）。不进行重采样；区域位置与逻辑边界由 grim 处理。X11 区域按根窗口像素坐标处理。

截图默认内联（上限 6 MiB）；只需路径时设置 `inline: false`。产物默认写入 `$TMPDIR/pi-computer-use/`，可用 `PI_COMPUTER_USE_DIR` 覆盖目录。

## 后端与依赖

### 会话探测

`cu_screen_info` 会报告 `sessionType`、`screen`、`screenshotBackend`、`inputBackend` 和各依赖是否安装。探测逻辑在 [`lib/session.js`](lib/session.js)：以 `XDG_SESSION_TYPE` 声明的类型优先（Wayland + XWayland 并存时按 Wayland 处理），缺 `WAYLAND_DISPLAY` 时从 `/run/user/<uid>/wayland-*` 选一个，缺 `DISPLAY` 时从 `/tmp/.X11-unix/X*` 选一个；niri 的 IPC socket 会自动补 `NIRI_SOCKET`。选后端在 [`lib/backends.js`](lib/backends.js)，按「会话类型 + 命令是否存在」决定，缺什么就直接报缺什么。

依赖按所需能力安装，不需要同时安装两套会话后端。截图裁剪由截图工具的区域参数完成，不依赖 ImageMagick。

| 依赖包/命令 | 用途 | 需要它的工具 | 必需/可选 |
| --- | --- | --- | --- |
| `grim` | Wayland 截图 | `cu_screenshot`、`cu_screen_info`（获取屏幕尺寸） | Wayland 必需 |
| `ydotool` + `ydotoold` | Wayland 鼠标和键盘注入 | `cu_mouse_move`、`cu_mouse_click`、`cu_key_press`、`cu_type_text` | 完整输入必需；守护进程必须运行 |
| `wtype` | Wayland 文本输入备选 | `cu_type_text` | 可选；仅打字，不能移动/点击/组合键 |
| `/dev/uinput` 可访问权限 | ydotoold 创建虚拟输入设备 | 所有 ydotool 输入工具 | 使用 ydotool 时必需 |
| `xdotool` | X11 鼠标、键盘和滚轮 | 移动、点击、滚动、打字、按键 | X11 必需 |
| `import`（ImageMagick）或 `scrot` | X11 截图 | `cu_screenshot`、`cu_screen_info`（获取屏幕尺寸） | X11 二选一必需 |
| `wmctrl` 或 `xdotool` | X11 窗口枚举 | `cu_window_list` | 可选 |
| `niri` CLI | niri 下窗口枚举 | `cu_window_list` | niri 可选 |

### 会话后端

| 会话 | 截图 | 鼠标/键盘 | 窗口枚举 |
| --- | --- | --- | --- |
| X11 | `import`（首选）或 `scrot` | `xdotool` | `wmctrl` 或 `xdotool` |
| Wayland | `grim`（wlroots 合成器，如 niri） | `ydotool` + `ydotoold`；只有文本输入时可用 `wtype` | 仅 niri 当前有专用实现；其它合成器通常不支持 |

### Arch Linux 安装

Wayland 完整输入与截图：

```bash
sudo pacman -S grim ydotool wtype wl-clipboard
```

`ydotoold` 与 unit 的名称随发行版/打包版本而异。先查看包文件清单和本机 unit：

```bash
pacman -Ql ydotool | grep -E 'systemd|ydotoold'
systemctl --user list-unit-files '*ydotool*' --no-pager
systemctl list-unit-files '*ydotool*' --no-pager
```

若本机确有系统级 `ydotool.service`，启用并启动：

```bash
sudo systemctl enable --now ydotool.service
systemctl status ydotool.service --no-pager
```

若 unit 不存在，可按发行版方式运行 `ydotoold`（本机实测为用户进程），并确认插件客户端连接同一 socket。检查：

```bash
ls -l "$XDG_RUNTIME_DIR/.ydotool_socket" /tmp/.ydotool_socket 2>/dev/null
```

服务默认 socket 权限可能只允许服务用户访问。确认 socket 在插件运行用户下可连；若系统服务以 root 运行，可通过 unit 覆盖设置 socket 路径和所有权，再让插件使用相同 socket。插件也识别 `$YDOTOOL_SOCKET`、`$XDG_RUNTIME_DIR/.ydotool_socket` 和 `/tmp/.ydotool_socket`。

X11：

```bash
sudo pacman -S xdotool imagemagick wmctrl
```

`wmctrl` 是可选的；没有它时 `xdotool` 可用于窗口枚举。若只需截图也可用 `scrot` 代替 ImageMagick。

### `/dev/uinput` 权限

检查设备权限和当前组：

```bash
ls -l /dev/uinput
groups
```

常见配置是设备属于 `input` 组。需要时将当前用户加入该组：

```bash
sudo usermod -aG input "$USER"
```

**组变更需注销并重新登录才会进入当前图形会话**；不应为此重启整机或图形会话。也可使用 udev 规则授予受控访问：

```bash
printf 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"\n' | sudo tee /etc/udev/rules.d/99-uinput.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=uinput
```

udev 规则仍需用户属于 `input` 组，并且通常也需重新登录。不要用 `chmod 666 /dev/uinput` 作为持久配置。

### 安装后自检

先用 `cu_screen_info` 查看 `sessionType`、`screen`、`screenshotBackend` 和 `inputBackend`。Wayland 可在终端检查：

```bash
pacman -Q grim ydotool wtype wl-clipboard
systemctl --user status ydotoold.service --no-pager 2>/dev/null || systemctl status ydotool.service --no-pager
ls -l /dev/uinput "$XDG_RUNTIME_DIR/.ydotool_socket"
```

## 重要行为

### fcitx5 文本注入默认 fail-closed

fcitx5 在运行时，`cu_type_text` 默认 fail-closed，返回 `input_blocked_by_ime`。调用方必须在该次工具调用中显式设置 `allowImeSuspend: true` 才会尝试暂停精确匹配的 `fcitx5` 主进程、输入文本并重启输入法；`cu_key_press` 始终保持拦截行为。

显式 opt-in 会短暂中断输入法，可能影响进行中的合成输入，并可能改变中英/输入法状态。调用成功会返回 `imeSuspended` / `imeRestored`；当前状态不可读取，因此不保证恢复到原中文态。若返回 `ime_restore_failed`，请立即运行 `fcitx5 -d --replace` 并核对进程恢复。

实现上的三道保险：只匹配名为 `fcitx5` 的主进程（不把 `fcitx5` backend 当主进程）；暂停后若主进程仍在运行，就不输入、直接返回 `input_blocked_by_ime`；重启后在默认 20 次 × 100 ms 的窗口内同时确认主进程与 backend 都已回来，否则报 `ime_restore_failed` 并在错误里带 `recoveryCommand`。

### 坐标与缩放

显示器物理尺寸 1920×1080、逻辑尺寸 1536×864、scale 1.25。修复前区域请求 320×180 被误作逻辑 320×180，PNG IHDR 为 400×225（等于逻辑尺寸再乘 1.25）。确认 grim `-g` 使用逻辑坐标后，修复为直接传逻辑区域；真实复测 320×180 输出 PNG 400×225。位置对照通过：整屏 PNG 中物理裁切 `(250,150)-(650,375)` 与区域 PNG 逐像素相同。

Wayland 高缩放下 PNG IHDR 是物理像素尺寸，不会等于逻辑请求尺寸；本插件不做重采样。输入坐标在屏幕尺寸已知时会先做范围校验（尺寸缓存 60 s），越界返回 `coordinate_out_of_bounds`。

### 安全语义

- 插件加载时不截图、不监听、不排队；只有显式调用 `cu_*` 工具时才动作。
- 不提权、不修改设备权限、不修改系统配置。
- 截图默认写入 `$TMPDIR/pi-computer-use/`，可用 `PI_COMPUTER_USE_DIR` 覆盖。
- 不联网、不引入 npm 运行时依赖。

## 错误码

缺依赖或能力不支持时返回 `{ ok: false, error: { code, message, hint } }`，不静默失败。常见错误码（实现见 [`lib/errors.js`](lib/errors.js)、[`lib/backends.js`](lib/backends.js)）：

| code | 含义与处理 |
| --- | --- |
| `no_graphical_session` | 当前是 tty/SSH，没有 X11 或 Wayland |
| `no_input_backend` | 缺 `ydotool` / `wtype` / `xdotool` |
| `no_screenshot_backend` | 缺 `grim`，或 X11 缺 `import`/`scrot` |
| `no_window_backend` | 当前合成器没有窗口枚举实现（Wayland 非 niri） |
| `ydotoold_not_running` | 找不到 ydotoold socket |
| `dependency_missing` | 底层命令根本不存在（`ENOENT`），通常是装了但不在 `PATH` |
| `command_failed` | 底层命令失败，消息包含 stderr 摘要 |
| `ime_restore_failed` | fcitx5 主进程/backend 未确认恢复；立即执行 `fcitx5 -d --replace` 并检查进程 |
| `input_blocked_by_ime` | fcitx5 正在运行且未显式允许暂停；可改用应用自身输入入口，或慎重 opt-in |
| `unsupported_on_backend` | 当前后端不支持该动作（Wayland 滚轮、wtype 组合键等） |
| `coordinate_out_of_bounds` | 坐标超出实际屏幕范围 |
| `invalid_coordinate` | 坐标不是非负整数，或只给了 x 没给 y |
| `invalid_argument` | 参数不合法（如 `text` 为空或超过 20000 字符） |
| `empty_capture` | 截图命令返回成功但没生成文件，通常是输出路径不可写 |
| `spawn_failed` | 无法启动子进程 |
| `unexpected` | 未归类的异常，`message` 为原始错误 |

### 故障排查

| 错误/症状 | 常见原因 | 处理方法 |
| --- | --- | --- |
| `no_input_backend` | 当前会话缺少对应输入命令，或图形会话未检测到 | Wayland 安装 `ydotool`（仅打字可用 `wtype`）；X11 安装 `xdotool`；用 `cu_screen_info` 核对会话 |
| `ydotoold_not_running` / socket not found | ydotoold 未运行，或 socket 不在默认路径 | 启动 `sudo systemctl enable --now ydotool.service`；检查 socket 并设置 `YDOTOOL_SOCKET` 指向实际路径 |
| `permission denied`（`/dev/uinput`） | ydotoold 进程没有 uinput 访问权限 | 检查 `/dev/uinput` 所属组和服务身份；配置 `input` 组/udev 权限，注销并重新登录后再验证 |
| `permission denied`（socket） | 插件用户无权连接 ydotoold socket | 检查 socket 的 owner/mode；用服务配置让 socket 对当前用户可访问，不要放宽到所有用户 |
| `no_screenshot_backend` | Wayland 缺 `grim`，或 X11 缺 `import`/`scrot` | 安装对应会话的截图依赖 |

## 开发

测试全部离线，不需要真实桌面（真实命令通过注入的 `which` / `run` 替身模拟）：

```bash
node --test test/     # 48 个离线单测
npm test              # 等价：package.json 里就是 node --test test/
```

目录：

```text
manifest.json     插件 id、版本、工具声明与权限
main.js           插件入口（注册工具、响应 activate）
lib/session.js    会话探测、命令查找与子进程执行
lib/backends.js   截图/输入后端选择与依赖缺失时的错误文案
lib/keymap.js     键名与 evdev/x11 映射
lib/actions.js    意图到命令参数的映射
lib/capture.js    截图、PNG 解析、区域裁剪与输出目录
lib/tools.js      TOOL_DEFS（schema）与各工具执行逻辑
lib/errors.js     统一错误形状（code/message/hint）
test/             actions / backends / keymap / tools 四组离线单测
dist/             打包产物（.piplug，已被 .gitignore 忽略）
```

## 已知限制

`ydotoold` 与 unit 的名称随发行版/打包版本而异；先检查包文件清单及本机 user/system unit。若本机存在系统级 `ydotool.service`，可用 `sudo systemctl enable --now ydotool.service` 启动；否则按发行版方式运行守护进程。本机实测为用户进程，socket 位于 `$XDG_RUNTIME_DIR/.ydotool_socket`。

- Wayland 下 ydotool 1.0.4 的 CLI 没有滚轮子命令；插件明确返回 `unsupported_on_backend`。X11 的 xdotool 滚轮可用。
- Wayland 协议没有通用窗口枚举接口。插件只对 niri 实现 `niri msg --json windows`；其它合成器返回 `no_window_backend`。
- `grim` 使用 wlroots screencopy 协议；非 wlroots 合成器可能不支持或行为不同，需使用该合成器支持的截图后端。
- 单显示器坐标按整屏绝对坐标处理；多显示器布局需自行换算偏移量。
- 插件不提供 OCR、元素定位或视觉理解；模型负责理解截图。
- 本文档的真机实测记录（区域截图与坐标对照、scale 1.25、ydotoold 为用户进程）来自 Wayland 会话；X11 分支只有离线单测覆盖，本文档没有对应的 X11 真机复测记录。

## 社区

本项目认可并感谢 [LINUX DO](https://linux.do) 社区。

相关链接：

- PI-Desktop 插件中心：<https://plugins.aiuo.net/plugins/corripo.computer-use>
- 源码仓库：<https://github.com/ProgramerLiang/pi-computer-use>
- 问题反馈：<https://github.com/ProgramerLiang/pi-computer-use/issues>
- 许可：[MIT](LICENSE)
