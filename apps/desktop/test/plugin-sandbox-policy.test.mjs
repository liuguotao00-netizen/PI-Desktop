import assert from "node:assert/strict";
import test from "node:test";
import { pluginSandboxPolicy } from "../electron/main/plugin-sandbox-policy.mjs";

test("plugins without process permission use the Node permission model", () => {
  const policy = pluginSandboxPolicy([], "darwin");
  assert.equal(policy.needsProcess, false);
  assert.deepEqual(policy.nodeExecArgv, [
    "--permission",
    "--allow-fs-read=*",
    "--allow-fs-write=*",
    "--allow-worker",
  ]);
  assert.equal(policy.sandboxChildProcesses, true);
});

test("system.process opts into child processes and drops implicit executables off macOS", () => {
  const mac = pluginSandboxPolicy(["system.process"], "darwin");
  assert.equal(mac.needsProcess, true);
  assert.equal(mac.allowImplicitProcesses, true);
  assert.equal(mac.sandboxChildProcesses, true);

  const linux = pluginSandboxPolicy(["system.process"], "linux");
  assert.equal(linux.nodeExecArgv.length, 0);
  assert.equal(linux.allowImplicitProcesses, false);
  assert.equal(linux.osSandbox, "none");
});

test("browser.launch is not wrapped by sandbox-exec and shell needs system.shell", () => {
  const policy = pluginSandboxPolicy(["browser.launch"], "darwin");
  assert.equal(policy.sandboxChildProcesses, false);
  assert.equal(policy.shellAccess, false);
  assert.equal(pluginSandboxPolicy(["system.shell"], "linux").shellAccess, true);
});
