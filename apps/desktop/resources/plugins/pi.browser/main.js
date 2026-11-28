/**
 * Browser automation tools — Cursor-aligned surface.
 *
 * Cursor's `cursor-ide-browser` provider exposes one tool per action with a
 * DOM snapshot full of refs, hit-testing before every click, structured
 * failure suggestions, and a hard rule that CDP `Input.*` stays out of the
 * raw-CDP tool. This plugin keeps the same shape on top of `pi.browser.*`:
 * snapshots and DOM work run through `evaluateNative`, pointer input goes
 * through CDP, and every tool reports `{ error, suggestion, recovery }` when
 * it cannot act.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const REF_ATTR = "data-pi-ref";
const REF_SELECTOR = `[${REF_ATTR}]`;
const PAGE_TIMEOUT_MS = 30_000;
const MAX_CDP_CHARS = 25_000;
const SCREENSHOT_MEMORY = new Map();
const SNAPSHOT_CACHE = new Map();
const REF_TOOLS = new Set([
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_scroll",
  "browser_drag",
  "browser_hover",
  "browser_highlight",
  "browser_get_bounding_box",
]);

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[role='switch']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='searchbox']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/** Shared page helpers: shadow-aware traversal, refs, states, hit-testing. */
const HELPERS = `
function piParent(el){ if(!el) return null; if(el.parentElement) return el.parentElement;
  const root = el.getRootNode ? el.getRootNode() : null;
  return root && root.host && root.host.nodeType === 1 ? root.host : null; }
function piContains(ancestor, node){ let cur = node; while(cur){ if(cur === ancestor) return true; cur = piParent(cur); } return false; }
function piAll(root, out){ out = out || []; for(const el of root.querySelectorAll('*')){ out.push(el); if(el.shadowRoot) piAll(el.shadowRoot, out); } return out; }
function piRefOf(el){ if(!el) return ''; const map = globalThis.__PI_REFS; if(map){ for(const entry of map){ if(entry[1] === el) return entry[0]; } } return el.getAttribute(${JSON.stringify(REF_ATTR)}) || ''; }
function piFindRef(ref){ if(!ref) return null; const map = globalThis.__PI_REFS; if(map && map.get(ref) && map.get(ref).isConnected) return map.get(ref);
  const all = piAll(document.body || document.documentElement, []);
  return all.find(function(el){ return el.getAttribute(${JSON.stringify(REF_ATTR)}) === ref; }) || null; }
function piFrame(){ return new Promise(function(resolve){ let settled = false; const done = function(){ if(!settled){ settled = true; resolve(); } };
  requestAnimationFrame(function(){ requestAnimationFrame(done); }); setTimeout(done, 200); }); }
function piVisible(el){ if(!el || el.nodeType !== 1) return false; const s = getComputedStyle(el);
  if(s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
  const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
function piName(el){ const aria = el.getAttribute('aria-label'); if(aria) return aria.trim().slice(0, 120);
  const labelled = el.getAttribute('aria-labelledby'); if(labelled){ const n = document.getElementById(labelled); if(n) return (n.textContent||'').trim().slice(0,120); }
  const alt = el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder');
  if(alt) return alt.trim().slice(0, 120);
  const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(); return text.slice(0, 120); }
function piRole(el){ const explicit = el.getAttribute('role'); if(explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if(tag === 'a' && el.getAttribute('href')) return 'link';
  if(tag === 'button' || tag === 'summary') return 'button';
  if(tag === 'input'){ const t = (el.getAttribute('type')||'text').toLowerCase();
    if(t === 'checkbox') return 'checkbox'; if(t === 'radio') return 'radio'; if(t === 'range') return 'slider';
    if(t === 'search') return 'searchbox'; return 'textbox'; }
  if(tag === 'textarea') return 'textbox';
  if(tag === 'select') return 'combobox';
  if(/^h[1-6]$/.test(tag)) return 'heading';
  if(tag === 'img') return 'image';
  return '';
}
function piStates(el){ const out = []; try{
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if(document.activeElement === el){ out.push('active'); out.push('focused'); }
  if(el.matches(':checked')) out.push('checked');
  const ac = el.getAttribute('aria-checked'); if(ac === 'true') out.push('checked'); else if(ac === 'mixed') out.push('mixed');
  if(el.matches(':disabled') || el.disabled) out.push('disabled');
  if(el.matches(':required')) out.push('required');
  if((tag === 'input' || tag === 'textarea') && el.matches(':read-only')) out.push('readonly');
  const ex = el.getAttribute('aria-expanded'); if(ex === 'true') out.push('expanded'); else if(ex === 'false') out.push('collapsed');
 }catch(e){} return out; }
function piValue(el){ if(el.tagName === 'SELECT' && el.selectedOptions) { return Array.from(el.selectedOptions).map(function(o){ return (o.textContent||'').trim(); }).filter(Boolean).join(', ').slice(0, 200); }
  if(el.value !== undefined && typeof el.value === 'string') return el.value.slice(0, 100);
  if(el.isContentEditable) return (el.textContent||'').slice(0,100); return ''; }
function piDepth(el){ let d=0, p=piParent(el); while(p){ d++; p=piParent(p); } return d; }
function piContent(el){ try { return el.matches('h1, h2, h3, h4, h5, h6, label, p, li, article, nav, main, header, footer, section, [role="heading"], [role="article"], [role="region"], [role="main"], [role="navigation"], [role="listitem"], [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]'); } catch(e) { return false; } }
function piLandmark(el){ const tag = el.tagName.toLowerCase(); return ['main','nav','header','footer','aside','section','form','dialog','table','ul','ol'].includes(tag); }
function piAllInteractive(el){ try { return el.matches(${JSON.stringify(INTERACTIVE_SELECTOR)}); } catch(e){ return false; } }
function piScrollIntoView(el){ try { el.scrollIntoView({block:'center', inline:'center', behavior:'instant'}); } catch(e){ el.scrollIntoView(); } }
function piPoint(el){ const r = el.getBoundingClientRect(); const w = window.innerWidth, h = window.innerHeight;
  const left = Math.max(0, r.left), right = Math.min(w, r.right), top = Math.max(0, r.top), bottom = Math.min(h, r.bottom);
  if(right <= left || bottom <= top) return null;
  return { x: (left+right)/2, y: (top+bottom)/2, rect: { x: r.left, y: r.top, width: r.width, height: r.height } }; }
function piElementFromPoint(x, y){ let el = document.elementFromPoint(x, y);
  while(el && el.shadowRoot){ const inner = el.shadowRoot.elementFromPoint(x, y); if(!inner || inner === el) break; el = inner; }
  return el; }
function piIsDialog(el){ if(!el) return false; const role = el.getAttribute('role') || ''; const tag = el.tagName.toLowerCase();
  if(role === 'dialog' || role === 'alertdialog' || tag === 'dialog') return true;
  const cls = String(el.className || '').toLowerCase(); return /(modal|dialog|mask|overlay|popup|toast)/.test(cls); }
function piIsDropdown(el){ if(!el) return false; const role = el.getAttribute('role') || ''; const tag = el.tagName.toLowerCase();
  if(['listbox','menu','combobox','tree','grid'].includes(role)) return true;
  if(tag === 'select' || tag === 'datalist') return true;
  if(el.getAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false') return true;
  const cls = String(el.className || '').toLowerCase(); return /(dropdown|select-options|autocomplete|suggestions|popover|menu-list|option-list)/.test(cls); }
function piBlocked(el, point){ const top = piElementFromPoint(point.x, point.y);
  if(!top) return { type: 'none' };
  if(top === el || piContains(el, top) || piContains(top, el)) return { type: 'none' };
  const tag = top.tagName.toLowerCase(); const role = top.getAttribute('role') || ''; const name = piName(top);
  if(tag === 'iframe') return { type: 'iframe', tag, role, name, src: top.getAttribute('src') || '' };
  if(piIsDialog(top)) return { type: 'modal', tag, role, name };
  if(piIsDropdown(top)) return { type: 'dropdown', tag, role, name };
  const s = getComputedStyle(top); const scrollable = /(auto|scroll)/.test(s.overflowY + s.overflowX) && (top.scrollHeight > top.clientHeight || top.scrollWidth > top.clientWidth);
  return { type: scrollable ? 'scroll-container' : 'element', tag, role, name, ref: piRefOf(top) };
}
function piPageState(){ return { url: location.href, title: document.title, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
  focused: document.activeElement ? (document.activeElement.tagName || '').toLowerCase() : '', viewport: { width: innerWidth, height: innerHeight } }; }
function piDeepQuery(selector){ if(!selector) return null; const hit = document.querySelector(selector); if(hit) return hit;
  for(const el of piAll(document.body || document.documentElement, [])){ if(el.shadowRoot){ const found = el.shadowRoot.querySelector(selector); if(found) return found; } } return null; }
`;

function pageScript(body) {
  return `(async () => { ${HELPERS}\n${body}\n})()`;
}

function fail(message, suggestion, recovery, extra) {
  return {
    ok: false,
    error: {
      message,
      ...(suggestion ? { suggestion } : {}),
      ...(recovery ? { recovery } : {}),
      ...(extra ? extra : {}),
    },
  };
}

function sessionOf(ctx) {
  return ctx && typeof ctx.sessionId === "string" ? ctx.sessionId : undefined;
}

async function runPage(sessionId, body, userGesture = true) {
  const expression = pageScript(body);
  if (typeof pi.browser.evaluateIsolated === "function") {
    return await pi.browser.evaluateIsolated({ expression, sessionId });
  }
  if (typeof pi.browser.evaluateNative === "function") {
    return await pi.browser.evaluateNative({ expression, sessionId });
  }
  return await pi.browser.evaluate({ expression, sessionId });
}

async function readPageState(sessionId) {
  return await runPage(sessionId, "return piPageState();", false);
}

function allowedOrigins() {
  const raw = typeof process !== "undefined" ? process.env.PI_BROWSER_ALLOWED_ORIGINS : "";
  return String(raw || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function originAllowed(url) {
  const list = allowedOrigins();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `Invalid URL: ${url}` };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { ok: false, reason: `Only http(s) pages may be driven; current page is ${parsed.protocol}` };
  }
  if (!list.length) return { ok: true };
  const host = parsed.hostname.toLowerCase();
  const hit = list.some((entry) => host === entry || host.endsWith(`.${entry}`));
  return hit ? { ok: true } : { ok: false, reason: `Origin ${parsed.origin} is not in PI_BROWSER_ALLOWED_ORIGINS` };
}

async function guardPage(sessionId) {
  const state = await readPageState(sessionId);
  const check = originAllowed(state && state.url);
  if (!check.ok) {
    return {
      state,
      error: fail(check.reason, "Navigate to an allowed page before continuing.", "browser_navigate"),
    };
  }
  return { state };
}

const MODIFIER_NAMES = {
  Control: "control", Shift: "shift", Alt: "alt", Meta: "meta",
  ControlOrMeta: process.platform === "darwin" ? "meta" : "control",
};

function normalizeModifiers(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => MODIFIER_NAMES[String(item)]).filter(Boolean)));
}

async function mouseClick(sessionId, x, y, options = {}) {
  const button = options.button || "left";
  const modifiers = Array.isArray(options.modifiers) ? options.modifiers : [];
  const clickCount = options.doubleClick ? 2 : 1;
  // Trusted native input: the view dispatches it itself, so no debugger is
  // attached and the page sees a normal mouse event.
  await pi.browser.inputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
  const hold = Math.max(0, Number(options.holdDuration) || 0);
  await pi.browser.inputEvent({
    type: "mouseDown",
    x: Math.round(x),
    y: Math.round(y),
    button,
    clickCount,
    modifiers,
  });
  if (hold) await new Promise((resolve) => setTimeout(resolve, hold));
  await pi.browser.inputEvent({
    type: "mouseUp",
    x: Math.round(x),
    y: Math.round(y),
    button,
    clickCount,
    modifiers,
  });
  if (options.doubleClick) {
    await pi.browser.inputEvent({
      type: "mouseDown",
      x: Math.round(x),
      y: Math.round(y),
      button,
      clickCount: 2,
      modifiers,
    });
    await pi.browser.inputEvent({
      type: "mouseUp",
      x: Math.round(x),
      y: Math.round(y),
      button,
      clickCount: 2,
      modifiers,
    });
  }
}

async function clickResolved(sessionId, resolution, options = {}) {
  await mouseClick(sessionId, resolution.x, resolution.y, options);
  return {
    ok: true,
    x: Math.round(resolution.x),
    y: Math.round(resolution.y),
    attempts: resolution.attempts,
    ...(resolution.refRecovered ? { refRecovered: resolution.usedRef } : {}),
    ...(resolution.blocked ? { blocked: resolution.blocked } : {}),
    pageState: resolution.pageState,
  };
}

function resolveError(result) {
  if (result && result.ok) return null;
  return fail(
    (result && result.error) || "The element could not be acted on.",
    result && result.suggestion,
    result && result.recovery,
    result && result.blocking ? { blocking: result.blocking, pageState: result.pageState } : {},
  );
}

/* ------------------------------ tools ------------------------------ */

const TOOLS = [
  {
    name: "browser_navigate",
    planSafeActions: ["*"],
    description:
      "Navigate the session's built-in browser to a URL (http/https only). Use browser_snapshot after navigation. Reuses the connected page by default; omit position for background work so focus is preserved, and reveal only when the user asks.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL" },
        newTab: { type: "boolean", description: "Open in a new tab" },
        headless: { type: "boolean", description: "With newTab: drive it in the background" },
        position: { type: "string", enum: ["active", "side"], description: "Reveal the tab when the user asked to see it" },
        preserveFocus: { type: "boolean", description: "Never reveal or focus the tab" },
      },
      required: ["url"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const url = String(args?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return fail("Only http(s) URLs can be opened by this tool.", "Pass a full https:// URL.", "browser_navigate");
      }
      const allowed = originAllowed(url);
      if (!allowed.ok) return fail(allowed.reason, "Use an allowed site.", "browser_navigate");
      const background = args?.headless === true || args?.preserveFocus === true;
      if (args?.newTab === true || args?.headless === true) {
        const opened = await pi.browser.tabs({
          action: "new",
          url,
          ...(background ? { headless: true } : {}),
          sessionId,
        });
        if (!background) await pi.browser.reveal();
        return { ok: true, tabId: opened && opened.tabId, state: opened && opened.state };
      }
      const state = await pi.browser.navigate({ sessionId, url });
      if (args?.position && !background) await pi.browser.reveal();
      return { ok: true, state };
    },
  },
  {
    name: "browser_snapshot",
    planSafeActions: ["*"],
    description:
      "Capture a DOM snapshot with stable refs (e1, e2, ...). This is the source of truth for page structure; screenshots cannot drive actions. Refs stay valid while the element is on the page. Options: interactive, compact, selector, maxDepth (default 30), includeDiff. Iframe content is not accessible. If four attempts fail or progress stalls with no new evidence, stop and report the page, target, blocker and next step instead of retrying.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        interactive: { type: "boolean", description: "Only actionable elements" },
        compact: { type: "boolean", description: "One line per node" },
        selector: { type: "string", description: "Snapshot only this subtree" },
        maxDepth: { type: "number", description: "Maximum DOM depth (default 30)" },
        includeDiff: { type: "boolean", description: "Include changes since the previous snapshot in this tab" },
      },
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const opts = {
        interactive: args?.interactive === true,
        compact: args?.compact === true,
        selector: typeof args?.selector === "string" ? args.selector : "",
        maxDepth: Number(args?.maxDepth) || 30,
        includeDiff: args?.includeDiff === true,
      };
      const result = await runPage(
        sessionId,
        `
        const opts = ${JSON.stringify(opts)};
        const roots = opts.selector ? (piDeepQuery(opts.selector) ? [piDeepQuery(opts.selector)] : []) : (document.body ? [document.body] : []);
        if (opts.selector && roots.length === 0) return { tree: '', url: location.href, title: document.title, count: 0, missing: opts.selector };
        const state = globalThis.__PI_REF_STATE || (globalThis.__PI_REF_STATE = { byEl: new WeakMap(), byRef: new Map(), next: 1 });
        globalThis.__PI_REFS = state.byRef;
        // Refs are stable: an element keeps its handle until it leaves the DOM.
        for (const entry of state.byRef) {
          if (!entry[1].isConnected) state.byRef.delete(entry[0]);
        }
        function stableRef(el) {
          const existing = state.byEl.get(el);
          if (existing && state.byRef.get(existing) === el) return existing;
          const ref = 'e' + state.next++;
          state.byEl.set(el, ref);
          state.byRef.set(ref, el);
          return ref;
        }
        function describedBy(el) {
          const ids = String(el.getAttribute('aria-describedby') || '').trim();
          if (!ids) return '';
          return ids.split(/\s+/).map(function(id) {
            const node = document.getElementById(id);
            return node ? String(node.textContent || '').trim() : '';
          }).filter(Boolean).join(' ').slice(0, 200);
        }
        function optionDetail(el) {
          const options = Array.from(el.options || []);
          const mapped = options.slice(0, 20).map(function(opt) {
            const label = String(opt.textContent || '').trim();
            let text = label;
            if (opt.value && opt.value !== label) text += ' (value: ' + opt.value + ')';
            if (opt.disabled) text += ' [disabled]';
            return text;
          });
          if (options.length > 20) mapped.push('... (' + options.length + ' total)');
          return mapped.join(' | ').slice(0, 400);
        }
        const nodes = [];
        const nameCounts = new Map();
        const maxDepth = Math.max(1, Math.min(80, opts.maxDepth));
        for (const root of roots) {
          for (const el of piAll(root, [])) {
            if (!piVisible(el)) continue;
            const depth = piDepth(el);
            if (depth > maxDepth) continue;
            const role = piRole(el);
            const interactive = piAllInteractive(el) || !!role;
            const landmark = piLandmark(el);
            const content = piContent(el);
            if (opts.interactive && !interactive) continue;
            if (!interactive && !landmark && !content) continue;
            const name = piName(el);
            if (!interactive && !name && !el.getAttribute('aria-label')) continue;
            const ref = stableRef(el);
            const roleName = role || el.tagName.toLowerCase();
            const key = roleName + '|' + name;
            const seen = nameCounts.get(key) || 0;
            nameCounts.set(key, seen + 1);
            const tag = el.tagName.toLowerCase();
            const levelMatch = roleName === 'heading' ? (el.getAttribute('aria-level') || (tag.match(/^h([1-6])$/) || [])[1] || '') : '';
            const description = String(el.getAttribute('aria-description') || '').trim() || describedBy(el);
            const value = tag === 'input' && String(el.type || '').toLowerCase() === 'password' ? '' : piValue(el);
            nodes.push({
              ref: ref, role: roleName, name: name, depth: depth, nth: seen, level: levelMatch, interactive: interactive,
              states: piStates(el), value: value,
              placeholder: el.getAttribute('placeholder') || '',
              description: description,
              url: tag === 'a' ? String(el.getAttribute('href') || '') : '',
              src: tag === 'img' || tag === 'svg' ? String(el.getAttribute('src') || '') : '',
              activeDescendant: String(el.getAttribute('aria-activedescendant') || ''),
              options: tag === 'select' ? optionDetail(el) : '',
            });
          }
        }
        const lines = [];
        for (const node of nodes) {
          const pad = '  '.repeat(Math.min(node.depth, 20));
          if (opts.compact) {
            const stateText = node.states.length ? ' [' + node.states.join(',') + ']' : '';
            lines.push(pad + '- ' + node.ref + ' ' + node.role + ' "' + node.name.replace(/"/g, '\\"') + '"' + stateText);
          } else {
            lines.push(pad + '- role: ' + node.role);
            if (node.name) lines.push(pad + '  name: ' + JSON.stringify(node.name));
            lines.push(pad + '  ref: ' + node.ref);
            if (node.nth > 0) lines.push(pad + '  nth: ' + node.nth);
            if (node.level) lines.push(pad + '  level: ' + node.level);
            if (node.value) lines.push(pad + '  value: ' + JSON.stringify(node.value));
            if (node.placeholder) lines.push(pad + '  placeholder: ' + JSON.stringify(node.placeholder));
            if (node.description) lines.push(pad + '  description: ' + JSON.stringify(node.description));
            if (node.url) lines.push(pad + '  url: ' + JSON.stringify(node.url));
            if (node.src) lines.push(pad + '  src: ' + JSON.stringify(node.src));
            if (node.activeDescendant) lines.push(pad + '  activeDescendant: ' + JSON.stringify(node.activeDescendant));
            if (node.options) lines.push(pad + '  options: ' + JSON.stringify(node.options));
            if (node.states.length) lines.push(pad + '  state: [' + node.states.join(', ') + ']');
          }
        }
        // Diff against the previous snapshot of this page, keyed by stable ref.
        function nodeSignature(node) {
          return node.ref + '|' + node.role + '|' + node.name + '|' + node.states.join(',') + '|' + node.value;
        }
        const previous = globalThis.__PI_LAST_SNAPSHOT;
        let diff = '';
        if (opts.includeDiff && previous) {
          const before = new Map(previous.nodes.map(function(entry) { return [entry.ref, entry]; }));
          const now = new Map(nodes.map(function(entry) { return [entry.ref, { node: entry, sig: nodeSignature(entry) }]; }));
          const changes = [];
          for (const [ref, entry] of now) {
            const old = before.get(ref);
            const node = entry.node;
            if (!old) changes.push('+ ' + ref + ' ' + node.role + ' "' + node.name + '"');
            else if (old.sig !== entry.sig) {
              const stateText = node.states.length ? ' [' + node.states.join(',') + ']' : '';
              changes.push('~ ' + ref + ' ' + node.role + ' "' + node.name + '"' + stateText);
            }
          }
          for (const [ref, node] of before) {
            if (!now.has(ref)) changes.push('- ' + ref + ' ' + node.role + ' "' + node.name + '"');
          }
          diff = changes.length ? changes.join('\\n') : '(no changes since the previous snapshot)';
        }
        globalThis.__PI_LAST_SNAPSHOT = {
          url: location.href,
          nodes: nodes.map(function(node) {
            return { ref: node.ref, role: node.role, name: node.name, sig: nodeSignature(node) };
          }),
        };
        const stats = '- Total refs: ' + nodes.length + '\\n- Interactive refs: ' + nodes.filter(function(node) { return node.interactive; }).length;
        const filters = [];
        if (opts.interactive) filters.push('interactive only');
        if (opts.compact) filters.push('compact');
        if (opts.selector) filters.push('selector: ' + opts.selector);
        const header = 'Page: ' + (document.title || '(untitled)') + '\\nURL: ' + location.href + '\\n' + stats + (filters.length ? '\\n- Filter: ' + filters.join(' · ') : '') + (diff ? '\\n\\nChanges:\\n' + diff : '');
        return { tree: header + '\\n\\n' + (lines.join('\\n') || '(empty)'), url: location.href, title: document.title, count: nodes.length, diff: diff, stats: { totalRefs: nodes.length } };
        `,
      );
      if (result && result.ok) {
        SNAPSHOT_CACHE.set(sessionId || "default", { at: Date.now(), url: result.url, count: result.count });
      }
      return { ok: true, ...result };
    },
  },
  {
    name: "browser_click",
    description:
      "Click an element by ref from browser_snapshot. Scrolls, hit-tests against overlays/dropdowns, recovers stale refs, and retries with an offset. Use modifiers for Ctrl/Cmd/Shift-click. If a click fails twice with no new evidence, take a snapshot instead of repeating it. Do not use CDP Input.* for clicks.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Snapshot ref (e1, e2, ...)" },
        element: { type: "string", description: "Expected accessible name; used to recover a stale ref" },
        offsetX: { type: "number", description: "Horizontal offset from element centre (px)" },
        offsetY: { type: "number", description: "Vertical offset from element centre (px)" },
        doubleClick: { type: "boolean" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        modifiers: { type: "array", items: { type: "string", enum: ["Control", "Shift", "Alt", "Meta", "ControlOrMeta"] }, description: "Modifier keys held during the click" },
        maxScrollAttempts: { type: "number", description: "Default 5" },
        retryOnStaleRef: { type: "boolean", description: "Default true" },
        autoCloseDropdowns: { type: "boolean", description: "Default true" },
        retryWithOffset: { type: "boolean", description: "Default true" },
        take_screenshot_afterwards: { type: "boolean" },
      },
      required: ["ref"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const opts = {
        ref: String(args?.ref || "").trim(),
        element: typeof args?.element === "string" ? args.element : "",
        offsetX: Number(args?.offsetX) || 0,
        offsetY: Number(args?.offsetY) || 0,
        doubleClick: args?.doubleClick === true,
        button: String(args?.button || "left"),
        modifiers: normalizeModifiers(args?.modifiers),
        maxScrollAttempts: Math.max(1, Math.min(20, Number(args?.maxScrollAttempts) || 5)),
        retryOnStaleRef: args?.retryOnStaleRef !== false,
        autoCloseDropdowns: args?.autoCloseDropdowns !== false,
        retryWithOffset: args?.retryWithOffset !== false,
      };
      const result = await runPage(
        sessionId,
        `
        const opts = ${JSON.stringify(opts)};
        function normalized(value) { return String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }
        function findByName() {
          if (!opts.element) return null;
          const needle = normalized(opts.element);
          const candidates = piAll(document.body || document.documentElement, []).filter(function(node) {
            if (!piVisible(node)) return false;
            const name = normalized(piName(node));
            return name && (name === needle || name.indexOf(needle) >= 0);
          });
          return candidates.length ? candidates[0] : null;
        }
        function pick() {
          const el = piFindRef(opts.ref);
          if (el) {
            if (!opts.element) return { el };
            const actual = normalized(piName(el));
            const needle = normalized(opts.element);
            if (actual === needle || actual.indexOf(needle) >= 0) return { el };
            return { refMismatch: { actual: piName(el) } };
          }
          const alt = findByName();
          if (alt) return { el: alt, refRecovered: true, usedRef: piRefOf(alt) || opts.ref };
          return null;
        }
        let picked = pick();
        if (picked && picked.refMismatch) return { ok: false, error: 'Ref ' + opts.ref + ' resolves to "' + picked.refMismatch.actual + '", not "' + opts.element + '"', suggestion: 'Take a fresh snapshot or pass the ref that matches the description.', recovery: 'browser_snapshot', pageState: piPageState() };
        if (!picked) return { ok: false, error: 'Element not found: ' + opts.ref, suggestion: 'Take a snapshot to get current refs.', recovery: 'browser_snapshot', pageState: piPageState() };
        let el = picked.el;
        for (let attempt = 0; attempt < opts.maxScrollAttempts; attempt += 1) {
          if (!el.isConnected) { picked = pick(); if (!picked) break; el = picked.el; }
          piScrollIntoView(el);
          await piFrame();
          const point = piPoint(el);
          if (!point) continue;
          const blocked = piBlocked(el, point);
          if (blocked.type === 'dropdown' && opts.autoCloseDropdowns) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await new Promise(function(resolve){ setTimeout(resolve, 120); });
            continue;
          }
          if (blocked.type !== 'none') {
            if (blocked.type === 'element' && opts.retryWithOffset) {
              for (const shift of [[6,0],[-6,0],[0,6],[0,-6]]) {
                const shifted = { x: point.x + shift[0], y: point.y + shift[1] };
                const inside = shifted.x > point.rect.x && shifted.x < point.rect.x + point.rect.width && shifted.y > point.rect.y && shifted.y < point.rect.y + point.rect.height;
                if (inside && piBlocked(el, shifted).type === 'none') {
                  return { ok: true, x: shifted.x + opts.offsetX, y: shifted.y + opts.offsetY, attempts: attempt + 1, refRecovered: !!picked.refRecovered, usedRef: picked.usedRef, offsetUsed: shift, pageState: piPageState() };
                }
              }
            }
            const suggestion = blocked.type === 'modal'
              ? 'A dialog/modal is covering the element. Close it first.'
              : blocked.type === 'iframe'
                ? 'The click lands on an iframe. Navigate to the iframe URL or snapshot inside it.'
                : blocked.type === 'dropdown'
                  ? 'A dropdown is covering the element. Press Escape or click outside it.'
                  : blocked.type === 'scroll-container'
                    ? 'A scroll container intercepts the click. Scroll the container first.'
                    : 'Another element covers the target. Click the covering ref or take a fresh snapshot.';
            return { ok: false, error: 'Element is obscured at (' + Math.round(point.x) + ', ' + Math.round(point.y) + ')', blocking: blocked, suggestion: suggestion, recovery: blocked.type === 'iframe' ? 'browser_navigate' : 'browser_snapshot', pageState: piPageState() };
          }
          return { ok: true, x: point.x + opts.offsetX, y: point.y + opts.offsetY, attempts: attempt + 1, refRecovered: !!picked.refRecovered, usedRef: picked.usedRef, pageState: piPageState() };
        }
        return { ok: false, error: 'Element is not visible or could not be scrolled into view: ' + opts.ref, suggestion: 'Take a fresh snapshot; the element may be hidden or removed.', recovery: 'browser_snapshot', pageState: piPageState() };
        `,
      );
      const error = resolveError(result);
      if (error) return error;
      const clicked = await clickResolved(sessionId, result, opts);
      if (args?.take_screenshot_afterwards) {
        clicked.screenshot = await takeScreenshot(sessionId, {});
      }
      return clicked;
    },
  },
  {
    name: "browser_mouse_click_xy",
    description:
      "Click at viewport coordinates from the most recent screenshot. Rejects stale screenshots. Prefer browser_click with refs when possible.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        doubleClick: { type: "boolean" },
      },
      required: ["x", "y"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      let memory = SCREENSHOT_MEMORY.get(sessionId || "default");
      try {
        if (typeof pi.browser.screenshotState === "function") {
          const hostState = await pi.browser.screenshotState();
          if (hostState && hostState.imageWidth && hostState.imageHeight) {
            memory = {
              url: hostState.url,
              imageWidth: hostState.imageWidth,
              imageHeight: hostState.imageHeight,
              viewportWidth: guard.state.viewport.width,
              viewportHeight: guard.state.viewport.height,
              takenAt: hostState.at,
            };
          }
        }
      } catch {
        // Fall back to the plugin-local memory.
      }
      if (!memory) {
        return fail("No screenshot for this page yet.", "Call browser_take_screenshot first, then use its coordinates.", "browser_take_screenshot");
      }
      if (memory.url !== guard.state.url) {
        return fail("The page changed since the last screenshot.", "Take a new screenshot and retry.", "browser_take_screenshot", { pageState: guard.state });
      }
      const imageWidth = Number(memory.imageWidth) || Number(memory.viewportWidth);
      const imageHeight = Number(memory.imageHeight) || Number(memory.viewportHeight);
      const x = (Number(args?.x) / imageWidth) * memory.viewportWidth;
      const y = (Number(args?.y) / imageHeight) * memory.viewportHeight;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return fail("Screenshot coordinates are not numbers.", "Pass x and y from the last screenshot.", "browser_take_screenshot");
      }
      await mouseClick(sessionId, x, y, { doubleClick: args?.doubleClick === true });
      return { ok: true, x: Math.round(x), y: Math.round(y), pageState: guard.state };
    },
  },
  {
    name: "browser_type",
    description: "Focus an element by ref and type text with trusted native input. clear empties it first, submit presses Enter after, slowly types character by character for autocomplete.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
        element: { type: "string", description: "Expected name for stale-ref recovery" },
        clear: { type: "boolean", description: "Clear the existing value first" },
        submit: { type: "boolean", description: "Press Enter after typing" },
        slowly: { type: "boolean", description: "Type one character at a time to trigger autocomplete" },
      },
      required: ["ref", "text"],
    },
    execute: async (args, ctx) => typeInto(args, ctx, "type"),
  },
  {
    name: "browser_fill",
    description: "Replace the value of an input, textarea, or contenteditable element by ref using trusted native input.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
        element: { type: "string" },
        submit: { type: "boolean", description: "Press Enter after filling" },
      },
      required: ["ref", "text"],
    },
    execute: async (args, ctx) => typeInto(args, ctx, "fill"),
  },
  {
    name: "browser_fill_form",
    description: "Fill several input/textarea/contenteditable refs in one call.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: { ref: { type: "string" }, text: { type: "string" } },
            required: ["ref", "text"],
          },
        },
      },
      required: ["fields"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      return await runPage(
        sessionId,
        `
        const fields = ${JSON.stringify(Array.isArray(args?.fields) ? args.fields : [])};
        const filled = [], missing = [];
        for (const field of fields) {
          const el = piFindRef(String(field.ref || ''));
          if (!el) { missing.push(String(field.ref || '')); continue; }
          piScrollIntoView(el);
          try { el.focus({ preventScroll: true }); } catch (e) {}
          if (el.isContentEditable) el.textContent = String(field.text ?? '');
          else if ('value' in el) el.value = String(field.text ?? '');
          else { missing.push(String(field.ref || '')); continue; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          filled.push(String(field.ref || ''));
        }
        return missing.length
          ? { ok: false, error: 'Some fields were not found: ' + missing.join(', '), suggestion: 'Take a snapshot.', recovery: 'browser_snapshot', filled, missing }
          : { ok: true, filled };
        `,
      );
    },
  },
  {
    name: "browser_select_option",
    description: "Select one or more options in a select element by ref.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        values: { type: "array", items: { type: "string" } },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["ref"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const result = await runPage(
        sessionId,
        `
        const ref = ${JSON.stringify(String(args?.ref || ""))};
        const values = ${JSON.stringify(Array.isArray(args?.values) ? args.values.map(String) : [])};
        const labels = ${JSON.stringify(Array.isArray(args?.labels) ? args.labels.map(String) : [])};
        const el = piFindRef(ref);
        if (!el) return { ok: false, error: 'Element not found: ' + ref, suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
        if (el.tagName.toLowerCase() !== 'select') return { ok: false, error: 'Element is not a select', suggestion: 'Use browser_snapshot to find a select element.', recovery: 'browser_snapshot' };
        let changed = 0;
        for (const option of Array.from(el.options)) {
          const matchValue = values.length ? values.indexOf(option.value) >= 0 : false;
          const matchLabel = labels.length ? labels.indexOf((option.textContent || '').trim()) >= 0 : false;
          if (matchValue || matchLabel) { option.selected = true; changed += 1; }
        }
        if (!changed) return { ok: false, error: 'No option matched', suggestion: 'Check values/labels against the snapshot.', recovery: 'browser_snapshot' };
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, changed };
        `,
      );
      return result;
    },
  },
  {
    name: "browser_press_key",
    description: "Press a key on the focused element (or a ref) using trusted native key events.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "e.g. Enter, Escape, ArrowDown, a" },
        ref: { type: "string", description: "Optional element to focus first" },
      },
      required: ["key"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const key = String(args?.key || "");
      if (!key) return fail("key is required.", "Pass a key such as Enter or Escape.", "browser_press_key");
      const focused = await runPage(
        sessionId,
        `
        const ref = ${JSON.stringify(String(args?.ref || ""))};
        let target = ref ? piFindRef(ref) : document.activeElement;
        if (ref && !target) return { ok: false, error: 'Element not found: ' + ref, suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
        if (!target || target === document.body) target = document.activeElement || document.body;
        try { target.focus({ preventScroll: true }); } catch (e) {}
        return { ok: true };
        `,
      );
      if (!focused || focused.ok !== true) return focused;
      const named = {
        Enter: "Return", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
        ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
        Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Space: "Space",
      };
      const keyCode = named[key] || (key.length === 1 ? key.toUpperCase() : key);
      await pi.browser.inputEvent({ type: "keyDown", keyCode });
      if (key.length === 1) {
        await pi.browser.inputEvent({ type: "char", keyCode: key });
      }
      await pi.browser.inputEvent({ type: "keyUp", keyCode });
      return { ok: true, key };
    },
  },
  {
    name: "browser_hover",
    description: "Move the pointer over an element by ref.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        element: { type: "string" },
        waitForChange: { type: "boolean", description: "Wait for DOM changes after hovering" },
        timeoutMs: { type: "number", description: "Max wait for waitForChange (default 2000)" },
      },
      required: ["ref"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const result = await runPage(
        sessionId,
        `
        const ref = ${JSON.stringify(String(args?.ref || ""))};
        let el = piFindRef(ref);
        if (!el) return { ok: false, error: 'Element not found: ' + ref, suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
        piScrollIntoView(el);
        await piFrame();
        const point = piPoint(el);
        if (!point) return { ok: false, error: 'Element has no visible box', suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
        return { ok: true, x: point.x, y: point.y };
        `,
      );
      if (!result.ok) return result;
      await pi.browser.inputEvent({ type: "mouseMove", x: Math.round(result.x), y: Math.round(result.y) });
      let changed = false;
      if (args?.waitForChange === true) {
        const timeout = Math.max(100, Math.min(15000, Number(args?.timeoutMs) || 2000));
        changed = await runPage(
          sessionId,
          `
          const timeout = ${JSON.stringify(timeout)};
          return await new Promise(function(resolve) {
            let done = false;
            const finish = function(value) { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); resolve(value); };
            const observer = new MutationObserver(function() { finish(true); });
            observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
            const timer = setTimeout(function() { finish(false); }, timeout);
          });
          `,
        );
      }
      return { ok: true, x: Math.round(result.x), y: Math.round(result.y), ...(args?.waitForChange === true ? { changed } : {}) };
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page or a scrollable container, or scroll an element into view.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Pixels, default 300" },
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        scrollIntoView: { type: "boolean" },
      },
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const scrollable = {
        ref: String(args?.ref || ""),
        direction: String(args?.direction || ""),
        amount: Number(args?.amount) || 300,
        deltaX: Number(args?.deltaX) || 0,
        deltaY: Number(args?.deltaY) || 0,
        scrollIntoView: args?.scrollIntoView === true,
      };
      const result = await runPage(
        sessionId,
        `
        const opts = ${JSON.stringify(scrollable)};
        let dx = opts.deltaX, dy = opts.deltaY;
        if (opts.direction === 'up') dy = -opts.amount;
        else if (opts.direction === 'down') dy = opts.amount;
        else if (opts.direction === 'left') dx = -opts.amount;
        else if (opts.direction === 'right') dx = opts.amount;
        const el = opts.ref ? piFindRef(opts.ref) : null;
        if (opts.ref && !el) return { ok: false, error: 'Element not found: ' + opts.ref, suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
        if (el && (opts.scrollIntoView || (dx === 0 && dy === 0))) { piScrollIntoView(el); return { ok: true, mode: 'into-view' }; }
        if (el) {
          const s = getComputedStyle(el);
          const box = /(auto|scroll)/.test(s.overflowY + s.overflowX) ? el : null;
          if (box) { box.scrollBy({ left: dx, top: dy, behavior: 'instant' }); return { ok: true, mode: 'container' }; }
        }
        window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
        return { ok: true, mode: 'window' };
        `,
      );
      return result;
    },
  },
  {
    name: "browser_drag",
    description: "Drag from a source ref to a target ref or viewport coordinates.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        sourceRef: { type: "string" },
        targetRef: { type: "string" },
        targetX: { type: "number" },
        targetY: { type: "number" },
      },
      required: ["sourceRef"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      if (!args?.targetRef && (args?.targetX === undefined || args?.targetY === undefined)) {
        return fail("Either targetRef or targetX/targetY is required.", "Pass a target element or coordinates.", "browser_snapshot");
      }
      const result = await runPage(
        sessionId,
        `
        const source = piFindRef(${JSON.stringify(String(args?.sourceRef || ""))});
        if (!source) return { ok: false, error: 'Source element not found', suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
        piScrollIntoView(source);
        await piFrame();
        const from = piPoint(source);
        if (!from) return { ok: false, error: 'Source has no visible box', suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
        let to;
        const targetRef = ${JSON.stringify(String(args?.targetRef || ""))};
        if (targetRef) {
          const target = piFindRef(targetRef);
          if (!target) return { ok: false, error: 'Target element not found', suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
          piScrollIntoView(target);
          await piFrame();
          const point = piPoint(target);
          if (!point) return { ok: false, error: 'Target has no visible box', suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
          to = { x: point.x, y: point.y };
        } else {
          to = { x: ${JSON.stringify(Number(args?.targetX) || 0)}, y: ${JSON.stringify(Number(args?.targetY) || 0)} };
        }
        return { ok: true, from: { x: from.x, y: from.y }, to: to };
        `,
      );
      if (!result.ok) return result;
      await pi.browser.inputEvent({ type: "mouseMove", x: Math.round(result.from.x), y: Math.round(result.from.y) });
      await pi.browser.inputEvent({ type: "mouseDown", x: Math.round(result.from.x), y: Math.round(result.from.y), button: "left", clickCount: 1 });
      for (let step = 1; step <= 8; step += 1) {
        const x = result.from.x + ((result.to.x - result.from.x) * step) / 8;
        const y = result.from.y + ((result.to.y - result.from.y) * step) / 8;
        await pi.browser.inputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
      }
      await pi.browser.inputEvent({ type: "mouseUp", x: Math.round(result.to.x), y: Math.round(result.to.y), button: "left", clickCount: 1 });
      return { ok: true, from: result.from, to: result.to };
    },
  },
  {
    name: "browser_highlight",
    description: "Highlight an element by ref for visual grounding.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        durationMs: { type: "number", description: "Default 2000" },
      },
      required: ["ref"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const result = await runPage(
        sessionId,
        `
        const ref = ${JSON.stringify(String(args?.ref || ""))};
        const duration = Math.max(200, Math.min(15000, ${JSON.stringify(Number(args?.durationMs) || 2000)}));
        const el = piFindRef(ref);
        if (!el) return { ok: false, error: 'Element not found: ' + ref, suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
        piScrollIntoView(el);
        await piFrame();
        const point = piPoint(el);
        if (!point) return { ok: false, error: 'Element has no visible box', suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
        const old = document.getElementById('pi-highlight-box'); if (old) old.remove();
        const box = document.createElement('div');
        box.id = 'pi-highlight-box';
        box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;border:2px solid #ff6a00;box-shadow:0 0 0 4px rgba(255,106,0,.25);border-radius:3px;'
          + 'left:' + Math.max(0, point.rect.x) + 'px;top:' + Math.max(0, point.rect.y) + 'px;'
          + 'width:' + Math.min(innerWidth, point.rect.width) + 'px;height:' + Math.min(innerHeight, point.rect.height) + 'px;';
        document.body.appendChild(box);
        setTimeout(function(){ const node = document.getElementById('pi-highlight-box'); if (node) node.remove(); }, duration);
        return { ok: true, durationMs: duration };
        `,
      );
      return result;
    },
  },
  {
    name: "browser_get_bounding_box",
    planSafeActions: ["*"],
    description: "Return the viewport bounding box for an element ref.",
    risk: "low",
    schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      return await runPage(
        sessionId,
        `
        const ref = ${JSON.stringify(String(args?.ref || ""))};
        const el = piFindRef(ref);
        if (!el) return { ok: false, error: 'Element not found: ' + ref, suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
        const r = el.getBoundingClientRect();
        return { ok: true, box: { x: r.left, y: r.top, width: r.width, height: r.height }, visible: piVisible(el) };
        `,
        false,
      );
    },
  },
  {
    name: "browser_take_screenshot",
    planSafeActions: ["*"],
    description: "Capture the page (or an element by ref). Screenshots are size-capped; prefer browser_snapshot for structure.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        fullPage: { type: "boolean" },
        ref: { type: "string", description: "Screenshot only this element" },
        type: { type: "string", enum: ["jpeg", "png"], description: "Image format (default jpeg)" },
        filename: { type: "string", description: "Save a copy under the plugin data directory" },
        clipX: { type: "number", description: "Clip x in CSS pixels" },
        clipY: { type: "number", description: "Clip y in CSS pixels" },
        clipWidth: { type: "number", description: "Clip width in CSS pixels" },
        clipHeight: { type: "number", description: "Clip height in CSS pixels" },
      },
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const clip = typeof args?.clipWidth === "number" && typeof args?.clipHeight === "number"
        ? { x: Number(args?.clipX) || 0, y: Number(args?.clipY) || 0, width: Number(args.clipWidth), height: Number(args.clipHeight) }
        : undefined;
      return await takeScreenshot(sessionId, { fullPage: args?.fullPage === true, ref: args?.ref, type: args?.type, filename: args?.filename, clip });
    },
  },
  {
    name: "browser_dialog",
    description:
      "Read, accept, or dismiss the JavaScript alert/confirm/prompt currently blocking the page. Use it when a click or navigation leaves the page unresponsive because a dialog is open.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "accept", "dismiss"] },
        promptText: { type: "string", description: "Text to enter into a prompt()" },
      },
      required: ["action"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      if (String(args?.action || "") === "get") {
        return { ok: true, action: "get", dialog: await pi.browser.getJsDialog({ sessionId }) };
      }
      const accept = String(args?.action || "accept") !== "dismiss";
      const result = await pi.browser.handleDialog({
        accept,
        ...(typeof args?.promptText === "string" ? { promptText: args.promptText } : {}),
      });
      if (!result || result.ok !== true) {
        return fail(
          "No JavaScript dialog is open (or it already closed).",
          "Take a snapshot to check the page state before retrying.",
          "browser_snapshot",
        );
      }
      return { ok: true, action: accept ? "accept" : "dismiss" };
    },
  },
  {
    name: "browser_wait",
    description:
      "Wait for a page condition instead of sleeping: selector appears/disappears, text appears, URL changes, navigation completes, DOM settles, or network goes idle. Polls briefly; returns a timeout result rather than hanging.",
    planSafeActions: ["*"],
    risk: "low",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["selector", "text", "url", "navigation", "domStable", "networkIdle", "loadState", "download", "fileChooser"] },
        state: { type: "string", enum: ["present", "absent", "load", "domcontentloaded", "networkidle"], description: "present/absent for selector/text/url; load state for kind=loadState" },
        target: { type: "string", description: "Selector, text, or URL fragment (depending on kind)" },
        timeoutMs: { type: "number", description: "Default 10000; download/fileChooser allow up to 300000" },
      },
      required: ["kind"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const kind = String(args?.kind || "selector");
      const target = String(args?.target || "");
      const absent = String(args?.state || "present") === "absent";
      const timeout = Math.max(200, Math.min(kind === "download" || kind === "fileChooser" ? 300000 : 25000, Number(args?.timeoutMs) || (kind === "download" ? 120000 : 10000)));
      if (kind === "download") {
        const record = await pi.browser.waitForDownload({ timeoutMs: timeout });
        return { ok: true, kind, ...(record || {}) };
      }
      if (kind === "fileChooser") {
        const chooser = await pi.browser.waitForFileChooser({ timeoutMs: timeout });
        return { ok: true, kind, chooser };
      }
      if (kind === "loadState") {
        const wanted = ["load", "domcontentloaded", "networkidle"].includes(String(args?.state)) ? String(args.state) : "load";
        const deadline = Date.now() + timeout;
        for (;;) {
          const ready = String(await runPage(sessionId, "return document.readyState;", true) ?? "");
          if (wanted === "domcontentloaded" ? ready !== "loading" : ready === "complete") {
            return { ok: true, kind, state: wanted, waitedMs: timeout - Math.max(0, deadline - Date.now()) };
          }
          if (Date.now() >= deadline) return fail(`load state ${wanted} not reached in ${timeout}ms`, "Increase timeoutMs or check the page.", "browser_snapshot");
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }
      if (kind === "networkIdle") {
        const start = Date.now();
        let quietSince = Date.now();
        while (Date.now() - start < timeout) {
          const recent = await pi.browser.networkRequests({ limit: 5 });
          const entries = Array.isArray(recent?.entries) ? recent.entries : [];
          const newest = entries.length ? entries[entries.length - 1].timestamp : 0;
          if (Date.now() - newest > 600) quietSince = quietSince || Date.now();
          else quietSince = 0;
          if (quietSince && Date.now() - quietSince > 500) {
            return { ok: true, kind, waitedMs: Date.now() - start, matched: true };
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return fail(`Network did not go idle within ${timeout}ms.`, "Increase timeoutMs or inspect browser_network.", "browser_network");
      }
      const result = await runPage(
        sessionId,
        `
        const kind = ${JSON.stringify(kind)};
        const target = ${JSON.stringify(target)};
        const absent = ${absent === true};
        const timeout = ${timeout};
        const start = Date.now();
        const initialUrl = location.href;
        let lastHtml = '';
        let stableSince = 0;
        const sleep = function(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); };
        for (;;) {
          let matched = false;
          if (kind === 'selector') {
            let found = false;
            try { found = !!piDeepQuery(target); } catch (e) { found = false; }
            matched = absent ? !found : found;
          } else if (kind === 'text') {
            const haystack = String((document.body && document.body.innerText) || '');
            const found = haystack.indexOf(target) >= 0;
            matched = absent ? !found : found;
          } else if (kind === 'url') {
            const found = location.href.indexOf(target) >= 0;
            matched = absent ? !found : found;
          } else if (kind === 'navigation') {
            matched = location.href !== initialUrl;
          } else if (kind === 'domStable') {
            const html = String((document.body && document.body.innerHTML) || '');
            if (html === lastHtml) {
              if (!stableSince) stableSince = Date.now();
              matched = Date.now() - stableSince >= 300;
            } else {
              lastHtml = html;
              stableSince = 0;
            }
          }
          if (matched) return { ok: true, kind: kind, waitedMs: Date.now() - start, matched: true, url: location.href };
          if (Date.now() - start > timeout) return { ok: false, timeout: true, kind: kind, waitedMs: Date.now() - start, url: location.href, error: 'Timed out waiting for ' + kind + (target ? ' ' + target : '') };
          await sleep(100);
        }
        `,
      );
      if (result && result.ok) return result;
      return fail(
        (result && result.error) || "Timed out waiting for the page condition.",
        "Take a snapshot to see the current state, or increase timeoutMs.",
        "browser_snapshot",
      );
    },
  },
  {
    name: "browser_console",
    description:
      "Read recent console output from the page. Use it for JavaScript errors and diagnostics instead of guessing from a screenshot.",
    planSafeActions: ["*"],
    risk: "low",
    schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum entries, default 100" },
        level: { type: "string", enum: ["all", "error", "warning", "log"], description: "Filter by level" },
        levels: { type: "array", items: { type: "string", enum: ["debug", "info", "log", "warn", "error"] }, description: "Codex-style level filter (warn matches warning)" },
        filter: { type: "string", description: "Only entries containing this text (alias of search)" },
        search: { type: "string", description: "Only entries containing this text" },
      },
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const result = await pi.browser.consoleLogs({ limit: Number(args?.limit) || 100 });
      const level = String(args?.level || "all");
      const levels = Array.isArray(args?.levels) ? args.levels.map(String) : [];
      const needle = String(args?.filter ?? args?.search ?? "").toLowerCase();
      const entries = (Array.isArray(result?.entries) ? result.entries : [])
        .filter((entry) => level === "all" || entry.type === level || (level === "warning" && entry.type === "warn"))
        .filter((entry) => !levels.length || levels.includes(String(entry.type)) || (entry.type === "warning" && levels.includes("warn")))
        .filter((entry) => !needle || String(entry.message).toLowerCase().includes(needle));
      return { ok: true, entries };
    },
  },
  {
    name: "browser_network",
    description:
      "Read recent HTTP requests from the page (method, URL, status). Use it to diagnose failed API calls and blocked resources.",
    planSafeActions: ["*"],
    risk: "low",
    schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum entries, default 100" },
        filter: { type: "string", enum: ["all", "failed"], description: "failed shows non-2xx and network errors" },
        search: { type: "string", description: "Only URLs containing this text" },
      },
    },
    execute: async (args, ctx) => {
      const result = await pi.browser.networkRequests({ limit: Number(args?.limit) || 100 });
      const failedOnly = String(args?.filter || "all") === "failed";
      const needle = String(args?.search || "").toLowerCase();
      const entries = (Array.isArray(result?.entries) ? result.entries : [])
        .filter((entry) => !failedOnly || !(entry.status >= 200 && entry.status < 300))
        .filter((entry) => !needle || String(entry.url).toLowerCase().includes(needle));
      return { ok: true, entries };
    },
  },
  {
    name: "browser_tabs",
    planSafeActions: ["list"],
    description: "List, create, select, show (reveal a background tab), close, claim, release, or mark browser tabs for this session. A tab created by automation closes when the turn ends unless marked deliverable (shown to the user) or handoff (continued later).",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "new", "select", "show", "close", "content", "mention", "claim", "release", "mark"] },
        urls: { type: "array", items: { type: "string" }, description: "For action=content: URLs to load in temporary background tabs" },
        contentType: { type: "string", enum: ["text", "html", "domSnapshot"], description: "For action=content: default text" },
        timeoutMs: { type: "number", description: "For action=content: per-page load budget" },
        tabId: { type: "string" },
        index: { type: "number", description: "Tab index from action=list (select/close/mark/claim)" },
        position: { type: "string", enum: ["active", "side"], description: "For action=new: reveal the tab" },
        url: { type: "string", description: "For action=new; defaults to about:blank" },
        headless: { type: "boolean", description: "For action=new: drive it in the background without revealing it" },
        mark: { type: "string", enum: ["deliverable", "handoff"], description: "For action=mark: keep the tab after this turn" },
      },
      required: ["action"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const action = String(args?.action || "");
      if (!["list", "new", "select", "show", "close", "content", "mention", "claim", "release", "mark"].includes(action)) {
        return fail(`Unknown tabs action: ${action}`, "Use list, new, select, show, close, content, claim, release, or mark.", "browser_tabs");
      }
      if (action === "content") {
        const urls = Array.isArray(args?.urls) ? args.urls.map(String).filter(Boolean) : [];
        if (!urls.length) return fail("action=content requires urls.", "Pass one or more URLs.", "browser_tabs");
        const result = await pi.browser.tabs({
          action: "content",
          urls,
          contentType: ["text", "html", "domSnapshot"].includes(String(args?.contentType)) ? String(args.contentType) : "text",
          ...(typeof args?.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
          sessionId,
        });
        return { ok: true, action, backend: result?.backend, results: result?.results ?? [] };
      }
      let tabId = args?.tabId ? String(args.tabId) : "";
      if (!tabId && typeof args?.index === "number" && (action === "select" || action === "close" || action === "claim" || action === "mark" || action === "mention")) {
        const listed = await pi.browser.tabs({ action: "list", sessionId });
        const index = Math.trunc(args.index);
        const visible = (listed && listed.tabs) || [];
        if (index < 0 || index >= visible.length) {
          return fail(`Tab index ${index} is out of range (${visible.length} tabs).`, "Use action=list to see indexes.", "browser_tabs");
        }
        tabId = visible[index].tabId;
      }
      if (action === "mention") {
        if (!tabId) {
          const listed = await pi.browser.tabs({ action: "list", sessionId });
          const active = (listed?.tabs || []).find((tab) => tab.active) ?? listed?.tabs?.[0];
          tabId = active?.tabId ? String(active.tabId) : "";
        }
        if (!tabId) return fail("action=mention requires an open tab.", "Open a tab first.", "browser_tabs");
        const listed = await pi.browser.tabs({ action: "list", sessionId });
        const entry = (listed?.tabs || []).find((tab) => String(tab.tabId) === tabId);
        return {
          ok: true,
          action,
          tabId,
          mention: `[[tab:${tabId}]]`,
          ...(entry?.providerTabId ? { providerTabId: entry.providerTabId } : {}),
          title: entry?.title ?? "",
          url: entry?.url ?? "",
        };
      }
      if (action === "mark") {
        const mark = String(args?.mark || "");
        if (!tabId) return fail("action=mark requires a tabId or index.", "List tabs first.", "browser_tabs");
        if (mark !== "deliverable" && mark !== "handoff") {
          return fail("mark must be deliverable or handoff.", "Use mark=deliverable to show the page to the user, handoff to continue later.", "browser_tabs");
        }
        const marked = await pi.browser.markTab({ tabId, mark, sessionId });
        return { ok: true, action, tabId, mark, ...(marked || {}) };
      }
      if (action === "claim") {
        if (!tabId) return fail("action=claim requires a tabId or index.", "List user tabs first.", "browser_tabs");
        const claimed = await pi.browser.claimTab({ tabId, sessionId });
        return { ok: true, action, tabId, ...(claimed || {}) };
      }
      if (action === "release") {
        await pi.browser.releaseTab({ sessionId });
        return { ok: true, action };
      }
      const result = await pi.browser.tabs({
        action,
        ...(tabId ? { tabId } : {}),
        ...(args?.url ? { url: String(args.url) } : {}),
        ...(args?.headless === true ? { headless: true } : {}),
        sessionId,
      });
      if (action === "new" && args?.position && args?.headless !== true) {
        await pi.browser.reveal();
      }
      return { ok: true, action, ...(result || {}) };
    },
  },
  {
    name: "browser_capabilities",
    planSafeActions: ["*"],
    description: "List Codex-shaped browser capabilities for this browser or a tab, describe one, or get/set it. visibility.set(true) reveals the browser; visibility.set(false) hides it.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "describe", "get", "set"] },
        id: { type: "string", description: "Capability id, e.g. visibility, tabs, playwright, content" },
        value: { description: "Value for action=set (visibility uses true/false)" },
        tabId: { type: "string", description: "Read the tab's own capability set" },
      },
      required: ["action"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const action = String(args?.action || "list");
      const tabId = args?.tabId ? String(args.tabId) : "";
      const scope = tabId ? { tabId, sessionId } : { sessionId };
      if (action === "list") {
        return { ok: true, action, capabilities: await pi.browser.capabilities(scope) };
      }
      const id = String(args?.id || "").trim();
      if (!id) return fail("Capability id is required.", "Call action=list first.", "browser_capabilities");
      if (action === "describe") {
        return { ok: true, action, ...(await pi.browser.capability({ id, ...scope })) };
      }
      if (action === "get") {
        return { ok: true, action, id, value: await pi.browser.capability({ id, action: "get", ...scope }) };
      }
      if (action === "set") {
        const result = await pi.browser.capability({ id, action: "set", value: args?.value, ...scope });
        return { ok: true, action, id, ...(result || {}) };
      }
      return fail(`Unknown capabilities action: ${action}`, "Use list, describe, get, or set.", "browser_capabilities");
    },
  },
  {
    name: "browser_lock",
    description:
      "Hold an automation lease across a longer workflow. Correct order: browser_navigate -> browser_lock(lock) -> interactions -> browser_lock(unlock) when finished. User takeover always wins and clears the lease; it never grants new capabilities.",
    risk: "low",
    schema: {
      type: "object",
      properties: { action: { type: "string", enum: ["lock", "unlock"] } },
      required: ["action"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const action = String(args?.action || "lock");
      if (action === "unlock") {
        await pi.browser.unlock();
        return { ok: true, locked: false };
      }
      if (action !== "lock") return fail(`Unknown lock action: ${action}`, "Use lock or unlock.", "browser_lock");
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      await pi.browser.lock();
      return { ok: true, locked: true, pageState: guard.state };
    },
  },
  {
    name: "browser_telemetry",
    planSafeActions: ["*"],
    description: "Read the last 300 browser tool outcomes and aggregate success/failure per tool. Local JSONL only.",
    risk: "low",
    schema: { type: "object", properties: { limit: { type: "number", description: "Default 200, max 500" } } },
    execute: async (args) => {
      const limit = Math.max(1, Math.min(500, Number(args?.limit) || 200));
      let lines = [];
      try {
        const text = await readFile(await telemetryLogPath(), "utf8");
        lines = text.split("\n").filter(Boolean).slice(-limit);
      } catch {
        return { ok: true, entries: [], totals: {} };
      }
      const entries = [];
      const totals = {};
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          entries.push(entry);
          const bucket = totals[entry.tool] || { ok: 0, failed: 0, totalMs: 0 };
          if (entry.ok) bucket.ok += 1; else bucket.failed += 1;
          bucket.totalMs += Number(entry.durationMs) || 0;
          totals[entry.tool] = bucket;
        } catch {
          // Skip a torn line; telemetry is best-effort.
        }
      }
      for (const bucket of Object.values(totals)) bucket.avgMs = bucket.ok + bucket.failed ? Math.round(bucket.totalMs / (bucket.ok + bucket.failed)) : 0;
      return { ok: true, entries, totals };
    },
  },
  {
    name: "browser_backend",
    planSafeActions: ["catalog", "status", "health"],
    description: "Select the browser backend for this session: status, connect to an external Chrome/Edge DevTools endpoint (loopback only), or disconnect back to the embedded browser. Binding is session-scoped and never persisted.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["catalog", "status", "connect", "disconnect", "health"] },
        kind: { type: "string", enum: ["cdp", "extension", "mcp"], description: "Backend kind" },
        endpoint: { type: "string", description: "cdp: http://127.0.0.1:<port>; extension: ws://127.0.0.1:<port>; mcp: http(s) MCP endpoint" },
        tabId: { type: "string", description: "Existing target id; defaults to the active tab" },
        url: { type: "string", description: "Open this URL when no tab exists" },
        launch: { type: "boolean", description: "Launch Chrome when the endpoint is not running" },
        chromePath: { type: "string", description: "Absolute Chrome/Chromium/Edge path for launch" },
        userDataDir: { type: "string", description: "Chrome user-data directory for launch" },
        headless: { type: "boolean", description: "Launch Chrome headless" },
        chromeArgs: { type: "array", items: { type: "string" }, description: "Extra Chrome flags" },
      },
      required: ["action"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const action = String(args?.action || "status");
      if (action === "catalog") return { ok: true, browsers: await pi.browser.catalog() };
      if (action === "status") return { ok: true, ...(await pi.browser.backendState({ sessionId })) };
      if (action === "health") return { ok: true, ...(await pi.browser.backendHealth({ sessionId })) };
      if (action === "disconnect") return { ok: true, ...(await pi.browser.disconnectBackend({ sessionId })) };
      if (action !== "connect") return fail(`Unknown backend action: ${action}`, "Use status, health, connect, or disconnect.", "browser_backend");
      return {
        ok: true,
        ...(await pi.browser.connectBackend({
          sessionId,
          kind: String(args?.kind || "cdp"),
          endpoint: String(args?.endpoint || ""),
          ...(args?.tabId ? { tabId: String(args.tabId) } : {}),
          ...(args?.url ? { url: String(args.url) } : {}),
          ...(args?.launch === true ? { launch: true } : {}),
          ...(args?.chromePath ? { chromePath: String(args.chromePath) } : {}),
          ...(args?.userDataDir ? { userDataDir: String(args.userDataDir) } : {}),
          ...(args?.headless === true ? { headless: true } : {}),
          ...(Array.isArray(args?.chromeArgs) ? { chromeArgs: args.chromeArgs.map(String) } : {}),
        })),
      };
    },
  },
  {
    name: "browser_locator",
    planSafeActions: ["list", "count", "waitFor", "text", "innerText", "textContent", "attribute", "isVisible", "isEnabled", "isChecked"],
    description: "Playwright-style element lookup and interaction. Filter by selector, role, text, placeholder, test id, hasText/hasNotText. Actions cover the full Codex locator surface: list, count, click, dblclick, hover, fill, type, press, pressSequentially, text/innerText/textContent, attribute, isVisible/isEnabled/isChecked, check/uncheck/setChecked, selectOption, focus, scrollIntoView, waitFor, evaluate/evaluateAll, downloadMedia.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        text: { type: "string" },
        placeholder: { type: "string" },
        testId: { type: "string" },
        action: { type: "string", enum: ["list", "count", "click", "dblclick", "hover", "fill", "type", "press", "pressSequentially", "text", "innerText", "textContent", "html", "attribute", "isVisible", "isEnabled", "isChecked", "check", "uncheck", "setChecked", "selectOption", "focus", "scrollIntoView", "waitFor", "evaluate", "evaluateAll", "downloadMedia"], description: "Default list" },
        hasText: { type: "string", description: "Filter: textContent must contain this" },
        hasNotText: { type: "string", description: "Filter: textContent must not contain this" },
        visibleOnly: { type: "boolean", description: "Filter: only visible elements" },
        state: { type: "string", enum: ["attached", "detached", "visible", "hidden"], description: "waitFor target state, default visible" },
        timeoutMs: { type: "number", description: "waitFor/target timeout, default 10000" },
        value: { type: "string", description: "Text for fill/type/selectOption, key for press" },
        values: { type: "array", items: { type: "string" }, description: "selectOption values or labels" },
        checked: { type: "boolean", description: "setChecked target state" },
        attribute: { type: "string", description: "Attribute name for action=attribute" },
        fn: { type: "string", description: "Function source for evaluate/evaluateAll: receives (element, arg)" },
        arg: { description: "Argument passed to evaluate/evaluateAll" },
        nth: { type: "number", description: "Match index, default 0" },
        nthFromEnd: { type: "number", description: "1 = last match" },
        limit: { type: "number", description: "Default 10, max 50" },
      },
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const action = String(args?.action || "list");
      const query = {
        selector: String(args?.selector || ""),
        role: String(args?.role || ""),
        name: String(args?.name || ""),
        text: String(args?.text || ""),
        placeholder: String(args?.placeholder || ""),
        testId: String(args?.testId || ""),
        hasText: String(args?.hasText || ""),
        hasNotText: String(args?.hasNotText || ""),
        visibleOnly: args?.visibleOnly === true,
        ...(typeof args?.nth === "number" ? { nth: args.nth } : {}),
        ...(typeof args?.nthFromEnd === "number" ? { nthFromEnd: args.nthFromEnd } : {}),
        limit: Math.max(1, Math.min(50, Number(args?.limit) || 10)),
        sessionId,
      };
      const call = (extra = {}) => pi.browser.locator({ ...query, ...extra });
      const failResult = (result, fallback) => fail(String(result?.error || fallback), "Take a snapshot to inspect the page, or broaden the locator.", "browser_snapshot");

      if (action === "waitFor") {
        const state = ["attached", "detached", "visible", "hidden"].includes(String(args?.state)) ? String(args.state) : "visible";
        const timeout = Math.max(100, Math.min(30000, Number(args?.timeoutMs) || 10000));
        const deadline = Date.now() + timeout;
        for (;;) {
          const listed = await call({ action: "list" });
          if (!listed || listed.ok === false) return failResult(listed, "Locator failed.");
          const match = listed.matches && listed.matches[0];
          const attached = Boolean(match);
          const visible = Boolean(match && match.visible);
          if ((state === "attached" && attached) || (state === "detached" && !attached) || (state === "visible" && visible) || (state === "hidden" && !visible)) {
            return { ok: true, action, state, count: listed.count || 0, matches: listed.matches || [] };
          }
          if (Date.now() >= deadline) return fail(`locator did not become ${state} in ${timeout}ms`, "Broaden the filters or increase timeoutMs.", "browser_locator");
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }

      if (action === "click" || action === "dblclick" || action === "hover") {
        const listed = await call({ action: "list" });
        if (!listed || listed.ok === false) return failResult(listed, "Locator failed.");
        const match = listed.matches && listed.matches[0];
        if (!match) return fail("Locator matched no element.", "Broaden the selector or take a snapshot.", "browser_snapshot");
        if (!match.visible) return fail("Matched element is not visible.", "Scroll it into view or choose another match.", "browser_snapshot");
        const x = match.box.x + match.box.width / 2;
        const y = match.box.y + match.box.height / 2;
        if (action === "hover") {
          await pi.browser.inputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y), sessionId });
          return { ok: true, action, ref: match.ref, x: Math.round(x), y: Math.round(y), count: listed.count, matches: listed.matches };
        }
        await mouseClick(sessionId, x, y, { doubleClick: action === "dblclick" });
        return { ok: true, action, ref: match.ref, x: Math.round(x), y: Math.round(y), count: listed.count, matches: listed.matches };
      }

      if (action === "press" || action === "pressSequentially") {
        const focused = await call({ action: "focus" });
        if (!focused || focused.ok === false) return failResult(focused, "could not focus element");
        if (action === "press") {
          const key = String(args?.value ?? "");
          await pi.browser.inputEvent({ type: "keyDown", keyCode: key, sessionId });
          await pi.browser.inputEvent({ type: "keyUp", keyCode: key, sessionId });
          return { ok: true, action, count: focused.count || 0 };
        }
        for (const char of String(args?.value ?? "")) await pi.browser.insertText({ text: char, sessionId });
        return { ok: true, action, count: focused.count || 0 };
      }

      if (action === "downloadMedia") {
        const media = await call({ action: "mediaUrl" });
        if (!media || media.ok === false || !media.value) return fail("Matched element has no media URL.", "Check the element or use browser_download with a URL.", "browser_download");
        const saved = await pi.browser.downloadUrl({ url: String(media.value), sessionId });
        return { ok: true, action, url: media.value, ...(saved || {}) };
      }

      const pass = { action };
      if (["fill", "type"].includes(action)) pass.value = String(args?.value ?? "");
      if (action === "selectOption") pass.values = Array.isArray(args?.values) ? args.values.map(String) : [String(args?.value ?? "")];
      if (action === "setChecked") pass.checked = args?.checked !== false;
      if (action === "attribute") pass.attribute = String(args?.attribute ?? "");
      if (action === "evaluate" || action === "evaluateAll") {
        if (typeof args?.fn !== "string" || !args.fn.trim()) return fail("evaluate requires fn.", "Pass a function body or arrow function source.", "browser_locator");
        pass.fn = args.fn;
        pass.arg = args.arg;
      }
      const result = await call(pass);
      if (!result) return fail("Locator returned no result.", "Take a snapshot to inspect the page.", "browser_snapshot");
      return { ok: result.ok !== false, action, ...result };
    },
  },
  {
    name: "browser_frame",
    planSafeActions: ["list", "text"],
    description: "List iframes, read same-origin iframe content, and interact with same-origin frame elements by selector. Cross-origin frames are listed but never read or driven.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "text", "html", "click", "fill"], description: "Default list" },
        index: { type: "number", description: "Frame index from action=list" },
        selector: { type: "string", description: "CSS selector for the iframe" },
        limit: { type: "number", description: "Max characters for text/html, default 8000" },
        targetSelector: { type: "string", description: "Element inside the frame for click/fill" },
        value: { type: "string", description: "Text for fill" },
        crossOrigin: { type: "boolean", description: "Use CDP for a cross-origin frame (list/text/html/click/fill)" },
        frameId: { type: "string", description: "Cross-origin frame id from action=list" },
      },
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const action = String(args?.action || "list");
      if (args?.crossOrigin === true) {
        return await pi.browser.crossOriginFrame({
          sessionId,
          action,
          ...(args?.frameId ? { frameId: String(args.frameId) } : {}),
          ...(args?.url ? { url: String(args.url) } : {}),
          ...(args?.targetSelector ? { targetSelector: String(args.targetSelector) } : {}),
          ...(typeof args?.value === "string" ? { value: args.value } : {}),
          ...(typeof args?.limit === "number" ? { limit: args.limit } : {}),
        });
      }
      const index = Number.isFinite(Number(args?.index)) ? Math.trunc(Number(args.index)) : -1;
      const selector = String(args?.selector || "");
      const limit = Math.max(200, Math.min(30000, Number(args?.limit) || 8000));
      const result = await runPage(
        sessionId,
        `
        const action = ${JSON.stringify(action)};
        const index = ${JSON.stringify(index)};
        const selector = ${JSON.stringify(selector)};
        const limit = ${JSON.stringify(limit)};
        const nodes = Array.from(document.querySelectorAll('iframe, frame'));
        const frames = nodes.map(function(node, i) {
          let doc = null;
          try { doc = node.contentDocument; } catch (e) { doc = null; }
          let url = '';
          try { url = doc ? doc.location.href : new URL(node.getAttribute('src') || '', location.href).href; } catch (e) { url = node.getAttribute('src') || ''; }
          return { index: i, name: node.getAttribute('name') || '', src: node.getAttribute('src') || '', url, sameOrigin: !!doc };
        });
        if (action === 'list') return { ok: true, frames };
        const node = selector ? document.querySelector(selector) : nodes[index];
        if (!node) return { ok: false, error: 'Frame not found', frames };
        if (!/^(iframe|frame)$/i.test(node.tagName)) return { ok: false, error: 'Selector is not an iframe', frames };
        let doc = null;
        try { doc = node.contentDocument; } catch (e) { doc = null; }
        if (!doc) return { ok: false, error: 'Cross-origin frame content is not readable', frames };
        if (action === 'text') return { ok: true, url: doc.location.href, text: String(doc.body ? doc.body.innerText : '').slice(0, limit), frames };
        if (action === 'html') return { ok: true, url: doc.location.href, html: String(doc.documentElement ? doc.documentElement.outerHTML : '').slice(0, limit), frames };
        const targetSelector = ${JSON.stringify(String(args?.targetSelector || ""))};
        const target = targetSelector ? doc.querySelector(targetSelector) : null;
        if (!target) return { ok: false, error: 'Frame target not found', frames };
        target.scrollIntoView({ block: 'center', inline: 'center' });
        if (action === 'fill') {
          target.focus({ preventScroll: true });
          if ('value' in target) {
            target.value = ${JSON.stringify(String(args?.value || ""))};
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            target.textContent = ${JSON.stringify(String(args?.value || ""))};
            target.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return { ok: true, url: doc.location.href, value: ('value' in target ? target.value : target.textContent), frames };
        }
        const frameRect = node.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        return {
          ok: true,
          url: doc.location.href,
          x: frameRect.left + targetRect.left + targetRect.width / 2,
          y: frameRect.top + targetRect.top + targetRect.height / 2,
          frames,
        };
        `,
      );
      if (!result || result.ok === false) {
        return fail((result && result.error) || "Frame read failed.", "Check whether the frame is cross-origin.", "browser_frame");
      }
      if (action === "click") {
        await mouseClick(sessionId, Number(result.x), Number(result.y));
        return { ok: true, action, x: Math.round(Number(result.x)), y: Math.round(Number(result.y)), url: result.url, frames: result.frames };
      }
      return result;
    },
  },
  {
    name: "browser_upload_file",
    description: "Set absolute local files on an input[type=file] inside the current session workspace. Files outside the session roots are rejected by the host.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the file input (default input[type=file])" },
        triggerRef: { type: "string", description: "Snapshot ref that opens a file chooser" },
        triggerSelector: { type: "string", description: "CSS selector that opens a file chooser" },
        timeoutMs: { type: "number", description: "File chooser timeout, default 15000" },
        files: { type: "array", items: { type: "string" }, minItems: 1 },
        cancel: { type: "boolean", description: "Dismiss the intercepted file chooser without selecting files" },
      },
      required: [],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      if (args?.cancel === true) {
        await pi.browser.cancelFileChooser({ sessionId });
        return { ok: true, cancelled: true };
      }
      const files = Array.isArray(args?.files) ? args.files.map(String) : [];
      if (!files.length) return fail("browser_upload_file requires files, or cancel:true.", "Pass at least one absolute file path.", "browser_upload_file");
      const triggerRef = String(args?.triggerRef || "");
      const triggerSelector = String(args?.triggerSelector || "");
      if (triggerRef || triggerSelector) {
        const timeoutMs = Math.max(1000, Number(args?.timeoutMs) || 15_000);
        const chooser = pi.browser.waitForFileChooser({ sessionId, timeoutMs });
        chooser.catch(() => undefined);
        const point = await runPage(
          sessionId,
          `
          const ref = ${JSON.stringify(triggerRef)};
          const selector = ${JSON.stringify(triggerSelector)};
          const el = ref ? piFindRef(ref) : piDeepQuery(selector);
          if (!el) return { ok: false, error: 'Trigger not found' };
          piScrollIntoView(el);
          const r = el.getBoundingClientRect();
          return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
          `,
        );
        if (!point || point.ok === false) {
          return fail((point && point.error) || "Trigger not found.", "Take a snapshot and retry with a valid ref.", "browser_snapshot");
        }
        await mouseClick(sessionId, point.x, point.y);
        try {
          await chooser;
        } catch (error) {
          return fail(
            String(error?.message || error),
            "Click the control that opens the file chooser, or pass the input selector directly.",
            "browser_snapshot",
          );
        }
        return await pi.browser.setFileChooserFiles({ sessionId, files });
      }
      return await pi.browser.uploadFiles({
        sessionId,
        selector: String(args?.selector || "input[type=file]"),
        files,
      });
    },
  },
  {
    name: "browser_download",
    planSafeActions: ["*"],
    description: "Download an http(s) resource, or the src/href of a local element, into the session scratch directory. Returns the saved path.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL" },
        ref: { type: "string", description: "Snapshot ref whose src/href should be downloaded" },
        selector: { type: "string", description: "CSS selector whose src/href should be downloaded" },
        filename: { type: "string", description: "Optional file name inside scratch" },
        waitForDownload: { type: "boolean", description: "Click ref and wait for the browser download event" },
        timeoutMs: { type: "number", description: "Download event timeout, default 30000" },
      },
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      if (args?.waitForDownload === true) {
        const ref = String(args?.ref || "");
        if (!ref) return fail("waitForDownload requires a snapshot ref.", "Take a snapshot and pass the download control ref.", "browser_snapshot");
        return {
          ok: true,
          ...(await pi.browser.clickAndWaitForDownload({
            sessionId,
            ref,
            ...(typeof args?.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
          })),
        };
      }
      let url = String(args?.url || "").trim();
      if (!url) {
        const query = args?.ref ? { ref: String(args.ref) } : { selector: String(args?.selector || "") };
        const resolved = await runPage(
          sessionId,
          `
          const ref = ${JSON.stringify(query.ref || "")};
          const selector = ${JSON.stringify(query.selector || "")};
          const node = ref ? piFindRef(ref) : (selector ? piDeepQuery(selector) : null);
          if (!node) return { ok: false, error: 'Element not found' };
          return { ok: true, url: String(node.currentSrc || node.src || node.href || '') };
          `,
        );
        if (!resolved || resolved.ok === false) {
          return fail(
            (resolved && resolved.error) || "Element not found.",
            "Pass an explicit url, or snapshot first and use the element ref.",
            "browser_snapshot",
          );
        }
        url = String(resolved.url || "");
      }
      if (!/^https?:\/\//i.test(url)) {
        return fail("Only http(s) resources can be downloaded.", "Open the page or pass an absolute https:// URL.", "browser_navigate");
      }
      return await pi.browser.downloadUrl({
        sessionId,
        url,
        ...(args?.filename ? { filename: String(args.filename) } : {}),
      });
    },
  },
  {
    name: "browser_evaluate",
    planSafeActions: ["*"],
    description: "Evaluate a read-only JavaScript expression in the current page's isolated automation world. Use this for DOM inspection; use structured browser actions for interaction.",
    risk: "medium",
    schema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const expression = String(args?.expression || "null");
      const body = /\breturn\b/.test(expression) ? expression : `return (${expression});`;
      return { ok: true, value: await runPage(sessionId, body, false) };
    },
  },
  {
    name: "browser_content",
    planSafeActions: ["*"],
    description: "Export the current page content as text or HTML. Read-only; use a CSS selector to scope the export.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Optional CSS selector" },
        format: { type: "string", enum: ["text", "html"], description: "Default: text" },
      },
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const selector = String(args?.selector || "").trim();
      const format = String(args?.format || "text") === "html" ? "html" : "text";
      const value = await runPage(
        sessionId,
        `
        const selector = ${JSON.stringify(selector)};
        const node = selector ? document.querySelector(selector) : document.documentElement;
        if (!node) return { ok: false, error: 'selector not found' };
        return {
          ok: true,
          url: location.href,
          title: document.title,
          format: ${JSON.stringify(format)},
          text: ${JSON.stringify(format)} === 'html' ? node.outerHTML : (node.innerText || node.textContent || ''),
        };
        `,
      );
      if (!value || value.ok === false) return fail(value?.error || "Could not export page content.");
      return value;
    },
  },
  {
    name: "browser_dom",
    planSafeActions: ["visibleDom"],
    description: "DOM-level interaction with stable node ids: read a filtered visible DOM, then click/double-click/scroll/type/keypress/download a node without screenshots or coordinates. Use it when accessibility snapshots miss a control or coordinates are unreliable.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["visibleDom", "click", "doubleClick", "scroll", "type", "keypress", "downloadMedia"], description: "Default visibleDom" },
        nodeId: { type: "string", description: "Node id from action=visibleDom (e.g. d12)" },
        text: { type: "string", description: "Text for action=type" },
        keys: { type: "array", items: { type: "string" }, description: "Keys for action=keypress" },
        deltaX: { type: "number", description: "Horizontal scroll delta" },
        deltaY: { type: "number", description: "Vertical scroll delta" },
      },
      required: ["action"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const action = String(args?.action || "visibleDom");
      if (action !== "visibleDom" && !args?.nodeId && action !== "keypress") {
        return fail(`${action} requires nodeId from visibleDom.`, "Run action=visibleDom first.", "browser_dom");
      }
      const result = await pi.browser.domAction({
        action,
        ...(args?.nodeId ? { nodeId: String(args.nodeId) } : {}),
        ...(typeof args?.text === "string" ? { text: args.text } : {}),
        ...(Array.isArray(args?.keys) ? { keys: args.keys.map(String) } : {}),
        ...(typeof args?.deltaX === "number" ? { deltaX: args.deltaX } : {}),
        ...(typeof args?.deltaY === "number" ? { deltaY: args.deltaY } : {}),
        sessionId,
      });
      return { ok: true, action, ...(result || {}) };
    },
  },
  {
    name: "browser_webmcp_list",
    planSafeActions: ["*"],
    description: "List WebMCP tools exposed by the current document via document.modelContext / navigator.modelContext.",
    risk: "low",
    schema: {
      type: "object",
      properties: { fromOrigins: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const fromOrigins = Array.isArray(args?.fromOrigins) ? args.fromOrigins.map(String) : undefined;
      return await runPage(
        sessionId,
        `
        const mc = document.modelContext || navigator.modelContext;
        const testing = navigator.modelContextTesting;
        if (!mc && !testing) return { supported: false, tools: [] };
        const tools = mc
          ? await mc.getTools(${JSON.stringify(fromOrigins ? { fromOrigins } : {})})
          : await testing.listTools();
        return {
          supported: true,
          tools: (tools || []).map((tool) => ({
            name: String(tool.name || ''),
            title: tool.title ? String(tool.title) : undefined,
            description: tool.description ? String(tool.description) : undefined,
            inputSchema: tool.inputSchema ?? null,
            origin: tool.origin ? String(tool.origin) : undefined,
          })),
        };
        `,
      );
    },
  },
  {
    name: "browser_webmcp_call",
    description: "Execute one WebMCP tool exposed by the current document.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        input: { type: "object" },
        fromOrigins: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const name = String(args?.name || "").trim();
      if (!name) return fail("browser_webmcp_call requires a tool name.");
      const input = args?.input && typeof args.input === "object" ? args.input : {};
      const fromOrigins = Array.isArray(args?.fromOrigins) ? args.fromOrigins.map(String) : undefined;
      return await runPage(
        sessionId,
        `
        const name = ${JSON.stringify(name)};
        const input = ${JSON.stringify(input)};
        const mc = document.modelContext || navigator.modelContext;
        const testing = navigator.modelContextTesting;
        if (!mc && !testing) return { ok: false, error: 'WebMCP is not available on this page' };
        if (testing && !mc) {
          const result = await testing.executeTool(name, input);
          return { ok: true, result };
        }
        const tools = await mc.getTools(${JSON.stringify(fromOrigins ? { fromOrigins } : {})});
        const tool = (tools || []).find((candidate) => String(candidate.name) === name);
        if (!tool) return { ok: false, error: 'tool not found: ' + name };
        const result = await mc.executeTool(tool, input);
        return { ok: true, result };
        `,
      );
    },
  },
  {
    name: "browser_history",
    planSafeActions: ["*"],
    description: "Read navigation history, optionally bounded by time and keywords.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO timestamp or epoch milliseconds lower bound" },
        queries: { type: "array", items: { type: "string" }, description: "Only entries whose URL or title contains one of these" },
        limit: { type: "number", description: "Default 100, max 500" },
      },
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      return await pi.browser.history({
        ...(args?.from !== undefined ? { from: args.from } : {}),
        ...(Array.isArray(args?.queries) ? { queries: args.queries.map(String) } : {}),
        ...(typeof args?.limit === "number" ? { limit: args.limit } : {}),
      });
    },
  },
  {
    name: "browser_cdp",
    description:
      "Send a raw CDP command. CDP Input.* is denied here — use browser_click/type/press_key/scroll/drag instead. Large responses are truncated to " + MAX_CDP_CHARS + " characters.",
    schema: {
      type: "object",
      properties: {
        method: { type: "string" },
        params: { type: "object" },
      },
      required: ["method"],
    },
    execute: async (args, ctx) => {
      const sessionId = sessionOf(ctx);
      const method = String(args?.method || "").trim();
      if (/^Input\./i.test(method)) {
        return fail(
          `CDP ${method} is denied for focus safety.`,
          "Use browser_click, browser_type, browser_press_key, browser_scroll, or browser_drag.",
          "browser_snapshot",
        );
      }
      const guard = await guardPage(sessionId);
      if (guard.error) return guard.error;
      const value = await pi.browser.cdp({ sessionId, method, params: args?.params || {} });
      if (value && typeof value.savedTo === "string") {
        return { ok: true, method, ...value };
      }
      const serialized = JSON.stringify(value ?? null);
      if (method === "Profiler.stop" || (serialized && serialized.length > MAX_CDP_CHARS)) {
        try {
          const dir = join(await pluginDataDir(), "browser-logs");
          await mkdir(dir, { recursive: true });
          const file = join(dir, method === "Profiler.stop" ? `profile-${Date.now()}.json` : `cdp-${Date.now()}.json`);
          await writeFile(file, serialized ?? "null", "utf8");
          const sizeBytes = Buffer.byteLength(serialized ?? "");
          return {
            ok: true,
            method,
            savedTo: file,
            log_file: { path: file, sizeBytes },
            sizeBytes,
            preview: (serialized || "").slice(0, 2000),
          };
        } catch {
          return { ok: true, truncated: true, method, value: (serialized || "").slice(0, MAX_CDP_CHARS) };
        }
      }
      return { ok: true, method, value };
    },
  },
];

async function typeInto(args, ctx, mode) {
  const sessionId = sessionOf(ctx);
  const guard = await guardPage(sessionId);
  if (guard.error) return guard.error;
  const ref = String(args?.ref || "");
  const text = String(args?.text ?? "");
  const element = String(args?.element || "");
  const clear = args?.clear === true || mode === "fill";
  const submit = args?.submit === true;
  const slowly = args?.slowly === true;
  const prepared = await runPage(
    sessionId,
    `
    const ref = ${JSON.stringify(ref)};
    const expected = ${JSON.stringify(element)};
    const mode = ${JSON.stringify(mode)};
    const clear = ${clear === true};
    let el = piFindRef(ref);
    let recovered = false;
    if (!el && expected) {
      const needle = expected.replace(/\s+/g, ' ').trim().toLowerCase();
      el = piAll(document.body || document.documentElement, []).find(function(node) {
        if (!piVisible(node)) return false;
        const name = piName(node).replace(/\s+/g, ' ').trim().toLowerCase();
        return name && (name === needle || name.indexOf(needle) >= 0);
      }) || null;
      recovered = !!el;
    }
    if (!el) return { ok: false, error: 'Element not found: ' + ref, suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
    piScrollIntoView(el);
    try { el.focus({ preventScroll: true }); } catch (e) {}
    const tag = el.tagName.toLowerCase();
    const editable = el.isContentEditable || tag === 'textarea' || tag === 'input';
    if (!editable) return { ok: false, error: 'Element is not a text input', suggestion: 'Use browser_snapshot to find an input.', recovery: 'browser_snapshot' };
    if (clear) {
      if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      } else if (typeof el.select === 'function') {
        el.select();
      }
    } else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = window.getSelection();
      if (selection) { selection.removeAllRanges(); selection.addRange(range); }
    } else if (typeof el.setSelectionRange === 'function') {
      const end = String(el.value || '').length;
      try { el.setSelectionRange(end, end); } catch (e) {}
    }
    const finalRef = piRefOf(el) || ref;
    return { ok: true, ref: finalRef, refRecovered: recovered, mode: mode };
    `,
  );
  if (!prepared || prepared.ok !== true) return prepared;
  // insertText path is native: trusted input, no debugger attachment.
  if (slowly && text.length > 1) {
    for (const char of text) {
      await pi.browser.insertText(char);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  } else {
    await pi.browser.insertText(text);
  }
  if (submit) {
    await pi.browser.inputEvent({ type: "keyDown", keyCode: "Return" });
    await pi.browser.inputEvent({ type: "keyUp", keyCode: "Return" });
  }
  return prepared;
}

async function takeScreenshot(sessionId, options) {
  const format = options?.type === "png" ? "png" : "jpeg";
  if (options?.ref) {
    const box = await runPage(
      sessionId,
      `
      const ref = ${JSON.stringify(String(options.ref))};
      const el = piFindRef(ref);
      if (!el) return { ok: false, error: 'Element not found: ' + ref, suggestion: 'Take a snapshot.', recovery: 'browser_snapshot' };
      piScrollIntoView(el);
      await piFrame();
      const r = el.getBoundingClientRect();
      return { ok: true, clip: { x: r.left, y: r.top, width: r.width, height: r.height } };
      `,
    );
    if (!box.ok) return box;
    const clip = box.clip;
    if (!clip.width || !clip.height) return fail("Element has no visible box.", "Take a snapshot.", "browser_snapshot");
    const shot = await pi.browser.cdp({
      sessionId,
      method: "Page.captureScreenshot",
      params: {
        format,
        ...(format === "jpeg" ? { quality: 70 } : {}),
        clip: { ...clip, scale: 1 },
        captureBeyondViewport: true,
      },
    });
    if (!shot || typeof shot.data !== "string") return fail("Screenshot produced no data.", "Retry after the page settles.", "browser_take_screenshot");
    const mimeType = format === "png" ? "image/png" : "image/jpeg";
    const saved = await saveScreenshotCopy(options?.filename, shot.data);
    return {
      ok: true,
      mimeType,
      ...(saved ? { path: saved } : {}),
      images: [{ mimeType, data: shot.data }],
      clip,
    };
  }
  if (options?.clip) {
    const clip = {
      x: Math.max(0, Math.round(Number(options.clip.x) || 0)),
      y: Math.max(0, Math.round(Number(options.clip.y) || 0)),
      width: Math.max(1, Math.round(Number(options.clip.width) || 1)),
      height: Math.max(1, Math.round(Number(options.clip.height) || 1)),
    };
    const shot = await pi.browser.screenshot({ sessionId, clip, format });
    if (!shot || typeof shot.data !== "string") return fail("Screenshot produced no data.", "Retry after the page settles.", "browser_take_screenshot");
    const saved = await saveScreenshotCopy(options?.filename, shot.data);
    return {
      ok: true,
      mimeType: shot.mimeType,
      ...(saved ? { path: saved } : {}),
      images: [{ mimeType: shot.mimeType, data: shot.data }],
      clip,
    };
  }
  const page = await readPageState(sessionId);
  const shot = await pi.browser.screenshot({ sessionId, fullPage: options?.fullPage === true, format });
  if (!shot || typeof shot.data !== "string") return fail("Screenshot produced no data.", "Retry after the page settles.", "browser_take_screenshot");
  SCREENSHOT_MEMORY.set(sessionId || "default", {
    url: page.url,
    viewportWidth: page.viewport.width,
    viewportHeight: page.viewport.height,
    imageWidth: shot.width || page.viewport.width,
    imageHeight: shot.height || page.viewport.height,
    takenAt: Date.now(),
  });
  const saved = await saveScreenshotCopy(options?.filename, shot.data);
  return {
    ok: true,
    mimeType: shot.mimeType,
    ...(saved ? { path: saved } : {}),
    images: [{ mimeType: shot.mimeType, data: shot.data }],
    pageState: page,
  };
}

/** Copies stay inside the plugin data dir so a filename can never escape it. */
async function saveScreenshotCopy(filename, data) {
  if (!filename || typeof data !== "string") return "";
  const name = basename(String(filename)).replace(/[^a-zA-Z0-9._-]/g, "_") || "screenshot.jpg";
  const target = join(await pluginDataDir(), name);
  await writeFile(target, Buffer.from(data, "base64"));
  return target;
}

let telemetryPath = null;

async function pluginDataDir() {
  const dataPath = await pi.plugin.getDataPath();
  await mkdir(dataPath, { recursive: true });
  return dataPath;
}

async function telemetryLogPath() {
  if (!telemetryPath) telemetryPath = join(await pluginDataDir(), "browser-telemetry.jsonl");
  return telemetryPath;
}

async function recordTelemetry(tool, args, result, startedAt, ctx) {
  try {
    const telemetryPath = await telemetryLogPath();
    const ok = !(result && result.ok === false);
    const error = ok ? null : String((result && result.error && result.error.message) || "failed").slice(0, 500);
    const entry = {
      ts: new Date().toISOString(),
      tool,
      ok,
      durationMs: Date.now() - startedAt,
      sessionId: sessionOf(ctx) || null,
      error,
      suggestion: ok ? null : String((result && result.error && result.error.suggestion) || "").slice(0, 300),
      args: JSON.stringify(args ?? {}).slice(0, 500),
    };
    await appendFile(telemetryPath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Telemetry must never change a tool outcome.
  }
}

const PAGE_STATE_TOOLS = new Set([
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_scroll",
  "browser_drag",
  "browser_hover",
  "browser_highlight",
  "browser_get_bounding_box",
]);

const SHOT_EXCLUDED = new Set([
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_tabs",
  "browser_capabilities",
  "browser_lock",
  "browser_telemetry",
]);

export async function onLoad() {
  for (const tool of TOOLS) {
    if (!SHOT_EXCLUDED.has(tool.name) && tool.schema && tool.schema.properties) {
      tool.schema.properties.take_screenshot_afterwards = {
        type: "boolean",
        description: "Attach a screenshot of the page after this action succeeds",
      };
    }
  }
  const snapshotTool = TOOLS.find((tool) => tool.name === "browser_snapshot");
  for (const tool of TOOLS) {
    await pi.agent.registerTool({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      schema: tool.schema,
      ...(tool.planSafeActions ? { planSafeActions: tool.planSafeActions } : {}),
      execute: async (args, ctx) => {
        const startedAt = Date.now();
        const sessionId = sessionOf(ctx);
        try {
          // Cursor refreshes a stale snapshot before a ref-based action; refs
          // are positional, so an unchanged DOM keeps the same eN mapping.
          if (REF_TOOLS.has(tool.name) && snapshotTool) {
            const cached = SNAPSHOT_CACHE.get(sessionId || "default");
            if (!cached || Date.now() - cached.at > 10_000) {
              await snapshotTool.execute({ compact: false }, ctx).catch(() => undefined);
            }
          }
          let result = await tool.execute(args, ctx);
          // Cursor returns pageState with every action result.
          if (
            result &&
            result.ok !== false &&
            !result.pageState &&
            PAGE_STATE_TOOLS.has(tool.name)
          ) {
            result.pageState = await readPageState(sessionId).catch(() => undefined);
          }
          // Cursor retries once with a fresh snapshot when a ref went stale.
          if (
            result &&
            result.ok === false &&
            REF_TOOLS.has(tool.name) &&
            result.error &&
            result.error.recovery === "browser_snapshot" &&
            snapshotTool &&
            (args?.ref || args?.sourceRef)
          ) {
            await snapshotTool.execute({ compact: false }, ctx).catch(() => undefined);
            result = await tool.execute(args, ctx);
          }
          // Cursor backfills a fresh snapshot when an action failed on a stale
          // ref; hand the model the new refs instead of another round trip.
          if (
            result &&
            result.ok === false &&
            REF_TOOLS.has(tool.name) &&
            result.error &&
            result.error.recovery === "browser_snapshot" &&
            snapshotTool
          ) {
            const backfill = await snapshotTool.execute({ compact: true }, ctx).catch(() => null);
            if (backfill && backfill.ok) {
              result.snapshotBackfill = {
                url: backfill.url,
                count: backfill.count,
                tree: String(backfill.tree || "").slice(0, 4000),
              };
            }
          }
          if (
            args &&
            args.take_screenshot_afterwards === true &&
            result &&
            !SHOT_EXCLUDED.has(tool.name) &&
            !result.screenshot
          ) {
            try {
              result.screenshot = await takeScreenshot(sessionId, {});
            } catch {
              // A screenshot failure must not turn a successful action into one.
            }
          }
          await recordTelemetry(tool.name, args, result, startedAt, ctx);
          return result;
        } catch (error) {
          const message = String(error?.message || error);
          await recordTelemetry(tool.name, args, { ok: false, error: { message } }, startedAt, ctx);
          if (/destroyed|detached|render frame|target closed|no page|not attached|webcontents/i.test(message)) {
            return fail(
              "Browser page is detached or unresponsive: " + message,
              "Call browser_navigate to recreate the page, then take a snapshot.",
              "browser_navigate",
            );
          }
          throw error;
        }
      },
    });
  }
}

export async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    case "app.getAppearance":
      return pi.app.getAppearance();
    case "browser.setBounds":
      return pi.browser.setBounds(payload);
    case "browser.setVisible":
      return pi.browser.setVisible(payload?.visible === true || payload === true);
    case "browser.navigate":
      return pi.browser.navigate({ url: payload?.url });
    case "browser.action":
      return pi.browser.action({ action: payload?.action });
    case "browser.openExternal":
      return pi.browser.openExternal();
    case "browser.getState":
      return pi.browser.getState();
    case "browser.downloads":
      return pi.browser.downloads();
    case "browser.cancelDownload":
      return pi.browser.cancelDownload(String(payload?.id ?? payload ?? ""));
    case "browser.cancelFileChooser":
      return pi.browser.cancelFileChooser();
    default:
      throw new Error(`unknown browser view channel: ${channel}`);
  }
}

export async function onUnload() {
  for (const tool of TOOLS) {
    await pi.agent.unregisterTool(tool.name);
  }
}
