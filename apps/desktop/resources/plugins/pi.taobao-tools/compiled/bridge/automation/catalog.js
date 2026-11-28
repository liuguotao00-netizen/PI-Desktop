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
exports.SUPPORTED_ACTIONS = exports.SCRIPTS_DIR = exports.PUBLISH_ACTIONS = exports.CAPTURE_ACTIONS = exports.KIND_INTERACT = exports.KIND_PUBLISH = exports.KIND_COLLECT = void 0;
exports.asInt = asInt;
exports.clearCache = clearCache;
exports.loadScripts = loadScripts;
exports.normalizeScript = normalizeScript;
exports.requireScript = requireScript;
exports.scriptCatalog = scriptCatalog;
/**
 * Automation script catalogue.
 *
 * The JSON files under `scripts/` are the product surface: id, platform,
 * variables, steps, outputs. Nothing here opens a browser. A script whose
 * steps use an action the engine cannot execute is rejected at load time
 * rather than failing halfway through a run.
 *
 * The DSL and the action vocabulary are aligned with QiWork's built-in
 * automation engine, so the same script files run on both hosts.
 */
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const errors_1 = require("./errors");
const SCRIPTS_DIR = path.join(__dirname, "scripts");
exports.SCRIPTS_DIR = SCRIPTS_DIR;
const SUPPORTED_ACTIONS = new Set([
    "wait",
    "execute",
    "transform",
    "assertPageState",
    "waitForSelector",
    "waitForElement",
    "waitForLoad",
    "waitForNavigation",
    "navigate",
    "reload",
    "click",
    "type",
    "hover",
    "scroll",
    "upload",
    "activateAndWaitForResponse",
    "activateAndWaitForNavigation",
    "downloadFile",
    "extractZip",
    "saveMarkdown",
    "sessionCapture",
    "scrollForSession",
    "scrollForState",
    "waitForState",
]);
exports.SUPPORTED_ACTIONS = SUPPORTED_ACTIONS;
const CAPTURE_ACTIONS = new Set(["sessionCapture", "scrollForSession"]);
exports.CAPTURE_ACTIONS = CAPTURE_ACTIONS;
/**
 * Actions that change something on the platform rather than read from it.
 * A script is a publishing script because it uses one of these, never because
 * it says so: a manifest cannot talk its way out of the classification.
 */
const PUBLISH_ACTIONS = new Set([
    "upload",
    "activateAndWaitForResponse",
    "activateAndWaitForNavigation",
]);
exports.PUBLISH_ACTIONS = PUBLISH_ACTIONS;
exports.KIND_COLLECT = "collect";
exports.KIND_PUBLISH = "publish";
/**
 * Writes that are not posts: a like, a comment, a saved draft. They change
 * the account, but a second identical like is harmless.
 */
exports.KIND_INTERACT = "interact";
const KINDS = new Set([exports.KIND_COLLECT, exports.KIND_PUBLISH, exports.KIND_INTERACT]);
function asInt(value, fallback = 0) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function readScriptFiles() {
    return fs
        .readdirSync(SCRIPTS_DIR)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => ({
        file,
        payload: fs.readFileSync(path.join(SCRIPTS_DIR, file), "utf8"),
    }));
}
function normalizeVariable(raw) {
    const key = String(raw.key ?? "").trim();
    if (!key)
        throw new errors_1.ContractError("automation variable is missing key");
    const variable = {
        key,
        label: String(raw.label || key),
        type: String(raw.type || "text"),
        required: raw.required !== false,
    };
    for (const name of [
        "default",
        "options",
        "placeholder",
        "accept",
        "minChars",
        "forbidChars",
        "lengthUnit",
    ]) {
        if (name in raw)
            variable[name] = raw[name];
    }
    return variable;
}
function scriptKind(scriptId, raw, actions) {
    const derived = [...actions].some((action) => PUBLISH_ACTIONS.has(action))
        ? exports.KIND_PUBLISH
        : exports.KIND_COLLECT;
    const declared = String(raw.kind ?? "").trim();
    if (!declared)
        return derived;
    if (!KINDS.has(declared)) {
        throw new errors_1.ContractError(`automation ${scriptId} has unknown kind ${JSON.stringify(declared)}`);
    }
    if ((declared === exports.KIND_COLLECT || declared === exports.KIND_INTERACT) &&
        derived === exports.KIND_PUBLISH) {
        throw new errors_1.ContractError(`automation ${scriptId} declares kind ${JSON.stringify(declared)} but uses ` +
            `[${[...actions].filter((action) => PUBLISH_ACTIONS.has(action)).join(", ")}]`);
    }
    // `publish` and `interact` may be declared without an action that proves
    // it: clicking a button whose label is "发布" is still a publish, and only
    // the manifest knows what that button does.
    return declared;
}
function normalizeScript(scriptId, raw) {
    const steps = raw.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
        throw new errors_1.ContractError(`automation ${scriptId} has no steps`);
    }
    const stepList = steps.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new errors_1.ContractError(`automation ${scriptId} step is invalid`);
        }
        return item;
    });
    const actions = new Set();
    stepList.forEach((step, index) => {
        const action = String(step.action ?? "");
        if (!action) {
            throw new errors_1.ContractError(`automation ${scriptId} step ${index} has no action`);
        }
        if (!SUPPORTED_ACTIONS.has(action)) {
            throw new errors_1.ContractError(`automation ${scriptId} uses unsupported action ${JSON.stringify(action)}`);
        }
        actions.add(action);
    });
    const variables = Array.isArray(raw.variables) ? raw.variables : [];
    if (raw.variables !== undefined &&
        raw.variables !== null &&
        !Array.isArray(raw.variables)) {
        throw new errors_1.ContractError(`automation ${scriptId} variables must be a list`);
    }
    const kind = scriptKind(scriptId, raw, actions);
    return {
        id: scriptId,
        name: String(raw.name || scriptId),
        platform: String(raw.platform || ""),
        description: String(raw.description || ""),
        kind,
        startUrl: String(raw.startUrl || ""),
        variables: variables
            .filter((item) => Boolean(item) && typeof item === "object" && !Array.isArray(item))
            .map((item) => normalizeVariable(item)),
        steps: stepList,
        contextSetup: raw.contextSetup && typeof raw.contextSetup === "object"
            ? raw.contextSetup
            : {},
        outputSchema: raw.outputSchema && typeof raw.outputSchema === "object"
            ? raw.outputSchema
            : {},
        dedupeWindowMs: asInt(raw.dedupeWindowMs),
        actions: [...actions].sort(),
        requiresCapture: [...actions].some((action) => CAPTURE_ACTIONS.has(action)),
    };
}
let cache = null;
/**
 * Load and validate every bundled automation.
 *
 * A malformed script is a packaging error, not a runtime one: it fails the
 * whole catalogue so `list_automations` never advertises something that
 * cannot run.
 */
function loadScripts() {
    if (cache)
        return cache;
    const scripts = {};
    for (const { file, payload } of readScriptFiles()) {
        const stem = path.basename(file, ".json");
        let raw;
        try {
            raw = JSON.parse(payload);
        }
        catch (error) {
            throw new errors_1.ContractError(`automation ${file} is not valid JSON`);
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new errors_1.ContractError(`automation ${file} must be an object`);
        }
        const record = raw;
        const scriptId = String(record.id || stem).trim();
        if (!scriptId || scripts[scriptId]) {
            throw new errors_1.ContractError(`automation id is empty or duplicated: ${scriptId}`);
        }
        if (scriptId !== stem) {
            throw new errors_1.ContractError(`automation id ${JSON.stringify(scriptId)} must match file ${JSON.stringify(stem)}`);
        }
        scripts[scriptId] = normalizeScript(scriptId, record);
    }
    cache = scripts;
    return scripts;
}
function requireScript(scriptId) {
    const scripts = loadScripts();
    const script = scripts[String(scriptId || "").trim()];
    if (!script) {
        throw new errors_1.ContractError(`未知自动化: ${scriptId}`);
    }
    return script;
}
/** Public catalogue for the tool; never includes the step JS bodies. */
function scriptCatalog() {
    return Object.values(loadScripts())
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((script) => ({
        id: script.id,
        name: script.name,
        description: script.description,
        platform: script.platform,
        kind: script.kind,
        startUrl: script.startUrl,
        variables: script.variables,
        stepCount: script.steps.length,
        actions: script.actions,
        requiresCapture: script.requiresCapture,
        outputs: Object.keys(script.outputSchema).sort(),
    }));
}
/** Forget the validated catalogue, for tests and development reloads. */
function clearCache() {
    cache = null;
}
