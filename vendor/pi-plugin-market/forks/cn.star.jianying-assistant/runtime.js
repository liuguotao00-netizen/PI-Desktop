'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { normalizeTimeline, validateTitle } = require('./timeline');
const { inside, localPath, noLinks, directory, mkdirSafe, regularFile, mediaPath, treeNoLinks } = require('./path-safety');
const { ProcessRunner, MAX_OUTPUT } = require('./process-runner');

const PACKAGE = 'pyJianYingDraft==0.3.0';
const PYTHON_INFO = 'import sys,json; print(json.dumps({"version":list(sys.version_info[:3]),"executable":sys.executable}))';
const VENV_INFO = 'import sys,json,importlib.metadata,pyJianYingDraft; from pymediainfo import MediaInfo; assert MediaInfo.can_parse(), "MediaInfo runtime unavailable"; print(json.dumps({"version":importlib.metadata.version("pyJianYingDraft"),"prefix":sys.prefix,"isolated":sys.prefix!=sys.base_prefix}))';
const IMPORT_WARNING = '必要时重启剪映刷新草稿；素材为原文件绝对路径';
const numericSort = (a, b) => b.localeCompare(a, undefined, { numeric: true });

function envValue(env, name) {
  const key = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function directoryHint(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return '';
  try { return localPath(value); } catch { return ''; }
}

function systemHome() {
  // userInfo uses the OS account, unlike homedir's environment override.
  try {
    const home = directoryHint(os.userInfo().homedir);
    if (home) return home;
  } catch { /* Account lookup may be unavailable; try Node's platform fallback. */ }
  return directoryHint(os.homedir());
}

function userDirectories(env = process.env, { platform = process.platform, getHome = systemHome } = {}) {
  const home = directoryHint(envValue(env, 'HOME'));
  const profile = directoryHint(envValue(env, 'USERPROFILE'));
  const fallback = (platform === 'win32' ? profile || home : home) || directoryHint(getHome());
  const directories = {};
  if (home || fallback) directories.HOME = home || fallback;
  if (platform === 'win32') {
    if (profile || fallback) directories.USERPROFILE = profile || fallback;
    for (const [name, child] of [['APPDATA', 'Roaming'], ['LOCALAPPDATA', 'Local']]) {
      const value = directoryHint(envValue(env, name)) || (fallback && path.join(fallback, 'AppData', child));
      if (value) directories[name] = value;
    }
  } else {
    // Preserve explicit hints, but never derive Windows paths on other platforms.
    for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      const value = directoryHint(envValue(env, name));
      if (value) directories[name] = value;
    }
  }
  return directories;
}

function payload(value, allowed = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Payload must be an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown payload field: ${key}`);
}
function json(text, label) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_OUTPUT) throw new Error(`${label} exceeds 2MB or is not text`);
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${label} must be a single JSON object`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}
async function readJson(file) {
  const stat = await regularFile(file);
  if (stat.size > MAX_OUTPUT) throw new Error('JSON file exceeds 2MB');
  return json(await fs.readFile(file, 'utf8'), file);
}
async function children(root) {
  try {
    await directory(root);
    return (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name).sort(numericSort);
  } catch { return []; }
}

class JianyingRuntime {
  constructor({ getSettings, getWorkspace, runner, env = process.env, getHome = systemHome } = {}) {
    if (typeof getSettings !== 'function' || typeof getWorkspace !== 'function') throw new Error('getSettings and getWorkspace are required');
    this.getSettings = getSettings;
    this.getWorkspace = getWorkspace;
    this.env = env;
    this.getHome = getHome;
    // Injection replaces only process execution; filesystem and protocol checks still run.
    this.processes = new ProcessRunner();
    this.runner = runner;
    this.busy = false;
    this.disposed = false;
    this.launches = new Set();
  }

  async _exclusive(fn) {
    if (this.disposed || this.processes.disposed) throw new Error('Runtime is disposed');
    if (this.busy) throw new Error('Runtime is busy; wait for the current operation');
    this.busy = true;
    const operation = Promise.resolve().then(fn);
    this.activeOperation = operation;
    try { return await operation; } finally { this.busy = false; this.activeOperation = null; }
  }

  async _context() {
    const settings = await this.getSettings();
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Settings must be an object');
    for (const name of ['pythonPath', 'draftRoot', 'jianyingPath', 'workDir']) {
      if (settings[name] !== undefined && typeof settings[name] !== 'string') throw new Error(`${name} must be a string`);
    }
    const workspaceValue = await this.getWorkspace();
    localPath(workspaceValue, 'workspace');
    const workspace = path.resolve(workspaceValue);
    await directory(workspace);
    const realWorkspace = await fs.realpath(workspace);
    const requested = settings.workDir || 'Jianying';
    localPath(requested, 'workDir');
    if (requested.split(/[\\/]/).includes('..')) throw new Error('workDir may not contain ..');
    const workDir = path.resolve(workspace, requested);
    if (!inside(workspace, workDir)) throw new Error('workDir must be inside the workspace');
    await directory(workDir, true);
    // Validate all existing components, including .runtime, without creating them.
    const runtimeDir = path.join(workDir, '.runtime');
    await directory(runtimeDir, true);
    const relative = path.relative(workspace, workDir);
    if (!inside(realWorkspace, path.resolve(realWorkspace, relative))) throw new Error('workDir escapes the real workspace');
    return { settings: { ...settings }, workspace, workDir, runtimeDir, venvDir: path.join(runtimeDir, 'venv') };
  }

  _userDirectories() { return userDirectories(this.env, { getHome: this.getHome }); }

  _env(ctx) {
    // Keep the host's minimal process environment; never recover its full env.
    const env = this._userDirectories();
    for (const name of ['PATH', 'SystemRoot', 'windir', 'LANG']) {
      const value = envValue(this.env, name);
      if (typeof value === 'string') env[name] = value;
    }
    return { ...env, TEMP: path.join(ctx.runtimeDir, 'temp'), TMP: path.join(ctx.runtimeDir, 'temp'), TMPDIR: path.join(ctx.runtimeDir, 'temp'), PIP_CACHE_DIR: path.join(ctx.runtimeDir, 'pip-cache'), PYTHONPYCACHEPREFIX: path.join(ctx.runtimeDir, 'pycache'), PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PIP_CONFIG_FILE: os.devNull, PIP_DISABLE_PIP_VERSION_CHECK: '1', XDG_CACHE_HOME: path.join(ctx.runtimeDir, 'cache'), UV_CACHE_DIR: path.join(ctx.runtimeDir, 'uv-cache') };
  }

  async _prepare(ctx) {
    await mkdirSafe(ctx.runtimeDir);
    for (const name of ['temp', 'pip-cache', 'pycache', 'cache', 'uv-cache']) {
      const cacheDir = path.join(ctx.runtimeDir, name);
      await mkdirSafe(cacheDir);
      await treeNoLinks(cacheDir);
    }
  }

  async _run(executable, args, ctx, { input = '', timeout = 60000 } = {}) {
    if (this.disposed) throw new Error('Runtime is disposed');
    const options = { cwd: ctx.workspace, env: this._env(ctx), input, timeout, maxOutput: MAX_OUTPUT, shell: false };
    const result = this.runner ? await (typeof this.runner === 'function' ? this.runner(executable, args, options) : this.runner.run(executable, args, options)) : await this.processes.run(executable, args, options);
    if (this.disposed) throw new Error('Runtime is disposed');
    if (!result || typeof result.stdout !== 'string') throw new Error('Process returned no stdout');
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr || '') > MAX_OUTPUT) throw new Error('Process output exceeds 2MB');
    if (result.code !== undefined && result.code !== 0) throw new Error(`Process exited ${result.code}: ${(result.stderr || '').slice(0, 4000)}`);
    return result.stdout;
  }

  async _executable(candidate) {
    if (/WindowsApps/i.test(candidate)) throw new Error('WindowsApps Python store placeholders are not supported');
    localPath(candidate, 'Python executable');
    const candidates = path.isAbsolute(candidate) || /[\\/]/.test(candidate)
      ? [path.resolve(candidate)]
      : (envValue(this.env, 'PATH') || '').split(path.delimiter).filter((dir) => path.isAbsolute(dir)).map((dir) => path.join(dir, process.platform === 'win32' && !candidate.toLowerCase().endsWith('.exe') ? `${candidate}.exe` : candidate));
    for (const file of candidates) {
      if (/WindowsApps/i.test(file)) continue;
      try {
        const real = await fs.realpath(file);
        if (/WindowsApps/i.test(real)) continue;
        await regularFile(real);
        return real;
      } catch { /* next PATH entry */ }
    }
    throw new Error(`Python executable not found: ${candidate}`);
  }

  async _python(ctx) {
    const candidates = [];
    if (ctx.settings.pythonPath) candidates.push({ path: ctx.settings.pythonPath, args: [] });
    candidates.push({ path: 'py', args: ['-3'] }, { path: 'python', args: [] });
    const directories = this._userDirectories();
    if (directories.LOCALAPPDATA) {
      const root = path.join(directories.LOCALAPPDATA, 'Programs', 'Python');
      for (const child of await children(root)) candidates.push({ path: path.join(root, child, 'python.exe'), args: [] });
    }
    if (directories.APPDATA) {
      const root = path.join(directories.APPDATA, 'uv', 'python');
      for (const child of await children(root)) candidates.push({ path: path.join(root, child, 'python.exe'), args: [] });
    }
    const errors = [];
    for (const candidate of candidates) {
      try {
        const executable = await this._executable(candidate.path);
        const info = json(await this._run(executable, [...candidate.args, '-I', '-B', '-c', PYTHON_INFO], ctx, { timeout: 15000 }), 'Python detection');
        if (!Array.isArray(info.version) || info.version.length < 2 || !info.version.every((v) => Number.isInteger(v) && v >= 0) || info.version[0] < 3 || (info.version[0] === 3 && info.version[1] < 10)) throw new Error('Python >=3.10 is required');
        // py -3 is discovery only: bind setup to the actual interpreter it reports.
        const actual = await this._executable(info.executable);
        return { available: true, path: actual, version: info.version.join('.') };
      } catch (error) { errors.push(`${candidate.path}: ${error.message}`); }
    }
    return { available: false, path: null, errors, message: '未找到 Python >=3.10。请自行安装 Python 或设置 pythonPath；不会自动下载 Python。' };
  }

  _venvPython(ctx) { return path.join(ctx.venvDir, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'); }

  async _venv(ctx) {
    try {
      await directory(ctx.venvDir);
      const configFile = path.join(ctx.venvDir, 'pyvenv.cfg');
      const configStat = await regularFile(configFile);
      if (configStat.size > 65536) throw new Error('Invalid venv configuration');
      if (!/^include-system-site-packages\s*=\s*false\s*$/im.test(await fs.readFile(configFile, 'utf8'))) throw new Error('venv must not include system site packages');
      const executable = this._venvPython(ctx);
      await regularFile(executable);
      const info = json(await this._run(executable, ['-I', '-B', '-c', VENV_INFO], ctx, { timeout: 20000 }), 'venv inspection');
      if (info.version !== '0.3.0' || info.isolated !== true || typeof info.prefix !== 'string' || path.resolve(info.prefix) !== ctx.venvDir) throw new Error(`An isolated ${PACKAGE} environment is required`);
      return { available: true, path: executable, version: info.version };
    } catch (error) { return { available: false, path: this._venvPython(ctx), version: null, message: error.message }; }
  }

  async _requireVenv(ctx) {
    const venv = await this._venv(ctx);
    if (!venv.available) throw new Error(`请先确认并运行 setup 安装隔离环境 (${PACKAGE}): ${venv.message}`);
    return venv.path;
  }

  async _jianying(ctx) {
    const candidates = [];
    const directories = this._userDirectories();
    if (ctx.settings.jianyingPath) candidates.push(path.resolve(ctx.workspace, localPath(ctx.settings.jianyingPath, 'jianyingPath')));
    else if (directories.LOCALAPPDATA) {
      const apps = path.join(directories.LOCALAPPDATA, 'JianyingPro', 'Apps');
      candidates.push(path.join(apps, 'JianyingPro.exe'));
      for (const version of (await children(apps)).filter((name) => /^\d+(?:\.\d+)*$/.test(name))) candidates.push(path.join(apps, version, 'JianyingPro.exe'));
    }
    for (const executable of candidates) {
      try {
        if (path.basename(executable).toLowerCase() !== 'jianyingpro.exe') throw new Error('Only JianyingPro.exe may be launched');
        await regularFile(executable);
        const file = await fs.open(executable, 'r');
        try {
          const header = Buffer.alloc(2);
          await file.read(header, 0, 2, 0);
          if (header.toString('ascii') !== 'MZ') throw new Error('Invalid Windows executable');
        } finally { await file.close(); }
        return { available: true, path: executable };
      } catch { /* report unavailable; never launch an unverified path */ }
    }
    return { available: false, path: null, message: '未找到有效的 JianyingPro.exe，请设置 jianyingPath。' };
  }

  async doctor(value = {}) {
    return this._exclusive(async () => {
      payload(value);
      const ctx = await this._context();
      const python = await this._python(ctx);
      const venv = await this._venv(ctx);
      const jianying = await this._jianying(ctx);
      const directories = this._userDirectories();
      const candidates = directories.LOCALAPPDATA ? [path.join(directories.LOCALAPPDATA, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft')] : [];
      const draftRoot = { configured: ctx.settings.draftRoot || '', candidates, writable: false };
      if (ctx.settings.draftRoot) {
        try { draftRoot.path = await this._draftRoot(ctx); draftRoot.valid = true; } catch (error) { draftRoot.valid = false; draftRoot.message = error.message; }
      }
      return { ok: true, workspace: ctx.workspace, workDir: ctx.workDir, python, venv, jianying, draftRoot, ready: venv.available };
    });
  }

  async setup(value = {}) {
    return this._exclusive(async () => {
      payload(value, ['confirmed']);
      if (value.confirmed !== true) throw new Error('setup requires confirmed:true');
      const ctx = await this._context();
      const python = await this._python(ctx);
      if (!python.available) throw new Error(python.message);
      await this._prepare(ctx);
      await directory(ctx.venvDir, true);
      // Never let venv creation or pip follow a pre-existing redirected tree.
      try { await treeNoLinks(ctx.venvDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this._run(python.path, ['-I', '-B', '-m', 'venv', '--copies', ctx.venvDir], ctx, { timeout: 180000 });
      const executable = this._venvPython(ctx);
      await regularFile(executable);
      await this._run(executable, ['-I', '-B', '-m', 'pip', 'install', '--disable-pip-version-check', PACKAGE, '--index-url', 'https://pypi.org/simple'], ctx, { timeout: 600000 });
      const venv = await this._venv(ctx);
      if (!venv.available) throw new Error(`setup verification failed: ${venv.message}`);
      return { ok: true, workDir: ctx.workDir, venv, package: PACKAGE };
    });
  }

  async _bridge(ctx, request, executable) {
    const bridge = path.join(__dirname, 'python', 'bridge.py');
    await regularFile(bridge);
    await this._prepare(ctx);
    const result = json(await this._run(executable, ['-B', '-X', 'utf8', bridge], ctx, { input: `${JSON.stringify(request)}\n`, timeout: request.action === 'build' ? 300000 : 120000 }), 'Python bridge stdout');
    if (result.ok !== true) throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error || result.message || 'Python bridge failed'));
    if (request.action !== 'probe') {
      if (typeof result.duration !== 'number' || !Number.isFinite(result.duration) || result.duration <= 0 || !Array.isArray(result.warnings) || !result.warnings.every((warning) => typeof warning === 'string')) throw new Error('Invalid bridge duration/warnings');
    }
    return result;
  }

  async probe(value = {}) {
    return this._exclusive(async () => {
      payload(value, ['path']);
      const ctx = await this._context();
      const source = await mediaPath(value.path, ctx.workspace);
      const executable = await this._requireVenv(ctx);
      return this._bridge(ctx, { action: 'probe', path: source }, executable);
    });
  }

  async validate(value = {}) {
    return this._exclusive(async () => {
      payload(value, ['timeline']);
      const ctx = await this._context();
      const timeline = await normalizeTimeline(value.timeline, ctx.workspace);
      const executable = await this._requireVenv(ctx);
      return { ...await this._bridge(ctx, { action: 'validate', timeline }, executable), timeline };
    });
  }

  async build(value = {}) {
    return this._exclusive(async () => {
      payload(value, ['timeline']);
      const ctx = await this._context();
      const timeline = await normalizeTimeline(value.timeline, ctx.workspace);
      const executable = await this._requireVenv(ctx);
      const jobs = path.join(ctx.workDir, 'jobs');
      await mkdirSafe(jobs);
      const jobDir = path.join(jobs, `${timeline.title}-${Date.now()}-${randomUUID()}`);
      await fs.mkdir(jobDir); // Exclusive new directory, including for the bridge.
      try {
        // The bridge receives an empty job directory. Persist input after it returns,
        // and on failures below, so timeline.json cannot break that contract.
        const result = await this._bridge(ctx, { action: 'build', timeline, outputDir: jobDir }, executable);
        const draftDir = path.join(jobDir, 'draft');
        if (typeof result.draftDir !== 'string' || !path.isAbsolute(result.draftDir) || result.title !== timeline.title) throw new Error('Bridge returned an unexpected draftDir/title');
        try {
          await directory(result.draftDir);
          if (await fs.realpath(result.draftDir) !== await fs.realpath(draftDir)) throw new Error('directory identity mismatch');
        } catch (error) { throw new Error(`Bridge returned an unexpected draftDir: ${error.message}`); }
        await treeNoLinks(draftDir);
        const saved = { ...result, jobDir, draftDir };
        await this._writeJob(jobDir, 'timeline.json', timeline);
        await this._writeJob(jobDir, 'result.json', saved);
        return saved;
      } catch (error) {
        try {
          await directory(jobDir);
          try { await this._writeJob(jobDir, 'timeline.json', timeline); } catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
          await fs.writeFile(path.join(jobDir, 'error.txt'), `${error.message}\n`, { flag: 'wx', encoding: 'utf8' });
        } catch (writeError) { throw new Error(`${error.message}; jobDir=${jobDir}; could not preserve diagnostics: ${writeError.message}`); }
        throw new Error(`${error.message}; jobDir=${jobDir}`);
      }
    });
  }

  async _writeJob(jobDir, name, value) {
    await directory(jobDir);
    await fs.writeFile(path.join(jobDir, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
  }

  async _draftRoot(ctx) {
    if (!ctx.settings.draftRoot) throw new Error('Explicit draftRoot setting is required; automatic candidates are read-only');
    const requested = path.resolve(ctx.workspace, localPath(ctx.settings.draftRoot, 'draftRoot'));
    await directory(requested);
    // Resolve Windows short-name aliases before comparing dangerous destinations.
    const root = await fs.realpath(requested);
    const home = await fs.realpath(os.homedir());
    if (root === path.parse(root).root || inside(root, home, true) || inside(root, ctx.workDir, true) || inside(ctx.workDir, root, true)) throw new Error('Unsafe draftRoot: root/home/work directory or its ancestor');
    const protectedRoots = [process.env.SystemRoot, process.env.WINDIR, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData, process.platform === 'win32' ? path.join(path.parse(root).root, 'Windows') : '/usr', process.platform === 'win32' ? null : '/etc', process.platform === 'win32' ? null : '/bin', process.platform === 'win32' ? null : '/System'].filter(Boolean);
    if (protectedRoots.some((entry) => inside(path.resolve(entry), root, true))) throw new Error('Unsafe draftRoot: system directory');
    return root;
  }

  async _copyDraft(source, destination, overrides = {}) {
    await treeNoLinks(source);
    await directory(path.dirname(destination));
    await noLinks(destination, { allowMissing: true });
    await fs.mkdir(destination); // EEXIST is fatal; never merge or overwrite.
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      if (/^root_meta_info(?:\.json)?$/i.test(entry.name)) throw new Error('Refusing to write root_meta_info');
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      if (entry.isDirectory()) await this._copyDraft(from, to);
      else {
        await regularFile(from);
        await directory(destination);
        if (Object.hasOwn(overrides, entry.name)) {
          await fs.writeFile(to, `${JSON.stringify(overrides[entry.name], null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
        } else await fs.copyFile(from, to, constants.COPYFILE_EXCL);
      }
    }
  }

  async publish(value = {}) {
    return this._exclusive(async () => {
      payload(value, ['jobDir', 'confirmed']);
      if (value.confirmed !== true) throw new Error('publish requires confirmed:true');
      const ctx = await this._context();
      localPath(value.jobDir, 'jobDir');
      const jobDir = path.resolve(ctx.workspace, value.jobDir);
      const jobs = path.join(ctx.workDir, 'jobs');
      if (path.dirname(jobDir) !== jobs) throw new Error('jobDir must be a direct child of workDir/jobs');
      await directory(jobDir);
      const result = await readJson(path.join(jobDir, 'result.json'));
      const draftDir = path.join(jobDir, 'draft');
      if (result.ok !== true || result.jobDir !== jobDir || result.draftDir !== draftDir || typeof result.duration !== 'number' || !Number.isFinite(result.duration) || result.duration <= 0) throw new Error('Invalid or forged job result paths/status');
      const title = validateTitle(result.title);
      if (typeof result.title !== 'string') throw new Error('Missing result title');
      await treeNoLinks(draftDir);
      const metadata = await readJson(path.join(draftDir, 'draft_meta_info.json'));
      const content = await readJson(path.join(draftDir, 'draft_content.json'));
      const draftRoot = await this._draftRoot(ctx);
      const backups = path.join(ctx.workDir, 'backups');
      await mkdirSafe(backups);
      const backupDir = path.join(backups, `${path.basename(jobDir)}-${randomUUID()}`);
      await this._copyDraft(draftDir, backupDir);
      // Recheck after backup, immediately before writing the external directory.
      await this._draftRoot(ctx);
      const draftId = randomUUID().toUpperCase();
      const importedDir = path.join(draftRoot, `${title}-pi-${draftId}`);
      const now = Date.now() * 1000;
      await this._copyDraft(backupDir, importedDir, {
        'draft_meta_info.json': { ...metadata, draft_id: draftId, draft_name: title,
          draft_fold_path: importedDir, draft_root_path: draftRoot,
          tm_draft_create: now, tm_draft_modified: now },
        'draft_content.json': { ...content, id: draftId, name: title },
      });
      return { ok: true, importedDir, backupDir, warnings: [IMPORT_WARNING] };
    });
  }

  async launch(value = {}) {
    return this._exclusive(async () => {
      payload(value);
      if (process.platform !== 'win32') throw new Error('Launching Jianying is supported on Windows only');
      const ctx = await this._context();
      const app = await this._jianying(ctx);
      if (!app.available) throw new Error(app.message);
      if (this.disposed) throw new Error('Runtime is disposed');
      await new Promise((resolve, reject) => {
        const child = spawn(app.path, [], { shell: false, detached: true, stdio: 'ignore', cwd: path.dirname(app.path), windowsHide: false });
        this.launches.add(child);
        child.once('error', (error) => { this.launches.delete(child); reject(error); });
        child.once('close', () => this.launches.delete(child));
        child.once('spawn', () => { child.unref(); resolve(); });
      });
      return { ok: true, launched: true, path: app.path, message: '仅启动剪映；未自动打开任何工程。' };
    });
  }

  async dispose() {
    this.disposed = true;
    let cleanupError;
    try {
      await Promise.all([
        this.processes.dispose(),
        ...(this.runner && typeof this.runner.dispose === 'function' ? [this.runner.dispose()] : []),
      ]);
    } catch (error) { cleanupError = error; }
    // Drain an in-flight copy before the host tears down the plugin process.
    if (this.activeOperation) await this.activeOperation.catch(() => {});
    // A launched editor belongs to the user; never terminate it on plugin unload.
    this.launches.clear();
    if (cleanupError) throw cleanupError;
  }
}

module.exports = { JianyingRuntime, userDirectories };
