import type { CdpConnection } from "./connection.ts";

export async function crossOriginFrame(
  connection: CdpConnection,
  input: {
    action: "list" | "text" | "html" | "click" | "fill" | "count";
    frameId?: string;
    url?: string;
    targetSelector?: string;
    value?: string;
    limit?: number;
  },
  clickAt: (x: number, y: number) => Promise<void>,
): Promise<unknown> {
  const cdp = connection;
  await cdp.send("Page.enable");
  const raw = (await cdp.send("Page.getFrameTree")) as {
    frameTree?: {
      frame?: { id?: string; url?: string; name?: string };
      childFrames?: Array<{ frame?: { id?: string; url?: string; name?: string }; childFrames?: unknown[] }>;
    };
  };
  type Frame = { id: string; url: string; name: string };
  const frames: Frame[] = [];
  const walk = (node: { frame?: { id?: string; url?: string; name?: string }; childFrames?: Array<{ frame?: { id?: string; url?: string; name?: string }; childFrames?: unknown[] }> }) => {
    const frame = node.frame;
    if (frame?.id) frames.push({ id: frame.id, url: frame.url || "", name: frame.name || "" });
    for (const child of node.childFrames ?? []) walk(child as typeof node);
  };
  if (raw.frameTree) walk(raw.frameTree);
  if (input.action === "list") return { ok: true, frames };
  const selected = frames.find((frame) => (input.frameId ? frame.id === input.frameId : input.url ? frame.url.includes(input.url) : false)) ?? frames.find((frame) => frame.id !== frames[0]?.id) ?? frames[0];
  if (!selected) return { ok: false, error: "no frame available", frames };
  const world = (await cdp.send("Page.createIsolatedWorld", {
    frameId: selected.id,
    worldName: "pi-browser-frame",
  })) as { executionContextId?: number };
  const contextId = world.executionContextId;
  if (typeof contextId !== "number") return { ok: false, error: "could not create frame context", frames };
  const run = async (expression: string) => {
    const result = (await cdp.send("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "frame evaluation failed");
    return result.result?.value;
  };
  if (input.action === "text") {
    const value = await run("document.body ? document.body.innerText : ''");
    return { ok: true, frame: selected, text: String(value ?? "").slice(0, Math.max(200, Math.min(30000, input.limit || 8000))) };
  }
  if (input.action === "html") {
    const value = await run("document.documentElement ? document.documentElement.outerHTML : ''");
    return { ok: true, frame: selected, html: String(value ?? "").slice(0, Math.max(200, Math.min(30000, input.limit || 8000))) };
  }
  const selector = String(input.targetSelector || "");
  if (!selector) return { ok: false, error: "targetSelector required", frames };
  if (input.action === "count") {
    const value = await run(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      return { count: nodes.length, matches: nodes.slice(0, 50).map((el) => ({ text: String(el.innerText || el.value || '').trim().slice(0, 200), tag: el.tagName.toLowerCase() })) };
    })()`);
    return { ok: true, frame: selected, ...(value as object) };
  }
  if (input.action === "fill") {
    const value = await run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.focus({ preventScroll: true });
      if ('value' in el) { el.value = ${JSON.stringify(String(input.value ?? ""))}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      else { el.textContent = ${JSON.stringify(String(input.value ?? ""))}; el.dispatchEvent(new Event('input', { bubbles: true })); }
      return String('value' in el ? el.value : el.textContent);
    })()`);
    if (value === null) return { ok: false, error: "frame target not found", frames };
    return { ok: true, frame: selected, value };
  }
  const point = (await run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)) as { x?: number; y?: number } | null;
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
    return { ok: false, error: "frame target not found", frames };
  }
  const owner = (await cdp.send("DOM.getFrameOwner", { frameId: selected.id })) as { backendNodeId?: number };
  let origin = { x: 0, y: 0 };
  if (typeof owner.backendNodeId === "number") {
    try {
      const box = (await cdp.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId })) as {
        model?: { border?: number[] };
      };
      const border = box.model?.border;
      if (border && border.length >= 2) origin = { x: border[0], y: border[1] };
    } catch {
      // Frame owner box unavailable; keep viewport coordinates.
    }
  }
  await clickAt(origin.x + point.x, origin.y + point.y);
  return { ok: true, frame: selected, x: Math.round(origin.x + point.x), y: Math.round(origin.y + point.y) };
}

