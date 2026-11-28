import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerDesktopExtension } = require('./extension.cjs');

// PI-Desktop loads this module inside the Agent sidecar and calls the default
// export with the host ExtensionAPI. Everything else lives in the shared
// CommonJS core so the Guard behaves the same outside this host.
export default function stopThatShitDesktopExtension(pi) {
  return registerDesktopExtension(pi);
}
