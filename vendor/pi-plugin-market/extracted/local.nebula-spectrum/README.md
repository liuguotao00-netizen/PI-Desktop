# Nebula Spectrum

PI-Desktop 外观主题插件，同一套光谱语言下的**八个版本**。

| 主题 | id | 基础色 | 外观 |
| --- | --- | --- | --- |
| 光谱·青蓝 | `nebula` | `dark` | **深色对话区**（`#0a171f`）+ 窗口外围多色光谱（琥珀 / 玫红 / 洋红 / 靛蓝 / 青 / 青绿） |
| 光谱·彩虹 | `nebula-light` | `light` | **白色对话区** + 窗口外围多色光谱（琥珀 / 玫红 / 洋红 / 靛蓝 / 青 / 绿） |
| 光谱·暖阳 | `nebula-sunrise` | `light` | **暖白对话区** + 琥珀 / 橙 / 玫红 / 金 光谱 |
| 光谱·冰蓝 | `nebula-glacier` | `light` | **冷白对话区** + 冰蓝 / 银 / 薄荷 光谱 |
| 光谱·玫瑰 | `nebula-rose` | `light` | **粉白对话区** + 玫粉 / 珊瑚 / 桃 / 樱花 光谱 |
| 光谱·余烬 | `nebula-ember` | `dark` | **暖黑对话区**（`#100a08`）+ 琥珀 / 橙 / 猩红 / 玫红 光谱 |
| 光谱·朱红 | `nebula-crimson` | `dark` | **红黑对话区**（`#0d0508`、画布 `#000000`）+ 朱红 / 橙 / 琥珀 / 品红 / 青 光谱 |
| 光谱·霓虹 | `nebula-neon` | `dark` | **纯黑对话区**（`#04060c`）+ 青 / 电光蓝 / 品红 霓虹 |

- 插件 id：`local.nebula-spectrum`
- 完整主题 id：`plugin:local.nebula-spectrum:` + `nebula` / `nebula-light` / `nebula-sunrise` / `nebula-glacier` / `nebula-rose` / `nebula-ember` / `nebula-crimson` / `nebula-neon`
- 权限：`ui.theme`（注入主题 CSS）、`ui.window.appearance`（原生窗口底色，消除启动白闪）

## 预览

三套主题共用同一份布局，只改令牌映射与主色：

**Nebula Spectrum**（深色）— 深海军蓝对话区，青 / 蓝 / 青绿弧线，窗口右下角一点玫红

![Nebula Spectrum](https://raw.githubusercontent.com/LiuHongXuMaritime/pi-desktop-theme-nebula-spectrum/main/docs/preview-nebula.jpg)

**Nebula Spectrum Light** — 白色面板承载文字，整窗铺琥珀 / 玫红 / 洋红 / 靛蓝 / 青 / 绿的光谱

![Nebula Spectrum Light](https://raw.githubusercontent.com/LiuHongXuMaritime/pi-desktop-theme-nebula-spectrum/main/docs/preview-light.jpg)

**Nebula Spectrum Onyx**（深色）— 对话区沉到近黑，卡片只比面板亮一丝，光谱收在窗口边缘

![Nebula Spectrum Onyx](https://raw.githubusercontent.com/LiuHongXuMaritime/pi-desktop-theme-nebula-spectrum/main/docs/preview-onyx.jpg)


> Sunrise / Glacier / Rose / Ember / Neon 为新增配色，截图尚未更新；本地可直接打开 `preview/compare.html`（八套并排）或对应的 `preview/specimen-*.html` 预览。
> 截图来自主题 CSS 在真实宿主令牌下的渲染（1440 × 820）。

## 安装

1. 打开 PI-Desktop 的「插件」页。
2. 载入本目录 `nebula-spectrum/`（开发模式热重载），或 `PluginPack` 打成 `.piplug` 后从文件安装。
3. 在 设置 → 外观 里选择 **Nebula Spectrum** 或 **Nebula Spectrum Light**。

## 实现要点

两套主题都是纯 CSS，没有脚本、没有外部资源；`main.js` 只是插件入口的空壳。

1. 选择器全部是 `:root[data-theme][data-plugin-theme="plugin:local.nebula-spectrum:<主题>"]`。
   三重属性选择器的特异性 (0,3,0) 高于宿主自己的 `:root[data-theme=dark]` / `[data-theme=light]` 令牌块，
   所以无论样式表顺序如何都能覆盖，也不会泄漏到另一个主题或其它插件。
2. 先重映射 `--gray-*` 中性色阶（深色版是紫调墨色，浅色版是紫调纸白），再显式覆盖语义令牌 `--ds-*`；
   宿主从这两者派生的组件颜色会自动跟着变。
3. 再对少数高曝光表面单独上渐变：`.app-shell`（极光）、`.sidebar-surface`（玻璃侧栏）、
   `.composer-shell`（光谱描边）、`.send-btn`、`.message-bubble`、`.code-block-head`。

浅色版的思路：**对话区（`.main-pane`）是纯白面板**，和输入框、代码块同一种白，正文直接落在白纸上；
颜色只留在窗口外围——`.app-shell` 的 118° 多色 wash（琥珀→玫红→靛蓝→青→绿）、侧栏玻璃、输入框五段光谱描边、
彩虹发送键，以及 `.main-pane` 顶部一条很淡的暖色光带。取色：对话框底 `#ffffff`、墨 `#1a1a26`（对比 ≈ 16:1）、
强调色 `#be185d`（白底 ≈ 6.0:1）。

气泡样式只作用于**用户自己的消息**（`.message-row.user .message-bubble`）：宿主的助手消息也带 `.message-bubble`，
只把它重置成透明无内边距，所以助手回复直接落在阅读面上，不会被套进一个白框／深色框。
用户气泡用 `#ffffff` + 1px 中性描边 + 轻微阴影，靠右下角的直角与大圆角区分"我发的"。

深色版用同一套分层逻辑：对话区是**一整块沉稳的深色阅读面**（`.main-pane` → `#0a171f`），
气泡 `#14262f`、代码块 `#0f1e27`、输入框半透明深色，彼此只靠发丝线和一两档明度差分层；
彩色只留在窗口外围——`.app-shell` 的琥珀 / 玫红 / 洋红 / 靛蓝 / 青 / 青绿极光、玻璃侧栏、
输入框五段光谱描边、彩虹发送键与顶部彩虹细线，以及对话区顶部一条很淡的彩色光带。
两套主题共用同一套光谱色相，只是底色与文字层次相反。

第三套 **Nebula Spectrum Onyx** 是深色版的再加黑一档：画布 `#000000`、对话区 `#04070b`、
用户气泡 `#0b1218`、代码块 `#080d11`，层与层之间只差一两档明度，边框降到 `rgba(148,190,210,0.12–0.14)`；
外围光谱与另两套完全一致（同一组色相，alpha 略降），阴影改成纯黑，让极光成为唯一的发光来源。

## 想改颜色

| 目标 | 变量 |
| --- | --- |
| 主背景 | `--ds-bg-primary` |
| 面板 / 浮层 | `--ds-bg-secondary`、`--ds-bg-elevated` |
| 强调色 | `--ds-accent`、`--ds-accent-hover` |
| 文字层次 | `--ds-text-primary` / `-secondary` / `-muted` / `-faint` |
| 分割线 | `--ds-border-default` |
| 极光本体 | `.app-shell` 里的 `radial-gradient(...)` 层 |

想更亮 / 更暗，通常只动两个数：`--ds-bg-primary` 和 `.app-shell` 各层极光的 alpha。

## 预览

`preview/` 里是原生尺寸的样张，直接双击打开：

- `compare.html` — 深色与浅色并排对比
- `specimen.html` / `specimen-light.html` — 单版本样张（文字层次、表面令牌、侧栏、气泡、代码块、输入框、设置卡片）

## 开发校验

`python validate_theme.py nebula-spectrum` 会跑一份宿主规则的本地镜像：
manifest 字段、主题 id / 路径 / 基础色、权限、CSS 体积上限、禁止项（`@import`、markup、脚本表达式、外部 `url()`），
以及括号配平、规则作用域、声明完整性——`contributes.themes` 里的每个主题都会检查。
