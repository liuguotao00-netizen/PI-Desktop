"use strict";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ContractError, RiskControlError } from "./errors";
import { RISK_PATTERN } from "./runner";

// qiwork/src/validation.ts
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const META_FIELDS = [
  "dataSource",
  "scene",
  "script",
  "cateId",
  "kwType",
  "rankType",
  "period",
  "dateType",
  "dateRange",
  "dateLabel",
  "fetchedAt",
  "producer",
  "contractVersion",
];
const DATA_FIELDS = [
  "searchWord",
  "rank",
  "seIpvUvHits",
  "seIpvUvHitsCrc",
  "clickUv",
  "clickThroughRate",
  "payRate",
];
const STATS_FIELDS = [
  "recordCount",
  "wordCount",
  "targetCount",
  "pagesFetched",
  "pagesReused",
  "dedupCount",
  "invalidRows",
];
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined || (typeof value === "number" && !Number.isFinite(value)))
    throw new Error("产物包含非 JSON 值");
  return encoded;
}
function payloadHash(payload: Record<string, unknown>): string {
  const normalized = { ...payload };
  delete normalized.validation;
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}
function attachValidation(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    validation: {
      status: "passed",
      payloadHash: payloadHash(payload),
      validatedAt: new Date().toISOString(),
      validatorVersion: "2",
      hashAlgorithm: "sha256-sorted-json-v2",
    },
  };
}
function verifyValidation(payload: unknown): string[] {
  if (!isObject(payload) || !isObject(payload.validation))
    return ["validation 校验凭证缺失或不是对象"];
  const errors: string[] = [];
  const receipt = payload.validation;
  if (receipt.status !== "passed") errors.push("validation.status 必须为 passed");
  if (!isObject(payload.meta) || payload.meta.producer !== "sycm-market")
    errors.push("meta.producer 必须为 sycm-market");
  if (receipt.validatorVersion !== "2" || receipt.hashAlgorithm !== "sha256-sorted-json-v2")
    errors.push("旧版校验凭证需要重新校验；不能直接当作已通过");
  else if (receipt.payloadHash !== payloadHash(payload))
    errors.push("validation.payloadHash 不匹配，产物可能在校验后被修改");
  return errors;
}
function validate(payload: unknown): string[] {
  if (!isObject(payload)) return ["产物顶层必须是 JSON 对象"];
  const { meta: meta3, data, stats } = payload;
  if (!isObject(meta3) || !Array.isArray(data) || !isObject(stats))
    return ["meta/data/stats 结构不完整"];
  const errors: string[] = [];
  for (const field of META_FIELDS)
    if (typeof meta3[field] !== "string" || !meta3[field])
      errors.push(`meta.${field} 必须是非空字符串`);
  for (const [key, value] of Object.entries({
    scene: "sycm",
    producer: "sycm-market",
    contractVersion: "1",
    kwType: "search",
    rankType: "hot",
  })) {
    if (meta3[key] !== value) errors.push(`meta.${key} 必须为 ${value}`);
  }
  if (
    ![
      "vendor_scripts/search-keyword-rank.js",
      "sycm-market/scripts/search-keyword-rank.js",
    ].includes(String(meta3.script))
  )
    errors.push("meta.script 非法");
  if (!["current", "prev"].includes(String(meta3.period)))
    errors.push("meta.period 必须为 current/prev");
  if (typeof meta3.cateId !== "string" || !/^\d+$/.test(meta3.cateId))
    errors.push("meta.cateId 必须为纯数字字符串");
  if (typeof meta3.cached !== "boolean") errors.push("meta.cached 必须为布尔值");
  for (const field of STATS_FIELDS)
    if (typeof stats[field] !== "number" || !Number.isSafeInteger(stats[field]) || stats[field] < 0)
      errors.push(`stats.${field} 必须是非负整数`);
  if (typeof stats.complete !== "boolean") errors.push("stats.complete 必须为布尔值");
  if (typeof stats.stopReason !== "string" || !stats.stopReason)
    errors.push("stats.stopReason 必须为非空字符串");
  if (stats.truncatedReason !== null && typeof stats.truncatedReason !== "string")
    errors.push("stats.truncatedReason 必须为字符串或 null");
  if (stats.complete !== (stats.truncatedReason === null))
    errors.push("stats.complete 与 truncatedReason 不一致");
  if (stats.wordCount !== data.length) errors.push("stats.wordCount 与 data 条数不一致");
  if (typeof stats.targetCount === "number" && data.length > stats.targetCount)
    errors.push("data 条数不能超过 stats.targetCount");
  const seen = new Set<string>();
  data.forEach((row, index) => {
    if (!isObject(row)) {
      errors.push(`data[${index}] 必须是对象`);
      return;
    }
    for (const field of DATA_FIELDS)
      if (!(field in row)) errors.push(`data[${index}] 缺少字段 ${field}`);
    if (typeof row.searchWord !== "string" || !row.searchWord)
      errors.push(`data[${index}].searchWord 必须为非空字符串`);
    else if (seen.has(row.searchWord)) errors.push(`data[${index}].searchWord 重复`);
    else seen.add(String(row.searchWord));
  });
  return errors;
}

// qiwork/src/keywords.ts
type WordRow = { searchWord: string; [key: string]: unknown };

type FetchResult = {
  cateId?: unknown;
  recordCount?: unknown;
  words?: unknown[];
  [key: string]: unknown;
};

type PeriodResult = {
  complete: boolean;
  validated: boolean;
  period: string;
  outputFile: string | null;
  [key: string]: unknown;
};

type FetchOptions = {
  cateId: string;
  workDir: string;
  outputDir?: string;
  dateType?: string;
  period?: string;
  targetCount?: number;
  explicitDateRange?: string;
  now?: Date;
  signal?: AbortSignal;
  allowOverwrite?: string[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  [key: string]: unknown;
};

const IDENTITY = [
  "producer",
  "contractVersion",
  "cateId",
  "kwType",
  "rankType",
  "period",
  "dateRange",
];
var sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  await delay(ms, undefined, { signal });
};
function requireCateId(value: string): string {
  if (!/^\d+$/.test(value.trim())) throw new ContractError("cateId 必须为纯数字字符串");
  return value.trim();
}
function dateText(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
function resolveDateRange(
  dateType: string,
  period: string,
  explicit: string | undefined,
  now: Date = new Date(),
): { start: string; end: string; label: string; dateRange: string } {
  const days = { day: 1, recent7: 7, recent30: 30 }[dateType];
  if (!days || !["current", "prev"].includes(period)) throw new ContractError("日期类型或周期非法");
  if (explicit) {
    const [start2, end2] = explicit.split("|");
    if (
      !/^\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}$/.test(explicit) ||
      start2 > end2 ||
      [start2, end2].some(
        (date4) =>
          Number.isNaN(Date.parse(date4)) || new Date(date4).toISOString().slice(0, 10) !== date4,
      )
    )
      throw new ContractError("dateRange 必须为有效的 YYYY-MM-DD|YYYY-MM-DD");
    return { start: start2, end: end2, label: `${start2} ~ ${end2}`, dateRange: explicit };
  }
  const endDate = new Date(now);
  endDate.setDate(
    endDate.getDate() - 1 - (now.getHours() < 8 ? 1 : 0) - (period === "prev" ? days : 0),
  );
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days + 1);
  const start = dateText(startDate),
    end = dateText(endDate);
  return {
    start,
    end,
    label:
      (period === "prev" ? "上期" : "") +
      { day: "昨日", recent7: "近7天", recent30: "近30天" }[dateType],
    dateRange: `${start}|${end}`,
  };
}
async function exists(file2: string): Promise<boolean> {
  try {
    await fsPromises.lstat(file2);
    return true;
  } catch (error2) {
    if ((error2 as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error2;
  }
}
async function within(root: string, target: string): Promise<string> {
  const boundary = await fsPromises.realpath(root);
  let ancestor = path.resolve(target);
  const tail: string[] = [];
  while (!(await exists(ancestor))) {
    tail.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  const resolved = path.join(await fsPromises.realpath(ancestor), ...tail);
  const relative = path.relative(boundary, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new ContractError("文件路径越出任务目录");
  return resolved;
}
async function atomicWrite(
  file2: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const partial2 = `${file2}.${randomUUID()}.partial`;
  try {
    signal?.throwIfAborted();
    await fsPromises.writeFile(
      partial2,
      `${JSON.stringify(payload, null, 2)}
`,
      { flag: "wx" },
    );
    signal?.throwIfAborted();
    await fsPromises.rename(partial2, file2);
  } finally {
    await fsPromises.rm(partial2, { force: true });
  }
}
async function initWorkdir(
  cateId: string,
  root: string,
  taskType: string = "fetch",
) {
  cateId = requireCateId(cateId);
  if (!taskType || /[/\\]/.test(taskType) || [".", ".."].includes(taskType))
    throw new ContractError("taskType 非法");
  await fsPromises.mkdir(root, { recursive: true });
  if (await exists(path.join(root, "SKILL.md")))
    throw new ContractError("任务根目录不能是技能目录");
  const runId = `run-${new Date().toISOString().replace(/\D/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
  const workDir = await within(root, path.join(root, `category-${cateId}`, taskType, runId));
  for (const sub of ["交付文件", "中间数据文件", "临时文件"])
    await fsPromises.mkdir(path.join(workDir, sub), { recursive: true });
  return {
    workDir,
    deliveryDir: path.join(workDir, "交付文件"),
    intermediateDir: path.join(workDir, "中间数据文件"),
    tempDir: path.join(workDir, "临时文件"),
    objectType: "category",
    objectId: cateId,
    taskType,
    runId,
    reused: false,
    warnings: [],
  };
}
async function guardedWriteArtifact(
  file2: string,
  payload: unknown,
  workDir: string,
  allowOverwrite: string[] = [],
  signal?: AbortSignal,
): Promise<{ relPath: string; writeType: string; backup: string | null }> {
  file2 = await within(workDir, file2);
  const relative = path
    .relative(await fsPromises.realpath(workDir), file2)
    .split(path.sep)
    .join("/");
  let backup: string | null = null;
  if (await exists(file2)) {
    let same = false;
    try {
      const old = JSON.parse(await fsPromises.readFile(file2, "utf8"));
      const incoming = isObject(payload) ? payload : {};
      const oldMeta = isObject(old.meta) ? old.meta : null;
      const newMeta = isObject(incoming.meta) ? incoming.meta : null;
      same = Boolean(
        oldMeta &&
          newMeta &&
          IDENTITY.every((key) => oldMeta[key] === newMeta[key]),
      );
    } catch (error2) {
      if (!(error2 instanceof SyntaxError)) throw error2;
    }
    if (
      !same &&
      !allowOverwrite.includes(relative) &&
      !allowOverwrite.includes(path.basename(file2))
    )
      throw new ContractError("目标产物已存在且不同源，拒绝覆盖");
    const backupDir = await within(
      workDir,
      path.join(workDir, "临时文件", `write-backup-${randomUUID()}`),
    );
    await fsPromises.mkdir(backupDir, { recursive: true });
    backup = path.join(backupDir, path.basename(file2));
    await fsPromises.copyFile(file2, backup);
  }
  await atomicWrite(file2, payload, signal);
  return { relPath: relative, writeType: "artifact", backup };
}
function extractWords(result: unknown): FetchResult {
  if (!isObject(result) || !Array.isArray(result.words))
    throw new ContractError("接口响应缺少 words 数组");
  if (
    !Number.isSafeInteger(result.recordCount) ||
    typeof result.recordCount !== "number" ||
    result.recordCount < 0
  )
    throw new ContractError("接口响应 recordCount 必须是非负整数");
  if (result.words.some((row) => !isObject(row)))
    throw new ContractError("words 条目必须是对象");
  return result as FetchResult;
}
function normalizeWord(word: unknown): WordRow {
  const item = isObject(word) ? word : {};
  const value = (key: string) =>
    isObject(item[key]) && "value" in (item[key] as Record<string, unknown>)
      ? (item[key] as Record<string, unknown>).value
      : (item[key] ?? null);
  return Object.fromEntries(
    [
      "searchWord",
      "rank",
      "seIpvUvHits",
      "seIpvUvHitsCrc",
      "seUvEx",
      "seUvDelta",
      "clickUv",
      "clickThroughRate",
      "payRate",
    ].map((key) => [
      key,
      key === "searchWord" ? String(value(key) || "").trim() : value(key),
    ]),
  ) as WordRow;
}
async function cachedPage(
  file2: string,
  request: unknown,
): Promise<FetchResult | null> {
  if (!(await exists(file2))) return null;
  try {
    const cached2 = JSON.parse(await fsPromises.readFile(file2, "utf8"));
    if (!isObject(cached2) || !isObject(cached2.request) || !isObject(cached2.response))
      return null;
    return canonicalJson(cached2.request) === canonicalJson(request)
      ? extractWords(cached2.response)
      : null;
  } catch (error2) {
    if (error2 instanceof SyntaxError || error2 instanceof ContractError) return null;
    throw error2;
  }
}
function terminalError(error2: unknown): boolean {
  const code = isObject(error2) ? error2.code : undefined;
  return (
    error2 instanceof ContractError ||
    error2 instanceof RiskControlError ||
    RISK_PATTERN.test(String(error2)) ||
    (typeof code === "string" &&
      /^(TARGET_|ACCOUNT_|LEASE_|EXECUTION_STOPPED|TAB_CHANGED)/.test(code)) ||
    /LOGIN_REQUIRED|ACCOUNT_CHANGED|IDENTITY_CHANGED|LEASE_EXPIRED/.test(String(error2))
  );
}
async function fetchPage(
  evaluate: (request: unknown) => Promise<unknown>,
  request: unknown,
  options: FetchOptions,
): Promise<FetchResult> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return extractWords(await evaluate(request));
    } catch (error2) {
      options.signal?.throwIfAborted();
      if (terminalError(error2) || attempt >= 2) throw error2;
      await (options.sleep ?? sleep)(800 * (attempt + 1), options.signal);
    }
  }
}
async function fetchPeriod(
  evaluate: (request: unknown) => Promise<unknown>,
  options: FetchOptions,
  period: string,
): Promise<PeriodResult> {
  const cateId = requireCateId(options.cateId);
  const targetCount = options.targetCount ?? 100;
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 3e3)
    throw new ContractError("targetCount 范围为 1～3000");
  const dates = resolveDateRange(
    String(options.dateType || ""),
    period,
    options.explicitDateRange,
    options.now,
  );
  const pagesDir = await within(
    options.workDir,
    path.join(options.workDir, "临时文件", `pages_${cateId}_${period}_${dates.start}_${dates.end}`),
  );
  const interDir =
    options.outputDir ??
    (await within(options.workDir, path.join(options.workDir, "中间数据文件")));
  await fsPromises.mkdir(pagesDir, { recursive: true });
  await fsPromises.mkdir(interDir, { recursive: true });
  const words: WordRow[] = [],
    seen = new Set<string>(),
    reusedPages: number[] = [],
    recomputedPages: number[] = [];
  let pagesProcessed = 0,
    recordCount = 0,
    invalidRows = 0,
    dedupCount = 0;
  let truncatedReason: string | null = null,
    stopReason: string = "safety_limit";
  for (let page = 1; page <= 60; page++) {
    options.signal?.throwIfAborted();
    const request = {
      cateId,
      dateType: options.dateType,
      dateRange: dates.dateRange,
      orderBy: "seIpvUvHits",
      order: "desc",
      rankType: "hot",
      kwType: "search",
      page,
      pageSize: 50,
      device: "0",
    };
    const pageFile = await within(options.workDir, path.join(pagesDir, `page_${page}.json`));
    let result: FetchResult | null = await cachedPage(pageFile, request);
    if (!result) {
      try {
        result = await fetchPage(evaluate, request, options);
      } catch (error2) {
        options.signal?.throwIfAborted();
        if (terminalError(error2)) throw error2;
        truncatedReason = `第 ${page} 页失败: ${String(error2)}`;
        stopReason = "page_failed";
        break;
      }
      options.signal?.throwIfAborted();
      if (String(result.cateId || cateId) !== cateId)
        throw new ContractError("接口返回 cateId 与请求不一致");
      await atomicWrite(pageFile, { request, response: result }, options.signal);
      recomputedPages.push(page);
    } else reusedPages.push(page);
    if (!result) throw new ContractError("页面数据缺失");
    if (String(result.cateId || cateId) !== cateId)
      throw new ContractError("接口返回 cateId 与请求不一致");
    pagesProcessed++;
    recordCount = Math.max(recordCount, Number(result.recordCount) || 0);
    const resultWords = result.words ?? [];
    for (const row of resultWords) {
      const normalized = normalizeWord(row),
        key = normalized.searchWord;
      if (!key) {
        invalidRows++;
        continue;
      }
      if (seen.has(key)) {
        dedupCount++;
        continue;
      }
      seen.add(key);
      words.push(normalized);
      if (words.length >= targetCount) break;
    }
    if (words.length >= targetCount) {
      stopReason = "target_reached";
      break;
    }
    if (resultWords.length < 50) {
      stopReason = "source_exhausted";
      break;
    }
    if (recomputedPages.length)
      await (options.sleep ?? sleep)(800 * (0.8 + Math.random() * 0.8), options.signal);
  }
  if (stopReason === "safety_limit")
    truncatedReason = `达到页数熔断上限（60 页）但未完成目标 Top${targetCount}`;
  options.signal?.throwIfAborted();
  const complete = truncatedReason === null;
  const stats = {
    recordCount,
    wordCount: words.length,
    targetCount,
    pagesFetched: pagesProcessed,
    pagesReused: reusedPages.length,
    dedupCount,
    invalidRows,
    complete,
    stopReason,
    truncatedReason,
  };
  const now = options.now ?? new Date();
  const payload = {
    meta: {
      dataSource: "生意参谋-市场-搜索排行",
      scene: "sycm",
      script: "vendor_scripts/search-keyword-rank.js",
      cateId,
      kwType: "search",
      rankType: "hot",
      period,
      dateType: options.dateType,
      dateRange: dates.dateRange,
      dateLabel: dates.label,
      fetchedAt: `${dateText(now)} ${now.toTimeString().slice(0, 8)}`,
      producer: "sycm-market",
      contractVersion: "1",
      cached: reusedPages.length > 0,
      runtime: "tb-data",
    },
    data: words,
    stats,
  };
  const errors = validate(payload);
  if (errors.length) throw new ContractError(`数据合同校验失败: ${errors.join("；")}`);
  const suffix = options.outputDir ? `_${path.basename(options.workDir)}` : "";
  const outputFile = path.join(
    interDir,
    `类目搜索词排行_${cateId}_${period}_${dates.start}_${dates.end}${suffix}.json`,
  );
  const write = await guardedWriteArtifact(
    outputFile,
    attachValidation(payload),
    options.outputDir ?? options.workDir,
    options.allowOverwrite,
    options.signal,
  );
  const saved = JSON.parse(await fsPromises.readFile(outputFile, "utf8"));
  options.signal?.throwIfAborted();
  const validationErrors = [...validate(saved), ...verifyValidation(saved)];
  return {
    outputFile,
    writeType: write.writeType,
    writeBackup: write.backup,
    period,
    dateRange: dates.dateRange,
    ...stats,
    warnings: reusedPages.length
      ? [
          {
            warningCode: "PAGE_REUSED",
            reusedNodes: reusedPages.map((p) => `page_${p}`),
            recomputedNodes: recomputedPages.map((p) => `page_${p}`),
          },
        ]
      : [],
    validated: validationErrors.length === 0,
    validationErrors,
  };
}
async function runFetch(
  evaluate: (request: unknown) => Promise<unknown>,
  options: FetchOptions,
): Promise<Record<string, unknown>> {
  const period = options.period ?? "both";
  if (!["current", "prev", "both"].includes(period)) throw new ContractError("period 非法");
  if (period === "both" && options.explicitDateRange)
    throw new ContractError("period=both 时禁止只传一份 dateRange");
  const periods = period === "both" ? ["current", "prev"] : [period];
  const outputs: PeriodResult[] = [];
  for (const requested of periods) {
    outputs.push(await fetchPeriod(evaluate, options, requested));
  }
  return {
    readyForDownstream: outputs.every((output) => output.complete && output.validated),
    currentPath: outputs.find((o) => o.period === "current")?.outputFile ?? null,
    prevPath: outputs.find((o) => o.period === "prev")?.outputFile ?? null,
    outputs,
  };
}

export {
  isObject,
  canonicalJson,
  payloadHash,
  attachValidation,
  verifyValidation,
  validate,
  IDENTITY,
  requireCateId,
  dateText,
  resolveDateRange,
  exists,
  within,
  atomicWrite,
  initWorkdir,
  guardedWriteArtifact,
  extractWords,
  normalizeWord,
  cachedPage,
  terminalError,
  fetchPage,
  fetchPeriod,
  runFetch,
};
