"use strict";

/* ThinkRail panel.
 *
 * One data source: the plugin process, over the host bridge. `pluginBridge.invoke(channel,
 * payload)` reaches `onPanelInvoke` in main.js for the channels this panel owns — state, grep,
 * spec — and every mutation is followed by a full state reload (no optimistic updates).
 *
 * All user-controlled text goes in with textContent; nothing here builds HTML from data. */

(function () {
  var bridge = window.pluginBridge;

  var I18N = {
    en: {
      tabSpecs: "Specs",
      refresh: "Refresh",
      filterPlaceholder: "Filter specs (Enter = full-text search)",
      loading: "Loading…",
      indexing: "Indexing specs…",
      stale: "Showing an older snapshot",
      noProject: "No project is open in PI-Desktop. Activate a project (click it in the sidebar, or Mod+K and type its name), then retry.",
      loadFailed: "Could not load",
      graphValid: "graph valid",
      graphIssues: "issues",
      emptyGraph: "No specs yet. A file is a spec once its frontmatter carries `id` and `type`.",
      partialIndex: "index may be incomplete",
      noMatch: "No matches.",
      matchCount: "match(es)",
      noSelection: "Select a spec to read it here.",
      reverseLinks: "Referenced by",
      specsCount: "spec(s)",
      kind: "Kind",
      done: "Done.",
      toolsOff: "tools off",
    },
    "zh-CN": {
      tabSpecs: "Spec 图",
      refresh: "刷新",
      filterPlaceholder: "筛选 spec（回车 = 全文检索）",
      loading: "加载中…",
      indexing: "正在建立 spec 索引…",
      stale: "正在显示旧快照",
      noProject: "没有打开项目。请在 PI-Desktop 里激活一个项目（侧栏点击，或 Mod+K 输入名字），然后重试。",
      loadFailed: "读取失败",
      graphValid: "图有效",
      graphIssues: "问题",
      emptyGraph: "还没有 spec。frontmatter 带 `id` 与 `type` 的文件才算 spec。",
      partialIndex: "索引可能不全",
      noMatch: "没有匹配。",
      matchCount: "处匹配",
      noSelection: "选一个 spec 在这里读它。",
      reverseLinks: "被谁引用",
      specsCount: "个 spec",
      kind: "类型",
      done: "完成。",
      toolsOff: "工具已关闭",
    },
  };

  var ROLE_LABELS = {
    en: {
      "goal-and-requirements": "Goal",
      "architecture-design": "Arch",
      "module-design": "Module",
      "submodule-design": "Sub",
      "task-spec": "Task",
    },
    "zh-CN": {
      "goal-and-requirements": "目标",
      "architecture-design": "架构",
      "module-design": "模块",
      "submodule-design": "子模块",
      "task-spec": "任务",
    },
  };

  // ── state ────────────────────────────────────────────────────────────────

  var HINT_POLL_MS = 4000;

  /** 上下列布局里，上半部（列表）占容器高度的百分比；拖动分隔条改的就是它。 */
  var SPLIT_KEY = "pi.thinkrail.splitTop";
  var SPLIT_DEFAULT = 42;
  var SPLIT_MIN = 15;
  var SPLIT_MAX = 85;

  var app = {
    view: "specs",
    state: null,
    filter: "",
    matches: null,
    collapsed: Object.create(null),
    spec: null,
    note: null,
    busy: false,
    hintToken: 0,
    indexedAt: 0,
    projectId: undefined,
    version: 0,
    epoch: 0,
    stateRequest: 0,
    detailRequest: 0,
    searchRequest: 0,
    hintBusy: false,
  };

  // ── helpers ──────────────────────────────────────────────────────────────

  function locale() {
    try {
      return window.__appearance.current().locale || "en";
    } catch (e) {
      return document.documentElement.lang || "en";
    }
  }

  function t() {
    return I18N[locale()] || I18N.en;
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    for (var key in props || {}) {
      var value = props[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.indexOf("on") === 0) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (var i = 0; i < (children || []).length; i++) {
      var child = children[i];
      if (!child) continue;
      node.append(child);
    }
    return node;
  }

  function fill(node, children) {
    node.textContent = "";
    for (var i = 0; i < children.length; i++) if (children[i]) node.append(children[i]);
    return node;
  }

  function truncate(text, max) {
    var value = String(text === null || text === undefined ? "" : text);
    return value.length > max ? value.slice(0, max) + "…" : value;
  }

  function displayTitle(node) {
    return String(node.title || node.id).replace(/\s+[—–]\s+/g, " · ");
  }

  function roleLabel(type) {
    var table = ROLE_LABELS[locale()] || ROLE_LABELS.en;
    if (table[type]) return table[type];
    return String(type || "spec")
      .split("-")
      .map(function (word) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(" ");
  }

  async function invoke(channel, payload) {
    if (!bridge || !bridge.invoke) throw new Error("host bridge is unavailable");
    var result = await bridge.invoke(channel, payload || {});
    if (result && result.ok === false) throw new Error(result.error || "the plugin refused the request");
    return result || {};
  }

  function note(kind, text) {
    app.note = text ? { kind: kind, text: text } : null;
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /** Every mutation goes through here: clear the note, run, reload state, redraw. */
  async function run(channel, payload) {
    if (app.busy) return;
    app.busy = true;
    note(null);
    render();
    try {
      var result = await invoke(channel, payload);
      note("ok", result.message || t().done);
      // 自己刚改过东西：这一读必须是真值，不能吃面板侧那 3 秒的记忆。
      await reload({ keepSelection: true, fresh: true });
    } catch (error) {
      note("error", error.message || String(error));
    } finally {
      app.busy = false;
      render();
    }
  }

  /**
   * `fresh` 绕过面板侧的短期记忆（默认允许复用 3 秒内的扫描，这样点开一个 spec 不再重走全树）。
   * 人主动要真值的三个入口都带 fresh：刷新按钮、窗口重新可见、以及每一次自己发起的改动。
   */
  function projectId(value) {
    return value.projectId !== undefined ? value.projectId : (value.project && value.project.path) || null;
  }

  function adoptProject(next) {
    var id = projectId(next);
    if (id === app.projectId) return false;
    app.projectId = id;
    app.epoch++;
    app.stateRequest++;
    app.detailRequest++;
    app.searchRequest++;
    app.version = 0;
    app.indexedAt = 0;
    app.spec = null;
    app.matches = null;
    app.filter = "";
    app.collapsed = Object.create(null);
    app.busy = false;
    note(null);
    document.getElementById("filter").value = "";
    app.state = { project: next.project || null, projectId: id, specs: null,
      indexing: next.indexing, specError: next.specError };
    return true;
  }

  async function reload(options) {
    var epoch = app.epoch;
    var request = ++app.stateRequest;
    app.busy = true;
    render();
    try {
      var next = await invoke("state", { fresh: options && options.fresh === true });
      if (epoch !== app.epoch || request !== app.stateRequest) return;
      adoptProject(next);
      // adoptProject invalidates older requests, including this request's old number.
      epoch = app.epoch;
      request = app.stateRequest;
      app.state = next;
      app.version = next.version || 0;
      app.indexedAt = next.indexedAt || 0;
      if (!options || !options.keepSelection) {
        app.detailRequest++;
        app.searchRequest++;
        app.spec = null;
        app.matches = null;
      }
      if (app.spec) await loadSpec(app.spec.path);
      if (epoch === app.epoch && request === app.stateRequest) note(null);
    } catch (error) {
      if (epoch === app.epoch && request === app.stateRequest)
        note("error", t().loadFailed + ": " + (error.message || String(error)));
    } finally {
      if (epoch === app.epoch && request === app.stateRequest) {
        app.busy = false;
        render();
      }
    }
  }

  async function loadSpec(path) {
    var epoch = app.epoch;
    var request = ++app.detailRequest;
    var detail = await invoke("spec", { file: path });
    if (epoch !== app.epoch || request !== app.detailRequest ||
        (detail.projectId !== undefined && detail.projectId !== app.projectId)) return;
    app.spec = { path: detail.file || path, detail: detail };
  }

  /** Hint checks workspace identity and schedules due background scans. */
  async function syncHint(options) {
    if (app.hintBusy) return false;
    var epoch = app.epoch;
    app.hintBusy = true;
    try {
      var next = await invoke("hint", {});
      if (epoch !== app.epoch) return false;
      var changed = adoptProject(next);
      var indexMoved = (next.version || 0) !== app.version;
      var tokenMoved = next.token !== app.hintToken;
      app.hintToken = next.token;
      if (tokenMoved && next.view) app.view = next.view;
      if (changed || indexMoved || tokenMoved) {
        if (options && options.reload === false) render();
        else reload({ keepSelection: !changed });
        return true;
      }
      return false;
    } catch (error) {
      return false;
    } finally {
      app.hintBusy = false;
    }
  }

  function startHintPoll() {
    window.setInterval(function () {
      if (document.hidden) return;
      // Keep observing project changes even while a detail/search request is pending.
      syncHint();
    }, HINT_POLL_MS);
    // 回到应用时问一下意向、并让状态跟上——但**不**强制重扫：快速切页签回来时，
    // 那次全树枚举（几百次宿主调用）纯属浪费，记忆窗口本来就是为这种时刻准备的。
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      syncHint({ reload: false }).then(function () {
        return reload({ keepSelection: true });
      });
    });
  }

  // ── specs view ───────────────────────────────────────────────────────────

  function nodes() {
    return (app.state && app.state.specs && app.state.specs.nodes) || [];
  }

  function nodeByPath(path) {
    var list = nodes();
    for (var i = 0; i < list.length; i++) if (list[i].path === path) return list[i];
    return null;
  }

  /** Child list per parent, plus which ids are roots (missing / self / unknown parent). */
  function tree() {
    var list = nodes();
    var known = Object.create(null);
    for (var i = 0; i < list.length; i++) known[list[i].id] = true;
    var children = Object.create(null);
    var roots = [];
    for (var j = 0; j < list.length; j++) {
      var node = list[j];
      var parent = node.parent;
      if (!parent || parent === node.id || !known[parent]) {
        roots.push(node);
        continue;
      }
      (children[parent] = children[parent] || []).push(node);
    }
    // Promote one node from each rootless parent cycle; its descendants stay reachable.
    var reached = Object.create(null);
    function mark(root) {
      var pending = [root];
      while (pending.length) {
        var current = pending.pop();
        if (reached[current.id]) continue;
        reached[current.id] = true;
        pending = pending.concat(children[current.id] || []);
      }
    }
    roots.forEach(mark);
    var byId = Object.create(null);
    list.forEach(function (node) { byId[node.id] = node; });
    list.forEach(function (node) {
      if (reached[node.id]) return;
      var cursor = node;
      var trail = Object.create(null);
      while (!trail[cursor.id] && !reached[cursor.id]) {
        trail[cursor.id] = true;
        cursor = byId[cursor.parent] || cursor;
      }
      if (!reached[cursor.id]) {
        roots.push(cursor);
        mark(cursor);
      }
    });
    var byTitle = function (a, b) {
      return displayTitle(a).localeCompare(displayTitle(b));
    };
    roots.sort(byTitle);
    for (var key in children) children[key].sort(byTitle);
    return { roots: roots, children: children };
  }

  /** Client-side filter: match id/type/title/path, then keep every ancestor of a hit. */
  function filtered() {
    var list = nodes();
    if (!app.filter) return null;
    var needle = app.filter.toLowerCase();
    var byId = Object.create(null);
    for (var i = 0; i < list.length; i++) byId[list[i].id] = list[i];
    var keep = Object.create(null);
    for (var j = 0; j < list.length; j++) {
      var node = list[j];
      var hay = (node.id + " " + node.type + " " + (node.title || "") + " " + node.path).toLowerCase();
      if (hay.indexOf(needle) === -1) continue;
      var cursor = node;
      while (cursor && !keep[cursor.id]) {
        keep[cursor.id] = true;
        cursor = byId[cursor.parent];
      }
    }
    return keep;
  }

  function renderSpecList() {
    var host = document.getElementById("spec-list");
    var state = app.state;
    // 后端在「没有激活项目」时给的消息更具体（会指名上次那个项目），优先用它。
    if (!state || !state.project) return fill(host, [el("p", { class: "tr-empty", text: (state && state.specError) || t().noProject })]);
    if (state.specError && !state.specs) return fill(host, [el("p", { class: "tr-empty", text: state.specError })]);

    if (app.matches) {
      var rows = app.matches.matches || [];
      if (!rows.length) return fill(host, [el("p", { class: "tr-empty", text: t().noMatch })]);
      return fill(
        host,
        rows.map(function (match) {
          return el("button", {
            type: "button",
            class: "tr-row",
            "aria-selected": app.spec && app.spec.path === match.path ? "true" : "false",
            onclick: function () {
              selectSpec(match.path);
            },
          }, [
            el("span", { class: "tr-label", text: match.path + ":" + match.line }),
            el("span", { class: "tr-meta", text: truncate(match.snippet, 40) }),
          ]);
        }),
      );
    }

    var list = nodes();
    if (!list.length) {
      // 首次打开时索引还在后台建：说清楚是在建，而不是「没有 spec」。
      if (state.indexing) return fill(host, [el("p", { class: "tr-empty", text: t().indexing })]);
      return fill(host, [el("p", { class: "tr-empty", text: t().emptyGraph })]);
    }
    var keep = filtered();
    var shape = tree();
    var out = [el("ul", { class: "tr-tree" })];
    var rootList = out[0];
    var visited = Object.create(null);

    function row(node, depth) {
      if (visited[node.id]) return null;
      visited[node.id] = true;
      var kids = (shape.children[node.id] || []).filter(function (child) {
        return !visited[child.id] && (!keep || keep[child.id]);
      });
      var collapsed = app.collapsed[node.id] === true;
      var line = el("li", {}, [
        el("button", {
          type: "button",
          class: "tr-row secondary",
          "aria-selected": app.spec && app.spec.path === node.path ? "true" : "false",
          onclick: function () {
            selectSpec(node.path);
          },
        }, [
          el("span", {
            class: "tr-twisty",
            text: kids.length ? (collapsed ? "▸" : "▾") : "",
            onclick: function (event) {
              if (!kids.length) return;
              event.stopPropagation();
              app.collapsed[node.id] = !collapsed;
              render();
            },
          }),
          el("span", { class: "tr-role", text: roleLabel(node.type) }),
          el("span", { class: "tr-label", text: displayTitle(node), title: node.path }),
          el("span", { class: "tr-meta", text: node.status || "" }),
        ]),
      ]);
      if (kids.length && !collapsed) {
        var nested = el("ul", { class: "tr-tree" });
        kids.forEach(function (child) {
          var childRow = row(child, depth + 1);
          if (childRow) nested.append(childRow);
        });
        line.append(nested);
      }
      return line;
    }

    shape.roots
      .filter(function (node) {
        return !keep || keep[node.id];
      })
      .forEach(function (node) {
        var rootRow = row(node, 0);
        if (rootRow) rootList.append(rootRow);
      });
    fill(host, out);
  }

  async function selectSpec(path) {
    if (app.busy) return;
    var epoch = app.epoch;
    app.busy = true;
    note(null);
    render();
    try {
      await loadSpec(path);
    } catch (error) {
      if (epoch === app.epoch) {
        note("error", error.message || String(error));
        app.spec = null;
      }
    } finally {
      if (epoch === app.epoch) {
        app.busy = false;
        render();
      }
    }
  }

  /** 节点按路径索引，供详情页与链接解析使用（state 里已经带下来了，不必再问插件）。 */
  function nodeByPathExact(path) {
    var list = nodes();
    for (var i = 0; i < list.length; i++) if (list[i].path === path) return list[i];
    return null;
  }

  function nodeById(id) {
    var list = nodes();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /**
   * 反推「谁指向我」：state 每个节点都带了自己的正向链接，反过来扫一遍即可。
   * 这样点开一个 spec 就只需要读那一个文件，不用重新枚举整棵树。
   */
  function reverseLinksOf(id) {
    var list = nodes();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var links = list[i].links || [];
      for (var j = 0; j < links.length; j++) {
        if (links[j].target === id) out.push({ kind: links[j].kind, target: list[i].id, path: list[i].path });
      }
    }
    return out;
  }

  function linkRows(pairs) {
    var box = el("dl", { class: "tr-fields" });
    pairs.forEach(function (link) {
      var known = link.path ? nodeByPathExact(link.path) : nodeById(link.target);
      box.append(el("dt", { text: link.kind }));
      box.append(
        el("dd", {}, [
          el("a", {
            href: "#",
            text: link.target + (link.path ? " (" + link.path + ")" : " (missing)"),
            onclick: function (event) {
              event.preventDefault();
              if (known) selectSpec(known.path);
            },
          }),
        ]),
      );
    });
    return box;
  }

  function renderSpecDetail() {
    var title = document.getElementById("spec-title");
    var host = document.getElementById("spec-detail");
    if (!app.spec) {
      title.textContent = "";
      return fill(host, [el("p", { class: "tr-empty", text: t().noSelection })]);
    }
    var detail = app.spec.detail;
    // id/类型/链接都来自 state 里已有的节点；插件只回一份正文与 frontmatter。
    var node = nodeByPathExact(detail.file) || {
      id: app.spec.path,
      type: "",
      title: null,
      path: app.spec.path,
      links: [],
    };
    title.textContent = displayTitle(node);

    var children = [
      el("dl", { class: "tr-fields" }, [
        el("dt", { text: "id" }),
        el("dd", { text: node.id || app.spec.path }),
        el("dt", { text: t().kind }),
        el("dd", { text: node.type || "" }),
        el("dt", { text: "path" }),
        el("dd", { text: detail.file || app.spec.path }),
      ]),
    ];
    var links = node.links || [];
    var reverse = reverseLinksOf(node.id);
    if (links.length) children.push(linkRows(links));
    if (reverse.length) {
      children.push(el("div", { class: "tr-group", text: t().reverseLinks }));
      children.push(linkRows(reverse));
    }
    children.push(el("pre", { class: "tr-body", text: detail.body || "" }));
    fill(host, children);
  }

  // ── shell ────────────────────────────────────────────────────────────────

  function render() {
    var strings = t();
    document.getElementById("tab-specs").textContent = strings.tabSpecs;
    document.getElementById("refresh").textContent = strings.refresh;
    document.getElementById("filter").placeholder = strings.filterPlaceholder;

    document.querySelectorAll(".tr-tab").forEach(function (tab) {
      tab.setAttribute("aria-selected", tab.dataset.view === app.view ? "true" : "false");
    });
    document.getElementById("view-specs").hidden = app.view !== "specs";

    var project = document.getElementById("project");
    var state = app.state;
    project.textContent = state && state.project ? state.project.path : "";

    var chip = document.getElementById("chip");
    var specs = state && state.specs;
    if (app.view === "specs" && specs) {
      chip.hidden = false;
      chip.className = "tr-chip " + (specs.issues.valid ? "ok" : "bad");
      chip.textContent =
        ((state.stale ? strings.stale + " · " : "") + (state.indexing ? strings.indexing + " · " : "") +
        (specs.issues.valid
          ? specs.count + " " + strings.specsCount + " · " + strings.graphValid
          : specs.count +
            " " +
            strings.specsCount +
            " · " +
            strings.graphIssues +
            " " +
            (specs.issues.dangling + specs.issues.duplicates + specs.issues.cycles)) +
        (specs.truncated ? " · " + strings.partialIndex : ""));
    } else {
      chip.hidden = true;
    }

    var noteNode = document.getElementById("note");
    var visibleNote = app.note || (state && state.specError ? { kind: "error", text: state.specError } : null);
    if (visibleNote) {
      noteNode.hidden = false;
      noteNode.className = "tr-note " + (visibleNote.kind === "error" ? "error" : "");
      noteNode.textContent = visibleNote.text;
    } else {
      noteNode.hidden = true;
    }

    document.getElementById("refresh").disabled = app.busy;
    if (app.state === null) {
      fill(document.getElementById("spec-list"), [el("p", { class: "tr-empty", text: strings.loading })]);
      return;
    }
    renderSpecList();
    renderSpecDetail();
  }

  /**
   * 拖动分隔条调整上下两个窗格的高度。
   *
   * 值写进容器上的 CSS 变量（`--tr-split-top`），同时记进 localStorage，重开面板还是你调好的
   * 高度。键盘也能改（↑/↓ 各 5%，Home/End 到极限），因为分隔条本身是 `role="separator"` +
   * `tabindex="0"`。
   */
  function readSplitTop() {
    try {
      var stored = Number(window.localStorage.getItem(SPLIT_KEY));
      if (stored >= SPLIT_MIN && stored <= SPLIT_MAX) return stored;
    } catch (error) {
      /* file:// 下 localStorage 不可用时就用默认值 */
    }
    return SPLIT_DEFAULT;
  }

  function applySplitTop(pct) {
    var value = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct));
    document.querySelectorAll(".tr-split").forEach(function (split) {
      split.style.setProperty("--tr-split-top", value + "%");
    });
    document.querySelectorAll("[data-splitter]").forEach(function (bar) {
      bar.setAttribute("aria-valuenow", String(Math.round(value)));
      bar.setAttribute("aria-valuemin", String(SPLIT_MIN));
      bar.setAttribute("aria-valuemax", String(SPLIT_MAX));
    });
    try {
      window.localStorage.setItem(SPLIT_KEY, String(value));
    } catch (error) {
      /* 记不住也无所谓，本次会话内仍然有效 */
    }
    return value;
  }

  function wireSplitter(bar) {
    var split = bar.parentElement;
    var dragging = false;

    var moveTo = function (clientY) {
      var rect = split.getBoundingClientRect();
      if (rect.height <= 0) return;
      applySplitTop(((clientY - rect.top) / rect.height) * 100);
    };

    bar.addEventListener("pointerdown", function (event) {
      dragging = true;
      bar.dataset.dragging = "true";
      bar.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    bar.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      moveTo(event.clientY);
    });
    var stop = function (event) {
      if (!dragging) return;
      dragging = false;
      delete bar.dataset.dragging;
      if (bar.hasPointerCapture(event.pointerId)) bar.releasePointerCapture(event.pointerId);
    };
    bar.addEventListener("pointerup", stop);
    bar.addEventListener("pointercancel", stop);

    bar.addEventListener("keydown", function (event) {
      var step = event.key === "ArrowUp" ? -5 : event.key === "ArrowDown" ? 5 : 0;
      if (step !== 0) {
        applySplitTop(readSplitTop() + step);
        event.preventDefault();
        return;
      }
      if (event.key === "Home") {
        applySplitTop(SPLIT_MIN);
        event.preventDefault();
      } else if (event.key === "End") {
        applySplitTop(SPLIT_MAX);
        event.preventDefault();
      }
    });
  }

  function wire() {
    document.querySelectorAll("[data-splitter]").forEach(wireSplitter);
    applySplitTop(readSplitTop());

    document.getElementById("refresh").addEventListener("click", function () {
      reload({ fresh: true });
    });
    document.querySelectorAll(".tr-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        app.view = tab.dataset.view;
        app.matches = null;
        app.filter = "";
        document.getElementById("filter").value = "";
        render();
      });
    });

    var filter = document.getElementById("filter");
    filter.addEventListener("input", function () {
      app.searchRequest++;
      app.filter = filter.value.trim();
      if (!app.filter) app.matches = null;
      render();
    });
    filter.addEventListener("keydown", async function (event) {
      if (event.key === "Escape") {
        app.searchRequest++;
        filter.value = "";
        app.filter = "";
        app.matches = null;
        render();
        return;
      }
      if (event.key !== "Enter" || !app.filter) return;
      var epoch = app.epoch;
      var request = ++app.searchRequest;
      app.busy = true;
      note(null);
      render();
      try {
        var result = await invoke("grep", { pattern: app.filter });
        if (epoch === app.epoch && request === app.searchRequest &&
            (result.projectId === undefined || result.projectId === app.projectId)) app.matches = result;
      } catch (error) {
        if (epoch === app.epoch && request === app.searchRequest)
          note("error", error.message || String(error));
      } finally {
        if (epoch === app.epoch) {
          app.busy = false;
          render();
        }
      }
    });

    if (window.__appearance) {
      window.__appearance.init(bridge);
      window.__appearance.onLocaleChange(function () {
        render();
      });
    }
  }

  wire();
  render();
  // 先认下命令可能已经留下的意向，再整体读一次——这样命令开到哪里，视图第一次画就在哪里。
  syncHint({ reload: false })
    .catch(function () {})
    .then(function () {
      return reload();
    })
    .then(startHintPoll);
})();
