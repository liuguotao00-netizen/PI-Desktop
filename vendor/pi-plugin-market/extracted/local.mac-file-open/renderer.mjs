let dispose;

const COPY = {
  en: {
    menuLabel: 'File Open Options',
    preview: 'Preview in PI-Desktop',
    reveal: 'Reveal in Finder',
    openDefault: 'Open with Default App',
    openWith: 'Open With…',
    defaultSuffix: ' (Default)',
    noApps: 'No associated applications found on macOS.',
    copyFull: 'Copy Full Path',
    copyRelative: 'Copy Relative Path'
  },
  'zh-CN': {
    menuLabel: '文件打开方式',
    preview: '在 PI-Desktop 中预览',
    reveal: '在 Finder 中显示',
    openDefault: '使用默认应用打开',
    openWith: '打开方式…',
    defaultSuffix: '（默认）',
    noApps: '系统未找到关联应用。',
    copyFull: '复制完整地址',
    copyRelative: '复制相对地址'
  }
};

function currentCopy() {
  const lang = String(document.documentElement?.lang || navigator.language || 'zh-CN');
  return lang.toLowerCase().startsWith('zh') ? COPY['zh-CN'] : COPY.en;
}

export function onLoad(pi) {
  let layer = null;
  let anchor = null;

  const close = () => {
    layer?.close();
    layer = null;
    anchor?.focus();
    anchor = null;
  };

  const style = pi.ui.injectStyle(
    `.native-files{position:fixed;min-width:240px;max-width:420px;padding:7px;border:1px solid #8885;border-radius:14px;background:var(--background,#fff);color:var(--foreground,#242424);box-shadow:0 10px 40px #0003;font:14px -apple-system,BlinkMacSystemFont,sans-serif}.native-files button{display:block;width:100%;padding:10px 12px;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}.native-files button:hover,.native-files button:focus{background:#8882;outline:none}.native-files .caption{padding:7px 12px;font-size:12px;opacity:.65;overflow-wrap:anywhere}.native-files .error{padding:10px;color:#b33;max-width:360px}.native-files hr{border:0;border-top:1px solid #8883}`
  );

  function show(event) {
    const a = event.target.closest?.('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || (!href.startsWith('file:') && !href.startsWith('/'))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
    anchor = a;
    const t = currentCopy();
    layer = pi.ui.openLayer();
    const box = document.createElement('div');
    box.className = 'native-files';
    box.setAttribute('role', 'menu');
    box.setAttribute('aria-label', t.menuLabel);
    box.style.left = Math.min(event.clientX, window.innerWidth - 310) + 'px';
    box.style.top = Math.min(event.clientY, window.innerHeight - 340) + 'px';
    layer.element.append(box);

    const caption = document.createElement('div');
    caption.className = 'caption';
    try {
      caption.textContent = decodeURIComponent(href.split('/').at(-1));
    } catch {
      caption.textContent = href.split('/').at(-1);
    }
    box.append(caption);

    const call = (method, args = {}) => pi.dispatch('plugin.call', { method, args: { path: href, ...args } });

    function button(label, fn) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.onclick = async () => {
        try {
          await fn();
        } catch (e) {
          let errNode = box.querySelector('.error');
          if (!errNode) {
            errNode = document.createElement('div');
            errNode.className = 'error';
            errNode.setAttribute('role', 'alert');
            box.append(errNode);
          }
          errNode.textContent = e.message || String(e);
        }
      };
      box.append(b);
      return b;
    }

    button(t.preview, () => {
      close();
      a.click();
    });
    button(t.reveal, async () => {
      await call('file.reveal');
      close();
    });
    button(t.openDefault, async () => {
      await call('file.open');
      close();
    });
    button(t.openWith, async () => {
      const info = await call('file.info');
      box.querySelector('[data-apps]')?.remove();
      const group = document.createElement('div');
      group.dataset.apps = 'true';
      const line = document.createElement('hr');
      group.append(line);
      box.append(group);
      for (const app of info.apps) {
        const b = button(app.name + (app.isDefault ? t.defaultSuffix : ''), async () => {
          await call('file.open', { app: app.path });
          close();
        });
        group.append(b);
      }
      if (!info.apps.length) group.textContent = t.noApps;
      box.style.top = Math.max(8, Math.min(event.clientY, window.innerHeight - box.offsetHeight - 8)) + 'px';
    });
    button(t.copyFull, async () => {
      await call('file.copy');
      close();
    });
    button(t.copyRelative, async () => {
      await call('file.copy', { relative: true });
      close();
    });

    box.querySelector('button').focus();
    box.onkeydown = e => {
      const items = [...box.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    };
  }

  const outside = e => {
    if (layer && !layer.element.contains(e.target)) close();
  };
  const keys = e => {
    if (layer && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  document.addEventListener('contextmenu', show, true);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keys, true);

  dispose = () => {
    close();
    style();
    document.removeEventListener('contextmenu', show, true);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keys, true);
  };
  return dispose;
}

export function onUnload() {
  dispose?.();
}
