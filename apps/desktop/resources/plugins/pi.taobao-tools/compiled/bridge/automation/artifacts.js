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
exports.MAX_RESULT_CHARS = void 0;
exports.bounded = bounded;
exports.downloadFile = downloadFile;
exports.downloadRemoteFile = downloadRemoteFile;
exports.extractZip = extractZip;
exports.htmlToMarkdown = htmlToMarkdown;
exports.isRemoteFileRef = isRemoteFileRef;
exports.materializeScriptFiles = materializeScriptFiles;
exports.safeFilename = safeFilename;
exports.saveMarkdown = saveMarkdown;
exports.uniquePath = uniquePath;
exports.uploadAllowedSuffixes = uploadAllowedSuffixes;
/**
 * Run artifacts: downloads, archives, Markdown and size-bounded results.
 *
 * Ported from QiWork's `automation/artifacts.py`. Files land inside the run's
 * artifact directory; nothing is written outside it.
 */
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const errors_1 = require("./errors");
const params_1 = require("./params");
const AdmZip = require("../vendor/adm-zip");
const MAX_RESULT_CHARS = 200_000;
exports.MAX_RESULT_CHARS = MAX_RESULT_CHARS;
const IMAGE_SUFFIXES = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
function safeFilename(value) {
    const name = String(value || "")
        .replace(/[\\/:*?"<>|\r\n]/g, "_")
        .trim()
        .slice(0, 120);
    return name || "download";
}
function uniquePath(directory, filename) {
    const parsed = path.parse(filename);
    let candidate = path.join(directory, filename);
    let index = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(directory, `${parsed.name} (${index})${parsed.ext}`);
        index += 1;
    }
    return candidate;
}
function isRemoteFileRef(value) {
    const lower = String(value || "").trim().toLowerCase();
    return lower.startsWith("http://") || lower.startsWith("https://");
}
function suffixFromUrl(url) {
    let pathname = "";
    try {
        pathname = new URL(url).pathname.toLowerCase();
    }
    catch (error) {
        pathname = String(url || "").toLowerCase();
    }
    for (const suffix of IMAGE_SUFFIXES) {
        if (pathname.endsWith(suffix))
            return suffix;
    }
    return ".jpg";
}
function suffixFromContentType(contentType) {
    const lowered = String(contentType || "").split(";")[0].trim().toLowerCase();
    return ({
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }[lowered] || ".jpg");
}
async function downloadRemoteFile(url, destDir, { driver, allowedSuffixes }) {
    const cleaned = String(url || "").trim();
    if (!isRemoteFileRef(cleaned)) {
        throw (0, errors_1.codedError)("AUTOMATION_UPLOAD_INVALID", `不是有效的图片 URL：${url}`);
    }
    const allowed = allowedSuffixes || IMAGE_SUFFIXES;
    fs.mkdirSync(destDir, { recursive: true });
    const fetched = await driver.fetchBinary(cleaned);
    let suffix = suffixFromUrl(cleaned);
    if (suffix === ".jpg" && fetched.contentType) {
        suffix = suffixFromContentType(fetched.contentType);
    }
    if (!allowed.has(suffix.toLowerCase())) {
        throw (0, errors_1.codedError)("AUTOMATION_UPLOAD_INVALID", `不支持的图片类型：${suffix}`);
    }
    const digest = crypto
        .createHash("sha256")
        .update(cleaned)
        .digest("hex")
        .slice(0, 16);
    const target = path.join(destDir, `remote_${digest}${suffix}`);
    if (!fs.existsSync(target)) {
        fs.writeFileSync(target, fetched.bytes);
    }
    return path.resolve(target);
}
function uploadAllowedSuffixes(script) {
    for (const step of script.steps || []) {
        if (!step || step.action !== "upload")
            continue;
        const verify = (step.params && step.params.verify) || {};
        const items = verify.allowedExtensions || [];
        if (items.length) {
            return new Set(items.map((item) => String(item).toLowerCase()));
        }
    }
    return IMAGE_SUFFIXES;
}
/**
 * Replace http(s) entries in file-typed variables with local paths.
 *
 * Downloads run through the page (same credentials, same referer) instead of
 * the plugin process, so no host egress grant is involved.
 */
async function materializeScriptFiles(script, context, artifactDir, driver) {
    const allowed = uploadAllowedSuffixes(script);
    const fileKeys = (script.variables || [])
        .filter((item) => String(item.type || "") === "files")
        .map((item) => String(item.key));
    const downloadDir = path.join(artifactDir, "downloads");
    for (const key of fileKeys) {
        const rawList = context[key];
        if (!Array.isArray(rawList))
            continue;
        if (!rawList.some((item) => isRemoteFileRef(String(item))))
            continue;
        const resolved = [];
        for (const raw of rawList) {
            const text = String(raw).trim();
            if (!text)
                continue;
            if (isRemoteFileRef(text)) {
                resolved.push(await downloadRemoteFile(text, downloadDir, {
                    driver,
                    allowedSuffixes: allowed,
                }));
                continue;
            }
            if (!path.isAbsolute(text)) {
                throw (0, errors_1.codedError)("AUTOMATION_UPLOAD_INVALID", `文件必须是绝对路径或 http(s) URL：${text}`);
            }
            resolved.push(text);
        }
        context[key] = resolved;
    }
}
async function downloadFile(step, { context, driver, artifactDir, files, }) {
    const params = (step && step.params) || {};
    const url = (0, params_1.getPath)(context, String(params.urlFromContext || "")) || params.url;
    if (!url) {
        throw (0, errors_1.codedError)("AUTOMATION_DOWNLOAD_URL_MISSING", "downloadFile 缺少下载地址");
    }
    const filename = safeFilename((0, params_1.renderTemplate)(params.filename || "download.bin", context));
    const target = uniquePath(artifactDir, filename);
    const encoded = await driver.evaluate("(async () => {\n" +
        `  const response = await fetch(${JSON.stringify(String(url))}, { credentials: 'include' });\n` +
        "  if (!response.ok) throw new Error('HTTP ' + response.status);\n" +
        "  const bytes = new Uint8Array(await response.arrayBuffer());\n" +
        "  let binary = ''; const chunk = 0x8000;\n" +
        "  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));\n" +
        "  return btoa(binary);\n" +
        "})()", { timeoutMs: 300_000 });
    fs.writeFileSync(target, Buffer.from(String(encoded || ""), "base64"));
    files.push(target);
    if (params.saveAs) {
        context[`execute_${params.saveAs}`] = {
            filePath: target,
            filename: path.basename(target),
            url: String(url),
        };
    }
}
function convertCsvEncoding(directory, encoding) {
    let decoder;
    try {
        decoder = new TextDecoder(String(encoding || "gb18030"));
    }
    catch (error) {
        throw (0, errors_1.codedError)("AUTOMATION_CSV_ENCODING", `不支持的编码：${encoding}`);
    }
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.name.toLowerCase().endsWith(".csv"))
                continue;
            let text;
            try {
                text = decoder.decode(fs.readFileSync(full));
            }
            catch (error) {
                throw (0, errors_1.codedError)("AUTOMATION_CSV_ENCODING", `CSV 转码失败：${full}（${encoding}）`);
            }
            fs.writeFileSync(full, `\uFEFF${text}`, "utf8");
        }
    };
    walk(directory);
}
function extractZip(step, { context, files }) {
    const params = (step && step.params) || {};
    const zipPath = (0, params_1.getPath)(context, String(params.zipPathFromContext || "")) || params.zipPath;
    if (!zipPath || !fs.existsSync(String(zipPath)) || !fs.statSync(String(zipPath)).isFile()) {
        throw (0, errors_1.codedError)("AUTOMATION_ZIP_MISSING", `extractZip 找不到压缩包：${zipPath || "(空)"}`);
    }
    const source = path.resolve(String(zipPath));
    const dest = path.join(path.dirname(source), `${path.parse(source).name}.extracted`);
    fs.mkdirSync(dest, { recursive: true });
    const destRoot = path.resolve(dest);
    const archive = new AdmZip(source);
    for (const entry of archive.getEntries()) {
        const target = path.resolve(dest, entry.entryName);
        if (target !== destRoot && !target.startsWith(`${destRoot}${path.sep}`)) {
            throw (0, errors_1.codedError)("AUTOMATION_ZIP_INVALID", `压缩包包含非法路径：${entry.entryName}`);
        }
        if (entry.isDirectory) {
            fs.mkdirSync(target, { recursive: true });
            continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.getData());
    }
    const post = (params.postProcess || {});
    if (post.name === "alimamaCsvPostProcess") {
        convertCsvEncoding(dest, String((post.params && post.params.fromEncoding) || "gb18030"));
    }
    const extracted = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory())
                walk(full);
            else if (entry.isFile())
                extracted.push(full);
        }
    };
    walk(dest);
    extracted.sort();
    files.push(...extracted);
    if (params.saveAs) {
        context[`execute_${params.saveAs}`] = { dir: dest, files: extracted };
    }
}
function decodeEntities(text) {
    return String(text)
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&amp;/g, "&");
}
function attribute(attrs, name) {
    const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
    if (!match)
        return "";
    return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}
class MarkdownWriter {
    out = "";
    atLineStart = true;
    quoteDepth = 0;
    lists = [];
    link = null;
    table = null;
    inHead = false;
    render(html) {
        const text = String(html || "")
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "");
        const preBlocks = [];
        const withoutPre = text.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (_match, attrs, body) => {
            const inner = body
                .replace(/^\s*<code\b[^>]*>/i, "")
                .replace(/<\/code>\s*$/i, "")
                .replace(/<[^>]+>/g, "");
            const lang = /language-([\w-]+)/i.exec(attrs)?.[1] ??
                /data-lang=["']([^"']+)/i.exec(attrs)?.[1] ??
                "";
            preBlocks.push({ lang, text: decodeEntities(inner) });
            return `\u0000PRE${preBlocks.length - 1}\u0000`;
        });
        const token = /<!--[\s\S]*?-->|<\s*\/\s*([a-zA-Z][\w-]*)\s*>|<\s*([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
        let last = 0;
        let match;
        while ((match = token.exec(withoutPre))) {
            if (match.index > last) {
                this.text(withoutPre.slice(last, match.index), preBlocks);
            }
            if (match[1])
                this.close(match[1].toLowerCase());
            else if (match[2])
                this.open(match[2].toLowerCase(), match[3] || "");
            last = token.lastIndex;
        }
        if (last < withoutPre.length) {
            this.text(withoutPre.slice(last), preBlocks);
        }
        return this.out
            .split("\n")
            .map((line) => line.replace(/[ \t]+$/g, ""))
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }
    text(raw, preBlocks) {
        if (!raw)
            return;
        for (const part of raw.split(/(\u0000PRE\d+\u0000)/)) {
            if (!part)
                continue;
            const placeholder = /^\u0000PRE(\d+)\u0000$/.exec(part);
            if (placeholder) {
                const block = preBlocks[Number(placeholder[1])];
                if (block)
                    this.codeBlock(block.lang, block.text);
                continue;
            }
            const value = decodeEntities(part).replace(/\s+/g, " ");
            if (!value.trim()) {
                if (this.out && !this.out.endsWith("\n") && !this.out.endsWith(" ")) {
                    this.out += " ";
                }
                continue;
            }
            this.write(value);
        }
    }
    write(value) {
        if (!value)
            return;
        if (this.table && this.table.cell !== null) {
            this.table.cell += value;
            return;
        }
        if (this.link) {
            this.link.text += value;
            return;
        }
        if (this.atLineStart) {
            this.out += `${"> ".repeat(this.quoteDepth)}`;
            this.atLineStart = false;
        }
        if (this.out.endsWith(" ") && value.startsWith(" ")) {
            this.out = this.out.slice(0, -1);
        }
        this.out += value;
    }
    newline(count = 1) {
        if (!this.out)
            return;
        this.out = this.out.replace(/[ \t]+$/g, "");
        const wanted = Math.max(1, count);
        let existing = 0;
        while (existing < wanted && this.out.endsWith("\n")) {
            this.out = this.out.slice(0, -1);
            existing += 1;
        }
        this.out += "\n".repeat(wanted);
        this.atLineStart = true;
    }
    block() {
        this.newline(this.lists.length ? 1 : 2);
    }
    open(tag, attrs) {
        switch (tag) {
            case "h1":
            case "h2":
            case "h3":
            case "h4":
            case "h5":
            case "h6": {
                this.block();
                const level = Number(tag.slice(1));
                this.write(`${"#".repeat(level)} `);
                break;
            }
            case "p":
            case "div":
            case "section":
            case "article":
            case "header":
            case "footer":
            case "main":
            case "aside":
            case "figure":
                this.block();
                break;
            case "br":
                this.newline(1);
                break;
            case "hr":
                this.block();
                this.write("---");
                this.newline(2);
                break;
            case "strong":
            case "b":
                this.write("**");
                break;
            case "em":
            case "i":
                this.write("*");
                break;
            case "del":
            case "s":
            case "strike":
                this.write("~~");
                break;
            case "code":
                this.write("`");
                break;
            case "a":
                this.link = { href: attribute(attrs, "href"), text: "" };
                break;
            case "img": {
                const alt = attribute(attrs, "alt");
                const src = attribute(attrs, "src");
                if (src)
                    this.write(`![${alt}](${src})`);
                break;
            }
            case "ul":
            case "ol":
                this.block();
                this.lists.push({ ordered: tag === "ol", index: 1 });
                break;
            case "li": {
                this.newline(1);
                const list = this.lists[this.lists.length - 1];
                const indent = "  ".repeat(Math.max(0, this.lists.length - 1));
                const marker = list?.ordered ? `${list.index}. ` : "- ";
                if (list?.ordered)
                    list.index += 1;
                this.write(`${indent}${marker}`);
                break;
            }
            case "blockquote":
                if (this.quoteDepth === 0)
                    this.block();
                this.quoteDepth += 1;
                break;
            case "table":
                this.block();
                this.table = { header: [], rows: [], row: null, cell: null, head: false };
                this.inHead = false;
                break;
            case "thead":
                this.inHead = true;
                break;
            case "tbody":
            case "tfoot":
                this.inHead = false;
                break;
            case "tr":
                if (this.table)
                    this.table.row = [];
                break;
            case "th":
            case "td":
                if (this.table)
                    this.table.cell = "";
                break;
            default:
                break;
        }
    }
    close(tag) {
        switch (tag) {
            case "h1":
            case "h2":
            case "h3":
            case "h4":
            case "h5":
            case "h6":
            case "p":
                this.newline(2);
                break;
            case "div":
            case "section":
            case "article":
            case "header":
            case "footer":
            case "main":
            case "aside":
            case "figure":
                this.block();
                break;
            case "strong":
            case "b":
                this.write("**");
                break;
            case "em":
            case "i":
                this.write("*");
                break;
            case "del":
            case "s":
            case "strike":
                this.write("~~");
                break;
            case "code":
                this.write("`");
                break;
            case "a": {
                const link = this.link;
                this.link = null;
                if (link) {
                    const label = link.text.trim() || link.href;
                    this.write(`[${label}](${link.href})`);
                }
                break;
            }
            case "ul":
            case "ol":
                this.lists.pop();
                this.newline(this.lists.length ? 1 : 2);
                break;
            case "li":
                this.newline(1);
                break;
            case "blockquote":
                this.quoteDepth = Math.max(0, this.quoteDepth - 1);
                if (this.quoteDepth === 0)
                    this.newline(2);
                break;
            case "th":
            case "td":
                this.closeCell();
                break;
            case "tr":
                this.closeRow();
                break;
            case "table":
                this.closeRow();
                this.emitTable();
                this.table = null;
                this.newline(2);
                break;
            default:
                break;
        }
    }
    closeCell() {
        if (!this.table || this.table.cell === null)
            return;
        const cell = this.table.cell.replace(/\s+/g, " ").trim();
        this.table.cell = null;
        if (this.table.row)
            this.table.row.push(cell);
    }
    closeRow() {
        if (!this.table || !this.table.row)
            return;
        const row = this.table.row;
        this.table.row = null;
        if (!row.length)
            return;
        if (this.inHead && this.table.header.length === 0) {
            this.table.header = row;
        }
        else {
            this.table.rows.push(row);
        }
    }
    emitTable() {
        const table = this.table;
        if (!table)
            return;
        const all = [table.header, ...table.rows].filter((row) => row.length);
        if (!all.length)
            return;
        const columns = Math.max(...all.map((row) => row.length), 1);
        const format = (row) => {
            const cells = [...row];
            while (cells.length < columns)
                cells.push("");
            return `| ${cells
                .map((cell) => cell.replace(/\|/g, "\\|"))
                .join(" | ")} |`;
        };
        const header = table.header.length ? table.header : new Array(columns).fill("");
        this.block();
        this.write(format(header));
        this.newline(1);
        this.write(`| ${new Array(columns).fill("---").join(" | ")} |`);
        this.newline(1);
        for (const row of table.rows) {
            this.write(format(row));
            this.newline(1);
        }
        this.newline(2);
    }
    codeBlock(lang, text) {
        this.block();
        this.write(`\`\`\`${lang}`);
        this.newline(1);
        this.out += text.replace(/\n$/, "");
        this.atLineStart = this.out.endsWith("\n");
        this.newline(1);
        this.write("```");
        this.newline(2);
    }
}
/** HTML→Markdown for readable articles: headings, lists, quotes, code and tables. */
function htmlToMarkdown(html) {
    return new MarkdownWriter().render(String(html || ""));
}
function saveMarkdown(step, { context, artifactDir, files, }) {
    const params = (step && step.params) || {};
    const rawArticle = (0, params_1.getPath)(context, `execute_${params.inputFrom || ""}`);
    const article = rawArticle && typeof rawArticle === "object" && !Array.isArray(rawArticle)
        ? rawArticle
        : {};
    if (!rawArticle || typeof rawArticle !== "object" || Array.isArray(rawArticle)) {
        throw (0, errors_1.codedError)("AUTOMATION_ARTICLE_FAILED", "saveMarkdown 输入不是文章对象");
    }
    if (article.errorHint) {
        throw (0, errors_1.codedError)("AUTOMATION_ARTICLE_FAILED", String(article.errorHint));
    }
    const title = String(article.title || "无标题");
    const bodyHtml = String(article.contentHtml || "");
    const bodyText = String(article.contentText || "");
    const body = bodyHtml ? htmlToMarkdown(bodyHtml) : bodyText;
    const lines = [`# ${title}`];
    if (article.author)
        lines.push("", `**作者**：${article.author}`);
    if (article.publishTime)
        lines.push(`**发布时间**：${article.publishTime}`);
    lines.push("", "---", "", body);
    const target = uniquePath(artifactDir, `${safeFilename(title).slice(0, 80) || "article"}.md`);
    fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
    files.push(target);
    if (params.saveAs) {
        context[`execute_${params.saveAs}`] = {
            filePath: target,
            title,
            filename: path.basename(target),
        };
    }
}
function bounded(value, artifactDir) {
    const payload = JSON.stringify(value);
    if (payload === undefined || payload.length <= MAX_RESULT_CHARS)
        return value;
    const target = path.join(artifactDir, "result.json");
    fs.writeFileSync(target, payload, "utf8");
    return {
        truncated: true,
        reason: "结果超过上下文上限，已写入文件",
        file: target,
    };
}
