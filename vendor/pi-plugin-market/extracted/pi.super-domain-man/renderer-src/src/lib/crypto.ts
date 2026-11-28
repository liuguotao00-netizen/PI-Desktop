/* ============================================================
 * crypto.ts - WebCrypto 封装（HMAC/SHA256/PBKDF2/AES-GCM）
 * 凭据使用 PBKDF2(password, salt) 派生密钥 + AES-GCM 加密存储
 * 注：显式 Bytes = Uint8Array<ArrayBuffer>，兼容 TS5.9 的
 *     BufferSource 严格类型（Uint8Array<ArrayBufferLike> 不匹配）
 * ============================================================ */

const te = new TextEncoder();
const td = new TextDecoder();

export type Bytes = Uint8Array<ArrayBuffer>;

export function bytesToHex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Bytes {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToB64(buf: ArrayBuffer | Uint8Array): string {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b64ToBytes(b64: string): Bytes {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(buf: ArrayBuffer | Uint8Array): string {
  return bytesToB64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(s: string): Bytes {
  return b64ToBytes(s);
}

export function utf8(str: string): Bytes {
  // Uint8Array.from 保证返回 Uint8Array<ArrayBuffer>
  return Uint8Array.from(te.encode(str));
}

export function utf8BytesToStr(bytes: Uint8Array): string {
  return td.decode(bytes);
}

export async function sha256Bytes(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export async function sha256Hex(data: Bytes): Promise<string> {
  return bytesToHex(await sha256Bytes(data));
}

export async function hmacSha256(keyBytes: Bytes, dataBytes: Bytes): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

export async function hmacSha256Hex(keyBytes: Bytes, dataBytes: Bytes): Promise<string> {
  return bytesToHex(await hmacSha256(keyBytes, dataBytes));
}

export async function pbkdf2(password: string, saltBytes: Bytes, iterations: number): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: iterations || 150000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * 派生 256 位原始校验字节（PBKDF2 deriveBits）。
 * 派生密钥不可导出（extractable=false），因此不能用 exportKey("raw")
 * 计算校验值——那必然抛 DOMException。deriveBits 返回与导出 raw key
 * 完全相同的 256 位，可用于主密码校验，且保持密钥不可导出。
 */
export async function pbkdf2Bits(password: string, saltBytes: Bytes, iterations: number): Promise<Bytes> {
  const baseKey = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: saltBytes, iterations: iterations || 150000, hash: "SHA-256" },
      baseKey,
      256
    )
  );
}

export async function aesGcmEncrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(plaintext)));
  return `${bytesToB64(iv)}:${bytesToB64(ct)}`;
}

export async function aesGcmDecrypt(key: CryptoKey, packed: string): Promise<string> {
  const [ivB64, ctB64] = String(packed || "").split(":");
  if (!ivB64 || !ctB64) throw new Error("密文格式错误");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(ivB64) }, key, b64ToBytes(ctB64));
  return utf8BytesToStr(new Uint8Array(pt));
}

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomB64(n?: number): string {
  return bytesToB64(randomBytes(n || 16));
}
