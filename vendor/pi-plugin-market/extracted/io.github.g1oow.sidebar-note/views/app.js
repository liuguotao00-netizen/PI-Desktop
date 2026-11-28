/*
 * 笔记（Notes）— 视图页脚本
 *
 * 页面只有 window.pluginBridge：内置通道（appearance / toast）走宿主，其余全部是
 * 本插件自己的通道（note:*），由 main.js 的 onPanelInvoke 处理。
 *
 * 两条硬约束：
 *   ① 页面里出现的任何用户文本都走 textContent / text node，从不拼 innerHTML。
 *   ② 链接只认 http(s) / mailto；沙箱页面不能自己开浏览器，所以点击复制链接。
 */
(function () {
  "use strict";

  const bridge = window.pluginBridge;
  const SAVE_DEBOUNCE_MS = 600;
  const LIST_REFRESH_MIN_MS = 4000;
  const PREF_KEY = "sidebar-note.webview-ui";
  const STRINGS = {
    "zh-CN": {
      newNote: "新建",
      searchPlaceholder: "搜索笔记",
      clearSearch: "清除搜索",
      tabInbox: "收件箱",
      tabProject: "项目",
      tabAll: "全部",
      pinnedGroup: "置顶",
      recentGroup: "笔记",
      untitled: "无标题",
      inboxLabel: "收件箱",
      emptyTitle: "还没有笔记",
      emptySub: "笔记按项目分开保存，收件箱则跨项目通用。",
      emptyAction: "新建笔记",
      emptySearchTitle: "没有匹配的笔记",
      emptySearchSub: "换个关键词，或者切到其他范围看看。",
      noProjectHint: "当前没有打开的项目，这里显示收件箱。",
      titlePlaceholder: "标题（可留空）",
      bodyPlaceholder: "开始写…支持 Markdown",
      modeEdit: "编辑",
      modePreview: "预览",
      tipNew: "新建笔记 (Ctrl+N)",
      tipBack: "返回列表 (Esc)",
      tipCopy: "复制正文",
      tipDelete: "删除笔记",
      tipZoom: "缩放",
      tipTheme: "切换深浅色",
      tipSave: "保存 (Ctrl+S)",
      saveLabel: "保存",
      unsavedTitle: "有未保存的修改",
      unsavedBody: "这篇笔记还没保存，要先保存再离开吗？",
      unsavedSave: "保存并离开",
      unsavedDiscard: "放弃修改",
      unsavedCancel: "取消",
      zoomAuto: "自适应",
      zoomReset: "重置",
      zoomRange: "缩放比例",
      zoomHintAuto: "跟随面板宽度",
      zoomHintManual: "手动缩放",
      copyCode: "复制代码",
      copiedCode: "代码已复制",
      taskCheck: "标记为已完成",
      taskUncheck: "标记为未完成",
      back: "返回列表",
      pin: "置顶",
      unpin: "取消置顶",
      copy: "复制正文",
      remove: "删除笔记",
      dirty: "未保存",
      saving: "保存中…",
      saved: "已保存",
      saveFailed: "保存失败",
      deleted: "已删除",
      undo: "撤销",
      restored: "已恢复",
      pinnedOn: "已置顶",
      pinnedOff: "已取消置顶",
      copied: "已复制正文",
      linkCopied: "链接已复制，粘贴到浏览器即可打开",
      nothingToCopy: "没有可复制的内容",
      linkHint: "点击复制链接（沙箱页面不能直接打开外链）",
      chars: "字",
      bridgeMissing: "这个页面需要在 PI-Desktop 的笔记视图里打开。",
      loadFailed: "读取失败",
      emptyPreview: "（正文为空）",
      yesterday: "昨天",
      switchBlocked: "上一个项目的改动没保存成功，先留在原处",
    },
    en: {
      newNote: "New",
      searchPlaceholder: "Search notes",
      clearSearch: "Clear search",
      tabInbox: "Inbox",
      tabProject: "Project",
      tabAll: "All",
      pinnedGroup: "Pinned",
      recentGroup: "Notes",
      untitled: "Untitled",
      inboxLabel: "Inbox",
      emptyTitle: "No notes yet",
      emptySub: "Notes are kept per project; the inbox is shared across projects.",
      emptyAction: "New note",
      emptySearchTitle: "No matching notes",
      emptySearchSub: "Try another keyword, or switch scope.",
      noProjectHint: "No project is open, so this shows the inbox.",
      titlePlaceholder: "Title (optional)",
      bodyPlaceholder: "Start typing… Markdown supported",
      modeEdit: "Edit",
      modePreview: "Preview",
      tipNew: "New note (Ctrl+N)",
      tipBack: "Back to list (Esc)",
      tipCopy: "Copy body",
      tipDelete: "Delete note",
      tipZoom: "Zoom",
      tipTheme: "Toggle theme",
      tipSave: "Save (Ctrl+S)",
      saveLabel: "Save",
      unsavedTitle: "Unsaved changes",
      unsavedBody: "This note has unsaved edits. Save before leaving?",
      unsavedSave: "Save and leave",
      unsavedDiscard: "Discard",
      unsavedCancel: "Cancel",
      zoomAuto: "Adaptive",
      zoomReset: "Reset",
      zoomRange: "Zoom level",
      zoomHintAuto: "Follows panel width",
      zoomHintManual: "Manual zoom",
      copyCode: "Copy code",
      copiedCode: "Code copied",
      taskCheck: "Mark as done",
      taskUncheck: "Mark as not done",
      back: "Back to list",
      pin: "Pin",
      unpin: "Unpin",
      copy: "Copy body",
      remove: "Delete note",
      dirty: "Unsaved",
      saving: "Saving…",
      saved: "Saved",
      saveFailed: "Save failed",
      deleted: "Deleted",
      undo: "Undo",
      linkCopied: "Link copied — paste it in a browser",
      restored: "Restored",
      pinnedOn: "Pinned",
      pinnedOff: "Unpinned",
      copied: "Body copied",
      nothingToCopy: "Nothing to copy",
      linkHint: "Click to copy the link (a sandboxed page cannot open it)",
      chars: "chars",
      bridgeMissing: "Open this page from the Notes view inside PI-Desktop.",
      loadFailed: "Could not load",
      emptyPreview: "(empty note)",
      yesterday: "Yesterday",
      switchBlocked: "The previous project's edits could not be saved, staying here",
    },
  };

  const state = {
    locale: "en",
    theme: "dark",
    scope: "project",
    effectiveScope: "project",
    query: "",
    items: [],
    counts: { inbox: 0, project: 0, all: 0 },
    project: { key: "", name: "" },
    hasProject: false,
    mode: "list",
    current: null,
    dirty: false,
    preview: false,
    zoom: { auto: true, value: 100 },
    themeMode: "system",
    hostTheme: "dark",
  };

  const els = {};
  let saveTimer = null;
  /** 正在进行的那次保存；切项目 / 切笔记前要等它落地。 */
  let savePromise = null;
  let snackTimer = null;
  let lastListAt = 0;
  let searchTimer = null;
  let prefsTimer = null;

  const SVG_NS = "http://www.w3.org/2000/svg";

  /**
   * 动态创建的图标必须建在 SVG 命名空间里：document.createElement("svg") 得到的是
   * HTMLUnknownElement，挂了 <use> 也不会绘制（表现为“图标不显示”）。
   */
  function iconUse(symbolId, className) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", className || "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", `#${symbolId}`);
    svg.append(use);
    return svg;
  }


  function t(key) {
    const table = STRINGS[state.locale] || STRINGS.en;
    return table[key] || STRINGS.en[key] || key;
  }

  function el(tag) {
    return document.createElement(tag);
  }

  function call(channel, payload) {
    if (!bridge || typeof bridge.invoke !== "function") {
      return Promise.reject(new Error(t("bridgeMissing")));
    }
    return bridge.invoke(channel, payload || {});
  }

  function errorText(error) {
    const message = error && error.message ? String(error.message) : String(error || "");
    return message.replace(/^Error invoking remote method '[^']*':\s*/, "").trim() || t("loadFailed");
  }

  function formatClock(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString(state.locale, { hour: "2-digit", minute: "2-digit" });
  }

  function formatRelative(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return formatClock(iso);
    const yesterday = new Date(now.getTime() - 86400000);
    if (date.toDateString() === yesterday.toDateString()) return t("yesterday");
    if (date.getFullYear() === now.getFullYear()) {
      return date.toLocaleDateString(state.locale, { month: "numeric", day: "numeric" });
    }
    return date.toLocaleDateString(state.locale, { year: "numeric", month: "numeric", day: "numeric" });
  }

  function countChars(text) {
    return String(text || "").replace(/\s+/g, "").length;
  }

  // ── 外观与文案 ────────────────────────────────────────────────────────────

  function effectiveTheme() {
    return state.themeMode === "system" ? state.hostTheme : state.themeMode;
  }

  /** 默认跟随宿主外观；用户手动切过之后以本地偏好为准。 */
  function applyTheme() {
    state.theme = effectiveTheme();
    document.documentElement.dataset.theme = state.theme;
    renderThemeButton();
  }

  function renderThemeButton() {
    if (!els.themeBtn) return;
    const dark = state.theme === "dark";
    const use = els.themeBtn.querySelector("use");
    // 图标显示“点一下会切到哪种模式”：深色时给太阳，浅色时给月亮。
    if (use) use.setAttribute("href", dark ? "#i-sun" : "#i-moon");
    const label = t("tipTheme");
    els.themeBtn.dataset.tip = label;
    els.themeBtn.setAttribute("aria-label", label);
  }

  function toggleTheme() {
    state.themeMode = effectiveTheme() === "dark" ? "light" : "dark";
    applyTheme();
    savePrefs();
  }

  function applyAppearance(appearance) {
    const locale = typeof appearance?.locale === "string" ? appearance.locale : "";
    state.locale = /^zh/i.test(locale) ? "zh-CN" : "en";
    state.hostTheme = appearance?.base === "light" ? "light" : "dark";
    document.documentElement.lang = state.locale;
    applyTheme();
    applyStrings();
  }

  function applyStrings() {
    document.title = state.locale === "zh-CN" ? "笔记" : "Notes";
    els.newNoteLabel.textContent = t("newNote");
    els.searchInput.placeholder = t("searchPlaceholder");
    els.clearSearch.setAttribute("aria-label", t("clearSearch"));
    els.tabInbox.textContent = t("tabInbox");
    els.tabProject.textContent = t("tabProject");
    els.tabAll.textContent = t("tabAll");
    els.titleInput.placeholder = t("titlePlaceholder");
    els.bodyInput.placeholder = t("bodyPlaceholder");
    renderModeSwitch();
    els.emptyTitle.textContent = t("emptyTitle");
    els.emptySub.textContent = t("emptySub");
    els.emptyNew.textContent = t("emptyAction");
    els.backBtn.setAttribute("aria-label", t("back"));
    els.backBtn.dataset.tip = t("tipBack");
    els.copyBtn.setAttribute("aria-label", t("copy"));
    els.copyBtn.dataset.tip = t("tipCopy");
    els.deleteBtn.setAttribute("aria-label", t("remove"));
    els.deleteBtn.dataset.tip = t("tipDelete");
    els.newNote.dataset.tip = t("tipNew");
    els.zoomBtn.dataset.tip = t("tipZoom");
    els.zoomBtnEditor.dataset.tip = t("tipZoom");
    els.saveBtn.dataset.tip = t("tipSave");
    els.saveBtn.setAttribute("aria-label", t("saveLabel"));
    els.unsavedTitle.textContent = t("unsavedTitle");
    els.unsavedBody.textContent = t("unsavedBody");
    els.unsavedSave.textContent = t("unsavedSave");
    els.unsavedDiscard.textContent = t("unsavedDiscard");
    els.unsavedCancel.textContent = t("unsavedCancel");
    renderThemeButton();
    els.zoomAutoLabel.textContent = t("zoomAuto");
    els.autoSwitch.setAttribute("aria-label", t("zoomAuto"));
    els.zoomReset.textContent = t("zoomReset");
    els.zoomRange.setAttribute("aria-label", t("zoomRange"));
    renderZoom();
    renderPinButton();
    renderStatus();
    if (state.mode === "list") renderList();
  }

  async function syncAppearance() {
    try {
      applyAppearance(await call("app.getAppearance"));
    } catch {
      applyAppearance(null);
    }
  }

  // ── 提示条 ────────────────────────────────────────────────────────────────

  function hideSnack() {
    clearTimeout(snackTimer);
    snackTimer = null;
    els.snack.hidden = true;
  }

  function showSnack(text, actionLabel, onAction, ms) {
    els.snackText.textContent = text;
    if (actionLabel && typeof onAction === "function") {
      els.snackAction.hidden = false;
      els.snackAction.textContent = actionLabel;
      els.snackAction.onclick = () => {
        hideSnack();
        onAction();
      };
    } else {
      els.snackAction.hidden = true;
      els.snackAction.onclick = null;
    }
    els.snack.hidden = false;
    clearTimeout(snackTimer);
    snackTimer = setTimeout(hideSnack, ms || 4000);
  }

  // ── 列表 ──────────────────────────────────────────────────────────────────

  function renderTabs() {
    for (const button of els.scopeTabs.querySelectorAll("button")) {
      const scope = button.dataset.scope;
      button.setAttribute("aria-selected", String(scope === state.effectiveScope));
      const badge = button.querySelector(".count");
      if (badge) badge.textContent = String(state.counts[scope] || 0);
    }
    layoutSegThumb(els.scopeTabs);
  }

  function renderHint() {
    const noProject = state.scope === "project" && state.effectiveScope === "inbox";
    els.scopeHint.hidden = !noProject;
    els.scopeHint.textContent = noProject ? t("noProjectHint") : "";
  }

  function itemNode(meta) {
    const wrap = el("div");
    wrap.className = "item-wrap";

    const button = el("button");
    button.type = "button";
    button.className = "item";
    button.dataset.id = meta.id;

    const top = el("div");
    top.className = "item-top";
    const title = el("span");
    title.className = "item-title";
    const display = meta.displayTitle || "";
    title.textContent = display || t("untitled");
    if (!display) title.classList.add("is-untitled");
    top.append(title);
    button.append(top);

    if (meta.excerpt) {
      const excerpt = el("div");
      excerpt.className = "item-excerpt";
      excerpt.textContent = meta.excerpt;
      button.append(excerpt);
    }

    const metaRow = el("div");
    metaRow.className = "item-meta";
    const time = el("span");
    time.textContent = formatRelative(meta.updatedAt);
    metaRow.append(time);
    if (state.effectiveScope === "all") {
      const sep = el("span");
      sep.className = "sep";
      sep.textContent = "·";
      const project = el("span");
      project.textContent = meta.projectName || t("inboxLabel");
      metaRow.append(sep, project);
    }
    button.append(metaRow);
    button.addEventListener("click", () => openNote(meta.id));

    // 图钉是卡片外的独立按钮（button 不能套 button）：点它只切置顶，不打开笔记。
    const pin = el("button");
    pin.type = "button";
    pin.className = meta.pinned ? "item-pin" : "item-pin is-off";
    pin.dataset.id = meta.id;
    pin.append(iconUse("i-pin"));
    pin.setAttribute("aria-pressed", String(Boolean(meta.pinned)));
    const pinLabel = meta.pinned ? t("unpin") : t("pin");
    pin.setAttribute("aria-label", pinLabel);
    pin.dataset.tip = pinLabel;
    pin.addEventListener("click", (event) => {
      event.stopPropagation();
      void setCardPin(meta.id, !meta.pinned);
    });

    wrap.append(button, pin);
    return wrap;
  }

  function renderList() {
    const list = els.listGroups;
    list.textContent = "";

    const items = state.items;
    if (!items.length) {
      els.emptyState.hidden = false;
      els.emptyTitle.textContent = state.query ? t("emptySearchTitle") : t("emptyTitle");
      els.emptySub.textContent = state.query ? t("emptySearchSub") : t("emptySub");
      els.emptyNew.hidden = Boolean(state.query);
      return;
    }
    els.emptyState.hidden = true;

    const pinned = items.filter((item) => item.pinned);
    const rest = items.filter((item) => !item.pinned);

    const appendGroup = (label, group) => {
      if (!group.length) return;
      if (label) {
        const heading = el("div");
        heading.className = "group-label";
        heading.textContent = label;
        list.append(heading);
      }
      for (const meta of group) list.append(itemNode(meta));
    };

    appendGroup(pinned.length && rest.length ? t("pinnedGroup") : "", pinned);
    appendGroup(pinned.length ? t("recentGroup") : "", rest);
    list.scrollTop = 0;
  }

  /**
   * 取列表数据并写进 state。options.defer 为真时只更新数据、不渲染（切项目时不能
   * 让旧笔记先闪一下）；options.token 与当前同步令牌不一致时整个结果作废，
   * 免得慢回来的旧响应盖掉新项目的状态。
   */
  async function refreshList(options) {
    let data;
    try {
      data = await call("note:list", { scope: state.scope, query: state.query });
    } catch (error) {
      showSnack(errorText(error), null, null, 5000);
      return null;
    }
    if (options?.token !== undefined && options.token !== syncToken) return null;
    state.effectiveScope = data.scope || state.scope;
    state.items = Array.isArray(data.items) ? data.items : [];
    state.counts = data.counts || state.counts;
    state.project = data.project || { key: "", name: "" };
    state.hasProject = Boolean(data.hasProject);
    lastListAt = Date.now();
    renderTabs();
    renderHint();
    if (options?.defer) return data;
    if (state.mode === "list") renderList();
    else renderEditorChrome();
    return data;
  }

  /** 回到列表态（不重新取列表数据，调用方负责刷新）。 */
  function enterListMode() {
    state.mode = "list";
    state.current = null;
    state.preview = false;
    els.editorPane.hidden = true;
    els.listBar.hidden = false;
    els.listPane.hidden = false;
    renderList();
  }

  async function showList() {
    // 切项目也会重新进入列表态：记下同步令牌，中途被 syncProject 抢先就不要再清记忆
    const token = syncToken;
    await flushSave();
    enterListMode();
    await refreshList();
    if (token !== syncToken) return;
    // 回到列表 = 这个项目没有正在打开的笔记，清掉记忆（切换项目再回来时显示列表）。
    // 等它落地再返回，避免紧接着「打开某条笔记」的写入被这次清空盖掉。
    await rememberActive("");
  }

  // ── 跟随项目切换 ──────────────────────────────────────────────────────────

  /** 上一次同步到的工作区项目键；null 表示还没同步过。 */
  let projectKey = null;
  let syncToken = 0;

  /**
   * 记住「这个项目正在看哪条笔记」，切换项目后据此恢复；空 id 表示回到列表。
   * 只传笔记 id：项目键由插件进程按当前工作区自己算，切项目瞬间的竞态由它校验笔记归属。
   */
  function rememberActive(id) {
    return call("note:remember", { id: id || "" }).catch(() => {
      /* 记忆写失败不影响使用，下次打开只是回到列表 */
    });
  }

  /**
   * 宿主的 docked 视图按 pluginId/viewId 只缓存一份页面：切换项目时页面不重建、
   * boot() 不会重跑，state 里还留着上一个项目的笔记。所以项目键一变就自己换内容：
   * 先落盘上一个项目的笔记，再打开新项目记忆里的那条，没有记忆就回列表。
   * 首次同步（projectKey === null）也按记忆恢复，让「打开侧边栏」就能接上。
   */
  async function syncProject() {
    const token = ++syncToken;
    const data = await refreshList({ defer: true, token });
    if (!data) return;
    const nextKey = data.project?.key || "";
    // activeNoteId 由插件进程按「当前范围里能看到」筛过，视图拿到就能直接恢复
    const activeNoteId = data.activeNoteId || "";
    const first = projectKey === null;
    const restore = first ? Boolean(activeNoteId) : projectKey !== nextKey;
    if (!restore) {
      // 项目没变：只把列表 / 面包屑重绘一遍，不动正在编辑的内容
      projectKey = nextKey;
      if (state.mode === "list") renderList();
      else renderEditorChrome();
      return;
    }
    // 切换成功才认这个项目键：保存失败时保留旧内容和旧键，下次事件再试
    if (await enterProjectSession(activeNoteId)) projectKey = nextKey;
  }

  /**
   * 切换项目后显示什么：该项目记忆里的笔记，没有就回到它的列表。
   * 返回 false 表示上一个项目的改动没保存成功，面板保持原样。
   */
  async function enterProjectSession(activeNoteId) {
    // 先把上一个项目的编辑内容落盘：它属于上一个项目，不能跟着一起丢
    await flushSave();
    if (state.dirty) {
      showSnack(`${t("saveFailed")}：${t("switchBlocked")}`, null, null, 6000);
      return false;
    }
    if (activeNoteId) {
      if (state.current?.id === activeNoteId) {
        renderEditorChrome();
        return true;
      }
      try {
        const data = await call("note:read", { id: activeNoteId });
        state.current = data.note;
        showEditor();
        return true;
      } catch {
        /* 记忆里的笔记已不可用：退回列表 */
      }
    }
    enterListMode();
    return true;
  }
  // ── 编辑器 ────────────────────────────────────────────────────────────────

  function renderPinButton() {
    const pinned = Boolean(state.current && state.current.pinned);
    els.pinBtn.setAttribute("aria-pressed", String(pinned));
    els.pinBtn.setAttribute("aria-label", pinned ? t("unpin") : t("pin"));
    els.pinBtn.title = pinned ? t("unpin") : t("pin");
    els.pinBtn.style.color = pinned ? "var(--pinned)" : "";
  }

  function renderEditorChrome() {
    const current = state.current;
    const parts = [];
    if (current) parts.push(current.projectName || t("inboxLabel"));
    if (state.hasProject && state.project.name && (!current || current.projectName !== state.project.name)) {
      parts.push(state.project.name);
    }
    els.editorCrumb.textContent = parts.join(" · ");
    renderPinButton();
    renderStatus();
    fitEditorBar();
  }

  function renderStatus() {
    if (state.mode !== "editor") return;
    const body = els.bodyInput.value;
    const scopeName = state.current?.projectName || t("inboxLabel");
    els.statusLeft.textContent = `${scopeName} · ${countChars(body)} ${t("chars")}`;
  }

  function setSaveStatus(text, isError) {
    els.statusRight.textContent = text;
    els.statusRight.classList.toggle("is-error", Boolean(isError));
  }

  // ── 行号槽 ────────────────────────────────────────────────────────────────

  const GUTTER_MAX_LINES = 800;
  let gutterTimer = null;

  /**
   * 每行占几行高：把行塞进和正文同排版参数的隐形镜像里量 offsetHeight。
   * 超过 GUTTER_MAX_LINES 行就不再逐行测量（避免输入时卡顿），按单行高度排。
   */
  function measureLineHeights(lines) {
    const input = els.bodyInput;
    const mirror = els.editorMirror;
    const cs = getComputedStyle(input);
    const single = parseFloat(cs.lineHeight) || 21;
    if (!mirror || lines.length > GUTTER_MAX_LINES) return lines.map(() => single);
    const width =
      input.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    mirror.style.width = `${Math.max(40, width)}px`;
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      const row = document.createElement("div");
      row.textContent = line || "\u200b";
      frag.append(row);
    }
    mirror.replaceChildren(frag);
    const heights = Array.from(mirror.children, (node) => node.offsetHeight || single);
    mirror.replaceChildren();
    return heights;
  }

  function renderGutter() {
    if (!els.lineGutter) return;
    const visible = state.mode === "editor" && !state.preview;
    els.lineGutter.hidden = !visible;
    if (!visible) {
      els.lineGutterInner.replaceChildren();
      return;
    }
    const lines = els.bodyInput.value.split("\n");
    const heights = measureLineHeights(lines);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i += 1) {
      const row = document.createElement("div");
      row.className = "gutter-line";
      row.style.height = `${heights[i]}px`;
      row.textContent = String(i + 1);
      frag.append(row);
    }
    els.lineGutterInner.replaceChildren(frag);
    syncGutterScroll();
  }

  function scheduleGutter() {
    if (gutterTimer) return;
    gutterTimer = setTimeout(() => {
      gutterTimer = null;
      renderGutter();
    }, 120);
  }

  function syncGutterScroll() {
    if (!els.lineGutterInner) return;
    els.lineGutterInner.style.transform = `translateY(${-els.bodyInput.scrollTop}px)`;
  }

  function setPreview(next) {
    state.preview = next;
    renderModeSwitch();
    if (next) {
      renderMarkdownInto(els.previewPane, els.bodyInput.value);
      els.previewPane.hidden = false;
      els.bodyInput.hidden = true;
      els.previewPane.scrollTop = 0;
    } else {
      els.previewPane.hidden = true;
      els.bodyInput.hidden = false;
      els.bodyInput.focus();
    }
    // 预览态没有行号槽；切回编辑态时按当前正文重建
    renderGutter();
    savePrefs();
  }
  // ── 编辑 / 预览：分段滑块 ────────────────────────────────────────────────

  function renderModeSwitch() {
    const mode = state.preview ? "preview" : "edit";
    els.modeSwitch.dataset.value = mode;
    for (const option of els.modeSwitch.querySelectorAll(".seg-option")) {
      const active = option.dataset.value === mode;
      option.setAttribute("aria-pressed", String(active));
      option.textContent = option.dataset.value === "edit" ? t("modeEdit") : t("modePreview");
    }
    layoutSegThumb(els.modeSwitch);
  }

  /**
   * 滑块按当前选中项的实测宽高定位，中英文标签不同宽也不会错位。
   * 编辑/预览 与 收件箱/项目/全部 是同一个控件，只按 aria-selected / aria-pressed 认当前项。
   */
  function layoutSegThumb(container) {
    if (!container) return;
    const thumb = container.querySelector(".seg-thumb");
    const active = container.querySelector(
      '.seg-option[aria-selected="true"], .seg-option[aria-pressed="true"]',
    );
    if (!thumb || !active || !active.offsetWidth) return;
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.transform = `translateX(${active.offsetLeft}px)`;
  }

  function layoutSegThumbs() {
    layoutSegThumb(els.modeSwitch);
    layoutSegThumb(els.scopeTabs);
  }

  // ── 缩放：手动数值 + 自适应 ──────────────────────────────────────────────

  const ZOOM_MIN = 80;
  const ZOOM_MAX = 160;
  let zoomResizeTimer = null;

  function clampZoom(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 100;
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(num / 5) * 5));
  }

  /** 自适应：300px→86%，480px→100%，760px→134%（按面板可见宽度取值）。 */
  /**
   * 面板可见宽度：取 body 与视口中较小的那个。
   * 宿主里两者相等；万一 webview 的 body 比可见区域宽（被裁切），也要按可见宽度排版，
   * 否则顶栏和正文会跑到看不见的地方。
   */
  function panelWidth() {
    const bodyW = document.body.clientWidth || 0;
    const viewW = window.innerWidth || 0;
    const visualW = window.visualViewport ? window.visualViewport.width : 0;
    const widths = [bodyW, viewW, visualW].filter((n) => n > 0);
    if (!widths.length) return 380;
    return Math.min(...widths);
  }

  function autoZoomPercent() {
    // 不会被 .shell 自身的 zoom 反馈影响（zoom 只作用于 .shell 内部）
    const width = Math.min(760, Math.max(300, panelWidth()));
    return clampZoom(86 + ((width - 300) * (134 - 86)) / (760 - 300));
  }

  /**
   * 面板太窄时不要继续放大：顶栏（返回 + 滑块 + 5 个图标）在 240px 虚拟宽度下才排得开。
   * 侧边栏被拖窄后自动收一档，避免图标被挤出可视区。
   */
  function maxZoomForWidth() {
    return clampZoom((panelWidth() / 240) * 100);
  }

  function effectiveZoomPercent() {
    const raw = state.zoom.auto ? autoZoomPercent() : clampZoom(state.zoom.value);
    return Math.min(raw, maxZoomForWidth());
  }

  function renderZoom() {
    const percent = effectiveZoomPercent();
    document.documentElement.style.setProperty("--ui-zoom", String(percent / 100));
    els.autoSwitch.setAttribute("aria-checked", String(state.zoom.auto));
    els.zoomRange.disabled = state.zoom.auto;
    els.zoomRange.value = String(percent);
    els.zoomValue.textContent = `${percent}%`;
    // 自适应时把当前面板宽度也写出来：一眼能看出视图认为自己多宽
    els.zoomHint.textContent = state.zoom.auto
      ? `${t("zoomHintAuto")} · ${Math.round(panelWidth())}px`
      : t("zoomHintManual");
    for (const button of els.zoomBtns || []) {
      button.dataset.tip = `${t("tipZoom")} · ${percent}%`;
    }
    layoutSegThumbs();
    fitEditorBar();
    return percent;
  }

  function setZoom(next) {
    if (typeof next.auto === "boolean") state.zoom.auto = next.auto;
    if (typeof next.value === "number") state.zoom.value = clampZoom(next.value);
    renderZoom();
    savePrefs();
  }
  let hudTimer = null;

  /** Ctrl+滚轮时在底部闪一下当前百分比。 */
  function flashZoomHud(percent) {
    els.zoomHudValue.textContent = `${Math.round(percent)}%`;
    els.zoomHud.hidden = false;
    // 居中按面板宽度算：窗口比面板宽时（预览脚手架）也能落在面板正中。
    els.zoomHud.style.left = `${Math.round((document.body.clientWidth || window.innerWidth) / 2)}px`;
    els.zoomHud.classList.add("is-open");
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      els.zoomHud.classList.remove("is-open");
      hudTimer = setTimeout(() => {
        if (!els.zoomHud.classList.contains("is-open")) els.zoomHud.hidden = true;
      }, 200);
    }, 900);
  }

  let fitTimer = null;
  let bodyObserver = null;

  /**
   * 编辑器顶栏在窄面板 / 高缩放下放不下时收起面包屑，避免挤成一条。
   * 图标按钮固定宽（flex: none），所以真正溢出时 scrollWidth 会大于 clientWidth。
   */
  function fitEditorBar() {
    const bar = els.editorBar;
    if (!bar) return;
    bar.classList.remove("is-tight");
    if (bar.scrollWidth > bar.clientWidth + 1) bar.classList.add("is-tight");
  }

  /** 面板尺寸变化后的统一重排：窄面板标记、缩放、滑块、顶栏紧凑态、行号槽。 */
  function scheduleLayoutFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      const width = panelWidth();
      els.shell.classList.toggle("is-narrow", width < 300);
      els.shell.classList.toggle("is-tiny", width < 240);
      if (state.zoom.auto) renderZoom();
      else layoutSegThumbs();
      fitEditorBar();
      renderGutter();
      reportDiag("layout");
    }, 90);
  }
  const DIAG_LIMIT = 40;
  let diagSent = 0;
  const diagLastAt = new Map();

  /**
   * 调试模式：把面板的真实布局写进插件数据目录的 diagnostics.log（由 main.js 落盘）。
   * 宿主里的面板宽度只有页面自己知道，「右边被裁」这类问题读一行诊断就能判断是面板窄、
   * 还是视图本身比可见区域宽。每次会话最多 40 条，同一事件 400ms 内只发一次。
   */
  function reportDiag(event) {
    if (!bridge || typeof bridge.invoke !== "function") return;
    // 热重载后的首帧 webview 还没给出尺寸，这时上报只会写进一堆 0，等 layout 再报。
    if (!document.body.clientWidth) return;
    if (diagSent >= DIAG_LIMIT) return;
    const now = Date.now();
    if (now - (diagLastAt.get(event) || 0) < 400) return;
    diagLastAt.set(event, now);
    diagSent += 1;
    const shell = els.shell;
    const values = {
      panelWidth: Math.round(panelWidth()),
      bodyWidth: document.body.clientWidth,
      innerWidth: window.innerWidth,
      visualWidth: window.visualViewport ? Math.round(window.visualViewport.width) : 0,
      bodyHeight: document.body.clientHeight,
      innerHeight: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      docScrollHeight: document.documentElement.scrollHeight,
      shellClientWidth: shell ? shell.clientWidth : 0,
      shellScrollWidth: shell ? shell.scrollWidth : 0,
      zoom: Math.round(effectiveZoomPercent()),
      dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
      narrow: shell ? shell.classList.contains("is-narrow") : false,
      tiny: shell ? shell.classList.contains("is-tiny") : false,
      tight: els.editorBar ? els.editorBar.classList.contains("is-tight") : false,
    };
    call("note:diag", { event, values, viewport: navigator.userAgent }).catch(() => {});
  }


  /**
   * 锚点矩形（视口坐标）。
   * 气泡和缩放面板在 .shell 之外、用 position: fixed 定位；.shell 的 zoom 已经体现在
   * getBoundingClientRect() 的返回值里（Chromium 实测：25px 的按钮在 110% 下返回 27.5），
   * 所以这里直接给原始矩形——再乘一次 --ui-zoom 会把底栏的锚点推出视口，气泡就掉到界面底部。
   */
  function overlayRect(target) {
    return target.getBoundingClientRect();
  }

  let zoomAnchor = null;

  function openZoomPanel(anchor) {
    zoomAnchor = anchor || els.zoomBtn;
    els.zoomPanel.hidden = false;
    els.zoomPanel.classList.remove("is-open");
    const rect = overlayRect(zoomAnchor);
    const width = els.zoomPanel.offsetWidth;
    const height = els.zoomPanel.offsetHeight;
    const surfaceWidth = document.body.clientWidth || window.innerWidth;
    const surfaceHeight = window.innerHeight;
    const left = Math.min(
      Math.max(6, rect.right - width),
      Math.max(6, surfaceWidth - width - 6),
    );
    // 下半区的锚点（状态栏）向上弹，上半区的锚点（顶栏）向下弹，再夹在视口内。
    const preferred = rect.top > surfaceHeight / 2 ? rect.top - height - 6 : rect.bottom + 6;
    const top = Math.min(Math.max(6, preferred), Math.max(6, surfaceHeight - height - 6));
    els.zoomPanel.style.left = `${Math.round(left)}px`;
    els.zoomPanel.style.top = `${Math.round(top)}px`;
    requestAnimationFrame(() => els.zoomPanel.classList.add("is-open"));
    renderZoom();
  }

  function closeZoomPanel() {
    if (els.zoomPanel.hidden) return;
    els.zoomPanel.classList.remove("is-open");
    zoomAnchor = null;
    setTimeout(() => {
      if (!els.zoomPanel.classList.contains("is-open")) els.zoomPanel.hidden = true;
    }, 200);
  }

  function toggleZoomPanel(anchor) {
    if (els.zoomPanel.hidden) openZoomPanel(anchor);
    else closeZoomPanel();
  }

  // ── 提示气泡：从按钮上方浮出 ─────────────────────────────────────────────

  let tipDelayTimer = null;
  let tipHideTimer = null;
  let tipTarget = null;

  function placeTip(target) {
    const rect = overlayRect(target);
    els.tip.hidden = false;
    els.tip.classList.remove("is-open");
    const width = els.tip.offsetWidth;
    const height = els.tip.offsetHeight;
    const surfaceWidth = document.body.clientWidth || window.innerWidth;
    const surfaceHeight = window.innerHeight;
    const left = Math.min(
      Math.max(6, rect.left + rect.width / 2 - width / 2),
      Math.max(6, surfaceWidth - width - 6),
    );
    // 先试上方；上方确实放不下（顶栏按钮贴着面板顶边）才落到下方，并整体夹在视口内。
    let top = rect.top - height - 7;
    let below = false;
    if (top < 6) {
      top = rect.bottom + 7;
      below = true;
    }
    top = Math.min(Math.max(6, top), Math.max(6, surfaceHeight - height - 6));
    els.tip.classList.toggle("is-below", below);
    // 箭头跟着锚点中心走；气泡被贴边夹住时也不会指偏。
    const arrow = Math.min(
      Math.max(10, rect.left + rect.width / 2 - left),
      Math.max(10, width - 10),
    );
    els.tip.style.setProperty("--tip-arrow", `${Math.round(arrow)}px`);
    els.tip.style.left = `${Math.round(left)}px`;
    els.tip.style.top = `${Math.round(top)}px`;
    // 同步强制一次重排，让「移除 → 添加 is-open」之间能重放果冻入场动画（不依赖 rAF）。
    void els.tip.offsetWidth;
    els.tip.classList.add("is-open");
  }

  function showTip(target) {
    const text = target && target.dataset ? target.dataset.tip : "";
    if (!text) return;
    clearTimeout(tipHideTimer);
    tipTarget = target;
    els.tipText.textContent = text;
    placeTip(target);
  }

  function hideTip() {
    clearTimeout(tipDelayTimer);
    clearTimeout(tipHideTimer);
    tipDelayTimer = null;
    tipTarget = null;
    els.tip.classList.remove("is-open");
    tipHideTimer = setTimeout(() => {
      els.tip.hidden = true;
    }, 130);
  }

  function scheduleTip(target) {
    clearTimeout(tipDelayTimer);
    tipDelayTimer = setTimeout(() => showTip(target), 320);
  }


  function showEditor() {
    state.mode = "editor";
    els.listBar.hidden = true;
    els.listPane.hidden = true;
    els.editorPane.hidden = false;
    els.titleInput.value = state.current?.title || "";
    els.bodyInput.value = state.current?.body || "";
    state.dirty = false;
    els.saveBtn.classList.remove("is-dirty");
    setSaveStatus("");
    renderEditorChrome();
    if (state.preview) {
      setPreview(true);
    } else {
      els.bodyInput.hidden = false;
      els.previewPane.hidden = true;
      els.bodyInput.focus();
    }
    layoutSegThumbs();
    renderGutter();
  }

  async function openNote(id) {
    await flushSave();
    try {
      const data = await call("note:read", { id });
      state.current = data.note;
      showEditor();
      // 记住「这个项目正在打开这条笔记」：切换项目再回来、或重新打开面板都能接上
      rememberActive(id);
    } catch (error) {
      showSnack(errorText(error), null, null, 5000);
      await refreshList();
    }
  }

  async function createNote() {
    if (!(await confirmLeaveEditor())) return;
    await flushSave();
    try {
      const data = await call("note:create", { scope: state.scope });
      state.current = data.note;
      state.query = "";
      els.searchInput.value = "";
      els.clearSearch.hidden = true;
      showEditor();
      els.bodyInput.focus();
      rememberActive(data.note.id);
    } catch (error) {
      showSnack(errorText(error), null, null, 5000);
    }
  }

  function markDirty() {
    state.dirty = true;
    els.saveBtn.classList.add("is-dirty");
    setSaveStatus(t("dirty"));
    renderStatus();
    scheduleGutter();
    if (state.preview) renderMarkdownInto(els.previewPane, els.bodyInput.value);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
  }

  /**
   * 立即写盘。有保存正在进行时等它结束后再看是否还有改动 —— 切项目 / 切笔记
   * 都靠这个方法保证「上一个项目的改动真的落地了」。
   */
  async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (savePromise) {
      try {
        await savePromise;
      } catch {
        /* 失败状态已在下面处理过 */
      }
    }
    if (!state.current || !state.dirty) return;
    const note = state.current;
    const id = note.id;
    const title = els.titleInput.value;
    const body = els.bodyInput.value;
    state.dirty = false;
    setSaveStatus(t("saving"));
    let saved = false;
    savePromise = call("note:save", { id, title, body });
    try {
      const result = await savePromise;
      saved = true;
      note.title = title;
      note.body = body;
      if (!state.dirty) {
        els.saveBtn.classList.remove("is-dirty");
        setSaveStatus(`${t("saved")} ${formatClock(result.updatedAt || new Date().toISOString())}`);
      }
      renderStatus();
    } catch (error) {
      state.dirty = true;
      els.saveBtn.classList.add("is-dirty");
      setSaveStatus(`${t("saveFailed")}：${errorText(error)}`, true);
    } finally {
      savePromise = null;
      // 保存期间又有改动才补一次；失败不自动重试，交给下一次输入或显式保存
      if (saved && state.dirty) saveTimer = setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
    }
  }

  async function togglePin() {
    if (!state.current) return;
    const pinned = !state.current.pinned;
    try {
      await call("note:pin", { id: state.current.id, pinned });
      state.current.pinned = pinned;
      renderPinButton();
      showSnack(pinned ? t("pinnedOn") : t("pinnedOff"), null, null, 1600);
    } catch (error) {
      showSnack(errorText(error), null, null, 4000);
    }
  }

  /** 列表卡片右上角的图钉：只切置顶，不打开笔记。 */
  async function setCardPin(id, pinned) {
    try {
      await call("note:pin", { id, pinned });
      await refreshList();
      showSnack(pinned ? t("pinnedOn") : t("pinnedOff"), null, null, 1600);
    } catch (error) {
      showSnack(errorText(error), null, null, 4000);
    }
  }

  // ── 显式保存与「未保存」确认 ─────────────────────────────────────────────

  /** 保存按钮与 Ctrl+S 共用：没改动时也给一句“已保存”反馈。 */
  async function saveNow() {
    if (!state.current) return;
    if (!state.dirty) {
      setSaveStatus(`${t("saved")} ${formatClock(new Date().toISOString())}`);
      return;
    }
    await flushSave();
  }

  let dialogResolve = null;

  function askUnsaved() {
    return new Promise((resolve) => {
      dialogResolve = resolve;
      // 等用户决定期间先停掉自动保存，否则「放弃修改」可能已经被悄悄写盘了
      clearTimeout(saveTimer);
      saveTimer = null;
      els.unsavedDialog.hidden = false;
      // 同步重排一次再上 is-open，动画才会重放（不依赖 rAF，后台标签页也可靠）
      void els.unsavedDialog.offsetWidth;
      els.unsavedDialog.classList.add("is-open");
      els.unsavedSave.focus();
    });
  }

  function settleDialog(choice) {
    if (!dialogResolve) return;
    const resolve = dialogResolve;
    dialogResolve = null;
    els.unsavedDialog.classList.remove("is-open");
    setTimeout(() => {
      if (!els.unsavedDialog.classList.contains("is-open")) els.unsavedDialog.hidden = true;
    }, 160);
    resolve(choice);
  }

  /**
   * 离开编辑器前的闸门：有未保存改动就先问一句。
   * true = 可以继续（已保存或用户选择放弃），false = 留在原地。
   */
  async function confirmLeaveEditor() {
    if (!state.dirty) return true;
    const choice = await askUnsaved();
    if (choice === "cancel") {
      if (state.dirty) saveTimer = setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
      return false;
    }
    if (choice === "save") {
      await flushSave();
      return !state.dirty;
    }
    // 放弃修改：先把 dirty 清掉，showList() 里的 flushSave() 就不会再写盘
    clearTimeout(saveTimer);
    saveTimer = null;
    state.dirty = false;
    els.saveBtn.classList.remove("is-dirty");
    setSaveStatus("");
    return true;
  }

  async function leaveEditor() {
    if (!(await confirmLeaveEditor())) return;
    await showList();
  }

  // 只有「鼠标点过面板」之后快捷键才生效，避免误触宿主或全局快捷键
  let pointerFocused = false;

  function shortcutsEnabled() {
    return pointerFocused && document.hasFocus();
  }

  async function copyCurrent() {
    const title = els.titleInput.value.trim();
    const body = els.bodyInput.value;
    const text = [title ? `# ${title}` : "", body].filter((part) => part && part.trim()).join("\n\n");
    if (!text.trim()) {
      showSnack(t("nothingToCopy"), null, null, 2000);
      return;
    }
    try {
      await call("note:copy", { text });
      showSnack(t("copied"), null, null, 1800);
    } catch (error) {
      showSnack(errorText(error), null, null, 4000);
    }
  }

  async function deleteCurrent() {
    if (!state.current) return;
    const id = state.current.id;
    await flushSave();
    try {
      await call("note:delete", { id });
      await showList();
      showSnack(t("deleted"), t("undo"), async () => {
        try {
          await call("note:undoDelete", { id });
          await refreshList();
          showSnack(t("restored"), null, null, 2000);
        } catch (error) {
          showSnack(errorText(error), null, null, 4000);
        }
      }, 6000);
    } catch (error) {
      showSnack(errorText(error), null, null, 5000);
    }
  }

  // ── Markdown 渲染 ─────────────────────────────────────────────────────────

  /* 每次 inlineInto 自己 new 一个实例：全局正则在递归里共用会互相改写 lastIndex，
     导致外层循环在同一处反复命中（死循环）。 */
  const INLINE_SOURCE =
    "(`[^`\\n]+`)|(\\*\\*[^*\\n]+\\*\\*)|(__[^_\\n]+__)|(~~[^~\\n]+~~)|(\\[[^\\]\\n]*\\]\\([^)\\s]+\\))|(\\*[^*\\n]+\\*)|(_[^_\\n]+_)";

  function safeHref(raw) {
    const value = String(raw || "").trim();
    if (!/^(https?:\/\/|mailto:)/i.test(value)) return null;
    if (/[\s<>"]/.test(value)) return null;
    return value;
  }

  function linkNode(label, href) {
    const anchor = el("a");
    anchor.textContent = label || href;
    anchor.dataset.href = href;
    anchor.title = t("linkHint");
    anchor.setAttribute("role", "link");
    anchor.tabIndex = 0;
    return anchor;
  }

  function inlineInto(parent, text) {
    const source = String(text || "");
    let last = 0;
    const re = new RegExp(INLINE_SOURCE, "g");
    let match;
    while ((match = re.exec(source))) {
      if (match.index > last) parent.append(source.slice(last, match.index));
      const token = match[0];
      if (token.startsWith("`")) {
        const code = el("code");
        code.textContent = token.slice(1, -1);
        parent.append(code);
      } else if (token.startsWith("**") || token.startsWith("__")) {
        const strong = el("strong");
        inlineInto(strong, token.slice(2, -2));
        parent.append(strong);
      } else if (token.startsWith("~~")) {
        const strike = el("s");
        inlineInto(strike, token.slice(2, -2));
        parent.append(strike);
      } else if (token.startsWith("[")) {
        const parts = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
        const href = parts ? safeHref(parts[2]) : null;
        if (href) parent.append(linkNode(parts[1], href));
        else parent.append(token);
      } else {
        const em = el("em");
        inlineInto(em, token.slice(1, -1));
        parent.append(em);
      }
      last = match.index + token.length;
    }
    if (last < source.length) parent.append(source.slice(last));
  }

  const FENCE_RE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
  const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
  const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE_RE = /^\s{0,3}>\s?/;
  const BULLET_RE = /^\s{0,3}[-*+]\s+(.*)$/;
  const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
  const ORDERED_RE = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;

  function isBlockStart(line) {
    return (
      FENCE_RE.test(line) ||
      HEADING_RE.test(line) ||
      HR_RE.test(line) ||
      QUOTE_RE.test(line) ||
      BULLET_RE.test(line) ||
      ORDERED_RE.test(line)
    );
  }

  /** 预览里点任务框：改写正文对应行的 [ ] / [x]，其余内容与滚动位置保持不变。 */
  function toggleTaskLine(lineIndex) {
    const lines = els.bodyInput.value.split("\n");
    const line = lines[lineIndex];
    if (typeof line !== "string") return;
    const match = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/.exec(line);
    if (!match) return;
    const next = match[2].toLowerCase() === "x" ? " " : "x";
    lines[lineIndex] = `${match[1]}[${next}]${line.slice(match[0].length)}`;
    const scrollTop = els.previewPane.scrollTop;
    els.bodyInput.value = lines.join("\n");
    state.dirty = true;
    renderMarkdownInto(els.previewPane, els.bodyInput.value);
    els.previewPane.scrollTop = scrollTop;
    renderStatus();
    void flushSave();
  }

  /** 代码块外壳：右上角挂一个复制按钮，代码文本从 code 元素里取。 */
  function codeBlock(pre) {
    const wrapper = el("div");
    wrapper.className = "code-block";
    const copy = el("button");
    copy.type = "button";
    copy.className = "code-copy";
    copy.dataset.tip = t("copyCode");
    copy.setAttribute("aria-label", t("copyCode"));
    copy.append(iconUse("i-copy"));
    wrapper.append(pre, copy);
    return wrapper;
  }

  function renderMarkdownInto(container, text) {
    container.textContent = "";
    const source = String(text || "").replace(/\r\n?/g, "\n");
    if (!source.trim()) {
      const empty = el("p");
      empty.className = "empty-preview";
      empty.textContent = t("emptyPreview");
      container.append(empty);
      return;
    }

    const lines = source.split("\n");
    const frag = document.createDocumentFragment();
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i += 1;
        continue;
      }

      const fence = FENCE_RE.exec(line);
      if (fence) {
        const marker = fence[1][0] === "`" ? "```" : "~~~";
        const buffer = [];
        i += 1;
        while (i < lines.length && !new RegExp(`^\\s{0,3}${marker}`).test(lines[i])) {
          buffer.push(lines[i]);
          i += 1;
        }
        i += 1;
        const pre = el("pre");
        const code = el("code");
        code.textContent = buffer.join("\n");
        pre.append(code);
        frag.append(codeBlock(pre));
        continue;
      }

      const heading = HEADING_RE.exec(line);
      if (heading) {
        const node = el(`h${heading[1].length}`);
        inlineInto(node, heading[2]);
        frag.append(node);
        i += 1;
        continue;
      }

      if (HR_RE.test(line)) {
        frag.append(el("hr"));
        i += 1;
        continue;
      }

      if (QUOTE_RE.test(line)) {
        const buffer = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) {
          buffer.push(lines[i].replace(QUOTE_RE, ""));
          i += 1;
        }
        const quote = el("blockquote");
        renderMarkdownInto(quote, buffer.join("\n"));
        frag.append(quote);
        continue;
      }

      const ordered = ORDERED_RE.test(line);
      if (ordered || BULLET_RE.test(line)) {
        const list = el(ordered ? "ol" : "ul");
        const pattern = ordered ? ORDERED_RE : BULLET_RE;
        while (i < lines.length) {
          const item = pattern.exec(lines[i]);
          if (!item) break;
          const li = el("li");
          const raw = ordered ? item[2] : item[1];
          const task = TASK_RE.exec(raw);
          if (task) {
            li.className = "task";
            const box = el("button");
            box.type = "button";
            const done = task[1].toLowerCase() === "x";
            box.className = done ? "task-box is-done" : "task-box";
            if (done) box.append(iconUse("i-check"));
            /* 交互：点击直接改写正文里这一行的 [ ] / [x]，行号由渲染时记录。 */
            box.setAttribute("role", "checkbox");
            box.setAttribute("aria-checked", String(done));
            box.dataset.line = String(i);
            box.dataset.tip = done ? t("taskUncheck") : t("taskCheck");
            li.append(box, document.createTextNode(" "));
            inlineInto(li, task[2]);
          } else {
            inlineInto(li, raw);
          }
          list.append(li);
          i += 1;
        }
        frag.append(list);
        continue;
      }

      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        paragraph.push(lines[i]);
        i += 1;
      }
      if (!paragraph.length) {
        i += 1;
        continue;
      }
      const node = el("p");
      inlineInto(node, paragraph.join("\n"));
      frag.append(node);
    }

    container.append(frag);
  }

  // ── 事件绑定 ──────────────────────────────────────────────────────────────

  function restorePrefs() {
    try {
      const raw = window.localStorage.getItem(PREF_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw);
      if (prefs && (prefs.scope === "inbox" || prefs.scope === "project" || prefs.scope === "all")) {
        state.scope = prefs.scope;
      }
      state.preview = prefs && prefs.preview === true;
      if (prefs && (prefs.theme === "light" || prefs.theme === "dark")) {
        state.themeMode = prefs.theme;
      }
      if (prefs && prefs.zoom && typeof prefs.zoom === "object") {
        state.zoom.auto = prefs.zoom.auto !== false;
        state.zoom.value = clampZoom(prefs.zoom.value);
      }
    } catch {
      /* 忽略损坏的界面偏好 */
    }
  }

  function savePrefs() {
    clearTimeout(prefsTimer);
    prefsTimer = null;
    try {
      window.localStorage.setItem(
        PREF_KEY,
        JSON.stringify({
          scope: state.scope,
          preview: state.preview,
          theme: state.themeMode,
          zoom: state.zoom,
        }),
      );
    } catch {
      /* 存不下就算了 */
    }
  }

  /** Ctrl+滚轮会连续触发，攒一下再落盘。 */
  function schedulePrefsSave() {
    if (prefsTimer) return;
    prefsTimer = setTimeout(() => {
      prefsTimer = null;
      savePrefs();
    }, 400);
  }

  function bindEvents() {
    els.newNote.addEventListener("click", () => void createNote());
    els.emptyNew.addEventListener("click", () => void createNote());
    els.backBtn.addEventListener("click", () => void leaveEditor());
    els.modeSwitch.addEventListener("click", (event) => {
      const option = event.target.closest(".seg-option");
      if (!option) return;
      setPreview(option.dataset.value === "preview");
    });
    for (const trigger of document.querySelectorAll("[data-zoom-trigger]")) {
      trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        hideTip();
        toggleZoomPanel(trigger);
      });
    }
    els.autoSwitch.addEventListener("click", () => setZoom({ auto: !state.zoom.auto }));
    els.zoomRange.addEventListener("input", () =>
      setZoom({ auto: false, value: Number(els.zoomRange.value) }),
    );
    els.zoomReset.addEventListener("click", () => {
      state.zoom.value = 100;
      setZoom({ auto: true });
    });
    els.zoomPanel.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", () => closeZoomPanel());
    els.themeBtn.addEventListener("click", () => toggleTheme());
    // Ctrl+滚轮缩放：与面板滑杆共用同一份状态，滚完在底部闪一下当前百分比。
    document.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey || !event.deltaY) return;
        if (!shortcutsEnabled()) return;
        event.preventDefault();
        const current = effectiveZoomPercent();
        const next = clampZoom(current + (event.deltaY > 0 ? -5 : 5));
        if (next !== current) setZoom({ auto: false, value: next });
        flashZoomHud(next);
        schedulePrefsSave();
      },
      { passive: false },
    );
    document.addEventListener("pointerover", (event) => {
      const target = event.target.closest ? event.target.closest("[data-tip]") : null;
      if (target) scheduleTip(target);
    });
    document.addEventListener("pointerout", (event) => {
      const target = event.target.closest ? event.target.closest("[data-tip]") : null;
      if (target) hideTip();
    });
    document.addEventListener("focusin", (event) => {
      const target = event.target.closest ? event.target.closest("[data-tip]") : null;
      if (target) showTip(target);
    });
    document.addEventListener("focusout", () => hideTip());
    window.addEventListener("resize", () => scheduleLayoutFit());
    // 侧边栏拖宽 / 拖窄时 body 尺寸变化（iframe 里 window 的 resize 不一定每次都来）
    if (typeof ResizeObserver === "function") {
      bodyObserver = new ResizeObserver(() => scheduleLayoutFit());
      bodyObserver.observe(document.body);
    }
    els.pinBtn.addEventListener("click", () => void togglePin());
    els.copyBtn.addEventListener("click", () => void copyCurrent());
    els.saveBtn.addEventListener("click", () => void saveNow());
    els.unsavedSave.addEventListener("click", () => settleDialog("save"));
    els.unsavedDiscard.addEventListener("click", () => settleDialog("discard"));
    els.unsavedCancel.addEventListener("click", () => settleDialog("cancel"));
    els.unsavedDialog.addEventListener("click", (event) => {
      if (event.target === els.unsavedDialog) settleDialog("cancel");
    });
    // 记下“鼠标点过面板”，配合 document.hasFocus() 决定快捷键是否生效
    document.addEventListener(
      "pointerdown",
      () => {
        pointerFocused = true;
      },
      true,
    );
    window.addEventListener("blur", () => {
      pointerFocused = false;
    });
    els.deleteBtn.addEventListener("click", () => void deleteCurrent());

    els.searchInput.addEventListener("input", () => {
      state.query = els.searchInput.value.trim();
      els.clearSearch.hidden = !els.searchInput.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (state.mode === "list") void refreshList();
      }, 160);
    });

    els.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && els.searchInput.value) {
        event.stopPropagation();
        els.searchInput.value = "";
        state.query = "";
        els.clearSearch.hidden = true;
        void refreshList();
      }
    });

    els.clearSearch.addEventListener("click", () => {
      els.searchInput.value = "";
      state.query = "";
      els.clearSearch.hidden = true;
      els.searchInput.focus();
      void refreshList();
    });

    els.scopeTabs.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-scope]");
      if (!button) return;
      state.scope = button.dataset.scope;
      savePrefs();
      void refreshList();
    });

    els.titleInput.addEventListener("input", markDirty);
    els.bodyInput.addEventListener("input", markDirty);
    els.bodyInput.addEventListener("scroll", syncGutterScroll);
    els.bodyInput.addEventListener("blur", () => {
      // 正在问“要不要保存”时别抢着写盘，否则「放弃修改」形同虚设
      if (dialogResolve) return;
      void flushSave();
    });

    els.previewPane.addEventListener("click", (event) => {
      // 代码块右上角：复制这一块
      const copyButton = event.target.closest(".code-copy");
      if (copyButton) {
        const codeEl = copyButton.parentElement.querySelector("code");
        const text = codeEl ? codeEl.textContent : "";
        if (!text) return;
        void call("note:copy", { text })
          .then(() => showSnack(t("copiedCode"), null, null, 1600))
          .catch((error) => showSnack(errorText(error), null, null, 3000));
        return;
      }

      // 任务清单：点方框直接改正文里的 [ ] / [x]
      const taskBox = event.target.closest(".task-box[data-line]");
      if (taskBox) {
        toggleTaskLine(Number(taskBox.dataset.line));
        return;
      }

      // 链接：沙箱页面开不了外链，点击复制 URL
      const anchor = event.target.closest("a[data-href]");
      if (!anchor) return;
      event.preventDefault();
      void call("note:copy", { text: anchor.dataset.href })
        .then(() => showSnack(t("linkCopied"), null, null, 2200))
        .catch((error) => showSnack(errorText(error), null, null, 3000));
    });

    document.addEventListener("keydown", (event) => {
      // 未保存确认框开着时只处理 Esc：其余按键交给对话框自己的按钮
      if (!els.unsavedDialog.hidden) {
        if (event.key === "Escape") {
          event.preventDefault();
          settleDialog("cancel");
        }
        return;
      }
      if (event.key === "Escape") {
        if (!els.zoomPanel.hidden) {
          event.preventDefault();
          closeZoomPanel();
          return;
        }
        if (state.mode === "editor") {
          event.preventDefault();
          hideTip();
          void leaveEditor();
        }
        return;
      }
      // 组合键只在「鼠标点过面板且面板仍持有焦点」时生效，避免抢宿主或全局快捷键
      if (!shortcutsEnabled()) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        void createNote();
        return;
      }
      if (key === "f") {
        event.preventDefault();
        void (async () => {
          if (state.mode === "editor" && !(await confirmLeaveEditor())) return;
          await showList();
          els.searchInput.focus();
          els.searchInput.select();
        })();
        return;
      }
      if (key === "s") {
        event.preventDefault();
        void saveNow();
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        void flushSave();
        return;
      }
      // 面板重新可见时补一次项目同步：宿主不一定每次都推 workspace:changed 给 docked 视图
      if (Date.now() - lastListAt > LIST_REFRESH_MIN_MS) void syncProject();
    });

    window.addEventListener("focus", () => {
      if (Date.now() - lastListAt <= LIST_REFRESH_MIN_MS) return;
      // 焦点回来也走一次项目同步：切项目时宿主不一定每次都来得及推事件
      void syncProject();
    });

    if (bridge && typeof bridge.on === "function") {
      bridge.on("appearance:changed", (appearance) => applyAppearance(appearance));
      // 宿主的 docked 视图是同一份页面：切项目不会重建，必须自己换内容
      bridge.on("workspace:changed", () => {
        void syncProject();
      });
    }
  }

  function cacheElements() {
    const ids = [
      "listBar",
      "listPane",
      "editorPane",
      "searchInput",
      "clearSearch",
      "newNote",
      "newNoteLabel",
      "scopeTabs",
      "tabInbox",
      "tabProject",
      "tabAll",
      "scopeHint",
      "listGroups",
      "emptyState",
      "emptyTitle",
      "emptySub",
      "emptyNew",
      "backBtn",
      "editorCrumb",
      "modeSwitch",
      "shell",
      "newNote",
      "zoomBtn",
      "zoomBtnEditor",
      "themeBtn",
      "zoomHud",
      "zoomHudValue",
      "zoomPanel",
      "autoSwitch",
      "zoomRange",
      "zoomValue",
      "zoomHint",
      "zoomAutoLabel",
      "zoomReset",
      "tip",
      "tipText",
      "pinBtn",
      "copyBtn",
      "deleteBtn",
      "saveBtn",
      "unsavedDialog",
      "unsavedTitle",
      "unsavedBody",
      "unsavedSave",
      "unsavedDiscard",
      "unsavedCancel",
      "titleInput",
      "bodyInput",
      "previewPane",
      "lineGutter",
      "lineGutterInner",
      "editorMirror",
      "statusLeft",
      "statusRight",
      "snack",
      "snackText",
      "snackAction",
    ];
    for (const id of ids) els[id] = document.getElementById(id);
    els.editorBar = document.querySelector(".editor-bar");
    els.zoomBtns = [els.zoomBtn, els.zoomBtnEditor].filter(Boolean);
  }

  async function boot() {
    cacheElements();
    restorePrefs();
    renderZoom();
    renderModeSwitch();
    bindEvents();
    layoutSegThumbs();
    // 视图字体（MiSans）异步加载，字宽变化后重新量一次滑块。
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        layoutSegThumbs();
        renderGutter();
      });
    }

    if (!bridge) {
      els.emptyState.hidden = false;
      els.emptyTitle.textContent = t("bridgeMissing");
      els.emptySub.textContent = "";
      els.emptyNew.hidden = true;
      els.newNote.disabled = true;
      return;
    }

    await syncAppearance();
    // 首次同步也走项目同步：打开面板就接上这个项目「正在打开的笔记」
    await syncProject();
    reportDiag("boot");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot());
  } else {
    void boot();
  }
})();
