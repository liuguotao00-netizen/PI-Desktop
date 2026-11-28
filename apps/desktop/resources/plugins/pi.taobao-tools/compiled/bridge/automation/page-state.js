"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HINTS = void 0;
exports.classifySnapshot = classifySnapshot;
exports.hintFor = hintFor;
/**
 * What kind of page a failed run was looking at.
 *
 * A selector timeout has many causes, and they call for different reactions:
 * a captcha needs a person, a login wall needs an account, a deleted note is
 * not coming back, and a layout change needs a code fix.
 */
// Ordered: the first family that matches wins. A captcha page often also says
// "登录", so it has to be checked first.
const FAMILIES = [
    [
        "captcha",
        [
            "请完成验证",
            "请完成下方验证",
            "请进行验证",
            "安全验证",
            "拖动滑块",
            "点击按钮进行验证",
            "接收短信验证码",
            "身份验证",
            "风险提示",
        ],
    ],
    [
        "login",
        ["扫码登录", "请先登录", "登录后查看", "登录后可", "登录后评论", "未登录"],
    ],
    [
        "blocked",
        ["操作频繁", "禁止发布", "禁止发笔记", "违规", "账号异常", "无法发布"],
    ],
    [
        "not_found",
        [
            "页面不存在",
            "笔记不存在",
            "作品不存在",
            "内容不可见",
            "已删除",
            "暂时无法浏览",
            "无法访问",
        ],
    ],
];
const HINTS = {
    captcha: "平台要求人工验证，请先在浏览器里完成验证",
    login: "当前未登录或登录已过期，请先登录",
    blocked: "平台拒绝了这次操作（风控或权限限制）",
    not_found: "目标内容不存在、已删除或不可见",
    drift: "页面结构与脚本预期不一致，可能是平台改版",
};
exports.HINTS = HINTS;
function classifySnapshot(snapshot) {
    const record = snapshot && typeof snapshot === "object"
        ? snapshot
        : {};
    const text = `${String(record.title || "")}\n${String(record.body || "")}`;
    for (const [family, markers] of FAMILIES) {
        if (markers.some((marker) => text.includes(marker)))
            return family;
    }
    return "drift";
}
function hintFor(state) {
    return HINTS[state] || HINTS.drift;
}
