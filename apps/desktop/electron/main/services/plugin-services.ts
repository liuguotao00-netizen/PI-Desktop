import { BrowserWindow, app, dialog, globalShortcut, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getActiveRemoteHostsBoot } from "../bootstrap/remote-hosts";
import { createPluginWorkspaceReader } from "../remote/plugin-workspace-files";
import {
  IPC,
  ErrorCodes,
  FILE_LINES_ADD_CHANNEL,
  type ActivationScope,
  type AppSettings,
  type BrowserState,
  type McpServerStatus,
  type ModelBinding,
  type ShortcutPlatform,
  type ThinkingLevel,
  type ProjectRecord,
  normalizeProjectPath,
  type UiMessage,
} from "@pi-desktop/shared";
import type {
  PluginCompleteResult,
  PluginNativeNotificationInput,
  PluginNativeNotificationResult,
  PluginNotificationPermission,
  PluginSessionUserMessagePersisted,
} from "@pi-desktop/plugin-sdk";
import {
  asPluginThinkingLevel,
  listReadyPluginModels,
  parsePluginModelKey,
  pluginCompleteContext,
  pluginSessionContextFromSession,
} from "../plugin-agent-complete";
import type { LegacyPromptEnhancementSettings } from "../plugin-prompt-enhancement-migration";
import {
  completeOneShot,
  type RuntimeProviderConfig,
} from "@pi-desktop/agent-runtime";
import { createFsConsentService } from "../plugin-fs-consent";
import { pluginWorkspaceInfo, projectFolderPaths } from "../workspace-roots";
import { createDesktopConsentService } from "../plugin-desktop-consent";
import { PluginRuntime } from "../plugin-runtime";
import { createSpeechService } from "./speech-service";
import { PluginShortcutRegistry } from "../plugin-shortcut-registry";
import { PluginWebSocketRegistry } from "../plugin-websocket";
import { hostGlobalShortcutBindings } from "../bootstrap/launcher";
import { UserMcpRuntime } from "../user-mcp";
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_TOOL_DISCOVERY_TIMEOUT_MS,
  McpServerClient,
} from "../plugin-mcp";
import { McpOAuthManager } from "../mcp-oauth";
import { PluginPanelHost } from "../plugin-panel-host";
import { PluginViewHost } from "../plugin-view-host";
import { SESSION_SCOPED_EVENTS, sessionEventScopeFilter } from "../plugin-session-scope";
import { BrowserPane } from "../browser-view";
import { ExtensionBridgeServer } from "../browser/extension-server.ts";
import { BrowserSessions } from "../browser/sessions.ts";
import { TabLifecycle } from "../browser/lifecycle.ts";
import { takeOver } from "../browser-agent-control.ts";
import { nativeHostScriptExists, registerBrowserNativeHost } from "../browser/native-host.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { clearBrowserProfile } from "../browser/profile.ts";
import { BrowserBackingHost } from "../browser-backing-host";
import { BrowserHost, BROWSER_PLUGIN_ID } from "../browser-host";
import { BrowserRouter } from "../browser-backends";
import { CuaSessions } from "../cua/session";
import { CuaRuntime } from "../cua/runtime";
import { captureGrantedWindow } from "../computer-use/capture";
import { createBrowserService } from "../browser/service";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "../oauth";
import type { ClipboardHistory } from "../clipboard-history";
import type { TurnEndedPayload } from "../runtime/session-coordination";
import type { HostProcess } from "../host-process";
import { createPluginSessionContext } from "./plugin-session-context";
import { createPluginProjectLister } from "./plugin-projects";
import { createPluginSessionProjectResolver } from "./plugin-session-project";
import { createComposerSuggestionRelay } from "./composer-suggestion";
import { createPluginModelContext } from "../runtime/plugin-model-context";
import type { Logger } from "../logger";
import type { PluginAppearance } from "../../shared/plugin-panel-chrome";

import { addFileLinesFromView } from "../file-line-reference";

export type PluginServicesDependencies = {
  dataDir: string;
  logger: Logger;
  getMainWindow: () => BrowserWindow | null;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  safeOpenExternal: (rawUrl: unknown) => Promise<void>;
  stripWinLongPrefix: (path: string) => string;
  clipboardHistory: ClipboardHistory;
  getPluginNotificationPermission: () => PluginNotificationPermission;
  requestPluginNotificationPermission: () => Promise<PluginNotificationPermission>;
  showPluginNativeNotification: (
    input: PluginNativeNotificationInput,
  ) => Promise<PluginNativeNotificationResult>;
  getUpdaterLocale: () => string;
  getPluginPanelTheme: () => "light" | "dark";
  getAppearance: () => PluginAppearance;
  getWorkspacePath: () => string | null;
  resolveAgentRuntimeLaunch: (...args: any[]) => Promise<any>;
  vendorOAuth: VendorOAuth;
  /** The live turn of one session, read from the host's own turn map. */
  getActiveTurn: (sessionId: string) => string | null;
  isTurnDispatchable: (sessionId: string, turnId: string) => boolean;
  /**
   * Whether a plugin's contributions apply to the project the window shows.
   * Scope records live in Main, so this is the one lookup that decides.
   */
  isPluginActiveInProject: (pluginId: string) => boolean;
  /**
   * Scope check against an explicit project path, so the session-event
   * fan-out can hold the same line `session.getActive` does for sessions
   * that are not the window's own selection (#1754).
   */
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean;
};

/**
 * Session events whose payload describes the user's current selection. A
 * detached `ui.panel` window is application-scoped — it does not belong to a
 * session — so it never receives them; plugin processes and docked views do.
 */
export function createPluginServices({
  dataDir,
  logger,
  getMainWindow,
  getHost,
  sendToRenderer,
  safeOpenExternal,
  stripWinLongPrefix,
  clipboardHistory,
  getPluginNotificationPermission,
  requestPluginNotificationPermission,
  showPluginNativeNotification,
  getUpdaterLocale,
  getPluginPanelTheme,
  getAppearance,
  getWorkspacePath,
  resolveAgentRuntimeLaunch,
  vendorOAuth,
  getActiveTurn,
  isTurnDispatchable,
  isPluginActiveInProject,
  pluginActiveInProject,
}: PluginServicesDependencies) {
  // A plugin request can lose its race with host shutdown or restart.
  const isHostUnavailable = (error: unknown): boolean =>
    (error as { errorCode?: string } | null | undefined)?.errorCode ===
    ErrorCodes.HOST_UNAVAILABLE;
  const pluginPanels = new PluginPanelHost(
    async (pluginId, channel, payload, context) => {
      if (channel !== FILE_LINES_ADD_CHANNEL) return plugins.invokePanelBridge(pluginId, channel, payload, context);
      return addFileLinesFromView(pluginId, context?.senderId, payload, {
        plugins, pluginViews, pluginSession, pluginActiveInProject, getHost, getWorkspacePath,
        publish: (selection) => sendToRenderer(IPC.event.composerFileLines, selection),
      });
    },
    // A panel reaching for an undeclared host is the shape an exfiltration
    // attempt takes, so it is logged like a denied API call rather than dropped
    // silently in the network layer.
    ({ pluginId, url }) => {
      logger.app("plugin", "warn", "plugin.api", {
        pluginId,
        code: "PERMISSION_DENIED",
        data: { api: "panel.egress", ok: false, url, ts: Date.now() },
      });
    },
    (pluginId, channel, error) => {
      logger.app("plugin", "warn", "plugin.panel.bridge", {
        pluginId,
        code: (error as { code?: string })?.code ?? "PANEL_BRIDGE_FAILED",
        data: { channel, error: String(error) },
      });
    },
  );
  const callPluginSessionHost = async (
    method: string,
    pluginId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!getHost()) {
      throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
    }
    const result = await getHost()!.call(method, { ...input, pluginId });
    const body = (result ?? {}) as Record<string, unknown>;
    const changed =
      (method === "plugin.session.import" && body.imported === true) ||
      (method === "plugin.session.importBatch" && Number(body.imported ?? 0) > 0) ||
      (method === "plugin.session.rename" && body.updated === true) ||
      (method === "plugin.session.setAutoTitle" && body.updated === true) ||
      (method === "plugin.session.delete" && body.deleted === true) ||
      // Message-level writes (ADR 0339) also change what the user sees in the
      // open transcript, so they announce themselves like the session writes.
      (method === "plugin.session.appendMessage" && typeof body.messageId === "string") ||
      (method === "plugin.session.replaceMessages" && typeof body.messageCount === "number") ||
      (method === "plugin.session.deleteMessage" && typeof body.deletedCount === "number") ||
      (method === "plugin.session.truncateFrom" && typeof body.keptCount === "number");
    if (changed) {
      // `sessionId` scopes the refresh to the session that actually changed, so
      // the shell can repaint an open transcript without re-selecting it.
      const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
      sendToRenderer(IPC.event.sessionsChanged, {
        reason: method,
        pluginId,
        ...(sessionId ? { sessionId } : {}),
      });
    }
    return result;
  };
  const callPluginProjectHost = async (
    pluginId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!getHost()) {
      throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
    }
    const result = await getHost()!.call<{
      project?: { id?: number; path?: string; name?: string };
    }>("projects.create", { ...input, pluginId });
    const project = result.project;
    if (!project || typeof project.id !== "number" || !project.path || !project.name) {
      throw Object.assign(new Error("invalid project response"), { code: "INTERNAL" });
    }
    return { projectId: project.id, path: project.path, name: project.name };
  };
  /**
   * System-wide accelerators for plugins. Electron's `globalShortcut` is the
   * same registration API the app's own shortcuts use, so a plugin binding
   * conflicts with the host instead of fighting it, and the registry owns
   * every release path.
   */
  const shortcutPlatform: ShortcutPlatform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "win32"
        : "linux";
  const pluginShortcuts = new PluginShortcutRegistry({
    platform: shortcutPlatform,
    // The launcher owns the app's own global accelerators; asking it what it
    // currently holds keeps a rebound accelerator available to plugins instead
    // of blocking the shipped default forever.
    hostBindings: hostGlobalShortcutBindings,
    register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
    unregister: (accelerator) => {
      globalShortcut.unregister(accelerator);
    },
    // Late-bound: the runtime is constructed just below, and a trigger can
    // only arrive once the app is running and a plugin holds a shortcut.
    onTrigger: (entry) => {
      void plugins.triggerPluginShortcut(entry);
    },
    onRefused: (info) =>
      logger.app("plugin", "warn", "plugin global shortcut refused", { data: info }),
  });
  /**
   * Real-time sockets for plugins. The transport is `ws`, wrapped by a registry
   * that owns the budget, the bounds, and the release path; events are routed
   * to the owning plugin's process only.
   */
  const pluginSockets = new PluginWebSocketRegistry({
    onEvent: (pluginId, event) => plugins.deliverSocketEvent(pluginId, event),
  });
  const plugins: PluginRuntime = new PluginRuntime({
    pluginShortcuts,
    pluginSockets,
    providerOAuthPrompt: (pluginId, loginId, input) =>
      vendorOAuth.promptPluginOAuth(pluginId, loginId, input),
    providerOAuthNotify: (pluginId, loginId, event) =>
      vendorOAuth.notifyPluginOAuth(pluginId, loginId, event),
    getWorkspacePath: () => {
      // Filled after host boots; temporary stub until services rebinding.
      return null;
    },
    getLegacyPromptEnhancementSettings: async (): Promise<LegacyPromptEnhancementSettings | null> => {
      const host = getHost();
      if (!host?.isAvailable()) return null;
      const settings = await host.call<AppSettings>("settings.get");
      return {
        promptEnhancementProviderId: settings.promptEnhancementProviderId,
        promptEnhancementModelId: settings.promptEnhancementModelId,
        promptEnhancementThinkingLevel: settings.promptEnhancementThinkingLevel,
        promptEnhancementCustomTemplate: settings.promptEnhancementCustomTemplate,
        promptEnhancementUserTemplate: settings.promptEnhancementUserTemplate,
      };
    },
    showToast: (message) => sendToRenderer(IPC.event.toast, { message }),
    notify: (input) =>
      sendToRenderer(IPC.event.toast, {
        message: `${input.title}${input.body ? `: ${input.body}` : ""}`,
      }),
    getNotificationPermission: getPluginNotificationPermission,
    requestNotificationPermission: async () => {
      const permission = await requestPluginNotificationPermission();
      if (permission === "granted") {
        sendToRenderer(IPC.event.notificationSound, {});
      }
      return permission;
    },
    showNativeNotification: async (input) => {
      const result = await showPluginNativeNotification(input);
      if (result.shown) sendToRenderer(IPC.event.notificationSound, {});
      return result;
    },
    openExternal: async (url) => {
      await safeOpenExternal(url);
    },
    openPath: async (fullPath) => {
      const error = await shell.openPath(stripWinLongPrefix(fullPath));
      if (error) throw new Error(error);
    },
    revealPath: async (fullPath) => {
      shell.showItemInFolder(stripWinLongPrefix(fullPath));
    },
    readClipboard: async () => {
      const { clipboard } = await import("electron");
      return clipboard.readText();
    },
    writeClipboard: async (value) => {
      const { clipboard } = await import("electron");
      clipboard.writeText(value);
      clipboardHistory.recordText(value);
    },
    readClipboardHistory: async () => clipboardHistory.getHistory(),
    getLocale: () => getUpdaterLocale(),
    getAppearance: () => getAppearance(),
    openPanel: async (request) => {
      await pluginPanels.open({
        ...request,
        locale: getUpdaterLocale(),
        theme: getPluginPanelTheme(),
      });
    },
    closePanel: async (pluginId) => {
      await pluginPanels.close(pluginId);
    },
    // `net.fetch` is deliberately not overridden here: the runtime's own
    // implementation follows redirects by hand and re-checks the manifest
    // egress allowlist before every hop. A plain `fetch` service would let an
    // allowlisted host 30x the request straight out to an undeclared one.
    audit: (entry) => {
      logger.app("plugin", "info", "plugin.api", entry);
    },
    // A file access the manifest did not cover is decided by the user, natively
    // and synchronously: the plugin's call is still waiting on the answer, so
    // there is no window in which the access happens before consent.
    confirmFsAccess: createFsConsentService({
      getWindow: () => getMainWindow(),
      getLocale: () => getUpdaterLocale(),
    }),
    // A dangerous desktop operation (session delete, permission-mode change,
    // tool approval) requested by a plugin is decided by the user in a native
    // dialog that names the catalog operation, never plugin-authored text.
    confirmDesktopControl: createDesktopConsentService({
      getWindow: () => getMainWindow(),
      getLocale: () => getUpdaterLocale(),
    }),
    // The OS trash is what makes a plugin delete recoverable, and it is the
    // reason none of the user's data is copied anywhere by us.
    trashItem: async (fullPath) => {
      await shell.trashItem(fullPath);
    },
    pickDirectory: async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return result.filePaths[0];
    },
    // Refused under every root and grant: the data directory holds provider keys
    // and the session store, and a plugin reaching it would undo every other
    // limit on this list.
    protectedPaths: () => [dataDir],
    listModels: async () => {
      // Same D080 degrade as skills/MCP/subagent catalog reads: a dead
      // transport is expected during shutdown and supervised restarts.
      const host = getHost();
      if (!host?.isAvailable()) return [];
      try {
        const [listed, settings] = await Promise.all([
          host.call<{ providers: Array<{
            id: string;
            name: string;
            enabled?: boolean;
            hasSecret?: boolean;
            hasOauth?: boolean;
            authKind?: string;
            supportsReasoning?: boolean;
            supportedThinkingLevels?: ThinkingLevel[];
            defaultModelId?: string;
            models?: ModelBinding[];
          }> }>("providers.list", { includeDisabled: false }),
          host.call<AppSettings>("settings.get"),
        ]);
        return listReadyPluginModels(listed.providers ?? [], settings);
      } catch (error) {
        if (!isHostUnavailable(error)) throw error;
        return [];
      }
    },
    getSessionContext: async (sessionId, stripToolName) => {
      if (!getHost()) {
        throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
      }
      const detail = await getHost()!.call<{
        session?: {
          messages?: UiMessage[];
          compaction?: import("@pi-desktop/shared").ContextCompactionRecord;
          providerId?: string;
          modelId?: string;
          thinkingLevel?: string;
        } | null;
      }>("session.get", { id: sessionId });
      return pluginSessionContextFromSession(sessionId, detail?.session, stripToolName);
    },
    session: {
      list: (pluginId, input) => callPluginSessionHost("plugin.session.list", pluginId, input),
      get: (pluginId, input) => callPluginSessionHost("plugin.session.get", pluginId, input),
      listMessages: (pluginId, input) =>
        callPluginSessionHost("plugin.session.listMessages", pluginId, input),
      getAutoTitleContext: (pluginId, input) =>
        callPluginSessionHost("plugin.session.autoTitleContext", pluginId, input),
      setAutoTitle: (pluginId, input) =>
        callPluginSessionHost("plugin.session.setAutoTitle", pluginId, input),
      import: (pluginId, input) => callPluginSessionHost("plugin.session.import", pluginId, input),
      importBatch: (pluginId, input) =>
        callPluginSessionHost("plugin.session.importBatch", pluginId, input),
      rename: (pluginId, input) => callPluginSessionHost("plugin.session.rename", pluginId, input),
      delete: (pluginId, input) => callPluginSessionHost("plugin.session.delete", pluginId, input),
      appendMessage: (pluginId, input) =>
        callPluginSessionHost("plugin.session.appendMessage", pluginId, input),
      replaceMessages: (pluginId, input) =>
        callPluginSessionHost("plugin.session.replaceMessages", pluginId, input),
      deleteMessage: (pluginId, input) =>
        callPluginSessionHost("plugin.session.deleteMessage", pluginId, input),
      truncateFrom: (pluginId, input) =>
        callPluginSessionHost("plugin.session.truncateFrom", pluginId, input),
    },
    project: {
      create: (pluginId, input) => callPluginProjectHost(pluginId, input),
    },
    // Read-only usage facts: the same host-owned session transport, no
    // mutation, so no `sessionsChanged` fan-out (callPluginSessionHost only
    // announces the mutating methods).
    usage: {
      listTurns: (pluginId, input) =>
        callPluginSessionHost("plugin.usage.listTurns", pluginId, input),
    },
    complete: async (input): Promise<PluginCompleteResult> => {
      if (!getHost()) {
        throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
      }
      const parsed = parsePluginModelKey(input.modelKey);
      if (!parsed) {
        throw Object.assign(new Error("modelKey must be providerId/modelId"), {
          code: "INVALID_ARGUMENT",
        });
      }
      const thinkingLevel = asPluginThinkingLevel(input.thinkingLevel);
      const settings = await getHost()!.call<any>("settings.get");
      const launchSessionId = input.sessionId || `plugin-complete:${crypto.randomUUID()}`;
      const session = input.sessionId
        ? (await getHost()!.call<{ session?: any }>("session.get", { id: input.sessionId })).session
        : {};
      const launch = await resolveAgentRuntimeLaunch(launchSessionId, session ?? {}, settings, {
        mode: "agent",
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        thinkingLevel,
      });
      const runtimeProvider = {
        ...launch.sidecarParams.provider,
        ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
          ? { resolveAuth: () => vendorOAuth.resolveAuth(launch.providerId) }
          : {}),
      } as RuntimeProviderConfig;
      const sessionContext = input.includeSessionContext
        ? pluginSessionContextFromSession(
            String(input.sessionId ?? ""),
            session,
            input.stripToolName,
          )
        : undefined;
      const context = pluginCompleteContext({
        modelKey: input.modelKey,
        thinkingLevel: input.thinkingLevel,
        system: input.system,
        messages: input.messages,
        includeSessionContext: input.includeSessionContext,
        sessionContext,
      });
      const result = await completeOneShot(
        runtimeProvider,
        context,
        launch.sidecarParams.thinkingLevel,
        {
          signal: input.signal,
          sessionId: launchSessionId,
          // Spec 07-plugins/03-plugin-api.md: empty model output answers the
          // plugin with INVALID_ARGUMENT, not the runtime's internal code.
          emptyErrorCode: "INVALID_ARGUMENT",
          emptyErrorMessage: "The model returned no text.",
        },
      );
      return {
        text: result.text,
        modelKey: `${launch.providerId}/${launch.modelId}`,
        thinkingLevel: launch.sidecarParams.thinkingLevel,
        usage: result.usage,
      };
    },
    // A plugin host process dying is contained: contributions are already
    // deregistered by the runtime, we only have to tell the user and the UI.
    onPluginCrash: ({ pluginId, exitCode, exitCodeHex }) => {
      logger.app("plugin", "error", "plugin host process crashed", {
        pluginId,
        code: "PLUGIN_CRASHED",
        data: {
          exitCode,
          ...(exitCodeHex ? { exitCodeHex } : {}),
        },
      });
      // No toast here: the runtime already raised one through `showToast` on the
      // same code path, and a second identical message reads as two failures.
      // The view's page outlived the process behind its bridge, so it is a dead
      // surface. Drop it; the renderer re-opens it on the pluginChanged event if
      // the tab is still active and the plugin came back.
      pluginViews.closePlugin(pluginId);
      if (pluginId === BROWSER_PLUGIN_ID) browserHost.disposeGuest();
      sendToRenderer(IPC.event.pluginChanged,{ reason: "crash", pluginId });
    },
    // Supervision state is UI-only: the runtime owns restarts, the renderer just
    // reflects what happened.
    onServiceChange: (status) => {
      logger.app("plugin", "info", "plugin.service", {
        pluginId: status.pluginId,
        data: { serviceId: status.serviceId, state: status.state, restarts: status.restarts },
      });
      sendToRenderer(IPC.event.pluginChanged,{
        reason: "service",
        pluginId: status.pluginId,
      });
    },
    // Hot reload happens without anyone asking for it, so it has to report
    // itself: the plugins page reads status from the host, not from the edit.
    onPluginReloaded: async ({ pluginId, name, ok, message }) => {
      logger.app("plugin", ok ? "info" : "error", "development plugin reloaded", {
        pluginId,
        data: { ok, message },
      });
      sendToRenderer(IPC.event.toast, {
        message: ok ? `Reloaded ${name}` : `Reload failed: ${name} — ${message ?? ""}`,
      });
      // Views and panels were loaded from the previous revision of the plugin's files.
      pluginViews.closePlugin(pluginId);
      await pluginPanels.close(pluginId, { force: true });
      if (pluginId === BROWSER_PLUGIN_ID) browserHost.disposeGuest();
      sendToRenderer(IPC.event.pluginChanged,{ reason: "reload", pluginId });
    },
  });
  let userMcp: UserMcpRuntime;
  const mcpOAuth: McpOAuthManager = new McpOAuthManager({
    call: async (method, params) => {
      const h = getHost();
      if (!h) throw new Error("host unavailable");
      return h.call(method, params);
    },
    emit: (event) => sendToRenderer(IPC.event.mcpOauth, event),
    openExternal: (url) => safeOpenExternal(url),
    log: (level, message, data) => logger.app("plugin", level, message, { data }),
    onAuthorized: async (serverId, record): Promise<McpServerStatus> => {
      const existed = userMcp.listRecords().some((item) => item.id === serverId);
      userMcp.invalidate(serverId);
      // A server no workspace lists yet is tested as saved, without being
      // adopted into a list, and its probe connection is dropped afterwards.
      const status: McpServerStatus = await userMcp.test(serverId, null, existed ? undefined : record);
      if (!existed) userMcp.invalidate(serverId);
      sendToRenderer(IPC.event.pluginChanged, { reason: "mcp", pluginId: serverId });
      return status;
    },
  });
  userMcp = new UserMcpRuntime({
    createClient: (config) => new McpServerClient(config),
    oauth: mcpOAuth,
    connectTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
    callTimeoutMs: MCP_CALL_TIMEOUT_MS,
    discoveryTimeoutMs: MCP_TOOL_DISCOVERY_TIMEOUT_MS,
    audit: (entry) => logger.app("plugin", "info", "mcp.api", entry),
    log: (level, message, data) => logger.app("plugin", level, message, { data }),
  });
  /**
   * Activation scopes for the loaded plugins, keyed by plugin id.
   *
   * host-core is the source of truth; this cache exists because scope has to be
   * consulted on every session assembly and every tool dispatch, which are hot
   * paths that must not wait on an RPC round trip. It is refreshed whenever the
   * plugin list is read.
   */
  const pluginScopes = new Map<string, ActivationScope>();
  /**
   * Project path per live session, so a tool dispatch can be scope-checked
   * without asking host-core which project the session belongs to. Two windows
   * can hold sessions on different projects, so this cannot be a single value.
   */
  const sessionProjects = new Map<string, string | null>();
  const modelContext = createPluginModelContext({
    isDispatchable: isTurnDispatchable,
    projectFor: (sessionId) => sessionProjects.get(sessionId),
    inProject: pluginActiveInProject,
    providers: (inScope) => plugins.modelContextProviders(inScope),
    projectId: async (projectPath) => {
      try {
        const result = await getHost()?.call<{ projects: ProjectRecord[] }>("projects.list", undefined, 100);
        const path = normalizeProjectPath(projectPath);
        const project = result?.projects.find((entry) => normalizeProjectPath(entry.path) === path);
        return project ? String(project.id) : undefined;
      } catch {
        // Project identity is advisory; the independent scope gate still applies.
        return undefined;
      }
    },
  });
  const emitBrowserState = (state: BrowserState) => {
    sendToRenderer(IPC.event.browserState, state);
  };
  const emitBrowserPresentationState = (state: BrowserState) => {
    pluginPanels.broadcast("browser:state", state);
    pluginViews.broadcast("browser:state", state);
  };
  /**
   * One fan-out for every session-lifecycle event, so a rule added here cannot
   * apply to `session:turnEnded` and be forgotten for `session:activated`.
   *
   * The selected session and its project path are reported to the plugin
   * processes and to the docked views that follow the user's selection; a
   * detached `ui.panel` window is application-scoped and never receives them.
   * Each surface owns its failure: one unreachable plugin process, panel or view
   * must not suppress the other two.
   */
  const broadcastSessionEvent = (event: string, payload: unknown): void => {
    const sessionId =
      (payload as { sessionId?: string } | null | undefined)?.sessionId ?? undefined;
    // Selection events carry another project's session identity, so the
    // fan-out holds the scope line the pull side (session.getActive,
    // ui.revealView) already enforces: a project-scoped plugin does not
    // receive a session its scope excludes (#1754). Sessions without a
    // project fall back to the workspace-relative check.
    const scopeFilter = sessionEventScopeFilter(
      event,
      sessionId,
      sessionProjects,
      pluginActiveInProject,
    );
    try {
      plugins.broadcastEvent(event, [payload], scopeFilter);
    } catch (error) {
      logger.app("plugin", "warn", `${event} plugin broadcast failed`, {
        sessionId,
        data: String(error),
      });
    }
    if (!SESSION_SCOPED_EVENTS.has(event)) {
      try {
        pluginPanels.broadcast(event, payload);
      } catch (error) {
        logger.app("plugin", "warn", `${event} panel broadcast failed`, {
          sessionId,
          data: String(error),
        });
      }
    }
    try {
      pluginViews.broadcast(event, payload, scopeFilter);
    } catch (error) {
      logger.app("plugin", "warn", `${event} view broadcast failed`, {
        sessionId,
        data: String(error),
      });
    }
  };
  const announceObservedSession = (
    event: "session:turnStarted" | "session:userMessagePersisted",
    payload: { sessionId: string; turnId: string; messageId?: string },
  ): void => {
    // A missing mapping is not an invitation to use the window's project.
    if (!sessionProjects.has(payload.sessionId)) return;
    const projectPath = sessionProjects.get(payload.sessionId);
    plugins.broadcastEvent(event, [payload], (pluginId) => pluginActiveInProject(pluginId, projectPath));
  };
  const observePersistedUserMessage = ({ sessionId, turnId, messageId }: PluginSessionUserMessagePersisted): void => {
    announceObservedSession("session:userMessagePersisted", { sessionId, turnId, messageId });
  };
  const announceTurnEnded = (payload: TurnEndedPayload): void => {
    modelContext.end(payload.sessionId, payload.turnId);
    broadcastSessionEvent("session:turnEnded", payload);
    // The snapshot also carries the running turn, so a surface that subscribes
    // to `session:activated` learns the selected session went idle from the
    // same event stream it learns a switch from.
    pluginSession.noteTurnEnded(payload.sessionId, payload.turnId);
  };
  /**
   * The selected session and its running turn, as the plugin surfaces see it.
   *
   * Created after the two window hosts above because its fan-out reaches them,
   * and after nothing else: `announceTurnEnded` above notifies it, and that only
   * ever runs once this factory has returned.
   */
  const pluginSession = createPluginSessionContext({
    getActiveTurn,
    announce: broadcastSessionEvent,
  });
  /**
   * `pi.composer.suggest` (ADR 0333): the main process refuses a suggestion
   * that names another session or an overtaken turn, and the shell answers
   * whether the composer can take it. The composer owns its own state, so this
   * only ever relays — nothing here writes the draft.
   */
  const composerSuggestion = createComposerSuggestionRelay({
    sendToRenderer,
    getActiveSession: () => pluginSession.snapshot(),
    log: (message, data) => logger.app("plugin", "warn", message, { data }),
  });
  const pluginViews = new PluginViewHost(({ pluginId, url }) => {
    logger.app("plugin", "warn", "plugin.api", {
      pluginId,
      code: "PERMISSION_DENIED",
      data: { api: "view.egress", ok: false, url, ts: Date.now() },
    });
  });
  pluginPanels.addSenderResolver((senderId) => pluginViews.pluginIdForSender(senderId));
  const browserBackingHost = new BrowserBackingHost();
  const browserSettingsCache: { current: AppSettings["browser"] | null } = { current: null };
  void getHost()?.call<AppSettings>("settings.get").then((settings) => {
    browserSettingsCache.current = settings?.browser ?? null;
  }).catch(() => undefined);
  let browserRouter: BrowserRouter;
  const browserHost = new BrowserHost({
    createPane: (onState, onOpenUrl, sessionId) =>
      new BrowserPane(onState, onOpenUrl, browserBackingHost, sessionId),
    onOpenUrl: (url, sessionId) => {
      void (async () => {
        const settings = await getHost()?.call<AppSettings>("settings.get");
        if (
          !sessionId ||
          settings?.linkOpenTarget === "external" ||
          settings?.browser?.linkTarget === "external-browser" ||
          !/^https?:/i.test(url)
        ) {
          await shell.openExternal(url);
        } else {
          sendToRenderer(IPC.event.browserPreview, { sessionId, url });
        }
      })().catch((error) => logger.app("plugin", "warn", "browser.link.open.failed", { data: String(error) }));
    },
    isPluginLoaded: (pluginId) => Boolean(plugins.getLoaded(pluginId)),
    getBrowserSettings: () => browserSettingsCache.current ?? null,
    onPageState: (page) => {
      const wc = page.pane.getWebContents();
      if (wc && !wc.isDestroyed()) browserHost.trackDownloadsForPage(page, wc);
    },
    onSessionClose: (sessionId) => {
      cuaSessions.clear(sessionId);
      browserSessions.clear(sessionId);
      browserRouter.release(sessionId);
      void clearBrowserProfile(sessionId).catch((error) => {
        logger.app("plugin", "warn", "browser profile cleanup failed", {
          data: { error: error instanceof Error ? error.message : String(error) },
        });
      });
    },
    getFileRoots: async (sessionId) => {
      if (!sessionId) return projectFolderPaths(getWorkspacePath());
      const host = getHost();
      if (!host) throw new Error("Browser preview host is unavailable.");
      const res = await host.call<{ session: { projectPath?: string; worktree?: unknown } | null }>(
        "session.get", { id: sessionId, messageLimit: 1 },
      );
      if (!res?.session) throw new Error("Browser preview session is unavailable.");
      if (res.session.worktree) {
        const location = await host.call<{ path?: string }>("worktree.location", { sessionId });
        const path = location.path?.trim();
        if (!path) throw new Error("Browser preview worktree is unavailable.");
        return [path, join(dataDir, "scratch", sessionId)];
      }
      return [
        ...projectFolderPaths(res.session.projectPath?.trim() || null),
        join(dataDir, "scratch", sessionId),
      ];
    },
    getScratchDir: (sessionId) => {
      if (!sessionId) return null;
      return join(dataDir, "scratch", sessionId);
    },
    onState: emitBrowserState,
    onPresentationState: emitBrowserPresentationState,
    onRevealView: (sessionId, tabId, location) =>
      sendToRenderer(IPC.event.browserPreview, { sessionId, tabId, ...(location ?? { revealOnly: true }) }),
  });
  const bridgeTokenFile = join(dataDir, "extension-bridge-token");
  let bridgeToken = "";
  try {
    bridgeToken = readFileSync(bridgeTokenFile, "utf8").trim();
  } catch {
    // First run: the stable token is created below.
  }
  if (!bridgeToken) {
    bridgeToken = randomUUID();
    writeFileSync(bridgeTokenFile, bridgeToken, { mode: 0o600 });
  }
  const extensionBridge = new ExtensionBridgeServer(47123, bridgeToken);
  const nativeHostScript = [
    join(process.resourcesPath, "browser-native-host", "host.mjs"),
    join(app.getAppPath(), "resources", "browser-native-host", "host.mjs"),
    // Dev runs the app from a cached bundle under out/main; resources live in
    // the checkout next to it.
    fileURLToPath(new URL("../../resources/browser-native-host/host.mjs", import.meta.url)),
  ].find((candidate) => nativeHostScriptExists(candidate)) ?? join(process.resourcesPath, "browser-native-host", "host.mjs");
  const extensionDirs = [
    join(process.resourcesPath, "browser-extension"),
    join(app.getAppPath(), "resources", "browser-extension"),
    fileURLToPath(new URL("../../resources/browser-extension", import.meta.url)),
  ].filter((dir) => nativeHostScriptExists(join(dir, "manifest.json")));
  void extensionBridge
    .listen()
    .then(() => {
      if (!nativeHostScriptExists(nativeHostScript)) {
        logger.app("plugin", "warn", "browser native host script is missing", {
          data: { path: nativeHostScript },
        });
        return;
      }
      let registration: ReturnType<typeof registerBrowserNativeHost>;
      try {
        registration = registerBrowserNativeHost({
          dataDir,
          bridgeEndpoint: extensionBridge.nativeEndpoint,
          hostScriptPath: nativeHostScript,
          execPath: process.execPath,
          extensionPaths: extensionDirs,
        });
      } catch (error) {
        logger.app("plugin", "warn", "browser native host registration failed", {
          data: { error: error instanceof Error ? error.message : String(error) },
        });
        return;
      }
      if (!registration.supported) {
        logger.app("plugin", "info", "browser native host not registered", {
          data: { reason: registration.reason },
        });
        return;
      }
      if (registration.failures.length) {
        logger.app("plugin", "warn", "browser native host partially registered", {
          data: { failures: registration.failures },
        });
      }
      logger.app("plugin", "info", "browser native host registered", {
        data: { hostName: registration.hostName, manifests: registration.manifestPaths.length },
      });
    })
    .catch((error) => {
      logger.app("plugin", "warn", "extension bridge failed to listen", {
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    });
  browserRouter = new BrowserRouter(browserHost, extensionBridge);
  const browserService = createBrowserService(browserHost, browserRouter);
  browserService.chromeSettings = async () => {
    const settings = await getHost()?.call<AppSettings>("settings.get").catch(() => null);
    return settings?.browser ?? null;
  };
  const browserLifecycle = new TabLifecycle();
  const cuaSessions = new CuaSessions({
    router: browserRouter,
    getHost: () => getHost(),
    claims: browserLifecycle,
  });
  const readClipboard = async () => {
    const { clipboard } = await import("electron");
    return clipboard.readText();
  };
  const writeClipboard = async (value: string) => {
    const { clipboard } = await import("electron");
    clipboard.writeText(value);
    clipboardHistory.recordText(value);
  };
  const readClipboardImage = async () => {
    const { clipboard } = await import("electron");
    const image = clipboard.readImage();
    return image.isEmpty() ? null : image.toPNG().toString("base64");
  };
  const writeClipboardImage = async (data: string) => {
    const { clipboard, nativeImage } = await import("electron");
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(data, "base64")));
  };
  let cuaRuntimeRef: CuaRuntime | null = null;
  const browserSessions = new BrowserSessions({
    service: browserService,
    router: browserRouter,
    lifecycle: browserLifecycle,
    claimTab: async (sessionId, tabId) => {
      if (!cuaRuntimeRef) throw new Error("browser session registry is not ready");
      return cuaRuntimeRef.claimTab(sessionId, tabId);
    },
    releaseTab: (sessionId) => cuaRuntimeRef?.releaseTab(sessionId),
    isTabVisible: async (sessionId, tabId) => {
      const listed = await browserService.tabs({ action: "list" }, sessionId) as {
        tabs?: Array<{ tabId?: string; active?: boolean }>;
        activeTabId?: string;
      };
      return listed?.activeTabId === tabId || listed?.tabs?.some((tab) => tab.tabId === tabId && tab.active) === true;
    },
    setTabVisible: async (sessionId, tabId, visible) => {
      await browserService.tabs({ action: visible ? "show" : "select", tabId }, sessionId);
      browserHost.setGuestVisible(BROWSER_PLUGIN_ID, visible);
    },
    requestTakeover: (sessionId, reason) => {
      takeOver(sessionId);
      logger.app("plugin", "info", "browser.takeover.requested", {
        data: { sessionId, reason: reason ?? "other" },
      });
    },
    readClipboard,
    writeClipboard,
    readClipboardImage,
    writeClipboardImage,
  });
  const cuaRuntime = new CuaRuntime({
    sessions: cuaSessions,
    browser: browserService,
    browserSessions,
    getHost: () => getHost(),
    capture: captureGrantedWindow,
    readClipboard,
    writeClipboard,
    readClipboardImage,
    writeClipboardImage,
    confirmClaim: async (claim) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const result = await dialog.showMessageBox(window ?? undefined, {
        type: "question",
        buttons: ["Allow", "Deny"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: "Allow the agent to control this browser tab?",
        detail: [claim.title, claim.url, claim.tabId].filter(Boolean).join("\n"),
      });
      return result.response === 0;
    },
  });
  cuaRuntimeRef = cuaRuntime;
  browserRouter.onBackendStatus((sessionId, status) => {
    sendToRenderer(IPC.event.browserBackendStatus, { sessionId, status });
  });
  pluginViews.onSurface = (surface) => {
    browserHost.setChromeSurface(surface);
  };
  plugins.setServices({
    readRemoteWorkspaceFiles: createPluginWorkspaceReader({ getHost, getBoot: getActiveRemoteHostsBoot }),
    /**
     * The richer workspace payload, so `pi.workspace.get` and the
     * `workspace:changed` event both expose the open project's folder roots
     * (ADR 0263) instead of the bare primary path.
     */
    getWorkspaceInfo: (path = getWorkspacePath()) => pluginWorkspaceInfo(path),
    listProjects: createPluginProjectLister(getHost, (operation) => {
      logger.app("plugin", "warn", "plugin.projects.unavailable", {
        code: "HOST_UNAVAILABLE", data: { operation },
      });
    }),
    openInBrowser: async (fullPath) => {
      const preview = await browserHost.previewFile();
      if (!preview.ok) {
        throw Object.assign(new Error(preview.content), { code: "UNAVAILABLE" });
      }
      sendToRenderer(IPC.event.browserOpenFile, { path: fullPath });
    },
    /**
     * The project each live session belongs to, so an fs call made by one
     * session's tool follows that session instead of whichever project the
     * window happens to be showing (ADR 0016, D093). Cold for a session whose
     * runtime has not launched yet, which falls back to the visible workspace.
     */
    getWorkspacePathForSession: (sessionId) => sessionProjects.get(sessionId) ?? null,
    resolveSessionProjectPath: createPluginSessionProjectResolver(getHost),
    agentExtensionsChanged: () =>
      sendToRenderer(IPC.event.pluginChanged, { reason: "agentExtensions" }),
    /** `pi.session.getActive`: the selected session as the shell shows it. */
    getActiveSession: () => pluginSession.snapshot(),
    /**
     * The same project-scope check the view IPCs apply, so following a session
     * and revealing a view stay inside the project the plugin was activated in.
     */
    isPluginActiveInProject: (pluginId) => isPluginActiveInProject(pluginId),
    /**
     * #2377: the project-aware form backs the desktop.control session-read
     * gate, so a scoped plugin's `session/list` (including the reads a
     * background service makes) never crosses its activation scope.
     */
    pluginActiveInProject,
    /**
     * `pi.ui.revealView`: the runtime validated the view and the session; the
     * shell owns work-panel tabs, so it is the surface that opens the tab.
     */
    revealView: async ({ pluginId, viewId, sessionId, location }) => {
      sendToRenderer(IPC.event.pluginViewReveal, {
        pluginId,
        viewId,
        sessionId,
        ...(location ? { location } : {}),
      });
    },
    /**
     * `pi.composer.suggest`: the runtime already checked the permission and
     * shaped the text, and this only relays the offer to the shell that owns the
     * composer.
     */
    suggestComposer: (offer) => composerSuggestion.offer(offer),
    getComposerSuggestionTarget: (pluginId, input) => composerSuggestion.getTarget(pluginId, input),
    suggestComposerCandidates: (pluginId, input) => composerSuggestion.offerCandidates(pluginId, input),
    /** `pi.composer.clearSuggestion`: drop this plugin's own line. */
    clearComposerSuggestion: (pluginId, sessionId) =>
      composerSuggestion.clearSuggestion(pluginId, sessionId),
    browser: browserService,
    browserSessions,
    cua: cuaRuntime,
    onPluginUnload: (pluginId) => {
      if (pluginId === BROWSER_PLUGIN_ID) {
        browserRouter.dispose();
        browserHost.disposeGuest();
      }
      // A stopped plugin loses its line in the composer with it.
      composerSuggestion.clearPlugin(pluginId);
    },
  });
  const speech = createSpeechService({
    dataDir,
    getHost,
    plugins,
    logger,
  });
  return {
    setBrowserSettings: (browser: AppSettings["browser"] | null | undefined) => {
      browserSettingsCache.current = browser ?? null;
    },
    plugins,
    userMcp,
    mcpOAuth,
    pluginScopes,
    sessionProjects,
    emitBrowserState,
    announceTurnEnded,
    observePersistedUserMessage,
    readPluginModelContext: modelContext.read,
    announceObservedSession,
    pluginPanels,
    pluginViews,
    browserHost,
    browserRouter,
    browserSessions,
    cuaSessions,
    pluginSession,
    composerSuggestion,
    speech,
  };
}
