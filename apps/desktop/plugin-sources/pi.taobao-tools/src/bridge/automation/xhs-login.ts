"use strict";

/**
 * Per-script result shaping that is not expressible as a DSL step.
 *
 * Only the 小红书 login QR script needs it: the page returns the code as a
 * data URL, and a run that stops there would leave the agent with a string it
 * cannot send to the user. The PNG is written into the run's artifact
 * directory and the context is reduced to what the caller needs next.
 *
 * Ported from QiWork's `automation/xhs_login.py`.
 */

import { codedError } from "./errors";
import * as fs from "node:fs";
import * as path from "node:path";

const LOGIN_QRCODE_SCRIPT = "xiaohongshu-login-qrcode";
const DATA_URL = /^data:image\/([a-zA-Z0-9+.-]+);base64,([\s\S]+)$/;


function finalizeRunResult(
  automationId: string,
  value: Record<string, unknown> & { context?: unknown; files?: unknown[] },
  artifactDir: string,
): Record<string, unknown> {
  if (automationId !== LOGIN_QRCODE_SCRIPT) return value;
  const context = {
    ...((value && typeof value.context === "object" && value.context) || {}),
  } as Record<string, unknown>;
  const probe = context.execute_xhsLoginProbe as
    | Record<string, unknown>
    | undefined;
  if (probe && typeof probe === "object" && probe.logged_in) {
    return {
      ...value,
      context: {
        logged_in: true,
        message: "已登录，无需二维码",
        next: "可直接运行其他小红书 automation",
      },
    };
  }

  const qr =
    context.execute_xhsLoginQrcode &&
    typeof context.execute_xhsLoginQrcode === "object"
      ? (context.execute_xhsLoginQrcode as Record<string, unknown>)
      : {};
  const dataUrl = String(qr.qrcode_data_url || "").trim();
  const files = [...((value && value.files) || [])];
  if (!dataUrl) {
    throw codedError(
      "XHS_QRCODE_MISSING",
      String(qr.error || "未获取到二维码"),
    );
  }
  const match = DATA_URL.exec(dataUrl);
  if (!match) {
    throw codedError("XHS_QRCODE_INVALID", "二维码 data URL 格式无效");
  }
  let payload;
  try {
    payload = Buffer.from(match[2].trim(), "base64");
  } catch (error) {
    throw codedError("XHS_QRCODE_INVALID", "二维码 base64 解码失败");
  }
  if (payload.length < 64) {
    throw codedError("XHS_QRCODE_INVALID", "二维码图片过小或已截断");
  }
  const target = path.join(artifactDir, "xhs_login_qrcode.png");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, payload);
  files.push(target);

  return {
    ...value,
    context: {
      logged_in: false,
      qrcode_png: target,
      qrcode_filename: path.basename(target),
      next:
        "把 qrcode_png 发给用户扫码，然后运行 xiaohongshu-wait-login。" +
        "不要用其他浏览器操作重新取码。",
    },
    files,
  };
}

export { LOGIN_QRCODE_SCRIPT, finalizeRunResult };
