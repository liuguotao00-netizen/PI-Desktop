/* ============================================================
 * der.ts - 最小 ASN.1 DER 编解码 + CSR 构建 + 证书解析
 * 用于 ACME 流程（JWS 签名 DER 化、PKCS#10 CSR、证书有效期提取）
 * ============================================================ */
import * as C from "./crypto";

const TAG = {
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  UTCTime: 0x17,
  GeneralizedTime: 0x18,
};

export type DerNode = {
  tag: number;
  content: Uint8Array;
  children: DerNode[] | null;
  start: number;
  end: number;
};

/* ------------------------------ 编码 ------------------------------ */

function lenBytes(len: number): number[] {
  if (len < 0x80) return [len];
  const out: number[] = [];
  let n = len;
  while (n > 0) {
    out.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return [0x80 | out.length, ...out];
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  return new Uint8Array([tag, ...lenBytes(content.length), ...content]);
}

export function seq(...items: Uint8Array[]): Uint8Array {
  return tlv(TAG.SEQUENCE, concat(items));
}

export function set(...items: Uint8Array[]): Uint8Array {
  return tlv(TAG.SET, concat(items));
}

function concat(items: Uint8Array[]): Uint8Array {
  const total = items.reduce((n, i) => n + i.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const i of items) {
    out.set(i, p);
    p += i.length;
  }
  return out;
}

export function intFromBytes(bytes: Uint8Array): Uint8Array {
  let b = bytes;
  while (b.length > 1 && b[0] === 0) b = b.slice(1);
  if (b.length && b[0] & 0x80) b = new Uint8Array([0, ...b]);
  return tlv(TAG.INTEGER, b);
}

export function intFromNum(n: number): Uint8Array {
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return intFromBytes(new Uint8Array(bytes));
}

export function oid(oidStr: string): Uint8Array {
  const parts = oidStr.split(".").map(Number);
  const body: number[] = [];
  body.push(parts[0] * 40 + parts[1]);
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    body.push(...stack);
  }
  return tlv(TAG.OID, new Uint8Array(body));
}

export function utf8Str(s: string): Uint8Array {
  return tlv(TAG.UTF8, C.utf8(s));
}

function ia5StrBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

export function bitString(content: Uint8Array, unused = 0): Uint8Array {
  return tlv(TAG.BIT_STRING, new Uint8Array([unused, ...content]));
}

export function octetString(content: Uint8Array): Uint8Array {
  return tlv(TAG.OCTET_STRING, content);
}

export function context(tag: number, content: Uint8Array): Uint8Array {
  return tlv(0xa0 | tag, content);
}

// ECDSA raw (r||s) -> DER SEQUENCE{INTEGER r, INTEGER s}
export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  const half = Math.floor(raw.length / 2);
  return seq(intFromBytes(raw.slice(0, half)), intFromBytes(raw.slice(half)));
}

function dnsSan(names: string[]): Uint8Array {
  // GeneralName dNSName：[2] IMPLICIT IA5String（tag 0x82 + 原始 ASCII 字节）
  const items = names.map((n) => tlv(0x82, ia5StrBytes(n)));
  return seq(...items);
}

/* ------------------------------ 解码 ------------------------------ */

function parseOneAt(data: Uint8Array, start: number): DerNode {
  let p = start;
  const tag = data[p++];
  let len = data[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + data[p++];
  }
  const contentStart = p;
  const content = data.slice(p, p + len);
  p += len;
  const node: DerNode = { tag, content, children: null, start, end: p };
  if (tag & 0x20) {
    node.children = [];
    let q = 0;
    while (q < content.length) {
      const child = parseOneAt(content, q);
      // 子节点偏移相对 content 子数组，转成相对最外层数组
      child.start += contentStart;
      child.end += contentStart;
      node.children.push(child);
      q += child.end - child.start;
    }
  }
  return node;
}

export function read(derBytes: Uint8Array): DerNode {
  return parseOneAt(new Uint8Array(derBytes), 0);
}

function nodeText(node: DerNode): string {
  return C.utf8BytesToStr(node.content);
}

// 解码 DER OID 编码（base-128）为点分字符串
export function oidToStr(content: Uint8Array): string {
  if (content.length === 0) return "";
  let out = "";
  const first = content[0];
  out += Math.floor(first / 40) + "." + (first % 40);
  let value = 0;
  for (let i = 1; i < content.length; i++) {
    value = value * 128 + (content[i] & 0x7f);
    if (!(content[i] & 0x80)) {
      out += "." + value;
      value = 0;
    }
  }
  return out;
}

function parseAsn1Time(node: DerNode): number {
  const s = nodeText(node);
  if (node.tag === TAG.UTCTime) {
    const yy = parseInt(s.slice(0, 2), 10);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return Date.parse(`${year}-${s.slice(2, 4)}-${s.slice(4, 6)}T${s.slice(6, 8)}:${s.slice(8, 10)}:${s.slice(10, 12)}Z`);
  }
  return Date.parse(s);
}

function findOidValue(rdnNode: DerNode, targetOid: string): string {
  const scan = (node: DerNode, out: string[]): string[] => {
    if (!node.children) return out;
    for (const ch of node.children) {
      if (!ch.children || ch.children.length < 2) {
        scan(ch, out);
        continue;
      }
      const oidNode = ch.children[0];
      if (oidNode.tag === TAG.OID && oidNode.children === null) {
        if (oidToStr(oidNode.content) === targetOid) out.push(nodeText(ch.children[1]));
      } else {
        scan(ch, out);
      }
    }
    return out;
  };
  return scan(rdnNode, []).join(" / ");
}

/* ------------------------------ 证书解析 ------------------------------ */

export function parseCert(derBytes: Uint8Array): {
  serialHex: string;
  issuer: string;
  subject: string;
  notBefore: number;
  notAfter: number;
} {
  const cert = read(derBytes);
  const tbs = cert.children ? cert.children[0] : null;
  if (!tbs || !tbs.children) throw new Error("证书结构错误");

  let idx = 0;
  if (tbs.children[0] && (tbs.children[0].tag & 0x20) && (tbs.children[0].tag & 0x1f) === 0) idx = 1;
  const serial = tbs.children[idx];
  const issuer = tbs.children[idx + 2];
  const validity = tbs.children[idx + 3];
  const subject = tbs.children[idx + 4];
  if (!validity || !validity.children) throw new Error("证书有效性字段缺失");

  return {
    serialHex: C.bytesToHex(serial.content),
    issuer: findOidValue(issuer, "2.5.4.10") || findOidValue(issuer, "2.5.4.3"),
    subject: findOidValue(subject, "2.5.4.3"),
    notBefore: parseAsn1Time(validity.children[0]),
    notAfter: parseAsn1Time(validity.children[1]),
  };
}

export function pemToDer(pem: string): Uint8Array {
  const b64 = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return C.b64ToBytes(b64);
}

export function derToPem(der: Uint8Array, label: string): string {
  const b64 = C.bytesToB64(der).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
}

/* ------------------------------ CSR 构建 ------------------------------ */

const OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const OID_EXTENSION_REQUEST = "1.2.840.113549.1.9.14";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";

function buildCsrInfo(spkiDer: Uint8Array, dnsNames: string[]): Uint8Array {
  const version = intFromNum(0);
  const subject = seq();
  const sanExt = seq(oid(OID_SUBJECT_ALT_NAME), octetString(dnsSan(dnsNames)));
  const attr = seq(oid(OID_EXTENSION_REQUEST), set(sanExt));
  // RFC 2986: attributes [0] IMPLICIT SET OF Attribute（内容直接是 Attribute 序列）
  const attributes = context(0, attr);
  return seq(version, subject, spkiDer, attributes);
}

async function signAndWrapCsr(
  csrInfo: Uint8Array,
  sigAlgOid: string,
  privateKey: CryptoKey,
  sigParams: { name: string; hash: string }
): Promise<Uint8Array> {
  const sig = new Uint8Array(await crypto.subtle.sign(sigParams as AlgorithmIdentifier, privateKey, csrInfo as BufferSource));
  const sigDer = sigParams.name === "ECDSA" ? ecdsaRawToDer(sig) : sig;
  const alg = seq(oid(sigAlgOid));
  return seq(csrInfo, alg, bitString(sigDer));
}

export async function buildCsrEcdsa(
  spkiDer: Uint8Array,
  dnsNames: string[],
  privateKey: CryptoKey
): Promise<Uint8Array> {
  const csrInfo = buildCsrInfo(spkiDer, dnsNames);
  return signAndWrapCsr(csrInfo, OID_ECDSA_WITH_SHA256, privateKey, { name: "ECDSA", hash: "SHA-256" });
}

export async function buildCsrRsa(
  spkiDer: Uint8Array,
  dnsNames: string[],
  privateKey: CryptoKey
): Promise<Uint8Array> {
  const csrInfo = buildCsrInfo(spkiDer, dnsNames);
  return signAndWrapCsr(csrInfo, OID_SHA256_WITH_RSA, privateKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" });
}
