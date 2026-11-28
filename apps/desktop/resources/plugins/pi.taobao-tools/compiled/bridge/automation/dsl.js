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
exports.KEEP_TAB_CODES = exports.ACTION_HANDLERS = exports.CONTRACT_VERSION = void 0;
exports.runScript = runScript;
exports.runStep = runStep;
/**
 * Interpreter for the automation JSON DSL.
 *
 * The scripts are data: steps name an action and its parameters, and the page
 * does the work. This module decides when each action runs and how its result
 * is folded back into the context; the page-side JavaScript lives in
 * `page-scripts.cjs`, the parameter handling in `params.cjs` and artifact
 * writing in `artifacts.cjs`.
 *
 * Ported from QiWork's `automation/dsl.py`; the action vocabulary and the
 * script contract are deliberately the same so one script library runs on
 * both hosts.
 */
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const catalog_1 = require("./catalog");
const errors_1 = require("./errors");
const params = __importStar(require("./params"));
const ps = __importStar(require("./page-scripts"));
const artifacts = __importStar(require("./artifacts"));
const driver_1 = require("./driver");
const page_state_1 = require("./page-state");
const CONTRACT_VERSION = "1.0";
exports.CONTRACT_VERSION = CONTRACT_VERSION;
const POLL_MS = ps.POLL_MS;
const KEEP_TAB_CODES = new Set([
    "AUTH_REQUIRED",
    "LOGIN_REQUIRED",
    "RISK_CONTROL",
    "RISK_CAPTCHA",
    "HUMAN_VERIFICATION_REQUIRED",
    "PUBLISH_UNCONFIRMED",
    "CLICK_OUTCOME_UNKNOWN",
    "AUTOMATION_UPLOAD_FAILED",
    "AUTOMATION_UPLOAD_TIMEOUT",
    "AUTOMATION_TARGET_DISABLED",
]);
exports.KEEP_TAB_CODES = KEEP_TAB_CODES;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (low, high) => low + Math.random() * Math.max(0, high - low);
const toolError = errors_1.codedError;
function stepTimeoutMs(step) {
    const value = (0, catalog_1.asInt)(step && step.timeout, 0);
    return value || 30_000;
}
function sessionInput(context, sessionKey) {
    const sessions = context._sessions || {};
    const spec = sessions[sessionKey] || {};
    const captures = context._captures || [];
    const urlIncludes = spec.urlIncludes || [];
    const bodies = [];
    for (const capture of captures) {
        const url = String(capture.url || "");
        if (urlIncludes.length && !urlIncludes.some((part) => url.includes(part))) {
            continue;
        }
        bodies.push(capture.body);
    }
    let rawKey = null;
    for (const item of spec.valueKey || []) {
        if (item && item.name === "raw" && item.path) {
            rawKey = String(item.path);
            break;
        }
    }
    if (!rawKey)
        return bodies;
    const extracted = [];
    for (const body of bodies)
        extracted.push(...extractPath(body, rawKey));
    return extracted;
}
/** Minimal `a.b[].c` extraction; returns a flat list of matches. */
function extractPath(value, expression) {
    const parts = String(expression || "")
        .split(".")
        .filter(Boolean);
    let current = [value];
    for (const part of parts) {
        const isList = part.endsWith("[]");
        const name = isList ? part.slice(0, -2) : part;
        const next = [];
        for (const item of current) {
            if (!item || typeof item !== "object")
                continue;
            const found = item[name];
            if (isList && Array.isArray(found))
                next.push(...found);
            else if (!isList && found !== undefined)
                next.push(found);
        }
        current = next;
    }
    return current;
}
function sessionSpecs(stepParams) {
    const specs = [];
    const list = stepParams && Array.isArray(stepParams.sessionList)
        ? stepParams.sessionList
        : [];
    for (const rawItem of list) {
        const item = rawItem;
        if (!item || typeof item !== "object" || !item.sessionKey)
            continue;
        specs.push({
            sessionKey: String(item.sessionKey),
            urlIncludes: (Array.isArray(item.urlIncludes) ? item.urlIncludes : []).map((part) => String(part)),
            ...(typeof item.countByValueKey === "string"
                ? { countByValueKey: item.countByValueKey }
                : {}),
            ...(typeof item.hasNextKey === "string"
                ? { hasNextKey: item.hasNextKey }
                : {}),
            ...(Array.isArray(item.valueKey)
                ? {
                    valueKey: item.valueKey,
                }
                : {}),
        });
    }
    return specs;
}
function captureSessions(script) {
    const sessions = {};
    for (const step of script.steps || []) {
        if (step.action !== "sessionCapture")
            continue;
        for (const spec of sessionSpecs(step.params || {})) {
            sessions[spec.sessionKey] = spec;
        }
    }
    return sessions;
}
function boxOf(probe) {
    return {
        left: Number(probe.left || 0),
        top: Number(probe.top || 0),
        width: Number(probe.width || 0),
        height: Number(probe.height || 0),
    };
}
/**
 * Points to try inside a button, top edge first.
 *
 * The bottom of the viewport is where the app draws its "正在操作" bar, and a
 * platform's primary button lives exactly there. The button's upper strip is
 * usually still reachable, so the scan starts at the top instead of the
 * centre.
 */
function pressPoints(box) {
    const left = Number(box.left || 0);
    const top = Number(box.top || 0);
    const width = Number(box.width || 0);
    const height = Number(box.height || 0);
    if (width <= 0 || height <= 0)
        return [];
    const middle = left + width / 2;
    const steps = Math.min(9, Math.max(3, Math.floor(height / 3)));
    const points = [];
    for (let index = 0; index < steps; index += 1) {
        points.push([
            middle,
            top + 2 + ((height - 4) * index) / (steps - 1),
        ]);
    }
    points.push([left + width * 0.3, top + 2]);
    points.push([left + width * 0.7, top + 2]);
    const seen = new Set();
    const unique = [];
    for (const point of points) {
        const key = `${point[0].toFixed(1)}:${point[1].toFixed(1)}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(point);
    }
    return unique;
}
function unknownClick(error) {
    return toolError("CLICK_OUTCOME_UNKNOWN", "点击可能已经发出，但没有拿到结果；不要重复点击，先到平台确认", { cause: String(error?.message || error) });
}
async function pressHittable(driver, box, elementExpression, onPublish) {
    for (const [x, y] of pressPoints(box)) {
        let reachable = false;
        try {
            reachable = Boolean(await driver.evaluate(ps.hitScript(elementExpression, x, y)));
        }
        catch (error) {
            reachable = false;
        }
        if (!reachable)
            continue;
        if (onPublish)
            onPublish();
        try {
            await driver.clickAt(x, y);
            return true;
        }
        catch (error) {
            // The press may have reached the page and only the answer was lost.
            throw unknownClick(error);
        }
    }
    return false;
}
/* ------------------------------- executor -------------------------------- */
async function runScript({ script, variables, driver, artifactDir, timeoutMs = 300_000, onPublish = null, onProgress = null, signal = null, }) {
    fs.mkdirSync(artifactDir, { recursive: true });
    const context = params.buildContext(script, variables || {});
    context._captures = [];
    context._sessions = captureSessions(script);
    // Open the script's starting page first: remote files are downloaded
    // through that page (same credentials, same referer), and a script without
    // a start URL only needs the pane attached.
    await openScript(script, context, driver);
    await artifacts.materializeScriptFiles(script, context, artifactDir, driver);
    // Files are checked before the first step: a missing image should be a
    // sentence, not a form half-filled and abandoned.
    preflightUploads(script, context);
    const issues = params.contentIssues(script, context);
    if (issues.length) {
        throw toolError("AUTOMATION_CONTENT_INVALID", issues.join("；"), { issues });
    }
    const files = [];
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 0);
    let lastUrl = await driver.currentUrl();
    try {
        const steps = script.steps || [];
        for (let index = 0; index < steps.length; index += 1) {
            const rawStep = steps[index];
            if (Date.now() >= deadline) {
                throw toolError("AUTOMATION_TIMEOUT", "自动化执行超时");
            }
            if (signal && signal.aborted) {
                throw toolError("ABORTED", "自动化已中止");
            }
            let step = rawStep;
            if (step.when && !context[String(step.when)])
                continue;
            const condition = String(step.whenState || "").trim();
            if (condition && !(await driver.evaluate(`Boolean(${condition})`))) {
                continue;
            }
            if (onProgress) {
                onProgress({
                    step: index + 1,
                    total: steps.length,
                    action: step.action,
                    description: step.description || step.action,
                });
            }
            if (step.target && typeof step.target === "object") {
                step = { ...step, target: params.renderTarget(step.target, context) };
                if (step.hoverTarget && typeof step.hoverTarget === "object") {
                    step.hoverTarget = params.renderTarget(step.hoverTarget, context);
                }
            }
            await runStep(step, {
                context,
                driver,
                artifactDir,
                files,
                onPublish,
            });
            // A click that navigates replaces the document; re-apply any capture
            // interceptor the script installed so later steps still see responses.
            if (driver.hasInstalledSources && driver.hasInstalledSources()) {
                const currentUrl = await driver.currentUrl();
                if (currentUrl && currentUrl !== lastUrl) {
                    lastUrl = currentUrl;
                    await driver.reinstall();
                }
            }
            const postWait = step.postWait;
            if (postWait !== undefined) {
                const [low, high] = Array.isArray(postWait)
                    ? [Number(postWait[0]) || 0, Number(postWait[postWait.length - 1]) || 0]
                    : [Number(postWait) || 0, Number(postWait) || 0];
                await sleep(Math.max(0, randomBetween(low, high)));
            }
        }
    }
    catch (error) {
        // The tab is always kept: blanking the user's pane loses their context,
        // and a captcha or half-filled form must stay reachable.
        await recordFailure(driver, artifactDir, error);
        throw error;
    }
    return {
        schemaVersion: CONTRACT_VERSION,
        ok: true,
        automation: script.id,
        context: artifacts.bounded(params.publicContext(context), artifactDir),
        files,
    };
}
async function captureFailure(driver, artifactDir) {
    try {
        return await driver.capture(path.join(artifactDir, "failure.png"));
    }
    catch (error) {
        return "";
    }
}
async function recordFailure(driver, artifactDir, error) {
    if (!(error instanceof Error)) {
        error = new Error(String(error));
    }
    const failure = error;
    const screenshot = await captureFailure(driver, artifactDir);
    if (!failure.details)
        failure.details = {};
    if (screenshot)
        failure.details.screenshot = screenshot;
    let snapshot = {};
    try {
        snapshot = await driver.pageSnapshot();
    }
    catch (err) {
        snapshot = {};
    }
    const url = String(snapshot.url || "");
    if (url)
        failure.details.pageUrl = url;
    if (snapshot && Object.keys(snapshot).length) {
        const state = (0, page_state_1.classifySnapshot)(snapshot);
        failure.details.pageState = state;
        failure.details.pageHint = (0, page_state_1.hintFor)(state);
        failure.details.pageTitle = String(snapshot.title || "");
    }
    try {
        fs.writeFileSync(path.join(artifactDir, "failure.json"), JSON.stringify({
            code: String(error.code || "AUTOMATION_FAILED"),
            message: String(error.message || error),
            details: failure.details,
        }, null, 2), "utf8");
    }
    catch (err) {
        // Diagnostics must not mask the original error.
    }
}
async function openScript(script, context, driver) {
    const start = params.renderTemplate(script.startUrl || "", context);
    if (start)
        await driver.open(String(start));
    else
        await driver.attach();
}
async function runStep(step, state) {
    const action = String(step.action || "");
    const handler = ACTION_HANDLERS[action];
    if (!handler) {
        throw toolError("AUTOMATION_BAD_SCRIPT", `未实现的动作: ${action}`);
    }
    if (action === "execute") {
        await handler(step, state);
        return;
    }
    const attempts = Math.max(1, (0, catalog_1.asInt)(step.retry, 0) + 1);
    // Never retry a step whose first attempt may already have left the page:
    // re-pressing a publish button can post twice.
    const retryable = attempts > 1 &&
        !["upload", "activateAndWaitForResponse", "activateAndWaitForNavigation"].includes(action) &&
        !(action === "click" && step.trusted);
    for (let attempt = 0;; attempt += 1) {
        try {
            await handler(step, state);
            return;
        }
        catch (error) {
            const coded = error;
            const code = String(coded?.code || "");
            if (String(step.timeoutMode || "") === "continue" && code === "AUTOMATION_TARGET_NOT_FOUND") {
                return;
            }
            if (!retryable ||
                attempt + 1 >= attempts ||
                /未登录|登录已失效|请先登录|登录后重试/.test(String(coded?.message || error))) {
                throw error;
            }
            const low = (0, catalog_1.asInt)(step.retryDelayMin, 1000);
            const high = (0, catalog_1.asInt)(step.retryDelayMax, low);
            await sleep(randomBetween(low, high));
        }
    }
}
/* -------------------------------- actions -------------------------------- */
async function actionWait(step) {
    const duration = step.duration || [400, 900];
    const [low, high] = Array.isArray(duration) && duration.length
        ? [Number(duration[0]) || 0, Number(duration[duration.length - 1]) || 0]
        : [Number(duration) || 0, Number(duration) || 0];
    await sleep(Math.max(0, randomBetween(low, high)));
}
async function actionExecute(step, { context, driver }) {
    await executeWithRetry(step, context, driver);
}
async function actionTransform(step, { context, driver }) {
    const fn = String((step.params && step.params.fn) || "").trim();
    if (!fn) {
        throw toolError("AUTOMATION_BAD_SCRIPT", `步骤 ${step.id} 的 transform 函数为空`);
    }
    const inputSpec = (step.params && step.params.input);
    const sessionKey = String(inputSpec?.sessionKey || "");
    const value = sessionKey
        ? sessionInput(context, sessionKey)
        : params.publicContext(context);
    const expression = `(${fn})(${JSON.stringify(value)}, ${JSON.stringify(params.publicContext(context))})`;
    const result = await driver.evaluate(expression);
    if (step.params && step.params.saveAs) {
        context[`execute_${step.params.saveAs}`] = result;
    }
}
async function actionAssertPageState(step, { driver }) {
    await assertPageState(step, driver);
}
async function actionWaitForTarget(step, { driver }) {
    const target = { ...(step.target || {}) };
    const found = await waitForTarget(driver, target, stepTimeoutMs(step));
    if (!found) {
        throw toolError("AUTOMATION_WAIT_TIMEOUT", `等待元素超时：${target.selector || target.text}`);
    }
}
async function actionWaitForLoad(step, { driver }) {
    const timeout = stepTimeoutMs(step);
    const ready = await driver.evaluate(ps.waitLoadScript(timeout));
    if (!ready) {
        throw toolError("AUTOMATION_WAIT_TIMEOUT", "等待页面加载超时");
    }
}
async function actionWaitForNavigation(step, { driver }) {
    const timeout = stepTimeoutMs(step);
    const start = await driver.currentUrl();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        await sleep(300);
        const current = await driver.currentUrl();
        if (current !== start) {
            await driver.evaluate(ps.waitLoadScript(timeout));
            return;
        }
    }
    throw toolError("AUTOMATION_WAIT_TIMEOUT", "等待页面跳转超时");
}
async function actionNavigate(step, { context, driver }) {
    await driver.navigate(String(params.renderTemplate(step.value || (step.params && step.params.url) || "", context)), { timeout: stepTimeoutMs(step) });
}
async function actionReload(step, { driver }) {
    await driver.reload({ timeout: stepTimeoutMs(step) });
}
async function actionClick(step, { driver }) {
    const hoverTarget = step.hoverTarget || {};
    if (Object.keys(hoverTarget).length) {
        await hoverTargetClick(driver, { ...hoverTarget });
        await sleep(randomBetween(150, 350));
    }
    const target = { ...(step.target || {}) };
    if (step.trusted) {
        const desc = await resolveTarget(driver, target, {
            scroll: true,
            requireVisible: true,
        });
        if (!desc || desc.disabled) {
            throw toolError("AUTOMATION_TARGET_NOT_FOUND", `未找到可点击目标：${target.selector || target.text}`);
        }
        await pressTarget(driver, target, desc, null);
        return;
    }
    if (!(await clickTarget(driver, target))) {
        throw toolError("AUTOMATION_TARGET_NOT_FOUND", `未找到点击目标：${target.selector || target.text}`);
    }
}
async function actionType(step, { context, driver }) {
    await typeInto(step, context, driver);
}
async function actionUpload(step, { context, driver }) {
    await upload(step, context, driver);
}
async function actionActivateAndWaitForResponse(step, { context, driver, onPublish }) {
    await activateAndWaitForResponse(step, context, driver, stepTimeoutMs(step), onPublish);
}
async function actionActivateAndWaitForNavigation(step, { driver, onPublish }) {
    await activateAndWaitForNavigation(step, driver, stepTimeoutMs(step), onPublish);
}
async function actionHover(step, { driver }) {
    const target = { ...(step.target || {}) };
    if (!(await hoverTargetClick(driver, target))) {
        throw toolError("AUTOMATION_TARGET_NOT_FOUND", `未找到悬停目标：${target.selector}`);
    }
}
async function actionScroll(step, { driver }) {
    const target = step.target || {};
    if (target.selector || target.shadowHost) {
        if (!(await scrollTarget(driver, { ...target }))) {
            throw toolError("AUTOMATION_TARGET_NOT_FOUND", `未找到滚动目标：${target.selector}`);
        }
        return;
    }
    const delta = (0, catalog_1.asInt)((step.params && step.params.deltaY) ?? step.value ?? 600, 600);
    await driver.evaluate(`window.scrollBy(0, ${delta}); true`);
}
async function actionSessionCapture(step, { driver }) {
    await driver.install(ps.captureScript(sessionSpecs(step.params || {})));
}
async function actionScrollForSession(step, { context, driver }) {
    const stepParams = step.params || {};
    const sessionKey = String(stepParams.sessionKey || "");
    const spec = (context._sessions || {})[sessionKey] || {};
    const state = await driver.evaluate((0, driver_1.readCapturesExpression)());
    context._captures = (0, driver_1.parseCaptures)(state);
    const result = await driver.evaluate(ps.scrollForSessionScript({
        sessionKey,
        countPath: String(spec.countByValueKey || ""),
        hasNextPath: String(spec.hasNextKey || stepParams.hasNextKey || ""),
        limitTotal: (0, catalog_1.asInt)(params.renderTemplate(stepParams.limitTotal, context)),
        limitScroll: (0, catalog_1.asInt)(stepParams.limitScroll, 30),
        scrollStep: (0, catalog_1.asInt)(stepParams.scrollStep, 600),
        selector: String((step.target && step.target.selector) || ""),
    }));
    const after = await driver.evaluate((0, driver_1.readCapturesExpression)());
    context._captures = (0, driver_1.parseCaptures)(after);
    if (stepParams.saveAs) {
        context[`execute_${stepParams.saveAs}`] = result;
    }
}
async function actionScrollForState(step, { context, driver }) {
    const stepParams = step.params || {};
    const target = step.target || {};
    const result = await driver.evaluate(ps.scrollForStateScript({
        countExpr: String(stepParams.countExpr || "0"),
        limitTotal: (0, catalog_1.asInt)(params.renderTemplate(stepParams.limitTotal, context)),
        limitScroll: (0, catalog_1.asInt)(stepParams.limitScroll, 30),
        scrollStep: (0, catalog_1.asInt)(stepParams.scrollStep, 800),
        stallRounds: (0, catalog_1.asInt)(stepParams.stallRounds, 2),
        scrollSelector: String(target.selector || stepParams.scrollSelector || ""),
        anchorSelector: String(stepParams.anchorSelector || ""),
        expandSelector: String(stepParams.expandSelector || ""),
        expandMax: (0, catalog_1.asInt)(params.renderTemplate(stepParams.expandMaxPerRound, context), 5),
    }));
    if (stepParams.saveAs) {
        context[`execute_${stepParams.saveAs}`] = result;
    }
}
async function actionWaitForState(step, { driver }) {
    const stepParams = step.params || {};
    const expression = String(stepParams.expression || "").trim();
    if (!expression) {
        throw toolError("AUTOMATION_BAD_SCRIPT", `步骤 ${step.id} 的 waitForState 表达式为空`);
    }
    const ready = await driver.evaluate(ps.waitStateScript(expression, stepTimeoutMs(step)));
    if (!ready) {
        throw toolError(String(stepParams.errorCode || "AUTOMATION_WAIT_TIMEOUT"), String(stepParams.errorMessage || "等待页面状态超时"));
    }
}
async function actionDownloadFile(step, { context, driver, artifactDir, files }) {
    await artifacts.downloadFile(step, {
        context,
        driver,
        artifactDir,
        files,
    });
}
async function actionExtractZip(step, { context, files }) {
    artifacts.extractZip(step, { context, files });
}
async function actionSaveMarkdown(step, { context, artifactDir, files }) {
    artifacts.saveMarkdown(step, { context, artifactDir, files });
}
const ACTION_HANDLERS = {
    wait: actionWait,
    execute: actionExecute,
    transform: actionTransform,
    assertPageState: actionAssertPageState,
    waitForSelector: actionWaitForTarget,
    waitForElement: actionWaitForTarget,
    waitForLoad: actionWaitForLoad,
    waitForNavigation: actionWaitForNavigation,
    navigate: actionNavigate,
    reload: actionReload,
    click: actionClick,
    type: actionType,
    upload: actionUpload,
    activateAndWaitForResponse: actionActivateAndWaitForResponse,
    activateAndWaitForNavigation: actionActivateAndWaitForNavigation,
    hover: actionHover,
    scroll: actionScroll,
    sessionCapture: actionSessionCapture,
    scrollForSession: actionScrollForSession,
    scrollForState: actionScrollForState,
    waitForState: actionWaitForState,
    downloadFile: actionDownloadFile,
    extractZip: actionExtractZip,
    saveMarkdown: actionSaveMarkdown,
};
exports.ACTION_HANDLERS = ACTION_HANDLERS;
/* ------------------------------- helpers --------------------------------- */
async function assertPageState(step, driver) {
    const stepParams = step.params || {};
    const failWhen = Array.isArray(stepParams.failWhen) ? stepParams.failWhen : [];
    const passWhen = Array.isArray(stepParams.passWhen) ? stepParams.passWhen : [];
    const expression = ps.assertScript(failWhen, passWhen);
    const defaultCode = String(stepParams.errorCode || "ASSERT_PAGE_STATE_FAILED");
    const defaultMessage = String(stepParams.errorMessage || "页面状态校验失败");
    if (!passWhen.length) {
        const state = (await driver.evaluate(expression));
        if (state && state.failed) {
            throw toolError(String(state.code || defaultCode), String(state.message || defaultMessage));
        }
        return;
    }
    const deadline = Date.now() + Math.max(1000, stepTimeoutMs(step));
    while (Date.now() < deadline) {
        const state = (await driver.evaluate(expression));
        if (state && typeof state === "object") {
            if (state.failed) {
                throw toolError(String(state.code || defaultCode), String(state.message || defaultMessage));
            }
            if (state.passed)
                return;
        }
        await sleep(400);
    }
    throw toolError(defaultCode, defaultMessage);
}
async function typeInto(step, context, driver) {
    const target = { ...(step.target || {}) };
    let value = String(params.renderTemplate(step.value || "", context));
    const maxChars = (0, catalog_1.asInt)(step.maxChars, 0);
    if (maxChars > 0) {
        value = params.truncateText(value, maxChars, String(step.maxLengthUnit || "chars"));
    }
    const desc = await resolveTarget(driver, target);
    if (!desc) {
        throw toolError("AUTOMATION_TARGET_NOT_FOUND", `未找到输入框：${target.selector || target.text}`);
    }
    if (desc.mode === "element") {
        const state = (await driver.evaluate(ps.focusScript(target, Boolean(step.noClick))));
        if (!state || typeof state !== "object") {
            throw toolError("AUTOMATION_TARGET_NOT_FOUND", `未找到输入框：${target.selector || target.text}`);
        }
        if (state.editable) {
            if (step.tagMode)
                await insertTags(driver, value);
            else if (value)
                await insertEditable(driver, value);
            return;
        }
        const typed = await driver.evaluate(ps.setValueScript(target, value));
        if (!typed) {
            throw toolError("AUTOMATION_TARGET_NOT_FOUND", `未找到输入框：${target.selector || target.text}`);
        }
        return;
    }
    // A control the page script cannot reach: focus it through the DOM domain
    // and deliver the text the same way.
    await descFocus(driver, desc);
    if (desc.editable) {
        if (step.tagMode)
            await insertTags(driver, value);
        else if (value)
            await insertEditable(driver, value);
        return;
    }
    await descSetText(driver, desc, value);
}
async function insertEditable(driver, value) {
    try {
        await driver.insertText(value);
    }
    catch (error) {
        const inserted = await driver.evaluate(ps.insertTextFallbackScript(value));
        if (!inserted)
            throw error;
    }
}
/**
 * Type hashtags one at a time so the platform turns them into topics.
 *
 * Each tag is followed by a real space: that is the gesture both 小红书 and
 * 抖音 use to commit a topic.
 */
async function insertTags(driver, value) {
    if (!String(value).trim())
        return;
    if (/^\s/.test(value))
        await driver.insertText(" ");
    for (const token of String(value).trim().split(/\s+/)) {
        if (token.startsWith("#")) {
            await driver.insertText(token);
            await driver.pressKey("Space");
            await sleep(randomBetween(200, 450));
        }
        else {
            await driver.insertText(`${token} `);
        }
    }
}
function preflightUploads(script, context) {
    for (const step of script.steps || []) {
        if (!step || step.action !== "upload")
            continue;
        const verify = ((step.params && step.params.verify) || {});
        checkUploadFiles(params.resolveFiles(step.value, context), verify);
    }
}
function checkUploadFiles(files, verify) {
    if (!files.length) {
        throw toolError("AUTOMATION_UPLOAD_INVALID", "没有可上传的文件");
    }
    const maxFiles = (0, catalog_1.asInt)(verify.maxFiles, 0);
    if (maxFiles > 0 && files.length > maxFiles) {
        throw toolError("AUTOMATION_UPLOAD_INVALID", `文件数量超过上限：${files.length} > ${maxFiles}`);
    }
    const allowed = new Set((Array.isArray(verify.allowedExtensions) ? verify.allowedExtensions : []).map((item) => String(item).toLowerCase()));
    for (const raw of files) {
        const text = String(raw);
        if (artifacts.isRemoteFileRef(text)) {
            throw toolError("AUTOMATION_UPLOAD_INVALID", `远程图片尚未就绪：${text}`);
        }
        if (!path.isAbsolute(text)) {
            throw toolError("AUTOMATION_UPLOAD_INVALID", `文件必须是绝对路径或 http(s) URL：${text}`);
        }
        if (!fs.existsSync(text) || !fs.statSync(text).isFile()) {
            throw toolError("AUTOMATION_UPLOAD_INVALID", `文件不存在：${text}`);
        }
        if (allowed.size && !allowed.has(path.extname(text).toLowerCase())) {
            throw toolError("AUTOMATION_UPLOAD_INVALID", `不支持的文件类型：${path.basename(text)}`);
        }
    }
}
async function upload(step, context, driver) {
    const selector = String(step.inputSelector || "");
    if (!selector) {
        throw toolError("AUTOMATION_BAD_SCRIPT", "upload 步骤缺少 inputSelector");
    }
    const verify = { ...((step.params && step.params.verify) || {}) };
    const files = params.resolveFiles(step.value, context);
    checkUploadFiles(files, verify);
    const target = {
        selector,
        shadowHost: String(step.shadowHost || ""),
    };
    const desc = await resolveTarget(driver, target);
    if (!desc) {
        throw toolError("AUTOMATION_TARGET_NOT_FOUND", `未找到文件输入框：${selector}`);
    }
    if (desc.mode === "element") {
        const expression = ps.syncScript(`\n  return __qiworkEl(${JSON.stringify(target)});\n`);
        await driver.setFiles(expression, files);
    }
    else if (desc.mode === "node") {
        await driver.setFilesOn(files, { nodeId: Number(desc.nodeId) });
    }
    else if (desc.mode === "object") {
        await driver.setFilesOnObject(String(desc.objectId), files);
    }
    else {
        await driver.setFilesOn(files, { backendId: Number(desc.backendId) });
    }
    await waitUpload(driver, verify, files.length);
}
/**
 * Poll the page until every file is uploaded, or say why it is not.
 *
 * "Uploaded" means as many previews as files handed over: one image landing is
 * not the same as four.
 */
async function waitUpload(driver, verify, expected) {
    if (!(verify.uploadedSelector || verify.pendingSelectors))
        return;
    const wanted = (0, catalog_1.asInt)(verify.expectedCount, expected) || expected;
    const timeout = (0, catalog_1.asInt)(verify.timeout, 60_000);
    const stabilityMs = (0, catalog_1.asInt)(verify.stabilityMs, 3_000);
    const poll = Math.max(100, (0, catalog_1.asInt)(verify.pollInterval, 500));
    const expression = ps.uploadStateScript(verify);
    const deadline = Date.now() + Math.max(1000, timeout);
    let stableSince = null;
    while (Date.now() < deadline) {
        const state = (await driver.evaluate(expression));
        if (state && typeof state === "object") {
            const failure = String(state.failure || "");
            if (failure) {
                throw toolError("AUTOMATION_UPLOAD_FAILED", `上传失败：${failure}`);
            }
            const uploaded = (0, catalog_1.asInt)(state.uploaded, 0);
            if (uploaded >= wanted && !state.pending) {
                if (stableSince === null)
                    stableSince = Date.now();
                else if (Date.now() - stableSince >= stabilityMs)
                    return;
            }
            else {
                stableSince = null;
            }
        }
        await sleep(poll);
    }
    throw toolError("AUTOMATION_UPLOAD_TIMEOUT", "上传未在限定时间内完成");
}
/**
 * Find a control, and say how it was found.
 *
 * Three channels, in order of how much they can see: the page script (light
 * DOM and **open** shadow roots), the DOM domain (also **closed** shadow
 * roots), and the accessibility tree (a control by its name).
 */
async function resolveTarget(driver, target, options = {}) {
    const { scroll = false, deep = true, requireVisible = false } = options;
    const script = scroll ? ps.centerScript(target) : ps.probeScript(target);
    const probe = await driver.evaluate(script);
    if (probe && typeof probe === "object") {
        const record = probe;
        const box = boxOf(record);
        if (!requireVisible || (box.width > 0 && box.height > 0)) {
            return {
                mode: "element",
                box,
                editable: Boolean(record.editable),
                tag: String(record.tag || ""),
                disabled: Boolean(record.disabled),
            };
        }
    }
    if (!deep)
        return null;
    return resolveDeep(driver, target);
}
async function resolveDeep(driver, target) {
    const host = String(target.shadowHost || "");
    if (!host)
        return null;
    const selector = String(target.selector || "");
    if (selector) {
        const found = await driver.resolveShadowElement(`document.querySelector(${JSON.stringify(host)})`, selector);
        if (found)
            return found;
    }
    const backend = await driver.findAxNode(String(target.text || ""));
    if (backend) {
        const state = (await driver.nodeState({ backendId: backend })) || {};
        const box = (await driver.nodeBoxByBackend(backend)) || {};
        return {
            mode: "backend",
            nodeId: 0,
            backendId: backend,
            box,
            editable: Boolean(state.editable),
            tag: String(state.tag || ""),
            disabled: false,
        };
    }
    return null;
}
async function descCall(driver, desc, declaration, args = []) {
    if (desc.mode === "node") {
        return driver.callOnNode(Number(desc.nodeId), declaration, { arguments: args });
    }
    if (desc.mode === "object") {
        return driver.callOnObject(String(desc.objectId), declaration, { arguments: args });
    }
    return driver.callOnBackendNode(Number(desc.backendId), declaration, {
        arguments: args,
    });
}
async function descClick(driver, desc) {
    if (desc.mode === "node")
        await driver.clickNode(Number(desc.nodeId));
    else if (desc.mode === "backend") {
        await driver.clickBackendNode(Number(desc.backendId));
    }
    else
        await driver.clickObject(String(desc.objectId));
}
async function descFocus(driver, desc) {
    if (desc.mode === "node")
        await driver.focusNode({ nodeId: Number(desc.nodeId) });
    else if (desc.mode === "backend") {
        await driver.focusNode({ backendId: Number(desc.backendId) });
    }
    else
        await driver.focusObject(String(desc.objectId));
}
async function descSetText(driver, desc, value) {
    await descCall(driver, desc, ps.SET_VALUE_ON_THIS, [value]);
}
/**
 * Poll for a control, cheaply, then look through the privileged channels.
 * The page-script probe is one evaluation; the shadow/accessibility lookup
 * costs several round trips, so it runs once a second.
 */
async function waitForTarget(driver, target, timeoutMs) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    let nextDeep = Date.now();
    while (Date.now() < deadline) {
        const found = await resolveTarget(driver, target, { deep: false });
        if (found)
            return found;
        if (target.shadowHost && Date.now() >= nextDeep) {
            const deepFound = await resolveTarget(driver, target, { deep: true });
            if (deepFound)
                return deepFound;
            nextDeep = Date.now() + 1000;
        }
        await sleep(POLL_MS);
    }
    return null;
}
async function clickTarget(driver, target) {
    const desc = await resolveTarget(driver, target);
    if (!desc)
        return false;
    if (desc.mode === "element") {
        return Boolean(await driver.evaluate(ps.clickScript(target)));
    }
    await descClick(driver, desc);
    return true;
}
async function hoverTargetClick(driver, target) {
    const desc = await resolveTarget(driver, target);
    if (!desc)
        return false;
    if (desc.mode === "element") {
        return Boolean(await driver.evaluate(ps.hoverScript(target)));
    }
    const box = desc.box || {};
    if (box.width && box.height) {
        await driver.movePointer(Number(box.left) + Number(box.width) / 2, Number(box.top) + Number(box.height) / 2);
    }
    return true;
}
async function scrollTarget(driver, target) {
    const desc = await resolveTarget(driver, target);
    if (!desc)
        return false;
    if (desc.mode === "element") {
        return Boolean(await driver.evaluate(ps.scrollIntoViewScript(target)));
    }
    await descCall(driver, desc, "function () { this.scrollIntoView({ block: 'center', inline: 'center' }); return true; }");
    return true;
}
/** Press the control, using the first point nothing else covers. */
async function pressTarget(driver, target, desc, onPublish) {
    const box = desc.box || {};
    const expression = desc.mode === "element"
        ? ps.elExpression(target)
        : ps.hostExpression(target);
    if (await pressHittable(driver, box, expression, onPublish))
        return true;
    if (onPublish)
        onPublish();
    try {
        if (desc.mode === "element") {
            return Boolean(await driver.evaluate(ps.clickScript(target)));
        }
        await descClick(driver, desc);
        return true;
    }
    catch (error) {
        throw unknownClick(error);
    }
}
/** Explain what is actually inside the shadow root when a selector misses. */
async function raiseShadowDiagnostic(driver, target) {
    const host = String(target.shadowHost || "");
    if (!host)
        return;
    const buttons = await driver.shadowButtons(`document.querySelector(${JSON.stringify(host)})`);
    if (!buttons.length)
        return;
    const found = buttons
        .map((item) => `「${item.text || "无文字"}」${item.html}`)
        .join("；");
    throw toolError("AUTOMATION_TARGET_NOT_FOUND", `没找到控件「${target.text || target.selector || host}」：closed shadow root 里没有匹配 ` +
        `${target.selector || "(空)"} 的元素；实际存在：${found}`);
}
/**
 * Press the publish control the way a person would.
 *
 * A DOM `click()` is the fallback, not the default: these buttons are also
 * watched by hover handlers and disabled-state logic that only run for a real
 * pointer press.
 */
async function activate(step, driver, onPublish) {
    const target = { ...(step.target || {}) };
    const desc = await resolveTarget(driver, target, {
        scroll: true,
        requireVisible: true,
    });
    if (desc) {
        if (desc.disabled) {
            throw toolError("AUTOMATION_TARGET_DISABLED", "发布按钮当前不可用");
        }
        if (await pressTarget(driver, target, desc, onPublish))
            return;
    }
    await raiseShadowDiagnostic(driver, target);
    throw toolError("AUTOMATION_TARGET_NOT_FOUND", `未找到发布按钮：${target.selector || target.text}`);
}
/**
 * Press the second button some publish flows put in a modal.
 *
 * 视频号 answers the first 发表 press with a confirmation dialog whose button
 * is also labelled 发表. Missing it looks exactly like a publish that never
 * started.
 */
async function pressConfirm(driver, stepParams) {
    const confirm = stepParams.confirm;
    if (!confirm || typeof confirm !== "object")
        return false;
    const target = { ...(confirm.target || {}) };
    if (!Object.keys(target).length)
        return false;
    const timeout = (0, catalog_1.asInt)(confirm.timeout, 8000);
    const deadline = Date.now() + Math.max(500, timeout);
    while (Date.now() < deadline) {
        const desc = await resolveTarget(driver, target, {
            scroll: true,
            requireVisible: true,
        });
        if (desc && !desc.disabled) {
            await pressTarget(driver, target, desc, null);
            return true;
        }
        await sleep(300);
    }
    return false;
}
/**
 * Press publish and read the platform's own answer.
 *
 * The recorder is installed *before* the press: 小红书 answers a note publish
 * in a few hundred milliseconds, and a listener added afterwards misses it.
 */
async function activateAndWaitForResponse(step, context, driver, timeoutMs, onPublish) {
    const stepParams = { ...(step.params || {}) };
    await driver.install(ps.publishCaptureScript(String(stepParams.urlPattern || "")));
    await activate(step, driver, onPublish);
    await pressConfirm(driver, stepParams);
    const receipt = await waitForPublishResponse(driver, stepParams, timeoutMs);
    if (stepParams.saveAs) {
        context[`execute_${stepParams.saveAs}`] = receipt;
    }
}
async function waitForPublishResponse(driver, stepParams, timeoutMs) {
    const successPath = String(stepParams.successPath || "");
    const expected = stepParams.successEquals === undefined ? true : stepParams.successEquals;
    const required = (Array.isArray(stepParams.requiredPaths) ? stepParams.requiredPaths : []).map((item) => String(item));
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
        const raw = await driver.evaluate("JSON.stringify(window.__qiworkPublish || [])");
        for (const item of (0, driver_1.parseCaptures)(raw)) {
            if (!responseMatches(item.body, successPath, expected, required))
                continue;
            return {
                ok: true,
                url: String(item.url || ""),
                matched: successPath || "(any)",
            };
        }
        await sleep(400);
    }
    throw toolError("PUBLISH_UNCONFIRMED", "未收到发布成功响应，请在浏览器中确认发布状态（未确认前不要重复发布）");
}
function responseMatches(body, successPath, expected, required) {
    if (!body || typeof body !== "object")
        return false;
    for (const item of required) {
        const value = params.getPath(body, item);
        if (value === null || value === undefined || value === "")
            return false;
    }
    if (!successPath)
        return true;
    return equalValue(params.getPath(body, successPath), expected);
}
function equalValue(value, expected) {
    if (typeof expected === "boolean") {
        if (typeof value === "boolean")
            return value === expected;
        if (typeof value === "number")
            return Boolean(value) === expected;
        if (typeof value === "string") {
            return ["true", "1", "yes", "ok"].includes(value.trim().toLowerCase()) === expected;
        }
        return false;
    }
    return value === expected;
}
/**
 * Press publish and wait for the page to land on its success address.
 *
 * 抖音 and 快手 both answer with a redirect. A captcha is a third outcome: it
 * is reported as something the user must finish, not as a failed run.
 */
async function activateAndWaitForNavigation(step, driver, timeoutMs, onPublish) {
    const stepParams = { ...(step.params || {}) };
    const verification = { ...(stepParams.verification || {}) };
    const successUrl = String(stepParams.successUrl || "");
    const startUrl = await driver.currentUrl();
    await activate(step, driver, onPublish);
    await pressConfirm(driver, stepParams);
    const expression = Object.keys(verification).length
        ? ps.verificationScript(verification)
        : "";
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
        await sleep(400);
        const url = await driver.currentUrl();
        if (successUrl) {
            if (url.includes(successUrl)) {
                await waitLoaded(driver, timeoutMs);
                return;
            }
        }
        else if (url && url !== startUrl) {
            await waitLoaded(driver, timeoutMs);
            return;
        }
        const marker = await verificationMarker(driver, expression);
        if (marker)
            throw humanVerification(marker);
    }
    // A captcha can still be painted a moment later; give it a short grace.
    const graceMs = Math.min(Math.max((0, catalog_1.asInt)(verification.timeout, 0) - timeoutMs, 0), 15_000);
    const graceDeadline = Date.now() + graceMs;
    while (graceMs > 0 && Date.now() < graceDeadline) {
        const marker = await verificationMarker(driver, expression);
        if (marker)
            throw humanVerification(marker);
        await sleep(1000);
    }
    throw toolError("PUBLISH_UNCONFIRMED", "发布后页面未跳转，请在浏览器中确认发布状态（未确认前不要重复发布）");
}
async function verificationMarker(driver, expression) {
    if (!expression)
        return "";
    const marker = await driver.evaluate(expression);
    return String(marker || "");
}
function humanVerification(marker) {
    return toolError("HUMAN_VERIFICATION_REQUIRED", `发布被平台要求人工验证（${marker}），请在浏览器中完成验证后确认发布结果`);
}
async function waitLoaded(driver, timeoutMs) {
    const budget = Math.min(timeoutMs, 30_000);
    await driver.evaluate(ps.waitLoadScript(budget));
}
async function executeWithRetry(step, context, driver) {
    const stepParams = step.params || {};
    const fn = String(stepParams.fn || "").trim();
    if (!fn) {
        throw toolError("AUTOMATION_BAD_SCRIPT", `步骤 ${step.id} 的 execute 函数为空`);
    }
    const attempts = Math.max(1, (0, catalog_1.asInt)(step.retry, 0) + 1);
    const expression = `(${fn})(${JSON.stringify(params.publicContext(context))})`;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const result = await driver.evaluate(expression);
            if (stepParams.saveAs) {
                context[`execute_${stepParams.saveAs}`] = result;
            }
            return;
        }
        catch (error) {
            lastError = error;
            if (attempt + 1 >= attempts)
                break;
            const low = (0, catalog_1.asInt)(step.retryDelayMin, 1000);
            const high = (0, catalog_1.asInt)(step.retryDelayMax, low);
            await sleep(randomBetween(low, high));
        }
    }
    throw lastError || toolError("AUTOMATION_STEP", "自动化步骤失败");
}
