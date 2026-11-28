"use strict";
/**
 * Entry for the bundled Taobao tools plugin.
 *
 * Tools are registered natively so every call carries the invoking session
 * (`ctx.sessionId`). The tool bodies call `pi.browser.*` directly; the host
 * client is the only transport, and there is no intermediate open/evaluate
 * request protocol.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.onLoad = onLoad;
exports.onUnload = onUnload;
const server_1 = require("./bridge/server");
const runs_1 = require("./bridge/automation/runs");
const RISK = {
    list_scripts: "low",
    list_automations: "low",
    prepare_automation: "low",
    get_automation_run: "low",
    cancel_automation_run: "low",
    check_session: "low",
    finish_task: "low",
    eval_script: "medium",
    fetch_search_keywords: "medium",
    run_automation: "high",
};
async function onLoad() {
    let queue = Promise.resolve();
    pi.services.register({
        id: "automation-runner",
        start() {
            (0, runs_1.setRunExecutor)((work) => {
                queue = queue.then(work).catch(() => undefined);
            });
        },
        stop() {
            (0, runs_1.setRunExecutor)(null);
        },
    });
    for (const tool of server_1.TOOLS) {
        await pi.agent.registerTool({
            name: tool.name,
            description: tool.description,
            risk: RISK[tool.name] || "medium",
            schema: tool.inputSchema,
            execute: async (args, ctx) => {
                const host = {
                    sessionId: ctx && ctx.sessionId,
                    tabId: ctx && ctx.tabId,
                    browser: pi.browser,
                    net: pi.net,
                };
                return await (0, server_1.callTool)(tool.name, args || {}, host);
            },
        });
    }
}
async function onUnload() {
    for (const tool of server_1.TOOLS) {
        await pi.agent.unregisterTool(tool.name);
    }
}
