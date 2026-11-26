/* ============================================================
 * notify.ts - 通知渠道（面板内推送：飞书 / 钉钉 / 企业微信 / Server酱 / 通用 Webhook）
 * ============================================================ */
import * as C from "./crypto";
import * as Net from "./net";

export interface ChannelField {
  key: string;
  label: string;
  secret: boolean;
}

export interface ChannelDef {
  key: string;
  title: string;
  fields: ChannelField[];
}

export const CHANNELS: ChannelDef[] = [
  { key: "feishu", title: "飞书", fields: [{ key: "token", label: "Webhook Token", secret: true }] },
  {
    key: "dingtalk", title: "钉钉",
    fields: [
      { key: "token", label: "Access Token", secret: true },
      { key: "secret", label: "加签 Secret（可选）", secret: true },
    ],
  },
  { key: "wecom", title: "企业微信", fields: [{ key: "key", label: "Webhook Key", secret: true }] },
  { key: "serverchan", title: "Server酱", fields: [{ key: "sendkey", label: "SendKey", secret: true }] },
  { key: "generic", title: "通用 Webhook", fields: [{ key: "url", label: "Webhook URL", secret: false }] },
];

export async function sendChannel(channelKey: string, cfg: Record<string, any>, title: string, content: string): Promise<void> {
  const text = `${title}\n${content}`;
  let url = "";
  let body = "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (channelKey === "feishu" && cfg.token) {
    url = `https://open.feishu.cn/open-apis/bot/v2/hook/${cfg.token}`;
    body = JSON.stringify({ msg_type: "text", content: { text } });
  } else if (channelKey === "dingtalk" && cfg.token) {
    url = `https://oapi.dingtalk.com/robot/send?access_token=${cfg.token}`;
    if (cfg.secret) {
      const ts = Date.now();
      const mac = await C.hmacSha256(C.utf8(cfg.secret), C.utf8(`${ts}\n${cfg.secret}`));
      url += `&timestamp=${ts}&sign=${encodeURIComponent(C.bytesToB64(mac))}`;
    }
    body = JSON.stringify({ msgtype: "text", text: { content: text } });
  } else if (channelKey === "wecom" && cfg.key) {
    url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${cfg.key}`;
    body = JSON.stringify({ msgtype: "text", text: { content: text } });
  } else if (channelKey === "serverchan" && cfg.sendkey) {
    url = `https://sctapi.ftqq.com/${cfg.sendkey}.send`;
    body = new URLSearchParams({ title, desp: content }).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (channelKey === "generic" && cfg.url) {
    url = cfg.url;
    body = JSON.stringify({ title, content, text });
  } else {
    throw new Error("渠道配置不完整");
  }

  const res = await Net.request(url, { method: "POST", headers, body, timeoutMs: 10000 });
  if (res.status >= 400) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = JSON.parse(res.bodyText);
      msg = data.errmsg || data.message || data.msg || msg;
    } catch {
      /* 保留默认 */
    }
    throw new Error(msg);
  }
}

/** 向所有已启用的通知渠道推送（单个失败不阻塞其他渠道）。 */
export async function pushChannels(channels: Record<string, any>, title: string, content: string): Promise<number> {
  let ok = 0;
  const entries = Object.entries(channels || {}).filter(([, cfg]) => cfg && cfg.enabled);
  for (const [key, cfg] of entries) {
    try {
      await sendChannel(key, cfg, title, content);
      ok++;
    } catch {
      /* 忽略单渠道失败 */
    }
  }
  return ok;
}

export async function sendTest(channelKey: string, cfg: Record<string, any>): Promise<void> {
  const title = "超级域名侠 · 通知测试";
  const content = `这是一条测试消息\n时间：${new Date().toLocaleString()}`;
  await sendChannel(channelKey, cfg, title, content);
}
