/* ============================================================
 * net.ts - 网络层
 * 在 PI-Desktop 面板中走 window.pluginBridge.invoke("net.fetch", ...)
 * 在预览模式（普通浏览器）下降级为 fetch()
 * ============================================================ */

export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export interface NetRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

export function isHost(): boolean {
  return typeof (window as unknown as { pluginBridge?: { invoke?: unknown } }).pluginBridge?.invoke === "function";
}

function bridge() {
  return (window as unknown as { pluginBridge: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> } }).pluginBridge;
}

export async function request(url: string, opts: NetRequestOptions = {}): Promise<NetResponse> {
  const method = (opts.method || "GET").toUpperCase();
  const headers = opts.headers || {};
  const body = opts.body ?? null;
  const timeoutMs = opts.timeoutMs || 15000;

  if (isHost()) {
    const res = (await bridge().invoke("net.fetch", {
      url,
      method,
      headers,
      body: body === null ? undefined : String(body),
      timeoutMs,
    })) as { status: number; headers?: Record<string, string>; bodyText?: string };
    return { status: res.status, headers: res.headers || {}, bodyText: res.bodyText || "" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : body,
      signal: controller.signal,
    });
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => (h[k] = v));
    return { status: res.status, headers: h, bodyText: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

export async function json<T = unknown>(url: string, opts: NetRequestOptions = {}): Promise<NetResponse & { data: T }> {
  const res = await request(url, opts);
  let data: T;
  try {
    data = res.bodyText ? (JSON.parse(res.bodyText) as T) : (null as T);
  } catch {
    throw new Error(`响应不是合法 JSON（HTTP ${res.status}）`);
  }
  return { ...res, data };
}

export async function post(url: string, body: string | object, opts: NetRequestOptions = {}): Promise<NetResponse> {
  return request(url, {
    ...opts,
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
}
