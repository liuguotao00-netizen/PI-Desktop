import { app, BrowserWindow, type BrowserWindow as BrowserWindowType } from "electron";

type Credential = { username: string; password: string };
const cache = new Map<string, Credential>();
const inFlight = new Map<string, Promise<Credential | null>>();

function promptWindow(parent: BrowserWindowType | null, host: string, realm: string): Promise<Credential | null> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      ...(parent ? { parent } : {}),
      modal: Boolean(parent),
      show: false,
      width: 380,
      height: 220,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const html = `<!doctype html><meta charset="utf-8">
<style>body{font:13px system-ui;margin:20px}label{display:block;margin:10px 0 4px}input{width:100%;padding:6px}p{color:#666;margin:0 0 12px}button{padding:6px 12px}</style>
<p>${host.replace(/[<>&]/g, "")} requires authentication</p>
<label>Username<input id="u" autofocus></label>
<label>Password<input id="p" type="password"></label>
<p><button id="ok">Sign in</button> <button id="cancel">Cancel</button></p>
<script>
  window.__piAuth = null;
  const submit = () => { window.__piAuth = { username: document.getElementById('u').value, password: document.getElementById('p').value, submitted: true }; };
  document.getElementById('ok').onclick = submit;
  document.getElementById('p').onkeydown = (event) => { if (event.key === 'Enter') submit(); };
  document.getElementById('cancel').onclick = () => { window.__piAuth = { submitted: true, cancel: true }; };
</script>`;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.once("ready-to-show", () => win.show());
    let settled = false;
    const finish = (value: Credential | null) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (!win.isDestroyed()) win.close();
      resolve(value);
    };
    const timer = setInterval(() => {
      if (win.isDestroyed()) return finish(null);
      void win.webContents
        .executeJavaScript("window.__piAuth", true)
        .then((value: { username?: string; password?: string; submitted?: boolean; cancel?: boolean } | null) => {
          if (!value?.submitted) return;
          finish(value.cancel ? null : { username: String(value.username ?? ""), password: String(value.password ?? "") });
        })
        .catch(() => undefined);
    }, 100);
    win.once("closed", () => finish(null));
  });
}

/**
 * Chromium HTTP/proxy auth normally has no UI in Electron. Prompt once per
 * host+realm and cache the credentials for the session.
 */
export function installHttpAuthPrompt(parent: () => BrowserWindowType | null): void {
  app.on("login", (event, _webContents, _details, authInfo, callback) => {
    event.preventDefault();
    const key = `${authInfo.isProxy ? "proxy" : "http"}:${authInfo.host}:${authInfo.port}:${authInfo.realm}`;
    const cached = cache.get(key);
    if (cached) {
      callback(cached.username, cached.password);
      return;
    }
    let pending = inFlight.get(key);
    if (!pending) {
      pending = promptWindow(parent(), authInfo.host, authInfo.realm || authInfo.host);
      inFlight.set(key, pending);
      void pending.finally(() => inFlight.delete(key));
    }
    void pending.then((credential) => {
      if (!credential) {
        callback();
        return;
      }
      cache.set(key, credential);
      callback(credential.username, credential.password);
    });
  });
}
