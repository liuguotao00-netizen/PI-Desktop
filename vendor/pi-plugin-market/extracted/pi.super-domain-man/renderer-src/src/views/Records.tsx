/* ============================================================
 * views/Records.tsx - 域名解析记录管理
 * 对应 domain-helper 的 DomainRecords.vue
 * 分页/搜索、增删改、启用停用、MX 优先级、批量导入导出
 * ============================================================ */
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Store from "../lib/store";
import { create, DnsProvider, metaOf, DnsRecord, RecordDraft } from "../lib/providers";
import { toast, confirmBox, validateRecord, parseLinesToRecords, copyText, readClipboard, esc, RecordInput } from "../lib/util";
import { Button, Empty, Field, inputCls, Modal, selectCls, Table, Td, textareaCls } from "../components/ui";
import { useApp } from "../App";

const TYPES = ["A", "CNAME", "TXT", "AAAA", "NS", "MX"];
const PAGE_SIZES = [20, 50, 100];

export function Records() {
  const version = useSyncExternalStore(Store.subscribe, Store.getVersion, Store.getVersion);
  void version;
  const { go, state } = useApp();
  const rs = state.records;
  const account = rs ? Store.getAccount(rs.accountId) : null;
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState("");
  const [data, setData] = useState<{ count: number; list: DnsRecord[]; hasMore: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<null | { record?: DnsRecord }>(null);
  const [importing, setImporting] = useState(false);
  const tokenCache = useRef<Record<string, DnsProvider>>({});

  const getSvc = async (): Promise<DnsProvider | null> => {
    if (!rs || !account) return null;
    if (tokenCache.current[rs.accountId]) return tokenCache.current[rs.accountId];
    const tokens = await Store.getAccountTokens(rs.accountId);
    const svc = create(account.cloud, tokens, rs.accountId);
    tokenCache.current[rs.accountId] = svc;
    return svc;
  };

  const load = async (p = page, kw = keyword) => {
    if (!rs) return;
    setLoading(true);
    setError("");
    try {
      const svc = await getSvc();
      if (!svc) return;
      const result = await svc.listRecords(rs.domain, { page: p, pageSize, keyword: kw });
      setData(result);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  const ops = useMemo(
    () => ({
      load,
      account,
      setEditing,
      setImporting,
      page,
      setPage,
      keyword,
      setKeyword,
      pageSize,
      setPageSize,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rs, account, page, pageSize, keyword]
  );
  void ops;

  if (!rs || !account) {
    return (
      <Empty title="未选择域名" desc="请先到「域名列表」选择一个域名">
        <Button variant="primary" onClick={() => go("domains")}>去域名列表</Button>
      </Empty>
    );
  }

  const search = () => {
    setPage(1);
    load(1, keyword);
  };

  const del = async (rec: DnsRecord) => {
    if (!(await confirmBox(`删除记录 ${rec.Name} (${rec.Type}) ？此操作不可撤销。`, "删除记录"))) return;
    try {
      const svc = await getSvc();
      await svc?.deleteRecord(rs.domain, rec.RecordId, rec);
      toast("记录已删除");
      load();
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`, true);
    }
  };

  const toggle = async (rec: DnsRecord) => {
    try {
      const svc = await getSvc();
      if (svc?.changeRecordStatus) {
        await svc.changeRecordStatus(rs.domain, rec.RecordId, !rec.Status);
        toast(rec.Status ? "已停用" : "已启用");
        load();
      }
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`, true);
    }
  };

  const exportRecords = async () => {
    try {
      const svc = await getSvc();
      if (!svc) return;
      const all = await svc.listRecords(rs.domain, { pageSize: 500 });
      const json = JSON.stringify({
        domain: rs.domain,
        provider: account.cloud,
        exportedAt: new Date().toISOString(),
        records: all.list.map((r) => ({ name: r.Name, type: r.Type, value: r.Value, ttl: r.TTL, mx: r.MX || undefined, remark: r.Remark || undefined })),
      }, null, 2);
      await copyText(json);
      toast("导出 JSON 已复制到剪贴板");
    } catch (e) {
      toast(`导出失败：${(e as Error).message}`, true);
    }
  };

  const doImport = async (text: string) => {
    let records: RecordInput[];
    try {
      records = parseLinesToRecords(text);
    } catch (e) {
      return toast((e as Error).message, true);
    }
    if (records.length === 0) return toast("没有可导入的记录", true);
    try {
      const svc = await getSvc();
      if (!svc) return;
      let okCount = 0;
      const errors: string[] = [];
      for (const r of records) {
        try {
          validateRecord(r.type, r.value);
          await svc.addRecord(rs.domain, { name: r.name, type: r.type, value: r.value, ttl: r.ttl, mx: r.mx, remark: r.remark || "" });
          okCount++;
        } catch (e) {
          errors.push(`${r.name} ${r.type}: ${(e as Error).message}`);
        }
      }
      toast(`导入完成：成功 ${okCount}，失败 ${errors.length}`);
      if (errors.length > 0) Store.addNotification("批量导入完成（含失败）", errors.slice(0, 20).join("\n"), "warning");
      load();
    } catch (e) {
      toast(`导入失败：${(e as Error).message}`, true);
    }
  };

  const meta = metaOf(account.cloud);

  return (
    <div>
      <div className="view-head">
        <div>
          <div className="view-title">解析记录 <span className="mono">{rs.domain}</span></div>
          <div className="view-sub">{meta?.title || account.cloud} · {account.tag || "未命名"}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => go("domains")}>返回</Button>
          <Button onClick={exportRecords}>导出</Button>
          <Button onClick={() => setImporting(true)}>批量导入</Button>
          <Button variant="primary" onClick={() => setEditing({})}>+ 新增记录</Button>
        </div>
      </div>

      <div className="toolbar">
        <input className={`${inputCls} w-[220px]`} placeholder="搜索主机记录 / 记录值…" value={keyword} onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
        <select className={selectCls} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} 条/页</option>)}
        </select>
        <Button onClick={search}>搜索</Button>
        <Button onClick={() => load()}>刷新</Button>
        <span className="flex-1" />
        <span className="text-ink-faint text-[12px]">{data ? `共 ${data.count} 条` : ""}</span>
        <Button size="sm" disabled={page <= 1} onClick={() => { setPage(page - 1); load(page - 1); }}>上一页</Button>
        <span className="tabular-nums text-[12px]">第 {page} 页</span>
        <Button size="sm" disabled={!data?.hasMore} onClick={() => { setPage(page + 1); load(page + 1); }}>下一页</Button>
      </div>

      {loading ? (
        <Empty title="加载中…" />
      ) : error ? (
        <Empty title="加载失败" desc={error} />
      ) : !data || data.list.length === 0 ? (
        <Empty title="无记录" desc={keyword ? "没有匹配的记录" : "点击「新增记录」添加第一条解析"} />
      ) : (
        <Table head={["主机记录", "类型", "记录值", "TTL", "优先级", "状态", "备注", "操作"]}>
          {data.list.map((r) => (
            <tr key={r.RecordId} className="hover:bg-surface-panel">
              <Td className="font-mono">{r.Name}</Td>
              <Td><span className="inline-flex h-[18px] items-center px-1.5 text-[10.5px] font-bold border border-ink text-ink">{r.Type}</span></Td>
              <Td className="font-mono max-w-[320px] break-all">{esc(String(r.Value).replace(/\n/g, " ⏎ "))}</Td>
              <Td className="tabular-nums">{r.TTL ?? "—"}</Td>
              <Td className="tabular-nums">{r.MX ?? "—"}</Td>
              <Td>
                {meta?.supportsStatus ? (
                  <Button size="sm" variant={r.Status ? "primary" : "default"} onClick={() => toggle(r)}>{r.Status ? "启用" : "停用"}</Button>
                ) : <span className="text-ink-faint">—</span>}
              </Td>
              <Td className="text-ink-muted">{r.Remark || ""}</Td>
              <Td className="whitespace-nowrap">
                <Button size="sm" className="mr-1.5" onClick={() => setEditing({ record: r })}>编辑</Button>
                <Button size="sm" variant="danger" onClick={() => del(r)}>删除</Button>
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {editing && <RecordForm key={editing.record?.RecordId || "new"} record={editing.record} onClose={() => setEditing(null)} onSaved={() => load()} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onImport={doImport} />}
    </div>
  );
}

function RecordForm({ record, onClose, onSaved }: { record?: DnsRecord; onClose: () => void; onSaved: () => void }) {
  const { state } = useApp();
  const rs = state.records!;
  const account = Store.getAccount(rs.accountId)!;
  const meta = metaOf(account.cloud);
  const ttlDef = meta?.ttl?.def ?? 600;
  const mxDef = meta?.mx?.def ?? 10;
  const [name, setName] = useState(record?.Name || "");
  const [type, setType] = useState(record?.Type || "A");
  const [value, setValue] = useState(record?.Value || "");
  const [ttl, setTtl] = useState(String(record?.TTL ?? ttlDef));
  const [mx, setMx] = useState(String(record?.MX ?? mxDef));
  const [remark, setRemark] = useState(record?.Remark || "");

  const save = async () => {
    const t = parseInt(ttl, 10) || ttlDef;
    const m = parseInt(mx, 10) || mxDef;
    if (!name.trim()) return toast("请填写主机记录", true);
    try {
      validateRecord(type, value.trim());
    } catch (e) {
      return toast((e as Error).message, true);
    }
    if (meta?.ttl && (t < meta.ttl.min || t > meta.ttl.max)) return toast(`TTL 需在 ${meta.ttl.min} ~ ${meta.ttl.max} 之间`, true);
    if (type === "MX" && meta?.mx && (m < meta.mx.min || m > meta.mx.max)) return toast(`MX 优先级需在 ${meta.mx.min} ~ ${meta.mx.max} 之间`, true);
    try {
      const tokens = await Store.getAccountTokens(rs.accountId);
      const svc = create(account.cloud, tokens, rs.accountId);
      const draft: RecordDraft = { name: name.trim(), type, value: value.trim(), ttl: t, remark: remark.trim(), mx: m };
      if (record) draft.id = record.RecordId;
      if (record) await svc.updateRecord(rs.domain, draft);
      else await svc.addRecord(rs.domain, draft);
      onClose();
      toast(record ? "记录已更新" : "记录已添加");
      onSaved();
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`, true);
    }
  };

  return (
    <Modal open title={record ? "编辑记录" : "新增记录"} onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" onClick={save}>{record ? "保存修改" : "添加"}</Button></>}>
      <div className="flex gap-2.5">
        <Field label="主机记录（@ 表示根域名）" className="flex-1">
          <input className={`${inputCls} w-full`} value={name} onChange={(e) => setName(e.target.value)} placeholder="www / @ / _acme-challenge" />
        </Field>
        <Field label="类型" className="flex-[0_0_130px]">
          <select className={`${selectCls} w-full`} value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </div>
      <Field label="记录值">
        <textarea className={`${textareaCls} w-full`} rows={2} value={value} onChange={(e) => setValue(e.target.value)} placeholder="例如 1.2.3.4 / target.example.com" />
      </Field>
      <div className="flex gap-2.5">
        <Field label={`TTL（${meta?.ttl ? `${meta.ttl.min} ~ ${meta.ttl.max}` : "—"}）`} className="flex-1">
          <input className={`${inputCls} w-full`} type="number" value={ttl} onChange={(e) => setTtl(e.target.value)} />
        </Field>
        {type === "MX" && (
          <Field label={`MX 优先级（${meta?.mx ? `${meta.mx.min} ~ ${meta.mx.max}` : "—"}）`} className="flex-1">
            <input className={`${inputCls} w-full`} type="number" value={mx} onChange={(e) => setMx(e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="备注">
        <input className={`${inputCls} w-full`} value={remark} onChange={(e) => setRemark(e.target.value)} />
      </Field>
    </Modal>
  );
}

function ImportModal({ onClose, onImport }: { onClose: () => void; onImport: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const paste = async () => {
    try {
      setText(await readClipboard());
    } catch {
      toast("读取剪贴板失败", true);
    }
  };
  return (
    <Modal open title="批量导入记录" onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" onClick={() => void onImport(text)}>开始导入</Button></>}>
      <Field label="粘贴 JSON 数组或每行一条（name type value [ttl] [mx] [remark]）" hint="支持 JSON 数组与文本行两种格式">
        <textarea className={`${textareaCls} w-full font-mono text-[12px]`} rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder='[{"name":"www","type":"A","value":"1.2.3.4","ttl":600}]' />
      </Field>
      <Button size="sm" onClick={paste}>从剪贴板粘贴</Button>
    </Modal>
  );
}
