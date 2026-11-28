import type { LocatorQuery } from "./types.ts";

/**
 * One in-page locator program shared by every backend.
 *
 * The three driving paths (embedded host, CDP page, extension service worker)
 * all evaluate JavaScript inside the page, so they all run this same query.
 * Keeping one script avoids the drift the old per-backend locators had: the
 * extension could only match a CSS selector while CDP understood roles.
 *
 * The script returns JSON: `{ ok, count, matches, value? }`. It never clicks
 * through DOM events; the caller drives real input for click/press so pages
 * that check `isTrusted` still behave.
 */
export function locatorExpression(input: LocatorQuery): string {
  return `(() => {
  const q = ${JSON.stringify(input)};
  const state = globalThis.__PI_EXT_REFS || (globalThis.__PI_EXT_REFS = { byEl: new WeakMap(), byRef: new Map(), next: 1 });
  globalThis.__PI_REFS = state.byRef;
  for (const entry of [...state.byRef]) { if (!entry[1] || !entry[1].isConnected) state.byRef.delete(entry[0]); }
  const all = (root) => {
    const out = [];
    const walk = (node) => {
      for (const el of node.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
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
  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (tag === 'IMG') return 'img';
    return '';
  };
  const nameOf = (el) => String(
    el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt')) ||
    (el.labels && el.labels[0] && el.labels[0].innerText) ||
    el.innerText || el.textContent || ''
  ).replace(/\\s+/g, ' ').trim().slice(0, 200);
  const visible = (el) => {
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const matchesQuery = (el, query) => {
    if (!query) return true;
    if (query.selector) { try { if (!el.matches(query.selector)) return false; } catch (e) { return false; } }
    if (query.role && roleOf(el).toLowerCase() !== String(query.role).toLowerCase()) return false;
    if (query.name && !nameOf(el).toLowerCase().includes(String(query.name).toLowerCase())) return false;
    if (query.text && !String(el.innerText || el.textContent || '').toLowerCase().includes(String(query.text).toLowerCase())) return false;
    if (query.placeholder && !String(el.getAttribute('placeholder') || '').toLowerCase().includes(String(query.placeholder).toLowerCase())) return false;
    if (query.testId && String(el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '') !== String(query.testId)) return false;
    const haystack = String(el.innerText || el.textContent || '').toLowerCase();
    if (query.hasText && !haystack.includes(String(query.hasText).toLowerCase())) return false;
    if (query.hasNotText && haystack.includes(String(query.hasNotText).toLowerCase())) return false;
    if (query.visibleOnly && !visible(el)) return false;
    return true;
  };
  const describe = (el, index) => {
    const rect = el.getBoundingClientRect();
    return {
      ref: refFor(el),
      index,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el),
      text: String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      visible: visible(el),
      enabled: !el.disabled,
      ...(typeof el.checked === 'boolean' ? { checked: el.checked } : {}),
      ...(typeof el.value === 'string' ? { value: el.value.slice(0, 500) } : {}),
      html: String(el.outerHTML || '').slice(0, 2000),
      box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    };
  };
  const hasQuery = !!(q.selector || q.role || q.name || q.text || q.placeholder || q.testId || q.hasText || q.hasNotText || q.visibleOnly);
  const selected = [];
  for (const el of all(document.body || document.documentElement)) {
    if (el.nodeType !== 1) continue;
    if (!hasQuery && q.combine !== 'or' && q.combine !== 'and' && !el.hasAttribute('role') && !['A','BUTTON','INPUT','SELECT','TEXTAREA','IMG'].includes(el.tagName)) continue;
    let matched = matchesQuery(el, q);
    if (q.combine === 'and' && q.combined) matched = matched && matchesQuery(el, q.combined);
    if (q.combine === 'or' && q.combined) matched = matched || matchesQuery(el, q.combined);
    if (matched) selected.push(el);
  }
  const count = selected.length;
  const limit = Math.max(1, Math.min(200, Number(q.limit) || 10));
  const matches = selected.slice(0, limit).map(describe);
  const index = q.nthFromEnd ? Math.max(0, count - Math.trunc(Number(q.nthFromEnd) || 1)) : Math.max(0, Math.trunc(Number(q.nth) || 0));
  const target = selected[index] || null;
  const action = q.action || 'list';
  const out = (value) => ({ ok: true, count, matches, ...(value === undefined ? {} : { value }) });
  if (action === 'list') return { ok: true, count, matches };
  if (action === 'count') return { ok: true, count, matches: [] };
  if (!target) return { ok: false, error: 'Locator matched no element', count, matches: [] };
  const text = () => String(target.innerText || target.textContent || '');
  if (action === 'text' || action === 'innerText') return out(text());
  if (action === 'textContent') return out(target.textContent || '');
  if (action === 'html') return out(target.outerHTML || '');
  if (action === 'attribute') return out(target.getAttribute(String(q.attribute || '')));
  if (action === 'isVisible') return out(visible(target));
  if (action === 'isEnabled') return out(!target.disabled);
  if (action === 'isChecked') return out(!!target.checked);
  if (action === 'focus') { target.focus(); return out(true); }
  if (action === 'scrollIntoView') { target.scrollIntoView({ block: 'center', inline: 'center' }); return out(true); }
  if (action === 'check' || action === 'uncheck' || action === 'setChecked') {
    const want = action === 'setChecked' ? q.checked !== false : action === 'check';
    if (!!target.checked !== want) target.click();
    return out(!!target.checked);
  }
  if (action === 'selectOption') {
    const select = target.tagName === 'SELECT' ? target : target.querySelector('select');
    if (!select) return { ok: false, error: 'selectOption target is not a select', count, matches };
    const wanted = Array.isArray(q.values) && q.values.length ? q.values.map(String) : [String(q.value ?? '')];
    for (const option of select.options) option.selected = wanted.includes(option.value) || wanted.includes(option.text);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return out(select.value);
  }
  if (action === 'fill' || action === 'type') {
    const value = String(q.value ?? '');
    target.focus();
    if ('value' in target && typeof target.value === 'string') {
      target.value = action === 'type' ? target.value + value : value;
    } else if (target.isContentEditable) {
      target.textContent = action === 'type' ? String(target.textContent || '') + value : value;
    } else {
      return { ok: false, error: 'element is not editable', count, matches };
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return out(true);
  }
  if (action === 'dblclick') { target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return out(true); }
  const run = (fn, el, arg) => {
    if (typeof fn !== 'string' || !fn.trim()) return undefined;
    const body = fn.trim().startsWith('function') || fn.includes('=>') ? '(' + fn + ')' : 'function(el, arg){' + fn + '}';
    return (0, eval)(body)(el, arg);
  };
  if (action === 'evaluate') return Promise.resolve(run(q.fn, target, q.arg)).then((value) => out(value === undefined ? null : value));
  if (action === 'evaluateAll') {
    return Promise.all(selected.slice(0, Math.max(limit, 50)).map((el) => Promise.resolve(run(q.fn, el, q.arg)))).then((values) => out(values));
  }
  if (action === 'mediaUrl') {
    return out(String(target.currentSrc || target.src || target.href || '').slice(0, 2000));
  }
  return { ok: false, error: 'Unknown locator action: ' + action, count, matches };
})()`;
}
