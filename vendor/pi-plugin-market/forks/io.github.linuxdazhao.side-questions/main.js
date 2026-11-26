"use strict";

const HISTORY = "sideQuestionsV1";
const PAGE_SIZE = 60;
let writes = Promise.resolve();
const sending = new Set();

function invoke(operation, args, confirm = false) {
  return pi.desktop.invoke({ operation, args, ...(confirm ? { confirm } : {}) });
}

function serialWrite(action) {
  const next = writes.then(action);
  writes = next.catch(() => {});
  return next;
}

function text(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function label(content, length) {
  const characters = Array.from(content.replace(/\s+/g, " ").trim());
  return characters.slice(0, length).join("") + (characters.length > length ? "…" : "");
}

async function history() {
  const stored = (await pi.plugin.getSettings())[HISTORY];
  return Array.isArray(stored) ? stored : [];
}

function session(id, options = {}) {
  return invoke("session/get", [{ id, messageLimit: PAGE_SIZE, contentLimit: 32 * 1024, ...options }])
    .then(result => result?.session);
}

async function activeParent() {
  const active = await pi.session.getActive();
  const id = active?.sessionId;
  if (!id || id.startsWith("native-pi:") || id.startsWith("remote:")) return null;
  const branches = await history();
  if (branches.some(branch => branch.id === id)) return null;
  return id;
}

function isSupported(source) {
  return source && source.mode === "agent" && !source.scheduledRun &&
    source.source !== "pi-native" && source.source !== "remote" && !source.remoteWorkspace;
}

function sourceAnchors(source) {
  return (source?.messages ?? []).filter(message =>
    message.role === "assistant" && (message.status === undefined || message.status === "complete") &&
    !message.error && typeof message.content === "string" && message.content.trim()
  );
}

async function context() {
  const parentId = await activeParent();
  if (!parentId) return { parent: null, anchors: [], branches: [] };
  const [source, branches] = await Promise.all([session(parentId), history()]);
  if (!isSupported(source)) return { parent: null, anchors: [], branches: [] };
  return {
    parent: { id: parentId, title: source.title },
    anchors: sourceAnchors(source).slice(-12).reverse().map(message => ({
      id: message.id,
      label: label(message.content, 84),
    })),
    branches: branches.filter(branch => branch.parentId === parentId).reverse(),
  };
}

async function create(payload) {
  const { parentId, anchorId } = payload;
  const draftId = text(payload.draftId, 100);
  const title = label(text(payload.title, 160), 56);
  if (typeof parentId !== "string" || !draftId || !title || parentId !== await activeParent()) {
    throw new Error("Open a local Agent conversation and enter a question first.");
  }
  return serialWrite(async () => {
    const branches = await history();
    const previous = branches.find(branch => branch.parentId === parentId && branch.draftId === draftId);
    if (previous) return previous;
    const source = await session(parentId);
    const anchor = sourceAnchors(source).find(message => message.id === anchorId);
    if (!isSupported(source) || !anchor) throw new Error("Choose a completed assistant reply.");
    if (parentId !== await activeParent()) throw new Error("The selected conversation changed.");
    const { session: child } = await invoke("session/fork", [{
      sessionId: parentId,
      throughMessageId: anchor.id,
      title,
    }]);
    if (!child?.id || child.id === parentId || !Number.isSafeInteger(child.messageCount)) {
      throw new Error("The host did not create a side conversation.");
    }
    const branch = {
      id: child.id,
      parentId,
      draftId,
      title,
      anchor: label(anchor.content, 84),
      inheritedCount: child.messageCount,
    };
    await pi.plugin.setSettings({ [HISTORY]: [...branches, branch] });
    return branch;
  });
}

async function ownedBranch(id) {
  const parentId = await activeParent();
  const branch = (await history()).find(entry => entry.id === id && entry.parentId === parentId);
  if (!branch) throw new Error("This side question is not available in the selected conversation.");
  return branch;
}

async function isRunning(id) {
  const { status } = await invoke("agent/getStatus", [id]);
  return status?.isRunning === true || sending.has(id);
}

async function read(payload) {
  const branch = await ownedBranch(payload.id);
  const before = Number.isSafeInteger(payload.before) ? payload.before : undefined;
  const [child, running, interactive] = await Promise.all([
    session(branch.id, before ? { messageBefore: before } : {}),
    isRunning(branch.id),
    before ? null : invoke("agent/pendingInteractive", [{ sessionId: branch.id }]),
  ]);
  if (!child) return { missing: true, rows: [], running: false };
  const start = child.messageStart ?? 0;
  return {
    rows: (child.messages ?? []).slice(Math.max(0, branch.inheritedCount - start))
      .filter(message => message.role === "user" || message.role === "assistant")
      .map(({ id, role, content, error }) => ({ id, role, content, error: error?.message })),
    older: start > branch.inheritedCount ? start : null,
    running,
    interactive,
  };
}

async function send(payload) {
  const { id } = await ownedBranch(payload.id);
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (!content || content.length > 64 * 1024) throw new Error("Enter a question up to 64 KiB.");
  if (sending.has(id)) throw new Error("A question is already being sent.");
  sending.add(id);
  try {
    const result = await invoke("agent/prompt", [{ sessionId: id, content }]);
    if (result?.accepted !== true) throw new Error("The host did not accept the question.");
    return result;
  } finally {
    sending.delete(id);
  }
}

async function remove(payload) {
  const { id } = await ownedBranch(payload.id);
  if (await isRunning(id)) throw new Error("Stop the side question before deleting it.");
  return serialWrite(async () => {
    // The desktop confirms destructive operations in its own native dialog.
    const result = await invoke("session/delete", [id], true);
    if (result?.ok === false) throw new Error("The host did not delete the conversation.");
    await pi.plugin.setSettings({ [HISTORY]: (await history()).filter(branch => branch.id !== id) });
  });
}

async function permission(payload) {
  const { id } = await ownedBranch(payload.id);
  if (payload.decision !== "allow-once" && payload.decision !== "deny") {
    throw new Error("Choose Allow once or Deny.");
  }
  const { permissions } = await invoke("agent/pendingInteractive", [{ sessionId: id }]);
  const request = permissions?.find(item => item.requestId === payload.requestId && item.sessionId === id);
  if (!request) throw new Error("This tool request has already changed.");
  return invoke("tool/resolvePermission", [{
    requestId: request.requestId,
    sessionId: id,
    decision: payload.decision,
  }], true);
}

async function answer(payload) {
  const { id } = await ownedBranch(payload.id);
  const { asks } = await invoke("agent/pendingInteractive", [{ sessionId: id }]);
  const request = asks?.find(item => item.requestId === payload.requestId && item.sessionId === id);
  if (!request) throw new Error("This question has already changed.");
  const answers = request.questions.map((question, index) => {
    const selected = Array.isArray(payload.answers?.[index]) ? payload.answers[index] : [];
    const options = question.options.map(option => typeof option === "string" ? option : option.label);
    const values = [...new Set(selected)].filter(option => options.includes(option));
    return values.length ? values.slice(0, question.multiSelect ? undefined : 1) : null;
  });
  return invoke("agent/askTool/resolve", [{ sessionId: id, requestId: request.requestId, answers }], true);
}

async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    case "sideQuestions.context": return context();
    case "sideQuestions.create": return create(payload);
    case "sideQuestions.read": return read(payload);
    case "sideQuestions.send": return send(payload);
    case "sideQuestions.stop": {
      const { id } = await ownedBranch(payload.id);
      return invoke("agent/abort", [{ sessionId: id }]);
    }
    case "sideQuestions.delete": return remove(payload);
    case "sideQuestions.permission": return permission(payload);
    case "sideQuestions.answer": return answer(payload);
    default: throw new Error("Unsupported Side Questions action.");
  }
}

module.exports = { onPanelInvoke };
