import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ExtensionBridgeServer } from "../electron/main/browser/extension-server.ts";

const hostPath = fileURLToPath(new URL("../resources/browser-native-host/host.mjs", import.meta.url));

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function frameReader(stream) {
  let buffer = Buffer.alloc(0);
  const queue = [];
  const waiters = [];
  const flush = () => {
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      queue.push(JSON.parse(body.toString("utf8")));
      waiters.shift()?.();
    }
  };
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  });
  return () =>
    new Promise((resolve, reject) => {
      if (queue.length) {
        resolve(queue.shift());
        return;
      }
      const timer = setTimeout(() => reject(new Error("timed out waiting for host frame")), 8_000);
      waiters.push(() => {
        clearTimeout(timer);
        resolve(queue.shift());
      });
    });
}

test("native host relays bridge requests over chrome stdio framing", async () => {
  const server = new ExtensionBridgeServer(0);
  await server.listen();
  const child = spawn(process.execPath, [hostPath], {
    env: { ...process.env, PI_BROWSER_BRIDGE_URL: server.nativeEndpoint },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const readFrame = frameReader(child.stdout);
  try {
    const pending = server.request("tabs.list");
    const request = await readFrame();
    assert.equal(request.method, "tabs.list");
    assert.equal(typeof request.id, "number");
    child.stdin.write(frame({ id: request.id, result: { tabs: [{ id: "1", title: "Relay" }] } }));
    const result = await pending;
    assert.equal(result.tabs[0].title, "Relay");

    // Keepalive frames must stay inside the host, not reach the bridge.
    child.stdin.write(frame({ type: "ping" }));
    const evaluate = server.request("page.evaluate");
    const second = await readFrame();
    assert.equal(second.method, "page.evaluate");
    child.stdin.write(frame({ id: second.id, result: 42 }));
    assert.equal(await evaluate, 42);
  } finally {
    child.kill();
    server.close();
  }
  assert.equal(stderr.includes("dropping"), false, stderr);
});
