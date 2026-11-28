import type { BrowserBackend } from "./types.ts";
import type { ExtensionBridge } from "./extension.ts";
import { CdpBrowserBackend } from "./cdp.ts";
import { ExtensionBrowserBackend, WebSocketExtensionBridge } from "./extension.ts";
import { McpBrowserBackend, McpHttpToolCaller } from "./mcp.ts";

export type ConnectBrowserBackendInput = {
  kind?: string;
  endpoint?: string;
  tabId?: string;
  url?: string;
  downloadDir?: string;
  launch?: boolean;
  chromePath?: string;
  userDataDir?: string;
  headless?: boolean;
  chromeArgs?: string[];
  extensionBridge?: ExtensionBridge;
};

/** Build one external backend after validating its loopback endpoint. */
export function createBrowserBackend(input: ConnectBrowserBackendInput): BrowserBackend {
  const kind = String(input.kind || "cdp");
  let endpoint: URL;
  try {
    endpoint = new URL(String(input.endpoint || "").trim());
  } catch {
    throw new Error("browser backend endpoint must be a full URL");
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(endpoint.hostname)) {
    throw new Error("browser backend endpoint must be loopback");
  }
  if (kind === "cdp") {
    if (endpoint.protocol !== "http:") throw new Error("CDP endpoint must be http://127.0.0.1:<port>");
    const launch = input.launch
      ? {
          port: Number(endpoint.port || 80),
          ...(input.chromePath ? { chromePath: input.chromePath } : {}),
          ...(input.userDataDir ? { userDataDir: input.userDataDir } : {}),
          ...(input.headless === true ? { headless: true } : {}),
          ...(Array.isArray(input.chromeArgs) ? { args: input.chromeArgs } : {}),
        }
      : undefined;
    return new CdpBrowserBackend(endpoint.origin, input.downloadDir, `cdp:${endpoint.origin}`, launch);
  }
  if (kind === "extension") {
    const downloadDir = input.downloadDir;
    if (input.extensionBridge) {
      // The in-app bridge is owned by the app, not by this backend.
      return new ExtensionBrowserBackend(input.extensionBridge, "extension:in-app-bridge", {
        ownsBridge: false,
        ...(downloadDir ? { downloadDir } : {}),
      });
    }
    if (endpoint.protocol !== "ws:") throw new Error("extension endpoint must be ws://127.0.0.1:<port>");
    return new ExtensionBrowserBackend(
      new WebSocketExtensionBridge(endpoint.toString()),
      `extension:${endpoint.origin}`,
      downloadDir ? { downloadDir } : {},
    );
  }
  if (kind === "mcp") {
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("MCP endpoint must be http(s)");
    }
    const caller = new McpHttpToolCaller(endpoint.toString());
    return new McpBrowserBackend(
      (name, args) => caller.callTool(name, args),
      "mcp",
      `mcp:${endpoint.origin}`,
      "mcp",
      caller,
    );
  }
  throw new Error(`unknown browser backend: ${kind}`);
}
