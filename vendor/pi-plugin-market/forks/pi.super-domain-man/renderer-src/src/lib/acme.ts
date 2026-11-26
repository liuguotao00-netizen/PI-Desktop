/* ============================================================
 * acme.ts - ACME v2 客户端（浏览器 WebCrypto 实现）
 * 支持：Let's Encrypt / ZeroSSL（EAB）/ Google Trust Services
 * 流程：目录 -> 新账户(JWS+JWK) -> 新订单 -> DNS-01 挑战 ->
 *       respond -> 轮询订单 -> finalize(CSR) -> 下载证书
 * ============================================================ */
import * as C from "./crypto";
import * as D from "./der";
import * as Net from "./net";
import { sleep } from "./util";

export interface CaInfo {
  title: string;
  directory: string;
  needEab: boolean;
  eabHint: string;
}

export const CAs: Record<string, CaInfo> = {
  letsencrypt: {
    title: "Let's Encrypt",
    directory: "https://acme-v02.api.letsencrypt.org/directory",
    needEab: false,
    eabHint: "",
  },
  zerossl: {
    title: "ZeroSSL",
    directory: "https://acme.zerossl.com/v2/DV90",
    needEab: true,
    eabHint: "需在 ZeroSSL Dashboard 生成 EAB Credentials（KID + HMAC Key）",
  },
  google: {
    title: "Google Trust Services",
    directory: "https://acme-v02.api.google.com/directory",
    needEab: false,
    eabHint: "",
  },
};

export interface EabCredential {
  kid: string;
  hmacKey: string;
}

export interface ChallengeInfo {
  domain: string;
  challenge: Record<string, any>;
  txtValue: string;
}

function jwkThumbprint(jwk: Record<string, string>): string {
  const json = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return C.bytesToB64url(C.utf8(json));
}

export class AcmeClient {
  private directoryUrl: string;
  private email: string;
  private eab: EabCredential | null;
  private nonce: string | null = null;
  private kid: string | null = null;
  private accountKey: CryptoKey | null = null;
  private accountPublicKey: CryptoKey | null = null;
  private jwk: Record<string, string> | null = null;
  private directory: Record<string, string> | null = null;
  caTitle: string;

  constructor(caKey: string, email: string, eab: EabCredential | null) {
    this.directoryUrl = CAs[caKey].directory;
    this.caTitle = CAs[caKey].title;
    this.email = email;
    this.eab = eab || null;
  }

  private _b64json(obj: unknown): string {
    return C.bytesToB64url(C.utf8(JSON.stringify(obj)));
  }

  private _setNonce(res: Net.NetResponse): void {
    const n = res.headers["replay-nonce"];
    if (n) this.nonce = n;
  }

  private async _request(method: string, url: string, payload?: string, headers: Record<string, string> = {}, timeoutMs = 30000): Promise<Net.NetResponse> {
    if (payload !== undefined) headers["Content-Type"] = "application/jose+json";
    const res = await Net.request(url, { method, headers, body: payload, timeoutMs });
    this._setNonce(res);
    if (res.status >= 400) {
      let detail = "";
      try {
        const data = JSON.parse(res.bodyText);
        detail = data.detail || (data.error && data.error.detail) || data.title || "";
      } catch {
        detail = res.bodyText.slice(0, 200);
      }
      const err = new Error(`ACME 请求失败（HTTP ${res.status}）：${detail || res.bodyText.slice(0, 200)}`) as Error & { status?: number; bodyText?: string };
      err.status = res.status;
      err.bodyText = res.bodyText;
      throw err;
    }
    return res;
  }

  private async _signJws(payloadObj: unknown, url: string, useKid: boolean, jwk: Record<string, string>): Promise<{ protected: string; payload: string; signature: string }> {
    const protectedHeader: Record<string, unknown> = { alg: "ES256", nonce: this.nonce, url };
    if (useKid) protectedHeader.kid = this.kid;
    else protectedHeader.jwk = jwk;
    const protectedB64 = this._b64json(protectedHeader);
    const payloadB64 = payloadObj === undefined ? "" : this._b64json(payloadObj);
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.accountKey as CryptoKey,
        C.utf8(`${protectedB64}.${payloadB64}`)
      )
    );
    return {
      protected: protectedB64,
      payload: payloadB64,
      signature: C.bytesToB64url(D.ecdsaRawToDer(sig)),
    };
  }

  private async _signedPost(url: string, payloadObj: unknown, useKid = true): Promise<Net.NetResponse> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const jws = await this._signJws(payloadObj, url, useKid, this.jwk as Record<string, string>);
      try {
        return await this._request("POST", url, JSON.stringify(jws), { "Content-Type": "application/jose+json" });
      } catch (e) {
        const err = e as Error & { status?: number; bodyText?: string };
        if (err.status === 400 && err.bodyText && err.bodyText.includes("badNonce")) continue;
        throw e;
      }
    }
    throw new Error("ACME badNonce 重试次数超限");
  }

  async init(): Promise<void> {
    const res = await this._request("GET", this.directoryUrl);
    this.directory = JSON.parse(res.bodyText) as Record<string, string>;
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    this.accountKey = keyPair.privateKey;
    this.accountPublicKey = keyPair.publicKey;
    const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    this.jwk = { crv: jwk.crv as string, kty: jwk.kty as string, x: jwk.x as string, y: jwk.y as string };
  }

  async registerAccount(): Promise<string> {
    const newAccountUrl = this.directory!.newAccount;
    const payload: Record<string, unknown> = { termsOfServiceAgreed: true, contact: [`mailto:${this.email}`] };
    if (this.eab && this.eab.kid && this.eab.hmacKey) {
      const eabKeyBytes = C.b64urlToBytes(this.eab.hmacKey);
      const protectedB64 = this._b64json({ alg: "HS256", kid: this.eab.kid, url: newAccountUrl });
      const payloadB64 = this._b64json(this.jwk);
      const mac = await C.hmacSha256(eabKeyBytes, C.utf8(`${protectedB64}.${payloadB64}`));
      payload.externalAccountBinding = {
        protected: protectedB64,
        payload: payloadB64,
        signature: C.bytesToB64url(mac),
      };
    }
    const res = await this._signedPost(newAccountUrl, payload, false);
    const loc = res.headers.location || res.headers.Location;
    if (!loc) throw new Error("ACME 账户注册失败：未返回账户 URL");
    this.kid = loc;
    return this.kid;
  }

  async newOrder(domains: string[]): Promise<Record<string, any>> {
    const payload = { identifiers: domains.map((d) => ({ type: "dns", value: d })) };
    const res = await this._signedPost(this.directory!.newOrder, payload);
    const order = JSON.parse(res.bodyText) as Record<string, any>;
    order.url = res.headers.location || res.headers.Location;
    return order;
  }

  async requestCertificate(domains: string[]): Promise<{ order: Record<string, any>; challenges: ChallengeInfo[] }> {
    const order = await this.newOrder(domains);
    const challenges: ChallengeInfo[] = [];
    for (const authzUrl of order.authorizations || []) {
      const res = await this._signedPost(authzUrl, {});
      const authz = JSON.parse(res.bodyText) as Record<string, any>;
      const challenge = (authz.challenges || []).find((c: any) => c.type === "dns-01");
      if (!challenge) throw new Error(`未找到 dns-01 挑战（${authz.identifier.value}）`);
      const keyAuth = `${challenge.token}.${jwkThumbprint(this.jwk as Record<string, string>)}`;
      const txtValue = C.bytesToB64url(await C.sha256Bytes(C.utf8(keyAuth)));
      challenges.push({ domain: authz.identifier.value, challenge, txtValue });
    }
    return { order, challenges };
  }

  async respondChallenge(challenge: Record<string, any>): Promise<void> {
    await this._signedPost(challenge.url, {});
  }

  async pollOrder(order: Record<string, any>, maxTries = 30, intervalMs = 4000, onStatus?: (s: string) => void): Promise<Record<string, any>> {
    let current = order;
    for (let i = 0; i < maxTries; i++) {
      if (onStatus) onStatus(current.status || "processing");
      if (current.status === "valid") return current;
      if (current.status === "invalid" || current.status === "revoked") {
        throw new Error(`订单状态为 ${current.status}`);
      }
      await sleep(intervalMs);
      const res = await this._signedPost(current.url, {});
      current = { ...(JSON.parse(res.bodyText) as Record<string, any>), url: current.url };
    }
    throw new Error("订单轮询超时");
  }

  async finalizeOrder(order: Record<string, any>, csrDer: Uint8Array): Promise<Record<string, any>> {
    const payload = { csr: C.bytesToB64url(csrDer) };
    const res = await this._signedPost(order.finalize, payload);
    return { ...(JSON.parse(res.bodyText) as Record<string, any>), url: order.url };
  }

  async downloadCertificate(order: Record<string, any>): Promise<string> {
    const res = await this._request("GET", order.certificate);
    return res.bodyText;
  }

  async finalizeWithKey(order: Record<string, any>, domains: string[], keyType: string): Promise<{
    cert: string; privateKey: string; csr: string; issuer: string; notBefore: number; notAfter: number;
    domains: string[]; keyType: string; ca: string;
  }> {
    let key: CryptoKeyPair;
    let spki: ArrayBuffer;
    let csrDer: Uint8Array;
    if (keyType === "ECC-256" || keyType === "ECC-384") {
      key = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: keyType === "ECC-384" ? "P-384" : "P-256" },
        true,
        ["sign"]
      );
      spki = await crypto.subtle.exportKey("spki", key.publicKey);
      csrDer = await D.buildCsrEcdsa(new Uint8Array(spki), domains, key.privateKey);
    } else {
      const bits = keyType === "RSA-4096" ? 4096 : 2048;
      key = await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign"]
      );
      spki = await crypto.subtle.exportKey("spki", key.publicKey);
      csrDer = await D.buildCsrRsa(new Uint8Array(spki), domains, key.privateKey);
    }
    const finalized = await this.finalizeOrder(order, csrDer);
    const done = await this.pollOrder(finalized, 30, 3000);
    const certPem = await this.downloadCertificate(done);
    const firstPem = certPem.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----";
    const info = D.parseCert(D.pemToDer(firstPem));
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", key.privateKey);
    return {
      cert: certPem,
      privateKey: D.derToPem(new Uint8Array(pkcs8), "PRIVATE KEY"),
      csr: D.derToPem(csrDer, "CERTIFICATE REQUEST"),
      issuer: info.issuer,
      notBefore: info.notBefore,
      notAfter: info.notAfter,
      domains,
      keyType,
      ca: this.caTitle,
    };
  }
}
