#!/usr/bin/env node
/**
 * Chrome native messaging host for the PI-Desktop browser bridge.
 *
 * Chrome launches this process (via the launcher script written by the app)
 * when the extension calls chrome.runtime.connectNative, and frames messages
 * on stdin/stdout with a 4-byte little-endian length prefix. This host relays
 * those frames to the app's loopback bridge, so the extension never needs a
 * URL or token.
 *
 * stderr is diagnostic only and never reaches the extension.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOST_NAME = "com.pi.desktop.browser";
const DEFAULT_PORT = 47123;
const DEFAULT_PATH = "/pi-browser-native";
/** Chrome caps host→browser messages at 1 MB; browser→host may be much larger. */
const WRITE_LIMIT = 1024 * 1024;
const READ_LIMIT = 256 * 1024 * 1024;

function log(message) {
  process.stderr.write(`[pi-browser-host] ${message}\n`);
}

function bridgeUrl() {
  const baked = process.env.PI_BROWSER_BRIDGE_URL;
  if (baked) return baked;
  const dataDir = process.env.PI_DESKTOP_DATA_DIR;
  if (!dataDir) throw new Error("PI_BROWSER_BRIDGE_URL and PI_DESKTOP_DATA_DIR are both unset");
  const token = readFileSync(join(dataDir, "extension-bridge-token"), "utf8").trim();
  if (!token) throw new Error("extension bridge token file is empty");
  return `ws://127.0.0.1:${DEFAULT_PORT}${DEFAULT_PATH}?token=${encodeURIComponent(token)}`;
}

function writeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > WRITE_LIMIT) {
    log(`dropping oversized message (${body.length} bytes)`);
    return;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let buffered = Buffer.alloc(0);
function readFrames(chunk, onMessage) {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32LE(0);
    if (length > READ_LIMIT) {
      log(`invalid frame length ${length}`);
      process.exit(1);
    }
    if (buffered.length < 4 + length) return;
    const body = buffered.subarray(4, 4 + length);
    buffered = buffered.subarray(4 + length);
    let message;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      log("dropping non-JSON frame");
      continue;
    }
    onMessage(message);
  }
}

async function main() {
  const url = bridgeUrl();
  const socket = new WebSocket(url);

  const closed = () => {
    log("bridge connection closed");
    process.exit(0);
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge connect timed out")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(`bridge connect failed: ${event?.message ?? "websocket error"}`));
    }, { once: true });
  });

  socket.addEventListener("close", closed);
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message?.id !== "number") return;
    writeFrame(message);
  });

  process.stdin.on("data", (chunk) => {
    readFrames(chunk, (message) => {
      // Keepalive pings from the extension only keep the MV3 worker alive.
      if (message?.type === "ping") return;
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(message));
    });
  });
  process.stdin.on("end", closed);
  process.stdin.on("error", (error) => {
    log(`stdin error: ${error.message}`);
    process.exit(1);
  });

  log(`connected to bridge as ${HOST_NAME}`);
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
