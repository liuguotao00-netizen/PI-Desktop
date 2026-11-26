# pi-deepseek-web

为 Pi 生态接入 DeepSeek 官方 Search / Fetch API 的扩展：让 agent 具备实时联网搜索与网页正文提取能力。**自动复用你已有的 DeepSeek 密钥**，无需额外维护任何 key。

## 提供的资源

| 资源 | 用途 |
| --- | --- |
| `deepseek_search` 工具 | 联网搜索，返回标题 / URL / 摘要（最多 10 条，可选附带全文） |
| `deepseek_fetch` 工具 | 对指定 URL 提取干净的可读正文（对 JS 重度页面优于朴素抓取） |
| `/search <查询>` 命令 | 手动发起搜索并以通知展示结果 |
| `/deepseek-key` 命令 | 查看当前生效的密钥来源（脱敏显示） |

工具的详细行为说明由扩展自身向模型声明，此处不重复。

## 安装

### pi 终端（`pi` CLI）

```bash
# 发布到 npm 之后
pi install npm:pi-deepseek-web

# 开发期：从本地路径安装
pi install ./pi-deepseek-web
```

验证：`pi list` 中出现 `npm:pi-deepseek-web`。重启会话后工具即生效。

### PI-Desktop

PI-Desktop 不加载 `~/.pi/agent` 下的扩展，需经插件体系导入：

1. 打开 PI-Desktop 的 **插件（Plugins）** 页
2. 点击 **「导入 pi 扩展」**，选择本包所在目录（如 `C:\...\pi-deepseek-web`）
3. 导入成功后以插件形式出现在列表中（ID 形如 `imported.pi-deepseek-web`），启用即可

注意：PI-Desktop 的模型注册表不提供密钥访问，此时密钥走下文密钥解析顺序的第 2 / 3 级回退。

### 启用状态与故障排查

导入后的插件状态由**宿主**保管，落在 `~/.pi-desktop/plugins/registry.json`（每个插件一条记录，关键字段 `enabled` / `status`）：

- **现象**：会话里 `deepseek_search` / `deepseek_fetch` 与 `/search`、`/deepseek-key` 全部消失；插件页显示「已禁用」；`~/.pi-desktop/logs/app/plugin.log` 里有 `plugin.disabled`，且**没有任何 error / warn**（源码与密钥都是好的）
- **处理**：在插件页重新启用该插件，使 `enabled=true`、`status=ready`；日志出现 `plugin.enabled` + `plugin.load.success` 即恢复
- **会话快照**：工具在会话启动那一刻注册，启用后**必须新建会话**，旧会话拿不到
- **升级后易复发**：PI-Desktop 自升级（如 0.21.0 → 0.22.0）会把 `source: "dev"` 的导入插件重置为禁用，升级后回插件页确认一次

这份 `registry.json` 是**逐机器的宿主状态**——含本机绝对路径、其它插件的条目、安装时间戳——不属于插件源码。**不要**把它复制进仓库或纳入版本控制；导入时宿主在 `~/.pi-desktop/plugins/imported/<包名>/` 生成的 `manifest.json` + `main.cjs` 包装层同理，都是生成物。

`imported/<包名>/src/` 是导入瞬间的**整份快照拷贝，不是符号链接**：只改仓库源码对运行中的 PI-Desktop 无效。用仓库内脚本同步：

```bash
pwsh -File scripts/sync-to-pi-desktop.ps1         # 把 index.ts 复制进安装副本
pwsh -File scripts/sync-to-pi-desktop.ps1 -DryRun # 只比对 SHA256，不写入
```

同步后在插件页重载（或重启应用），再新建会话生效。

## 密钥解析顺序

1. **宿主模型注册表** — pi CLI 中即你为 DeepSeek 聊天模型配置的那个 key
2. **环境变量** `DEEPSEEK_API_KEY` — 面向 headless / CI 场景
3. **本地凭据文件** `~/.pi/agent/auth.json` 中的 `deepseek.key` — pi CLI 登录时落盘的同一份密钥，供 PI-Desktop 等无法访问注册表的宿主使用

本扩展只读不写这份文件，也不把密钥包含在任何输出或日志中（`/deepseek-key` 仅显示 `前5位…后4位`）。

## 费用与限流（DeepSeek 官方口径）


- 计费：Search ¥5 / 千次成功请求；Fetch ¥5 / 千次成功请求（失败不计费）
- 限流：各接口 5 QPS
- 本扩展对 429 / 5xx / 网络抖动做指数退避重试（最多 3 次），401 不重试
- 输出截断保护：搜索总量 ≤ 24k 字符（单条 ≤ 3k），抓取 ≤ 20k 字符，防止撑爆上下文

## 开发与发布

唯一源文件：`extensions/deepseek-web/index.ts`，由宿主的 jiti 加载器直接执行，无构建步骤。

```bash
# 类型检查（需本地安装 pi 系列包作为 devDependency）
npx tsc --noEmit

# 打包预览（核对 tarball 内容）
npm pack --dry-run

# 发布
npm publish --registry=https://registry.npmjs.org
```

若 `npm config get registry` 指向镜像（如 `https://registry.npmmirror.com/`），必须显式带上 `--registry=https://registry.npmjs.org`——镜像不接受发布。`~/.npmrc` 里的 `_authToken` 失效时 `npm whoami` 会返回 `E401 Unauthorized`，需先 `npm login`。

`pi` CLI 没有 publish 子命令（只有 `install` / `remove` / `list` / `config`），npm 就是唯一的发布通道；PI-Desktop 插件市场按 catalog 收录本包根目录的 `manifest.json`（`id: io.github.Readon.deepseek-web`）。仓库里的 `scripts/sync-to-pi-desktop.ps1` 只用于本地联调，不在 `package.json` 的 `files` 白名单内，不会进 tarball。
