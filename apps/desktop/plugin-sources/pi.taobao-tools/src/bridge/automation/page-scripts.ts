"use strict";

/**
 * Page-side JavaScript the DSL injects.
 *
 * Each builder returns one self-contained expression. They are data, not
 * logic: the executor decides *when* to run one, this module decides *what*
 * it says.
 */

import { globToRegex } from "./params";
import type { Target } from "./types";

/** How often page-side loops poll before giving up. */
const POLL_MS = 200;

const js = (value: unknown): string => JSON.stringify(value);

const TARGET_JS = `
const __qiworkAll = (root) => {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node.querySelectorAll !== 'function') return;
    let elements;
    try { elements = node.querySelectorAll('*'); } catch (error) { return; }
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      out.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(root);
  return out;
};
const __qiworkEl = (target) => {
  const spec = target || {};
  let roots = [document];
  if (spec.shadowHost) {
    let host = null;
    try { host = document.querySelector(spec.shadowHost); } catch (error) { host = null; }
    if (!host) return null;
    roots = host.shadowRoot ? [host.shadowRoot] : [host];
  }
  const pool = [];
  for (let index = 0; index < roots.length; index += 1) {
    const found = __qiworkAll(roots[index]);
    for (let inner = 0; inner < found.length; inner += 1) pool.push(found[inner]);
  }
  const selector = spec.selector || '';
  let matches = pool;
  if (selector) {
    matches = pool.filter((element) => {
      try { return element.matches(selector); } catch (error) { return false; }
    });
  }
  const text = spec.text || '';
  if (text) {
    const byText = matches.filter((element) => (element.textContent || '').trim() === text);
    if (byText.length) return byText[0];
    const byPlaceholder = matches.filter((element) => {
      const placeholder = element.getAttribute ? element.getAttribute('placeholder') : '';
      return String(placeholder || '').includes(text);
    });
    if (byPlaceholder.length) return byPlaceholder[0];
    if (!selector) {
      const loose = pool.filter((element) => (element.textContent || '').trim() === text);
      if (loose.length) return loose[0];
    }
  }
  return matches.length ? matches[0] : null;
};
const __qiworkVisible = (element) => {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
};
`;

function syncScript(body: string): string {
  return `(() => {\n${TARGET_JS}${body}\n})()`;
}

function asyncScript(body: string): string {
  return `(async () => {\n${TARGET_JS}${body}\n})()`;
}

function captureScript(sessions: unknown[]): string {
  return (
    "(() => {\n" +
    "  if (window.__qiworkAutomation) return;\n" +
    `  const SESSIONS = ${js(sessions)};\n` +
    "  const state = { captures: [] };\n" +
    "  Object.defineProperty(window, '__qiworkAutomation', " +
    "{ value: state, configurable: true });\n" +
    "  const keysFor = (url) => SESSIONS.filter((s) => " +
    "s.urlIncludes.some((part) => String(url).includes(part)))" +
    ".map((s) => s.sessionKey);\n" +
    "  const record = (url, body) => {\n" +
    "    const keys = keysFor(url);\n" +
    "    if (!keys.length || body === null || typeof body !== 'object') return;\n" +
    "    state.captures.push({ url: String(url), body, keys, ts: Date.now() });\n" +
    "  };\n" +
    "  const origFetch = window.fetch;\n" +
    "  if (origFetch) {\n" +
    "    window.fetch = async function (...args) {\n" +
    "      const response = await origFetch.apply(this, args);\n" +
    "      try { response.clone().json().then((body) => record(response.url, body)).catch(() => {}); } catch (e) {}\n" +
    "      return response;\n" +
    "    };\n" +
    "  }\n" +
    "  const XHR = window.XMLHttpRequest;\n" +
    "  if (XHR) {\n" +
    "    const open = XHR.prototype.open;\n" +
    "    XHR.prototype.open = function (method, url, ...rest) { this.__qiworkUrl = url; return open.call(this, method, url, ...rest); };\n" +
    "    const send = XHR.prototype.send;\n" +
    "    XHR.prototype.send = function (...args) {\n" +
    "      this.addEventListener('load', function () {\n" +
    "        try {\n" +
    "          const type = this.getResponseHeader('content-type') || '';\n" +
    "          if (type.includes('json') && this.responseText) record(this.__qiworkUrl || this.responseURL, JSON.parse(this.responseText));\n" +
    "        } catch (e) {}\n" +
    "      });\n" +
    "      return send.apply(this, args);\n" +
    "    };\n" +
    "  }\n" +
    "})();"
  );
}

function clickScript(target: Target): string {
  return syncScript(`
  const element = __qiworkEl(${js(target)});
  if (!element) return false;
  try { element.scrollIntoView({ block: 'center', inline: 'center' }); } catch (error) {}
  element.click();
  return true;
`);
}

function focusScript(target: Target, noClick: boolean): string {
  return syncScript(`
  const element = __qiworkEl(${js(target)});
  if (!element) return null;
  try { element.scrollIntoView({ block: 'center', inline: 'center' }); } catch (error) {}
  if (${js(Boolean(noClick))} === false) { try { element.click(); } catch (error) {} }
  if (typeof element.focus === 'function') element.focus();
  const editable = Boolean(element.isContentEditable)
    || String(element.getAttribute ? element.getAttribute('contenteditable') : '') === 'true';
  return { editable: editable, tagName: String(element.tagName || '') };
`);
}

function setValueScript(target: Target, value: string): string {
  return syncScript(`
  const element = __qiworkEl(${js(target)});
  if (!element) return false;
  const value = ${js(value)};
  const prototype = element.tagName === 'TEXTAREA'
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value); else element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
`);
}

function insertTextFallbackScript(value: string): string {
  return syncScript(`
  const active = document.activeElement;
  if (!active || !(active.isContentEditable || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return false;
  document.execCommand('insertText', false, ${js(value)});
  active.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
`);
}

function hoverScript(target: Target): string {
  return syncScript(`
  const element = __qiworkEl(${js(target)});
  if (!element) return false;
  element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  return true;
`);
}

function waitLoadScript(timeoutMs: number): string {
  return (
    "(async () => {\n" +
    `  const deadline = Date.now() + ${Math.max(1000, Number(timeoutMs) || 0)};\n` +
    "  while (Date.now() < deadline) {\n" +
    "    if (document.readyState === 'complete') return true;\n" +
    `    await new Promise((resolve) => setTimeout(resolve, ${POLL_MS}));\n` +
    "  }\n" +
    "  return false;\n" +
    "})()"
  );
}

function assertScript(failWhen: unknown[], passWhen: unknown[]): string {
  return syncScript(`
  const failWhen = ${js(failWhen)};
  const passWhen = ${js(passWhen)};
  const textOf = (element) => String((element && (element.innerText || element.textContent)) || '');
  const pageText = () => (document.body ? String(document.body.innerText || '') : '');
  const matches = (condition) => {
    const type = String(condition.type || '');
    if (type === 'url') {
      return String(location.href || '').includes(String(condition.includes || condition.value || ''));
    }
    const element = __qiworkEl(condition);
    if (type === 'exist') return Boolean(element);
    if (type === 'visible') {
      if (!__qiworkVisible(element)) return false;
      const value = String(condition.value || '');
      return value ? textOf(element).includes(value) : true;
    }
    if (type === 'text') {
      const value = String(condition.value || '');
      return Boolean(value) && pageText().includes(value);
    }
    return false;
  };
  for (let index = 0; index < failWhen.length; index += 1) {
    const condition = failWhen[index];
    if (matches(condition)) {
      return {
        failed: true,
        passed: false,
        code: String(condition.errorCode || ''),
        message: String(condition.errorMessage || ''),
        reason: String(condition.type || ''),
      };
    }
  }
  const passed = passWhen.length === 0 || passWhen.every(matches);
  return { failed: false, passed: passed };
`);
}

function uploadStateScript(verify: Record<string, unknown>): string {
  return syncScript(`
  const spec = ${js(verify)};
  const body = document.body ? String(document.body.innerText || '') : '';
  const failureTexts = spec.failureTexts || [];
  for (let index = 0; index < failureTexts.length; index += 1) {
    const text = String(failureTexts[index] || '');
    if (text && body.includes(text)) return { uploaded: 0, pending: false, failure: text };
  }
  const failureSelectors = spec.failureSelectors || [];
  for (let index = 0; index < failureSelectors.length; index += 1) {
    let element = null;
    try { element = document.querySelector(String(failureSelectors[index])); } catch (error) { element = null; }
    if (__qiworkVisible(element)) return { uploaded: 0, pending: false, failure: String(failureSelectors[index]) };
  }
  let uploaded = 0;
  if (spec.uploadedSelector) {
    try { uploaded = document.querySelectorAll(String(spec.uploadedSelector)).length; } catch (error) { uploaded = 0; }
  }
  let pending = false;
  const pendingSelectors = spec.pendingSelectors || [];
  for (let index = 0; index < pendingSelectors.length; index += 1) {
    try {
      if (document.querySelector(String(pendingSelectors[index]))) { pending = true; break; }
    } catch (error) {}
  }
  return { uploaded: uploaded, pending: pending, failure: '' };
`);
}

/**
 * Install a response recorder for the publish request.
 *
 * Same idea as `sessionCapture`, but a different slot: a publish run must see
 * the *publish* answer, not whichever data response the page happened to
 * make. Every entry is cleared when the script is installed so a receipt can
 * never be an old response.
 */
function publishCaptureScript(urlPattern: string): string {
  return (
    "(() => {\n" +
    `  const PATTERN = new RegExp(${js(globToRegex(urlPattern))});\n` +
    "  const matches = (url) => { try { return PATTERN.test(String(url || '')); } catch (error) { return false; } };\n" +
    "  if (window.__qiworkPublishInstalled) { window.__qiworkPublish = []; return; }\n" +
    "  window.__qiworkPublishInstalled = true;\n" +
    "  window.__qiworkPublish = [];\n" +
    "  const push = (url, body) => {\n" +
    "    if (!matches(url) || body === null || typeof body !== 'object') return;\n" +
    "    window.__qiworkPublish.push({ url: String(url), body: body, ts: Date.now() });\n" +
    "  };\n" +
    "  const origFetch = window.fetch;\n" +
    "  if (origFetch) {\n" +
    "    window.fetch = async function (...args) {\n" +
    "      const response = await origFetch.apply(this, args);\n" +
    "      try { response.clone().json().then((body) => push(response.url, body)).catch(() => {}); } catch (error) {}\n" +
    "      return response;\n" +
    "    };\n" +
    "  }\n" +
    "  const XHR = window.XMLHttpRequest;\n" +
    "  if (XHR) {\n" +
    "    const open = XHR.prototype.open;\n" +
    "    XHR.prototype.open = function (method, url, ...rest) { this.__qiworkPublishUrl = url; return open.call(this, method, url, ...rest); };\n" +
    "    const send = XHR.prototype.send;\n" +
    "    XHR.prototype.send = function (...args) {\n" +
    "      this.addEventListener('load', function () {\n" +
    "        try {\n" +
    "          const type = this.getResponseHeader('content-type') || '';\n" +
    "          if (type.includes('json') && this.responseText) push(this.__qiworkPublishUrl || this.responseURL, JSON.parse(this.responseText));\n" +
    "        } catch (error) {}\n" +
    "      });\n" +
    "      return send.apply(this, args);\n" +
    "    };\n" +
    "  }\n" +
    "})();"
  );
}

function probeScript(target: Target): string {
  return syncScript(`
  const element = __qiworkEl(${js(target)});
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    left: rect ? rect.left : 0,
    top: rect ? rect.top : 0,
    width: rect ? rect.width : 0,
    height: rect ? rect.height : 0,
    x: rect ? rect.left + rect.width / 2 : 0,
    y: rect ? rect.top + rect.height / 2 : 0,
    editable: Boolean(element.isContentEditable)
      || String(element.getAttribute ? element.getAttribute('contenteditable') : '') === 'true',
    tag: String(element.tagName || ''),
    disabled: Boolean(element.disabled)
      || String(element.getAttribute ? element.getAttribute('aria-disabled') : '') === 'true'
      || /(^|[\\s_-])(?:is-)?disabled($|[\\s_-])/i.test(String(element.className || '')),
  };
`);
}

function centerScript(target: Target): string {
  return syncScript(`
  const element = __qiworkEl(${js(target)});
  if (!element) return null;
  try { element.scrollIntoView({ block: 'center', inline: 'center' }); } catch (error) {}
  const rect = element.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const disabled = Boolean(element.disabled)
    || String(element.getAttribute ? element.getAttribute('aria-disabled') : '') === 'true'
    || /(^|[\\s_-])(?:is-)?disabled($|[\\s_-])/i.test(String(element.className || ''));
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    editable: Boolean(element.isContentEditable)
      || String(element.getAttribute ? element.getAttribute('contenteditable') : '') === 'true',
    tag: String(element.tagName || ''),
    disabled: disabled,
  };
`);
}

function scrollIntoViewScript(target: Target): string {
  return syncScript(`
  const element = __qiworkEl(${js(target)});
  if (!element) return false;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  return true;
`);
}

function elExpression(target: Target): string {
  return `__qiworkEl(${js(target)})`;
}

function hostExpression(target: Target): string {
  return `document.querySelector(${js(String((target && target.shadowHost) || ""))})`;
}

/**
 * Would a press at this point reach *element*?
 *
 * Nothing on a page can tell us it is covered — but `elementFromPoint`
 * answers exactly that, and it is the only check that sees the app's own
 * control bar sitting over the platform's bottom action bar.
 */
function hitScript(elementExpression: string, x: number, y: number): string {
  return syncScript(`
  const element = ${elementExpression};
  if (!element) return false;
  const at = document.elementFromPoint(${Number(x)}, ${Number(y)});
  if (!at) return false;
  return at === element || element.contains(at);
`);
}

function verificationScript(verification: Record<string, unknown>): string {
  return syncScript(`
  const spec = ${js(verification)};
  const selectors = spec.selectors || [];
  for (let index = 0; index < selectors.length; index += 1) {
    let element = null;
    try { element = document.querySelector(String(selectors[index])); } catch (error) { element = null; }
    if (__qiworkVisible(element)) return 'selector:' + String(selectors[index]);
  }
  const body = document.body ? String(document.body.innerText || '') : '';
  const texts = spec.texts || [];
  for (let index = 0; index < texts.length; index += 1) {
    const text = String(texts[index] || '');
    if (text && body.includes(text)) return 'text:' + text;
  }
  return '';
`);
}

function scrollForSessionScript({
  sessionKey,
  countPath,
  hasNextPath,
  limitTotal,
  limitScroll,
  scrollStep,
  selector,
}: {
  sessionKey: string;
  countPath: string;
  hasNextPath: string;
  limitTotal: number;
  limitScroll: number;
  scrollStep: number;
  selector: string;
}): string {
  return (
    "(async () => {\n" +
    "  const state = window.__qiworkAutomation;\n" +
    "  if (!state) return { count: 0, hasNext: false, rounds: 0 };\n" +
    `  const key = ${js(sessionKey)};\n` +
    `  const countPath = ${js(countPath)};\n` +
    `  const hasNextPath = ${js(hasNextPath)};\n` +
    `  const limit = ${Math.trunc(Number(limitTotal) || 0)};\n` +
    `  const maxRounds = ${Math.max(1, Math.trunc(Number(limitScroll) || 0))};\n` +
    `  const step = ${Math.max(100, Math.trunc(Number(scrollStep) || 0))};\n` +
    `  const selector = ${js(selector)};\n` +
    "  const values = (obj, path) => {\n" +
    "    if (!path) return [];\n" +
    "    let current = [obj];\n" +
    "    for (const part of String(path).split('.')) {\n" +
    "      if (!part) continue;\n" +
    "      const list = part.endsWith('[]'); const name = list ? part.slice(0, -2) : part; const next = [];\n" +
    "      for (const item of current) {\n" +
    "        if (!item || typeof item !== 'object') continue;\n" +
    "        const found = item[name];\n" +
    "        if (list && Array.isArray(found)) next.push(...found);\n" +
    "        else if (!list && found !== undefined) next.push(found);\n" +
    "      }\n" +
    "      current = next;\n" +
    "    }\n" +
    "    return current;\n" +
    "  };\n" +
    "  const collect = () => {\n" +
    "    const out = new Set();\n" +
    "    for (const capture of state.captures) {\n" +
    "      if (!capture.keys.includes(key)) continue;\n" +
    "      for (const value of values(capture.body, countPath)) out.add(String(value));\n" +
    "    }\n" +
    "    return out.size;\n" +
    "  };\n" +
    "  const hasNext = () => {\n" +
    "    for (let i = state.captures.length - 1; i >= 0; i -= 1) {\n" +
    "      const capture = state.captures[i];\n" +
    "      if (!capture.keys.includes(key)) continue;\n" +
    "      const found = values(capture.body, hasNextPath);\n" +
    "      if (found.length) return Boolean(found[0]);\n" +
    "      return false;\n" +
    "    }\n" +
    "    return false;\n" +
    "  };\n" +
    "  const scroller = selector ? document.querySelector(selector) : window;\n" +
    "  let rounds = 0;\n" +
    "  while (rounds < maxRounds) {\n" +
    "    const count = collect();\n" +
    "    if (limit > 0 && count >= limit) break;\n" +
    "    if (rounds > 0 && hasNextPath && !hasNext()) break;\n" +
    "    if (scroller && typeof scroller.scrollBy === 'function') scroller.scrollBy(0, step);\n" +
    "    else window.scrollBy(0, step);\n" +
    "    await new Promise((resolve) => setTimeout(resolve, 500));\n" +
    "    rounds += 1;\n" +
    "  }\n" +
    "  return { count: collect(), hasNext: hasNext(), rounds };\n" +
    "})()"
  );
}

/**
 * Scroll until the counted state stops growing.
 *
 * Three ways to move, because a page does not always scroll its window:
 * `anchorSelector` brings the last match into view, `scrollSelector` scrolls
 * a named container, and otherwise the window moves.
 */
function scrollForStateScript({
  countExpr,
  limitTotal,
  limitScroll,
  scrollStep,
  stallRounds,
  scrollSelector = "",
  anchorSelector = "",
  expandSelector = "",
  expandMax = 5,
}: {
  countExpr: string;
  limitTotal: number;
  limitScroll: number;
  scrollStep: number;
  stallRounds: number;
  scrollSelector?: string;
  anchorSelector?: string;
  expandSelector?: string;
  expandMax?: number;
}): string {
  return (
    "(async () => {\n" +
    `  const limit = ${Math.trunc(Number(limitTotal) || 0)};\n` +
    `  const maxRounds = ${Math.max(1, Math.trunc(Number(limitScroll) || 0))};\n` +
    `  const step = ${Math.max(100, Math.trunc(Number(scrollStep) || 0))};\n` +
    `  const stallLimit = ${Math.max(1, Math.trunc(Number(stallRounds) || 0))};\n` +
    `  const scrollSelector = ${js(scrollSelector)};\n` +
    `  const anchorSelector = ${js(anchorSelector)};\n` +
    `  const expandSelector = ${js(expandSelector)};\n` +
    `  const expandMax = ${Math.max(0, Math.trunc(Number(expandMax) || 0))};\n` +
    "  const count = () => {\n" +
    `    try { return Number(${countExpr || "0"}) || 0; } catch (e) { return 0; }\n` +
    "  };\n" +
    "  const expand = () => {\n" +
    "    if (!expandSelector || expandMax <= 0) return 0;\n" +
    "    let clicked = 0;\n" +
    "    let nodes = [];\n" +
    "    try { nodes = Array.from(document.querySelectorAll(expandSelector)); } catch (e) { return 0; }\n" +
    "    for (const node of nodes) {\n" +
    "      if (clicked >= expandMax) break;\n" +
    "      if (node.getAttribute('data-qiwork-expanded') === '1') continue;\n" +
    "      try { node.click(); node.setAttribute('data-qiwork-expanded', '1'); clicked += 1; } catch (e) {}\n" +
    "    }\n" +
    "    return clicked;\n" +
    "  };\n" +
    "  const move = () => {\n" +
    "    if (anchorSelector) {\n" +
    "      let nodes = [];\n" +
    "      try { nodes = document.querySelectorAll(anchorSelector); } catch (e) { nodes = []; }\n" +
    "      if (nodes.length) {\n" +
    "        try { nodes[nodes.length - 1].scrollIntoView({ block: 'end' }); return; } catch (e) {}\n" +
    "      }\n" +
    "    }\n" +
    "    if (scrollSelector) {\n" +
    "      let container = null;\n" +
    "      try { container = document.querySelector(scrollSelector); } catch (e) { container = null; }\n" +
    "      if (container && typeof container.scrollBy === 'function') { container.scrollBy(0, step); return; }\n" +
    "    }\n" +
    "    window.scrollBy(0, step);\n" +
    "  };\n" +
    "  let last = -1; let stalled = 0; let rounds = 0; let expanded = 0;\n" +
    "  while (rounds < maxRounds) {\n" +
    "    expanded += expand();\n" +
    "    const current = count();\n" +
    "    if (limit > 0 && current >= limit) { last = current; break; }\n" +
    "    if (current <= last) { stalled += 1; if (stalled >= stallLimit) { last = current; break; } }\n" +
    "    else stalled = 0;\n" +
    "    last = current;\n" +
    "    move();\n" +
    "    await new Promise((resolve) => setTimeout(resolve, 600));\n" +
    "    rounds += 1;\n" +
    "  }\n" +
    "  return { count: last, rounds, expanded };\n" +
    "})()"
  );
}

/**
 * Wait for an arbitrary page expression to become truthy.
 *
 * DOM selectors are not always the readiness signal: 小红书 injects its data
 * into `__INITIAL_STATE__` before it renders anything.
 */
function waitStateScript(expression: string, timeoutMs: number): string {
  return (
    "(async () => {\n" +
    `  const deadline = Date.now() + ${Math.max(1000, Number(timeoutMs) || 0)};\n` +
    "  while (Date.now() < deadline) {\n" +
    `    try { if (${expression}) return true; } catch (e) {}\n` +
    `    await new Promise((resolve) => setTimeout(resolve, ${POLL_MS}));\n` +
    "  }\n" +
    "  return false;\n" +
    "})()"
  );
}

const SET_VALUE_ON_THIS =
  "function (value) {" +
  " const prototype = this.tagName === 'TEXTAREA'" +
  "   ? HTMLTextAreaElement.prototype" +
  "   : HTMLInputElement.prototype;" +
  " const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;" +
  " if (setter) setter.call(this, value); else this.value = value;" +
  " this.dispatchEvent(new Event('input', { bubbles: true }));" +
  " this.dispatchEvent(new Event('change', { bubbles: true }));" +
  " return true;" +
  "}";

export {
  POLL_MS,
  SET_VALUE_ON_THIS,
  assertScript,
  asyncScript,
  captureScript,
  centerScript,
  clickScript,
  elExpression,
  focusScript,
  hitScript,
  hostExpression,
  hoverScript,
  insertTextFallbackScript,
  probeScript,
  publishCaptureScript,
  scrollForSessionScript,
  scrollForStateScript,
  scrollIntoViewScript,
  setValueScript,
  syncScript,
  uploadStateScript,
  verificationScript,
  waitLoadScript,
  waitStateScript,
};
