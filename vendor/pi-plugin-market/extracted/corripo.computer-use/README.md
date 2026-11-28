# PI Computer Use

Linux 桌面的 **computer use** 插件，提供截屏、鼠标移动/点击/滚动、打字、按键、会话信息和窗口枚举工具。Wayland 使用 `grim` 与 `ydotool`（或仅打字时使用 `wtype`）；X11 使用 `import`/`scrot` 与 `xdotool`。

> **安全提示：** 此插件可以控制桌面。工具只在 agent 显式调用时动作，但可能影响当前焦点窗口。启用前请评估风险；操作敏感会话时不要开放。

## 工具

| 工具 | 作用 |
| --- | --- |
| `cu_screenshot` | 截取整屏或指定区域，保存 PNG 并可内联图片 |
| `cu_mouse_move` | 移动鼠标到屏幕绝对坐标 |
| `cu_mouse_click` | 左/中/右键单击、双击或三击 |
| `cu_mouse_scroll` | 滚轮（X11 支持；Wayland 当前明确返回不支持） |
| `cu_type_text` | 向当前焦点窗口输入文本 |
| `cu_key_press` | 按键或组合键 |
| `cu_screen_info` | 只读检查会话、屏幕尺寸和可用后端 |
| `cu_window_list` | 列出窗口（X11 或 niri） |

坐标以屏幕左上角为原点、单位为逻辑像素；niri/Wayland 下区域参数原样传给 grim，grim 按合成器逻辑坐标裁切，PNG 按输出 scale 产生物理像素（例如 scale 1.25 时逻辑 320×180 输出 400×225）。不进行重采样；区域位置与逻辑边界由 grim 处理。X11 区域按根窗口像素坐标处理。截图默认内联（上限 6 MiB）；只需路径时设置 `inline: false`。

## 依赖

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

fcitx5 在运行时，`cu_type_text` 默认 fail-closed，返回 `input_blocked_by_ime`。调用方必须在该次工具调用中显式设置 `allowImeSuspend: true` 才会尝试暂停精确匹配的 `fcitx5` 主进程、输入文本并重启输入法；`cu_key_press` 始终保持拦截行为。
显式 opt-in 会短暂中断输入法，可能影响进行中的合成输入，并可能改变中英/输入法状态。调用成功会返回 `imeSuspended` / `imeRestored`；当前状态不可读取，因此不保证恢复到原中文态。若返回 `ime_restore_failed`，请立即运行 `fcitx5 -d --replace` 并核对进程恢复。
显示器物理尺寸 1920×1080、逻辑尺寸 1536×864、scale 1.25。修复前区域请求 320×180 被误作逻辑 320×180，PNG IHDR 为 400×225（等于逻辑尺寸再乘 1.25）。确认 grim `-g` 使用逻辑坐标后，修复为直接传逻辑区域；真实复测 320×180 输出 PNG 400×225。位置对照通过：整屏 PNG 中物理裁切 `(250,150)-(650,375)` 与区域 PNG 逐像素相同。

Wayland 高缩放下 PNG IHDR 是物理像素尺寸，不会等于逻辑请求尺寸；本插件不做重采样。

### 故障排查

| 错误/症状 | 常见原因 | 处理方法 |
| --- | --- | --- |
| `no_input_backend` | 当前会话缺少对应输入命令，或图形会话未检测到 | Wayland 安装 `ydotool`（仅打字可用 `wtype`）；X11 安装 `xdotool`；用 `cu_screen_info` 核对会话 |
| `ydotoold_not_running` / socket not found | ydotoold 未运行，或 socket 不在默认路径 | 启动 `sudo systemctl enable --now ydotool.service`；检查 socket 并设置 `YDOTOOL_SOCKET` 指向实际路径 |
| `permission denied`（`/dev/uinput`） | ydotoold 进程没有 uinput 访问权限 | 检查 `/dev/uinput` 所属组和服务身份；配置 `input` 组/udev 权限，注销并重新登录后再验证 |
| `permission denied`（socket） | 插件用户无权连接 ydotoold socket | 检查 socket 的 owner/mode；用服务配置让 socket 对当前用户可访问，不要放宽到所有用户 |
| `no_screenshot_backend` | Wayland 缺 `grim`，或 X11 缺 `import`/`scrot` | 安装对应会话的截图依赖 |

## 错误约定

缺依赖或能力不支持时返回 `{ ok: false, error: { code, message, hint } }`，不静默失败。常见错误码：

| code | 含义与处理 |
| --- | --- |
| `no_graphical_session` | 当前是 tty/SSH，没有 X11 或 Wayland |
| `no_input_backend` | 缺 `ydotool` / `wtype` / `xdotool` |
| `ydotoold_not_running` | 找不到 ydotoold socket |
| `ime_restore_failed` | fcitx5 主进程/backend 未确认恢复；立即执行 `fcitx5 -d --replace` 并检查进程 |
| `input_blocked_by_ime` | fcitx5 正在运行且未显式允许暂停；可改用应用自身输入入口，或慎重 opt-in |
| `unsupported_on_backend` | 当前后端不支持该动作（Wayland 滚轮、wtype 组合键等） |
| `coordinate_out_of_bounds` | 坐标超出实际屏幕范围 |
| `command_failed` | 底层命令失败，消息包含 stderr 摘要 |
| `invalid_coordinate` | 坐标不是非负整数，或只给了 x 没给 y |

## 已知限制
`ydotoold` 与 unit 的名称随发行版/打包版本而异；先检查包文件清单及本机 user/system unit。若本机存在系统级 `ydotool.service`，可用 `sudo systemctl enable --now ydotool.service` 启动；否则按发行版方式运行守护进程。本机实测为用户进程，socket 位于 `$XDG_RUNTIME_DIR/.ydotool_socket`。


- Wayland 下 ydotool 1.0.4 的 CLI 没有滚轮子命令；插件明确返回 `unsupported_on_backend`。X11 的 xdotool 滚轮可用。
- Wayland 协议没有通用窗口枚举接口。插件只对 niri 实现 `niri msg --json windows`；其它合成器返回 `no_window_backend`。
- `grim` 使用 wlroots screencopy 协议；非 wlroots 合成器可能不支持或行为不同，需使用该合成器支持的截图后端。
- 单显示器坐标按整屏绝对坐标处理；多显示器布局需自行换算偏移量。
- 插件不提供 OCR、元素定位或视觉理解；模型负责理解截图。

## 安全语义

- 插件加载时不截图、不监听、不排队；只有显式调用 `cu_*` 工具时才动作。
- 不提权、不修改设备权限、不修改系统配置。
- 截图默认写入 `$TMPDIR/pi-computer-use/`，可用 `PI_COMPUTER_USE_DIR` 覆盖。
- 不联网、不引入 npm 运行时依赖。

## 安装到 PI-Desktop

插件 id：`corripo.computer-use`，权限：`agent.tool.register`（高权限，需显式同意）。使用 PI-Desktop 的插件工具打包并在设置中安装。

## 开发

```bash
node --test test/          # 40 个离线单测，不需要真实桌面
```

目录：

```
manifest.json     工具声明
main.js           插件入口
lib/session.js    会话探测、命令查找与子进程执行
lib/backends.js   截图/输入后端选择
lib/keymap.js     键名与 evdev/x11 映射
lib/actions.js    意图到命令参数的映射
lib/capture.js    截图、PNG 解析与区域裁剪
lib/tools.js      工具 schema 与执行
 test/             离线单测
```
