"use strict";

/**
 * 截图与屏幕信息。
 *
 * PNG 尺寸直接从文件头（IHDR）读，不引入任何图片库依赖：
 * 这样 plugin 不需要 node_modules，PluginCheck 也不会因为依赖告警。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buf) {
  return buf.length >= 24 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

/** 读 PNG 的宽高；不是 PNG 或读不出来时返回 null */
function pngSize(buf) {
  if (!isPng(buf)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function defaultOutDir(env = process.env) {
  if (env.PI_COMPUTER_USE_DIR) return env.PI_COMPUTER_USE_DIR;
  return path.join(os.tmpdir(), "pi-computer-use");
}

function shotPath(dir, label) {
  const safe = String(label || "shot").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `shot-${safe}-${stamp}.png`);
}

/** grim 的区域语法是 "x,y w*h" */
function grimGeometry(region) {
  return `${region.x},${region.y} ${region.width}x${region.height}`;
}

function planScreenshot(backend, outPath, region) {
  if (backend.kind === "grim") {
    const argv = [backend.bin];
    if (region) argv.push("-g", grimGeometry(region));
    argv.push(outPath);
    return argv;
  }
  if (backend.kind === "import") {
    // import -window root 抓整个 X11 根窗口
    if (region) {
      return [backend.bin, "-window", "root", "-crop", `${region.width}x${region.height}+${region.x}+${region.y}`, "+repage", outPath];
    }
    return [backend.bin, "-window", "root", outPath];
  }
  if (backend.kind === "scrot") {
    return [backend.bin, "--overwrite", outPath];
  }
  return null;
}

function clampRegion(region, bounds) {
  if (!region) return null;
  const nums = ["x", "y", "width", "height"];
  for (const k of nums) {
    if (!Number.isInteger(region[k])) {
      const err = new Error(`region.${k} 必须是整数`);
      err.field = `region.${k}`;
      throw err;
    }
  }
  const x = Math.max(0, region.x);
  const y = Math.max(0, region.y);
  const width = Math.max(1, region.width);
  const height = Math.max(1, region.height);
  if (bounds && bounds.width > 0) {
    if (x >= bounds.width || y >= bounds.height) {
      const err = new Error(
        `region 起点 (${x}, ${y}) 超出屏幕范围 ${bounds.width}x${bounds.height}`
      );
      err.field = "region";
      throw err;
    }
  }
  const out = { x, y, width, height };
  if (bounds && bounds.width > 0) {
    out.width = Math.min(width, bounds.width - x);
    out.height = Math.min(height, bounds.height - y);
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * 屏幕尺寸。通用做法：用截图后端拍一张，读 PNG 头，再删掉。
 * 不依赖 xrandr / wlr-randr / swaymsg / niri，任何能截图的会话都能用。
 */
function probeScreenSize(backend, run, options = {}) {
  const dir = options.dir || defaultOutDir();
  ensureDir(dir);
  const tmp = path.join(dir, `.probe-${process.pid}-${Date.now()}.png`);
  const argv = planScreenshot(backend, tmp, null);
  try {
    const res = run(argv, options);
    if (!res.ok) return { ok: false, error: res };
    const buf = fs.readFileSync(tmp);
    const size = pngSize(buf);
    return size ? { ok: true, size } : { ok: false, error: { message: "截图不是 PNG" } };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 忽略：探测文件删不掉不影响结果 */
    }
  }
}

function readPngBase64(filePath) {
  const buf = fs.readFileSync(filePath);
  if (!isPng(buf)) return null;
  return { data: buf.toString("base64"), mimeType: "image/png", bytes: buf.length, size: pngSize(buf) };
}

module.exports = {
  PNG_MAGIC,
  isPng,
  pngSize,
  defaultOutDir,
  shotPath,
  planScreenshot,
  grimGeometry,
  clampRegion,
  ensureDir,
  fileSize,
  probeScreenSize,
  readPngBase64,
};
