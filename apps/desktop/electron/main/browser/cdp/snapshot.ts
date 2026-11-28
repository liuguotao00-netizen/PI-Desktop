import type { CdpConnection } from "./connection.ts";
import type { SnapshotResult } from "../types.ts";

const SNAPSHOT_BODY = String.raw`
(() => {
  const state = globalThis.__PI_EXT_REFS || (globalThis.__PI_EXT_REFS = { byEl: new WeakMap(), byRef: new Map(), next: 1 });
  for (const entry of state.byRef) if (!entry[1].isConnected) state.byRef.delete(entry[0]);
  const parent = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  const all = (root) => {
    const out = [];
    for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) out.push(...all(el.shadowRoot)); }
    return out;
  };
  const refFor = (el) => {
    const existing = state.byEl.get(el);
    if (existing && state.byRef.get(existing) === el) return existing;
    const ref = 'e' + state.next++;
    state.byEl.set(el, ref);
    state.byRef.set(ref, el);
    return ref;
  };
  const nameOf = (el) => el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const roleOf = (el) => el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button' : el.tagName === 'INPUT' ? 'textbox' : '');
  const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0; };
  const interactive = (el) => el.matches('a[href],button,input,textarea,select,summary,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],[role="menuitem"],[role="option"],[role="tab"],[tabindex]:not([tabindex="-1"])');
  const lines = [];
  for (const el of all(document.body || document.documentElement)) {
    if (!interactive(el) && !/^(H[1-6]|P|LI|LABEL|IMG|MAIN|NAV|HEADER|SECTION|ARTICLE)$/.test(el.tagName)) continue;
    let depth = 0; let p = parent(el); while (p) { depth += 1; p = parent(p); }
    const bits = [el.tagName.toLowerCase(), roleOf(el) ? 'role=' + roleOf(el) : '', nameOf(el) ? JSON.stringify(nameOf(el)) : '', visible(el) ? '' : 'hidden', 'ref=' + refFor(el)];
    lines.push('  '.repeat(depth) + '- ' + bits.filter(Boolean).join(' '));
    if (lines.length > 4000) break;
  }
  return { tree: lines.join('\n'), url: location.href, title: document.title };
})()
`;

export async function snapshotPage(connection: CdpConnection): Promise<SnapshotResult> {
  const result = (await connection.send("Runtime.evaluate", {
    expression: SNAPSHOT_BODY,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: SnapshotResult } };
  const value = result.result?.value;
  if (!value?.tree) throw new Error("CDP snapshot produced no tree");
  return value;
}
