/* ============================================================
 * store.ts - 数据层
 *  - localStorage 持久化（面板每插件独立分区）
 *  - 账号凭据：PBKDF2 + AES-GCM 加密存储
 *  - 工作区协同：把监控目标/配置镜像到工作区 super-domain-man/*.json
 *  - React 集成：useSyncExternalStore 订阅（任意写操作 bump 版本号）
 * ============================================================ */
import * as C from "./crypto";
import { uid, Thresholds } from "./util";

const K = {
  master: "sdm.master",
  settings: "sdm.settings",
  notifications: "sdm.notifications",
  monitors: "sdm.monitors",
  certs: "sdm.certs",
  domainsCache: "sdm.domainsCache",
  zonesCache: "sdm.zonesCache",
};

/* ------------------------------ React 订阅 ------------------------------ */

let version = 0;
const listeners = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getVersion(): number {
  return version;
}

function bump(): void {
  version++;
  listeners.forEach((f) => f());
}

/* ------------------------------ 基础存取 ------------------------------ */

export function get<T = unknown>(key: string, dflt: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? dflt : (JSON.parse(raw) as T);
  } catch {
    return dflt;
  }
}

export function set(key: string, val: unknown): void {
  localStorage.setItem(key, JSON.stringify(val));
  bump();
}

export function remove(key: string): void {
  localStorage.removeItem(key);
  bump();
}

/* ------------------------------ 主题 ------------------------------ */

export function applyTheme(theme: string): void {
  const t =
    theme === "light"
      ? "light"
      : theme === "system"
        ? window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : "dark";
  document.documentElement.setAttribute("data-theme", t);
}

/* ------------------------------ 设置 ------------------------------ */

export interface Settings {
  theme: string;
  noticeDays: number;
  warningDays: number;
  criticalDays: number;
  intervalHours: number;
  channels: Record<string, Record<string, unknown> & { enabled?: boolean }>;
}

const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  noticeDays: 30,
  warningDays: 10,
  criticalDays: 5,
  intervalHours: 6,
  channels: {},
};

export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...get<Partial<Settings>>(K.settings, {}) };
}

export function saveSettings(partial: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...partial };
  set(K.settings, next);
  if (partial.theme !== undefined) applyTheme(next.theme);
  return next;
}

export function getThresholds(): Thresholds {
  const s = getSettings();
  return { notice: s.noticeDays, warning: s.warningDays, critical: s.criticalDays };
}

/* ------------------------------ 主密码 ------------------------------ */

let masterKey: CryptoKey | null = null;

export function isMasterSet(): boolean {
  return !!get(K.master, null);
}

export function hasKey(): boolean {
  return !!masterKey;
}

export async function setMaster(password: string): Promise<void> {
  const salt = C.randomBytes(16);
  const iter = 150000;
  const key = await C.pbkdf2(password, salt, iter);
  // 派生密钥不可导出，校验值改用 deriveBits 计算（与 raw key 位相同）
  const bits = await C.pbkdf2Bits(password, salt, iter);
  const verifier = (await C.sha256Hex(bits)).slice(0, 32);
  set(K.master, { salt: C.bytesToB64(salt), iter, verifier });
  masterKey = key;
}

export async function unlock(password: string): Promise<boolean> {
  const meta = get<{ salt: string; iter: number; verifier: string } | null>(K.master, null);
  if (!meta) return false;
  const bits = await C.pbkdf2Bits(password, C.b64ToBytes(meta.salt), meta.iter);
  const verifier = (await C.sha256Hex(bits)).slice(0, 32);
  if (verifier !== meta.verifier) return false;
  masterKey = await C.pbkdf2(password, C.b64ToBytes(meta.salt), meta.iter);
  return true;
}

export function lock(): void {
  masterKey = null;
}

/** 忘记主密码：清空全部本地数据（主密码、账号凭据、缓存、证书、监控目标等）。 */
export function wipeAll(): void {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("sdm.")) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
  masterKey = null;
  bump();
}

function requireKey(): CryptoKey {
  if (!masterKey) throw new Error("请先在设置中解锁主密码");
  return masterKey;
}

/* ------------------------------ 账号 ------------------------------ */

export interface AccountMeta {
  id: string;
  tag: string;
  cloud: string;
  createdAt: number;
}

export interface AccountToken {
  key: string;
  value: string;
}

export function listAccounts(): AccountMeta[] {
  const metas: AccountMeta[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("sdm.accmeta.")) {
      const meta = get<AccountMeta | null>(key, null);
      if (meta) metas.push(meta);
    }
  }
  return metas.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function saveAccount(account: AccountMeta & { tokens: AccountToken[] }): Promise<AccountMeta> {
  const meta: AccountMeta = {
    id: account.id,
    tag: account.tag || "",
    cloud: account.cloud,
    createdAt: account.createdAt || Date.now(),
  };
  const key = requireKey();
  const packed = await C.aesGcmEncrypt(key, JSON.stringify(account.tokens || []));
  set(`sdm.accmeta.${meta.id}`, meta);
  set(`sdm.acc.${meta.id}`, packed);
  return meta;
}

export async function getAccountTokens(accountId: string): Promise<AccountToken[]> {
  const packed = get<string | null>(`sdm.acc.${accountId}`, null);
  if (!packed) return [];
  return JSON.parse(await C.aesGcmDecrypt(requireKey(), packed)) as AccountToken[];
}

export function deleteAccount(accountId: string): void {
  remove(`sdm.accmeta.${accountId}`);
  remove(`sdm.acc.${accountId}`);
}

export function getAccount(id: string): AccountMeta | null {
  return listAccounts().find((a) => a.id === id) || null;
}

/* ------------------------------ 通知 ------------------------------ */

export interface NotificationItem {
  id: string;
  title: string;
  content: string;
  level: string;
  ts: number;
  read: boolean;
}

export function listNotifications(): NotificationItem[] {
  return get<NotificationItem[]>(K.notifications, []).sort((a, b) => b.ts - a.ts);
}

export function addNotification(title: string, content: string, level = "info"): void {
  const list = get<NotificationItem[]>(K.notifications, []);
  list.unshift({ id: uid(), title, content, level, ts: Date.now(), read: false });
  set(K.notifications, list.slice(0, 200));
}

export function markAllRead(): void {
  const list = get<NotificationItem[]>(K.notifications, []);
  for (const n of list) n.read = true;
  set(K.notifications, list);
}

export function clearNotifications(): void {
  set(K.notifications, []);
}

export function unreadCount(): number {
  return get<NotificationItem[]>(K.notifications, []).filter((n) => !n.read).length;
}

/* ------------------------------ 监控目标 ------------------------------ */

export interface MonitorTarget {
  id: string;
  uri: string;
  host: string;
  domain: string;
  sub: string;
  remark: string;
  expire_time: number | null;
  issuer?: string;
  is_wildcard?: boolean;
  checked_at?: number | null;
  last_error?: string | null;
}

export function listMonitors(): MonitorTarget[] {
  return get<MonitorTarget[]>(K.monitors, []);
}

export function saveMonitors(list: MonitorTarget[]): void {
  set(K.monitors, list);
}

/* ------------------------------ 证书 ------------------------------ */

export interface CertRecord {
  id: string;
  createdAt: number;
  domains: string[];
  cert: string;
  privateKey: string;
  csr: string;
  issuer: string;
  notBefore: number;
  notAfter: number;
  keyType: string;
  ca: string;
}

export function listCerts(): CertRecord[] {
  return get<CertRecord[]>(K.certs, []).sort((a, b) => (b.notAfter || 0) - (a.notAfter || 0));
}

export function saveCert(cert: Omit<CertRecord, "id" | "createdAt">): void {
  const list = get<CertRecord[]>(K.certs, []);
  list.unshift({ id: uid(), createdAt: Date.now(), ...cert });
  set(K.certs, list);
}

export function deleteCert(id: string): void {
  set(K.certs, get<CertRecord[]>(K.certs, []).filter((c) => c.id !== id));
}

/* ------------------------------ 域名缓存 ------------------------------ */

export interface DomainItem {
  domain: string;
  cloud: string;
  zone_id?: string;
  expire_time?: string;
  renew_link?: string;
}

export function getDomainsCache(accountId: string): { domains: DomainItem[]; at: number } | null {
  const cache = get<Record<string, { domains: DomainItem[]; at: number }>>(K.domainsCache, {});
  return cache[accountId] || null;
}

export function setDomainsCache(accountId: string, domains: DomainItem[]): void {
  const cache = get<Record<string, { domains: DomainItem[]; at: number }>>(K.domainsCache, {});
  cache[accountId] = { domains, at: Date.now() };
  set(K.domainsCache, cache);
}

export function getZonesCache(accountId: string): { zones: DomainItem[]; at: number } | null {
  const cache = get<Record<string, { zones: DomainItem[]; at: number }>>(K.zonesCache, {});
  return cache[accountId] || null;
}

export function setZonesCache(accountId: string, zones: DomainItem[]): void {
  const cache = get<Record<string, { zones: DomainItem[]; at: number }>>(K.zonesCache, {});
  cache[accountId] = { zones, at: Date.now() };
  set(K.zonesCache, cache);
}

/* ------------------------------ 导出/导入 ------------------------------ */

export async function exportAll(): Promise<string> {
  const data: Record<string, unknown> = {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: listAccounts(),
    settings: getSettings(),
    monitors: listMonitors(),
    certs: listCerts().map((c) => ({ ...c, cert: undefined, key: undefined, csr: undefined })),
    domainsCache: get<Record<string, unknown>>(K.domainsCache, {}),
  };
  for (const a of data.accounts as AccountMeta[]) {
    (a as unknown as Record<string, unknown>).tokensEncrypted = get<string>(`sdm.acc.${a.id}`, "");
  }
  return JSON.stringify(data, null, 2);
}

export async function importAll(jsonText: string): Promise<void> {
  const data = JSON.parse(jsonText) as Record<string, any>;
  if (data.version !== 1) throw new Error("不支持的导出文件版本");
  for (const a of (data.accounts || []) as Array<AccountMeta & { tokensEncrypted?: string }>) {
    if (a.tokensEncrypted) {
      set(`sdm.accmeta.${a.id}`, { id: a.id, tag: a.tag, cloud: a.cloud, createdAt: a.createdAt });
      set(`sdm.acc.${a.id}`, a.tokensEncrypted);
    }
  }
  if (data.monitors) set(K.monitors, data.monitors);
  if (data.settings) saveSettings(data.settings as Partial<Settings>);
  if (data.domainsCache) set(K.domainsCache, data.domainsCache);
}
