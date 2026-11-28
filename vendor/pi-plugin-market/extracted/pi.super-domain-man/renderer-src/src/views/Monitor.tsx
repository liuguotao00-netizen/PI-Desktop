/* ============================================================
 * views/Monitor.tsx - SSL 监控
 * 对应 domain-helper 的 SslMonitor.vue
 * ============================================================ */
import { useState, useSyncExternalStore } from "react";
import * as Store from "../lib/store";
import * as Ssl from "../lib/ssl";
import { toast, confirmBox, daysLeft, expiryLevel, fmtDate } from "../lib/util";
import { Button, Empty, Field, inputCls, LevelBadge, Modal, Table, Td, textareaCls } from "../components/ui";

export function Monitor() {
  const version = useSyncExternalStore(Store.subscribe, Store.getVersion, Store.getVersion);
  void version;
  const monitors = Store.listMonitors();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const editing = monitors.find((m) => m.id === editingId) || null;

  const refreshAll = async () => {
    const list = Store.listMonitors();
    if (list.length === 0) return toast("暂无监控目标", true);
    setRefreshing(true);
    try {
      await Ssl.refreshAll(list, 3);
      Store.saveMonitors(list);
      const n = Ssl.notifyExpiring(list);
      toast(n > 0 ? `检查完成，产生 ${n} 条到期提醒` : "检查完成");
    } catch (e) {
      toast(`检查失败：${(e as Error).message}`, true);
    } finally {
      setRefreshing(false);
    }
  };

  const checkOne = async (id: string) => {
    setCheckingId(id);
    try {
      const m = Store.listMonitors().find((x) => x.id === id);
      if (!m) return;
      await Ssl.checkMonitor(m);
      Store.saveMonitors(Store.listMonitors());
      Ssl.notifyExpiring(Store.listMonitors());
    } finally {
      setCheckingId(null);
    }
  };

  return (
    <div>
      <div className="view-head">
        <div>
          <div className="view-title">SSL 监控</div>
          <div className="view-sub">到期前 30/10/5 天提醒（阈值可在设置中调整）· 面板内检查（crt.sh 证书透明日志）</div>
        </div>
        <div className="flex items-center gap-2">
          <Button disabled={refreshing} onClick={() => void refreshAll()}>{refreshing ? "检查中…" : "全部检查"}</Button>
          <Button variant="primary" onClick={() => setAdding(true)}>+ 添加监控</Button>
        </div>
      </div>

      {monitors.length === 0 ? (
        <Empty title="暂无监控目标" desc="添加 https:// 地址或域名，面板通过 crt.sh 证书透明日志查询到期时间" />
      ) : (
        <Table head={["地址", "根域名", "子域", "到期时间", "倒计时", "状态", "备注/错误", "操作"]}>
          {[...monitors].sort((a, b) => (a.expire_time || 0) - (b.expire_time || 0)).map((m) => {
            const remaining = m.expire_time ? (daysLeft(m.expire_time) >= 0 ? `剩余 ${daysLeft(m.expire_time)} 天` : `已过期 ${-daysLeft(m.expire_time)} 天`) : "—";
            return (
              <tr key={m.id} className="hover:bg-surface-panel">
                <Td className="font-mono">{m.uri}</Td>
                <Td className="font-mono">{m.domain || ""}</Td>
                <Td className="font-mono">{m.sub || ""}</Td>
                <Td className="tabular-nums">{fmtDate(m.expire_time)}</Td>
                <Td className="tabular-nums">{remaining}</Td>
                <Td><LevelBadge level={expiryLevel(m.expire_time)} /></Td>
                <Td className="text-ink-muted">{m.last_error || m.remark || ""}</Td>
                <Td className="whitespace-nowrap">
                  <Button size="sm" className="mr-1.5" disabled={checkingId === m.id} onClick={() => void checkOne(m.id)}>{checkingId === m.id ? "…" : "检查"}</Button>
                  <Button size="sm" className="mr-1.5" onClick={() => setEditingId(m.id)}>编辑</Button>
                  <Button size="sm" variant="danger" onClick={async () => {
                    if (await confirmBox("删除该监控目标？", "删除监控")) {
                      Store.saveMonitors(Store.listMonitors().filter((x) => x.id !== m.id));
                      toast("已删除");
                    }
                  }}>删除</Button>
                </Td>
              </tr>
            );
          })}
        </Table>
      )}

      {adding && <AddModal onClose={() => setAdding(false)} />}
      {editing && <EditModal monitor={editing} onClose={() => setEditingId(null)} />}
    </div>
  );
}

function AddModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const add = () => {
    const inputs = Ssl.parseAddInput(text);
    if (inputs.length === 0) return toast("没有有效输入", true);
    const monitors = Store.listMonitors();
    let added = 0;
    for (const input of inputs) {
      const m = Ssl.buildMonitor(input.uri, input.remark || "");
      if (!m) {
        toast(`地址无效：${input.uri}`, true);
        continue;
      }
      if (monitors.some((x) => x.uri === m.uri)) continue;
      monitors.push(m);
      added++;
    }
    Store.saveMonitors(monitors);
    onClose();
    toast(`已添加 ${added} 个监控目标`);
  };
  return (
    <Modal open title="添加监控目标" onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" onClick={add}>添加</Button></>}>
      <Field label="监控地址（每行一个，支持 https:// 前缀、端口、备注）">
        <textarea className={`${textareaCls} w-full`} rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="https://example.com 官网&#10;mail.example.com:8443 邮件服务器" />
      </Field>
    </Modal>
  );
}

function EditModal({ monitor, onClose }: { monitor: Store.MonitorTarget; onClose: () => void }) {
  const [uri, setUri] = useState(monitor.uri);
  const [domain, setDomain] = useState(monitor.domain || "");
  const [remark, setRemark] = useState(monitor.remark || "");
  const save = () => {
    const norm = Ssl.normalizeUri(uri);
    if (!norm) return toast("地址无效", true);
    const list = Store.listMonitors();
    const target = list.find((x) => x.id === monitor.id);
    if (target) {
      target.uri = norm.uri;
      target.host = norm.host;
      target.domain = domain.trim() || norm.host.split(".").slice(-2).join(".");
      target.sub = norm.host === target.domain ? "@" : norm.host.replace(`.${target.domain}`, "");
      target.remark = remark.trim();
      Store.saveMonitors(list);
    }
    onClose();
    toast("已保存");
  };
  return (
    <Modal open title="编辑监控目标" onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" onClick={save}>保存</Button></>}>
      <Field label="地址"><input className={`${inputCls} w-full`} value={uri} onChange={(e) => setUri(e.target.value)} /></Field>
      <Field label="根域名"><input className={`${inputCls} w-full`} value={domain} onChange={(e) => setDomain(e.target.value)} /></Field>
      <Field label="备注"><input className={`${inputCls} w-full`} value={remark} onChange={(e) => setRemark(e.target.value)} /></Field>
    </Modal>
  );
}
