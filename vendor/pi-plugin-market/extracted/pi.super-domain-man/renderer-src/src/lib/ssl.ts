/* ============================================================
 * ssl.ts - SSL 监控（面板内）
 *  - 监控目标 CRUD 辅助
 *  - 通过 crt.sh 查询证书有效期（证书透明日志）
 * ============================================================ */
import * as Net from "./net";
import * as Store from "./store";
import { pushChannels } from "./notify";
import { daysLeft, registeredDomain, sleep } from "./util";

export interface MonitorDraft {
  uri: string;
  remark?: string;
}

export function normalizeUri(uri: string): { uri: string; host: string } | null {
  let u = String(uri || "").trim();
  if (!u) return null;
  if (!u.includes("://")) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    if (!parsed.hostname) return null;
    const port = parsed.port || 443;
    return { uri: port === 443 ? parsed.hostname : `${parsed.hostname}:${port}`, host: parsed.hostname };
  } catch {
    return null;
  }
}

export function parseAddInput(text: string): MonitorDraft[] {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      return { uri: parts[0], remark: parts.slice(1).join(" ") };
    });
}

export interface CrtShInfo {
  notBefore: number;
  notAfter: number;
  issuer: string;
  isWildcard: boolean;
}

export async function queryCrtSh(host: string): Promise<CrtShInfo | null> {
  const url = `https://crt.sh/?q=${encodeURIComponent(host)}&output=json`;
  const res = await Net.request(url, { timeoutMs: 12000 });
  if (res.status !== 200 || !res.bodyText) return null;
  let rows: any[];
  try {
    rows = JSON.parse(res.bodyText);
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const h = host.toLowerCase().replace(/\.$/, "");
  const matches = rows.filter((r) => {
    const names = String(r.name_value || "")
      .split("\n")
      .map((n: string) => n.trim().toLowerCase())
      .filter(Boolean);
    return names.some((n: string) => n === h) || names.some((n: string) => n.startsWith("*.") && h.endsWith(n.slice(1)));
  });
  const pool = matches.length > 0 ? matches : rows;
  const best = pool
    .filter((r) => r.not_after)
    .sort((a, b) => Date.parse(b.not_before || 0) - Date.parse(a.not_before || 0))[0];
  if (!best) return null;
  return {
    notBefore: Date.parse(best.not_before),
    notAfter: Date.parse(best.not_after),
    issuer: best.issuer_name || "",
    isWildcard: String(best.name_value || "").includes("*."),
  };
}

export async function checkMonitor(m: Store.MonitorTarget): Promise<Store.MonitorTarget> {
  try {
    const info = await queryCrtSh(m.host || m.uri);
    if (!info) {
      m.last_error = "crt.sh 未查询到证书信息";
      m.expire_time = null;
    } else {
      m.expire_time = info.notAfter;
      m.issuer = info.issuer;
      m.is_wildcard = info.isWildcard;
      m.last_error = null;
    }
  } catch (e) {
    m.last_error = (e as Error).message || "查询失败";
    m.expire_time = null;
  }
  m.checked_at = Date.now();
  return m;
}

export async function refreshAll(monitors: Store.MonitorTarget[], concurrency = 3): Promise<Store.MonitorTarget[]> {
  const list = [...monitors];
  const queue = [...list];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency && queue.length; i++) {
    workers.push(
      (async () => {
        while (queue.length) {
          const m = queue.shift();
          if (m) await checkMonitor(m);
        }
      })()
    );
  }
  await Promise.all(workers);
  return list;
}

// 生成阈值通知（带静默期）
export function notifyExpiring(monitors: Store.MonitorTarget[]): number {
  const s = Store.getSettings();
  const thresholds = { notice: s.noticeDays, warning: s.warningDays, critical: s.criticalDays };
  const now = Date.now();
  const silentKey = "sdm.monitor.silent";
  const silenced = Store.get<Record<string, number>>(silentKey, {});
  let changed = false;
  let notified = 0;
  for (const m of monitors) {
    if (!m.expire_time) continue;
    const remaining = daysLeft(m.expire_time);
    if (remaining > thresholds.notice) continue;
    const key = m.id || m.uri;
    if (silenced[key] && now < silenced[key]) continue;
    let silenceMs = 0;
    let level = "info";
    if (remaining <= thresholds.critical) level = "error";
    else if (remaining <= thresholds.warning) {
      level = "warning";
      silenceMs = 3 * 86400000;
    } else {
      silenceMs = 7 * 86400000;
    }
    Store.addNotification(`证书到期提醒：${m.uri}`, `证书剩余 ${remaining} 天（${new Date(m.expire_time).toLocaleDateString()} 到期）`, level);
    if (silenceMs > 0) {
      silenced[key] = now + silenceMs;
      changed = true;
    }
    notified++;
  }
  if (changed) Store.set(silentKey, silenced);
  if (notified > 0) {
    const title = `超级域名侠：${notified} 个域名证书即将到期`;
    const content = monitors
      .filter((m) => m.expire_time && daysLeft(m.expire_time) <= thresholds.notice)
      .map((m) => `${m.uri}: 剩余 ${daysLeft(m.expire_time as number)} 天`)
      .join("\n");
    void pushChannels(Store.getSettings().channels, title, content);
  }
  return notified;
}

export function buildMonitor(uri: string, remark = ""): Store.MonitorTarget | null {
  const norm = normalizeUri(uri);
  if (!norm) return null;
  const domain = registeredDomain(norm.host);
  return {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    uri: norm.uri,
    host: norm.host,
    domain,
    sub: norm.host === domain ? "@" : norm.host.replace(`.${domain}`, ""),
    remark: remark || "",
    expire_time: null,
    checked_at: null,
    last_error: null,
  };
}

export { sleep };
