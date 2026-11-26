/* Stop That Shit panel. Plain DOM, no framework: the host renders this page
 * in an isolated window and forwards unknown channels to the plugin's
 * onPanelInvoke. */
(function () {
  "use strict";

  var view = window.StsView;
  var bridge = window.pluginBridge || null;

  var STRINGS = {
    zh: {
      subtitle: "任务边界护栏 · 本地审计",
      refresh: "刷新",
      switchLanguage: "切换语言",
      eventsTitle: "审计事件",
      detailTitle: "事件详情",
      doctorTitle: "Doctor",
      sessionsTitle: "会话契约",
      filter: "按工具、原因码、事件 ID 过滤",
      allOutcomes: "全部结果",
      emptyEvents: "还没有审计记录。首行发送 $stop-that-shit change -- … 才会武装 Guard。",
      emptySessions: "还没有会话契约。",
      pickEvent: "选择左侧一条事件查看判定原因。",
      loading: "加载中…",
      "card.sessions": "会话",
      "card.locks": "锁",
      "card.damaged": "损坏",
      "card.checked": "已检查动作",
      "card.context": "上下文响应",
      "card.deny": "权限拒绝",
      "card.execDeny": "执行前拒绝",
      "card.correct": "标为正确",
      "card.incorrect": "标为错误",
      "card.inconclusive": "标为不确定",
      "card.damagedRecords": "损坏记录",
      "table.session": "会话",
      "table.state": "状态",
      "table.agents": "Agents",
      "table.hash": "Hash",
      "table.deps": "Deps",
      "table.files": "Files",
      "table.updated": "更新",
      "label.correct": "正确",
      "label.incorrect": "错误",
      "label.inconclusive": "无法判定",
      "label.unlabeled": "未标注",
      "value.any": "任意",
      "value.unlimited": "不限",
      "doctor.pass": "通过",
      "doctor.fail": "失败",
      "doctor.loaded": "已加载",
      "doctor.waiting": "等待中",
      "doctor.dataDir": "{path}",
      "doctor.stateFiles": "{total} 个文件，{damaged} 个损坏{unreadable}",
      "doctor.runtimeRecords": "{events} 条事件，{damaged} 条损坏",
      "doctor.locks": "{count} 个锁，{stale} 个超过 10 秒",
      "doctor.extensionDataDir": "扩展与本报告共用同一目录，或扩展尚未注册",
      "doctor.extensionElsewhere": "扩展注册在 {fallback}，而本报告读取 {dataDir}",
      "doctor.extensionLoaded": "注册于 {time} · 命令 API：{api}",
      "doctor.extensionWaiting": "Agent 扩展尚未在此数据目录注册",
      "explain.event": "事件: ",
      "explain.when": "时间: ",
      "explain.state": "状态: ",
      "explain.action": "动作: ",
      "explain.paths": "；路径数=",
      "explain.decision": "判定: ",
      "explain.response": "响应: ",
      "explain.hostEffect": "宿主效果: ",
      "explain.policy": "哈希: {hash}；依赖: {deps}；Agents: {agents}",
      "explain.label": "标注: ",
      "explain.why": "原因: ",
      "explain.next": "下一步: ",
      "toast.labelSaved": "标注已保存: ",
      "toast.labelFailed": "标注失败: ",
    },
    en: {
      subtitle: "Task-boundary Guard · local audit",
      refresh: "Refresh",
      switchLanguage: "Switch language",
      eventsTitle: "Audit events",
      detailTitle: "Event detail",
      doctorTitle: "Doctor",
      sessionsTitle: "Session contracts",
      filter: "Filter by tool, reason code, or event id",
      allOutcomes: "All outcomes",
      emptyEvents: "No audit records yet. Send $stop-that-shit change -- … on the first line to arm the Guard.",
      emptySessions: "No session contracts yet.",
      pickEvent: "Pick an event on the left to read the decision.",
      loading: "Loading…",
      "card.sessions": "Sessions",
      "card.locks": "Locks",
      "card.damaged": "Damaged",
      "card.checked": "Checked actions",
      "card.context": "Context responses",
      "card.deny": "Permission denies",
      "card.execDeny": "Execution denies",
      "card.correct": "Labeled correct",
      "card.incorrect": "Labeled incorrect",
      "card.inconclusive": "Labeled inconclusive",
      "card.damagedRecords": "Damaged records",
      "table.session": "Session",
      "table.state": "State",
      "table.agents": "Agents",
      "table.hash": "Hash",
      "table.deps": "Deps",
      "table.files": "Files",
      "table.updated": "Updated",
      "label.correct": "correct",
      "label.incorrect": "incorrect",
      "label.inconclusive": "inconclusive",
      "label.unlabeled": "unlabeled",
      "value.any": "any",
      "value.unlimited": "unlimited",
      "doctor.pass": "PASS",
      "doctor.fail": "FAIL",
      "doctor.loaded": "LOADED",
      "doctor.waiting": "WAITING",
      "doctor.dataDir": "{path}",
      "doctor.stateFiles": "{total} file(s), {damaged} damaged{unreadable}",
      "doctor.runtimeRecords": "{events} event(s), {damaged} damaged",
      "doctor.locks": "{count} lock(s), {stale} older than 10s",
      "doctor.extensionDataDir": "this report and the extension share a directory, or the extension has not registered yet",
      "doctor.extensionElsewhere": "the extension registered in {fallback} while this report reads {dataDir}",
      "doctor.extensionLoaded": "registered {time} · command API: {api}",
      "doctor.extensionWaiting": "the agent extension has not registered in this data directory yet",
      "explain.event": "Event: ",
      "explain.when": "When: ",
      "explain.state": "State: ",
      "explain.action": "Action: ",
      "explain.paths": "; paths=",
      "explain.decision": "Decision: ",
      "explain.response": "Response: ",
      "explain.hostEffect": "Host effect: ",
      "explain.policy": "Hash: {hash}; deps: {deps}; agents: {agents}",
      "explain.label": "Label: ",
      "explain.why": "Why: ",
      "explain.next": "Next: ",
      "toast.labelSaved": "Label saved: ",
      "toast.labelFailed": "Label failed: ",
    },
  };

  var state = {
    locale: "zh",
    overview: null,
    events: [],
    doctor: null,
    query: "",
    outcome: "",
    selectedId: null,
    ready: false,
  };

  function t(key) {
    return (STRINGS[state.locale] || STRINGS.zh)[key] || key;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function call(channel, payload) {
    if (!bridge || typeof bridge.invoke !== "function") {
      return Promise.resolve({ ok: false, code: "NO_BRIDGE", message: "The panel bridge is unavailable." });
    }
    return Promise.resolve(bridge.invoke(channel, payload || {})).catch(function (error) {
      return { ok: false, code: "INVOKE_FAILED", message: error && error.message ? error.message : String(error) };
    });
  }

  function toast(message) {
    if (bridge && typeof bridge.invoke === "function") {
      call("ui.showToast", { message: String(message) });
    }
  }

  function known(key) {
    var table = STRINGS[state.locale] || STRINGS.zh;
    return table[key];
  }

  function applyLocale() {
    document.documentElement.lang = state.locale === "en" ? "en" : "zh-CN";
    el("subtitle").textContent = t("subtitle");
    el("refresh").textContent = t("refresh");
    el("events-title").textContent = t("eventsTitle");
    el("detail-title").textContent = t("detailTitle");
    el("doctor-title").textContent = t("doctorTitle");
    el("sessions-title").textContent = t("sessionsTitle");
    el("filter").placeholder = t("filter");
    el("outcome").options[0].textContent = t("allOutcomes");
    el("events-empty").textContent = t("emptyEvents");
    el("sessions-empty").textContent = t("emptySessions");
    if (!state.selectedId) el("explain").textContent = t("pickEvent");
    var toggle = el("locale");
    // The button names the language it switches to, so one click never lies.
    toggle.textContent = state.locale === "zh" ? "EN" : "中";
    toggle.title = t("switchLanguage");
    toggle.setAttribute("aria-label", t("switchLanguage"));
    var marked = document.querySelectorAll("[data-i18n]");
    for (var index = 0; index < marked.length; index += 1) {
      var key = marked[index].getAttribute("data-i18n");
      marked[index].textContent = t(key);
    }
  }

  function renderCards() {
    var summary = view.summarize(state.overview);
    var badge = el("state-badge");
    badge.textContent = summary.label;
    badge.className = "badge " + summary.state;
    var runtime = view.runtimeRows(state.overview && state.overview.runtime ? state.overview.runtime.summary : null);
    var cards = [
      { label: t("card.sessions"), value: summary.sessions },
      { label: t("card.locks"), value: summary.locks },
      { label: t("card.damaged"), value: summary.damagedSessions }
    ].concat(runtime.slice(0, 5).map(function (row) {
      return { label: t("card." + row.id), value: row.value };
    }));
    el("cards").innerHTML = cards.map(function (card) {
      return '<div class="card"><div class="label">' + escapeHtml(card.label) + '</div>'
        + '<div class="value">' + escapeHtml(card.value) + '</div></div>';
    }).join("");
    el("data-dir").textContent = state.overview && state.overview.dataDir ? state.overview.dataDir : "—";
  }

  function renderEvents() {
    var rows = view.filterEvents(state.events, { query: state.query, outcome: state.outcome });
    el("events-count").textContent = String(rows.length);
    el("events").innerHTML = rows.map(function (row) {
      var selected = row.eventId && row.eventId === state.selectedId ? " selected" : "";
      return '<li class="event' + selected + '" data-id="' + escapeHtml(row.eventId) + '" tabindex="0">'
        + '<time>' + escapeHtml(row.time) + '</time>'
        + '<div><div class="tool">' + escapeHtml(row.toolName) + '</div>'
        + '<div class="meta">' + escapeHtml(row.mutability) + ' · ' + escapeHtml(row.reasonCode)
        + (row.label ? ' · ' + escapeHtml(row.label) : '') + '</div></div>'
        + '<span class="outcome ' + escapeHtml(row.policyOutcome) + '">' + escapeHtml(row.policyOutcome) + '</span>'
        + '</li>';
    }).join("");
    el("events-empty").hidden = rows.length > 0;
  }

  function renderDoctor() {
    var rows = view.doctorRows(state.doctor);
    el("doctor").innerHTML = rows.map(function (row) {
      var label = known("doctor." + row.labelKey) || row.label;
      var detail = view.doctorDetail(row, t);
      return '<li><span class="flag ' + (row.ok ? "ok" : "bad") + '">' + escapeHtml(label) + '</span>'
        + '<span>' + escapeHtml(row.id) + '</span>'
        + '<span class="detail">' + escapeHtml(detail) + '</span></li>';
    }).join("");
  }

  function renderSessions() {
    var list = (state.overview && state.overview.sessions && state.overview.sessions.list) || [];
    var body = document.querySelector("#sessions tbody");
    body.innerHTML = list.map(function (session) {
      var contract = session.contract || {};
      var head = view.headline(contract);
      var files = Array.isArray(contract.allowedPaths) && contract.allowedPaths.length
        ? contract.allowedPaths.join(", ")
        : t("value.any");
      return '<tr><td>' + escapeHtml(session.key) + '</td>'
        + '<td>' + escapeHtml(head.label) + '</td>'
        + '<td>' + escapeHtml(typeof contract.agentBudget === "number" && contract.agentBudget < Number.MAX_SAFE_INTEGER ? contract.agentBudget : t("value.unlimited")) + '</td>'
        + '<td>' + escapeHtml(contract.hashPolicy || "deny") + '</td>'
        + '<td>' + escapeHtml(contract.dependencyPolicy || "ask") + '</td>'
        + '<td>' + escapeHtml(files) + '</td>'
        + '<td>' + escapeHtml(view.formatTime(session.updatedAt)) + '</td></tr>';
    }).join("");
    el("sessions-empty").hidden = list.length > 0;
  }

  function renderDetail() {
    var event = null;
    for (var index = 0; index < state.events.length; index += 1) {
      if (state.events[index] && state.events[index].eventId === state.selectedId) event = state.events[index];
    }
    if (!event) {
      el("labels").hidden = true;
      el("explain").textContent = t("pickEvent");
      return;
    }
    el("explain").textContent = view.explainLines(event, t).join("\n");
    el("labels").hidden = false;
  }

  function render() {
    applyLocale();
    renderCards();
    renderEvents();
    renderDoctor();
    renderSessions();
    renderDetail();
  }

  async function loadAll() {
    var overview = await call("sts.overview");
    if (overview && overview.ok) state.overview = overview;
    var events = await call("sts.events", { limit: 200 });
    if (events && events.ok) {
      state.events = events.events || [];
      if (!state.selectedId && state.events.length) state.selectedId = state.events[0].eventId;
    }
    var doctor = await call("sts.doctor");
    if (doctor && doctor.ok) state.doctor = doctor.report;
    state.ready = true;
    render();
  }

  async function refreshEvents() {
    var events = await call("sts.events", { limit: 200 });
    if (events && events.ok) state.events = events.events || [];
    render();
  }

  async function label(value) {
    if (!state.selectedId) return;
    var result = await call("sts.label", { eventId: state.selectedId, label: value });
    toast(result && result.ok ? t("toast.labelSaved") + value : t("toast.labelFailed") + ((result && result.message) || "unknown"));
    await refreshEvents();
  }

  document.addEventListener("click", function (event) {
    var row = event.target.closest(".event");
    if (row && row.dataset.id) {
      state.selectedId = row.dataset.id;
      render();
      return;
    }
    var button = event.target.closest("[data-label]");
    if (button) label(button.dataset.label);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    var row = event.target.closest(".event");
    if (!row || !row.dataset.id) return;
    event.preventDefault();
    state.selectedId = row.dataset.id;
    render();
  });

  el("filter").addEventListener("input", function (event) {
    state.query = event.target.value || "";
    renderEvents();
  });

  el("outcome").addEventListener("change", function (event) {
    state.outcome = event.target.value || "";
    renderEvents();
  });

  el("locale").addEventListener("click", function () {
    state.locale = state.locale === "zh" ? "en" : "zh";
    storeLocale(state.locale);
    render();
  });

  el("refresh").addEventListener("click", function () { loadAll(); });
  el("doctor-refresh").addEventListener("click", async function () {
    var doctor = await call("sts.doctor");
    if (doctor && doctor.ok) state.doctor = doctor.report;
    renderDoctor();
  });

  // A manual choice outlives the window: the panel is reopened whenever it is
  // revealed, and the host locale must not override the user's pick.
  function readStoredLocale() {
    try {
      var stored = window.localStorage.getItem("sts.locale");
      return stored === "zh" || stored === "en" ? stored : null;
    } catch (error) {
      return null;
    }
  }

  function storeLocale(value) {
    try {
      window.localStorage.setItem("sts.locale", value);
    } catch (error) {
      // A panel that cannot persist the choice still switches for this view.
    }
  }

  async function boot() {
    var stored = readStoredLocale();
    if (stored) state.locale = stored;
    applyLocale();
    try {
      var appearance = await call("app.getAppearance");
      var locale = appearance && (appearance.locale || appearance.language);
      if (!stored && typeof locale === "string" && locale.toLowerCase().indexOf("en") === 0) state.locale = "en";
      var theme = appearance && appearance.theme;
      if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    } catch (error) {
      // Appearance is cosmetic; the panel still loads.
    }
    applyLocale();
    await loadAll();
  }

  boot();
})();
