const PREFIX = 'local.market-translator.v1';
const SELECTOR = '.sklm-card .sklm-name, .sklm-card .sklm-desc, .mcpm-card .mcpm-name, .mcpm-card .mcpm-desc, .sklm-sheet .ext-sheet-title, .sklm-sheet .ext-sheet-sub, .mcpm-sheet .ext-sheet-title, .mcpm-sheet .ext-sheet-sub, .mcpm-sheet .mcpm-note';
const PREVIEW = '.sklm-preview';
const LISTS = '.sklm-list, .mcpm-list';
const SCOPE = '.sklm-list, .mcpm-list, .sklm-sheet, .mcpm-sheet';
const OWN = '[data-market-translator]';
const TEXT_MARK = 'data-market-translator-text';
const CSS = `
[data-market-translator="bar"] { display:flex; align-items:center; justify-content:flex-end; gap:10px; padding:2px 2px 12px; font:inherit; font-size:12px; line-height:1.4; }
[data-market-translator="bar"] .mt-quiet { font:inherit; font-size:12px; color:inherit; opacity:.66; background:none; border:0; padding:4px 2px; border-radius:6px; cursor:pointer; }
[data-market-translator="bar"] .mt-quiet:hover { opacity:1; text-decoration:underline; text-underline-offset:3px; }
[data-market-translator="bar"] .mt-quiet:focus-visible { outline:2px solid #8b5cf6aa; outline-offset:3px; }
[data-market-translator="bar"] .mt-state { opacity:.6; }
[data-market-translator="switch"] { display:inline-flex; align-items:center; gap:8px; font:inherit; font-size:12px; color:inherit; background:none; border:0; padding:4px 2px; border-radius:6px; cursor:pointer; }
[data-market-translator="switch"] .mt-track { position:relative; flex:none; width:30px; height:18px; border-radius:999px; background:color-mix(in oklab, currentColor 20%, transparent); transition:background 160ms ease; }
[data-market-translator="switch"] .mt-thumb { position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:999px; background:color-mix(in oklab, currentColor 88%, transparent); transition:transform 160ms ease, background 160ms ease; }
[data-market-translator="switch"][aria-checked="true"] .mt-track { background:#8b5cf6; }
[data-market-translator="switch"][aria-checked="true"] .mt-thumb { transform:translateX(12px); background:#fff; }
[data-market-translator="switch"]:focus-visible { outline:2px solid #8b5cf6aa; outline-offset:3px; }
[${TEXT_MARK}] { font:inherit; }
[data-market-translator="overlay"] { position:fixed; inset:0; z-index:2147483000; display:flex; align-items:center; justify-content:center; padding:24px; background:rgba(8,8,12,.42); }
[data-market-translator="dialog"] { width:min(432px, 100%); max-height:calc(100dvh - 72px); overflow:auto; padding:18px 18px 14px; border-radius:14px; background:var(--mt-surface); color:var(--mt-fg); border:1px solid var(--mt-border); box-shadow:0 18px 48px rgba(0,0,0,.4); font-family:inherit; font-size:13px; line-height:1.55; text-align:left; }
[data-market-translator="dialog"] .mt-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:16px; }
[data-market-translator="dialog"] h2 { margin:0; font-size:14px; font-weight:600; letter-spacing:0; }
[data-market-translator="dialog"] .mt-sub { margin:2px 0 0; font-size:12px; color:var(--mt-muted); }
[data-market-translator="dialog"] .mt-close { flex:none; width:26px; height:26px; padding:0; font:inherit; font-size:16px; line-height:1; border-radius:7px; color:var(--mt-muted); background:none; border:1px solid transparent; cursor:pointer; }
[data-market-translator="dialog"] .mt-close:hover { color:var(--mt-fg); border-color:var(--mt-border); }
[data-market-translator="dialog"] .mt-row { display:grid; gap:6px; margin-bottom:14px; }
[data-market-translator="dialog"] .mt-row-inline { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
[data-market-translator="dialog"] .mt-label { font-size:12px; color:var(--mt-muted); }
[data-market-translator="dialog"] select { width:100%; padding:8px 10px; font:inherit; font-size:13px; color:var(--mt-fg); background:var(--mt-field); border:1px solid var(--mt-border); border-radius:8px; }
[data-market-translator="dialog"] select:focus-visible { outline:2px solid #8b5cf6aa; outline-offset:1px; }
[data-market-translator="dialog"] .mt-note { margin:0; font-size:12px; line-height:1.6; color:var(--mt-muted); }
[data-market-translator="dialog"] .mt-hint { margin:-4px 0 16px; padding-left:10px; border-left:2px solid var(--mt-border); font-size:12px; line-height:1.6; color:var(--mt-muted); }
[data-market-translator="dialog"] .mt-alert { margin:0; font-size:12px; line-height:1.6; color:#f0a4a4; }
[data-market-translator="dialog"] .mt-actions { display:flex; align-items:center; gap:8px; margin-top:14px; padding-top:13px; border-top:1px solid var(--mt-border); }
[data-market-translator="dialog"] .mt-actions .mt-btn:last-child { margin-left:auto; }
[data-market-translator="dialog"] .mt-btn { padding:7px 12px; font:inherit; font-size:12px; white-space:nowrap; border-radius:8px; border:1px solid var(--mt-border); background:var(--mt-field); color:var(--mt-fg); cursor:pointer; }
[data-market-translator="dialog"] .mt-btn:hover { border-color:color-mix(in oklab, var(--mt-fg) 28%, transparent); }
[data-market-translator="dialog"] select:focus-visible { outline:2px solid #8b5cf6aa; outline-offset:1px; }
[data-market-translator="dialog"] input { width:100%; padding:8px 10px; font:inherit; font-size:13px; color:var(--mt-fg); background:var(--mt-field); border:1px solid var(--mt-border); border-radius:8px; }
[data-market-translator="dialog"] input:focus-visible { outline:2px solid #8b5cf6aa; outline-offset:1px; }
[data-market-translator="dialog"] input::placeholder { color:var(--mt-muted); }
[data-market-translator="dialog"] .mt-limit, [data-market-translator="dialog"] select.mt-limit { width:auto; min-width:92px; padding:5px 8px; font-size:12px; }
[data-market-translator="dialog"] .mt-btn:focus-visible { outline:2px solid #8b5cf6aa; outline-offset:2px; }
[data-market-translator="dialog"] .mt-btn-primary { background:#8b5cf6; border-color:#8b5cf6; color:#fff; }
[data-market-translator="dialog"] .mt-btn-primary:hover { background:#7c4ff0; border-color:#7c4ff0; }
[data-market-translator="dialog"] .mt-count { margin:0 0 2px; font-size:12px; color:var(--mt-muted); }
[data-market-translator="dialog"] .mt-btn:disabled { opacity:.5; cursor:default; }
@media (prefers-reduced-motion: reduce) { [data-market-translator] *, [data-market-translator] { transition:none !important; } }
`;
let dispose;

export function onLoad(pi) {
  dispose?.();
  let alive = true, busy = false, modelsLoading = false, epoch = 0, timer, nextRequest = 0;
  let models = [], modelsLoaded = false, open = false, status = '', error = '', notice = '';
  const bars = new Map(), shown = new WeakMap(), touched = new Set(), sleepTimers = new Map();
  let overlay, dialog, dialogRefs;

  const get = (key, fallback) => { try { return JSON.parse(localStorage.getItem(PREFIX + key)) ?? fallback; } catch { return fallback; } };
  const set = (key, value) => { try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { notice = '本地缓存不可用，本次译文仅在当前页面生效'; } };
  const saved = get('.settings', {});
  const clampLimit = value => Math.min(2000, Math.max(50, Math.round(Number(value) || 500)));
  let enabled = saved.enabled === true, modelKey = typeof saved.modelKey === 'string' ? saved.modelKey : '';
  let limit = clampLimit(saved.limit), retranslate = saved.retranslate !== false;
  let googleKey = typeof saved.googleKey === 'string' ? saved.googleKey : '';
  let googleOn = saved.googleOn !== false;
  const GOOGLE = 'google';
  const googleReady = () => googleOn && googleKey.trim().length >= 20;
  const cache = new Map();
  const parseKey = raw => {
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string' ? { model: value[0], text: value[1] } : null;
    } catch { return null; }
  };
  const byText = new Map();
  const rebuildIndex = () => {
    byText.clear();
    for (const [raw, translation] of cache) { const parsed = parseKey(raw); if (parsed && parsed.model !== GOOGLE) byText.set(parsed.text, { model: parsed.model, translation }); }
  };
  const stored = get('.cache', []);
  if (Array.isArray(stored)) for (const row of stored.slice(-2000)) {
    if (Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && row[0].length <= 4500 && typeof row[1] === 'string' && row[1].length <= 8000) cache.set(...row);
  }
  rebuildIndex();
  const key = text => JSON.stringify([modelKey, text]);
  const save = () => set('.settings', { enabled, modelKey, limit, retranslate, googleKey, googleOn });
  const googleCached = text => cache.get(JSON.stringify([GOOGLE, text]));
  const lookup = text => cache.get(key(text)) ?? (retranslate ? null : byText.get(text)?.translation ?? null) ?? googleCached(text);
  const known = text => cache.has(key(text)) || (!retranslate && byText.has(text)) || Boolean(googleCached(text));
  const CHAR_BUDGET = 800000;
  const persistCache = () => {
    while (cache.size > limit) cache.delete(cache.keys().next().value);
    let chars = 0;
    for (const [raw, translation] of cache) chars += raw.length + translation.length;
    while (chars > CHAR_BUDGET && cache.size > 1) {
      const first = cache.keys().next().value;
      chars -= first.length + cache.get(first).length;
      cache.delete(first);
    }
    rebuildIndex();
    set('.cache', [...cache]);
  };
  const call = (method, args = {}) => pi.dispatch('plugin.call', { method, args });
  const wait = ms => new Promise(resolve => { const id = setTimeout(() => { sleepTimers.delete(id); resolve(); }, ms); sleepTimers.set(id, resolve); });
  const owns = node => (node.nodeType === 1 ? node : node.parentElement)?.closest?.(OWN);
  const visible = el => el.isConnected && el.getClientRects().length > 0 && !el.closest('[hidden], [aria-hidden="true"]');
  const eligible = text => text.length > 0 && text.length <= 4000 && /[A-Za-z]/.test(text) && !/[\u3400-\u9fff]/.test(text);
  const elements = () => [...document.querySelectorAll(SELECTOR)].filter(visible);
  const make = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };
  const tokenise = el => {
    const parts = []; let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) text += node.nodeValue;
      else if (node.nodeType === 1) {
        if (node.tagName === 'BR') { text += '\n'; continue; }
        parts.push(node.outerHTML);
        text += `〔${parts.length}〕`;
      }
    }
    return { text: text.trim(), parts };
  };
  const restoreTokens = (text, parts) => text.replace(/〔(\d+)〕/g, (all, index) => parts[Number(index) - 1] ?? '');
  const tokensIntact = (text, parts) => {
    const seen = new Set();
    for (const match of text.matchAll(/〔(\d+)〕/g)) {
      const index = Number(match[1]);
      if (!(index >= 1 && index <= parts.length) || seen.has(index)) return false;
      seen.add(index);
    }
    return parts.length === 0 ? !/〔\d+〕/.test(text) : seen.size === parts.length;
  };
  const MAX_BLOCK = 2600;
  function previewSegments(raw) {
    const chunks = [];
    let buffer = [], fence = false, bufferIsFence = false;
    const flush = () => { if (buffer.length) { chunks.push({ text: buffer.join('\n'), fence: bufferIsFence }); buffer = []; bufferIsFence = false; } };
    for (const line of raw.split('\n')) {
      if (/^\s*```/.test(line)) {
        fence = !fence;
        if (!buffer.length) bufferIsFence = fence;
        buffer.push(line);
        if (!fence) flush();
        continue;
      }
      if (fence) { buffer.push(line); continue; }
      if (!line.trim()) { flush(); chunks.push({ text: line, fence: false }); continue; }
      buffer.push(line);
    }
    flush();
    return chunks.map(chunk => {
      const translatable = !chunk.fence && chunk.text.trim().length > 0 && chunk.text.length <= MAX_BLOCK && /[A-Za-z]/.test(chunk.text) && !/[\u3400-\u9fff]/.test(chunk.text);
      if (!translatable) return { raw: chunk.text, translate: false, parts: [] };
      const parts = [];
      const text = chunk.text.replace(/`[^`\n]{1,200}`/g, code => { parts.push(code); return `〔${parts.length}〕`; });
      return { raw: chunk.text, text, parts, translate: true };
    });
  }
  const styleEl = document.createElement('style');
  styleEl.setAttribute('data-market-translator-style', '1');
  styleEl.textContent = CSS;
  document.head.append(styleEl);

  function restoreOne(el) {
    const rec = shown.get(el);
    if (!rec) return;
    if (rec.kind === 'pre') el.textContent = rec.source;
    else if (rec.source !== undefined) el.innerHTML = rec.source;
    el.removeAttribute(TEXT_MARK);
    shown.delete(el);
  }
  function restoreAll() { for (const el of [...touched]) { restoreOne(el); if (!el.isConnected) touched.delete(el); } }
  function paintSimple(el) {
    let rec = shown.get(el);
    if (!rec || rec.kind !== 'simple' || el.textContent !== rec.painted) {
      const tokenised = tokenise(el);
      rec = { kind: 'simple', text: tokenised.text, parts: tokenised.parts, source: el.innerHTML, painted: '' };
      shown.set(el, rec);
    }
    const translation = lookup(rec.text);
    if (!translation) {
      if (rec.painted) { el.innerHTML = rec.source; rec.painted = ''; }
      return;
    }
    if (rec.painted && el.textContent === rec.painted) return;
    if (rec.parts.length) {
      if (!tokensIntact(translation, rec.parts)) return;
      const fragment = document.createDocumentFragment();
      translation.split(/〔(\d+)〕/).forEach((chunk, index) => {
        if (index % 2) {
          const template = document.createElement('template');
          template.innerHTML = rec.parts[Number(chunk) - 1] ?? '';
          if (template.content.firstChild) fragment.append(template.content.firstChild);
        } else if (chunk) fragment.append(document.createTextNode(chunk));
      });
      el.replaceChildren(fragment);
    } else {
      el.textContent = translation;
    }
    rec.painted = el.textContent;
    el.setAttribute(TEXT_MARK, '');
    touched.add(el);
  }
  function paintPreview(el) {
    let rec = shown.get(el);
    if (!rec || rec.kind !== 'pre' || el.textContent !== rec.painted) {
      const source = el.textContent;
      rec = { kind: 'pre', source, segments: previewSegments(source), painted: source };
      shown.set(el, rec);
    }
    const pieces = [];
    for (const segment of rec.segments) {
      const translation = segment.translate ? lookup(segment.text) : null;
      pieces.push(translation && tokensIntact(translation, segment.parts) ? restoreTokens(translation, segment.parts) : segment.raw);
    }
    const out = pieces.join('\n');
    if (out !== el.textContent) { el.textContent = out; el.setAttribute(TEXT_MARK, ''); }
    rec.painted = el.textContent;
    touched.add(el);
  }
  function paintAll() {
    if (!enabled) { restoreAll(); return; }
    for (const el of elements()) paintSimple(el);
    for (const el of [...document.querySelectorAll(PREVIEW)].filter(visible)) paintPreview(el);
  }
  function pending() {
    const texts = [], seen = new Set();
    const add = text => {
      if (!text || !eligible(text) || seen.has(text) || known(text)) return;
      seen.add(text); texts.push(text);
    };
    for (const el of elements()) {
      const rec = shown.get(el);
      add(rec && el.textContent === rec.painted ? rec.text : tokenise(el).text);
    }
    for (const el of [...document.querySelectorAll(PREVIEW)].filter(visible)) {
      const rec = shown.get(el);
      const segments = rec && el.textContent === rec.painted ? rec.segments : previewSegments(el.textContent);
      for (const segment of segments) if (segment.translate) add(segment.text);
    }
    return texts;
  }
  function schedule(delay = 180) { if (!alive) return; clearTimeout(timer); timer = setTimeout(scan, delay); }
  function themeVars(root) {
    const probe = getComputedStyle(document.body).backgroundColor.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [32, 32, 36];
    const [r, g, b] = probe.length >= 3 ? probe : [32, 32, 36];
    const dark = (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
    root.style.setProperty('--mt-surface', dark ? 'rgb(33,33,39)' : 'rgb(255,255,255)');
    root.style.setProperty('--mt-field', dark ? 'rgba(255,255,255,.06)' : 'rgba(17,17,20,.04)');
    root.style.setProperty('--mt-fg', dark ? 'rgb(237,236,242)' : 'rgb(32,31,38)');
    root.style.setProperty('--mt-muted', dark ? 'rgba(237,236,242,.62)' : 'rgba(32,31,38,.6)');
    root.style.setProperty('--mt-border', dark ? 'rgba(255,255,255,.12)' : 'rgba(17,17,20,.12)');
  }

  function barFor(list) {
    if (bars.has(list)) return bars.get(list);
    const root = make('div');
    root.dataset.marketTranslator = 'bar';
    const state = make('span', '', 'mt-state');
    state.setAttribute('role', 'status');
    const settings = make('button', '翻译设置', 'mt-quiet');
    settings.type = 'button';
    const toggle = make('button');
    toggle.type = 'button';
    toggle.dataset.marketTranslator = 'switch';
    toggle.setAttribute('role', 'switch');
    const track = make('span', '', 'mt-track'), thumb = make('span', '', 'mt-thumb'), label = make('span');
    track.append(thumb); toggle.append(track, label);
    settings.onclick = () => { open = true; renderDialog(); };
    toggle.onclick = () => {
      if (!enabled && !googleReady() && (!modelsLoaded || !models.some(m => m.key === modelKey))) { open = true; renderDialog(); return; }
      enabled = !enabled; epoch++; error = ''; status = ''; save();
      if (!enabled) restoreAll();
      schedule(0); renderBars(); renderDialog();
    };
    root.append(state, settings, toggle);
    list.before(root);
    const bar = { root, state, toggle, label };
    bars.set(list, bar);
    return bar;
  }
  function renderBars() {
    for (const [list, bar] of [...bars]) if (!list.isConnected || !bar.root.isConnected) { bar.root.remove(); bars.delete(list); }
    for (const list of document.querySelectorAll(LISTS)) {
      if (!visible(list)) continue;
      const bar = barFor(list);
      bar.toggle.setAttribute('aria-checked', String(enabled));
      bar.label.textContent = enabled ? '翻译已开' : '翻译';
      const message = error ? '翻译失败' : busy ? '翻译中…' : '';
      if (bar.state.textContent !== message) bar.state.textContent = message;
    }
  }

  function fillDialog() {
    if (!dialogRefs) return;
    const { select, googleKeyInput, googleSwitch, limitSelect, toggle, retranslateToggle, statusEl, alertEl, countEl, clearBtn, refreshBtn } = dialogRefs;
    const signature = JSON.stringify(models.map(m => [m.key, m.label]));
    if (select.dataset.models !== signature) {
      select.replaceChildren();
      const empty = make('option', modelsLoaded ? '选择翻译模型' : '正在读取模型…');
      empty.value = ''; select.append(empty);
      for (const model of models) { const option = make('option', model.label || model.key); option.value = model.key; select.append(option); }
      select.dataset.models = signature;
    }
    select.value = modelKey;
    select.disabled = !modelsLoaded || models.length === 0;
    limitSelect.value = String(limit);
    if (document.activeElement !== googleKeyInput && googleKeyInput.value.trim() !== googleKey) googleKeyInput.value = googleKey;
    googleSwitch.setAttribute('aria-checked', String(googleOn && googleKey.trim().length >= 20));
    googleSwitch.disabled = googleKey.trim().length < 20;
    googleSwitch.querySelector('.mt-track').nextElementSibling.textContent = googleReady() ? '使用中' : googleKey.trim().length >= 20 ? '已停用' : '未配置';
    if (![...limitSelect.options].some(option => option.value === String(limit))) {
      const extra = make('option', `${limit} 条`); extra.value = String(limit); limitSelect.append(extra); limitSelect.value = String(limit);
    }
    retranslateToggle.setAttribute('aria-checked', String(retranslate));
    retranslateToggle.querySelector('.mt-track').nextElementSibling.textContent = retranslate ? '重新翻译' : '沿用旧译文';
    toggle.setAttribute('aria-checked', String(enabled));
    toggle.disabled = !(googleReady() || models.some(m => m.key === modelKey));
    toggle.querySelector('.mt-track').nextElementSibling.textContent = enabled ? '已开启' : '已关闭';
    const engineLine = !modelsLoaded && !googleReady() ? '正在读取模型…' : enabled ? `翻译已开启（${googleReady() ? '谷歌翻译' : '模型'}），滚动或翻页会继续处理` : '已关闭，显示原文';
    const line = error || notice || status || engineLine;
    if (statusEl.textContent !== line) statusEl.textContent = line;
    statusEl.classList.toggle('mt-alert', Boolean(error));
    alertEl.hidden = !error && !notice;
    countEl.textContent = `已缓存 ${cache.size} 条 · 上限 ${limit} 条`;
    clearBtn.disabled = !cache.size;
    refreshBtn.disabled = modelsLoading;
  }
  function renderDialog() {
    if (!open) return;
    if (!overlay) {
      overlay = make('div');
      overlay.dataset.marketTranslator = 'overlay';
      overlay.setAttribute('role', 'presentation');
      themeVars(overlay);
      dialog = make('div');
      dialog.dataset.marketTranslator = 'dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', '市场中文翻译设置');
      const head = make('div', '', 'mt-head');
      const titles = make('div');
      titles.append(make('h2', '市场中文翻译'), make('p', '列表和详情页都显示中文，原文与安装配置不变。', 'mt-sub'));
      const close = make('button', '×', 'mt-close');
      close.type = 'button'; close.setAttribute('aria-label', '关闭');
      head.append(titles, close);

      const rowModel = make('div', '', 'mt-row');
      const select = make('select');
      select.setAttribute('aria-label', '翻译模型');
      rowModel.append(make('label', '翻译模型', 'mt-label'), select);

      const rowGoogleKey = make('div', '', 'mt-row');
      const googleKeyInput = make('input');
      googleKeyInput.type = 'password';
      googleKeyInput.autocomplete = 'off';
      googleKeyInput.spellcheck = false;
      googleKeyInput.placeholder = '粘贴谷歌云翻译 API 密钥（可选）';
      googleKeyInput.setAttribute('aria-label', '谷歌翻译 API 密钥');
      rowGoogleKey.append(make('label', '谷歌翻译密钥', 'mt-label'), googleKeyInput);
      const rowGoogle = make('div', '', 'mt-row-inline');
      const googleSwitch = make('button');
      googleSwitch.type = 'button';
      googleSwitch.dataset.marketTranslator = 'switch';
      googleSwitch.setAttribute('role', 'switch');
      googleSwitch.setAttribute('aria-label', '用谷歌翻译');
      googleSwitch.append(make('span', '', 'mt-track'), make('span'));
      googleSwitch.querySelector('.mt-track').append(make('span', '', 'mt-thumb'));
      rowGoogle.append(make('span', '用谷歌翻译', 'mt-label'), googleSwitch);
      const googleHint = make('p', '有密钥且开启时，新文案改用谷歌翻译、不消耗模型额度；失败会自动回退模型。缓存优先用模型译文，谷歌译文排最后。密钥只保存在本机。', 'mt-hint');
      const googleClear = make('button', '清除本机密钥', 'mt-quiet');
      googleClear.type = 'button';
      googleClear.style.cssText = 'align-self:flex-start;margin:-8px 0 16px;font-size:12px;';
      const rowLimit = make('div', '', 'mt-row-inline');
      const limitSelect = make('select', '', 'mt-limit');
      limitSelect.setAttribute('aria-label', '缓存上限');
      for (const size of [100, 200, 300, 500, 800, 1200, 2000]) {
        const option = make('option', `${size} 条`);
        option.value = String(size);
        limitSelect.append(option);
      }
      rowLimit.append(make('span', '缓存上限', 'mt-label'), limitSelect);

      const rowRetranslate = make('div', '', 'mt-row-inline');
      const retranslateToggle = make('button');
      retranslateToggle.type = 'button';
      retranslateToggle.dataset.marketTranslator = 'switch';
      retranslateToggle.setAttribute('role', 'switch');
      retranslateToggle.setAttribute('aria-label', '换模型后重新翻译');
      retranslateToggle.append(make('span', '', 'mt-track'), make('span'));
      retranslateToggle.querySelector('.mt-track').append(make('span', '', 'mt-thumb'));
      rowRetranslate.append(make('span', '换模型后重新翻译', 'mt-label'), retranslateToggle);
      const retranslateHint = make('p', '关闭时沿用任意模型已有的译文、不消耗额度；开启时用新模型重新翻译。旧模型的译文都会保留，切回即可立即复用。', 'mt-hint');

      const rowToggle = make('div', '', 'mt-row-inline');
      const toggle = make('button');
      toggle.type = 'button';
      toggle.dataset.marketTranslator = 'switch';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-label', '自动翻译');
      toggle.append(make('span', '', 'mt-track'), make('span'));
      toggle.querySelector('.mt-track').append(make('span', '', 'mt-thumb'));
      rowToggle.append(make('span', '自动翻译', 'mt-label'), toggle);

      const statusEl = make('p', '', 'mt-note');
      statusEl.setAttribute('role', 'status');
      const alertEl = make('p', '', 'mt-alert');
      alertEl.hidden = true;

      const countEl = make('p', '', 'mt-count');
      const actions = make('div', '', 'mt-actions');
      const clearBtn = make('button', '清空', 'mt-btn');
      const refreshBtn = make('button', '刷新模型', 'mt-btn');
      clearBtn.type = 'button'; refreshBtn.type = 'button';
      clearBtn.setAttribute('aria-label', '清空译文缓存');
      const done = make('button', '完成', 'mt-btn mt-btn-primary');
      done.type = 'button';
      actions.append(clearBtn, refreshBtn, done);

      const repaint = () => { epoch++; error = ''; status = ''; save(); restoreAll(); schedule(0); renderBars(); renderDialog(); };
      select.onchange = () => { modelKey = select.value; repaint(); };
      googleKeyInput.onchange = () => {
        googleKey = googleKeyInput.value.trim();
        if (!googleKey) googleOn = true;
        repaint();
      };
      googleSwitch.onclick = () => {
        if (googleKey.trim().length < 20) return;
        googleOn = !googleOn;
        repaint();
      };
      googleClear.onclick = () => {
        googleKey = ''; googleOn = true;
        googleKeyInput.value = '';
        repaint();
      };
      limitSelect.onchange = () => {
        limit = clampLimit(limitSelect.value);
        persistCache(); save(); renderBars(); renderDialog();
      };
      retranslateToggle.onclick = () => {
        retranslate = !retranslate;
        if (retranslate) { restoreAll(); }
        repaint();
      };
      toggle.onclick = () => {
        if (!enabled && !models.some(m => m.key === modelKey)) return;
        enabled = !enabled; epoch++; error = ''; status = ''; save();
        if (!enabled) restoreAll();
        schedule(0); renderBars(); renderDialog();
      };
      clearBtn.onclick = () => { cache.clear(); persistCache(); error = ''; status = ''; restoreAll(); schedule(0); renderBars(); renderDialog(); };
      refreshBtn.onclick = () => { error = ''; loadModels(); renderDialog(); };
      const closeAll = () => { open = false; overlay?.remove(); overlay = dialog = null; dialogRefs = null; };
      done.onclick = closeAll;
      close.onclick = closeAll;
      overlay.onmousedown = event => { if (event.target === overlay) closeAll(); };
      dialog.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); closeAll(); } };

      dialog.append(head, rowModel, rowGoogleKey, rowGoogle, googleHint, googleClear, rowLimit, rowRetranslate, retranslateHint, rowToggle, statusEl, alertEl, countEl, actions);
      overlay.append(dialog);
      dialogRefs = { select, googleKeyInput, googleSwitch, limitSelect, toggle, retranslateToggle, statusEl, alertEl, countEl, clearBtn, refreshBtn };
    }
    if (!overlay.isConnected) document.body.append(overlay);
    fillDialog();
  }
  async function scan() {
    if (!alive) return;
    renderBars(); paintAll(); renderDialog();
    if (!enabled || busy || error) return;
    const useGoogle = googleReady();
    if (!useGoogle && (!modelsLoaded || !models.some(m => m.key === modelKey))) return;
    if (Date.now() < nextRequest) { schedule(nextRequest - Date.now()); return; }
    const texts = []; let chars = 0;
    for (const text of pending()) {
      if (texts.length >= 12 || chars + text.length > 12000) break;
      texts.push(text); chars += text.length;
    }
    if (!texts.length) { if (status) { status = ''; renderBars(); renderDialog(); } return; }
    const version = epoch, chosen = modelKey;
    busy = true; status = `正在用${useGoogle ? '谷歌翻译' : '模型'}翻译 ${texts.length} 段文字`; renderBars(); renderDialog();
    try {
      let translations = null, engineName = chosen;
      if (useGoogle) {
        try {
          const answer = await call('google', { key: googleKey.trim(), texts });
          const list = Array.isArray(answer?.translations) ? answer.translations : null;
          if (!list || list.length !== texts.length) throw new Error('返回条数与请求不一致');
          translations = list; engineName = GOOGLE; notice = '';
        } catch (failure) {
          if (!alive || version !== epoch) throw failure;
          notice = `谷歌翻译失败，已改用模型：${String(failure?.message || failure).slice(0, 120)}`;
          if (!modelsLoaded || !models.some(m => m.key === modelKey)) throw failure;
        }
      }
      if (!translations) {
        const started = await call('start', { modelKey: chosen, texts });
        const deadline = Date.now() + 100000;
        let result;
        while (alive && Date.now() < deadline) {
          await wait(1000); if (!alive) return;
          result = await call('poll', { id: started.id });
          if (result.status === 'error') throw new Error(result.error);
          if (result.status === 'done') break;
        }
        if (!alive) return;
        if (result?.status !== 'done') throw new Error('翻译超时，请稍后重试');
        translations = result.translations; engineName = chosen;
      }
      if (version === epoch && enabled) {
        translations.forEach((translation, index) => {
          cache.set(JSON.stringify([engineName, texts[index]]), translation);
          if (engineName !== GOOGLE) byText.set(texts[index], { model: engineName, translation });
        });
        persistCache(); status = ''; paintAll();
      }
    } catch (failure) {
      if (alive && version === epoch) error = String(failure?.message || failure).slice(0, 240);
    } finally {
      busy = false; nextRequest = Date.now() + 1500;
      if (alive) { renderBars(); renderDialog(); schedule(1600); }
    }
  }

  async function loadModels() {
    if (modelsLoading || !alive) return;
    modelsLoading = true; renderDialog();
    try {
      const result = await call('models');
      if (!alive) return;
      models = Array.isArray(result) ? result.filter(m => typeof m.key === 'string') : [];
      modelsLoaded = true;
      if (!models.length) error = '没有可用模型，请先在设置 → 模型中配置，然后点刷新模型';
      else if (modelKey && !models.some(m => m.key === modelKey)) { enabled = false; modelKey = ''; save(); }
    } catch (failure) { if (alive) error = '读取模型失败：' + String(failure?.message || failure).slice(0, 160); }
    finally { modelsLoading = false; if (alive) { renderBars(); renderDialog(); schedule(); } }
  }

  const relevant = node => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el && !owns(el) && (el.matches?.(SCOPE) || el.closest?.(SCOPE) || el.querySelector?.(SCOPE));
  };
  const observer = new MutationObserver(records => {
    if (records.some(record => {
      if (owns(record.target)) return false;
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const rec = target && shown.get(target);
      if (rec && rec.painted && target.textContent === rec.painted) return false;
      return target?.closest?.(SCOPE) || [...record.addedNodes, ...record.removedNodes].some(relevant);
    })) schedule();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  const onResize = () => schedule();
  window.addEventListener('resize', onResize);

  dispose = () => {
    alive = false; epoch++; observer.disconnect(); clearTimeout(timer);
    window.removeEventListener('resize', onResize);
    for (const [id, resolve] of sleepTimers) { clearTimeout(id); resolve(); } sleepTimers.clear();
    restoreAll(); touched.clear();
    for (const bar of bars.values()) bar.root.remove(); bars.clear();
    overlay?.remove(); overlay = dialog = dialogRefs = null; open = false;
    styleEl.remove();
  };
  loadModels(); renderBars(); schedule();
}
export function onUnload() { dispose?.(); dispose = undefined; }
