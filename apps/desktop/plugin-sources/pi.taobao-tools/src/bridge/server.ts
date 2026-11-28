#!/usr/bin/env node
"use strict";

/**
 * Tool bodies for pi.taobao-tools.
 *
 * main.cjs registers the declared agent tools and forwards calls here. Data
 * collection runs on the whitelisted in-page scripts; browser automation runs
 * on the same JSON DSL QiWork ships, with PI-Desktop's built-in browsed pane
 * as the driver (no extension, no MCP child process, no cookie access here).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { MerchantRunner, loadRegistry, requiredArgs } from "./runner";
import { codedError as automationError } from "./automation/errors";
import * as catalog from "./automation/catalog";
import * as params from "./automation/params";
import * as dsl from "./automation/dsl";
import { createDriver } from "./automation/driver";
import * as runs from "./automation/runs";
import * as publishGuard from "./automation/publish-guard";
import { finalizeRunResult } from "./automation/xhs-login";
import { initWorkdir, runFetch, requireCateId } from "./keywords";
import type { AutomationContext, AutomationScript } from "./automation/types";

type ToolHost = {
  sessionId?: string;
  tabId?: string;
  browser?: {
    reveal(input?: { sessionId?: string; tabId?: string }): Promise<void>;
    navigate(input: Record<string, unknown>): Promise<unknown>;
    evaluateNative(input: Record<string, unknown>): Promise<unknown>;
    evaluate?(input: Record<string, unknown>): Promise<unknown>;
    insertText?(input: Record<string, unknown>): Promise<unknown>;
    cdp(input: Record<string, unknown>): Promise<unknown>;
    input(input: Record<string, unknown>): Promise<unknown>;
  };
  net?: {
    fetch(input: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      responseType?: "text" | "base64";
      maxResponseBytes?: number;
      redirect?: "follow" | "error" | "manual";
    }): Promise<{
      status: number;
      headers: Record<string, string>;
      bodyText: string;
      bodyBase64?: string;
      contentType?: string;
      byteLength?: number;
    }>;
  };
};

const OUTPUT_ROOT =
  process.env.PI_TAOBAO_OUTPUT_ROOT || path.join(os.homedir(), "Downloads", "pi-taobao");
const RUNS_ROOT = path.join(OUTPUT_ROOT, "runs");

function log(message: string): void {
  process.stderr.write(`[taobao-bridge] ${message}\n`);
}


function merchantRunner(host: ToolHost | null | undefined) {
  if (!host || !host.browser) {
    throw automationError(
      "AUTOMATION_BROWSER_UNAVAILABLE",
      "内置浏览器通道不可用；请在 PI-Desktop 中重试",
    );
  }
  return new MerchantRunner({
    browser: host.browser,
    sessionId: host.sessionId,
    tabId: host.tabId,
  });
}

/* ---------------------------------- tools ---------------------------------- */

const TOOLS = [
  {
    name: "list_scripts",
    description:
      "列出白名单取数脚本，按平台（scene）汇总。只读，不访问浏览器。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "按 id 或说明过滤" },
        scene: { type: "string", description: "只列某个平台，例如 sycm" },
        limit: { type: "number", description: "最多返回条数，默认 50" },
      },
    },
  },
  {
    name: "eval_script",
    description:
      "在用户已登录的店铺页面执行一个白名单取数脚本。遇到登录页或风控页会拒绝执行并保留标签页。",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "脚本 id，见 list_scripts" },
        args: { type: "object", description: "脚本参数，见 list_scripts 的 args" },
        timeout_ms: { type: "number", description: "执行超时，1～120000，默认 30000" },
      },
      required: ["script"],
    },
  },
  {
    name: "check_session",
    description: "检查生意参谋登录状态与主营类目。只读，不访问浏览器。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fetch_search_keywords",
    description:
      "按类目拉取本期/上期搜索词排行，结果与中间文件写入 ~/Downloads/pi-taobao。target_count 过大会超过单次调用时限，建议 ≤ 500。",
    inputSchema: {
      type: "object",
      properties: {
        cate_id: { type: "string", description: "类目 id；为空时用 cate_name 检索" },
        cate_name: { type: "string", description: "类目名称，需唯一匹配" },
        date_type: {
          type: "string",
          enum: ["day", "recent7", "recent30"],
          description: "统计周期长度，默认 recent7",
        },
        period: {
          type: "string",
          enum: ["current", "prev", "both"],
          description: "本期/上期/两者，默认 both",
        },
        target_count: { type: "number", description: "目标词数，默认 30" },
      },
    },
  },
  {
    name: "finish_task",
    description: "结束本次取数：关闭本插件为取数打开的标签页，不发任何网站请求。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_automations",
    description:
      "列出可用的浏览器自动化：平台、类型（collect/publish/interact）、参数、步骤数、动作集合。只读，不执行。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prepare_automation",
    description:
      "干跑：解析参数、校验文件与内容、返回将要执行的步骤与预览，不打开浏览器、不发请求。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "自动化 id，见 list_automations" },
        variables: { type: "object", description: "脚本变量" },
      },
      required: ["id"],
    },
  },
  {
    name: "run_automation",
    description:
      "提交一个自动化执行，立即返回 runId，任务串行执行。采集、互动与发布都直接执行；发布类在按下按钮时记录本次内容，5 分钟内同内容不会重复发布。用 get_automation_run 轮询状态与结果。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "自动化 id，见 list_automations" },
        variables: { type: "object", description: "脚本变量" },
        background: {
          type: "boolean",
          default: true,
          description: "兼容字段；本插件始终异步执行并返回 runId",
        },
        timeout_ms: {
          type: "number",
          description: "整次运行超时，1000～900000；发布默认 900000，其它默认 300000",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_automation_run",
    description:
      "按 runId 查询一次自动化执行的状态、进度、结果、产物文件或失败原因。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "run_automation 返回的 runId" },
      },
      required: ["runId"],
    },
  },
  {
    name: "cancel_automation_run",
    description:
      "按 runId 取消排队中或运行中的自动化。运行中的任务会在下一次浏览器操作前停止；已按下的发布按钮无法撤回，请到平台确认结果。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "run_automation 返回的 runId" },
      },
      required: ["runId"],
    },
  },
];

function summarizeSteps(
  script: AutomationScript,
  context: AutomationContext,
) {
  return (script.steps || []).map((step, index) => {
    const target =
      step.target && typeof step.target === "object"
        ? params.renderTarget(step.target, context)
        : null;
    return {
      index: index + 1,
      action: step.action,
      description: step.description || "",
      when: step.when || null,
      whenState: step.whenState || null,
      target: target ? target.selector || target.text || null : null,
    };
  });
}

function timeoutMsFor(
  args: Record<string, unknown>,
  script: AutomationScript,
): number {
  const fallback = script.kind === "publish" ? 900_000 : 300_000;
  const value = Number(args && args.timeout_ms);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(900_000, Math.max(1_000, Math.trunc(value)));
}

/* -------------------------------- tool calls ------------------------------- */

async function callTool(
  name: string,
  args: unknown,
  host: ToolHost | null,
): Promise<unknown> {
  const toolArgs: Record<string, unknown> =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};

  if (name === "list_scripts") {
    const registry = loadRegistry();
    const query = String(toolArgs.query || "").trim().toLowerCase();
    const scene = String(toolArgs.scene || "").trim();
    const limit = Math.min(500, Math.max(1, Number(toolArgs.limit) || 50));

    const summary = new Map();
    for (const entry of Object.values(registry)) {
      const key = entry.scene || "unknown";
      summary.set(key, (summary.get(key) || 0) + 1);
    }

    const scripts = Object.entries(registry)
      .filter(([id, entry]) => {
        if (scene && entry.scene !== scene) return false;
        if (!query) return true;
        return (
          id.toLowerCase().includes(query) ||
          String(entry.desc || "").toLowerCase().includes(query)
        );
      })
      .slice(0, limit)
      .map(([id, entry]) => ({
        id,
        scene: entry.scene || "",
        description: entry.desc || "",
        args: entry.args || {},
        requiredArgs: requiredArgs(entry),
      }));

    return {
      total: Object.keys(registry).length,
      returned: scripts.length,
      summary: [...summary.entries()]
        .map(([scene2, count]) => ({ scene: scene2, count }))
        .sort((a, b) => a.scene.localeCompare(b.scene)),
      scripts,
    };
  }

  if (name === "eval_script") {
    const runner = merchantRunner(host);
    try {
      return await runner.evalScript(
        String(toolArgs.script || ""),
        toolArgs.args && typeof toolArgs.args === "object"
          ? (toolArgs.args as Record<string, unknown>)
          : {},
        Number(toolArgs.timeout_ms) || 30_000,
      );
    } finally {
      await runner.close().catch(() => {});
    }
  }

  if (name === "check_session") {
    const runner = merchantRunner(host);
    try {
      return await runner.checkSession();
    } finally {
      await runner.close().catch(() => {});
    }
  }

  if (name === "fetch_search_keywords") {
    const runner = merchantRunner(host);
    try {
      let cateId = String(toolArgs.cate_id || "").trim();
      const cateName = String(toolArgs.cate_name || "").trim();
      if (!cateId && cateName) {
        const result = (await runner.evalScript(
          "market-cate-search",
          { keyword: cateName, leafOnly: true },
          30_000,
        )) as { categories?: Array<Record<string, unknown>> } | null;
        if (!result || !Array.isArray(result.categories)) {
          throw new Error("类目查询返回结构异常");
        }
        if (result.categories.length !== 1) {
          return {
            ok: false,
            error: `类目候选 ${result.categories.length} 条，需唯一匹配`,
            candidates: result.categories.slice(0, 10).map((item) => ({
              cateId: item.cateId,
              name: item.cateFullName || item.cateName,
            })),
          };
        }
        cateId = String(result.categories[0].cateId);
      }
      cateId = requireCateId(cateId);

      await runner.open("sycm");
      const workDir = await initWorkdir(cateId, path.join(RUNS_ROOT, "search-keywords"));
      const envelope = await runFetch(
        (request) =>
          runner.evalScript(
            "search-keyword-rank",
            request as Record<string, unknown>,
            30_000,
          ),
        {
          cateId,
          dateType: String(toolArgs.date_type || "recent7"),
          period: String(toolArgs.period || "both"),
          targetCount: Math.max(1, Math.min(3_000, Number(toolArgs.target_count) || 30)),
          workDir: workDir.workDir,
          outputDir: OUTPUT_ROOT,
        },
      );
      return { ok: true, outputRoot: OUTPUT_ROOT, ...envelope };
    } finally {
      await runner.close().catch(() => {});
    }
  }

  if (name === "finish_task") {
    return { ok: true };
  }

  if (name === "list_automations") {
    const automations = catalog.scriptCatalog();
    const platforms: Record<string, number> = {};
    const kinds: Record<string, number> = {};
    for (const item of automations) {
      platforms[item.platform || "unknown"] = (platforms[item.platform || "unknown"] || 0) + 1;
      kinds[item.kind] = (kinds[item.kind] || 0) + 1;
    }
    return {
      contractVersion: dsl.CONTRACT_VERSION,
      total: automations.length,
      platforms,
      kinds,
      automations,
    };
  }

  if (name === "prepare_automation") {
    const script = catalog.requireScript(String(toolArgs.id || ""));
    const variables =
      toolArgs.variables && typeof toolArgs.variables === "object"
        ? (toolArgs.variables as Record<string, unknown>)
        : {};
    const context = params.buildContext(script, variables);
    const steps = summarizeSteps(script, context);
    const issues = params.contentIssues(script, context);
    const warnings = [...issues];
    try {
      const files = (script.variables || [])
        .filter((item) => String(item.type || "") === "files")
        .flatMap((item) => params.resolveFiles(context[item.key], context));
      for (const raw of files) {
        const text = String(raw);
        if (artifactsIsRemote(text)) {
          warnings.push(`远程文件将在运行时下载：${text}`);
          continue;
        }
        if (!path.isAbsolute(text)) {
          issues.push(`文件必须是绝对路径或 http(s) URL：${text}`);
          warnings.push(`文件必须是绝对路径或 http(s) URL：${text}`);
        } else if (!fs.existsSync(text)) {
          issues.push(`文件不存在：${text}`);
          warnings.push(`文件不存在：${text}`);
        }
      }
    } catch (error) {
      const message = String((error as Error)?.message || error);
      issues.push(message);
      warnings.push(message);
    }
    if (script.kind === "publish") {
      warnings.push("发布类：按下发布按钮时会记录本次内容，5 分钟内不会重复发布同一条内容");
    }
    return {
      dryRun: true,
      id: script.id,
      name: script.name,
      platform: script.platform,
      kind: script.kind,
      startUrl: script.startUrl,
      variables: script.variables,
      resolvedContext: params.publicContext(context),
      stepCount: steps.length,
      steps,
      warnings,
      supported: issues.length === 0,
    };
  }

  if (name === "run_automation") {
    const script = catalog.requireScript(String(toolArgs.id || ""));
    const variables =
      toolArgs.variables && typeof toolArgs.variables === "object"
        ? (toolArgs.variables as Record<string, unknown>)
        : {};
    const context = params.buildContext(script, variables);
    const issues = params.contentIssues(script, context);
    if (issues.length) {
      throw automationError("AUTOMATION_CONTENT_INVALID", issues.join("；"), {
        issues,
      });
    }

    let attemptKey: string | null = null;
    if (script.kind === "publish") {
      // A like is idempotent; a post is not. Only the post needs the
      // "same content, once" memory.
      attemptKey = publishGuard.buildKey(
        script.id,
        publishGuard.digestContext(params.publicContext(context)),
      );
      publishGuard.check(attemptKey, {
        windowMs: script.dedupeWindowMs || publishGuard.DEFAULT_WINDOW_MS,
      });
    }

    if (!host || !host.browser) {
      throw automationError(
        "AUTOMATION_BROWSER_UNAVAILABLE",
        "自动化需要 PI-Desktop 的浏览器面板；请先打开当前对话的 Browser 页签后重试",
      );
    }

    const browser = host.browser;
    const sessionId = String(host.sessionId || "");
    const openRun = runs.submit(
      {
        automationId: script.id,
        name: script.name,
        platform: script.platform,
        kind: script.kind,
        sessionId,
      },
      async (onProgress, meta) => {
        const driver = createDriver({
          browser,
          net: host.net,
          sessionId,
          tabId: host.tabId,
          log,
          signal: meta.signal,
        });
        const value = await dsl.runScript({
          script,
          variables,
          driver,
          artifactDir: meta.artifactDir,
          timeoutMs: timeoutMsFor(toolArgs, script),
          onPublish: attemptKey
            ? () => publishGuard.record(attemptKey)
            : null,
          onProgress,
          signal: meta.signal,
        });
        return finalizeRunResult(script.id, value, meta.artifactDir);
      },
    );

    return {
      ok: true,
      schemaVersion: dsl.CONTRACT_VERSION,
      runId: openRun.runId,
      status: openRun.status,
      automation: script.id,
      kind: script.kind,
      artifacts: openRun.artifacts,
      next: "用 get_automation_run 按 runId 查询状态",
    };
  }

  if (name === "get_automation_run") {
    const runId = String(toolArgs.runId || "").trim();
    const record = runs.get(runId);
    if (!record) {
      throw automationError("RUN_NOT_FOUND", `未知 runId：${runId}`);
    }
    return record;
  }

  if (name === "cancel_automation_run") {
    const runId = String(toolArgs.runId || "").trim();
    const record = runs.cancel(runId);
    if (!record) {
      throw automationError("RUN_NOT_FOUND", `未知 runId：${runId}`);
    }
    return record;
  }

  throw automationError("UNKNOWN_TOOL", `未知工具：${name}`);
}

function artifactsIsRemote(value: unknown): boolean {
  const lower = String(value || "").trim().toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://");
}

export { TOOLS, callTool };
