const MAX_TREE_CHARS = 24_000;
const MAX_HISTORY = 24;

function fail(message) {
  return [{ type: "text", text: message }];
}

function parseAction(text) {
  const source = String(text ?? "").trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(source.slice(start, end + 1));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

async function modelKey() {
  try {
    const context = await pi.session.getLlmContext();
    if (context?.modelKey) return context.modelKey;
  } catch {
    // Fall through to the catalogue.
  }
  const models = await pi.models.list();
  const preferred = models.find((model) => model.isDefault) ?? models.find((model) => model.availableForSubagents) ?? models[0];
  return preferred?.key ?? null;
}

function prompt(goal, observation, history, plan) {
  return [
    "You are driving the visible browser for one task.",
    `Goal: ${goal}`,
    "",
    "Current page:",
    observation,
    "",
    history.length ? `Previous actions:\n${history.join("\n")}` : "No previous actions.",
    plan.length ? `Current plan:\n${plan.map((item, index) => `${index + 1}. ${item}`).join("\n")}` : "No plan yet.",
    "",
    "Answer with exactly one JSON object and nothing else:",
    '{"action":"click","uid":"e12","note":"why"}',
    '{"action":"fill","uid":"e7","text":"value","note":"why"}',
    '{"action":"hover","uid":"e7","note":"why"}',
    '{"action":"select","uid":"e7","value":"option","note":"why"}',
    '{"action":"press","key":"Enter","note":"why"}',
    '{"action":"scroll","dy":600,"note":"why"}',
    '{"action":"drag","from":{"x":100,"y":100},"to":{"x":300,"y":300},"note":"why"}',
    '{"action":"navigate","url":"https://example.com","note":"why"}',
    '{"action":"new_tab","url":"https://example.com","note":"why"}',
    '{"action":"switch_tab","tabId":"...","note":"why"}',
    '{"action":"close_tab","tabId":"...","note":"why"}',
    '{"action":"wait","selector":".result","text":"Success","urlContains":"/done","timeoutMs":8000,"note":"why"}',
    '{"action":"wait","idle":true,"timeoutMs":8000,"note":"wait for load/network settle"}',
    '{"action":"screenshot","fullPage":true,"note":"why"}',
    '{"action":"download","url":"https://example.com/file.pdf","filename":"file.pdf","note":"why"}',
    '{"action":"upload","selector":"input[type=file]","files":["/abs/path/file.pdf"],"note":"why"}',
    '{"action":"frame","frame":{"action":"text","frameId":"..."},"note":"why"}',
    '{"action":"dialog","accept":true,"promptText":"...","note":"why"}',
    '{"action":"done","summary":"what is now true"}',
    '{"action":"ask","question":"what you need"}',
    "Use only uids present in the current page snapshot. Do not guess.",
  ].join("\n");
}

async function observe(vision) {
  const [snapshot, text] = await Promise.all([
    pi.browser.snapshot(),
    pi.browser.evaluate({ expression: "document.body ? document.body.innerText.slice(0, 4000) : ''" }).catch(() => ""),
  ]);
  const tree = String(snapshot?.tree ?? "").slice(0, MAX_TREE_CHARS);
  const observation = [
    `URL: ${snapshot?.url ?? ""}`,
    `Title: ${snapshot?.title ?? ""}`,
    "",
    "Accessibility snapshot:",
    tree,
    "",
    "Page text:",
    String(text?.value ?? text ?? "").slice(0, 4000),
  ].join("\n");
  const images = [];
  if (vision) {
    try {
      const shot = await pi.browser.screenshot({ fullPage: false });
      if (shot?.data) images.push({ mimeType: shot.mimeType || "image/png", data: shot.data });
    } catch {
      // Text observation is still usable.
    }
  }
  return { text: observation, images };
}

function unwrap(value) {
  return value && typeof value === "object" && "value" in value ? value.value : value;
}

async function waitFor(action, signal) {
  const timeoutMs = Math.max(0, Math.min(30_000, Number(action.timeoutMs ?? 8_000) || 8_000));
  const deadline = Date.now() + timeoutMs;
  const selector = String(action.selector ?? "");
  const text = String(action.text ?? "");
  const urlContains = String(action.urlContains ?? "");
  let lastResources = -1;
  let stableTicks = 0;
  while (Date.now() <= deadline) {
    signal?.throwIfAborted?.();
    if (action.idle === true) {
      try {
        await pi.browser.networkIdle({ timeoutMs, idleMs: 500 });
        return "network idle";
      } catch (error) {
        if (String(error instanceof Error ? error.message : error).includes("unavailable")) {
          // Text-only backends can still settle on document.readyState.
          const state = unwrap(await pi.browser.evaluate({
            expression:
              "(() => ({ ready: document.readyState, resources: performance.getEntriesByType('resource').length }))()",
          })) ?? {};
          if (state.ready === "complete") {
            stableTicks = state.resources === lastResources ? stableTicks + 1 : 0;
            lastResources = state.resources;
            if (stableTicks >= 2) return "network idle";
          } else {
            stableTicks = 0;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        throw error;
      }
    }
    const value = await pi.browser.evaluate({
      expression:
        "(() => { const selector = " + JSON.stringify(selector) + "; const text = " + JSON.stringify(text) +
        "; const urlContains = " + JSON.stringify(urlContains) + "; const node = selector ? document.querySelector(selector) : null;" +
        " return { selector: selector ? !!node : true, text: text ? (document.body ? document.body.innerText.includes(text) : false) : true," +
        " url: urlContains ? location.href.includes(urlContains) : true }; })()",
    });
    const state = unwrap(value) ?? {};
    if (state.selector !== false && state.text !== false && state.url !== false) return "wait satisfied";
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("wait timed out");
}

async function pointOf(uid) {
  const value = unwrap(await pi.browser.evaluate({
    expression:
      "(() => { const map = globalThis.__PI_REFS || (globalThis.__PI_EXT_REFS && globalThis.__PI_EXT_REFS.byRef); const el = map && map.get(" + JSON.stringify(String(uid)) + ");" +
      " if (!el) return null; el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect();" +
      " return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()",
  }));
  if (!value || typeof value.x !== "number") throw new Error(`unknown or stale ref ${uid}`);
  return value;
}

async function execute(action, signal, images) {
  signal?.throwIfAborted?.();
  switch (action.action) {
    case "click": {
      const uid = String(action.uid ?? "").trim();
      if (!uid) throw new Error("click needs uid");
      await pi.browser.click({ uid });
      return `click ${uid}`;
    }
    case "fill": {
      const uid = String(action.uid ?? "").trim();
      if (!uid) throw new Error("fill needs uid");
      await pi.browser.fill({ uid, text: String(action.text ?? "") });
      return `fill ${uid}`;
    }
    case "hover": {
      const uid = String(action.uid ?? "").trim();
      if (!uid) throw new Error("hover needs uid");
      const point = await pointOf(uid);
      await pi.browser.inputEvent({ type: "mouseMove", x: Math.round(point.x), y: Math.round(point.y) });
      return `hover ${uid}`;
    }
    case "press": {
      const key = String(action.key ?? "").trim();
      if (!key) throw new Error("press needs key");
      await pi.browser.inputEvent({ type: "keyDown", keyCode: key });
      await pi.browser.inputEvent({ type: "keyUp", keyCode: key });
      return `press ${key}`;
    }
    case "select": {
      const uid = String(action.uid ?? "").trim();
      if (!uid) throw new Error("select needs uid");
      const ok = await pi.browser.evaluate({
        expression:
          "(() => { const map = globalThis.__PI_REFS || (globalThis.__PI_EXT_REFS && globalThis.__PI_EXT_REFS.byRef); const el = map && map.get(" + JSON.stringify(uid) + ");" +
          " if (!el || el.tagName !== 'SELECT') return false; el.value = " + JSON.stringify(String(action.value ?? "")) + ";" +
          " el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()",
      });
      if (unwrap(ok) !== true) throw new Error(`select failed for ${uid}`);
      return `select ${uid}`;
    }
    case "scroll": {
      const dy = Math.max(-4000, Math.min(4000, Number(action.dy ?? 600) || 600));
      const dx = Math.max(-4000, Math.min(4000, Number(action.dx ?? 0) || 0));
      await pi.browser.inputEvent({ type: "mouseWheel", x: 20, y: 20, deltaX: dx, deltaY: dy });
      return `scroll ${dx},${dy}`;
    }
    case "drag": {
      const from = action.from ?? {};
      const to = action.to ?? {};
      await pi.browser.inputEvent({ type: "mouseMove", x: Number(from.x), y: Number(from.y) });
      await pi.browser.inputEvent({ type: "mouseDown", x: Number(from.x), y: Number(from.y), button: "left", clickCount: 1 });
      await pi.browser.inputEvent({ type: "mouseMove", x: Number(to.x), y: Number(to.y) });
      await pi.browser.inputEvent({ type: "mouseUp", x: Number(to.x), y: Number(to.y), button: "left", clickCount: 1 });
      return "drag";
    }
    case "navigate": {
      const url = String(action.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("navigate needs an http(s) url");
      await pi.browser.navigate({ url });
      return `navigate ${url}`;
    }
    case "new_tab": {
      const url = String(action.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("new_tab needs an http(s) url");
      const opened = await pi.browser.tabs({ action: "new", url });
      return `new_tab ${opened?.tabId ?? ""}`;
    }
    case "switch_tab": {
      const tabId = String(action.tabId ?? "").trim();
      if (!tabId) throw new Error("switch_tab needs tabId");
      await pi.browser.tabs({ action: "select", tabId });
      return `switch_tab ${tabId}`;
    }
    case "close_tab": {
      await pi.browser.tabs({ action: "close", ...(action.tabId ? { tabId: String(action.tabId) } : {}) });
      return "close_tab";
    }
    case "wait":
      return waitFor(action, signal);
    case "screenshot": {
      const shot = await pi.browser.screenshot({ fullPage: action.fullPage === true });
      if (shot?.data) images.push({ type: "image", mimeType: shot.mimeType || "image/png", data: shot.data });
      return `screenshot ${shot?.width || "?"}x${shot?.height || "?"}`;
    }
    case "download": {
      const url = String(action.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("download needs an http(s) url");
      const result = await pi.browser.downloadUrl({ url, ...(action.filename ? { filename: String(action.filename) } : {}) });
      return `download ${result?.path ?? url}`;
    }
    case "upload": {
      const selector = String(action.selector ?? "input[type=file]");
      const files = Array.isArray(action.files) ? action.files.map(String) : [];
      if (!files.length) throw new Error("upload needs files");
      await pi.browser.uploadFiles({ selector, files });
      return `upload ${files.length} file(s)`;
    }
    case "frame": {
      return pi.browser.crossOriginFrame(action.frame ?? action);
    }
    case "dialog": {
      return pi.browser.handleDialog({ accept: action.accept !== false, promptText: action.promptText });
    }
    default:
      throw new Error(`unsupported action: ${action.action}`);
  }
}

async function browserRun(args, ctx) {
  const goal = String(args?.goal ?? "").trim();
  if (!goal) return fail("browser_run requires a goal");
  const maxSteps = Math.max(1, Math.min(32, Number(args?.maxSteps ?? 6) || 6));
  const maxMs = Math.max(5_000, Math.min(5 * 60_000, Number(args?.maxMs ?? 120_000) || 120_000));
  const deadline = Date.now() + maxMs;
  const signal = ctx?.signal;
  const url = String(args?.url ?? "").trim();
  if (url) await pi.browser.navigate({ url });
  const key = String(args?.modelKey ?? "").trim() || await modelKey();
  if (!key) return fail("browser_run needs a session model, modelKey, or a ready model catalogue");
  let locked = false;
  try {
    await pi.browser.lock();
    locked = true;
  } catch (error) {
    return [{ type: "text", text: JSON.stringify({ ok: false, outcome: "needs-user", error: error instanceof Error ? error.message : String(error) }, null, 2) }];
  }
  try {
  const resumed = args?.resume && typeof args.resume === "object" ? args.resume : null;
  const history = Array.isArray(resumed?.history) ? resumed.history.map(String).slice(-MAX_HISTORY) : [];
  const plan = Array.isArray(resumed?.plan) ? resumed.plan.map(String).slice(0, 12) : [];
  const images = [];
  let consecutiveFailures = 0;
  let vision = args?.vision !== false;
  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) return [{ type: "text", text: JSON.stringify({ ok: false, outcome: "cancelled", steps: history }, null, 2) }];
    if (Date.now() > deadline) return [{ type: "text", text: JSON.stringify({ ok: false, outcome: "time-limit", steps: history }, null, 2) }];
    const observation = await observe(vision);
    const request = {
      modelKey: key,
      thinkingLevel: "off",
      system: "You are a browser automation planner. Reply with one JSON action only.",
      messages: [{ role: "user", content: prompt(goal, observation.text, history.slice(-MAX_HISTORY), plan) }],
    };
    let answer;
    try {
      answer = await pi.agent.complete({ ...request, ...(observation.images.length ? { images: observation.images } : {}) });
    } catch (error) {
      if (!observation.images.length) throw error;
      vision = false;
      history.push("vision unavailable; continuing with text only");
      answer = await pi.agent.complete(request);
    }
    const action = parseAction(answer?.text);
    if (!action) return fail(`browser_run: model returned no valid action at step ${step + 1}`);
    if (Array.isArray(action.plan)) {
      plan.splice(0, plan.length, ...action.plan.map(String).slice(0, 12));
    }
    if (action.action === "done") {
      return [
        { type: "text", text: JSON.stringify({ ok: true, summary: String(action.summary ?? ""), plan, steps: history }, null, 2) },
        ...images,
      ];
    }
    if (action.action === "ask") {
      return [{ type: "text", text: JSON.stringify({ ok: false, needsUser: true, question: String(action.question ?? ""), steps: history }, null, 2) }];
    }
    try {
      history.push(await execute(action, signal, images));
      consecutiveFailures = 0;
    } catch (error) {
      if (signal?.aborted) return [{ type: "text", text: JSON.stringify({ ok: false, outcome: "cancelled", steps: history }, null, 2) }];
      if (/已接管|HANDOFF_REQUIRED|handed (back|over)/i.test(error instanceof Error ? error.message : String(error))) {
        return [{ type: "text", text: JSON.stringify({ ok: false, outcome: "needs-user", question: "用户已接管浏览器，交还 Agent 后可继续。", resume: { history: history.slice(-MAX_HISTORY), plan }, steps: history }, null, 2) }];
      }
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      history.push(`failed(${consecutiveFailures}): ${message}; re-observe before retrying`);
      if (consecutiveFailures >= 3) {
        return [{ type: "text", text: JSON.stringify({ ok: false, outcome: "needs-recovery", error: message, steps: history }, null, 2) }];
      }
    }
  }
  return [
    { type: "text", text: JSON.stringify({ ok: false, outcome: "step-limit", steps: history }, null, 2) },
    ...images,
  ];
  } finally {
    if (locked) await pi.browser.unlock().catch(() => undefined);
  }
}

export async function onLoad() {
  await pi.agent.registerTool({
    name: "browser_run",
    description: "Run an autonomous browser loop toward a goal: observe, one model action, execute, repeat until done or the step/time limit. Supports click, fill, navigate, wait and screenshot.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        url: { type: "string" },
        maxSteps: { type: "integer", minimum: 1, maximum: 32 },
        maxMs: { type: "integer", minimum: 5000, maximum: 300000 },
        modelKey: { type: "string" },
        vision: { type: "boolean" },
        resume: {
          type: "object",
          description: "Resume a paused loop from a previous result.resume",
          properties: {
            history: { type: "array", items: { type: "string" } },
            plan: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      required: ["goal"],
      additionalProperties: false,
    },
    execute: browserRun,
  });
}

export async function onUnload() {
  await pi.agent.unregisterTool("browser_run");
}
