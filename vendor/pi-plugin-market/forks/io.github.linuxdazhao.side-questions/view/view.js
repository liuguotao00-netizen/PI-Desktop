"use strict";

const bridge = window.pluginBridge;
const byId = id => document.getElementById(id);
const ui = Object.fromEntries([
  "heading", "parent", "new", "history", "history-title", "search", "branches", "more",
  "branch-header", "anchor-preview", "delete", "error", "transcript", "empty", "older",
  "rows", "interactive", "composer", "anchor", "anchor-label", "draft", "working", "stop", "send",
].map(id => [id, byId(id)]));
const english = {
  title: "Side Questions", new: "New", history: "History", search: "Search side questions",
  more: "Show more", older: "Earlier messages", delete: "Delete", send: "Send", stop: "Stop",
  draft: "Ask a follow-up…", source: "Start from", working: "Working…",
  noParent: "Open a local Agent conversation to ask a side question.",
  noAnchor: "A completed assistant reply will appear here as a starting point.",
  newQuestion: "Choose a reply and enter your question.",
  empty: "No follow-ups yet.", missing: "This side conversation was deleted.",
  allow: "Allow once", deny: "Deny", answer: "Submit answer", skip: "Skip",
};
const chinese = {
  title: "支线提问", new: "新建", history: "历史", search: "搜索支线提问",
  more: "显示更多", older: "更早的消息", delete: "删除", send: "发送", stop: "停止",
  draft: "输入追问…", source: "从这条回复分叉", working: "处理中…",
  noParent: "打开一个本地 Agent 对话即可使用支线提问。",
  noAnchor: "主对话完成回复后，就可以从这里分叉。",
  newQuestion: "选一条回复，然后输入你的问题。",
  empty: "还没有追问。", missing: "这条支线已被删除。",
  allow: "允许一次", deny: "拒绝", answer: "提交回答", skip: "跳过",
};

const state = {
  parent: null, anchors: [], branches: [], selected: null, source: "", rows: [],
  running: false, older: null, interactive: null, missing: false, busy: false,
  visibleHistory: 20,
};
const drafts = new Map();
const lastBranch = new Map();
const draftIds = new Map();
let strings = english;
let contextTicket = 0;
let branchTicket = 0;
let interactiveSignature = "";
let timer;
const reading = new Set();
let rowsRevision = "";

function call(action, payload) {
  return bridge.invoke(`sideQuestions.${action}`, payload);
}

function error(failure) {
  ui.error.hidden = !failure;
  ui.error.textContent = failure?.message ?? String(failure ?? "");
}

function appearance(value) {
  strings = (value?.locale ?? navigator.language).startsWith("zh") ? chinese : english;
  document.documentElement.lang = strings === chinese ? "zh-CN" : "en";
  const tone = value?.base === "light" || value?.base === "dark"
    ? value.base
    : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.tone = tone;
  interactiveSignature = "";
  render();
}

function branch() {
  return state.branches.find(item => item.id === state.selected);
}

function draftKey() {
  return state.selected ?? state.parent?.id;
}

function updateActions() {
  const ready = Boolean(state.parent && (state.selected || state.source) && !state.missing);
  ui.draft.disabled = !ready;
  ui.send.disabled = !ready || state.running || state.busy || !ui.draft.value.trim();
  ui.stop.hidden = !state.running;
  ui.stop.disabled = state.busy;
  ui.delete.disabled = state.running || state.busy;
  ui.working.textContent = state.running ? strings.working : "";
}

function button(label, click) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.addEventListener("click", click);
  return element;
}

function renderHistory() {
  ui.history.hidden = !state.branches.length;
  ui["history-title"].textContent = `${strings.history} (${state.branches.length})`;
  const query = ui.search.value.trim().toLocaleLowerCase();
  const matches = state.branches.filter(item => `${item.title} ${item.anchor}`.toLocaleLowerCase().includes(query));
  ui.more.hidden = matches.length <= state.visibleHistory;
  ui.branches.replaceChildren(...matches.slice(0, state.visibleHistory).map(item => {
    const row = document.createElement("li");
    const open = button(item.title, () => { select(item.id); ui.history.open = false; });
    open.setAttribute("aria-current", String(item.id === state.selected));
    row.append(open);
    return row;
  }));
}

function renderRows() {
  const revision = JSON.stringify(state.rows);
  if (rowsRevision === revision) return;
  rowsRevision = revision;
  const follow = ui.transcript.scrollHeight - ui.transcript.scrollTop - ui.transcript.clientHeight < 45;
  ui.rows.replaceChildren(...state.rows.map(message => {
    const row = document.createElement("article");
    row.className = "row";
    row.dataset.role = message.role;
    row.textContent = message.error || message.content;
    return row;
  }));
  if (follow) ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

function renderInteractive() {
  const permission = state.interactive?.permissions?.[0];
  const ask = state.interactive?.asks?.[0];
  const signature = JSON.stringify([state.selected, permission, ask]);
  if (signature === interactiveSignature) return;
  interactiveSignature = signature;
  ui.interactive.hidden = !permission && !ask;
  ui.interactive.replaceChildren();
  const id = state.selected;
  if (permission) {
    const reason = document.createElement("p");
    reason.textContent = `${permission.toolName} · ${permission.reason}`;
    const args = document.createElement("pre");
    args.textContent = JSON.stringify(permission.argsPreview, null, 2);
    ui.interactive.append(reason, args);
    for (const [decision, label] of [["allow-once", strings.allow], ["deny", strings.deny]]) {
      ui.interactive.append(button(label, () => actFor(id, "permission", { requestId: permission.requestId, decision })));
    }
  }
  if (ask) {
    const groups = ask.questions.map((question, index) => {
      const field = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = question.question;
      field.append(legend);
      const inputs = question.options.map(option => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = question.multiSelect ? "checkbox" : "radio";
        input.name = `answer-${index}`;
        input.value = typeof option === "string" ? option : option.label;
        label.append(input, ` ${input.value}`);
        field.append(label);
        return input;
      });
      ui.interactive.append(field);
      return inputs;
    });
    const answer = skip => actFor(id, "answer", {
      requestId: ask.requestId,
      answers: groups.map(inputs => skip ? null : inputs.filter(input => input.checked).map(input => input.value)),
    });
    ui.interactive.append(button(strings.answer, () => answer(false)), button(strings.skip, () => answer(true)));
  }
}

function render() {
  const current = branch();
  ui.heading.textContent = strings.title;
  ui.parent.textContent = state.parent?.title ?? "";
  ui.parent.title = ui.parent.textContent;
  ui.new.textContent = strings.new;
  ui.new.disabled = !state.anchors.length;
  ui.search.placeholder = strings.search;
  ui.search.setAttribute("aria-label", strings.search);
  ui.more.textContent = strings.more;
  ui.older.textContent = strings.older;
  ui.older.hidden = !state.older;
  ui.delete.textContent = strings.delete;
  ui.send.textContent = strings.send;
  ui.stop.textContent = strings.stop;
  ui.draft.placeholder = strings.draft;
  ui.draft.setAttribute("aria-label", strings.draft);
  ui.composer.hidden = !state.parent || (!state.anchors.length && !current);
  ui["anchor-label"].textContent = strings.source;
  ui["anchor-label"].hidden = Boolean(current);
  ui.anchor.hidden = Boolean(current);
  ui["branch-header"].hidden = !current;
  ui["anchor-preview"].textContent = current?.anchor ?? "";
  ui["anchor-preview"].title = ui["anchor-preview"].textContent;
  ui.empty.hidden = state.rows.length > 0;
  ui.empty.textContent = state.missing ? strings.missing :
    !state.parent ? strings.noParent : current ? strings.empty :
    !state.anchors.length ? strings.noAnchor : strings.newQuestion;
  renderHistory();
  renderRows();
  renderInteractive();
  updateActions();
}

function chooseSource() {
  if (!state.anchors.some(item => item.id === state.source)) state.source = state.anchors[0]?.id ?? "";
  ui.anchor.replaceChildren(...state.anchors.map(item => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    return option;
  }));
  ui.anchor.value = state.source;
}

function select(id) {
  ++branchTicket;
  state.selected = id;
  if (state.parent) lastBranch.set(state.parent.id, id);
  Object.assign(state, { rows: [], olderRows: [], older: null, running: false, interactive: null, missing: false, busy: false });
  ui.draft.value = drafts.get(draftKey()) ?? "";
  error(null);
  render();
  if (id) void refreshBranch();
}

async function refreshContext() {
  const ticket = ++contextTicket;
  try {
    const result = await call("context");
    if (ticket !== contextTicket) return;
    const changed = state.parent?.id !== result.parent?.id;
    Object.assign(state, result);
    chooseSource();
    if (changed || (state.selected && !branch())) {
      const preferred = lastBranch.get(state.parent?.id);
      select(state.branches.some(item => item.id === preferred) ? preferred : null);
    } else render();
  } catch (failure) {
    if (ticket === contextTicket) error(failure);
  }
}

async function refreshBranch(older = false) {
  const id = state.selected;
  if (!id || reading.has(id)) return;
  const ticket = branchTicket;
  const before = older ? state.older : undefined;
  if (older && !before) return;
  reading.add(id);
  try {
    const result = await call("read", { id, before });
    if (ticket !== branchTicket) return;
    if (older) {
      state.olderRows = [...result.rows, ...state.olderRows];
      state.older = result.older;
    } else {
      if (!state.olderRows.length) state.older = result.older;
      state.running = result.running;
      state.interactive = result.interactive;
      state.missing = result.missing === true;
    }
    const rows = older ? [...result.rows, ...state.rows] : [...state.olderRows, ...result.rows];
    state.rows = [...new Map(rows.map(message => [message.id, message])).values()];
    render();
  } catch (failure) {
    if (ticket === branchTicket) error(failure);
  } finally {
    reading.delete(id);
  }
}

async function actFor(id, action, payload = {}) {
  if (id !== state.selected || state.busy) return;
  const ticket = branchTicket;
  state.busy = true;
  updateActions();
  error(null);
  try {
    await call(action, { ...payload, id });
    if (ticket !== branchTicket) return;
    if (action === "delete") {
      select(null);
      await refreshContext();
    } else {
      await refreshBranch();
    }
  } catch (failure) {
    if (ticket === branchTicket) error(failure);
  } finally {
    if (ticket === branchTicket) {
      state.busy = false;
      updateActions();
    }
  }
}

async function submit(event) {
  event.preventDefault();
  if (ui.send.disabled || !state.parent) return;
  const parentId = state.parent.id;
  let id = state.selected;
  let ticket = branchTicket;
  const content = ui.draft.value.trim();
  state.busy = true;
  updateActions();
  error(null);
  try {
    if (!id) {
      if (!draftIds.has(parentId)) draftIds.set(parentId, crypto.randomUUID());
      const created = await call("create", {
        parentId, anchorId: state.source, draftId: draftIds.get(parentId), title: content,
      });
      if (ticket !== branchTicket) return;
      id = created.id;
      if (!state.branches.some(item => item.id === id)) state.branches.unshift(created);
      drafts.set(id, ui.draft.value);
      drafts.delete(parentId);
      draftIds.delete(parentId);
      select(id);
      ticket = branchTicket;
      state.busy = true;
      updateActions();
    }
    await call("send", { id, content });
    if (drafts.get(id)?.trim() === content) drafts.delete(id);
    if (ticket !== branchTicket) return;
    if (ui.draft.value.trim() === content) ui.draft.value = "";
    await refreshBranch();
  } catch (failure) {
    if (ticket === branchTicket) error(failure);
  } finally {
    if (ticket === branchTicket) {
      state.busy = false;
      updateActions();
    }
  }
}

ui.anchor.addEventListener("change", () => { state.source = ui.anchor.value; updateActions(); });
ui.draft.addEventListener("input", () => { drafts.set(draftKey(), ui.draft.value); updateActions(); });
ui.composer.addEventListener("submit", submit);
ui.new.addEventListener("click", () => { select(null); ui.draft.focus(); });
ui.stop.addEventListener("click", () => actFor(state.selected, "stop"));
ui.delete.addEventListener("click", () => actFor(state.selected, "delete"));
ui.search.addEventListener("input", () => { state.visibleHistory = 20; renderHistory(); });
ui.more.addEventListener("click", () => { state.visibleHistory += 20; renderHistory(); });
ui.older.addEventListener("click", () => refreshBranch(true));

appearance();
if (bridge) {
  bridge.invoke("app.getAppearance").then(appearance).catch(() => {});
  bridge.on("appearance:changed", appearance);
  bridge.on("session:activated", refreshContext);
  bridge.on("session:turnEnded", () => { if (!document.hidden) void refreshBranch(); });
  void refreshContext();
  timer = setInterval(() => { if (!document.hidden) void refreshBranch(); }, 1600);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}
