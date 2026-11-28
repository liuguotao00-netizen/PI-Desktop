/**
 * The `pi.*` object exposed to a plugin module. Transport, permission checks and
 * service ownership stay in plugin-host-process; this module only builds the
 * call surface around the injected `call` bridge.
 */
export function createPluginApi({
  call,
  commands,
  tools,
  speechHandles,
  services,
  busHandlers,
  eventListeners,
  pluginId,
  manifest,
  normalizeBytes,
  normalizeClipboardHistory,
  audioUnavailable,
}) {
  return {
    app: {
      getVersion: () => call("app.getVersion"),
      getLocale: () => call("app.getLocale"),
      getAppearance: () => call("app.getAppearance"),
      getCapabilities: () => call("app.getCapabilities"),
      setTheme: (themeId) => call("app.setTheme", [themeId]),
    },
    themes: {
      upsert: (input) => call("themes.upsert", [input]),
      remove: (themeId) => call("themes.remove", [themeId]),
      list: () => call("themes.list"),
      setVariables: (themeId, values) => call("themes.setVariables", [themeId, values]),
    },
    plugin: {
      getId: () => pluginId,
      getManifest: () => manifest,
      getSettings: () => call("plugin.getSettings"),
      setSettings: (partial) => call("plugin.setSettings", [partial]),
      getDataPath: () => call("plugin.getDataPath"),
    },
    commands: {
      register: async (command) => {
        if (!command || typeof command.id !== "string" || !command.id) {
          throw new Error("command.id is required");
        }
        if (typeof command.run !== "function") {
          throw new Error("command.run must be a function");
        }
        commands.set(command.id, command.run);
        try {
          await call("commands.register", [
            {
              id: command.id,
              title: command.title,
              keywords: command.keywords,
              category: command.category,
            },
          ]);
        } catch (error) {
          commands.delete(command.id);
          throw error;
        }
      },
      unregister: async (id) => {
        commands.delete(id);
        await call("commands.unregister", [id]);
      },
    },
    speech: {
      registerAdapter: async (adapter) => {
        if (!adapter || typeof adapter.protocol !== "string" || !adapter.protocol.trim()) {
          throw new Error("speech protocol is required");
        }
        if (typeof adapter.handle !== "function") {
          throw new Error("speech handle must be a function");
        }
        const protocol = adapter.protocol.trim();
        const roles = Array.isArray(adapter.roles) ? adapter.roles : [];
        speechHandles.set(protocol, adapter.handle);
        try {
          await call("speech.registerAdapter", [
            {
              protocol,
              label: adapter.label,
              roles,
            },
          ]);
        } catch (error) {
          speechHandles.delete(protocol);
          throw error;
        }
      },
      unregisterAdapter: async (protocol) => {
        speechHandles.delete(String(protocol ?? ""));
        await call("speech.unregisterAdapter", [protocol]);
      },
    },
    ui: {
      openPanel: (options) => call("ui.openPanel", [options]),
      closePanel: () => call("ui.closePanel"),
      showToast: (message, level) => call("ui.showToast", [message, level]),
      // The work panel is the shell's own surface: the plugin names one of its
      // declared views and the subject, and the main process refuses a session
      // that stopped being the one the user is looking at.
      revealView: (input) => call("ui.revealView", [input ?? {}]),
      notify: (input) => call("ui.notify", [input]),
      getNotificationPermission: () => call("ui.getNotificationPermission"),
      requestNotificationPermission: () => call("ui.requestNotificationPermission"),
      showNativeNotification: (input) => call("ui.showNativeNotification", [input]),
    },
    // One line into the session's composer placeholder (ADR 0333). The shell
    // answers whether it went on screen, so a plugin never has to guess before
    // spending another completion.
    composer: {
      suggest: (input) => call("composer.suggest", [input ?? {}]),
      getSuggestionTarget: (input) => call("composer.getSuggestionTarget", [input]),
      suggestCandidates: (input) => call("composer.suggestCandidates", [input]),
      clearSuggestion: (input) => call("composer.clearSuggestion", [input ?? {}]),
    },
    project: {
      create: (input) => call("project.create", [input ?? {}]),
    },
    providers: {
      oauth: {
        prompt: (loginId, input) => call("providers.oauth.prompt", [loginId, input]),
        notify: (loginId, event) => call("providers.oauth.notify", [loginId, event]),
      },
    },
    workspace: {
      get: () => call("workspace.get"),
    },
    projects: {
      list: () => call("projects.list"),
    },
    desktop: {
      listOperations: () => call("desktop.listOperations"),
      invoke: (input) => call("desktop.invoke", [input ?? {}]),
    },
    fs: {
      readText: (path) => call("fs.readText", [path]),
      stat: (path, grantId) => call("fs.stat", [path, grantId]),
      readRange: (path, byteOffset, length, grantId) =>
        call("fs.readRange", [path, byteOffset, length, grantId]).then((result) => ({
          ...result,
          bytes: normalizeBytes(result?.bytes),
        })),
      readPreview: (path, options) => call("fs.readPreview", options === undefined ? [path] : [path, options]),
      openDefault: (path) => call("fs.openDefault", [path]),
      openInBrowser: (path) => call("fs.openInBrowser", [path]),
      reveal: (path) => call("fs.reveal", [path]),
      writeText: (path, content) => call("fs.writeText", [path, content]),
      glob: (pattern) => call("fs.glob", [pattern]),
      list: (path, options) => call("fs.list", options === undefined ? [path] : [path, options]),
      remove: (path) => call("fs.remove", [path]),
      requestDirectory: () => call("fs.requestDirectory"),
    },
    agent: {
      registerTool: async (tool) => {
        if (!tool || typeof tool.name !== "string" || !tool.name) {
          throw new Error("tool.name is required");
        }
        if (typeof tool.execute !== "function") {
          throw new Error("tool.execute must be a function");
        }
        tools.set(tool.name, tool.execute);
        try {
          await call("agent.registerTool", [
            {
              name: tool.name,
              description: tool.description,
              risk: tool.risk,
              schema: tool.schema,
            },
          ]);
        } catch (error) {
          tools.delete(tool.name);
          throw error;
        }
      },
      unregisterTool: async (name) => {
        tools.delete(name);
        await call("agent.unregisterTool", [name]);
      },
      complete: (input) => call("agent.complete", [input ?? {}]),
    },
    models: {
      list: () => call("models.list"),
    },
    session: {
      // The selected session, as the shell shows it. A snapshot is a value: a
      // plugin compares `sessionId` rather than assuming the session still holds.
      getActive: () => call("session.getActive"),
      getLlmContext: () => call("session.getLlmContext"),
      getAutoTitleContext: (input) => call("session.getAutoTitleContext", [input ?? {}]),
      setAutoTitle: (input) => call("session.setAutoTitle", [input ?? {}]),
      list: (input) => call("session.list", [input ?? {}]),
      get: (input) => call("session.get", [input ?? {}]),
      listMessages: (input) => call("session.listMessages", [input ?? {}]),
      import: (input) => call("session.import", [input ?? {}]),
      importBatch: (input) => call("session.importBatch", [input ?? {}]),
      rename: (input) => call("session.rename", [input ?? {}]),
      delete: (input) => call("session.delete", [input ?? {}]),
      // Message-level writes (`session.update.all` / `session.delete.all`, ADR
      // 0339). The plugin supplies no scope: the main-process gateway derives it
      // from the granted permissions.
      appendMessage: (input) => call("session.appendMessage", [input ?? {}]),
      replaceMessages: (input) => call("session.replaceMessages", [input ?? {}]),
      deleteMessage: (input) => call("session.deleteMessage", [input ?? {}]),
      truncateFrom: (input) => call("session.truncateFrom", [input ?? {}]),
    },
    // Read-only usage facts (`usage.read`). The main-process dispatch owns
    // the permission check and parameter bounds; the host returns per-turn
    // counters and identifiers only, so no message body crosses this bridge.
    usage: {
      listTurns: (input) => call("usage.listTurns", [input ?? {}]),
    },
    /**
     * Resident background workers (spec 07 §3). Registration is local: the
     * manifest already declared the service, and the broker starts it only when
     * `background.service` was granted — so a plugin that registers without the
     * permission simply never runs.
     */
    services: {
      register: (service) => {
        if (!service || typeof service.id !== "string" || !service.id) {
          throw new Error("service.id is required");
        }
        if (typeof service.start !== "function") {
          throw new Error("service.start must be a function");
        }
        services.set(service.id, {
          start: service.start,
          stop: typeof service.stop === "function" ? service.stop : undefined,
          running: false,
        });
      },
      unregister: async (id) => {
        const entry = services.get(String(id ?? ""));
        services.delete(String(id ?? ""));
        if (entry?.running && entry.stop) await entry.stop();
      },
    },
    /**
     * Inter-plugin message bus (spec 07 §3). Topics must be declared in
     * `contributes.bus`; the broker owns the routing table, so this side only
     * keeps the handler for each subscription it was given.
     */
    bus: {
      publish: (topic, payload) => call("bus.publish", [topic, payload]),
      subscribe: async (topic, handler) => {
        if (typeof handler !== "function") {
          throw new Error("bus.subscribe handler must be a function");
        }
        const result = await call("bus.subscribe", [topic]);
        const id = String(result?.subscriptionId ?? "");
        busHandlers.set(id, handler);
        return async () => {
          busHandlers.delete(id);
          await call("bus.unsubscribe", [id]);
        };
      },
    },
    clipboard: {
      readText: () => call("clipboard.readText"),
      writeText: (text) => call("clipboard.writeText", [text]),
      getHistory: () => call("clipboard.getHistory").then(normalizeClipboardHistory),
    },
    shell: {
      openExternal: (url) => call("shell.openExternal", [url]),
    },
    browser: {
      reveal: (input) => call("browser.reveal", [input ?? {}]),
      navigate: (input) => call("browser.navigate", [input ?? {}]),
      action: (input) => call("browser.action", [input]),
      setBounds: (hole) => call("browser.setBounds", [hole]),
      setVisible: (visible) => call("browser.setVisible", [visible]),
      getState: () => call("browser.getState"),
      openExternal: () => call("browser.openExternal"),
      snapshot: () => call("browser.snapshot"),
      history: () => call("browser.history"),
      screenshot: (input) => call("browser.screenshot", [input ?? {}]),
      click: (input) => call("browser.click", [input]),
      uploadFiles: (input) => call("browser.uploadFiles", [input ?? {}]),
      waitForFileChooser: (input) => call("browser.waitForFileChooser", [input ?? {}]),
      waitForDownload: (input) => call("browser.waitForDownload", [input ?? {}]),
      setFileChooserFiles: (input) => call("browser.setFileChooserFiles", [input ?? {}]),
      cancelFileChooser: (input) => call("browser.cancelFileChooser", [input ?? {}]),
      downloads: (input) => call("browser.downloads", [input ?? {}]),
      cancelDownload: (input) => call("browser.cancelDownload", [input]),
      networkIdle: (input) => call("browser.networkIdle", [input ?? {}]),
      downloadUrl: (input) => call("browser.downloadUrl", [input ?? {}]),
      clickAndWaitForDownload: (input) => call("browser.clickAndWaitForDownload", [input ?? {}]),
      crossOriginFrame: (input) => call("browser.crossOriginFrame", [input ?? {}]),
      fill: (input) => call("browser.fill", [input]),
      locator: (input) => call("browser.locator", [input ?? {}]),
      domAction: (input) => call("browser.domAction", [input ?? {}]),
      catalog: () => call("browser.catalog"),
      getJsDialog: (input) => call("browser.getJsDialog", [input ?? {}]),
      chromeSettings: () => call("browser.chromeSettings"),
      evaluate: (input) => call("browser.evaluate", [input]),
      evaluateNative: (input) => call("browser.evaluateNative", [input ?? {}]),
      evaluateIsolated: (input) => call("browser.evaluateIsolated", [input ?? {}]),
      inputEvent: (input) => call("browser.inputEvent", [input ?? {}]),
      insertText: (input) => call("browser.insertText", [input ?? {}]),
      handleDialog: (input) => call("browser.handleDialog", [input ?? {}]),
      consoleLogs: (input) => call("browser.consoleLogs", [input ?? {}]),
      networkRequests: (input) => call("browser.networkRequests", [input ?? {}]),
      console: (input) => call("browser.console", [input ?? {}]),
      cdp: (input) => call("browser.cdp", [input]),
      input: (input) => call("browser.input", [input]),
      tabs: (input) => call("browser.tabs", [input]),
      capabilities: (input) => call("browser.capabilities", [input ?? {}]),
      capability: (input) => call("browser.capability", [input ?? {}]),
      markTab: (input) => call("browser.markTab", [input ?? {}]),
      sessionState: () => call("browser.sessionState"),
      claimTab: (input) => call("browser.claimTab", [input ?? {}]),
      releaseTab: () => call("browser.releaseTab"),
      screenshotState: () => call("browser.screenshotState"),
      lock: () => call("browser.lock"),
      unlock: () => call("browser.unlock"),
      connectBackend: (input) => call("browser.connectBackend", [input ?? {}]),
      disconnectBackend: (input) => call("browser.disconnectBackend", [input ?? {}]),
      backendState: (input) => call("browser.backendState", [input ?? {}]),
      backendHealth: (input) => call("browser.backendHealth", [input ?? {}]),
    },
    net: {
      getCapabilities: () => call("net.getCapabilities"),
      fetch: (input) => call("net.fetch", [input]),
      // Real-time connections (`net.websocket`). Frames arrive back as
      // `net:websocket:message` host events, so a plugin subscribes with
      // `pi.events.on` exactly as it does for any other host event.
      websocket: {
        connect: (input) => call("net.websocket.connect", [input ?? {}]),
        send: (input) => call("net.websocket.send", [input ?? {}]),
        close: (input) => call("net.websocket.close", [input ?? {}]),
      },
    },
    /**
     * Background audio (`audio.capture.background`, `audio.playback.background`).
     * The host has no device backend yet, so the async calls travel to the
     * broker and come back as a coded `UNSUPPORTED` refusal — a plugin can
     * branch on `error.code` instead of catching a TypeError. The two
     * registration helpers are synchronous by contract and cannot reject, so
     * they throw the same refusal immediately rather than registering a handler
     * that could never fire.
     */
    audio: {
      getInputDevices: () => call("audio.getInputDevices"),
      openInput: (options) => call("audio.openInput", [options ?? {}]),
      closeInput: (streamId) => call("audio.closeInput", [streamId]),
      getCaptureState: () => call("audio.getCaptureState"),
      onInputFrame: () => {
        throw audioUnavailable("audio.onInputFrame");
      },
      offInputFrame: () => {
        throw audioUnavailable("audio.offInputFrame");
      },
      openOutput: (options) => call("audio.openOutput", [options ?? {}]),
      writeOutput: (input) => call("audio.writeOutput", [input ?? {}]),
      stopOutput: (streamId) => call("audio.stopOutput", [streamId]),
      closeOutput: (streamId) => call("audio.closeOutput", [streamId]),
    },
    // System-wide accelerators. The arrow handlers live in the host: this
    // object only carries requests across the boundary.
    keyboard: {
      registerGlobalShortcut: (input) => call("keyboard.registerGlobalShortcut", [input]),
      unregisterGlobalShortcut: (id) => call("keyboard.unregisterGlobalShortcut", [id]),
      listGlobalShortcuts: () => call("keyboard.listGlobalShortcuts"),
    },
    cua: {
      state: () => call("cua.state"),
      bind: (input) => call("cua.bind", [input ?? {}]),
      clear: () => call("cua.clear"),
      app: (input) => call("cua.app", [input ?? {}]),
      browser: (input) => call("cua.browser", [input ?? {}]),
      createTab: (input) => call("cua.createTab", [input ?? {}]),
      capture: (input) => call("cua.capture", [input ?? {}]),
      claimTab: (input) => call("cua.claimTab", [input ?? {}]),
      releaseTab: () => call("cua.releaseTab"),
      act: (input) => call("cua.act", [input ?? {}]),
      browsers: () => call("cua.browsers"),
      session: () => call("cua.session"),
      sessionInvoke: (input) => call("cua.sessionInvoke", [input ?? {}]),
    },
    // Fed by the parent's `event` frames; bus deliveries also arrive as
    // `bus.message` here, so a plugin can watch the raw stream if it wants to.
    events: {
      on: (event, handler) => {
        if (typeof handler !== "function") return;
        const listeners = eventListeners.get(event) ?? new Set();
        listeners.add(handler);
        eventListeners.set(event, listeners);
      },
      off: (event, handler) => {
        eventListeners.get(event)?.delete(handler);
      },
    },
  };
}
