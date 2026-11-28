/**
 * One source of truth for the plugin sandbox decisions shared by the spawner
 * (`plugin-runtime.ts`) and the forked host (`plugin-host-process.mjs`).
 *
 * Keeping both sides on the same policy prevents the spawn flags from drifting
 * away from the process guard that enforces them.
 */

/** Permissions that legitimately need to create child processes. */
export const PROCESS_PERMISSIONS = Object.freeze(["system.process", "browser.launch"]);

/** Node Permission Model flags for a plugin that cannot spawn processes. */
export const NO_PROCESS_EXEC_ARGV = Object.freeze([
  "--permission",
  "--allow-fs-read=*",
  "--allow-fs-write=*",
  "--allow-worker",
]);

/**
 * @param {readonly string[]} permissions
 * @param {NodeJS.Platform} [platform]
 */
export function pluginSandboxPolicy(permissions, platform = process.platform) {
  const list = Array.isArray(permissions) ? permissions : [];
  const needsProcess = PROCESS_PERMISSIONS.some((permission) => list.includes(permission));
  return {
    needsProcess,
    nodeExecArgv: needsProcess ? [] : [...NO_PROCESS_EXEC_ARGV],
    shellAccess: list.includes("system.shell"),
    // Chrome launch plugins are excluded because Chrome's helper processes
    // must exec inside the bundle; they still go through the allowlist.
    sandboxChildProcesses: platform === "darwin" && !list.includes("browser.launch"),
    // Windows/Linux have no OS sandbox here, so never grant implicit exec
    // rights: a plugin must declare its processAllowlist explicitly.
    allowImplicitProcesses: platform === "darwin",
    osSandbox: platform === "darwin" ? "sandbox-exec" : "none",
  };
}
