/* ============================================================
 * providers.ts - 云厂商 DNS API 适配器
 * 移植自 domain-helper/src/service/*（MIT），签名算法保持一致：
 *   阿里云 ACS3-HMAC-SHA256 / 腾讯云 TC3-HMAC-SHA256 /
 *   Cloudflare Bearer / AWS SigV4 (Route53) / 火山引擎 HMAC-SHA256 /
 *   华为云 IAM Token + REST（Node crypto 替换为 WebCrypto）
 * ============================================================ */
import * as C from "./crypto";
import * as Store from "./store";
import * as Net from "./net";

/* ------------------------------ 元数据 ------------------------------ */

export interface ProviderTokenDef {
  key: string;
  label: string;
  secret: boolean;
}

export interface ProviderMeta {
  key: string;
  title: string;
  tokens: ProviderTokenDef[];
  ttl: { min: number; max: number; def: number } | null;
  mx: { min: number; max: number; def: number } | null;
  supportsStatus: boolean;
  note?: string;
}

export const META: ProviderMeta[] = [
  {
    key: "ali", title: "阿里云",
    tokens: [
      { key: "accessKeyId", label: "AccessKey ID", secret: false },
      { key: "accessKeySecret", label: "AccessKey Secret", secret: true },
    ],
    ttl: { min: 600, max: 86400, def: 600 }, mx: { min: 1, max: 50, def: 10 }, supportsStatus: true,
  },
  {
    key: "tencent", title: "腾讯云",
    tokens: [
      { key: "secretId", label: "Secret ID", secret: false },
      { key: "secretKey", label: "Secret Key", secret: true },
    ],
    ttl: { min: 600, max: 604800, def: 600 }, mx: { min: 1, max: 20, def: 10 }, supportsStatus: true,
  },
  {
    key: "cloudflare", title: "Cloudflare",
    tokens: [
      { key: "apiToken", label: "API Token（推荐）", secret: true },
      { key: "email", label: "EMAIL（旧版）", secret: false },
      { key: "apiKey", label: "API Key（旧版）", secret: true },
    ],
    ttl: { min: 60, max: 86400, def: 600 }, mx: { min: 0, max: 65535, def: 100 }, supportsStatus: false,
    note: "Token 与 Key/Email 二选一，优先使用 Token；Token 需具备 Zone → DNS 读/编辑权限",
  },
  {
    key: "aws", title: "AWS Route53",
    tokens: [
      { key: "accessKeyId", label: "Access key ID", secret: false },
      { key: "secretAccessKey", label: "Secret access key", secret: true },
    ],
    ttl: { min: 60, max: 86400, def: 300 }, mx: null, supportsStatus: false,
  },
  {
    key: "volcengine", title: "火山引擎",
    tokens: [
      { key: "accessKeyId", label: "Access Key ID", secret: false },
      { key: "secretAccessKey", label: "Secret Access Key", secret: true },
    ],
    ttl: { min: 60, max: 86400, def: 600 }, mx: null, supportsStatus: true,
  },
  {
    key: "huawei", title: "华为云",
    tokens: [
      { key: "domainName", label: "主账号", secret: false },
      { key: "username", label: "IAM 账号", secret: false },
      { key: "password", label: "IAM 账号密码", secret: true },
    ],
    ttl: null, mx: null, supportsStatus: true,
  },
];

export function metaOf(cloud: string): ProviderMeta | null {
  return META.find((m) => m.key === cloud) || null;
}

/* ------------------------------ 通用类型 ------------------------------ */

export interface DnsRecord {
  RecordId: string;
  Name: string;
  Value: string;
  TTL?: number | string;
  Type: string;
  Status?: boolean;
  Remark?: string;
  MX?: number | string;
  RecordLine?: string;
  ProxyStatus?: boolean;
  Line?: string;
}

export interface RecordListResult {
  count: number;
  list: DnsRecord[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface RecordDraft {
  id?: string;
  name: string;
  type: string;
  value: string;
  ttl?: number;
  mx?: number;
  remark?: string;
  line?: string;
  proxied?: boolean;
}

export interface DnsProvider {
  listDomains(): Promise<Store.DomainItem[]>;
  listRecords(domain: string, options?: Record<string, unknown>): Promise<RecordListResult>;
  addRecord(domain: string, record: RecordDraft): Promise<unknown>;
  updateRecord(domain: string, record: RecordDraft): Promise<unknown>;
  deleteRecord(domain: string, recordId: string, record?: DnsRecord): Promise<unknown>;
  changeRecordStatus?(domain: string, recordId: string, enable: boolean): Promise<unknown>;
}

/* ============================ 阿里云 ============================ */

class AliDnsService implements DnsProvider {
  private accessKeyId: string;
  private accessKeySecret: string;
  private apiBase = "alidns.aliyuncs.com";
  private version = "2015-01-09";

  constructor(tokens: Record<string, string>) {
    this.accessKeyId = tokens.accessKeyId || "";
    this.accessKeySecret = tokens.accessKeySecret || "";
  }

  async listDomains(): Promise<Store.DomainItem[]> {
    const res = await this.getDomainsData(1, 100);
    if (!res || res.TotalCount === 0) return [];
    const totalPages = Math.ceil(res.TotalCount / 100);
    let domains: Array<{ DomainName: string }> = res.Domains.Domain || [];
    for (let i = 2; i <= totalPages; i++) {
      const page = await this.getDomainsData(i, 100);
      domains = domains.concat(page.Domains.Domain || []);
    }
    let expMap: Record<string, string> = {};
    try {
      this.apiBase = "domain.aliyuncs.com";
      this.version = "2018-01-29";
      let page = 1;
      for (;;) {
        const payload = await this._buildQuery("QueryDomainList", { PageSize: 500, PageNum: page });
        const r = await this._aliRest("QueryDomainList", payload);
        for (const d of r.Data.Domain || []) expMap[d.DomainName] = d.ExpirationDate;
        if (r.NextPage === false) break;
        page++;
      }
    } catch {
      /* 到期信息可选 */
    } finally {
      this.apiBase = "alidns.aliyuncs.com";
      this.version = "2015-01-09";
    }
    return domains
      .filter((d) => expMap[d.DomainName] === undefined || expMap[d.DomainName])
      .map((d) => ({
        domain: d.DomainName,
        cloud: "ali",
        expire_time: expMap[d.DomainName] || "",
        renew_link: expMap[d.DomainName] ? "https://dc.console.aliyun.com/#/domain-list/all" : "",
      }));
  }

  private async getDomainsData(PageNumber: number, PageSize: number): Promise<any> {
    const payload = await this._buildQuery("DescribeDomains", { PageSize, PageNumber });
    return this._aliRest("DescribeDomains", payload);
  }

  async listRecords(domain: string, options: Record<string, unknown> = {}): Promise<RecordListResult> {
    const hasOptions = Object.keys(options).length > 0;
    const page = Math.max(parseInt(String(options.page || 1), 10), 1);
    const pageSize = Math.max(parseInt(String(options.pageSize || (hasOptions ? 20 : 500)), 10), 1);
    const params: Record<string, unknown> = { DomainName: domain, PageSize: pageSize, PageNumber: page };
    if (options.keyword) params.RRKeyWord = options.keyword;
    const payload = await this._buildQuery("DescribeDomainRecords", params);
    const res = await this._aliRest("DescribeDomainRecords", payload);
    if (res.TotalCount === 0) return { count: 0, list: [], page, pageSize, hasMore: false };
    const list: DnsRecord[] = (res.DomainRecords.Record || []).map((item: any) => ({
      RecordId: item.RecordId, Name: item.RR, Value: item.Value, TTL: item.TTL,
      Type: item.Type, Status: item.Status === "ENABLE", Remark: item.Remark || "", MX: item.Priority || "",
    }));
    return { count: res.TotalCount, list, page, pageSize, hasMore: page * pageSize < res.TotalCount };
  }

  async addRecord(domain: string, record: RecordDraft): Promise<unknown> {
    const formData: Record<string, unknown> = {
      DomainName: domain, RR: record.name, Type: record.type, Value: record.value, TTL: record.ttl || 600,
    };
    if (record.type === "MX") formData.Priority = record.mx || 10;
    const payload = await this._buildQuery("AddDomainRecord", formData);
    const res = await this._aliRest("AddDomainRecord", payload);
    if (record.remark) await this.updateRecordRemark(res.RecordId, record.remark);
    return res;
  }

  private async updateRecordRemark(recordId: string, remark: string): Promise<unknown> {
    const payload = await this._buildQuery("UpdateDomainRecordRemark", {
      RecordId: recordId,
      Remark: String(remark || "").replace(/[!~*'()_.-]/g, " "),
    });
    return this._aliRest("UpdateDomainRecordRemark", payload);
  }

  async updateRecord(domain: string, record: RecordDraft): Promise<unknown> {
    const { list } = await this.listRecords(domain);
    const old = list.find((r) => r.RecordId === record.id);
    if (!old) throw new Error("未找到记录");
    const formData: Record<string, unknown> = {
      RecordId: record.id, RR: record.name, Type: record.type, Value: record.value, TTL: record.ttl || 600,
    };
    if (record.type === "MX") formData.Priority = record.mx || 10;
    if (
      old.Name !== record.name || old.Type !== record.type || old.Value !== record.value ||
      old.TTL !== record.ttl || (record.type === "MX" && String(old.MX) !== String(record.mx || 10))
    ) {
      const payload = await this._buildQuery("UpdateDomainRecord", formData);
      await this._aliRest("UpdateDomainRecord", payload);
    }
    if (String(old.Remark || "") !== String(record.remark || "")) {
      await this.updateRecordRemark(record.id as string, record.remark || "");
    }
    return;
  }

  async deleteRecord(domain: string, recordId: string): Promise<unknown> {
    const payload = await this._buildQuery("DeleteDomainRecord", { RecordId: recordId });
    return this._aliRest("DeleteDomainRecord", payload);
  }

  async changeRecordStatus(domain: string, recordId: string, enable: boolean): Promise<unknown> {
    const payload = await this._buildQuery("SetDomainRecordStatus", {
      RecordId: recordId, Status: enable ? "Enable" : "Disable",
    });
    return this._aliRest("SetDomainRecordStatus", payload);
  }

  private async _buildQuery(action: string, params: Record<string, unknown>): Promise<{ headers: Record<string, string>; query: string }> {
    const headers: Record<string, string> = {
      host: this.apiBase,
      "x-acs-action": action,
      "x-acs-version": this.version,
      "x-acs-date": new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      "x-acs-signature-nonce": Math.random().toString(36).slice(2) + Date.now().toString(36),
    };
    const flat: Record<string, string> = {};
    const process = (key: string, value: unknown) => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) value.forEach((v, i) => process(`${key}.${i + 1}`, v));
      else if (typeof value === "object") Object.entries(value as object).forEach(([k, v]) => process(`${key}.${k}`, v));
      else flat[key.startsWith(".") ? key.slice(1) : key] = String(value);
    };
    process("", params);

    const pct = (s: string) => encodeURIComponent(s).replace(/\+/g, "%20").replace(/\*/g, "%2A").replace(/%7E/g, "~");
    const canonicalQueryString = Object.entries(flat)
      .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
      .map(([k, v]) => `${pct(k)}=${pct(v)}`)
      .join("&");

    const hashedPayload = await C.sha256Hex(new Uint8Array(0));
    headers["x-acs-content-sha256"] = hashedPayload;
    const sortedKeys = Object.keys(headers).filter((k) => k.startsWith("x-acs-") || k === "host" || k === "content-type").sort();
    const signedHeaders = sortedKeys.join(";");
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}`).join("\n") + "\n";
    const canonicalRequest = ["GET", "/", canonicalQueryString, canonicalHeaders, signedHeaders, hashedPayload].join("\n");
    const hashedCanonical = await C.sha256Hex(C.utf8(canonicalRequest));
    const stringToSign = `ACS3-HMAC-SHA256\n${hashedCanonical}`;
    const signature = await C.hmacSha256Hex(C.utf8(this.accessKeySecret), C.utf8(stringToSign));
    headers.Authorization = `ACS3-HMAC-SHA256 Credential=${this.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
    return { headers, query: canonicalQueryString };
  }

  private async _aliRest(action: string, { headers, query }: { headers: Record<string, string>; query: string }): Promise<any> {
    const res = await Net.request(`https://${this.apiBase}/?${query}`, {
      method: "GET",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      timeoutMs: 15000,
    });
    let result: any;
    try {
      result = JSON.parse(res.bodyText);
    } catch {
      throw new Error(`API 请求失败（HTTP ${res.status}）`);
    }
    if (result.Code) throw new Error(result.Message || result.Code);
    return result;
  }
}

/* ============================ 腾讯云 ============================ */

class TencentDnsService implements DnsProvider {
  private secretId: string;
  private secretKey: string;

  constructor(tokens: Record<string, string>) {
    this.secretId = tokens.secretId || "";
    this.secretKey = tokens.secretKey || "";
  }

  private async _rest(service: string, action: string, payload: string, version: string): Promise<any> {
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().split("T")[0];
    const canonicalHeaders = `content-type:application/json\nhost:${service}.tencentcloudapi.com\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = "content-type;host;x-tc-action";
    const hashedPayload = await C.sha256Hex(C.utf8(payload));
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
    const credentialScope = `${date}/${service}/tc3_request`;
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${await C.sha256Hex(C.utf8(canonicalRequest))}`;
    const secretDate = await C.hmacSha256(C.utf8(`TC3${this.secretKey}`), C.utf8(date));
    const secretService = await C.hmacSha256(secretDate, C.utf8(service));
    const secretSigning = await C.hmacSha256(secretService, C.utf8("tc3_request"));
    const signature = await C.hmacSha256Hex(secretSigning, C.utf8(stringToSign));
    const authorization = `TC3-HMAC-SHA256 Credential=${this.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const res = await Net.post(`https://${service}.tencentcloudapi.com/`, payload, {
      headers: {
        Authorization: authorization, "X-TC-Version": version, "X-TC-Timestamp": String(timestamp),
        "X-TC-Action": action, "Content-Type": "application/json",
      },
      timeoutMs: 15000,
    });
    let body: any;
    try {
      body = JSON.parse(res.bodyText);
    } catch {
      throw new Error(`API 请求失败（HTTP ${res.status}）`);
    }
    if (body.Response && body.Response.Error) throw new Error(body.Response.Error.Message || "腾讯云 API 错误");
    return body.Response || body;
  }

  async listDomains(): Promise<Store.DomainItem[]> {
    let myDomains: Array<{ DomainName: string; ExpirationDate: string }> = [];
    try {
      const r = await this._rest("domain", "DescribeDomainNameList", JSON.stringify({ Limit: 100 }), "2018-08-08");
      myDomains = r.DomainSet || [];
    } catch {
      /* 可选 */
    }
    const r = await this._rest("dnspod", "DescribeDomainList", JSON.stringify({ Limit: 3000 }), "2021-03-23");
    return (r.DomainList || [])
      .filter((d: any) => d.Status === "ENABLE")
      .map((d: any) => {
        const exp = myDomains.find((m) => m.DomainName === d.Name);
        return {
          domain: d.Name, cloud: "tencent", expire_time: exp ? exp.ExpirationDate : "",
          renew_link: exp ? "https://console.cloud.tencent.com/domain/all-domain/all" : "",
        };
      });
  }

  async listRecords(domain: string, options: Record<string, unknown> = {}): Promise<RecordListResult> {
    const hasOptions = Object.keys(options).length > 0;
    const page = Math.max(parseInt(String(options.page || 1), 10), 1);
    const pageSize = Math.max(parseInt(String(options.pageSize || (hasOptions ? 20 : 3000)), 10), 1);
    const params: Record<string, unknown> = { Domain: domain, Limit: pageSize, Offset: (page - 1) * pageSize };
    if (options.keyword) params.Keyword = options.keyword;
    const r = await this._rest("dnspod", "DescribeRecordList", JSON.stringify(params), "2021-03-23");
    const count = r.RecordCountInfo ? r.RecordCountInfo.TotalCount || 0 : 0;
    const list: DnsRecord[] = (r.RecordList || []).map((item: any) => ({
      RecordId: item.RecordId, Name: item.Name, Value: item.Value, TTL: item.TTL, Type: item.Type,
      Status: item.Status === "ENABLE", Remark: item.Remark || "", MX: item.MX, RecordLine: item.Line,
    }));
    return { count, list, page, pageSize, hasMore: page * pageSize < count };
  }

  async addRecord(domain: string, record: RecordDraft): Promise<unknown> {
    const formData: Record<string, unknown> = {
      Domain: domain, SubDomain: record.name, RecordType: record.type, RecordLine: record.line || "默认",
      Value: record.value, Remark: record.remark || "", TTL: record.ttl || 600,
    };
    if (record.type === "MX") formData.MX = record.mx || 10;
    return this._rest("dnspod", "CreateRecord", JSON.stringify(formData), "2021-03-23");
  }

  async updateRecord(domain: string, record: RecordDraft): Promise<unknown> {
    const { list } = await this.listRecords(domain);
    const old = list.find((r) => r.RecordId === record.id);
    const formData: Record<string, unknown> = {
      Domain: domain, SubDomain: record.name, RecordId: record.id, RecordType: record.type,
      RecordLine: record.line || (old && old.RecordLine) || "默认", Value: record.value,
      Remark: record.remark || "", TTL: record.ttl || 600,
    };
    if (record.type === "MX") formData.MX = record.mx || 10;
    return this._rest("dnspod", "ModifyRecord", JSON.stringify(formData), "2021-03-23");
  }

  async deleteRecord(domain: string, recordId: string): Promise<unknown> {
    return this._rest("dnspod", "DeleteRecord", JSON.stringify({ Domain: domain, RecordId: recordId }), "2021-03-23");
  }

  async changeRecordStatus(domain: string, recordId: string, enable: boolean): Promise<unknown> {
    return this._rest(
      "dnspod", "ModifyRecordStatus",
      JSON.stringify({ Domain: domain, RecordId: recordId, Status: enable ? "ENABLE" : "DISABLE" }),
      "2021-03-23"
    );
  }
}

/* ============================ Cloudflare ============================ */

class CloudflareDnsService implements DnsProvider {
  private apiToken: string;
  private email: string;
  private apiKey: string;
  private accountId: string;

  constructor(tokens: Record<string, string>, accountId: string) {
    this.apiToken = tokens.apiToken || "";
    this.email = tokens.email || "";
    this.apiKey = tokens.apiKey || "";
    this.accountId = accountId;
  }

  private _headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
    else {
      headers["X-Auth-Email"] = this.email;
      headers["X-Auth-Key"] = this.apiKey;
    }
    return headers;
  }

  private async _rest(method: string, endpoint: string, data: unknown = null): Promise<any> {
    const res = await Net.request(`https://api.cloudflare.com${endpoint}`, {
      method,
      headers: this._headers(),
      body: data === null ? null : JSON.stringify(data),
      timeoutMs: 15000,
    });
    let body: any;
    try {
      body = JSON.parse(res.bodyText);
    } catch {
      throw new Error(`Cloudflare API 请求失败（HTTP ${res.status}）`);
    }
    if (!body.success) {
      const errs = (body.errors || []).map((e: any) => e.message).join("; ");
      let msg = errs || "Cloudflare API 错误";
      if (res.status === 403 || /auth|permission|forbidden|权限|鉴权/i.test(msg)) {
        msg += "（请检查 API Token 是否具备 Zone → DNS 读/编辑权限，可在 Cloudflare 控制台重新生成 Token）";
      }
      throw new Error(msg);
    }
    return body;
  }

  async listDomains(): Promise<Store.DomainItem[]> {
    const res = await this._rest("GET", "/client/v4/zones?per_page=50");
    return (res.result || [])
      .filter((z: any) => z.status === "active")
      .map((z: any) => ({ domain: z.name, cloud: "cloudflare", zone_id: z.id }));
  }

  private async _zoneId(domain: string): Promise<string> {
    const cache = Store.getZonesCache(this.accountId);
    if (cache?.zones) {
      const hit = cache.zones.find((z) => z.domain === domain && z.zone_id);
      if (hit) return hit.zone_id as string;
    }
    const zones = await this.listDomains();
    Store.setZonesCache(this.accountId, zones);
    const hit = zones.find((z) => z.domain === domain && z.zone_id);
    if (!hit) throw new Error(`未找到区域：${domain}`);
    return hit.zone_id as string;
  }

  private _normName(name: string, domain: string): string {
    if (name === domain) return "@";
    if (name.endsWith(`.${domain}`)) return name.slice(0, -domain.length - 1);
    return name;
  }

  async listRecords(domain: string, options: Record<string, unknown> = {}): Promise<RecordListResult> {
    const hasOptions = Object.keys(options).length > 0;
    const page = Math.max(parseInt(String(options.page || 1), 10), 1);
    const pageSize = Math.max(parseInt(String(options.pageSize || (hasOptions ? 20 : 100)), 10), 1);
    const zoneId = await this._zoneId(domain);
    const map = (r: any): DnsRecord => ({
      RecordId: r.id, Name: this._normName(r.name, domain), Value: r.content, TTL: r.ttl, Type: r.type,
      Status: true, Remark: r.comment || "", MX: r.priority, ProxyStatus: r.proxied,
    });
    if (!hasOptions) {
      let all: any[] = [];
      let currentPage = 1;
      let totalPages = 1;
      while (currentPage <= totalPages) {
        const res = await this._rest("GET", `/client/v4/zones/${zoneId}/dns_records?per_page=${pageSize}&page=${currentPage}`);
        all = all.concat(res.result || []);
        totalPages = res.result_info?.total_pages || 1;
        currentPage++;
      }
      const list = all.map(map);
      return { count: list.length, list, page: 1, pageSize: list.length, hasMore: false };
    }
    let endpoint = `/client/v4/zones/${zoneId}/dns_records?per_page=${pageSize}&page=${page}`;
    if (options.keyword) endpoint += `&search=${encodeURIComponent(String(options.keyword))}`;
    const res = await this._rest("GET", endpoint);
    const list = (res.result || []).map(map);
    return {
      count: res.result_info?.total_count || list.length, list, page, pageSize,
      hasMore: page < (res.result_info?.total_pages || 1),
    };
  }

  async addRecord(domain: string, record: RecordDraft): Promise<unknown> {
    const zoneId = await this._zoneId(domain);
    const formData: Record<string, unknown> = {
      type: record.type, name: record.name === "@" ? "@" : `${record.name}.${domain}`,
      content: record.value, ttl: record.ttl || 600, comment: record.remark || "",
    };
    if (record.type === "MX") formData.priority = record.mx || 100;
    return this._rest("POST", `/client/v4/zones/${zoneId}/dns_records`, formData);
  }

  async updateRecord(domain: string, record: RecordDraft): Promise<unknown> {
    const zoneId = await this._zoneId(domain);
    const formData: Record<string, unknown> = {
      type: record.type, name: record.name === "@" ? "@" : `${record.name}.${domain}`,
      content: record.value, ttl: record.ttl || 600, comment: record.remark || "",
    };
    if (record.type === "MX") formData.priority = record.mx || 100;
    return this._rest("PATCH", `/client/v4/zones/${zoneId}/dns_records/${record.id}`, formData);
  }

  async deleteRecord(domain: string, recordId: string): Promise<unknown> {
    const zoneId = await this._zoneId(domain);
    return this._rest("DELETE", `/client/v4/zones/${zoneId}/dns_records/${recordId}`);
  }
}

/* ============================ AWS Route53 ============================ */

class AwsDnsService implements DnsProvider {
  private accessKeyId: string;
  private secretAccessKey: string;
  private host = "route53.amazonaws.com";
  private accountId: string;

  constructor(tokens: Record<string, string>, accountId: string) {
    this.accessKeyId = tokens.accessKeyId || "";
    this.secretAccessKey = tokens.secretAccessKey || "";
    this.accountId = accountId;
  }

  private async _rest(method: string, endpoint: string, queryString = "", data: string | null = null): Promise<Document> {
    const requestDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = requestDate.slice(0, 8);
    const canonicalHeaders = `host:${this.host}\nx-amz-date:${requestDate}\n`;
    const signedHeaders = "host;x-amz-date";
    const payloadHash = await C.sha256Hex(C.utf8(data || ""));
    const canonicalRequest = `${method}\n/${endpoint}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${date}/us-east-1/route53/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${requestDate}\n${credentialScope}\n${await C.sha256Hex(C.utf8(canonicalRequest))}`;
    const kDate = await C.hmacSha256(C.utf8(`AWS4${this.secretAccessKey}`), C.utf8(date));
    const kRegion = await C.hmacSha256(kDate, C.utf8("us-east-1"));
    const kService = await C.hmacSha256(kRegion, C.utf8("route53"));
    const kSigning = await C.hmacSha256(kService, C.utf8("aws4_request"));
    const signature = await C.hmacSha256Hex(kSigning, C.utf8(stringToSign));
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const res = await Net.request(`https://${this.host}/${endpoint}${queryString ? `?${queryString}` : ""}`, {
      method,
      headers: { "Content-Type": "application/xml", "x-amz-date": requestDate, Authorization: authorization },
      body: data,
      timeoutMs: 20000,
    });
    if (res.status >= 400) {
      const msg = (res.bodyText || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      throw new Error(`Route53 API 错误（HTTP ${res.status}）：${msg.slice(0, 200)}`);
    }
    return new DOMParser().parseFromString(res.bodyText, "text/xml");
  }

  private _unescape(input: string): string {
    return String(input || "").replace(/\\(\d{3})/g, (_m, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  }

  async listDomains(): Promise<Store.DomainItem[]> {
    const doc = await this._rest("GET", "2013-04-01/hostedzone", "maxitems=100");
    const list: Store.DomainItem[] = [];
    for (const z of Array.from(doc.getElementsByTagName("HostedZone"))) {
      const id = z.getElementsByTagName("Id")[0]?.textContent || "";
      const name = (z.getElementsByTagName("Name")[0]?.textContent || "").replace(/\.$/, "");
      if (!id || !name) continue;
      list.push({ domain: name, cloud: "aws", zone_id: id });
    }
    return list;
  }

  private async _zoneId(domain: string): Promise<string> {
    
    const cache = Store.getZonesCache(this.accountId);
    if (cache?.zones) {
      const hit = cache.zones.find((z) => z.domain === domain && z.zone_id);
      if (hit) return hit.zone_id as string;
    }
    const zones = await this.listDomains();
    Store.setZonesCache(this.accountId, zones);
    const hit = zones.find((z) => z.domain === domain && z.zone_id);
    if (!hit) throw new Error(`未找到托管区：${domain}`);
    return hit.zone_id as string;
  }

  async listRecords(domain: string, options: Record<string, unknown> = {}): Promise<RecordListResult> {
    const hasOptions = Object.keys(options).length > 0;
    const page = Math.max(parseInt(String(options.page || 1), 10), 1);
    const pageSize = Math.max(parseInt(String(options.pageSize || (hasOptions ? 20 : 500)), 10), 1);
    const zoneId = await this._zoneId(domain);
    const doc = await this._rest("GET", `2013-04-01${zoneId}/rrset`, "maxitems=500");
    const records: DnsRecord[] = Array.from(doc.getElementsByTagName("ResourceRecordSet")).map((set) => {
      const values = Array.from(set.getElementsByTagName("Value")).map((v) => this._unescape(v.textContent || ""));
      const name = set.getElementsByTagName("Name")[0]?.textContent || "";
      const type = set.getElementsByTagName("Type")[0]?.textContent || "";
      const ttl = set.getElementsByTagName("TTL")[0]?.textContent || "";
      return {
        RecordId: `${name}##${type}##${ttl}##${values.join("\n")}`,
        Name: name.slice(0, -(domain.length + 2)) || "@",
        Type: type, TTL: ttl, Value: values.join("\n"), Status: true, Remark: "", MX: "",
      };
    });
    const start = (page - 1) * pageSize;
    const list = records.slice(start, start + pageSize);
    return { count: records.length, list, page, pageSize, hasMore: start + list.length < records.length };
  }

  private _xmlChange(zoneId: string, action: string, name: string, type: string, ttl: number, values: string[]): string {
    const recordsXml = values.map((v) => `<ResourceRecord><Value>${v}</Value></ResourceRecord>`).join("");
    return `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch><Changes><Change>
    <Action>${action}</Action>
    <ResourceRecordSet>
      <Name>${name}</Name><Type>${type}</Type><TTL>${ttl}</TTL>
      <ResourceRecords>${recordsXml}</ResourceRecords>
    </ResourceRecordSet>
  </Change></Changes></ChangeBatch>
</ChangeResourceRecordSetsRequest>`;
  }

  async addRecord(domain: string, record: RecordDraft): Promise<unknown> {
    const zoneId = await this._zoneId(domain);
    const targetValue = record.type === "TXT" ? `"${record.value}"` : record.value;
    const full = record.name === "@" ? domain : `${record.name}.${domain}`;
    const xml = this._xmlChange(zoneId, "UPSERT", `${full}.`, record.type, record.ttl || 300, [targetValue]);
    return this._rest("POST", `2013-04-01${zoneId}/rrset/`, "", xml);
  }

  async updateRecord(domain: string, record: RecordDraft): Promise<unknown> {
    const { list } = await this.listRecords(domain);
    const old = list.find((r) => r.RecordId === record.id);
    const full = record.name === "@" ? domain : `${record.name}.${domain}`;
    if (old && (old.Name !== record.name || old.Type !== record.type)) {
      await this.deleteRecord(domain, record.id as string);
    }
    const zoneId = await this._zoneId(domain);
    const targetValue = record.type === "TXT" ? `"${record.value}"` : record.value;
    const xml = this._xmlChange(zoneId, "UPSERT", `${full}.`, record.type, record.ttl || 300, [targetValue]);
    return this._rest("POST", `2013-04-01${zoneId}/rrset/`, "", xml);
  }

  async deleteRecord(domain: string, recordId: string, record?: DnsRecord): Promise<unknown> {
    const zoneId = await this._zoneId(domain);
    let target = record;
    if (!target) {
      const { list } = await this.listRecords(domain);
      target = list.find((r) => r.RecordId === recordId);
    }
    if (!target) return;
    const full = `${target.Name}.${domain}.`;
    const values = String(target.Value).split("\n").map((v) => v.trim());
    const xml = this._xmlChange(zoneId, "DELETE", full, target.Type, Number(target.TTL) || 300, values);
    return this._rest("POST", `2013-04-01${zoneId}/rrset/`, "", xml);
  }
}

/* ============================ 火山引擎 ============================ */

class VolcengineDnsService implements DnsProvider {
  private secretId: string;
  private secretKey: string;
  private service = "DNS";
  private region = "cn-north-1";
  private host = "open.volcengineapi.com";
  private version = "2018-08-01";
  private accountId: string;

  constructor(tokens: Record<string, string>, accountId: string) {
    this.secretId = tokens.accessKeyId || "";
    this.secretKey = tokens.secretAccessKey || "";
    this.accountId = accountId;
  }

  private normQuery(params: Record<string, unknown>): string {
    const keys = Object.keys(params).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = params[k];
      if (Array.isArray(v)) for (const item of v) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
      else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    return parts.join("&").replace(/\+/g, "%20");
  }

  private async _request(method: string, query: Record<string, unknown>, action: string, body: Record<string, unknown>): Promise<any> {
    query = { Action: action, Version: this.version, ...query };
    const xDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const shortDate = xDate.slice(0, 8);
    const bodyStr = method === "POST" ? JSON.stringify(body) : "";
    const contentSha256 = await C.sha256Hex(C.utf8(bodyStr));
    const signedHeaders = "content-type;host;x-content-sha256;x-date";
    const canonicalRequest = [
      method, "/", this.normQuery(query),
      `content-type:application/json\nhost:${this.host}\nx-content-sha256:${contentSha256}\nx-date:${xDate}\n`,
      signedHeaders, contentSha256,
    ].join("\n");
    const credentialScope = `${shortDate}/${this.region}/${this.service}/request`;
    const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${await C.sha256Hex(C.utf8(canonicalRequest))}`;
    const kDate = await C.hmacSha256(C.utf8(this.secretKey), C.utf8(shortDate));
    const kRegion = await C.hmacSha256(kDate, C.utf8(this.region));
    const kService = await C.hmacSha256(kRegion, C.utf8(this.service));
    const kSigning = await C.hmacSha256(kService, C.utf8("request"));
    const signature = await C.hmacSha256Hex(kSigning, C.utf8(stringToSign));
    const headers = {
      Host: this.host, "X-Content-Sha256": contentSha256, "X-Date": xDate, "Content-Type": "application/json",
      Authorization: `HMAC-SHA256 Credential=${this.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
    const res = await Net.request(`https://${this.host}/?${this.normQuery(query)}`, {
      method, headers, body: bodyStr || null, timeoutMs: 15000,
    });
    let parsed: any;
    try {
      parsed = JSON.parse(res.bodyText);
    } catch {
      throw new Error(`火山引擎 API 请求失败（HTTP ${res.status}）`);
    }
    if (parsed.ResponseMetadata?.Error) {
      throw new Error(`${parsed.ResponseMetadata.Error.Code}: ${parsed.ResponseMetadata.Error.Message || ""}`);
    }
    return parsed;
  }

  async listDomains(): Promise<Store.DomainItem[]> {
    const r = await this._request("GET", {}, "ListZones", {});
    return ((r.Result && r.Result.Zones) || []).map((z: any) => ({ domain: z.ZoneName, cloud: "volcengine", zone_id: z.ZID }));
  }

  private async _zoneId(domain: string): Promise<string> {
    
    const cache = Store.getZonesCache(this.accountId);
    if (cache?.zones) {
      const hit = cache.zones.find((z) => z.domain === domain && z.zone_id);
      if (hit) return hit.zone_id as string;
    }
    const zones = await this.listDomains();
    Store.setZonesCache(this.accountId, zones);
    const hit = zones.find((z) => z.domain === domain && z.zone_id);
    if (!hit) throw new Error(`未找到 Zone：${domain}`);
    return hit.zone_id as string;
  }

  async listRecords(domain: string, options: Record<string, unknown> = {}): Promise<RecordListResult> {
    const hasOptions = Object.keys(options).length > 0;
    const page = Math.max(parseInt(String(options.page || 1), 10), 1);
    const pageSize = Math.max(parseInt(String(options.pageSize || (hasOptions ? 20 : 500)), 10), 1);
    const zoneId = await this._zoneId(domain);
    const r = await this._request("GET", { ZID: zoneId, PageNumber: page, PageSize: pageSize }, "ListRecords", {});
    const count = (r.Result && r.Result.TotalCount) || 0;
    const list: DnsRecord[] = ((r.Result && r.Result.Records) || []).map((rec: any) => ({
      RecordId: rec.RecordID, Name: rec.Host, Value: rec.Value, TTL: rec.TTL, Type: rec.Type,
      Status: rec.Enable, Remark: rec.Remark || "", MX: "", Line: rec.Line,
    }));
    return { count, list, page, pageSize, hasMore: page * pageSize < count };
  }

  async addRecord(domain: string, record: RecordDraft): Promise<unknown> {
    const zoneId = await this._zoneId(domain);
    return this._request("POST", {}, "CreateRecord", {
      Host: record.name, Value: record.value, Type: record.type, Remark: record.remark || "", ZID: zoneId,
    });
  }

  async updateRecord(domain: string, record: RecordDraft): Promise<unknown> {
    const { list } = await this.listRecords(domain);
    const old = list.find((r) => r.RecordId === record.id);
    return this._request("POST", {}, "UpdateRecord", {
      RecordID: record.id, Host: record.name, Line: old ? old.Line : undefined,
      Value: record.value, Type: record.type, Remark: record.remark || "",
    });
  }

  async deleteRecord(domain: string, recordId: string): Promise<unknown> {
    return this._request("POST", {}, "DeleteRecord", { RecordID: recordId });
  }

  async changeRecordStatus(domain: string, recordId: string, enable: boolean): Promise<unknown> {
    return this._request("POST", {}, "UpdateRecordStatus", { RecordID: recordId, Enable: enable });
  }
}

/* ============================ 华为云 ============================ */

class HuaweiDnsService implements DnsProvider {
  private domainName: string;
  private username: string;
  private password: string;
  private hostname = "dns.ap-southeast-1.myhuaweicloud.com";
  private accountId: string;

  constructor(tokens: Record<string, string>, accountId: string) {
    this.domainName = tokens.domainName || "";
    this.username = tokens.username || "";
    this.password = tokens.password || "";
    this.accountId = accountId;
  }

  private async getToken(): Promise<string> {
    
    const cached = Store.get<{ token: string; expire: number } | null>(`sdm.hw.token.${this.accountId}`, null);
    if (cached && cached.expire > Date.now()) return cached.token;
    const body = JSON.stringify({
      auth: {
        identity: {
          methods: ["password"],
          password: { user: { name: this.username, password: this.password, domain: { name: this.domainName } } },
        },
        scope: { project: { name: "ap-southeast-1" } },
      },
    });
    const res = await Net.request("https://iam.myhuaweicloud.com/v3/auth/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf8" },
      body,
      timeoutMs: 15000,
    });
    const data = JSON.parse(res.bodyText);
    if (data.error) throw new Error(data.error.message || "华为云 IAM 认证失败");
    const token = res.headers["x-subject-token"];
    const expire = Date.parse(data.token.expires_at) - 5 * 60000;
    Store.set(`sdm.hw.token.${this.accountId}`, { token, expire });
    return token;
  }

  private async _rest(method: string, path: string, body: string | null = null): Promise<any> {
    const token = await this.getToken();
    const headers: Record<string, string> = { "X-Auth-Token": token };
    if (body !== null) headers["Content-Type"] = "application/json";
    const res = await Net.request(`https://${this.hostname}${path}`, {
      method, headers, body, timeoutMs: 15000,
    });
    if (res.status >= 400) {
      let msg = `华为云 API 错误（HTTP ${res.status}）`;
      try {
        const data = JSON.parse(res.bodyText);
        msg = data.message || data.error?.message || msg;
      } catch {
        /* 保留默认 */
      }
      throw new Error(msg);
    }
    return res.bodyText ? JSON.parse(res.bodyText) : {};
  }

  async listDomains(): Promise<Store.DomainItem[]> {
    const r = await this._rest("GET", "/v2/zones");
    return (r.zones || [])
      .filter((z: any) => z.status === "ACTIVE")
      .map((z: any) => ({ domain: z.name.replace(/\.$/, ""), cloud: "huawei", zone_id: z.id }));
  }

  private async _zoneId(domain: string): Promise<string> {
    
    const cache = Store.getZonesCache(this.accountId);
    if (cache?.zones) {
      const hit = cache.zones.find((z) => z.domain === domain && z.zone_id);
      if (hit) return hit.zone_id as string;
    }
    const zones = await this.listDomains();
    Store.setZonesCache(this.accountId, zones);
    const hit = zones.find((z) => z.domain === domain && z.zone_id);
    if (!hit) throw new Error(`未找到 Zone：${domain}`);
    return hit.zone_id as string;
  }

  async listRecords(domain: string, options: Record<string, unknown> = {}): Promise<RecordListResult> {
    const hasOptions = Object.keys(options).length > 0;
    const page = Math.max(parseInt(String(options.page || 1), 10), 1);
    const pageSize = Math.max(parseInt(String(options.pageSize || (hasOptions ? 20 : 500)), 10), 1);
    const zoneId = await this._zoneId(domain);
    let path = `/v2/zones/${zoneId}/recordsets?limit=${pageSize}&offset=${(page - 1) * pageSize}`;
    if (options.keyword) path += `&search_mode=equal&tags=${encodeURIComponent(String(options.keyword))}`;
    const r = await this._rest("GET", path);
    const total = r.metadata ? r.metadata.total_count : 0;
    const list: DnsRecord[] = (r.recordsets || []).map((rec: any) => ({
      RecordId: rec.id,
      Name: rec.name === `${domain}.` ? "@" : rec.name.replace(new RegExp(`\\.${domain}\\.$`), ""),
      Value: (rec.records || []).join("\n"), TTL: rec.ttl, Type: rec.type,
      Status: rec.status === "ACTIVE", Remark: rec.description || "", MX: "",
    }));
    return { count: total, list, page, pageSize, hasMore: page * pageSize < total };
  }

  async addRecord(domain: string, record: RecordDraft): Promise<unknown> {
    const zoneId = await this._zoneId(domain);
    let values = [record.value];
    if (record.type === "TXT") values = values.map((v) => `"${v}"`);
    const body = {
      name: record.name === "@" ? domain : `${record.name}.${domain}`,
      type: record.type, records: values, description: record.remark || "",
    };
    return this._rest("POST", `/v2/zones/${zoneId}/recordsets`, JSON.stringify(body));
  }

  async updateRecord(domain: string, record: RecordDraft): Promise<unknown> {
    await this.deleteRecord(domain, record.id as string);
    return this.addRecord(domain, record);
  }

  async deleteRecord(domain: string, recordId: string): Promise<unknown> {
    const zoneId = await this._zoneId(domain);
    return this._rest("DELETE", `/v2/zones/${zoneId}/recordsets/${recordId}`);
  }

  async changeRecordStatus(domain: string, recordId: string, enable: boolean): Promise<unknown> {
    return this._rest(
      "PUT", `/v2.1/recordsets/${recordId}/statuses/set`,
      JSON.stringify({ status: enable ? "ENABLE" : "DISABLE" })
    );
  }
}

/* ------------------------------ 工厂 ------------------------------ */

const REGISTRY: Record<string, new (tokens: Record<string, string>, accountId: string) => DnsProvider> = {
  ali: AliDnsService,
  tencent: TencentDnsService,
  cloudflare: CloudflareDnsService,
  aws: AwsDnsService,
  volcengine: VolcengineDnsService,
  huawei: HuaweiDnsService,
};

export function create(cloud: string, tokensArray: Array<{ key: string; value: string }>, accountId: string): DnsProvider {
  const Cls = REGISTRY[cloud];
  if (!Cls) throw new Error(`不支持的云厂商：${cloud}`);
  const tokens: Record<string, string> = {};
  for (const t of tokensArray || []) tokens[t.key] = t.value ?? "";
  return new Cls(tokens, accountId);
}

export function findZone(domains: Store.DomainItem[], host: string): Store.DomainItem | null {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  let best: Store.DomainItem | null = null;
  for (const d of domains) {
    const zone = String(d.domain || "").toLowerCase().replace(/\.$/, "");
    if (h === zone || h.endsWith("." + zone)) {
      if (!best || zone.length > (best.domain || "").length) best = { ...d, domain: zone };
    }
  }
  return best;
}
