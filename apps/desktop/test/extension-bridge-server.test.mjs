import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { ExtensionBridgeServer } from "../electron/main/browser/extension-server.ts";

test("bridge server forwards requests to the connected extension", async () => {
  const server = new ExtensionBridgeServer(0);
  await server.listen();
  const client = new WebSocket(server.endpoint, { origin: "chrome-extension://pi-desktop-test" });
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  client.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === "tabs.list") {
      client.send(JSON.stringify({ id: message.id, result: { tabs: [{ id: "1", url: "https://example.test", title: "Example" }] } }));
    }
  });
  const result = await server.request("tabs.list");
  assert.equal(result.tabs[0].title, "Example");
  client.close();
  server.close();
});

test("bridge server refuses requests without an extension", async () => {
  const server = new ExtensionBridgeServer(0, undefined, { clientWaitMs: 0 });
  await server.listen();
  await assert.rejects(() => server.request("tabs.list"), /not connected/);
  server.close();
});

test("bridge server waits briefly for an extension that is reconnecting", async () => {
  const server = new ExtensionBridgeServer(0, undefined, { clientWaitMs: 3_000 });
  await server.listen();
  const pending = server.request("tabs.list");
  const client = new WebSocket(server.endpoint, { origin: "chrome-extension://pi-desktop-test" });
  client.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    client.send(JSON.stringify({ id: message.id, result: { tabs: [{ id: "late", title: "Late" }] } }));
  });
  const result = await pending;
  assert.equal(result.tabs[0].id, "late");
  client.close();
  server.close();
});

test("bridge server closes clients with a wrong token", async () => {
  const server = new ExtensionBridgeServer(0, "expected-token");
  await server.listen();
  const endpoint = server.endpoint.replace(/token=[^&]+/, "token=wrong");
  const client = new WebSocket(endpoint, { origin: "chrome-extension://pi-desktop-test" });
  const [code, reason] = await new Promise((resolve) => client.once("close", (closeCode, closeReason) => resolve([closeCode, String(closeReason)])));
  assert.equal(code, 1008);
  assert.match(reason, /token/);
  server.close();
});

test("bridge server closes clients that are not extensions", async () => {
  const server = new ExtensionBridgeServer(0);
  await server.listen();
  const client = new WebSocket(server.endpoint, { origin: "http://localhost:5173" });
  const [code, reason] = await new Promise((resolve) => client.once("close", (closeCode, closeReason) => resolve([closeCode, String(closeReason)])));
  assert.equal(code, 1008);
  assert.match(reason, /origin/);
  server.close();
});

test("native host path accepts a token without an extension origin", async () => {
  const server = new ExtensionBridgeServer(0);
  await server.listen();
  const client = new WebSocket(server.nativeEndpoint);
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  client.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    client.send(JSON.stringify({ id: message.id, result: { tabs: [{ id: "native" }] } }));
  });
  const result = await server.request("tabs.list");
  assert.equal(result.tabs[0].id, "native");
  client.close();
  server.close();
});

test("native host path still rejects a wrong token", async () => {
  const server = new ExtensionBridgeServer(0, "expected-token");
  await server.listen();
  const client = new WebSocket(server.nativeEndpoint.replace(/token=[^&]+/, "token=wrong"));
  const [code] = await new Promise((resolve) => client.once("close", (closeCode) => resolve([closeCode])));
  assert.equal(code, 1008);
  server.close();
});
