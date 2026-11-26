/* ============================================================
 * views/Settings.tsx - 插件设置
 * 主题 / 主密码管理 / 监控阈值 / 通知渠道 / 数据导入导出 / 关于
 * ============================================================ */
import { useSyncExternalStore, useState } from "react";
import * as Store from "../lib/store";
import { CHANNELS, sendTest } from "../lib/notify";
import { toast, promptBox, copyText, openExternal, confirmBox } from "../lib/util";
import { Badge, Button, Card, Field, inputCls } from "../components/ui";

export function Settings() {
  const version = useSyncExternalStore(Store.subscribe, Store.getVersion, Store.getVersion);
  void version;
  const settings = Store.getSettings();
  const masterSet = Store.isMasterSet();
  const unlocked = Store.hasKey();

  const [notice, setNotice] = useState(String(settings.noticeDays));
  const [warning, setWarning] = useState(String(settings.warningDays));
  const [critical, setCritical] = useState(String(settings.criticalDays));
  const [testing, setTesting] = useState<string | null>(null);

  const saveMonitorSettings = () => {
    const n = Math.max(1, parseInt(notice, 10) || 30);
    const w = Math.max(1, parseInt(warning, 10) || 10);
    const c = Math.max(1, parseInt(critical, 10) || 5);
    if (!(n >= w && w >= c)) return toast("阈值需满足：提醒 ≥ 警告 ≥ 危急", true);
    Store.saveSettings({ noticeDays: n, warningDays: w, criticalDays: c });
    toast("监控阈值已保存");
  };

  const changeMasterPw = async () => {
    try {
      const oldPw = await promptBox("输入当前主密码", "", "修改主密码");
      if (oldPw === null) return;
      if (!(await Store.unlock(oldPw))) return toast("当前主密码错误", true);
      const newPw = await promptBox("输入新主密码（至少 6 位）", "", "修改主密码");
      if (!newPw || newPw.length < 6) return toast("主密码至少 6 位", true);
      // 用旧密钥解密所有账号，再用新密钥重新加密
      const accounts = Store.listAccounts();
      for (const a of accounts) {
        const tokens = await Store.getAccountTokens(a.id);
        await Store.saveAccount({ ...a, tokens });
      }
      await Store.setMaster(newPw);
      toast("主密码已修改");
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`, true);
    }
  };

  const forgotMaster = async () => {
    if (!(await confirmBox("忘记主密码将清空全部本地数据：账号凭据、域名缓存、SSL 证书、监控目标与设置，且无法恢复。确定继续？", "忘记主密码"))) return;
    Store.wipeAll();
    // 重载面板以进入「设置主密码」流程
    setTimeout(() => location.reload(), 400);
  };

  const exportData = async () => {
    const json = await Store.exportAll();
    await copyText(json);
    toast("数据已复制到剪贴板");
  };

  const importData = async () => {
    const text = await promptBox("粘贴导出的 JSON 数据", "", "导入数据");
    if (!text) return;
    try {
      await Store.importAll(text);
      toast("导入完成");
    } catch (e) {
      toast(`导入失败：${(e as Error).message}`, true);
    }
  };

  const testChannel = async (key: string) => {
    setTesting(key);
    try {
      const cfg = Store.getSettings().channels?.[key] || {};
      await sendTest(key, { ...cfg, enabled: true });
      toast("测试消息已发送");
    } catch (e) {
      toast(`发送失败：${(e as Error).message}`, true);
    } finally {
      setTesting(null);
    }
  };

  const setChannelField = (key: string, field: string, value: string) => {
    const channels = Store.getSettings().channels;
    channels[key] = channels[key] || {};
    channels[key][field] = value;
    Store.saveSettings({ channels });
  };

  return (
    <div>
      <div className="view-head">
        <div>
          <div className="view-title">插件设置</div>
          <div className="view-sub">超级域名侠 v0.2.0 · 本地优先 · 数据仅存本机</div>
        </div>
      </div>

      <Card title="外观">
        <Field label="主题">
          <div className="inline-flex border border-line-strong">
            {(["dark", "light", "system"] as const).map((t) => (
              <button
                key={t}
                className={`h-[26px] px-3 text-[12px] border-r border-line-strong last:border-r-0 cursor-pointer ${
                  settings.theme === t ? "bg-accent text-accent-on font-semibold" : "bg-surface-panel text-ink-muted hover:text-ink"
                }`}
                onClick={() => {
                  Store.saveSettings({ theme: t });
                  Store.applyTheme(t);
                }}
              >
                {t === "dark" ? "深色" : t === "light" ? "浅色" : "跟随系统"}
              </button>
            ))}
          </div>
        </Field>
        <Field hint="也可通过侧边栏底部的「白天/黑夜」按钮随时切换。">
          <span className="text-[11.5px] text-ink-faint">偏好保存在本机，下次打开面板自动恢复。</span>
        </Field>
      </Card>

      <Card
        title={<span>主密码（凭据加密）</span>}
        right={
          masterSet ? (
            unlocked ? <Badge solid>已解锁</Badge> : <Badge>已设置 · 未解锁</Badge>
          ) : <Badge>未设置</Badge>
        }
      >
        <Field hint="凭据使用 PBKDF2(150000) + AES-GCM 加密存储；主密码仅保存在内存中，忘记密码只能清空全部数据。">
          <div className="flex gap-2 flex-wrap">
            <Button onClick={() => void changeMasterPw()}>修改主密码</Button>
            {unlocked && (
              <Button variant="danger" onClick={() => { Store.lock(); toast("已锁定"); }}>锁定</Button>
            )}
            <Button variant="danger" onClick={() => void forgotMaster()}>忘记密码（清空全部数据）</Button>
          </div>
        </Field>
      </Card>

      <Card title="SSL 监控阈值">
        <div className="flex gap-2.5">
          <Field label="提醒阈值（天）" className="flex-1"><input className={`${inputCls} w-full`} type="number" value={notice} onChange={(e) => setNotice(e.target.value)} /></Field>
          <Field label="警告阈值（天）" className="flex-1"><input className={`${inputCls} w-full`} type="number" value={warning} onChange={(e) => setWarning(e.target.value)} /></Field>
          <Field label="危急阈值（天）" className="flex-1"><input className={`${inputCls} w-full`} type="number" value={critical} onChange={(e) => setCritical(e.target.value)} /></Field>
        </div>
        <Button variant="primary" onClick={saveMonitorSettings}>保存监控阈值</Button>
      </Card>

      <Card title="通知渠道（证书到期提醒推送）">
        {CHANNELS.map((ch) => {
          const cfg = settings.channels[ch.key] || {};
          return (
            <div key={ch.key} className="border border-line p-3 mb-2.5">
              <div className="flex items-center mb-2">
                <label className="inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="w-3.5 h-3.5 accent-[var(--accent)]"
                    checked={!!cfg.enabled}
                    onChange={(e) => {
                      const channels = Store.getSettings().channels;
                      channels[ch.key] = channels[ch.key] || {};
                      channels[ch.key].enabled = e.target.checked;
                      Store.saveSettings({ channels });
                    }}
                  />
                  {ch.title}
                </label>
                <span className="flex-1" />
                <Button size="sm" disabled={testing === ch.key} onClick={() => void testChannel(ch.key)}>{testing === ch.key ? "发送中…" : "发送测试"}</Button>
              </div>
              {ch.fields.map((f) => (
                <div key={f.key} className="mb-1.5">
                  <label className="block text-[11.5px] text-ink-muted mb-1">{f.label}</label>
                  <input
                    className={`${inputCls} w-full`}
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    value={String(cfg[f.key] || "")}
                    onChange={(e) => setChannelField(ch.key, f.key, e.target.value)}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </Card>

      <Card title="数据">
        <div className="flex gap-2">
          <Button onClick={() => void exportData()}>导出数据（剪贴板）</Button>
          <Button onClick={() => void importData()}>导入数据</Button>
        </div>
        <div className="text-[11px] text-ink-faint mt-2">导出包含账号凭据密文（仍受主密码保护）、设置、监控目标与域名缓存</div>
      </Card>

      <Card title="关于">
        <div className="text-[12.5px] text-ink-muted mb-3 leading-relaxed">
          超级域名侠是一个本地优先的域名与 SSL 证书管理面板：集中管理多家云厂商的 DNS 解析记录，
          查看与申请 SSL 证书，并监控证书到期情况。所有数据仅保存在本机，无任何云端上报。
        </div>
        <dl className="kv">
          <dt>功能</dt><dd>账号凭据加密管理 · 域名解析记录增删改查 · SSL 证书查看与 ACME 申请 · 证书到期监控</dd>
          <dt>平台</dt><dd>阿里云 / 腾讯云 / Cloudflare / AWS Route53 / 火山引擎 / 华为云</dd>
          <dt>隐私</dt><dd>凭据经 PBKDF2 + AES-GCM 加密后仅存本机；主密码只保存在内存</dd>
          <dt>版本</dt><dd>0.2.0</dd>
          <dt>源码</dt><dd><a className="cursor-pointer border-b border-line-strong text-ink-muted hover:text-ink" onClick={() => openExternal("https://github.com/Tioit-Wang/super-domain-man")}>github.com/Tioit-Wang/super-domain-man</a></dd>
          <dt>许可</dt><dd>MIT · 界面与交互参考 domain-helper（MIT）</dd>
        </dl>
      </Card>
    </div>
  );
}
