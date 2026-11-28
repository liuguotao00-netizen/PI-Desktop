"use strict";

/**
 * PI-Desktop plugin entry point.
 *
 * The host injects the plugin API as `globalThis.pi` and expects CommonJS
 * exports named `onLoad`, `onUnload` and `onPanelInvoke`. The Guard itself runs
 * in the Agent sidecar (see `contributes.agentExtensions`); this file only
 * bridges the palette command and the audit panel.
 */

const { createPanelBackend } = require("./src/desktop/panel.cjs");
const { installPromptTemplates } = require("./src/desktop/prompt-templates.cjs");

const COMMAND_ID = "sts.openpanel";
const PANEL_TITLE = "Stop That Shit";
// The work-panel view id declared in manifest.json `contributes.views`.
const VIEW_ID = "sts";

// The composer resolves `/name` from the host's prompt-template directory, and
// the manifest has no contribution for it. Writing the two templates on load is
// what makes `/stop-that-shit` and `/sts` available right after an install, and
// it is also how an upgrade refreshes a template whose shipped text changed: the
// text it displaces is kept once as a `.md.bak` copy.
const PROMPTS_DIR_ENV = "STS_DESKTOP_PROMPTS_DIR";

function installComposerTemplates(options = {}) {
  const dir = options.dir || process.env[PROMPTS_DIR_ENV] || undefined;
  const entries = installPromptTemplates(dir);
  for (const entry of entries) {
    if (entry.error) console.error(`[stop-that-shit] composer template not installed (${entry.file}): ${entry.error}`);
  }
  const written = entries.filter((entry) => entry.changed);
  if (written.length) {
    console.error(`[stop-that-shit] composer templates installed: ${written.map((entry) => entry.file).join(", ")}`);
  }
  return entries;
}

/** @type {ReturnType<typeof createPanelBackend> | null} */
let backend = null;

function host() {
  return /** @type {any} */ (globalThis).pi ?? null;
}

function backendFor(pi) {
  if (!backend) backend = createPanelBackend({ pi });
  return backend;
}

async function onLoad() {
  try {
    const pi = host();
    installComposerTemplates();
    backendFor(pi);
    const canReveal = typeof pi?.ui?.revealView === 'function';
    const canOpenPanel = typeof pi?.ui?.openPanel === 'function';
    // A view-only host still gets the command; the window is the fallback for a
    // host that cannot reveal a work-panel tab.
    if (!pi?.commands?.register || (!canReveal && !canOpenPanel)) return;
    await pi.commands.register({
      id: COMMAND_ID,
      title: "Stop That Shit: 打开面板 / open panel",
      keywords: ["sts", "stop that shit", "guard", "别再造史了", "任务边界"],
      run: async () => {
        if (canReveal) {
          try {
            await pi.ui.revealView({ viewId: VIEW_ID });
            return;
          } catch (error) {
            console.error(`[stop-that-shit] reveal view failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        try {
          await pi.ui.openPanel({ title: PANEL_TITLE });
        } catch (error) {
          console.error(`[stop-that-shit] open panel failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
  } catch (error) {
    console.error(`[stop-that-shit] load failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function onUnload() {
  try {
    await host()?.commands?.unregister?.(COMMAND_ID);
  } catch {
    // A command that cannot be removed must not block teardown.
  }
  backend = null;
}

/**
 * @param {string} channel
 * @param {unknown} payload
 */
async function onPanelInvoke(channel, payload) {
  try {
    return await backendFor(host()).invoke(String(channel), payload ?? {});
  } catch (error) {
    return {
      ok: false,
      code: "FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

module.exports = { installComposerTemplates, onLoad, onUnload, onPanelInvoke };
