/* ============================================================
 * views/Notifications.tsx - 系统通知
 * 对应 domain-helper 的 NotificationList.vue
 * ============================================================ */
import { useSyncExternalStore } from "react";
import * as Store from "../lib/store";
import { confirmBox, fmtDateTime } from "../lib/util";
import { Button, Empty, LevelBadge, Badge } from "../components/ui";

export function Notifications() {
  const version = useSyncExternalStore(Store.subscribe, Store.getVersion, Store.getVersion);
  void version;
  const list = Store.listNotifications();

  return (
    <div>
      <div className="view-head">
        <div>
          <div className="view-title">系统通知</div>
          <div className="view-sub">证书到期提醒、证书申请结果、导入结果等</div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => { Store.markAllRead(); }}>全部已读</Button>
          <Button variant="danger" onClick={async () => {
            if (await confirmBox("清空全部通知？", "清空通知")) Store.clearNotifications();
          }}>清空</Button>
        </div>
      </div>

      {list.length === 0 ? (
        <Empty title="暂无通知" desc="证书到期提醒与操作结果会显示在这里" />
      ) : (
        list.map((n) => (
          <div key={n.id} className="border border-line bg-surface-panel mb-3.5" style={{ opacity: n.read ? 0.65 : 1 }}>
            <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-line font-semibold text-[13px]">
              <span>{n.title}</span>
              <span className="font-normal text-[11.5px] text-ink-faint">{fmtDateTime(n.ts)}</span>
            </div>
            <div className="p-3.5">
              <div className="mb-2"><LevelBadge level={(n.level as "info" | "warning" | "error") || "info"} /> <Badge faint>{n.level === "info" ? "提醒" : n.level === "warning" ? "警告" : "危急"}</Badge></div>
              <div className="whitespace-pre-wrap break-all">{n.content}</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
