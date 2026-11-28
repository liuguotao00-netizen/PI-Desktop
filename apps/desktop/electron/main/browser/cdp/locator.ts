import type { LocatorQuery } from "../types.ts";
import { locatorExpression } from "../locator-script.ts";

export async function readFrames(
evaluate: (expression: string) => Promise<unknown>,
input: { action: "list" | "text" | "html"; index?: number; selector?: string; limit?: number },
): Promise<unknown> {
return evaluate(`(() => {
    const action = ${JSON.stringify(input.action)};
    const index = ${JSON.stringify(input.index ?? -1)};
    const selector = ${JSON.stringify(input.selector ?? "")};
    const limit = ${JSON.stringify(Math.max(200, Math.min(30000, input.limit || 8000)))};
    const nodes = Array.from(document.querySelectorAll('iframe, frame'));
    const frames = nodes.map((node, i) => {
      let doc = null;
      try { doc = node.contentDocument; } catch {}
      let url = '';
      try { url = doc ? doc.location.href : new URL(node.getAttribute('src') || '', location.href).href; } catch { url = node.getAttribute('src') || ''; }
      return { index: i, name: node.getAttribute('name') || '', src: node.getAttribute('src') || '', url, sameOrigin: !!doc };
    });
    if (action === 'list') return { ok: true, frames };
    const node = selector ? document.querySelector(selector) : nodes[index];
    if (!node) return { ok: false, error: 'Frame not found', frames };
    let doc = null;
    try { doc = node.contentDocument; } catch {}
    if (!doc) return { ok: false, error: 'Cross-origin frame content is not readable', frames };
    if (action === 'text') return { ok: true, url: doc.location.href, text: String(doc.body ? doc.body.innerText : '').slice(0, limit), frames };
    return { ok: true, url: doc.location.href, html: String(doc.documentElement ? doc.documentElement.outerHTML : '').slice(0, limit), frames };
  })()`);
}

export async function runLocator(
  evaluate: (expression: string) => Promise<unknown>,
  input: LocatorQuery,
): Promise<unknown> {
  return evaluate(locatorExpression(input));
}
