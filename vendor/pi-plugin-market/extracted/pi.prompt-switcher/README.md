# 提示词切换器 (Prompt Switcher) — PI-Desktop 插件

[![GitHub Release](https://img.shields.io/github/v/release/mikulo/pi-prompt-switcher?color=6366f1&style=flat-square)](https://github.com/mikulo/pi-prompt-switcher/releases)
[![PI-Desktop Plugin](https://img.shields.io/badge/PI--Desktop-Plugin-blue?style=flat-square)](https://github.com/vastsa/PI-Desktop)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)

专为 **[PI-Desktop](https://github.com/vastsa/PI-Desktop)** 打造的提示词（System Prompt / Agent Prompt）热切换与生命周期管理插件。

---

## 💡 为什么需要本插件？

在使用 PI-Desktop 开发与对话时，经常需要在不同类型的任务之间切换（例如：代码审查专家、架构设计顾问、国际化翻译官、安全审计助手等）。

- **痛点一**：传统方式需要反复在工作区编辑 `agents.md` 或手动复制长篇提示词，效率低下且繁琐。
- **痛点二**：手动粘贴的提示词如果混入长期对话，容易对已有上下文产生角色干扰。
- **痛点三**：用户往往沉淀了许多本地 `.md` 提示词，缺乏一个可视化、可随时按需开关并同步至输入补全的集成管理工具。

**提示词切换器** 完美解决了以上问题：可在设置面板中自由配置本地提示词目录、批量勾选启用；在**新建会话首轮键入 `/`** 即可极速选择并应用；且拥有**历史对话自动守卫机制**，若对话已存在历史记录则自动忽略，绝不破坏长篇上下文。

---

## 🌟 核心特性

1. **📁 本地多提示词目录管理**：
   - 可以在扩展设置面板中指定任意本地路径（支持绝对路径或工作区相对路径）。
   - 自动递归扫描指定目录下的全部 `.md` 文件，读取文件大小与修改时间。

2. **🎛️ 可视化开关与独立持久化**：
   - 每个 `.md` 提示词配备独立的勾选开关（Toggle Switch），支持“全选启用”与“全选禁用”。
   - 自动解析 Markdown 的 YAML Frontmatter，优雅呈现提示词名称（Title）与功能说明（Description）。
   - 内置即时搜索筛选框，提示词再多也能秒级定位。

3. **⚡ 对话首轮输入 `/` 快速激活**：
   - 在新会话的输入框中键入 `/`，系统补全列表将自动列出所有已启用的提示词文件。
   - 选中并发送后，全文直接作为大模型的系统全局引导指令（效果等同于 `agents.md`）生效。
   - 亦可随时在输入框通过 `@文件名` 引用本地提示词文件。

4. **🛡️ 历史会话自动守卫机制（防上下文污染）**：
   - 严格遵循**“仅在会话最开始（首轮交互）时生效”**的设计原则。
   - 同步模板时自动注入状态守卫协议：当检测到会话中已经存在既往对话历史时，大模型将自动忽略该全局角色预设，继续基于原有上下文进行交流。

5. **🔄 双轨同步与零残留清理**：
   - 开启的提示词会实时同步至 PI-Desktop 原生模板系统（全局 `~/.pi/agent/prompts` 与项目 `<workspace>/.pi/prompts`）。
   - 取消勾选某提示词时，插件会自动撤回对应的原生模板，保持工作区干净纯粹。

---

## 📦 安装与加载方式

### 方式一：下载 `.piplug` 安装包一键安装（推荐）

1. 前往本仓库 [Releases 页面](https://github.com/mikulo/pi-prompt-switcher/releases) 下载最新版的 `pi.prompt-switcher-1.0.1.piplug`。
2. 打开 PI-Desktop，进入 **设置 -> 扩展**（Plugins）。
3. 将下载的 `.piplug` 文件拖入扩展窗口，或在右上角选择「从文件安装插件」。
4. 安装完成后即可在扩展列表中看到「提示词切换器」。

### 方式二：开发者模式加载（源码运行）

1. 克隆本仓库到本地：
   ```bash
   git clone https://github.com/mikulo/pi-prompt-switcher.git
   ```
2. 打开 PI-Desktop，进入 **设置 -> 扩展**。
3. 点击「加载开发插件」（Load Dev Plugin），选择克隆后的仓库根目录即可。

---

## 📖 详细使用指南

### 步骤 1：准备本地提示词文件

在您的工作区或电脑任意位置新建一个文件夹（例如 `prompts`），放入若干 `.md` 文件。支持可选的 Frontmatter 描述，例如：

`prompts/code-reviewer.md`:
```markdown
---
name: code-reviewer
description: 资深全栈代码审查专家，专注安全审计、性能瓶颈与代码整洁度
---

你是一位拥有 15 年经验的资深架构师兼代码审查专家。
请在接下来的对话中严格以代码规范、逻辑严谨性和边界异常处理为导向进行代码审查。
```

> **小贴士**：即使没有 Frontmatter，插件也会智能提取文件名作为指令名称，并提取前言首句作为简介。

### 步骤 2：打开设置面板配置

- 点击 PI-Desktop 左侧栏或扩展管理中的「提示词切换设置」图标；
- 或者在聊天输入框键入 `/open-prompt-switcher` 回车打开设置面板。
- 在「提示词本地目录」输入框中填入你的提示词文件夹路径（或点击「浏览...」按钮选取）。
- 在列表中勾选想要启用的提示词文件，点击「保存并立即同步」。

### 步骤 3：在新建会话中触发切换

1. 点击左上角「新建对话」按钮，确保当前处于**全新的对话（无任何历史记录）**。
2. 在输入框键入 `/`，下拉列表中将展示已启用的提示词（例如 `/code-reviewer`）。
3. 点击选中后发送，AI 大模型即可立即按照该提示词定义的目标角色和系统规范运行！

---

## 🧩 常用快捷命令

| 命令 ID | 快捷指令 | 说明 |
| :--- | :--- | :--- |
| `open-prompt-switcher` | `/open-prompt-switcher` | 打开提示词切换器设置面板 |
| `sync-prompt-switcher` | `/sync-prompt-switcher` | 重新扫描本地目录并立即同步模板 |
| （原生模板） | `/<文件名>` | 启用并同步后由 PI-Desktop 原生提示词系统提供，选中即注入全文。插件不会注册 `/prompt-<文件名>` |

---

## 🔒 隐私与安全性

- **纯本地运行**：本插件不连接任何外部网络，仅访问本地设定的提示词文件夹。
- **模板隔离保护**：守卫标记只针对由本插件生成的模板，绝不误删用户自建的系统模板。

---

## 📝 更新日志

### 1.0.1

- 修复未闭合 YAML frontmatter、或 `description` 含冒号时，原生 `/` 模板列表丢失提示词的问题。
- 不再注册无效的 `/prompt-<文件名>` 命令；启用后仅通过原生 `/<文件名>` 注入提示词。

### 1.0.0

- 首次发布。

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 协议开源。
