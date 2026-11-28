/* ============================================================
 * views/Ssl.tsx - SSL 证书管理 + ACME 证书申请
 * 对应 domain-helper 的 SslRecords.vue / SslApply.vue / SslDetail.vue
 * ============================================================ */
import { useState, useSyncExternalStore } from "react";
import * as Store from "../lib/store";
import * as Acme from "../lib/acme";
import { create } from "../lib/providers";
import { toast, confirmBox, copyText, expiryLevel, fmtDate, fmtDateTime, sleep, uid, esc, Level } from "../lib/util";
import { Button, Badge, Empty, Field, inputCls, LevelBadge, Modal, selectCls, Table, Td, textareaCls } from "../components/ui";
import { useApp } from "../App";

export function Ssl() {
  const version = useSyncExternalStore(Store.subscribe, Store.getVersion, Store.getVersion);
  void version;
  const { go } = useApp();
  const certs = Store.listCerts();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const detail = certs.find((c) => c.id === detailId) || null;

  const addMonitor = (cert: Store.CertRecord) => {
    const monitors = Store.listMonitors();
    const host = (cert.domains || [])[0];
    if (!host) return toast("无域名信息", true);
    const uri = host.startsWith("*.") ? host.slice(2) : host;
    if (monitors.some((m) => m.uri === uri)) return toast("该域名已在监控中", true);
    const domain = host.startsWith("*.") ? host.slice(2) : host;
    monitors.push({
      id: uid(),
      uri,
      host: uri,
      domain: domain.split(".").slice(-2).join("."),
      sub: "@",
      remark: "",
      expire_time: cert.notAfter,
      issuer: cert.issuer,
      is_wildcard: host.startsWith("*."),
      checked_at: Date.now(),
    });
    Store.saveMonitors(monitors);
    toast("已加入监控");
  };

  return (
    <div>
      <div className="view-head">
        <div>
          <div className="view-title">SSL 证书</div>
          <div className="view-sub">本地证书库 · ACME 证书申请（Let's Encrypt / ZeroSSL / Google）</div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => setApplying(true)}>+ 申请证书</Button>
        </div>
      </div>

      {certs.length === 0 ? (
        <Empty title="暂无证书" desc="通过「申请证书」签发新证书；签发的证书与私钥将保存在本地" />
      ) : (
        <Table head={["域名", "签发机构", "生效时间", "到期时间", "状态", "操作"]}>
          {certs.map((c) => (
            <tr key={c.id} className="hover:bg-surface-panel">
              <Td className="font-mono">{(c.domains || []).join(", ")}</Td>
              <Td>{c.ca || ""}</Td>
              <Td className="tabular-nums">{fmtDate(c.notBefore)}</Td>
              <Td className="tabular-nums">{fmtDate(c.notAfter)}</Td>
              <Td><LevelBadge level={expiryLevel(c.notAfter)} /></Td>
              <Td className="whitespace-nowrap">
                <Button size="sm" className="mr-1.5" onClick={() => setDetailId(c.id)}>详情</Button>
                <Button size="sm" className="mr-1.5" onClick={async () => { await copyText(c.cert); toast("证书 PEM 已复制"); }}>复制 PEM</Button>
                <Button size="sm" className="mr-1.5" onClick={() => addMonitor(c)}>加入监控</Button>
                <Button size="sm" variant="danger" onClick={async () => {
                  if (await confirmBox("删除该证书记录？（不影响已签发证书本身）", "删除证书")) Store.deleteCert(c.id);
                }}>删除</Button>
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {detail && <CertDetail cert={detail} onClose={() => setDetailId(null)} />}
      {applying && <ApplyWizard onClose={() => setApplying(false)} onGoAccounts={() => { setApplying(false); go("accounts"); }} />}
    </div>
  );
}

function CertDetail({ cert, onClose }: { cert: Store.CertRecord; onClose: () => void }) {
  const copy = async (text: string, label: string) => {
    await copyText(text);
    toast(`${label}已复制`);
  };
  return (
    <Modal open title="证书详情" size="lg" onClose={onClose}
      footer={<>
        <Button onClick={() => void copy(cert.cert, "证书")}>复制证书</Button>
        <Button onClick={() => void copy(cert.privateKey, "私钥")}>复制私钥</Button>
        <Button onClick={() => void copy(cert.csr, "CSR")}>复制CSR</Button>
        <Button variant="primary" onClick={onClose}>关闭</Button>
      </>}>
      <dl className="kv mb-3.5">
        <dt>域名</dt><dd>{(cert.domains || []).join(", ")}</dd>
        <dt>签发机构</dt><dd>{cert.issuer || ""}</dd>
        <dt>生效时间</dt><dd>{fmtDateTime(cert.notBefore)}</dd>
        <dt>到期时间</dt><dd>{fmtDateTime(cert.notAfter)}</dd>
        <dt>密钥类型</dt><dd>{cert.keyType || ""}</dd>
        <dt>CA</dt><dd>{cert.ca || ""}</dd>
      </dl>
      <Field label="证书（PEM）"><pre className="pem">{esc(cert.cert)}</pre></Field>
      <Field label="私钥（PEM）"><pre className="pem">{esc(cert.privateKey)}</pre></Field>
      <Field label="CSR"><pre className="pem">{esc(cert.csr)}</pre></Field>
    </Modal>
  );
}

/* ------------------------------ ACME 申请向导 ------------------------------ */

function ApplyWizard({ onClose, onGoAccounts }: { onClose: () => void; onGoAccounts: () => void }) {
  const accounts = Store.listAccounts();
  const [step, setStep] = useState(0);
  const [ca, setCa] = useState("letsencrypt");
  const [email, setEmail] = useState("");
  const [domainsText, setDomainsText] = useState("");
  const [keyType, setKeyType] = useState("ECC-256");
  const [eabKid, setEabKid] = useState("");
  const [eabHmac, setEabHmac] = useState("");
  const [wait, setWait] = useState(30);
  const [zoneSel, setZoneSel] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState<Array<{ msg: string; err?: boolean }>>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  if (accounts.length === 0) {
    return (
      <Modal open title="申请 SSL 证书" onClose={onClose}
        footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" onClick={onGoAccounts}>去添加账号</Button></>}>
        <Empty title="需要云厂商账号" desc="ACME DNS-01 挑战需要解析 API 自动添加 TXT 记录，请先添加账号" />
      </Modal>
    );
  }

  const caInfo = Acme.CAs[ca];
  const domains = domainsText.split(/[\s,，]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);

  const log = (msg: string, err = false) => setLogs((prev) => [...prev, { msg, err }]);

  const run = async () => {
    setRunning(true);
    setStep(2);
    try {
      log(`连接 ${caInfo.title} 目录…`);
      const client = new Acme.AcmeClient(ca, email, caInfo.needEab ? { kid: eabKid, hmacKey: eabHmac } : null);
      await client.init();
      log("获取目录成功，生成账户密钥…");
      await client.registerAccount();
      log("账户注册成功");

      log("创建订单…");
      const { order, challenges } = await client.requestCertificate(domains);
      log(`订单创建成功，共 ${challenges.length} 个域名挑战`);

      const created: Array<{ svc: ReturnType<typeof create>; zone: string; sub: string; txt: string }> = [];
      for (const ch of challenges) {
        const host = ch.domain.replace(/^\*\./, "");
        const sel = zoneSel[host] || "";
        let accountId = "";
        let zone = "";
        if (sel) [accountId, zone] = sel.split("|");
        if (!accountId) {
          for (const a of accounts) {
            const zones = Store.getZonesCache(a.id)?.zones || [];
            const hit = zones.find((z) => {
              const zn = z.domain.toLowerCase().replace(/\.$/, "");
              return host === zn || host.endsWith("." + zn);
            });
            if (hit) {
              accountId = a.id;
              zone = hit.domain;
              break;
            }
          }
        }
        if (!accountId) {
          log(`跳过 ${ch.domain}：未找到匹配的解析 Zone`, true);
          continue;
        }
        const account = Store.getAccount(accountId);
        const tokens = await Store.getAccountTokens(accountId);
        const svc = create(account!.cloud, tokens, accountId);
        const zoneClean = zone.toLowerCase().replace(/\.$/, "");
        const sub = host === zoneClean ? "_acme-challenge" : `_acme-challenge.${host.slice(0, -(zoneClean.length + 1))}`;
        log(`添加 TXT 记录：_acme-challenge.${host} = ${ch.txtValue.slice(0, 24)}…（${account!.tag} / ${zone}）`);
        await svc.addRecord(zone, { name: sub, type: "TXT", value: ch.txtValue, ttl: 600 });
        created.push({ svc, zone, sub, txt: ch.txtValue });
      }

      if (created.length === 0) throw new Error("没有成功添加任何 TXT 记录，无法验证");

      if (wait > 0) {
        log(`等待 DNS 传播 ${wait} 秒…`);
        await sleep(wait * 1000);
      }

      for (const ch of challenges) {
        log(`通知 CA 验证 ${ch.domain}…`);
        await client.respondChallenge(ch.challenge);
      }

      log("轮询订单状态…");
      const order2 = await client.pollOrder(order, 30, 4000, (s) => log(`订单状态：${s}`));
      if (order2.status !== "valid") throw new Error(`订单未通过验证：${order2.status}`);

      log("生成证书密钥与 CSR，提交 finalize…");
      const result = await client.finalizeWithKey(order2, domains, keyType);
      log("证书签发成功 ✓");
      Store.saveCert(result);
      log("证书已保存到本地证书库");

      for (const rec of created) {
        try {
          const { list } = await rec.svc.listRecords(rec.zone);
          const mine = list.filter((r) => r.Name === rec.sub && r.Type === "TXT" && String(r.Value).includes(rec.txt));
          for (const r of mine) await rec.svc.deleteRecord(rec.zone, r.RecordId);
          log(`已清理 TXT：${rec.sub}.${rec.zone}`);
        } catch (e) {
          log(`清理 TXT 失败：${(e as Error).message}`, true);
        }
      }

      Store.addNotification("证书申请成功", `${domains.join(", ")}\n有效期至 ${fmtDate(result.notAfter)}`, "info");
      toast("证书申请成功");
      setDone(true);
    } catch (e) {
      log(`申请失败：${(e as Error).message}`, true);
      Store.addNotification("证书申请失败", (e as Error).message, "error");
      toast("证书申请失败", true);
      setDone(true);
    } finally {
      setRunning(false);
    }
  };

  const stepBar = (
    <div className="wizard-steps">
      {["申请配置", "DNS 挑战", "执行"].map((s, i) => (
        <div key={s} className={`wizard-step ${step === i ? "on" : i < step ? "done" : ""}`}>{i + 1}. {s}</div>
      ))}
    </div>
  );

  return (
    <Modal open title="申请 SSL 证书" size="lg" closable={!running} onClose={onClose}
      footer={
        step === 0 ? (
          <>
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" onClick={() => {
              if (domains.length === 0) return toast("请填写域名", true);
              if (!email.includes("@")) return toast("请填写有效邮箱", true);
              if (caInfo.needEab && (!eabKid || !eabHmac)) return toast("ZeroSSL 需要填写 EAB KID 与 HMAC Key", true);
              setStep(1);
            }}>下一步</Button>
          </>
        ) : step === 1 ? (
          <>
            <Button onClick={() => setStep(0)}>上一步</Button>
            <Button variant="primary" disabled={running} onClick={() => void run()}>开始申请</Button>
          </>
        ) : (
          <Button variant="primary" disabled={!done} onClick={onClose}>{done ? "完成" : "执行中…"}</Button>
        )
      }>
      {stepBar}
      {step === 0 && (
        <>
          <Field label="证书颁发机构（CA）" hint={caInfo.eabHint}>
            <select className={`${selectCls} w-full`} value={ca} onChange={(e) => setCa(e.target.value)}>
              {Object.entries(Acme.CAs).map(([k, v]) => <option key={k} value={k}>{v.title}</option>)}
            </select>
          </Field>
          {caInfo.needEab && (
            <div className="flex gap-2.5">
              <Field label="EAB KID" className="flex-1"><input className={`${inputCls} w-full`} value={eabKid} onChange={(e) => setEabKid(e.target.value)} /></Field>
              <Field label="EAB HMAC Key" className="flex-1"><input className={`${inputCls} w-full`} value={eabHmac} onChange={(e) => setEabHmac(e.target.value)} /></Field>
            </div>
          )}
          <Field label="联系邮箱">
            <input className={`${inputCls} w-full`} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </Field>
          <Field label="域名（多个用逗号或换行分隔，支持 *.example.com 泛域名）">
            <textarea className={`${textareaCls} w-full`} rows={3} value={domainsText} onChange={(e) => setDomainsText(e.target.value)} placeholder="example.com&#10;www.example.com" />
          </Field>
          <Field label="证书密钥类型">
            <select className={`${selectCls} w-full`} value={keyType} onChange={(e) => setKeyType(e.target.value)}>
              <option value="ECC-256">ECC P-256（推荐）</option>
              <option value="ECC-384">ECC P-384</option>
              <option value="RSA-2048">RSA 2048</option>
              <option value="RSA-4096">RSA 4096</option>
            </select>
          </Field>
        </>
      )}
      {step === 1 && (
        <>
          <Field label="为每个域名选择解析账号与 Zone（自动匹配已就绪，可手动调整）" hint="缺失的账号会先尝试从「域名列表」拉取；若仍无匹配 Zone，该域名将跳过">
            <Table head={["域名", "Zone（账号）"]}>
              {domains.map((d) => {
                const host = d.replace(/^\*\./, "");
                const zones = accounts.flatMap((a) => (Store.getZonesCache(a.id)?.zones || []).map((z) => ({ a, z })));
                const matched = zones.find((zo) => {
                  const zn = zo.z.domain.toLowerCase().replace(/\.$/, "");
                  return host === zn || host.endsWith("." + zn);
                });
                return (
                  <tr key={d}>
                    <Td className="font-mono">{d}</Td>
                    <Td>
                      <select
                        className={`${selectCls} w-full`}
                        value={zoneSel[host] || (matched ? `${matched.a.id}|${matched.z.domain}` : "")}
                        onChange={(e) => setZoneSel((prev) => ({ ...prev, [host]: e.target.value }))}
                      >
                        <option value="">— 自动选择 —</option>
                        {accounts.map((a) => (
                          <optgroup key={a.id} label={`${a.tag || "未命名"}`}>
                            {(Store.getZonesCache(a.id)?.zones || []).map((z) => {
                              const zn = z.domain.toLowerCase().replace(/\.$/, "");
                              const ok = host === zn || host.endsWith("." + zn);
                              return <option key={z.domain} value={`${a.id}|${z.domain}`}>{z.domain}{ok ? " ✓" : ""}</option>;
                            })}
                          </optgroup>
                        ))}
                      </select>
                    </Td>
                  </tr>
                );
              })}
            </Table>
          </Field>
          <Field label="DNS 传播等待（秒）">
            <input className={`${inputCls} w-full`} type="number" min={0} value={wait} onChange={(e) => setWait(Number(e.target.value))} />
          </Field>
        </>
      )}
      {step === 2 && (
        <Field label="执行日志">
          <div className="log-box">
            {logs.map((l, i) => (
              <div key={i} className={l.err ? "text-ink font-bold" : "text-ink"}>{l.msg}</div>
            ))}
          </div>
        </Field>
      )}
    </Modal>
  );
}
