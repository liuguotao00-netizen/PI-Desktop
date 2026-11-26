(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const bridge = window.pluginBridge;
  const connected = typeof bridge?.invoke === "function";
  const settingKeys = ["pythonPath", "draftRoot", "jianyingPath", "workDir"];
  const sample = {
    title: "我的剪辑", width: 1080, height: 1920, fps: 30,
    clips: [{ path: "D:\\素材\\片段.mp4", start: 0, duration: 5, speed: 1, volume: 1 }],
    audio: [{ path: "D:\\素材\\音乐.mp3", start: 0, duration: 5, at: 0, volume: 0.3 }],
    texts: [{ text: "示例字幕", start: 0, duration: 3, fontSize: 8, color: "#FFFFFF" }],
  };
  const sampleText = JSON.stringify(sample, null, 2);
  let busy = false;
  let stateLoaded = false;
  let savedSettings = null;
  let settingsDirty = false;
  let lastResult = null;
  let builtTimeline = null;
  let publishedJob = null;
  let hostBase = null;
  const systemTheme = window.matchMedia("(prefers-color-scheme: light)");

  function applyAppearance(appearance) {
    hostBase = ["light", "dark"].includes(appearance?.base) ? appearance.base : null;
    document.documentElement.dataset.base = hostBase || (systemTheme.matches ? "light" : "dark");
  }
  applyAppearance(null);
  const onSystemTheme = () => { if (!hostBase) applyAppearance(null); };
  systemTheme.addEventListener("change", onSystemTheme);
  const unsubscribe = bridge?.on?.("appearance:changed", applyAppearance);
  if (connected) {
    Promise.resolve().then(() => bridge.invoke("app.getAppearance"))
      .then(applyAppearance).catch(() => applyAppearance(null));
  }
  window.addEventListener("pagehide", () => {
    systemTheme.removeEventListener("change", onSystemTheme);
    if (typeof unsubscribe === "function") unsubscribe();
  }, { once: true });

  function message(id, text, tone = "neutral") {
    $(id).textContent = text;
    $(id).dataset.tone = tone;
  }
  function readSettings() {
    return Object.fromEntries(settingKeys.map((key) => [key, $(key).value.trim()]));
  }
  function syncControls() {
    const stateRequired = new Set(["saveSettings", "setup", "validate", "build", "publish", "launch"]);
    document.querySelectorAll("[data-action]").forEach((button) => {
      const hostUnavailable = button.hasAttribute("data-host") && !connected;
      button.disabled = busy || hostUnavailable || (stateRequired.has(button.id) && !stateLoaded)
        || (button.id === "publish" && (!lastResult?.jobDir || publishedJob === lastResult.jobDir));
      button.title = hostUnavailable ? "浏览器预览，不连接本地剪映"
        : stateRequired.has(button.id) && !stateLoaded ? "请先成功读取插件状态" : "";
    });
    document.querySelectorAll("input, textarea").forEach((input) => { input.readOnly = busy; });
  }
  function showRaw(label, result, open = true) {
    $("diagnosticOutput").textContent = JSON.stringify({ operation: label, result }, null, 2);
    if (open) $("diagnostics").open = true;
  }
  async function invoke(channel, payload = {}) {
    if (!connected) throw new Error("浏览器预览，不连接本地剪映");
    // The host forwards unknown channels directly to main.onPanelInvoke.
    const result = await bridge.invoke(channel, payload);
    if (!result || typeof result !== "object" || result.ok !== true) {
      const error = new Error(typeof result?.error === "string" ? result.error : "插件返回格式异常：缺少 ok: true。请查看原始返回。");
      error.response = result ?? null;
      throw error;
    }
    showRaw(channel, result, channel !== "jy.state");
    return result;
  }
  async function run(id, label, action) {
    if (busy || $(id).disabled) return;
    busy = true;
    const button = $(id);
    const oldLabel = button.textContent;
    button.textContent = `${label}…`;
    button.setAttribute("aria-busy", "true");
    syncControls();
    message("feedback", `${label}中，请稍候。`);
    try {
      const success = await action();
      message("feedback", success || "已取消，未执行操作。", success ? "success" : "neutral");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message("feedback", `${label}失败：${detail}`, "error");
      showRaw(label, error?.response ?? { ok: false, error: detail });
      if (id === "refresh") message("connection", "状态读取失败", "error");
      if (id === "doctor") message("doctorStatus", "诊断失败；环境状态未知，请查看原始返回。", "error");
      if (id === "validate" || id === "build") message("jsonMessage", `${label}失败：${detail}。编辑内容已保留。`, "error");
      if (id === "build") message("resultState", lastResult ? "生成失败 · 保留上次结果" : "生成失败", "error");
    } finally {
      busy = false;
      button.textContent = oldLabel;
      button.removeAttribute("aria-busy");
      syncControls();
      if (document.activeElement === document.body && !button.disabled) button.focus({ preventScroll: true });
    }
  }
  function bind(id, label, action) {
    $(id).addEventListener("click", () => { void run(id, label, action); });
  }
  function confirmAction(title, text, accept) {
    const dialog = $("confirmDialog");
    $("confirmTitle").textContent = title;
    $("confirmMessage").textContent = text;
    $("confirmAccept").textContent = accept;
    dialog.returnValue = "cancel";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
      dialog.showModal();
    });
  }
  function requireSavedSettings() {
    if (settingsDirty) throw new Error("环境设置有未保存的修改，请先保存设置。");
  }
  function parseTimeline() {
    try {
      const timeline = JSON.parse($("timeline").value);
      if (!timeline || typeof timeline !== "object" || Array.isArray(timeline)) {
        throw new Error("时间轴必须是 JSON 对象，而不是数组或单个值。");
      }
      $("timeline").setAttribute("aria-invalid", "false");
      return timeline;
    } catch (error) {
      $("timeline").setAttribute("aria-invalid", "true");
      message("jsonMessage", `JSON 错误：${error.message}。内容已保留，请在编辑器中修正。`, "error");
      $("timeline").focus();
      throw error;
    }
  }
  function markTimelineChanged() {
    $("timeline").setAttribute("aria-invalid", "false");
    message("jsonMessage", "内容已修改，尚未校验。示例素材路径需替换为真实路径。");
    $("staleResult").hidden = !lastResult || (builtTimeline !== null && builtTimeline === $("timeline").value);
  }
  function renderResult(result, sourceText = null) {
    if (!result || typeof result.jobDir !== "string" || !result.jobDir.trim()
      || typeof result.draftDir !== "string" || !result.draftDir.trim()
      || typeof result.title !== "string" || typeof result.duration !== "number" || !Number.isFinite(result.duration)
      || result.duration < 0 || !Array.isArray(result.warnings) || result.ok === false) {
      throw Object.assign(new Error("生成结果格式不完整，无法安全导入。请查看原始返回。"), { response: result });
    }
    if (lastResult?.jobDir !== result.jobDir) publishedJob = null;
    lastResult = result;
    builtTimeline = sourceText;
    $("resultEmpty").hidden = true;
    $("resultContent").hidden = false;
    $("resultTitle").textContent = result.title || "未命名工程";
    $("resultDuration").textContent = `${result.duration.toLocaleString("zh-CN", { maximumFractionDigits: 3 })} 秒`;
    $("resultJob").textContent = result.jobDir;
    $("resultDraft").textContent = result.draftDir;
    $("resultOutput").textContent = JSON.stringify(result, null, 2);
    $("warnings").replaceChildren(...result.warnings.map((warning) => {
      const item = document.createElement("li");
      item.textContent = typeof warning === "string" ? warning : JSON.stringify(warning);
      return item;
    }));
    $("warnings").hidden = result.warnings.length === 0;
    $("staleResult").textContent = sourceText === null
      ? "这是上次生成的结果，与当前编辑器内容不一定一致。导入前请核对工程名称和路径。"
      : "时间轴已有修改，下方仍是上次生成的结果；导入不会包含当前修改。";
    $("staleResult").hidden = sourceText !== null;
    message("resultState", sourceText === null ? "上次生成结果" : "草稿已生成", "success");
    $("publishState").textContent = publishedJob === result.jobDir ? "此任务已导入，避免重复复制。" : "尚未导入";
  }
  let currentWorkspace = null;
  async function refresh() {
    const state = await invoke("jy.state");
    if (!state.settings || !settingKeys.every((key) => typeof state.settings[key] === "string") || typeof state.workspace !== "string") {
      throw Object.assign(new Error("状态返回格式异常：缺少环境设置或工作区。"), { response: state });
    }
    if (currentWorkspace !== null && currentWorkspace !== state.workspace) {
      lastResult = null;
      builtTimeline = null;
      publishedJob = null;
      $("resultContent").hidden = true;
      $("resultEmpty").hidden = false;
      $("publishState").textContent = "";
      message("resultState", "工作区已切换 · 等待生成");
      message("doctorStatus", "工作区已切换，请重新运行诊断。时间轴编辑内容已保留。");
    }
    currentWorkspace = state.workspace;
    const preserveEdits = settingsDirty;
    savedSettings = Object.fromEntries(settingKeys.map((key) => [key, state.settings[key]]));
    if (!preserveEdits) settingKeys.forEach((key) => { $(key).value = savedSettings[key]; });
    stateLoaded = true;
    $("settingsState").textContent = preserveEdits ? "未保存 · 已保留" : "已读取";
    $("workspacePath").textContent = state.workspace || "未设置工作区";
    message("connection", "插件已连接", "success");
    if (state.lastResult && (!lastResult || state.lastResult.jobDir !== lastResult.jobDir)) {
      try { renderResult(state.lastResult); }
      catch (error) {
        message("resultState", "历史结果不可导入", "error");
        showRaw("jy.state", state);
        return `状态已读取；${error.message}`;
      }
    }
    return preserveEdits ? "状态已刷新；未保存设置和时间轴内容已保留。" : "状态已读取。请运行诊断确认环境，不代表环境已就绪。";
  }

  $("timeline").value = sampleText;
  $("timeline").addEventListener("input", markTimelineChanged);
  settingKeys.forEach((key) => $(key).addEventListener("input", () => {
    settingsDirty = !savedSettings || settingKeys.some((name) => $(name).value.trim() !== savedSettings[name]);
    $("settingsState").textContent = settingsDirty ? "未保存" : "已保存";
  }));
  bind("refresh", "读取状态", refresh);
  bind("doctor", "运行诊断", async () => {
    await invoke("jy.doctor");
    message("doctorStatus", "诊断已返回，请展开原始返回查看各项检查；不代表全部就绪。");
    return "诊断已返回，请查看「原始返回」。";
  });
  $("settingsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void run("saveSettings", "保存设置", async () => {
      const settings = readSettings();
      await invoke("jy.settings", settings);
      savedSettings = settings;
      settingsDirty = false;
      settingKeys.forEach((key) => { $(key).value = settings[key]; });
      $("settingsState").textContent = "已保存";
      message("doctorStatus", "设置已更新，请重新运行诊断确认环境。");
      return "环境设置已保存。";
    });
  });
  bind("setup", "安装依赖", async () => {
    requireSavedSettings();
    const accepted = await confirmAction("联网安装 Python 依赖？", "将使用已保存的 Python 配置，从网络下载并安装所需 Python 包。此操作会更改本地 Python 环境，不包含下载或安装 Python 本体。\n\n请确认网络来源和环境可信后继续。", "确认安装");
    if (!accepted) return null;
    await invoke("jy.setup", { confirmed: true });
    message("doctorStatus", "依赖安装已返回，请重新运行诊断；不代表环境已就绪。");
    return "依赖安装操作已返回，请查看结果并重新诊断。";
  });
  bind("probe", "探测素材", async () => {
    const path = $("probePath").value.trim();
    if (!path) { $("probePath").focus(); throw new Error("请填写要探测的素材路径。"); }
    await invoke("jy.probe", { path });
    return "素材探测已返回，请查看「原始返回」。";
  });
  bind("loadExample", "载入示例", async () => {
    if ($("timeline").value.trim() && $("timeline").value !== sampleText) {
      if (!await confirmAction("替换当前时间轴？", "载入示例会替换编辑器中的当前内容。请先复制保留需要的内容；取消不会丢失编辑。", "替换为示例")) return null;
    }
    $("timeline").value = sampleText;
    markTimelineChanged();
    message("jsonMessage", "示例数据已载入。请替换素材路径；示例不会创建素材。");
    return "已载入示例数据，尚未进行素材或时间轴校验。";
  });
  bind("checkJson", "检查 JSON", async () => {
    parseTimeline();
    message("jsonMessage", "JSON 语法正确；尚未验证时间轴字段、素材或本地环境。", "success");
    return "JSON 语法检查通过；不代表可生成草稿。";
  });
  bind("validate", "校验时间轴", async () => {
    const timeline = parseTimeline();
    requireSavedSettings();
    await invoke("jy.validate", { timeline });
    message("jsonMessage", "时间轴校验已通过，请查看原始返回中的详情或警告。", "success");
    return "时间轴校验已通过。";
  });
  bind("build", "生成草稿", async () => {
    const timeline = parseTimeline();
    requireSavedSettings();
    const sourceText = $("timeline").value;
    const result = await invoke("jy.build", { timeline });
    renderResult(result, sourceText);
    message("jsonMessage", "本次时间轴已生成草稿，请核对生成结果与警告。", "success");
    return "草稿已生成，尚未导入剪映，也未导出 MP4。";
  });
  bind("publish", "导入草稿", async () => {
    requireSavedSettings();
    if (!lastResult?.jobDir) throw new Error("请先生成草稿。");
    if (!savedSettings?.draftRoot.trim()) throw new Error("请先填写并保存剪映草稿目录。");
    const jobDir = lastResult.jobDir;
    const accepted = await confirmAction("复制为新的剪映工程？", `将复制下方任务中的草稿到已保存的剪映草稿目录，不覆盖原工程。\n\n任务：${jobDir}\n目标：${savedSettings.draftRoot}\n\n${$("staleResult").hidden ? "请确认工程路径正确。" : "注意：此结果与当前编辑器内容不一定一致，导入的是上次生成的草稿。"}`, "确认复制新工程");
    if (!accepted) return null;
    await invoke("jy.publish", { jobDir, confirmed: true });
    publishedJob = jobDir;
    $("publishState").textContent = "此任务已导入，避免重复复制。";
    message("resultState", "已导入", "success");
    return "草稿导入已返回成功，请在剪映中核对新工程。";
  });
  bind("launch", "启动剪映", async () => {
    requireSavedSettings();
    await invoke("jy.launch", {});
    return "启动操作已返回成功；请在剪映中手动选择草稿。";
  });

  $("previewNotice").hidden = connected;
  if (!connected) {
    message("connection", "浏览器预览");
    message("feedback", "可载入示例或检查 JSON；不会读取、安装或写入本机文件。");
    $("settingsState").textContent = "仅预览";
  }
  syncControls();
  if (connected) void run("refresh", "读取状态", refresh);
})();
