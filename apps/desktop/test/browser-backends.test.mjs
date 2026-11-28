import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";

const { BrowserBackendRegistry, BrowserRouter, CdpBrowserBackend, EmbeddedBrowserBackend, ExtensionBrowserBackend, McpBrowserBackend } = await import(
  "../electron/main/browser-backends.ts"
);

test("registry binds per session and returns embedded on unbind", () => {
  const registry = new BrowserBackendRegistry();
  const backend = new ExtensionBrowserBackend({ request: async () => ({}), close() {} });
  registry.bind("s1", backend, "tab-1");
  assert.equal(registry.binding("s1")?.tabId, "tab-1");
  registry.setTab("s1", "tab-2");
  assert.equal(registry.binding("s1")?.tabId, "tab-2");
  registry.unbind("s1");
  assert.equal(registry.binding("s1"), undefined);
  registry.dispose();
});

test("router defaults to embedded and rejects non-loopback endpoints", async () => {
  const router = new BrowserRouter({});
  const state = router.state("s1");
  assert.equal(state.kind, "embedded");
  assert.ok(state.capabilities.includes("upload"));
  await assert.rejects(
    router.connect({ kind: "cdp", endpoint: "http://example.com:9222" }, "s1"),
    /loopback/,
  );
  router.dispose();
});

test("embedded backend advertises the full existing surface", () => {
  const embedded = new EmbeddedBrowserBackend({}, "s1");
  assert.deepEqual(embedded.capabilities(), [
    "tabs", "navigate", "snapshot", "evaluate", "screenshot", "input", "click", "fill", "upload", "download", "frames", "locator",
  ]);
});

test("extension and MCP adapters expose only their declared capabilities", async () => {
  const extension = new ExtensionBrowserBackend({ request: async () => ({ tabs: [] }), close() {} });
  assert.deepEqual(extension.capabilities(), [
    "tabs", "navigate", "snapshot", "evaluate", "screenshot", "input", "click", "fill", "upload", "download", "frames", "locator",
  ]);
  const mcp = new McpBrowserBackend(async () => ({}));
  assert.deepEqual(mcp.capabilities(), ["tabs", "navigate", "snapshot", "evaluate", "screenshot", "click", "fill"]);
  await assert.rejects(mcp.page().input(), /not declared/);
});

test("extension backend does not close a bridge it does not own", () => {
  let closed = 0;
  const bridge = { request: async () => ({}), close() { closed += 1; } };
  const shared = new ExtensionBrowserBackend(bridge, "extension:in-app-bridge", { ownsBridge: false });
  shared.dispose();
  assert.equal(closed, 0, "in-app bridge must outlive the backend");
  new ExtensionBrowserBackend(bridge).dispose();
  assert.equal(closed, 1, "a client-owned bridge still closes");
});

test("CDP backend lists tabs and evaluates over a WebSocket", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/json/list") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: "tab-1", type: "page", url: "https://example.com", title: "Example", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/tab-1` }]));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.method === "Runtime.evaluate") {
        socket.send(JSON.stringify({ id: message.id, result: { result: { value: 2 } } }));
        return;
      }
      if (message.method === "Page.getLayoutMetrics") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, cssContentSize: { width: 1200, height: 1600 } },
        }));
        return;
      }
      if (message.method === "Page.captureScreenshot") {
        socket.send(JSON.stringify({ id: message.id, result: { data: "abc" } }));
        return;
      }
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const backend = new CdpBrowserBackend(endpoint);
  try {
    const tabs = await backend.listTabs();
    assert.equal(tabs[0].id, "tab-1");
    await backend.attach("tab-1");
    assert.equal(await backend.page("tab-1").evaluate("1+1"), 2);
    assert.ok(backend.capabilities().includes("upload"));
    assert.ok(backend.capabilities().includes("download"));
    const shot = await backend.page("tab-1").screenshot();
    assert.equal(shot.width, 800);
    assert.equal(shot.height, 600);
  } finally {
    backend.dispose();
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections?.();
    server.close();
  }
});
