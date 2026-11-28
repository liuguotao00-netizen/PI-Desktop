"use strict";

/**
 * Script parameters: templates, variable coercion and content limits.
 *
 * Everything here is pure data handling — no browser, no driver. Keeping it
 * separate from the executor is what lets a script's parameters be previewed
 * and validated without opening a page.
 */

import { asInt } from "./catalog";
import { ContractError } from "./errors";
import type {
  AutomationContext,
  AutomationScript,
  ContextSetupSpec,
  Target,
} from "./types";

function renderTemplate(value: unknown, context: Record<string, unknown>) {
  if (typeof value !== "string" || !value.includes("{{")) return value;
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawKey) => {
    const resolved = context[String(rawKey).trim()];
    return resolved === undefined || resolved === null ? "" : String(resolved);
  });
}

function _toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function compare(left: unknown, op: string, right: unknown): boolean {
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

function coerceFiles(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  const text = String(raw).trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ContractError("文件参数必须是 JSON 数组");
    }
    if (!Array.isArray(parsed)) throw new ContractError("文件参数必须是 JSON 数组");
    return parsed.map((item) => String(item).trim()).filter(Boolean);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildContext(
  script: AutomationScript,
  variables: Record<string, unknown>,
): AutomationContext {
  const context: AutomationContext = {};
  const kinds: Record<string, string> = {};
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
  for (const [key, spec] of Object.entries<ContextSetupSpec>(script.contextSetup || {})) {
    if (!spec || typeof spec !== "object") continue;
    const kind = String(spec.type || "string");
    const source = Object.prototype.hasOwnProperty.call(context, key)
      ? context[key]
      : spec.default !== undefined
        ? spec.default
        : "";
    if (kind === "number") {
      const numeric = _toNumberOrNull(source);
      context[key] = numeric === null ? asInt(spec.default, 0) : Math.trunc(numeric);
    } else if (kind === "derived") {
      const baseKey = String(spec.source || "");
      const base = Object.prototype.hasOwnProperty.call(context, baseKey)
        ? context[baseKey]
        : spec.default;
      context[key] = compare(base, String(spec.op || ">"), spec.value);
    } else {
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

function resolveFiles(value: unknown, context: Record<string, unknown>): string[] {
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

function utf16Length(text: string): number {
  return text.length;
}

function xhsWeight(char: string): number {
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
function xhsLength(text: string): number {
  let total = 0;
  for (const char of text) total += xhsWeight(char);
  return Math.ceil(total / 2);
}

/** Length in the platform's own counting unit. */
function textLength(text: unknown, unit = "chars"): number {
  const kind = String(unit).toLowerCase();
  const value = String(text ?? "");
  if (kind === "utf16") return utf16Length(value);
  if (kind === "xhs") return xhsLength(value);
  return [...value].length;
}

/** Cut *text* to a platform limit, in the platform's own counting unit. */
function truncateText(text: unknown, maxChars: number, unit = "chars"): string {
  const value = String(text ?? "");
  const limit = Number(maxChars) || 0;
  if (limit <= 0 || !value) return value;
  const kind = String(unit).toLowerCase();
  if (kind === "utf16" || kind === "xhs") {
    if (textLength(value, kind) <= limit) return value;
    let kept = "";
    let used = 0;
    for (const char of value) {
      const size = kind === "utf16" ? char.length : xhsWeight(char);
      const grown = used + size;
      if (kind === "xhs") {
        if (Math.ceil(grown / 2) > limit) break;
      } else if (grown > limit) {
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
function globToRegex(pattern: unknown): string {
  let output = "";
  for (const char of String(pattern || "*")) {
    if (char === "*") output += ".*";
    else if (char === "?") output += ".";
    else output += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return output;
}

/**
 * Problems the platform would reject before we touch the page.
 *
 * `maxChars` truncates text to fit; a minimum length or a forbidden character
 * cannot be fixed by truncating, so they are checked up front and reported.
 */
function contentIssues(
  script: AutomationScript,
  context: AutomationContext,
): string[] {
  const issues: string[] = [];
  for (const variable of script.variables || []) {
    const key = String(variable.key || "");
    if (!key || String(variable.type || "") === "files") continue;
    const text = String(context[key] ?? "");
    if (!text) continue;
    const unit = String(variable.lengthUnit || "chars");
    const minimum = asInt(variable.minChars, 0);
    if (minimum > 0 && textLength(text, unit) < minimum) {
      issues.push(
        `${key} 至少需要 ${minimum} 字，现在是 ${textLength(text, unit)} 字`,
      );
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
function renderTarget(
  target: Target | undefined,
  context: Record<string, unknown>,
): Target {
  if (!target || typeof target !== "object") return {};
  const rendered: Target = { ...target };
  for (const key of ["selector", "text", "shadowHost"]) {
    if (key in rendered) rendered[key] = renderTemplate(rendered[key], context);
  }
  return rendered;
}

/** Read a dotted path (`a.b.c`) out of an object. */
function getPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  return String(path)
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      if (!current || typeof current !== "object") return undefined;
      return (current as Record<string, unknown>)[key];
    }, value);
}

/** Copy the context a page-side `execute` function may see. */
function publicContext(context: AutomationContext): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context).filter(([key]) => !key.startsWith("_")),
  );
}

export {
  buildContext,
  compare,
  contentIssues,
  coerceFiles,
  getPath,
  globToRegex,
  publicContext,
  renderTarget,
  renderTemplate,
  resolveFiles,
  textLength,
  truncateText,
  xhsLength,
};
