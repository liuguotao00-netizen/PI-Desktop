export type PluginSandboxPolicy = {
  needsProcess: boolean;
  nodeExecArgv: string[];
  shellAccess: boolean;
  sandboxChildProcesses: boolean;
  allowImplicitProcesses: boolean;
  osSandbox: "sandbox-exec" | "none";
};

export const PROCESS_PERMISSIONS: readonly string[];
export const NO_PROCESS_EXEC_ARGV: readonly string[];
export function pluginSandboxPolicy(
  permissions: readonly string[],
  platform?: NodeJS.Platform,
): PluginSandboxPolicy;
