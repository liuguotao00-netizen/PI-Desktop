/**
 * Compatibility barrel for the browser backend modules.
 *
 * New code imports from `./browser/*`; this file keeps existing imports and
 * tests stable while the implementation lives in focused modules.
 */
export type {
  BrowserBackendKind,
  BrowserCapability,
  BackendTab,
  SnapshotResult,
  ScreenshotResult,
  LocatorInput,
  LocatorMatch,
  BrowserPageOperations,
  BrowserBackend,
  BrowserBackendBinding,
} from "./browser/types.ts";
export { BrowserBackendRegistry } from "./browser/registry.ts";
export { CdpBrowserBackend } from "./browser/cdp.ts";
export {
  ExtensionBrowserBackend,
  WebSocketExtensionBridge,
  type ExtensionBridge,
} from "./browser/extension.ts";
export { McpBrowserBackend, McpHttpToolCaller, type McpToolCaller } from "./browser/mcp.ts";
export { EmbeddedBrowserBackend } from "./browser/embedded.ts";
export { createBrowserBackend, type ConnectBrowserBackendInput } from "./browser/factory.ts";
export { BrowserRouter } from "./browser/router.ts";
