# 剪映助手 · PI-Desktop 插件

版本 **0.1.1** · 插件 ID `cn.star.jianying-assistant`


运行要求：Windows 10/11、.NET Framework 4（Windows 通常已内置），以及 Python 3.10+。后台任务由随包提供的 `process-helper.exe` 托管 Windows Job Object，异常退出、超时或卸载时结束辅助进程树；不会关闭用户的剪映窗口。辅助程序的完整源码为 `process-helper.cs`，运行时不使用 PowerShell、不编译、不写临时缓存。若系统禁止执行辅助程序，会明确报错，不降级为不受控执行。
在 PI-Desktop 中用自然语言规划剪辑，通过本地工具生成可编辑的剪映草稿。中文面板可用于环境配置、媒体探测、JSON 时间轴编辑和工程导入。视觉参考用户指定的 PureSuck / started 主题：柔和粉色、圆角卡片、浅灰底色与轻阴影；支持宿主深浅主题。

## 功能

- 只读检测 Python、草稿库、剪映安装目录和候选草稿路径。
- 显式确认后，在**当前工作区**安装隔离的 Python venv 与 `pyJianYingDraft==0.3.0`。
- 读取本地音视频时长、轨道信息，校验源截取边界。
- 按顺序截取拼接视频，设置变速和音量；添加背景音频及带颜色的文字字幕，支持重叠音频/字幕分轨。
- 保存独立工程和时间轴 JSON；导入前备份，只新增工程，不覆盖旧草稿。
- 启动剪映；通过附带技能衔接可选的 Computer Use 插件进行预览和导出。

**不包含**：自动识别精彩片段、语音转字幕、转场/滤镜编辑、直接修改现有加密草稿、一键 MP4 导出、云渲染。生成工程不等于导出视频。首版仍需在目标剪映版本中验证打开和渲染效果。

## 安装与首次使用

1. 在 PI-Desktop 插件管理中安装 `dist/cn.star.jianying-assistant-0.1.1.piplug`。源码开发模式也可直接加载本目录。
2. 打开一个用于视频工作的**项目工作区**，运行命令 **“剪映助手：打开面板”**。
3. 点“检测环境”。需要本机已有 Python **3.10+**（建议 3.11；本次开发也使用 3.14），并可访问 PyPI。Windows 商店的占位 `python.exe` 不算有效 Python。
4. 在设置中填写/确认路径：
   - `pythonPath`：可留空自动检测；或指定真实 Python 可执行文件。
   - `workDir`：默认 `Jianying`，必须位于当前工作区内。
   - `draftRoot`：剪映草稿根目录，**必须亲自确认并保存后才能导入**。检测候选不会自动取得写入授权。常见位置为 `%LOCALAPPDATA%\JianyingPro\User Data\Projects\com.lveditor.draft`，自定义位置应以剪映设置为准。
   - `jianyingPath`：可留空自动检测，或指定 `JianyingPro.exe`。
5. 保存设置，然后确认安装本地依赖。安装过程可能需要数分钟，不会下载 Python 本体。
6. 向 PI 提供真实素材路径与剪辑要求，例如：

   > 用剪映助手把工作区“素材”里的开场.mp4 的第1～5秒和展示.mp4的前6秒拼接，第二段2倍速，加“新品介绍”字幕，配背景音乐，生成1080×1920草稿。

7. 也可在面板载入示例，替换素材路径后校验、生成。导入草稿后在剪映首页刷新/重启查看新工程。

## 输出与安全

默认目录：

```text
<当前工作区>/Jianying/
  .runtime/        隔离 Python 环境、依赖缓存及临时文件
  jobs/<唯一名称>/
    timeline.json  归一化后的剪辑方案
    result.json    生成结果
    draft/         剪映草稿文件
  backups/         导入前备份
```

- 不修改原视频；草稿引用素材**绝对路径**，备份工程不包含媒体本体。移动/删除素材会造成离线。
- 不上传素材、不调用第三方云渲染。仅安装依赖时访问 PyPI 及其包下载域名。
- 导入只复制本插件生成的工程，新目标使用唯一名称；不修改剪映全局工程索引，也不会关闭用户正在编辑的窗口。
- 插件使用 Node 本地文件和进程 API，PI 权限列表不是操作系统沙箱。请只安装可信来源的插件；manifest 中已披露原生访问行为。
- 卸载插件不自动删除工作区的工程、备份或运行环境。

## Agent 工具

| 工具 | 用途 |
| --- | --- |
| `check_environment` | 只读环境诊断 |
| `setup_environment` | 确认后安装隔离依赖 |
| `inspect_media` | 读取本地媒体信息 |
| `validate_timeline` | 输入与实际时长校验 |
| `create_draft` | 生成新草稿，返回 jobDir |
| `import_draft` | 确认后备份并导入 |
| `launch_jianying` | 仅启动剪映 |

详细 timeline 示例和字段说明见 [使用技能](skills/pi-jianying-assistant.md)。面板 JSON 与 Agent 工具共用同一后端，不会出现两套剪辑逻辑。

## 版本兼容与导出

底层库固定为 [pyJianYingDraft 0.3.0](https://pypi.org/project/pyJianYingDraft/0.3.0/)。上游文档列出剪映 10.8 的部分新草稿支持，但这**不等于**对剪映 11.x 的兼容保证。

上游旧 GUI 自动导出主要适用剪映 6 及以下；本插件不调用它。新版导出需用户在剪映中完成，或由已配置的 Computer Use 插件根据真实窗口观察执行。只有实际检查成片文件后才能判定导出成功。

## 开发与验证

无需 npm 依赖。所有临时产物放 `PI_SCRATCH_DIR`，不要在插件目录安装 Python venv。

```powershell
node --test .\tests\*.test.js
# Python 测试需要 pyJianYingDraft 0.3.0 和 PATH 中的 FFmpeg：
python .\tests\test_bridge.py
```

真实端到端测试（会从 PyPI 安装依赖，全部产物在 scratch）：

```powershell
$env:JY_INTEGRATION_PYTHON = '已安装的真实 Python 可执行文件完整路径'
node --test .\tests\integration.test.js
```

实机验收：通过已安装插件的真实 Agent 工具完成依赖安装、素材探测、6 秒时间轴校验、草稿生成、备份和导入。剪映 11.5.0.14471 自动识别新工程，编辑器正常显示两段视频、中文字幕与音频轨；播放到结束后第二段粉色画面和字幕正常。随后通过 Computer Use 操作剪映导出 MP4，ffprobe 确认 1920×1080、30fps、H.264、6 秒视频和 AAC 音轨；ffmpeg 完整解码无错误。此为“插件生成草稿 + 桌面工具操作导出”的实测，不代表插件内置无界面自动导出。

打包使用 PI-Desktop 的 `PluginCheck` 和 `PluginPack`，不要自行压缩为 `.piplug`。

## 来源与许可

插件代码 MIT。pyJianYingDraft 由用户安装至隔离运行环境，其自身许可适用于该依赖；没有将上游库代码复制到插件中。UI 仅参考 [PureSuck-theme](https://github.com/MoXiaoXi233/PureSuck-theme) 的视觉风格，未复用网站逻辑或品牌图片。

## 0.1.1 修复

修复 PI 宿主仅传递最小环境变量时找不到 Python/剪映的问题：环境变量名兼容大小写，缺少 APPDATA/LOCALAPPDATA 时只读使用系统用户目录兜底；显式配置优先。Python 子进程仅补必要用户目录变量，所有缓存仍限定在工作区，不恢复宿主完整环境，也不自动授权草稿导入。
