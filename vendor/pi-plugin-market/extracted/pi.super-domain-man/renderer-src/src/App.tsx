/* ============================================================
 * App.tsx - 应用主控（侧边导航 + 路由 + 主密码门禁 + 主题切换）
 * ============================================================ */
import { createContext, ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import * as Store from "./lib/store";
import { toast, confirmBox } from "./lib/util";
import { AskHost, ToastHost, Button, inputCls } from "./components/ui";
import * as SslLib from "./lib/ssl";
import { Accounts } from "./views/Accounts";
import { Domains } from "./views/Domains";
import { Records } from "./views/Records";
import { Ssl } from "./views/Ssl";
import { Monitor } from "./views/Monitor";
import { Notifications } from "./views/Notifications";
import { Settings } from "./views/Settings";

const ICONS: Record<string, string> = {
  accounts: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/></svg>',
  domains: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M2.5 8h11M8 2c2 1.8 2.5 4 2.5 6S10 12.2 8 14C6 12.2 5.5 10 5.5 8S6 3.8 8 2z"/></svg>',
  records: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4h12M2 8h12M2 12h7"/></svg>',
  ssl: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 6.5V4.8A5 5 0 0 1 8 0a5 5 0 0 1 5 4.8v1.7"/><rect x="2.5" y="6.5" width="11" height="9"/><path d="M8 9.5v2.5"/></svg>',
  monitor: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="3" width="13" height="10"/><path d="M4.5 6v4M8 6v4M11.5 6v4"/></svg>',
  notifications: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 12h12l-1.5-1.5V7a4.5 4.5 0 0 0-9 0v3.5L2 12z"/><path d="M6.5 13.5a1.5 1.5 0 0 0 3 0"/></svg>',
  settings: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="10" height="10"/><rect x="6.5" y="6.5" width="3" height="3"/></svg>',
};

export interface AppState {
  route: string;
  records: { accountId: string; domain: string } | null;
}

export interface AppCtx {
  go: (route: string, records?: { accountId: string; domain: string } | null) => void;
  state: AppState;
}

const Ctx = createContext<AppCtx>({ go: () => undefined, state: { route: "accounts", records: null } });

export function useApp(): AppCtx {
  return useContext(Ctx);
}

const ROUTES = [
  { key: "accounts", title: "账号管理", icon: "accounts" },
  { key: "domains", title: "域名列表", icon: "domains" },
  { key: "records", title: "域名解析", icon: "records", hidden: true },
  { key: "ssl", title: "SSL 证书", icon: "ssl" },
  { key: "monitor", title: "SSL 监控", icon: "monitor" },
  { key: "notifications", title: "系统通知", icon: "notifications" },
  { key: "settings", title: "插件设置", icon: "settings" },
];

/* ------------------------- 主密码门禁（进入面板时） ------------------------- */

function MasterGate({ mode, onDone }: { mode: "set" | "unlock"; onDone: () => void }) {
  const isSet = mode === "set";
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    try {
      if (isSet) {
        if (pw.length < 6) return toast("主密码至少 6 位", true);
        if (pw !== pw2) return toast("两次输入不一致", true);
        setBusy(true);
        await Store.setMaster(pw);
        toast("主密码已设置");
        onDone();
      } else {
        if (!pw) return toast("请输入主密码", true);
        setBusy(true);
        const ok = await Store.unlock(pw);
        if (!ok) return toast("主密码错误", true);
        onDone();
      }
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`, true);
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    if (!(await confirmBox("忘记主密码将清空全部本地数据：账号凭据、域名缓存、SSL 证书、监控目标与设置，且无法恢复。确定继续？", "忘记主密码"))) return;
    Store.wipeAll();
    toast("已清空全部本地数据，请重新设置主密码");
    onDone();
  };

  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--pi-plugin-titlebar-height,46px)] z-[500] bg-black/60 flex items-center justify-center p-6">
      <div className="w-full max-w-[380px] bg-surface-bg2 border border-line-strong shadow-[0_4px_24px_rgba(0,0,0,0.55)]">
        <div className="flex items-center justify-between h-11 px-4 border-b border-line text-sm font-bold">
          <span>{isSet ? "设置主密码" : "解锁主密码"}</span>
        </div>
        <div className="px-4 py-4">
          <div className="text-[12.5px] text-ink-muted mb-3">
            {isSet
              ? "云厂商 API 凭据将用主密码加密后仅保存在本机。请设置至少 6 位的主密码。"
              : "输入主密码解锁凭据。主密码只保存在内存中，关闭面板后需要重新解锁。"}
          </div>
          <input
            className={`${inputCls} w-full mb-2`}
            type="password"
            autoFocus
            placeholder={isSet ? "设置主密码（至少 6 位）" : "输入主密码"}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
          />
          {isSet && (
            <input
              className={`${inputCls} w-full mb-2`}
              type="password"
              placeholder="确认主密码"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          )}
          <Button variant="primary" className="w-full justify-center" disabled={busy} onClick={() => void submit()}>
            {busy ? "处理中…" : isSet ? "设置并进入" : "解锁进入"}
          </Button>
          {!isSet && (
            <div className="mt-3 text-center">
              <button
                className="text-[11.5px] text-ink-faint hover:text-danger cursor-pointer underline decoration-dotted"
                onClick={() => void forgot()}
              >
                忘记主密码？清空全部数据
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- 主应用 ---------------------------------- */

export default function App() {
  const [state, setState] = useState<AppState>(() => {
    const hash = (location.hash || "#/accounts").replace(/^#\/?/, "");
    return { route: ROUTES.some((r) => r.key === hash) ? hash : "accounts", records: null };
  });
  const version = useSyncExternalStore(Store.subscribe, Store.getVersion, Store.getVersion);
  const [gate, setGate] = useState<"set" | "unlock" | null>(() => (!Store.isMasterSet() ? "set" : !Store.hasKey() ? "unlock" : null));

  useEffect(() => {
    Store.applyTheme(Store.getSettings().theme);
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (Store.getSettings().theme === "system") Store.applyTheme("system");
    };
    mq.addEventListener("change", onChange);
    // 启动时若已有监控目标，做一次 crt.sh 检查
    if (Store.listMonitors().length > 0) {
      setTimeout(() => {
        void (async () => {
          try {
            const list = Store.listMonitors();
            const refreshed = await SslLib.refreshAll(list, 2);
            Store.saveMonitors(refreshed);
            SslLib.notifyExpiring(refreshed);
          } catch {
            /* 静默 */
          }
        })();
      }, 1500);
    }
    return () => mq.removeEventListener("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onHash = () => {
      const hash = (location.hash || "#/accounts").replace(/^#\/?/, "");
      setState((prev) => ({ ...prev, route: ROUTES.some((r) => r.key === hash) ? hash : "accounts" }));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const ctx = useMemo<AppCtx>(
    () => ({
      state,
      go: (route, records) => {
        location.hash = "#/" + route;
        setState((prev) => ({ ...prev, route, records: records !== undefined ? records : prev.records }));
      },
    }),
    [state]
  );

  const refreshGate = () => setGate(!Store.isMasterSet() ? "set" : !Store.hasKey() ? "unlock" : null);

  const settings = Store.getSettings();
  const isDark = settings.theme === "dark" || (settings.theme === "system" && !window.matchMedia("(prefers-color-scheme: light)").matches);

  void version;
  const unread = Store.unreadCount();

  return (
    <Ctx.Provider value={ctx}>
      <div className="flex h-screen">
        <aside className="fixed left-0 top-[var(--pi-plugin-titlebar-height,46px)] bottom-0 w-[176px] flex flex-col bg-surface-bg2 border-r border-line z-50">
          <div className="flex items-center gap-2.5 h-[52px] px-3 border-b border-line shrink-0 select-none">
            <span className="w-[26px] h-[26px] bg-accent text-accent-on font-bold text-[14px] flex items-center justify-center shrink-0">域</span>
            <span className="text-[14px] font-bold tracking-wide whitespace-nowrap">超级域名侠</span>
          </div>
          <nav className="flex-1 overflow-y-auto p-1.5">
            {ROUTES.filter((r) => !r.hidden).map((r) => (
              <div
                key={r.key}
                className={`flex items-center gap-2.5 h-[34px] px-2.5 mb-0.5 cursor-pointer select-none whitespace-nowrap border border-transparent ${
                  state.route === r.key ? "bg-accent text-accent-on font-semibold" : "text-ink-muted hover:text-ink hover:bg-surface-panel"
                }`}
                onClick={() => ctx.go(r.key)}
              >
                <span className="w-4 h-4 shrink-0 flex items-center justify-center" dangerouslySetInnerHTML={{ __html: ICONS[r.icon] }} />
                <span className="text-[13px]">{r.title}</span>
                {r.key === "notifications" && unread > 0 && (
                  <span className="ml-auto min-w-4 h-4 px-1 bg-ink text-surface text-[10px] font-bold leading-4 text-center">{unread}</span>
                )}
              </div>
            ))}
          </nav>
          <div className="border-t border-line p-1.5">
            <button
              className="w-full h-[30px] flex items-center justify-center gap-1.5 text-[12px] border border-line-strong bg-surface-panel2 text-ink-muted hover:text-ink hover:border-ink cursor-pointer"
              onClick={() => {
                const next = isDark ? "light" : "dark";
                Store.saveSettings({ theme: next });
                Store.applyTheme(next);
                toast(next === "light" ? "已切换为白天模式" : "已切换为黑夜模式");
              }}
            >
              {isDark ? "☀ 白天模式" : "☾ 黑夜模式"}
            </button>
          </div>
        </aside>

        <main className="flex-1 ml-[176px] h-screen overflow-hidden flex flex-col">
          <div className="flex-1 overflow-y-auto p-5 pb-8">
            {state.route === "accounts" && <Accounts />}
            {state.route === "domains" && <Domains />}
            {state.route === "records" && <Records />}
            {state.route === "ssl" && <Ssl />}
            {state.route === "monitor" && <Monitor />}
            {state.route === "notifications" && <Notifications />}
            {state.route === "settings" && <Settings />}
          </div>
        </main>
      </div>
      {gate && <MasterGate mode={gate} onDone={refreshGate} />}
      <ToastHost />
      <AskHost />
    </Ctx.Provider>
  );
}
