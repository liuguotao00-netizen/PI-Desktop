'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { JianyingRuntime, userDirectories } = require('../runtime');

const syntheticHome = path.resolve('synthetic-user');

test('stripped Windows environment derives only user directory hints', () => {
  const env = { Path: '', SystemRoot: path.parse(syntheticHome).root, LANG: 'en_US.UTF-8' };
  const before = { ...env };
  assert.deepEqual(userDirectories(env, { platform: 'win32', getHome: () => syntheticHome }), {
    HOME: syntheticHome, USERPROFILE: syntheticHome,
    APPDATA: path.join(syntheticHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(syntheticHome, 'AppData', 'Local'),
  });
  assert.deepEqual(env, before);
});

test('case-insensitive valid explicit directories win; invalid hints cannot become relative candidates', () => {
  const profile = path.join(syntheticHome, 'profile');
  const home = path.join(syntheticHome, 'home');
  const roaming = path.join(syntheticHome, 'redirected-roaming');
  const local = path.join(syntheticHome, 'redirected-local');
  const options = { platform: 'win32', getHome: () => { throw new Error('must not query OS'); } };
  assert.deepEqual(userDirectories({ userprofile: profile, Home: home, appdata: roaming, LocalAppData: local }, options), {
    USERPROFILE: profile, HOME: home, APPDATA: roaming, LOCALAPPDATA: local,
  });
  const fallback = userDirectories({ APPDATA: 'relative', LOCALAPPDATA: '\0', USERPROFILE: '' }, { platform: 'win32', getHome: () => syntheticHome });
  assert.equal(fallback.APPDATA, path.join(syntheticHome, 'AppData', 'Roaming'));
  assert.equal(fallback.LOCALAPPDATA, path.join(syntheticHome, 'AppData', 'Local'));
  assert.deepEqual(userDirectories({}, { platform: 'win32', getHome: () => '' }), {});
  assert.deepEqual(userDirectories({}, { platform: 'linux', getHome: () => syntheticHome }), { HOME: syntheticHome });
});

async function fixture(t) {
  assert.ok(process.env.PI_SCRATCH_DIR, 'PI_SCRATCH_DIR is required');
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'jianying-environment-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'user');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const put = async (file) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'MZ inert fixture'); return file; };
  const python = await put(path.join(home, 'AppData', 'Roaming', 'uv', 'python', 'cpython-3.12.8-windows-x86_64-none', 'python.exe'));
  const app = await put(path.join(home, 'AppData', 'Local', 'JianyingPro', 'Apps', '12.0.0', 'JianyingPro.exe'));
  const calls = [];
  const settings = {};
  const env = { Path: '', SystemRoot: path.parse(root).root, windir: path.parse(root).root, TEMP: root, TMP: root, TMPDIR: root, LANG: 'en_US.UTF-8' };
  const runtime = new JianyingRuntime({
    getSettings: async () => settings, getWorkspace: async () => workspace, env, getHome: () => home,
    runner: async (exe, args, options) => { calls.push({ exe, args, options }); return { code: 0, stdout: JSON.stringify({ version: [3, 12, 8], executable: exe }) }; },
  });
  t.after(() => runtime.dispose());
  return { home, workspace, python, app, calls, runtime, settings, env, put };
}

test('doctor under host whitelist discovers uv/editor without creating directories or authorizing drafts', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const before = { ...f.env };
  const report = await f.runtime.doctor();
  assert.equal(report.python.path, f.python);
  assert.equal(report.jianying.path, f.app);
  assert.deepEqual(report.draftRoot, { configured: '', candidates: [path.join(f.home, 'AppData', 'Local', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft')], writable: false });
  assert.equal(report.venv.available, false);
  assert.deepEqual(await fs.readdir(f.workspace), []);
  assert.deepEqual(f.env, before);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].args.includes('-B'));
  await assert.rejects(f.runtime._draftRoot(await f.runtime._context()), /Explicit draftRoot/);
  const env = f.calls[0].options.env;
  assert.equal(env.USERPROFILE, f.home);
  assert.equal(env.HOME, f.home);
  assert.equal(env.APPDATA, path.join(f.home, 'AppData', 'Roaming'));
  assert.equal(env.LOCALAPPDATA, path.join(f.home, 'AppData', 'Local'));
  assert.equal(env.PATH, '');
  assert.equal(env.SystemRoot, f.env.SystemRoot);
  assert.equal(env.LANG, f.env.LANG);
  for (const key of ['TEMP', 'TMP', 'TMPDIR', 'PIP_CACHE_DIR', 'PYTHONPYCACHEPREFIX', 'XDG_CACHE_HOME', 'UV_CACHE_DIR']) {
    assert.ok(env[key].startsWith(path.join(f.workspace, 'Jianying', '.runtime') + path.sep), key);
  }
});

test('configured paths and mixed-case PATH take precedence; subprocess environment remains allowlisted', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  f.settings.pythonPath = await f.put(path.join(f.home, 'configured', 'python.exe'));
  f.settings.jianyingPath = await f.put(path.join(f.home, 'configured', 'JianyingPro.exe'));
  Object.assign(f.env, { PRIVATE_HOST_TOKEN: 'not-inherited', pythonpath: 'unsafe', pip_target: 'unsafe', uv_cache_dir: 'unsafe', xdg_cache_home: 'unsafe', temp: 'unsafe' });
  const report = await f.runtime.doctor();
  assert.equal(report.python.path, f.settings.pythonPath);
  assert.equal(report.jianying.path, f.settings.jianyingPath);
  const env = f.calls[0].options.env;
  for (const key of ['PRIVATE_HOST_TOKEN', 'pythonpath', 'pip_target', 'uv_cache_dir', 'xdg_cache_home', 'temp']) assert.equal(env[key], undefined);
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  f.settings.pythonPath = '';
  f.env.Path = path.dirname(report.python.path);
  assert.equal((await f.runtime.doctor()).python.path, report.python.path);
  assert.deepEqual(await fs.readdir(f.workspace), []);
});
