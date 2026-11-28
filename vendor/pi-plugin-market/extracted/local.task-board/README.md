# 任务看板（task-board）

PI-Desktop 的只读任务看板：把宿主里的会话与待审批事项整理成一页，点一行跳回对应会话。
对照物是 DeepSeek Harness 的 `dsh-super-kanban`，本插件是它的 **M1 只读切片**。

## 怎么用

### 1. 装入

宿主左侧的**插件页**（Plugins）→ 安装 / 添加插件 → 选本地包，指向：

```
plugins/task-board/dist/local.task-board-0.2.2.piplug
```

找不到入口时，在命令面板搜「插件」或「plugin」，插件页会列出已装插件并给出主操作。

### 2. 授权

插件行里给这四项授权（前三项缺一不可，`notify` 只影响双击唤醒窗口）：

| 权限 | 必须给的理由 |
| --- | --- |
| `ui.view` | 不给就不会出现看板视图 |
| `ui.panel` | 不给就打不开浮窗（命令会提示授权） |
| `desktop.control` | 不给则四列全空，只剩降级提示 |
| `notify` | 不给则双击任务只切会话、不弹「点击恢复窗口」的通知 |

**改过权限或换过版本后，必须在该插件行的 More → Reload 重载一次**，热更新不会让新授权生效。

### 3. 打开与验收

打开「任务看板」视图，按这个顺序看：

1. 顶部统计四个数有值（会话 / 待审批 / 执行中 / 24h 活跃）；
2. 四列里有会话行，每行是「标题 + 项目 chip + 相对时间」；
3. 点任意一行，宿主切到那个会话；
4. 点「刷新」，右下角时间戳更新。

若想先看静态效果，直接用浏览器打开 `view/index.html`：没有宿主桥时进入**预览模式**，用内置示例数据渲染，并在顶部标注「预览模式」，不会发起任何真实读取。

## 现在能做什么（0.3.0）

**两种表面，同一个插件**：侧栏四列全景（`ui.view`）＋ 置顶浮窗（`ui.shape: widget`）。

### 浮窗（0.2.0 新增）

- **始终可见**：独立 OS 窗口、`alwaysOnTop`、不进任务栏 —— 切到任何应用都压在最上层。
- **四段各有分工**：等待人工介入（琥珀·等你批计划或回答）· 执行中（蓝·带「等模型 / 压缩上下文」等实时相位）· 待审批（Plan / Goal）· **5 分钟内完成**（绿·刚跑完的任务；从检测到停下的时刻起算，**跨轮保留满 5 分钟**，方便点回去继续）。全部按到手数据**全量渲染**，拉高就多显示、矮了在框内滚动。
- **双击任务＝跳过去并叫醒窗口**：单击只安静跳回会话；**双击**会在跳转后发一条系统通知，点它宿主就恢复并聚焦最小化的主窗口（宿主没给插件窗口控制 API，这是唯一路径）。
- **拖动与关闭**：拖标题栏移动；**拖窗口边缘改大小**（`resizable: true`，宽高都能拖）；右键菜单切换置顶、最小化、关闭。
- **小尺寸自适应**：窗口很窄时先隐藏摘要、再隐藏页脚提示，列表始终可滚；矮到系统下限（120px）仍能看见标题栏与一行内容。
- **尺寸上下限的实话**：宿主 `manifest.ui` 只接受 `title` / `panel` / `shape` / `alwaysOnTop` / `resizable`，**没有 min/max 尺寸字段**，插件也没有设置窗口尺寸的 API。所以拖多小由系统与用户决定，页面只能自适应，不能硬卡。
- **打开方式**：命令面板搜「任务看板：打开浮窗」，或执行命令 `taskboard.openWidget`。
- **打开侧栏**：标题栏左侧的看板图标按钮，一键在侧栏打开完整四列视图（宿主 `ui.revealView`）；窗口窄到 216px 时该按钮自动让位。

### 侧栏视图

- **四列看板**：等待人工介入 · 执行中 · 待审批 · 24h 内活跃。0.3.7 删掉了「更早」列（参考价值低，却要把历史会话全部渲染一遍）。
- **执行中**：正在跑回合的会话；行内 chip 显示 Agent 此刻在干什么（等模型 / 压缩上下文 / 重试中 / 等子代理…，取自 `activity.phase`）。
- **列内独立滚动**：每列高度上限跟可视区走，条目多时在卡片内滚动，不再撑破或被裁掉。
- **统计条**：会话总数、待审批数、等待介入数、执行中数、24h 活跃数。
- **点击跳转**：点任意会话行或待审批行，调用宿主 `session/open` 回到那个会话。
- **降级可见**：某个通道不可用时顶部提示原因，其余列照常显示；**没有任何降级时该条完全不出现**（0.3.6 修掉「恒显示空黄框」）。
- **自动刷新**：节奏自适应 —— 有人等你或在跑 2 秒、只剩「5 分钟内刚完成」5 秒、全空闲 15 秒；标签页隐藏时停表，重新可见时立即刷新。页脚会显示当前节奏（降频时标「空闲降频」）。

M1 明确**不做**：不建任务卡、不做 AI 研判、不读消息正文、不写任何宿主状态。

## 权限与用途

| 权限 | 用途 | 拒绝后 |
| --- | --- | --- |
| `ui.view` | 在宿主视图区放一页 HTML（页面无 Node，只有 `window.pluginBridge`） | 视图不出现 |
| `ui.panel` | 打开置顶浮窗（`ui.shape: widget`） | 浮窗打不开，命令会提示 |
| `desktop.control` | 调用 `project/list`、`session/list`、`plans/pending`、`agent/getStatus`（均 read 风险）与点击时的 `session/open` | 看板拿不到数据，降级提示 |
| `notify` | 浮窗双击任务后发一条固定文案的系统通知（宿主点它才会恢复并聚焦主窗口） | 双击只切会话，窗口不会自己回来 |

`ui.view` 与 `desktop.control` 属高危授予（前者决定界面入口，后者能触达宿主操作面），安装时需在插件页显式同意；`notify` 只用于系统通知。
不申请 `fs.*`、`net.*`、`clipboard.*`、`agent.*`；不联网；不打开 `pi.sqlite`。

## 数据来源

全部来自宿主控制面的只读操作，字段做多键兜底（键名口径取自本机已跑通的 `project-tree/lib/facts.js` 实测映射）：

| 通道 | 取到的字段 |
| --- | --- |
| `project/list` | `name`、`path`、`projectId` |
| `session/list` | `sessionId`、`title`、`projectId`、`projectPath`、`updatedAt` |
| `plans/pending` | `requestId`、`title`/`question`、`kind`、`status`、`createdAt`、`sessionId` |
| `agent/getStatus` | 逐会话读 `isRunning`、`planningState`、`pendingPlanId`、`activity.phase`、`currentTurnId`；一次刷新探最近 24h 活跃的前 20 个，分批并发 |
| `session/open` | 仅传 `sessionId`，由宿主执行跳转 |

写盘：**无**。本插件不写任何文件，也不建私有数据目录。

## 设置项

无。M1 不读宿主设置，参数全用内置默认：侧栏一次取 60 条、浮窗 20 条；刷新节奏由主进程按活跃度给（2s / 5s / 15s），两个页面共享同一份快照缓存。

## 开发与打包

```powershell
# 校验（manifest / 引用文件 / 权限 / 路径包含）
pi-plugin check plugins/task-board

# 打包（产物在 plugins/task-board/dist/）
pi-plugin pack plugins/task-board
```

宿主加载插件时不编译 TS、不装依赖，因此本插件全部是可直接执行的 `.js` / `.html`。

## 已知限制

- 会话「运行中」状态未接入：`runningSessionIds` 只在宿主渲染层 IPC `session/list` 的返回里，插件侧 `session/list` 不含该字段。M2 需要另找通道。
- 待办（`session_todo`）暂未接入：插件侧没有 `todos.get` 的 host API，只有渲染层 IPC。M2 再定方案。
- 待审批条目点击是跳回所属会话，不在看板内批准 —— 批准要走宿主自身的审批流程（`plans/resolve` 属 dangerous 风险，M1 不碰）。

- 浮窗位置不记忆：宿主没有设置/读取插件窗口位置的 API，每次打开都回落到默认位置。
- 「执行中」一次只探最近 24h 活跃的前 20 个会话：宿主没有「列出全部运行中会话」的接口，只能逐会话问 `agent/getStatus`，探得再多会明显拖慢刷新。
- **Agent 反问（asktool）0.3.8 起能读到了**：宿主 `agent/pendingInteractive` 是公开的 read 操作，入参 `{sessionId}`、返回 `{asks, permissions}`。插件只对**在跑**的会话调它（Ask 期间 `isRunning` 仍为 true），并且**只取题数、不读题干与选项文本**。0.3.1~0.3.7 那句「宿主未对插件开放」是取证失误（当时搜的是主进程内部变量名 `pendingInteractiveRequests`，漏了 operation handle），已在 0.3.8 更正。
- **「叫醒主窗口」要多点一下通知**：插件没有窗口控制 API，只能借宿主对通知点击的 restore 行为；做不到「双击直接把最小化的窗口拉起来」。

## 版本

- `0.1.0` — M1 只读看板：三列 + 统计 + 跳转 + 降级与自动刷新。
- `0.1.1` — 修三处视图缺陷：深色主题未覆盖 `--fg` / `--muted` / `--bg`，导致正文与背景同色、标题整行看不见；窄屏媒体查询缺一个闭合括号，整段规则失效；窄栏里列用固定高度，条目少时撑出大片空白。另加预览模式（无宿主桥时用示例数据渲染并标注）。
- `0.1.2` — ① 新增「执行中」列：宿主没有「列出全部运行中会话」的接口，改用 `agent/getStatus` 逐会话探测（最近 24h 活跃的前 20 个，分批 5 个并发），有待确认的工具调用时标「等你确认」；② 修列内无法滚动：此前 `main` 不溢出（`align-content` 拉伸后行高不增长）、`.list` 在窄屏被设成 `overflow: visible`、`.col` 却是 `overflow: hidden`，三者叠加导致长列表被静默裁掉；现改为每列 `max-height` 跟可视区（窄屏 52vh）、列表作为唯一滚动容器，实测注入 40 行后 `scrollHeight 2070 > clientHeight 331` 可滚。宽屏断点也更成 4 / 2 / 1 列。
- `0.1.3` — 「执行中」与「待审批」两列补项目名。根因是 `sessionRows` 保存的是**未映射 projectName** 的原始会话数组（映射只发生在展示切片上），于是执行中列永远拿到空值、只显示标题和时间；现改为先在**全量**行上映射项目名再切片。待审批条目只带 `sessionId`，按会话反查项目名与标题。三列的空归属统一显示「未归属项目」，不再出现没有归属信息的行。
- `0.2.1` — 浮窗改为可拖边缘调整大小（`ui.resizable: true`）。同时补小尺寸自适应：`max-width 272px` 隐藏摘要与页脚提示、`max-height 176px` 隐藏页脚，列表始终可滚；去掉待审批行里冗余的「待批」标签（段名已表意）；轮询间隔 15s → 20s（浮窗常驻，降低 IPC 频率）。**如实记录两条做不到的事**：① 宿主不支持 min/max 尺寸约束（`manifest.ui` 无该字段，插件也无设置尺寸 API）；② 浮窗右键菜单由宿主固定提供 `alwaysOnTop / minimize / close` 三项，插件既不能增删项、也不能用 API 切换置顶（`PLUGIN_PANEL_WINDOW_CONTROL_ACTIONS` 里没有 toggleAlwaysOnTop）。
- `0.2.2` — ① 浮窗与侧栏不再各拉一遍数据：主进程加共享快照缓存（8 秒 TTL + 并发请求合并），两个页面同时开着时 IPC 减半；② 浮窗取消「每段最多 3 条」硬截断，改为按到手数据全量渲染（拉高窗口就多显示，矮了在框内滚动），只有上游总数大于到手条数时才提示「还有 N 条」；③ 标题栏新增「在侧栏打开」按钮，走宿主 `ui.revealView`（契约取证自 `app.asar` 的 `revealWorkPanelView()`：需 `ui.view` 权限、单视图可省 `viewId`、`sessionId` 一律不传以免命中「必须等于当前活跃会话」的校验），窗口窄到 216px 时该按钮自动隐藏。
- `0.3.0` — 按用户四条需求改造。① **「等待人工介入」独立成列/段**：此前这类会话被混进「执行中」。取证发现 0.2.x 用来判断「等你确认」的 `pendingToolConfirmations` 在桌面原生 runtime 里**恒为 0**（sidecar `getStatus()` 写死 0），那个标签从来没出现过；现在改用真实可观测的 `planningState === "awaiting_approval"` 与 `pendingPlanId`（模型出计划、等你批准即暂停），并把 `activity.phase`（等模型 / 压缩上下文 / 重试中 / 等子代理…）显示在执行中行上。**asktool 反问仍无法识别**：宿主 `getStatus` 没有 pendingInputs/asks 字段，那类会话依旧归「执行中」，不猜。② **浮窗新增「5 分钟内完成」**：靠跃迁判断——上一轮快照里它还在跑、这一轮停了且会话更新在 5 分钟内才算刚完成（没有上一轮记录时不判断），不靠时间瞎猜。③ **双击任务叫醒主窗口**：取证确认插件拿不到任何窗口控制 API（72 个 operation 无 window/show|focus|restore，插件主进程还是宿主派生的隔离进程），唯一能让宿主 restore 的是原生通知的 click handler（宿主内写死 `isMinimized→restore→show→focus`），所以双击＝切会话 + 发一条固定文案通知，点通知即恢复窗口；为此新增 `notify` 权限，未授权时降级为只切会话。④ 侧栏五列、浮窗四段。
- `0.3.1` — 修 0.3.0 的漏判：用户实测 asktool 反问时浮窗仍把会话显示在「执行中」。根因是 asktool 等待只在**回合级**状态（`waiting_input`），而 `agent/getStatus` 只返回会话级字段。新读路径＝对正在跑的会话补调宿主 `session/get`（read 风险，已在 `desktop.control` 内），多键兜底读 `status` / `activeTurnStatus` / `turnStatus` / `activeTurn.status`，命中 `waiting_input` 即归「等待人工介入」，文案区分「等你回答」与「等你批准计划」。参数形状两种都试（sidecar 收 `{ id }`、remote backend 收 `{ sessionId }`），带 `messageLimit: 1` 少拉消息体；能调通但一个状态字段都没有时置 `state.turnStatusUnsupported` 停止重试，避免每轮白调。**这条读路径的有效性只能装机验证**——宿主若不返回该字段，这类等待仍显示「执行中」。
- `0.3.2` — 浮窗默认尺寸 340×300 → **400×475**（用户指定）。同时把段标题内边距 `5px 6px 3px → 4px 6px 2px`，让该尺寸下**4 段 6 行正好不滚动**——改前实测 `bodyScrollH 404 > bodyClientH 400`，最后一行会露出半截；改后 `400 = 400`。四档实测：400×475 不滚，340×300 / 240×170 / 120×120 均可滚，四档零横向溢出，三条让位断点仍生效。**注意**：宿主只在创建窗口时读一次 manifest 尺寸，你拖过的大小不会被保存，每次重开都回到 400×475（无设置尺寸/位置的 API）。
- `0.3.3` — **撤掉 0.3.1 的无效读路径，并把话说准**。实测（用户截图：左侧「需要回答几个问题 第 1 / 4 题」时浮窗仍显示「执行中 2」）证明 `session/get` 拿不到回合状态。三份证据：① `pi-desktop-host-core.exe`（21 MB）里**没有** `waiting_input` / `activeTurnStatus` 字符串，桌面会话记录不带回合级状态；② `waiting_input` 只出现在 `agent-runtime/chunks/chunk-F4YY2JVV.js` 的 RACP TypeBox 枚举里，那是**远程 MCP** 协议，桌面本地 asktool 不走它；③ `pendingInteractiveRequests` 在 asar 里只出现一次，是主进程内部的 `agentHostBridge`，72 个 desktop operation 里没有出口。因此删除 `readTurnStatus`、`turnStatusUnsupported` 与对 `session/get` 的调用（不留白调的死代码），「等待人工介入」从此**只覆盖计划审批**：列 hint 改为「等你批计划」、空态写明「Ask 反问类等待宿主未对插件开放，会显示在「执行中」」、徽章统一「等你批准计划」。要真正支持反问等待，需要宿主把 `agent/pendingInteractive` 暴露成 desktop operation（或让 `agent/getStatus` 带上 asks 字段）——这是宿主侧改动，插件这边已无可挖的通道。
- `0.3.4` — **刷新节奏自适应（用户选方案 C）**。改动前：侧栏 15s、浮窗 20s 固定轮询，主进程 8s 统一 TTL —— 想更快就得整体提频，代价是每轮都要重拉 `session/list` 那 341 行。现在：快照多带一个 `nextPollMs`，主进程按活跃度定三档（**有人等你或在跑 2s** / 只剩刚完成 5s / 全空闲 15s），缓存 TTL 直接取上一份的 `nextPollMs`，两个页面改用 `setTimeout` 递归调度、照主进程给的间隔排下一轮。实测口径：本机 341 个活会话、24h 活跃仅 10 个，`agent/getStatus` 是 sidecar 内存读（不碰盘、不碰模型），所以 2s 档的真实开销约 10 次内存读 + 1 次清单拉取。失败路径退回 15s，不追高频。视觉可见：浮窗状态行降频时显示「· 空闲降频 15s」，侧栏页脚显示「2s 刷新 / 空闲降频 15s 刷新」。**顺带如实说明**：插件拿不到宿主的推送通道（`pi.bus.subscribe` 存在但宿主不往总线发系统事件、host 内部 hub 无插件出口、72 个 operation 无 subscribe），所以 2s 是轮询模式下的合理下限。

- `0.3.5` — **修「5 分钟内完成」只闪一下就消失的真 bug**（用户反馈「感觉很短就消失了，似乎没有 5 分钟」）。核查结论：阈值没错（`DONE_WINDOW_MS = 5 * 60 * 1000`），坏在判定写法 —— `wasRunning && fresh` 里的 `prevRunning` 每轮都被重写成当前在跑集合，于是条目只在**检测到 running→停止跃迁的那一轮**成立，下一轮 `wasRunning=false` 直接消失；叠上 0.3.4 的 2s 活跃节奏，等于只显示约 2 秒。另外 `finishedAt` 原先取 `session.updatedAt`（会话最后更新时间），不是「检测到停下的时刻」。修法：新增 `state.recentlyDone`（`Map<sessionId, 行数据 + finishedAt>`），跃迁那一轮**记一次** `finishedAt = Date.now()` 并跨轮保留，每轮只做两件维护 —— 超出 5 分钟窗口的删掉、会话又跑起来的删掉；输出从表里汇总后按 `finishedAt` 倒序。附带好处：某轮 `agent/getStatus` 失败或该会话被挤出前 20 个候选时，已记下的完成仍照常显示。**行为级验证**（mock 宿主控制面跑真实 `buildSnapshot`，5 轮）：轮1 执行中且无刚完成 → 轮2 停下出现刚完成（`finishedAt` 为检测时刻）→ **轮3（5.2 秒后、无新跃迁）仍保留且 `finishedAt` 未被刷新** → 轮4 重新跑起来即移出 → 轮5 再停下重新记录，9/9 PASS。

- `0.3.6` — **修侧栏顶部「提示」条永远显示空壳的真 bug**（用户截图问「这个下面的提示条是干嘛的，我没看到过里面有内容」）。**它的本职**：只在某个数据通道降级（`degraded` 非空，如 `plans/pending` 读不到）或整轮读取失败时，把原因列出来；正常时**应当完全不出现**。**根因是 CSS 特异性**：`#notice` 元素带了 `hidden` 属性，但 `.notice` 自己写了 `display: flex` —— 作者样式覆盖了浏览器 UA 的 `[hidden] { display: none }`，于是 `box.hidden = true` 形同虚设，黄框一直占着一行、里面永远空着（因为 `showNotice` 在无降级时把列表清空了）。**修法**：补 `.notice[hidden] { display: none; }`（`.notice[hidden]` 特异性 0,2,0 高于 `.notice`，且写在后面）。**浮窗没有这个问题**：`widget` 的 `#note` 配的 `.note` 没写 `display`，`hidden` 一直有效 —— 全仓排查确认两页各只有一处 `hidden` 元素。**验证**：真实 Chromium（预览页）读 computed style —— `hidden=true` 时 `display: none`、`height 0`；`hidden=false` 时 `display: flex`；预览模式因「未连接宿主」被当作一条降级、标题显示「预览模式」且条正常可见，说明显示/隐藏两条路径都对。

- `0.3.7` — **删掉「更早」列，并做真正的降载**（用户：这张图里那列「作用不到，加载负担很重」）。**先说清一个事实**：`session/list` 没有分页参数（宿主 `desktopSessionTargetId` 只处理单会话目标），一次就返回**全量**——本机 395 行。所以只删列只是少渲染，拉取照旧。于是同时做两件实事：① **会话清单降频**——新增 `state.sessionsCache` + `SESSIONS_TTL_MS = 10000`，10 秒内的 2s 轮次直接复用缓存，连 `normalizeSessions` 的 395 行映射与排序都不做，每轮只剩 `agent/getStatus`（sidecar 内存读）；② **跨进程只发 24h 活跃行**——`snapshot.sessions` 从「前 60 行」改为「24h 内活跃的那些」（本机 20 条），历史行只服务统计（`sessionTotal` / `activeToday` 改由缓存一并算出），不再搬运。**视图侧**：删 `older` section、`fillSessions` 不再分 hot/cold 双列渲染、首屏 skeleton 少一列、`blankBox` 少一条文案、`main` 网格 `repeat(5)` → `repeat(4)`。**验证**：mock 宿主跑真实 `buildSnapshot` 两轮（越过 2s 快照缓存）—— 轮1 `session/list` 调用 1 次、`total=2`（含 30 天前那条）、`activeToday=1`、下发只有 24h 内那 1 行且项目名仍映射上；轮2 `session/list` **仍为 1 次**（命中清单缓存）而 `getStatus` 照常跑，统计不变，**10/10 PASS**；真实 Chromium 复核：`main .col` 为 4 列（waiting/running/plans/active）、无 `[data-kind="older"]`、无 `l-older`、活跃 6 行、零横向溢出。**副作用如实说明**：新建会话最迟 10 秒后才出现在看板（清单缓存窗口）。

- `0.3.8` — **把 asktool 反问并入「等待人工介入」，并修掉计划审批从未生效的顺序 bug**（用户：「「反问等待」接进去」）。**① 旧结论被推翻**：0.3.1~0.3.7 一直写「宿主未对插件开放」，实际 `agent/pendingInteractive` 是**公开的 read 操作**（`spec("pendingInteractive","agent/pendingInteractive","List pending Agent questions and tool permission requests.","read",["input"])`），入参 `{sessionId}`、返回 `{asks, permissions}`，宿主渲染层的 `restorePendingInteractive` 就用它。当初搜的是主进程内部变量名 `pendingInteractiveRequests`，漏了 operation handle 本身 —— 是取证失误，不是宿主限制。**② 新增 `readInteractive()`**：只对**在跑**的会话补查（Ask 期间 `isRunning` 仍为 true），每轮通常 0~3 次调用；只累加 `questions.length` 得到**题数**，不读题干与选项文本（守住「不读消息内容」边界）；异常返回 null 走 fail-open，若在跑会话全失败则 degraded 记 `ASK_PROBE_UNAVAILABLE`，不静默。**③ 顺手修掉一个更早的真 bug**：`awaiting_approval` 时回合已结束（`isRunning=false`），而 0.3.0 起这个判定被写在 `!isRunning` 的 `continue` **之后**，所以「计划审批」这一路**从来没被捕获过** —— 等待列长期为 0 不只是因为没反问，计划审批也没进。由本轮行为测试发现（mock 一个 awaiting_approval + isRunning=false 的会话，等待列仍空），已把判定提到 `!isRunning` 之前。**④ 视图**：徽章按 `waitingFor` 区分「等你回答 N 题」与「等你批准计划」，侧栏 hint 改「等你批计划 / 回答」，空态改为「计划审批与 Agent 反问都会出现在这里」，两页 DEMO 各加一条反问样例。**⑤ 刻意不并入 `permissions`**（工具权限确认）：宿主对它有自己的原生弹窗，插件再报一条会让用户以为有两处要填。**验证**：mock 宿主 11/11 PASS（反问进等待列且题数=2、计划审批归 plan-approval、无反问的仍在执行中、反问不重复出现在执行中、通道失败回落执行中并报 `ASK_PROBE_UNAVAILABLE`）；Chromium 两页实测徽章分别为「等你批准计划」「等你回答 3 题」、计数 2；`PluginCheck` passed、`PluginPack` → `dist/local.task-board-0.3.8.piplug`。**边界如实标注**：`agent/pendingInteractive` 的参数形态按 `plans/pending` 同构推断（`args[0] = {sessionId}`），装机若不通会由 `ASK_PROBE_UNAVAILABLE` 暴露。

- `0.3.9` — **页脚显示版本号，专门用来判断「页面到底刷没刷新」**（用户反馈「提示还是一直在」，此前每次都要靠猜是代码没改好还是视图文档没重载）。**取证结果**：安装目录 `plugins/installed/local.task-board` 已是 0.3.8，`view/index.html` 里 `.notice[hidden]`（L196）在位；`plugin.log` 显示主进程也确实在跑新代码（10:46:07 `plugin.load.success`，且日志里已有 `agent/pendingInteractive` 调用）—— 但宿主插件视图是**独立 webContents**，只有 `delivery.kind === "reload"` 才会重新 `loadURL`，所以已加载的旧文档可能一直留着。**改动**：侧栏页脚加 `v0.3.9`、浮窗状态行末尾加 ` · v0.3.9`；两处版本字符串必须与 `manifest.version` 一致，由打包校验器断言（防止以后漏改）。**怎么用**：装完重载后，页脚是 `v0.3.9` ⇒ 视图已刷新；仍是旧号或看不到 ⇒ 还是旧文档，重启宿主最稳妥。
