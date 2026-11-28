"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildContext = buildContext;
exports.compare = compare;
exports.contentIssues = contentIssues;
exports.coerceFiles = coerceFiles;
exports.getPath = getPath;
exports.globToRegex = globToRegex;
exports.publicContext = publicContext;
exports.renderTarget = renderTarget;
exports.renderTemplate = renderTemplate;
exports.resolveFiles = resolveFiles;
exports.textLength = textLength;
exports.truncateText = truncateText;
exports.xhsLength = xhsLength;
/**
 * Script parameters: templates, variable coercion and content limits.
 *
 * Everything here is pure data handling — no browser, no driver. Keeping it
 * separate from the executor is what lets a script's parameters be previewed
 * and validated without opening a page.
 */
const catalog_1 = require("./catalog");
const errors_1 = require("./errors");
function renderTemplate(value, context) {
    if (typeof value !== "string" || !value.includes("{{"))
        return value;
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawKey) => {
        const resolved = context[String(rawKey).trim()];
        return resolved === undefined || resolved === null ? "" : String(resolved);
    });
}
function _toNumberOrNull(value) {
    if (typeof value === "number")
        return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean")
        return value ? 1 : 0;
    const text = String(value ?? "").trim();
    if (!text)
        return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
}
function compare(left, op, right) {
    const numericLeft = _toNumberOrNull(left);
    const numericRight = _toNumberOrNull(right);
    const useNumbers = numericLeft !== null && numericRight !== null;
    const a = useNumbers ? numericLeft : String(left ?? "");
    const b = useNumbers ? numericRight : String(right ?? "");
    switch (op) {
        case ">":
            return a > b;
        case "<":
            return a < b;
        case ">=":
            return a >= b;
        case "<=":
            return a <= b;
        case "==":
            return a === b;
        case "!=":
            return a !== b;
        default:
            return false;
    }
}
function coerceFiles(raw) {
    if (raw === undefined || raw === null)
        return [];
    if (Array.isArray(raw)) {
        return raw.map((item) => String(item).trim()).filter(Boolean);
    }
    const text = String(raw).trim();
    if (!text)
        return [];
    if (text.startsWith("[")) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch (error) {
            throw new errors_1.ContractError("文件参数必须是 JSON 数组");
        }
        if (!Array.isArray(parsed))
            throw new errors_1.ContractError("文件参数必须是 JSON 数组");
        return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}
function buildContext(script, variables) {
    const context = {};
    const kinds = {};
    for (const variable of script.variables || []) {
        const key = variable.key;
        kinds[key] = String(variable.type || "text");
        context[key] =
            variables && Object.prototype.hasOwnProperty.call(variables, key)
                ? variables[key]
                : variable.default !== undefined
                    ? variable.default
                    : "";
    }
    for (const [key, spec] of Object.entries(script.contextSetup || {})) {
        if (!spec || typeof spec !== "object")
            continue;
        const kind = String(spec.type || "string");
        const source = Object.prototype.hasOwnProperty.call(context, key)
            ? context[key]
            : spec.default !== undefined
                ? spec.default
                : "";
        if (kind === "number") {
            const numeric = _toNumberOrNull(source);
            context[key] = numeric === null ? (0, catalog_1.asInt)(spec.default, 0) : Math.trunc(numeric);
        }
        else if (kind === "derived") {
            const baseKey = String(spec.source || "");
            const base = Object.prototype.hasOwnProperty.call(context, baseKey)
                ? context[baseKey]
                : spec.default;
            context[key] = compare(base, String(spec.op || ">"), spec.value);
        }
        else {
            context[key] = String(source === undefined || source === null ? "" : source);
        }
    }
    for (const [key, kind] of Object.entries(kinds)) {
        if (kind === "files" && key in context) {
            context[key] = coerceFiles(context[key]);
        }
    }
    return context;
}
function resolveFiles(value, context) {
    let raw = value;
    if (typeof value === "string") {
        const whole = value.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
        raw = whole
            ? Object.prototype.hasOwnProperty.call(context, whole[1].trim())
                ? context[whole[1].trim()]
                : ""
            : renderTemplate(value, context);
    }
    return coerceFiles(raw);
}
function utf16Length(text) {
    return text.length;
}
function xhsWeight(char) {
    let weight = 0;
    for (let index = 0; index < char.length; index += 1) {
        weight += char.charCodeAt(index) > 127 ? 2 : 1;
    }
    return weight;
}
/**
 * 小红书标题计数：非 ASCII 记 2、ASCII 记 1，求和后除 2 向上取整。
 *
 * "hello" counts 3, "你好世界" counts 4. Counting code points (or UTF-16
 * units) instead would truncate ASCII titles at half the room the platform
 * actually allows.
 */
function xhsLength(text) {
    let total = 0;
    for (const char of text)
        total += xhsWeight(char);
    return Math.ceil(total / 2);
}
/** Length in the platform's own counting unit. */
function textLength(text, unit = "chars") {
    const kind = String(unit).toLowerCase();
    const value = String(text ?? "");
    if (kind === "utf16")
        return utf16Length(value);
    if (kind === "xhs")
        return xhsLength(value);
    return [...value].length;
}
/** Cut *text* to a platform limit, in the platform's own counting unit. */
function truncateText(text, maxChars, unit = "chars") {
    const value = String(text ?? "");
    const limit = Number(maxChars) || 0;
    if (limit <= 0 || !value)
        return value;
    const kind = String(unit).toLowerCase();
    if (kind === "utf16" || kind === "xhs") {
        if (textLength(value, kind) <= limit)
            return value;
        let kept = "";
        let used = 0;
        for (const char of value) {
            const size = kind === "utf16" ? char.length : xhsWeight(char);
            const grown = used + size;
            if (kind === "xhs") {
                if (Math.ceil(grown / 2) > limit)
                    break;
            }
            else if (grown > limit) {
                break;
            }
            kept += char;
            used = grown;
        }
        return kept;
    }
    const chars = [...value];
    return chars.length <= limit ? value : chars.slice(0, limit).join("");
}
/** Translate the scripts' `*` url patterns into a regular expression. */
function globToRegex(pattern) {
    let output = "";
    for (const char of String(pattern || "*")) {
        if (char === "*")
            output += ".*";
        else if (char === "?")
            output += ".";
        else
            output += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return output;
}
/**
 * Problems the platform would reject before we touch the page.
 *
 * `maxChars` truncates text to fit; a minimum length or a forbidden character
 * cannot be fixed by truncating, so they are checked up front and reported.
 */
function contentIssues(script, context) {
    const issues = [];
    for (const variable of script.variables || []) {
        const key = String(variable.key || "");
        if (!key || String(variable.type || "") === "files")
            continue;
        const text = String(context[key] ?? "");
        if (!text)
            continue;
        const unit = String(variable.lengthUnit || "chars");
        const minimum = (0, catalog_1.asInt)(variable.minChars, 0);
        if (minimum > 0 && textLength(text, unit) < minimum) {
            issues.push(`${key} 至少需要 ${minimum} 字，现在是 ${textLength(text, unit)} 字`);
        }
        const forbidden = (Array.isArray(variable.forbidChars)
            ? variable.forbidChars
            : [])
            .map((char) => String(char))
            .filter(Boolean);
        const hits = forbidden.filter((char) => text.includes(char));
        if (hits.length) {
            issues.push(`${key} 含平台不支持的字符：${hits.join(" ")}`);
        }
    }
    return issues;
}
/** Render `{{var}}` inside a target's selector, text and shadow host. */
function renderTarget(target, context) {
    if (!target || typeof target !== "object")
        return {};
    const rendered = { ...target };
    for (const key of ["selector", "text", "shadowHost"]) {
        if (key in rendered)
            rendered[key] = renderTemplate(rendered[key], context);
    }
    return rendered;
}
/** Read a dotted path (`a.b.c`) out of an object. */
function getPath(value, path) {
    if (!path)
        return undefined;
    return String(path)
        .split(".")
        .filter(Boolean)
        .reduce((current, key) => {
        if (!current || typeof current !== "object")
            return undefined;
        return current[key];
    }, value);
}
/** Copy the context a page-side `execute` function may see. */
function publicContext(context) {
    return Object.fromEntries(Object.entries(context).filter(([key]) => !key.startsWith("_")));
}
