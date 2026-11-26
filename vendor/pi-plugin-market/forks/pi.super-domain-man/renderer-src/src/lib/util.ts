/* ============================================================
 * util.ts - 通用工具 + Toast/Confirm/Prompt 命令式队列
 * （React 组件通过 ToastHost / AskHost 渲染这些队列）
 * ============================================================ */

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function fmtDate(ts?: number | null): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDateTime(ts?: number | null): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function daysLeft(expiry: number): number {
  return Math.floor((expiry - Date.now()) / 86400000);
}

/* ------------------------------ 域名工具 ------------------------------ */

const TWO_LEVEL_SUFFIXES = new Set([
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn", "co.uk",
  "org.uk", "me.uk", "com.au", "net.au", "org.au", "co.jp", "ne.jp",
  "or.jp", "com.tw", "com.hk", "com.sg", "com.mx", "com.br", "net.br",
  "org.br", "co.in", "net.in", "org.in", "com.tr", "com.pl", "com.ru",
  "co.kr", "or.kr", "com.ua", "com.ar", "com.ve", "com.co", "com.pe",
]);

export function registeredDomain(host: string): string {
  host = String(host || "").toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_LEVEL_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

export function hostFromUri(uri: string): string {
  let h = String(uri || "").trim();
  if (h.includes("://")) h = h.split("://")[1];
  if (h.includes("/")) h = h.split("/")[0];
  if (h.includes("?")) h = h.split("?")[0];
  return h.replace(/:(\d+)$/, "");
}

export function subFromHost(host: string, domain: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  const d = String(domain || "").toLowerCase().replace(/\.$/, "");
  if (h === d) return "@";
  if (h.endsWith("." + d)) return h.slice(0, -(d.length + 1));
  return h;
}

export interface RecordInput {
  name: string;
  type: string;
  value: string;
  ttl?: number;
  mx?: number;
  remark?: string;
}

export function parseLinesToRecords(text: string): RecordInput[] {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as RecordInput[];
    } catch {
      throw new Error("JSON 格式错误");
    }
  }
  const records: RecordInput[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const rec: RecordInput = { name: parts[0], type: parts[1].toUpperCase(), value: parts.slice(2).join(" ") };
    if (rec.type === "MX") {
      const m = line.match(/\s(\d+)\s+([^\s]+.*)$/);
      if (m) {
        rec.mx = parseInt(m[1], 10);
        rec.value = m[2];
      }
    }
    records.push(rec);
  }
  return records;
}

export function validateRecord(type: string, value: string): string {
  const v = String(value ?? "").trim();
  const ipv4 = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
  const hostname = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/;
  if (type === "A" && !ipv4.test(v)) throw new Error(`A 记录值无效：${v} 不是合法 IPv4`);
  if (type === "AAAA" && !v.includes(":")) throw new Error(`AAAA 记录值无效：${v} 不是合法 IPv6`);
  if (type === "TXT" && v.length > 1024) throw new Error("TXT 记录值过长（超过 1024 字符）");
  if ((type === "CNAME" || type === "NS" || type === "MX") && !hostname.test(v)) {
    throw new Error(`${type} 记录值无效：${v} 不是合法域名`);
  }
  return v;
}

export async function copyText(text: string): Promise<void> {
  const w = window as unknown as { pluginBridge?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> } };
  if (w.pluginBridge?.invoke) {
    await w.pluginBridge.invoke("clipboard.writeText", { text: String(text) });
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(String(text));
  }
}

export async function readClipboard(): Promise<string> {
  const w = window as unknown as { pluginBridge?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> } };
  if (w.pluginBridge?.invoke) {
    return (await w.pluginBridge.invoke("clipboard.readText")) as string;
  }
  return navigator.clipboard.readText();
}

export function openExternal(url: string): void {
  const w = window as unknown as { pluginBridge?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> } };
  if (w.pluginBridge?.invoke) {
    void w.pluginBridge.invoke("shell.openExternal", { url });
  } else {
    window.open(url, "_blank");
  }
}

/* ------------------------------ 证书状态 ------------------------------ */

export type Level = "ok" | "notice" | "warning" | "error" | "unknown" | "info";

export interface Thresholds {
  notice: number;
  warning: number;
  critical: number;
}

export function expiryLevel(expiry: number | null | undefined, t?: Thresholds): Level {
  if (!expiry) return "unknown";
  const d = daysLeft(expiry);
  const th = t || { notice: 30, warning: 10, critical: 5 };
  if (d <= th.critical) return "error";
  if (d <= th.warning) return "warning";
  if (d <= th.notice) return "notice";
  return "ok";
}

/* ------------------------------ Toast 队列 ------------------------------ */

export interface ToastItem {
  id: string;
  msg: string;
  isErr: boolean;
}

let toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();

export function toast(msg: string, isErr = false): void {
  const item: ToastItem = { id: uid(), msg, isErr };
  toasts = [...toasts, item];
  emit(toastListeners);
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== item.id);
    emit(toastListeners);
  }, isErr ? 4200 : 2600);
}

export function getToasts(): ToastItem[] {
  return toasts;
}

export function subscribeToasts(fn: () => void): () => void {
  toastListeners.add(fn);
  return () => toastListeners.delete(fn);
}

/* ------------------------------ Confirm / Prompt 队列 ------------------------------ */

export interface AskItem {
  id: string;
  kind: "confirm" | "prompt";
  message: string;
  title: string;
  def?: string;
  resolve: (value: string | boolean | null) => void;
}

let asks: AskItem[] = [];
const askListeners = new Set<() => void>();

export function confirmBox(message: string, title = "确认操作"): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    asks = [...asks, { id: uid(), kind: "confirm", message, title, resolve: resolve as (v: string | boolean | null) => void }];
    emit(askListeners);
  });
}

export function promptBox(message: string, def = "", title = "输入"): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    asks = [...asks, { id: uid(), kind: "prompt", message, title, def, resolve: resolve as (v: string | boolean | null) => void }];
    emit(askListeners);
  });
}

export function getAsks(): AskItem[] {
  return asks;
}

export function resolveAsk(id: string, value: string | boolean | null): void {
  const item = asks.find((a) => a.id === id);
  if (!item) return;
  item.resolve(value);
  asks = asks.filter((a) => a.id !== id);
  emit(askListeners);
}

export function subscribeAsks(fn: () => void): () => void {
  askListeners.add(fn);
  return () => askListeners.delete(fn);
}

function emit(listeners: Set<() => void>): void {
  listeners.forEach((f) => f());
}
