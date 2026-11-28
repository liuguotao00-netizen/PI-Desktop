# pi.taobao-tools

生意参谋取数与浏览器自动化，作为 PI-Desktop 的内置插件运行。

```
PI-Desktop agent
  └─ 本插件（原生 agent tools）
        ├─ 取数脚本：白名单页面脚本 + 商家页面守卫
        └─ 自动化引擎：与 QiWork 同一套 JSON DSL
              └─ pi.browser（PI-Desktop 内置浏览器）
```

插件不启动外部浏览器、不保存 Cookie、不读凭据；登录态始终在用户自己的浏览器视图里。

## 源码与构建

引擎与工具层是 TypeScript（`strict`），源码在 `src/`，编译为 CommonJS 到 `compiled/`：

```text
src/main.ts                 工具注册入口
src/bridge/server.ts        工具面与运行编排
src/bridge/runner.ts        取数脚本运行器（商家页面守卫）
src/bridge/automation/      DSL 目录、参数、驱动、执行器、产物、运行记录
bridge/automation/scripts/  36 个脚本（数据，不是代码）
bridge/vendor/              vendored adm-zip
data/                       58 个白名单取数脚本的注册表与脚本体
```

```bash
npm run typecheck   # tsc --noEmit
npm test            # 编译后跑 node --test
npm run build       # 编译 + 复制运行时资源 + 同步到 resources/plugins
npm run test:e2e:browser  # 真实 Chrome + 本地夹具的浏览器 E2E
```

运行时入口是 `compiled/main.js`，manifest 的 `main` 指向它。插件根目录的
`package.json` 声明 `"type": "commonjs"`，因为上级 `apps/desktop` 是 ESM。

根仓库已经把插件构建接入流水线：`pnpm build:plugins` 会构建所有带
`package.json` + `tsconfig.json` 的插件；`apps/desktop` 的 `predev`、`pack`、
`dist` 都会先执行它。CI 会跑 `pnpm test:plugins`、浏览器 E2E，并检查
`resources/plugins/pi.taobao-tools` 与源码构建结果是否一致。

## 工具

| 工具 | 作用 |
| --- | --- |
| `list_scripts` | 列出 58 个白名单取数脚本，并按平台汇总数量 |
| `eval_script` | 在店铺页面执行一个取数脚本 |
| `check_session` | 校验生意参谋登录与主营类目 |
| `fetch_search_keywords` | 拉本期/上期搜索词排行，结果落盘到 `~/Downloads/pi-taobao` |
| `finish_task` | 关闭本次为取数打开的标签页 |
| `list_automations` | 列出自动化脚本：平台、类型、参数、动作 |
| `prepare_automation` | 干跑：校验文件与内容、预览步骤，不打开浏览器 |
| `run_automation` | 提交执行，立即返回 `runId`（同一会话内串行） |
| `get_automation_run` | 按 `runId` 查状态、进度、结果、产物或失败原因 |
| `cancel_automation_run` | 按 `runId` 取消排队中或运行中的任务 |

## 自动化脚本库

脚本位于 `bridge/automation/scripts/`，与 QiWork 的内置脚本库同源，36 个：

| 类型 | 平台 | 代表脚本 |
| --- | --- | --- |
| 采集 `collect` | 阿里妈妈、拼多多、淘宝、网页、抖音、小红书 | 计划/单元/人群/关键词报表、后台首页、商品详情、网页正文、搜索、热榜、笔记详情与评论 |
| 互动 `interact` | 小红书、抖音 | 点赞/取消点赞、收藏/取消收藏、评论 |
| 发布 `publish` | 小红书、抖音、快手、视频号 | 图文笔记、视频笔记、短视频、图文动态 |

脚本是数据：`variables` 描述参数，`steps` 描述动作，`outputSchema` 描述产物。执行器不认识任何具体平台，新增平台只需新增脚本。

### 支持的动作

`wait`、`execute`、`transform`、`assertPageState`（`failWhen` / `passWhen`）、
`waitForSelector` / `waitForElement`、`waitForLoad`、`waitForNavigation`、
`navigate`、`reload`、`click`、`type`、`hover`、`scroll`、`upload`、
`activateAndWaitForResponse`、`activateAndWaitForNavigation`、
`downloadFile`、`extractZip`、`saveMarkdown`、`sessionCapture`、
`scrollForSession`、`scrollForState`、`waitForState`。

能力细节与 QiWork 对齐：

- **目标解析**：`{selector, text, shadowHost}`；先查页面脚本（light DOM 与 open
  shadow root），再走 DOM 域（closed shadow root），最后用无障碍树按名称找控件。
- **真实输入**：`trusted` 点击与 `activate*` 走 CDP 指针事件；`contenteditable`
  用 `Input.insertText`；`tagMode` 逐个输入话题并按真实空格提交。
- **上传**：`DOM.setFileInputFiles`，可见/隐藏 input、shadow DOM 内的 input 都支持；
  上传完成按 `uploadedSelector` / `pendingSelectors` / `failureSelectors` 轮询。
- **发布回执**：`activateAndWaitForResponse` 先装响应记录器再点击，按
  `successPath` / `successEquals` / `requiredPaths` 判定；`activateAndWaitForNavigation`
  等跳转并识别验证码。
- **内容校验**：`minChars` / `forbidChars` 在打开页面之前报
  `AUTOMATION_CONTENT_INVALID`；`maxChars` 按 `chars` / `utf16` / `xhs` 截断。
- **页面就绪**：`waitForState` 轮询任意页面表达式（`__INITIAL_STATE__` 早于 DOM 的页面）。

## 并发与取消

运行按 **会话** 串行：同一对话的浏览器标签页一次只跑一个任务，不同对话可以并行。
`cancel_automation_run` 会中止排队中或运行中的任务；运行中的任务在下一次浏览器
操作前停止。已经按下的发布按钮无法撤回，取消后请到平台确认结果。

## 发布与防重复

发布类脚本直接执行，没有额外的确认门禁。按下发布按钮的那一刻会记录本次内容
（自动化 id + 参数指纹），同一内容在脚本的 `dedupeWindowMs`（默认 5 分钟）内
再次提交会被 `PUBLISH_ALREADY_ATTEMPTED` 拒绝。这样 `PUBLISH_UNCONFIRMED`
之后的重试不会变成两条笔记。

记录保存在 `~/.pi-desktop/plugins/data/pi.taobao-tools/automation/publish-attempts.json`。

## 运行记录与产物

`run_automation` 立即返回 `runId`，同一会话内串行执行。每个运行有独立目录：

```text
~/.pi-desktop/plugins/data/pi.taobao-tools/automation/runs/<runId>/
  run.json          # 状态、结果、失败原因与产物列表
  failure.png       # 失败时的页面截图（如有）
  failure.json      # 失败分类：captcha / login / blocked / not_found / drift
  downloads/        # 远程图片与下载文件
```

运行记录在插件重启后仍可通过 `get_automation_run` 读取。默认超时：采集/互动
300 秒，发布 900 秒，可用 `timeout_ms` 覆盖（1000～900000）。

## 人机边界

自动化与普通 turn 共用浏览器接管状态机：用户点「接管」后，任何后续浏览器操作
返回 `HANDOFF_REQUIRED`，运行记为 `cancelled`；用户交还后不会自动重跑。
详见 [CONTROL-FLOW.md](CONTROL-FLOW.md)。

## 浏览器 E2E 与真实平台冒烟

- **本地夹具 E2E**：`npm run test:e2e:browser`。它会启动无头 Chrome，对本地页面
  跑真实引擎：contenteditable 输入、隐藏文件上传、**closed shadow root** 里的
  发布按钮、发布回执捕获、网络响应捕获、验证码识别和失败截图。没有 Chrome 时
  自动跳过。
- **真实平台冒烟**：不自动登录、不接触账号。先用独立 profile 启动带远程调试的
  Chrome：

  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 --user-data-dir="$HOME/.pi-e2e-chrome"
  ```

  在这个 Chrome 里手动登录平台，然后运行：

  ```bash
  node test/e2e/real-platform-smoke.cjs \
    --cdp http://127.0.0.1:9222 \
    --script xiaohongshu-search \
    --variables '{"keyword":"咖啡"}'
  ```

  `--list` 可列出全部脚本；`--match <url>` 选择标签页；`--timeout <ms>` 调大发布
  任务的预算。它会打印结果、产物目录或带错误码的失败信息。

## 首次使用

1. 启动 PI-Desktop，打开任一对话右侧的 **Browser** 视图。插件随应用加载。
2. 在浏览器里登录目标平台（生意参谋、小红书创作中心、抖音创作服务平台等）。
3. 让 agent 先调用 `prepare_automation` 看参数与步骤，再调用 `run_automation`。

## 已知限制

- 发布与互动会改变账号状态；平台风控时脚本会停下并把页面留给用户处理。
- 远程图片优先走宿主 `pi.net.fetch`（已声明 `net.fetch` + `net.anyHost`），不再受
  图床 CORS 限制；宿主拒绝或没有二进制响应时回退到页面 `fetch`。`net.anyHost`
  是安装时的高风险授权，仅用于用户传入的图片 URL。
- `saveMarkdown` 覆盖标题、段落、列表、引用、代码块、链接、图片和表格；非常规
  布局仍可能需要补规则。
- `downloadFile` / `extractZip` 的产物落在本次运行的目录里；`alimamaCsvPostProcess`
  会把 CSV 从 GB18030 转为 UTF-8 BOM。
- 自动化使用浏览器视图，不读取 Cookie、不接管网络请求；用户接管时全部操作暂停。
  宿主 `pi.net.fetch` 只用于下载用户传入的图片 URL，不带浏览器 Cookie。
- 插件不内置确认门禁；是否发布由脚本参数（如 `submitAction: draft / fill`）和
  调用方决定。
