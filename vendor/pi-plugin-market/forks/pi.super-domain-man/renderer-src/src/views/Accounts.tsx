/* ============================================================
 * views/Accounts.tsx - 账号管理
 * 对应 domain-helper 的 AccountManager.vue
 * ============================================================ */
import { useSyncExternalStore, useState } from "react";
import * as Store from "../lib/store";
import { META, metaOf, create } from "../lib/providers";
import { toast, confirmBox, uid } from "../lib/util";
import { Button, Badge, Card, Empty, Field, inputCls, Modal, selectCls, Table, Td } from "../components/ui";
import { useApp } from "../App";

export function Accounts() {
  const version = useSyncExternalStore(Store.subscribe, Store.getVersion, Store.getVersion);
  void version;
  const accounts = Store.listAccounts();
  const { go } = useApp();
  const [editing, setEditing] = useState<null | { account?: Store.AccountMeta }>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const ensureUnlocked = (): boolean => {
    if (!Store.isMasterSet()) {
      toast("请先在「设置」中设置主密码，用于加密存储云厂商凭据", true);
      go("settings");
      return false;
    }
    if (!Store.hasKey()) {
      toast("请先在「设置」中解锁主密码", true);
      go("settings");
      return false;
    }
    return true;
  };

  const testAccount = async (id: string) => {
    if (!ensureUnlocked()) return;
    setTesting(id);
    try {
      const account = Store.getAccount(id);
      if (!account) return;
      const tokens = await Store.getAccountTokens(id);
      const svc = create(account.cloud, tokens, id);
      const domains = await svc.listDomains();
      Store.setZonesCache(id, domains);
      toast(`连接成功，共 ${domains.length} 个域名/区域`);
    } catch (e) {
      toast(`连接失败：${(e as Error).message}`, true);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div>
      <div className="view-head">
        <div>
          <div className="view-title">账号管理</div>
          <div className="view-sub">云厂商 API 凭据以 PBKDF2 + AES-GCM 加密存储，主密码仅存于内存</div>
        </div>
        <Button variant="primary" onClick={() => setEditing({})}>+ 新增账号</Button>
      </div>

      {accounts.length === 0 ? (
        <Empty title="暂无账号" desc="点击右上角「新增账号」添加阿里云 / 腾讯云 / Cloudflare / AWS / 火山引擎 / 华为云 凭据" />
      ) : (
        <Table head={["标签", "云厂商", "凭据状态", "TTL 范围", "操作"]}>
          {accounts.map((a) => {
            const m = metaOf(a.cloud);
            const ttl = m?.ttl ? `${m.ttl.min} ~ ${m.ttl.max}` : "—";
            return (
              <tr key={a.id} className="hover:bg-surface-panel">
                <Td className="font-semibold">{a.tag || "未命名"}</Td>
                <Td>{m?.title || a.cloud}</Td>
                <Td><Badge solid>已加密</Badge></Td>
                <Td className="tabular-nums">{ttl}</Td>
                <Td className="whitespace-nowrap">
                  <Button size="sm" className="mr-1.5" disabled={testing === a.id} onClick={() => testAccount(a.id)}>
                    {testing === a.id ? "测试中…" : "连通测试"}
                  </Button>
                  <Button size="sm" className="mr-1.5" onClick={() => { if (ensureUnlocked()) setEditing({ account: a }); }}>编辑</Button>
                  <Button size="sm" variant="danger" onClick={async () => {
                    if (!(await confirmBox("删除该账号？关联的域名缓存将被保留。", "删除账号"))) return;
                    Store.deleteAccount(a.id);
                    toast("账号已删除");
                  }}>删除</Button>
                </Td>
              </tr>
            );
          })}
        </Table>
      )}

      {editing && <AccountForm account={editing.account} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AccountForm({ account, onClose }: { account?: Store.AccountMeta; onClose: () => void }) {
  const isEdit = !!account;
  const [cloud, setCloud] = useState(account?.cloud || "ali");
  const [tag, setTag] = useState(account?.tag || "");
  const meta = metaOf(cloud);
  // 仅记录当前厂商字段的输入值；编辑时不回显密钥（保持安全）。
  // 切换厂商时清空，避免旧厂商字段残留参与校验。
  const [tokens, setTokens] = useState<Record<string, string>>({});

  // 凭据组合校验：
  // - Cloudflare：API Token 单独可用；或 EMAIL + API Key 组合（二选一，优先 Token）
  // - 其余厂商：全部字段必填
  const checkTokens = (cloud: string, values: Record<string, string>): { ok: boolean; msg?: string } => {
    if (cloud === "cloudflare") {
      const hasToken = !!(values.apiToken || "").trim();
      const hasLegacy = !!(values.email || "").trim() && !!(values.apiKey || "").trim();
      if (hasToken || hasLegacy) return { ok: true };
      return { ok: false, msg: "请填写 API Token，或同时填写 EMAIL 与 API Key（二选一）" };
    }
    const defs = metaOf(cloud)?.tokens || [];
    const empty = defs.filter((d) => !(values[d.key] || "").trim()).map((d) => d.label);
    if (empty.length) return { ok: false, msg: `请填写：${empty.join("、")}` };
    return { ok: true };
  };

  const save = async () => {
    if (!Store.hasKey()) return toast("请先在设置中解锁主密码", true);
    const defs = meta?.tokens || [];
    // 编辑时：字段留空 = 保持原值（不覆盖）；非空 = 更新为新值
    const oldMap = new Map(
      (isEdit ? await Store.getAccountTokens(account!.id) : []).map((t) => [t.key, t.value])
    );
    const values: Record<string, string> = {};
    for (const d of defs) {
      const typed = (tokens[d.key] || "").trim();
      values[d.key] = typed || (isEdit ? oldMap.get(d.key) || "" : "");
    }
    const chk = checkTokens(cloud, values);
    if (!chk.ok) return toast(chk.msg!, true);
    try {
      await Store.saveAccount({
        id: isEdit ? account!.id : uid(),
        tag,
        cloud,
        tokens: defs.map((d) => ({ key: d.key, value: values[d.key] })),
        createdAt: isEdit ? account!.createdAt : Date.now(),
      });
      onClose();
      toast(isEdit ? "账号已更新" : "账号已保存（凭据已加密）");
    } catch (e) {
      toast(`保存失败：${(e as Error).message}`, true);
    }
  };

  return (
    <Modal open title={isEdit ? "编辑账号" : "新增账号"} onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" onClick={save}>{isEdit ? "保存" : "保存并加密"}</Button></>}>
      <Field label="云厂商">
        <select
          className={`${selectCls} w-full`}
          value={cloud}
          onChange={(e) => {
            setCloud(e.target.value);
            setTokens({});
          }}
        >
          {META.map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}
        </select>
      </Field>
      <Field label="标签（备注）">
        <input className={`${inputCls} w-full`} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="例如：生产环境" />
      </Field>
      {meta?.tokens.map((t) => (
        <Field key={t.key} label={t.label}>
          <input
            className={`${inputCls} w-full`}
            type={t.secret ? "password" : "text"}
            autoComplete="off"
            value={tokens[t.key] || ""}
            onChange={(e) => setTokens((prev) => ({ ...prev, [t.key]: e.target.value }))}
            placeholder={isEdit ? (t.secret ? "留空则不修改" : "") : ""}
          />
        </Field>
      ))}
      {meta?.note && <div className="text-[11px] text-ink-faint">{meta.note}</div>}
      {isEdit && <div className="text-[11px] text-ink-faint mt-2">编辑时字段留空表示保持原值不变；如需更换凭据，直接填入新值即可。Cloudflare 可只填 API Token，或填 EMAIL + API Key。</div>}
    </Modal>
  );
}
