import type { PluginCompleteInput, PluginCompleteResult } from "@pi-desktop/plugin-sdk";

export type AgentCompleteDeps = {
  pluginId: string;
  input: PluginCompleteInput;
  assertPermission: () => void;
  assertSessionRead: () => void;
  rateExceeded: boolean;
  inFlight: { sessionId?: string; toolName?: string } | null;
  complete?: (input: PluginCompleteInput & {
    sessionId?: string;
    stripToolName?: string;
    signal?: AbortSignal;
  }) => Promise<PluginCompleteResult>;
  audit?: (entry: Record<string, unknown>) => void;
  timeoutMs: number;
  maxSystemChars: number;
  maxMessageChars: number;
  pluginToolName: (toolName: string) => string;
};

function apiError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * `pi.agent.complete` validation, timeout and audit. Transport and auth stay
 * with the injected `complete` service.
 */
export async function runAgentComplete(deps: AgentCompleteDeps): Promise<PluginCompleteResult> {
  deps.assertPermission();
  const { input } = deps;
  const modelKey = String(input.modelKey ?? "").trim();
  if (!modelKey || !modelKey.includes("/")) {
    throw apiError("INVALID_ARGUMENT", "modelKey must be providerId/modelId");
  }
  const system = typeof input.system === "string" ? input.system : "";
  if (system.length > deps.maxSystemChars) {
    throw apiError("INVALID_ARGUMENT", "system prompt exceeds 32 KiB");
  }
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const messageChars = messages.reduce(
    (sum, message) => sum + String(message?.content ?? "").length,
    0,
  );
  if (messageChars > deps.maxMessageChars) {
    throw apiError("INVALID_ARGUMENT", "messages exceed 200k characters");
  }
  const images = Array.isArray(input.images) ? input.images.slice(0, 4) : [];
  if (images.some((image) => !image || typeof image.data !== "string" || typeof image.mimeType !== "string")) {
    throw apiError("INVALID_ARGUMENT", "images are malformed");
  }
  if (images.reduce((sum, image) => sum + image.data.length, 0) > 12 * 1024 * 1024) {
    throw apiError("INVALID_ARGUMENT", "images exceed 12 MiB");
  }
  if (deps.rateExceeded) {
    deps.audit?.({
      pluginId: deps.pluginId,
      api: "agent.complete",
      ok: false,
      errorCode: "RATE_LIMITED",
      ts: Date.now(),
    });
    throw apiError("RATE_LIMITED", "plugin completion rate exceeded");
  }
  const includeSessionContext = input.includeSessionContext === true;
  if (includeSessionContext) deps.assertSessionRead();
  if (includeSessionContext && !deps.inFlight?.sessionId) {
    throw apiError("INVALID_ARGUMENT", "session context is only available during tool execution");
  }
  if (!deps.complete) {
    throw apiError("UNSUPPORTED", "host api not available: agent.complete");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  let result: PluginCompleteResult;
  try {
    result = await deps.complete({
      modelKey,
      thinkingLevel: input.thinkingLevel,
      system: system || undefined,
      messages,
      ...(images.length ? { images } : {}),
      includeSessionContext,
      sessionId: deps.inFlight?.sessionId,
      stripToolName: deps.inFlight?.toolName
        ? deps.pluginToolName(deps.inFlight.toolName)
        : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      deps.audit?.({
        pluginId: deps.pluginId,
        api: "agent.complete",
        ok: false,
        errorCode: "TIMEOUT",
        ts: Date.now(),
      });
      throw apiError("TIMEOUT", "plugin completion timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  deps.audit?.({
    pluginId: deps.pluginId,
    api: "agent.complete",
    ok: true,
    modelKey: result.modelKey,
    systemChars: system.length,
    messageChars,
    outputChars: result.text.length,
    usage: result.usage,
    ts: Date.now(),
  });
  return result;
}
