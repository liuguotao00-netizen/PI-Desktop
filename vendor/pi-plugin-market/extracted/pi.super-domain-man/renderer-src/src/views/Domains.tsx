/* ============================================================
 * views/Domains.tsx - 域名列表
 * 对应 domain-helper 的 DomainList.vue
 * ============================================================ */
import { useSyncExternalStore, useState } from "react";
import * as Store from "../lib/store";
import { metaOf, create } from "../lib/providers";
import { toast, openExternal, fmtDate, fmtDateTime } from "../lib/util";
import { Button, Empty, selectCls, Table, Td } from "../components/ui";
import { useApp } from "../App";

export function Domains() {
  const version = useSyncExternalStore(Store.subscribe, Store.getVersion, Store.getVersion);
  void version;
  const accounts = Store.listAccounts();
  const { go } = useApp();
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const [state, setState] = useState<{ loading: boolean; error: string }>({ loading: false, error: "" });

  const account = Store.getAccount(accountId);
  const cache = accountId ? Store.getDomainsCache(accountId) : null;

  const load = async (refresh = false) => {
    if (!accountId || !account) return;
    if (!Store.hasKey()) {
      setState({ loading: false, error: "主密码未解锁，请到「设置」解锁后拉取域名" });
      return;
    }
    setState({ loading: true, error: "" });
    try {
      const tokens = await Store.getAccountTokens(accountId);
      const svc = create(account.cloud, tokens, accountId);
      const domains = await svc.listDomains();
      Store.setDomainsCache(accountId, domains);
      Store.setZonesCache(accountId, domains);
      setState({ loading: false, error: "" });
    } catch (e) {
      setState({ loading: false, error: (e as Error).message });
    }
  };

  return (
    <div>
      <div className="view-head">
        <div>
          <div className="view-title">域名列表</div>
          <div className="view-sub">按账号拉取域名/区域，本地缓存，可手动刷新</div>
        </div>
        <div className="flex items-center gap-2">
          <select className={selectCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.tag || "未命名"} · {metaOf(a.cloud)?.title || a.cloud}</option>
            ))}
          </select>
          <Button onClick={() => load(true)}>刷新</Button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <Empty title="暂无账号" desc="请先在「账号管理」中添加云厂商账号" />
      ) : state.error ? (
        <Empty title={state.loading ? "加载中…" : "拉取失败"} desc={state.error}>
          {cache && <Button onClick={() => load(true)}>重试</Button>}
        </Empty>
      ) : !cache ? (
        <Empty title={state.loading ? "加载中…" : "未获取到域名"} desc="正在从云厂商 API 拉取域名列表…">
          {!state.loading && <Button variant="primary" onClick={() => load(true)}>立即拉取</Button>}
        </Empty>
      ) : (
        <>
          <Table head={["域名", "云厂商", "到期时间", "操作"]}>
            {cache.domains.map((d) => (
              <tr key={d.domain} className="hover:bg-surface-panel">
                <Td className="font-mono">{d.domain}</Td>
                <Td>{metaOf(d.cloud)?.title || d.cloud}</Td>
                <Td className="tabular-nums">{d.expire_time ? fmtDate(Date.parse(d.expire_time)) : "—"}</Td>
                <Td className="whitespace-nowrap">
                  <Button size="sm" variant="primary" className="mr-1.5" onClick={() => go("records", { accountId, domain: d.domain })}>
                    解析记录
                  </Button>
                  {d.renew_link && (
                    <Button size="sm" onClick={() => openExternal(d.renew_link!)}>续费</Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          <div className="text-[11.5px] text-ink-faint mt-2">缓存于 {fmtDateTime(cache.at)}</div>
        </>
      )}
    </div>
  );
}
