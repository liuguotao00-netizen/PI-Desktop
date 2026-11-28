/**
 * The plugin host injects one global `pi` object before loading this module.
 * This file describes the subset of that API the plugin uses; keeping it here
 * means the compiler checks every browser call against the host contract.
 */

type PluginToolContext = {
  sessionId?: string;
  tabId?: string;
};

type PluginTool = {
  name: string;
  description: string;
  risk?: "low" | "medium" | "high";
  schema?: unknown;
  execute(args: unknown, context: PluginToolContext): Promise<unknown>;
};

type PluginBrowserApi = {
  reveal(input?: { sessionId?: string; tabId?: string }): Promise<void>;
  navigate(input: {
    url?: string;
    path?: string;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
  evaluateNative(input: {
    expression?: string;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
  evaluate(input: {
    expression: string;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
  insertText(input: {
    text: string;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
  cdp(input: {
    method: string;
    params?: unknown;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
  input(input: {
    method: string;
    params?: unknown;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
  screenshot(input?: {
    fullPage?: boolean;
    sessionId?: string;
    tabId?: string;
  }): Promise<unknown>;
};

type PluginNetFetchInput = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  responseType?: "text" | "base64";
  maxResponseBytes?: number;
  redirect?: "follow" | "error" | "manual";
};

type PluginNetFetchResult = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyBase64?: string;
  contentType?: string;
  byteLength?: number;
};

declare const pi: {
  services: {
    register(service: {
      id: string;
      start(): void | Promise<void>;
      stop?(): void | Promise<void>;
    }): void;
  };
  agent: {
    registerTool(tool: PluginTool): Promise<void>;
    unregisterTool(name: string): Promise<void>;
  };
  browser: PluginBrowserApi;
  net: {
    fetch(input: PluginNetFetchInput): Promise<PluginNetFetchResult>;
  };
};
