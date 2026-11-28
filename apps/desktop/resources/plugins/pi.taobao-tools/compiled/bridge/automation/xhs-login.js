"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOGIN_QRCODE_SCRIPT = void 0;
exports.finalizeRunResult = finalizeRunResult;
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
const errors_1 = require("./errors");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const LOGIN_QRCODE_SCRIPT = "xiaohongshu-login-qrcode";
exports.LOGIN_QRCODE_SCRIPT = LOGIN_QRCODE_SCRIPT;
const DATA_URL = /^data:image\/([a-zA-Z0-9+.-]+);base64,([\s\S]+)$/;
function finalizeRunResult(automationId, value, artifactDir) {
    if (automationId !== LOGIN_QRCODE_SCRIPT)
        return value;
    const context = {
        ...((value && typeof value.context === "object" && value.context) || {}),
    };
    const probe = context.execute_xhsLoginProbe;
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
    const qr = context.execute_xhsLoginQrcode &&
        typeof context.execute_xhsLoginQrcode === "object"
        ? context.execute_xhsLoginQrcode
        : {};
    const dataUrl = String(qr.qrcode_data_url || "").trim();
    const files = [...((value && value.files) || [])];
    if (!dataUrl) {
        throw (0, errors_1.codedError)("XHS_QRCODE_MISSING", String(qr.error || "未获取到二维码"));
    }
    const match = DATA_URL.exec(dataUrl);
    if (!match) {
        throw (0, errors_1.codedError)("XHS_QRCODE_INVALID", "二维码 data URL 格式无效");
    }
    let payload;
    try {
        payload = Buffer.from(match[2].trim(), "base64");
    }
    catch (error) {
        throw (0, errors_1.codedError)("XHS_QRCODE_INVALID", "二维码 base64 解码失败");
    }
    if (payload.length < 64) {
        throw (0, errors_1.codedError)("XHS_QRCODE_INVALID", "二维码图片过小或已截断");
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
            next: "把 qrcode_png 发给用户扫码，然后运行 xiaohongshu-wait-login。" +
                "不要用其他浏览器操作重新取码。",
        },
        files,
    };
}
