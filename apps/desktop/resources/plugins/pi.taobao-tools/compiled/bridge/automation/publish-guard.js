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
exports.DEFAULT_WINDOW_MS = void 0;
exports.buildKey = buildKey;
exports.check = check;
exports.clear = clear;
exports.digestContext = digestContext;
exports.pending = pending;
exports.record = record;
/**
 * One-attempt memory for publishing, so a retry cannot double-post.
 *
 * `PUBLISH_UNCONFIRMED` is the awkward failure: the post may already be live
 * and the tool could not prove it. The natural next move — run it again — is
 * the one move that publishes twice. A publish is remembered the moment the
 * button is pressed, and the same content cannot be attempted again on that
 * automation inside the script's own `dedupeWindowMs`.
 *
 * The memory is persisted: a restart or a second process must not forget that
 * a post was already attempted.
 *
 * Ported from QiWork's `automation/publish_guard.py`.
 */
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const DEFAULT_WINDOW_MS = 300_000;
exports.DEFAULT_WINDOW_MS = DEFAULT_WINDOW_MS;
const MAX_ENTRIES = 256;
function dataDir() {
    const root = process.env.PI_DESKTOP_DATA_DIR || path.join(os.homedir(), ".pi-desktop");
    return path.join(root, "plugins", "data", "pi.taobao-tools", "automation");
}
function attemptsPath() {
    return path.join(dataDir(), "publish-attempts.json");
}
function readAttempts() {
    try {
        const raw = JSON.parse(fs.readFileSync(attemptsPath(), "utf8"));
        return raw && typeof raw === "object" && !Array.isArray(raw)
            ? raw
            : {};
    }
    catch (error) {
        return {};
    }
}
function writeAttempts(attempts) {
    fs.mkdirSync(path.dirname(attemptsPath()), { recursive: true });
    const temporary = `${attemptsPath()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(attempts), "utf8");
    fs.renameSync(temporary, attemptsPath());
}
function prune(attempts, windowMs) {
    const now = Date.now();
    for (const [key, started] of Object.entries(attempts)) {
        if (!Number.isFinite(Number(started)) || now - Number(started) >= windowMs) {
            delete attempts[key];
        }
    }
}
/** Stable key-sorted JSON, so two equal parameter sets digest the same. */
function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const record = value;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}
/** Stable fingerprint of the parameters that were shown to the user. */
function digestContext(context) {
    return crypto
        .createHash("sha256")
        .update(stableStringify(context || {}))
        .digest("hex");
}
function buildKey(automation, digest) {
    return `local|${automation}|${digest}`;
}
/** Throw if this exact content was published inside the window. */
function check(key, { windowMs = DEFAULT_WINDOW_MS } = {}) {
    const window = Math.max(0, Number(windowMs) || 0);
    if (window <= 0)
        return;
    const attempts = readAttempts();
    prune(attempts, window);
    const started = Number(attempts[key]);
    if (!Number.isFinite(started))
        return;
    const age = Date.now() - started;
    if (age >= window)
        return;
    const left = Math.max(1, Math.ceil((window - age) / 1000));
    const error = new Error("这条内容刚刚已经尝试发布过，请先到平台上确认是否已发出；" +
        `${left} 秒后才能再次尝试`);
    error.code = "PUBLISH_ALREADY_ATTEMPTED";
    error.details = { retryAfterSeconds: left };
    throw error;
}
/** Remember the attempt, before the click rather than after it. */
function record(key) {
    const attempts = readAttempts();
    prune(attempts, DEFAULT_WINDOW_MS);
    attempts[key] = Date.now();
    while (Object.keys(attempts).length >= MAX_ENTRIES) {
        let oldestKey = null;
        let oldest = Infinity;
        for (const [item, started] of Object.entries(attempts)) {
            if (Number(started) < oldest) {
                oldest = Number(started);
                oldestKey = item;
            }
        }
        if (oldestKey === null)
            break;
        delete attempts[oldestKey];
    }
    writeAttempts(attempts);
}
function pending() {
    return readAttempts();
}
function clear() {
    try {
        fs.rmSync(attemptsPath(), { force: true });
    }
    catch (error) {
        // Already gone.
    }
}
