"use strict";

/**
 * Plugin process: settings → config.json under ~/.pi/agent/user-profile/.
 * Profile files are written by the sidecar (Node fs). Host fs.write cannot
 * target that directory.
 */

const store = require("./src/memory-store.js");

function root() {
  return store.defaultRoot();
}

async function syncConfigFromSettings() {
  const settings = await pi.plugin.getSettings();
  store.ensureDir(root());
  store.saveConfig(root(), {
    enabled: settings.enabled !== false,
    userProfileEnabled: settings.userProfileEnabled !== false,
    memoryEnabled: settings.memoryEnabled !== false,
    userCharLimit: Number(settings.userCharLimit || store.DEFAULT_USER_LIMIT),
    memoryCharLimit: Number(settings.memoryCharLimit || store.DEFAULT_MEMORY_LIMIT),
    nudgeInterval: Number(settings.nudgeInterval || 10),
    memoryScope: settings.memoryScope === "project" ? "project" : "global",
    writeApproval: settings.writeApproval === "off" ? "off" : "notify",
  });
}

function statusText() {
  const cfg = store.loadConfig(root());
  const user = store.snapshot(root(), "user", cfg);
  const mem = store.snapshot(root(), "memory", cfg);
  return `user ${user.usageLabel} · memory ${mem.usageLabel} · ${cfg.enabled ? "on" : "off"}`;
}

async function onLoad() {
  await syncConfigFromSettings();

  await pi.commands.register({
    id: "user-profile.status",
    title: "User Profile: Status",
    keywords: ["memory", "profile", "user"],
    run: async () => {
      await pi.ui.showToast(statusText());
    },
  });

  if (pi.events && typeof pi.events.on === "function") {
    pi.events.on("plugin:settingsChanged", () => {
      void syncConfigFromSettings();
    });
  }
}

async function onUnload() {
  try {
    await pi.commands.unregister("user-profile.status");
  } catch {
    /* ignore */
  }
}

module.exports = { onLoad, onUnload };
