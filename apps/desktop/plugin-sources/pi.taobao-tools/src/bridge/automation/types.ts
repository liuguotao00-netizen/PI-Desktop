/**
 * Data shapes shared by the catalogue, the parameter layer and the executor.
 *
 * The JSON scripts are the contract; these types describe exactly what the
 * loader produces after validation, so a step handler can rely on its fields
 * instead of re-checking them.
 */

export type ScriptKind = "collect" | "publish" | "interact";

export type Target = {
  selector?: string;
  text?: string;
  shadowHost?: string;
  [key: string]: unknown;
};

export type ScriptVariable = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  default?: unknown;
  options?: unknown;
  placeholder?: unknown;
  accept?: unknown;
  minChars?: unknown;
  forbidChars?: unknown;
  lengthUnit?: unknown;
};

export type ScriptStep = {
  action: string;
  id?: string;
  description?: string;
  timeout?: number;
  when?: string;
  whenState?: string;
  postWait?: number | number[];
  retry?: number;
  retryDelayMin?: number;
  retryDelayMax?: number;
  target?: Target;
  hoverTarget?: Target;
  value?: unknown;
  inputSelector?: string;
  shadowHost?: string;
  trusted?: boolean;
  tagMode?: boolean;
  noClick?: boolean;
  maxChars?: number;
  maxLengthUnit?: string;
  timeoutMode?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ContextSetupSpec = {
  type?: string;
  default?: unknown;
  source?: string;
  op?: string;
  value?: unknown;
  [key: string]: unknown;
};

export type AutomationScript = {
  id: string;
  name: string;
  platform: string;
  description: string;
  kind: ScriptKind;
  startUrl: string;
  variables: ScriptVariable[];
  steps: ScriptStep[];
  contextSetup: Record<string, ContextSetupSpec>;
  outputSchema: Record<string, unknown>;
  dedupeWindowMs: number;
  actions: string[];
  requiresCapture: boolean;
};

export type Capture = {
  url: string;
  body: unknown;
  keys: string[];
  ts: number;
};

export type SessionSpec = {
  sessionKey: string;
  urlIncludes: string[];
  countByValueKey?: string;
  hasNextKey?: string;
  valueKey?: Array<{ name?: string; path?: string }>;
  [key: string]: unknown;
};

export type AutomationContext = {
  _captures?: Capture[];
  _sessions?: Record<string, SessionSpec>;
  [key: string]: unknown;
};

export type ResolvedTarget = {
  mode: "element" | "node" | "object" | "backend";
  box?: Record<string, number>;
  editable?: boolean;
  tag?: string;
  disabled?: boolean;
  nodeId?: number;
  backendId?: number;
  objectId?: string;
};
