'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { execFile } = require('node:child_process');

function within(file, root) {
  const r = path.relative(root, file);
  return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r));
}

async function resolveFile(input) {
  if (process.platform !== 'darwin') {
    throw Error('此插件仅支持 macOS 系统 / This plugin only supports macOS');
  }
  const active = await pi.session.getActive();
  if (!active) throw Error('请先打开文件所属会话 / Please open a session first');
  let p = String(input || '');
  if (p.startsWith('file:')) p = fileURLToPath(p);
  if (p.includes('\0')) throw Error('无效路径 / Invalid path');
  const roots = [
    active.projectPath,
    path.join(os.homedir(), '.pi-desktop', 'scratch', active.sessionId)
  ].filter(Boolean);
  if (!path.isAbsolute(p)) {
    if (!active.projectPath) throw Error('当前会话没有本地项目目录 / No active project directory');
    p = path.resolve(active.projectPath, p);
  }
  let real;
  try {
    real = await fs.realpath(p);
  } catch (e) {
    if (e.code !== 'ENOENT' || !/%[0-9a-f]{2}/i.test(p)) throw e;
    real = await fs.realpath(decodeURIComponent(p));
  }
  let allowed = false;
  for (const root of roots) {
    try {
      if (within(real, await fs.realpath(root))) allowed = true;
    } catch {}
  }
  if (!allowed) {
    throw Error('文件不在当前本地项目或会话附件目录；远程文件需要先下载 / File is outside the active local project or session scratch directory');
  }
  if (!(await fs.stat(real)).isFile()) {
    throw Error('请选择普通文件 / Target must be a regular file');
  }
  if (
    real.split(path.sep).some(s => s === '.ssh' || s === '.git' || /^\.env(?:\.|$)/.test(s)) ||
    /\.(pem|key|app|command|sh|exe|pkg|dmg|scpt|workflow)$/i.test(real)
  ) {
    throw Error('此文件类型不支持直接打开 / This file type is blocked for safety');
  }
  return real;
}

function native(action, file, app) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return Promise.reject(
      Error('当前内置原生助手仅编译了 macOS Apple Silicon (arm64) 版本 / Bundled native helper is compiled for macOS Apple Silicon (arm64) only')
    );
  }
  return new Promise((res, rej) =>
    execFile(
      path.join(__dirname, 'native-open'),
      [action, file, ...(app ? [app] : [])],
      { timeout: 20000, maxBuffer: 262144 },
      (e, out) => {
        if (e) return rej(Error('系统文件操作失败：' + e.message));
        try {
          const r = JSON.parse(out);
          if (r.ok === false) throw Error(r.error || '系统未能打开文件');
          res(r);
        } catch (x) {
          rej(x);
        }
      }
    )
  );
}

async function onRendererCall(method, args) {
  const file = await resolveFile(args?.path);
  if (method === 'file.copy') {
    const active = await pi.session.getActive();
    await pi.clipboard.writeText(
      args?.relative && active?.projectPath ? path.relative(active.projectPath, file) : file
    );
    return { ok: true };
  }
  if (method === 'file.info') return { ...(await native('info', file)), path: file };
  if (method === 'file.reveal') return native('reveal', file);
  if (method === 'file.open') return native('open', file, args?.app);
  throw Error('未知操作 / Unknown operation');
}

async function onLoad() {}

async function onUnload() {}

module.exports = {
  onLoad,
  onUnload,
  onRendererCall,
  _test: { within, resolveFile }
};
