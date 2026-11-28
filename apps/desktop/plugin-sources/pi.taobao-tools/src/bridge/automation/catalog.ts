"use strict";

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

import * as fs from "node:fs";
import * as path from "node:path";

import { ContractError } from "./errors";
import type {
  AutomationScript,
  ContextSetupSpec,
  ScriptKind,
  ScriptStep,
  ScriptVariable,
} from "./types";

const SCRIPTS_DIR = path.join(__dirname, "scripts");

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

const CAPTURE_ACTIONS = new Set(["sessionCapture", "scrollForSession"]);

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

export const KIND_COLLECT: ScriptKind = "collect";
export const KIND_PUBLISH: ScriptKind = "publish";
/**
 * Writes that are not posts: a like, a comment, a saved draft. They change
 * the account, but a second identical like is harmless.
 */
export const KIND_INTERACT: ScriptKind = "interact";

const KINDS = new Set<ScriptKind>([KIND_COLLECT, KIND_PUBLISH, KIND_INTERACT]);

function asInt(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readScriptFiles(): Array<{ file: string; payload: string }> {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      payload: fs.readFileSync(path.join(SCRIPTS_DIR, file), "utf8"),
    }));
}

function normalizeVariable(raw: Record<string, unknown>): ScriptVariable {
  const key = String(raw.key ?? "").trim();
  if (!key) throw new ContractError("automation variable is missing key");
  const variable: ScriptVariable = {
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
  ] as const) {
    if (name in raw) variable[name] = raw[name];
  }
  return variable;
}

function scriptKind(
  scriptId: string,
  raw: Record<string, unknown>,
  actions: Set<string>,
): ScriptKind {
  const derived: ScriptKind = [...actions].some((action) =>
    PUBLISH_ACTIONS.has(action),
  )
    ? KIND_PUBLISH
    : KIND_COLLECT;
  const declared = String(raw.kind ?? "").trim();
  if (!declared) return derived;
  if (!KINDS.has(declared as ScriptKind)) {
    throw new ContractError(
      `automation ${scriptId} has unknown kind ${JSON.stringify(declared)}`,
    );
  }
  if (
    (declared === KIND_COLLECT || declared === KIND_INTERACT) &&
    derived === KIND_PUBLISH
  ) {
    throw new ContractError(
      `automation ${scriptId} declares kind ${JSON.stringify(declared)} but uses ` +
        `[${[...actions].filter((action) => PUBLISH_ACTIONS.has(action)).join(", ")}]`,
    );
  }
  // `publish` and `interact` may be declared without an action that proves
  // it: clicking a button whose label is "发布" is still a publish, and only
  // the manifest knows what that button does.
  return declared as ScriptKind;
}

function normalizeScript(
  scriptId: string,
  raw: Record<string, unknown>,
): AutomationScript {
  const steps = raw.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ContractError(`automation ${scriptId} has no steps`);
  }
  const stepList = steps.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ContractError(`automation ${scriptId} step is invalid`);
    }
    return item as Record<string, unknown>;
  });
  const actions = new Set<string>();
  stepList.forEach((step, index) => {
    const action = String(step.action ?? "");
    if (!action) {
      throw new ContractError(
        `automation ${scriptId} step ${index} has no action`,
      );
    }
    if (!SUPPORTED_ACTIONS.has(action)) {
      throw new ContractError(
        `automation ${scriptId} uses unsupported action ${JSON.stringify(action)}`,
      );
    }
    actions.add(action);
  });

  const variables = Array.isArray(raw.variables) ? raw.variables : [];
  if (
    raw.variables !== undefined &&
    raw.variables !== null &&
    !Array.isArray(raw.variables)
  ) {
    throw new ContractError(`automation ${scriptId} variables must be a list`);
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
      .filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
      .map((item) => normalizeVariable(item)),
    steps: stepList as ScriptStep[],
    contextSetup:
      raw.contextSetup && typeof raw.contextSetup === "object"
        ? (raw.contextSetup as Record<string, ContextSetupSpec>)
        : {},
    outputSchema:
      raw.outputSchema && typeof raw.outputSchema === "object"
        ? (raw.outputSchema as Record<string, unknown>)
        : {},
    dedupeWindowMs: asInt(raw.dedupeWindowMs),
    actions: [...actions].sort(),
    requiresCapture: [...actions].some((action) => CAPTURE_ACTIONS.has(action)),
  };
}

let cache: Record<string, AutomationScript> | null = null;

/**
 * Load and validate every bundled automation.
 *
 * A malformed script is a packaging error, not a runtime one: it fails the
 * whole catalogue so `list_automations` never advertises something that
 * cannot run.
 */
function loadScripts(): Record<string, AutomationScript> {
  if (cache) return cache;
  const scripts: Record<string, AutomationScript> = {};
  for (const { file, payload } of readScriptFiles()) {
    const stem = path.basename(file, ".json");
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch (error) {
      throw new ContractError(`automation ${file} is not valid JSON`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ContractError(`automation ${file} must be an object`);
    }
    const record = raw as Record<string, unknown>;
    const scriptId = String(record.id || stem).trim();
    if (!scriptId || scripts[scriptId]) {
      throw new ContractError(
        `automation id is empty or duplicated: ${scriptId}`,
      );
    }
    if (scriptId !== stem) {
      throw new ContractError(
        `automation id ${JSON.stringify(scriptId)} must match file ${JSON.stringify(stem)}`,
      );
    }
    scripts[scriptId] = normalizeScript(scriptId, record);
  }
  cache = scripts;
  return scripts;
}

function requireScript(scriptId: unknown): AutomationScript {
  const scripts = loadScripts();
  const script = scripts[String(scriptId || "").trim()];
  if (!script) {
    throw new ContractError(`未知自动化: ${scriptId}`);
  }
  return script;
}

export type ScriptCatalogItem = {
  id: string;
  name: string;
  description: string;
  platform: string;
  kind: ScriptKind;
  startUrl: string;
  variables: ScriptVariable[];
  stepCount: number;
  actions: string[];
  requiresCapture: boolean;
  outputs: string[];
};

/** Public catalogue for the tool; never includes the step JS bodies. */
function scriptCatalog(): ScriptCatalogItem[] {
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
function clearCache(): void {
  cache = null;
}

export {
  CAPTURE_ACTIONS,
  PUBLISH_ACTIONS,
  SCRIPTS_DIR,
  SUPPORTED_ACTIONS,
  asInt,
  clearCache,
  loadScripts,
  normalizeScript,
  requireScript,
  scriptCatalog,
};
