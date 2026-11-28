"use strict";

const bridge = window.pluginBridge;
const byId = id => document.getElementById(id);
const ui = Object.fromEntries([
  "heading", "parent", "new", "history", "history-title", "search", "branches", "more",
  "branch-header", "anchor-preview", "delete", "error", "transcript", "empty", "older",
  "rows", "interactive", "composer", "anchor", "anchor-label", "draft", "working", "stop", "send",
  "paste-reference", "reference-chip", "reference-preview", "remove-reference",
].map(id => [id, byId(id)]));
const english = {
  title: "Side Questions", new: "New", history: "History", search: "Search side questions",
  more: "Show more", older: "Earlier messages", delete: "Delete", send: "Send", stop: "Stop",
  draft: "Ask a follow-up…", source: "Start from", working: "Working…",
  noParent: "Open a local Agent conversation to ask a side question.",
  newQuestion: "Choose a reply or paste a reference.",
  newConversation: "New conversation",
  pasteReference: "Paste text as a reference…",
  removeReference: "Remove reference",
  referenceTooLarge: "Paste a reference smaller than 64 KiB.",
  empty: "No follow-ups yet.", missing: "This side conversation was deleted.",
  allow: "Allow once", deny: "Deny", answer: "Submit answer", skip: "Skip",
};
const chinese = {
  title: "支线提问", new: "新建", history: "历史", search: "搜索支线提问",
  more: "显示更多", older: "更早的消息", delete: "删除", send: "发送", stop: "停止",
  draft: "输入追问…", source: "对话起点", working: "处理中…",
  noParent: "打开一个本地 Agent 对话即可使用支线提问。",
  newQuestion: "选一条回复，或粘贴一段文字作为引用。",
  newConversation: "全新对话",
  pasteReference: "粘贴文字作为引用…",
  removeReference: "移除引用",
  referenceTooLarge: "请粘贴小于 64 KiB 的文字。",
  empty: "还没有追问。", missing: "这条支线已被删除。",
  allow: "允许一次", deny: "拒绝", answer: "提交回答", skip: "跳过",
};

const state = {
  parent: null, anchors: [], branches: [], selected: null, source: null, rows: [],
  running: false, older: null, interactive: null, missing: false, busy: false, canReference: false,
  visibleHistory: 20,
};
const drafts = new Map();
const references = new Map();
const lastBranch = new Map();
const draftIds = new Map();
let strings = english;
let contextTicket = 0;
let pendingSelection;
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
  const ready = Boolean(state.parent && !state.missing);
  ui.anchor.disabled = state.busy;
  ui["paste-reference"].disabled = state.busy;
  ui["remove-reference"].disabled = state.busy;
  ui.draft.disabled = !ready;
  ui.send.disabled = !ready || state.running || state.busy || !ui.draft.value.trim();
  ui.stop.hidden = !state.running;
  ui.stop.disabled = state.busy;
  ui.delete.disabled = state.running || state.busy;
  ui.working.textContent = state.running ? strings.working : "";
}

function renderReference() {
  const reference = references.get(draftKey());
  const canPaste = Boolean(state.parent) && (!state.selected || state.canReference);
  const hasReference = Boolean(reference);
  const showSource = Boolean(state.parent) && !state.selected && !hasReference;
  ui.anchor.hidden = !showSource;
  ui["anchor-label"].hidden = !showSource;
  ui["paste-reference"].hidden = !canPaste || hasReference;
  ui["reference-chip"].hidden = !hasReference;
  const characters = Array.from((reference ?? "").replace(/\s+/g, " ").trim());
  ui["reference-preview"].textContent = characters.slice(0, 36).join("") +
    (characters.length > 36 ? "…" : "");
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
    if (message.reference) {
      const quote = document.createElement("div");
      quote.className = "reference-chip";
      const label = document.createElement("span");
      label.textContent = message.reference;
      quote.append(label);
      row.append(quote);
    }
    row.append(message.error || message.content || "");
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
  ui.new.disabled = !state.parent;
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
  ui.composer.hidden = !state.parent;
  ui["paste-reference"].placeholder = strings.pasteReference;
  ui["paste-reference"].setAttribute("aria-label", strings.pasteReference);
  ui["remove-reference"].setAttribute("aria-label", strings.removeReference);
  ui["remove-reference"].title = strings.removeReference;
  ui["anchor-label"].textContent = strings.source;
  if (ui.anchor.options[0]) ui.anchor.options[0].textContent = strings.newConversation;
  ui["branch-header"].hidden = !current;
  ui["anchor-preview"].textContent = current?.referenceOnly ? strings.newConversation : current?.anchor ?? "";
  ui["anchor-preview"].title = ui["anchor-preview"].textContent;
  ui.empty.hidden = state.rows.length > 0;
  ui.empty.textContent = state.missing ? strings.missing :
    !state.parent ? strings.noParent : current ? strings.empty : strings.newQuestion;
  renderReference();
  renderHistory();
  renderRows();
  renderInteractive();
  updateActions();
}

function chooseSource() {
  if (state.source !== "" && !state.anchors.some(item => item.id === state.source)) {
    state.source = state.anchors[0]?.id ?? "";
  }
  const sources = [{ id: "", label: strings.newConversation }, ...state.anchors];
  ui.anchor.replaceChildren(...sources.map(item => {
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
  Object.assign(state, { rows: [], olderRows: [], older: null, running: false, interactive: null, missing: false, busy: false, canReference: false });
  ui.draft.value = drafts.get(draftKey()) ?? "";
  ui["paste-reference"].value = "";
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
    if (changed) state.source = references.has(state.parent?.id) ? "" : null;
    chooseSource();
    if (pendingSelection) {
      const { sessionId, text } = pendingSelection;
      pendingSelection = undefined;
      if (sessionId === state.parent?.id) {
        drafts.delete(sessionId);
        draftIds.delete(sessionId);
        state.source = "";
        ui.anchor.value = "";
        select(null);
        setReference(text);
        return;
      }
    }
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
      state.canReference = result.canReference === true;
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
  const reference = references.get(draftKey());
  state.busy = true;
  updateActions();
  error(null);
  try {
    if (!id) {
      if (!draftIds.has(parentId)) draftIds.set(parentId, crypto.randomUUID());
      const created = await call("create", {
        parentId,
        ...(state.source ? { anchorId: state.source } : { referenceOnly: true }),
        draftId: draftIds.get(parentId),
        title: content,
      });
      if (ticket !== branchTicket) return;
      id = created.id;
      if (!state.branches.some(item => item.id === id)) state.branches.unshift(created);
      drafts.set(id, ui.draft.value);
      if (reference) references.set(id, reference);
      references.delete(parentId);
      drafts.delete(parentId);
      draftIds.delete(parentId);
      select(id);
      ticket = branchTicket;
      state.busy = true;
      updateActions();
    }
    await call("send", { id, content, ...(reference ? { reference } : {}) });
    if (drafts.get(id)?.trim() === content) drafts.delete(id);
    if (references.get(id) === reference) references.delete(id);
    if (ticket !== branchTicket) return;
    state.canReference = false;
    renderReference();
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

function setReference(value) {
  if (state.busy || !state.parent || (state.selected && !state.canReference)) return;
  if (!value.trim()) return;
  if (new TextEncoder().encode(value).length >= 64 * 1024) {
    error(new Error(strings.referenceTooLarge));
    return;
  }
  if (!state.selected) {
    if (state.source) draftIds.delete(state.parent.id);
    state.source = "";
    ui.anchor.value = "";
  }
  references.set(draftKey(), value);
  ui["paste-reference"].value = "";
  error(null);
  renderReference();
  ui.draft.focus();
}

ui.anchor.addEventListener("change", () => {
  state.source = ui.anchor.value;
  draftIds.delete(state.parent.id);
  if (state.source) references.delete(state.parent.id);
  else references.set(state.parent.id, "");
});
ui["paste-reference"].addEventListener("paste", event => {
  event.preventDefault();
  setReference(event.clipboardData.getData("text/plain"));
});
ui["paste-reference"].addEventListener("change", () => setReference(ui["paste-reference"].value));
ui["remove-reference"].addEventListener("click", () => {
  if (state.selected) references.delete(state.selected);
  else references.set(draftKey(), "");
  error(null);
  renderReference();
  ui["paste-reference"].focus();
});
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
  bridge.on("view:selection", selection => {
    if (typeof selection?.sessionId !== "string" || typeof selection.text !== "string" ||
        !selection.text.trim() || new TextEncoder().encode(selection.text).length >= 64 * 1024) return;
    pendingSelection = selection;
    void refreshContext();
  });
  bridge.on("session:turnEnded", () => { if (!document.hidden) void refreshBranch(); });
  void refreshContext();
  timer = setInterval(() => { if (!document.hidden) void refreshBranch(); }, 1600);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}
