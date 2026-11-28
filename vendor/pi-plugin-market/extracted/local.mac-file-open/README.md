# Mac 文件打开增强 / Mac File Open Enhancer (macOS Apple Silicon)

**系统与架构要求（重要）**：
- **仅支持 macOS**。
- **目前内置原生助手（`native-open`）仅编译了 Apple Silicon (`arm64`) 版本**。如果在 Intel Mac 上使用，可在插件目录下自行编译源码：`xcrun swiftc native.swift -o native-open`。

## 功能说明

在聊天消息中右键点击本地文件链接（`file://` 或 `/` 路径），弹出增强菜单：
- **在 PI-Desktop 中预览**：保持宿主原有的应用内预览行为
- **在 Finder 中显示**：调用 `NSWorkspace.shared.activateFileViewerSelecting` 定位并高亮文件
- **使用默认应用打开**：使用系统默认关联应用打开文件
- **打开方式…**：枚举系统关联的全部应用程序（标注默认项），指定应用直接打开，不修改系统默认关联
- **复制完整地址 / 复制相对地址**：将规范化后的真实路径或项目相对路径写入剪贴板

安全边界：仅允许当前项目目录或当前会话 `scratch` 附件目录内的普通文件，自动拒绝 `.git`、`.ssh`、`.env` 及可执行脚本后缀，不拼接执行任何 shell 命令字符串。

## English

**Platform & Architecture Requirement**:
- **macOS only**.
- **The bundled native helper (`native-open`) is currently compiled for Apple Silicon (`arm64`) only**. On Intel Macs, recompile from source with `xcrun swiftc native.swift -o native-open`.

Right-click any local file link (`file://` or `/`) in chat messages to:
- **Preview in PI-Desktop**
- **Reveal in Finder**
- **Open with Default App**
- **Open With…** (lists all macOS-associated applications via `NSWorkspace` without changing system default associations)
- **Copy Full Path / Copy Relative Path**
