'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ProcessRunner, MAX_OUTPUT } = require('../process-runner');

const reply = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const timeline = () => ({ title: 'demo', clips: [{ path: 'video.mp4', start: 0, duration: 4, speed: 2 }] });
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function link(target, name) { await fs.symlink(target, name, process.platform === 'win32' ? 'junction' : 'dir'); }
async function put(file, content = '') { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
function env(t, values) {
  const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  t.after(() => { for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
}

async function fixture(t, { venv = true } = {}) {
  assert.ok(process.env.PI_SCRATCH_DIR, 'PI_SCRATCH_DIR is required; never use os.tmpdir');
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'jianying-runtime-'));
  const plugin = path.join(root, 'plugin');
  const workspace = path.join(root, 'workspace');
  const workDir = path.join(workspace, 'Jianying');
  const runtimeDir = path.join(workDir, '.runtime');
  const venvDir = path.join(runtimeDir, 'venv');
  const venvPython = path.join(venvDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const draftRoot = path.join(root, 'drafts');
  await fs.mkdir(workspace);
  await fs.mkdir(plugin);
  await fs.mkdir(draftRoot);
  // A complete plugin copy and inert bridge fixture live only in PI_SCRATCH_DIR.
  // Production bridge existence checks remain enabled, even with a mock runner.
  for (const file of ['runtime.js', 'timeline.js', 'path-safety.js', 'process-runner.js']) await fs.copyFile(path.join(__dirname, '..', file), path.join(plugin, file));
  await put(path.join(plugin, 'python', 'bridge.py'), '# inert mock bridge fixture\n');
  await put(path.join(workspace, 'video.mp4'), 'media');
  const python = path.join(root, 'python.exe');
  await put(python, 'MZ inert fixture');
  const settings = { pythonPath: python, draftRoot, jianyingPath: '', workDir: '' };
  const makeVenv = async () => {
    await put(venvPython, 'MZ inert fixture');
    await put(path.join(venvDir, 'pyvenv.cfg'), 'include-system-site-packages = false\n');
  };
  if (venv) await makeVenv();
  const calls = [];
  const state = { bridge: null, version: '0.3.0', pythonVersion: [3, 14, 7], isolated: true };
  const runner = async (exe, args, options) => {
    calls.push({ exe, args, options });
    assert.equal(options.shell, false);
    for (const name of ['TEMP', 'TMP', 'TMPDIR', 'PIP_CACHE_DIR', 'PYTHONPYCACHEPREFIX', 'XDG_CACHE_HOME', 'UV_CACHE_DIR']) assert.ok(options.env[name].startsWith(`${runtimeDir}${path.sep}`), name);
    if (args.includes('-c')) {
      if (args.at(-1).includes('importlib.metadata')) return reply({ version: state.version, isolated: state.isolated, prefix: venvDir });
      return reply({ version: state.pythonVersion, executable: exe });
    }
    if (args.includes('venv')) { await makeVenv(); return reply({}); }
    if (args.includes('pip')) return reply({});
    assert.equal(args.at(-1), path.join(plugin, 'python', 'bridge.py'));
    assert.ok(options.input.endsWith('\n'));
    assert.equal(options.input.trim().split('\n').length, 1);
    const request = JSON.parse(options.input);
    if (state.bridge) return state.bridge(request, options);
    if (request.action === 'probe') return reply({ ok: true, path: request.path, duration: 10 });
    if (request.action === 'validate') return reply({ ok: true, duration: 2, warnings: [] });
    assert.deepEqual(await fs.readdir(request.outputDir), [], 'bridge receives a new empty directory');
    const draftDir = path.join(request.outputDir, 'draft');
    await put(path.join(draftDir, 'draft_content.json'), '{"materials":{}}');
    await put(path.join(draftDir, 'draft_meta_info.json'), '{"title":"demo"}');
    return reply({ ok: true, draftDir, title: request.timeline.title, duration: 2, warnings: [] });
  };
  const { JianyingRuntime } = require(path.join(plugin, 'runtime.js'));
  const runtime = new JianyingRuntime({ getSettings: async () => settings, getWorkspace: async () => workspace, runner });
  t.after(async () => { await runtime.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, plugin, workspace, workDir, runtimeDir, venvDir, venvPython, draftRoot, python, settings, runtime, calls, state, makeVenv };
}

test('doctor detects configured Python without creating workDir; setup needs confirmation', async (t) => {
  const f = await fixture(t, { venv: false });
  const result = await f.runtime.doctor({});
  assert.equal(result.python.path, f.python);
  assert.equal(result.python.version, '3.14.7');
  assert.equal(result.venv.available, false);
  assert.equal(await exists(f.workDir), false);
  await assert.rejects(f.runtime.setup({}), /confirmed:true/);
  assert.equal(await exists(f.workDir), false);
});

test('setup uses pinned PyPI dependency and isolates every cache/temp path', async (t) => {
  const f = await fixture(t, { venv: false });
  env(t, { PIP_EXTRA_INDEX_URL: 'https://untrusted.invalid', PYTHONPATH: 'untrusted', PIP_TARGET: f.draftRoot });
  const result = await f.runtime.setup({ confirmed: true });
  assert.equal(result.ok, true);
  const creation = f.calls.find((call) => call.args.includes('venv'));
  assert.deepEqual(creation.args, ['-I', '-B', '-m', 'venv', '--copies', f.venvDir]);
  const pip = f.calls.find((call) => call.args.includes('pip'));
  assert.equal(pip.exe, f.venvPython);
  assert.deepEqual(pip.args, ['-I', '-B', '-m', 'pip', 'install', '--disable-pip-version-check', 'pyJianYingDraft==0.3.0', '--index-url', 'https://pypi.org/simple']);
  assert.equal(pip.options.env.PIP_EXTRA_INDEX_URL, undefined);
  assert.equal(pip.options.env.PIP_TARGET, undefined);
  assert.equal(pip.options.env.PYTHONPATH, undefined);
  assert.equal(pip.options.timeout, 600000);
});

test('discovers uv Python and numerically newest Jianying version; skips WindowsApps', async (t) => {
  const f = await fixture(t, { venv: false });
  const local = path.join(f.root, 'Local');
  const roaming = path.join(f.root, 'Roaming');
  const store = path.join(local, 'Microsoft', 'WindowsApps');
  const uvPython = path.join(roaming, 'uv', 'python', 'cpython-3.14.7-windows-x86_64-none', 'python.exe');
  await put(uvPython, 'MZ fixture');
  await put(path.join(store, process.platform === 'win32' ? 'python.exe' : 'python'), 'store placeholder');
  for (const version of ['9.9.0', '10.1.0']) await put(path.join(local, 'JianyingPro', 'Apps', version, 'JianyingPro.exe'), 'MZ fixture');
  env(t, { LOCALAPPDATA: local, APPDATA: roaming, PATH: store });
  f.settings.pythonPath = '';
  const result = await f.runtime.doctor({});
  assert.equal(result.python.path, uvPython);
  assert.equal(result.jianying.path, path.join(local, 'JianyingPro', 'Apps', '10.1.0', 'JianyingPro.exe'));
  assert.ok(!f.calls.some((call) => call.exe.includes('WindowsApps')));
  assert.equal(await exists(f.workDir), false);
});

test('missing/old Python never downloads Python or creates workDir', async (t) => {
  const f = await fixture(t, { venv: false });
  env(t, { PATH: '', LOCALAPPDATA: f.root, APPDATA: f.root });
  f.state.pythonVersion = [3, 9, 9];
  await assert.rejects(f.runtime.setup({ confirmed: true }), /Python >=3.10/);
  f.settings.pythonPath = '';
  const result = await f.runtime.doctor({});
  assert.equal(result.python.available, false);
  assert.match(result.python.message, /不会自动下载/);
  assert.equal(await exists(f.workDir), false);
  assert.ok(!f.calls.some((call) => call.args.includes('pip')));
});

test('requires existing workspace and contained workDir with no traversal or junctions', async (t) => {
  const f = await fixture(t, { venv: false });
  for (const workDir of ['../escape', 'child/../escape', '.', f.root, '\\\\server\\share', 123]) {
    f.settings.workDir = workDir;
    await assert.rejects(f.runtime.doctor({}));
  }
  f.settings.workDir = 'linked';
  await link(f.draftRoot, path.join(f.workspace, 'linked'));
  await assert.rejects(f.runtime.doctor({}), /Symbolic links/);
  f.settings.workDir = '';
  f.runtime.getWorkspace = async () => path.join(f.root, 'missing');
  await assert.rejects(f.runtime.doctor({}), /ENOENT/);
});

test('rejects managed runtime/cache/venv and jobs junctions', async (t) => {
  const f = await fixture(t, { venv: false });
  await fs.mkdir(f.workDir);
  await link(f.draftRoot, f.runtimeDir);
  await assert.rejects(f.runtime.setup({ confirmed: true }), /Symbolic links/);
  await fs.unlink(f.runtimeDir);
  await fs.mkdir(f.runtimeDir);
  await link(f.draftRoot, path.join(f.runtimeDir, 'temp'));
  await assert.rejects(f.runtime.setup({ confirmed: true }), /Symbolic links/);
  await fs.unlink(path.join(f.runtimeDir, 'temp'));
  await fs.mkdir(path.join(f.runtimeDir, 'pip-cache'), { recursive: true });
  await link(f.draftRoot, path.join(f.runtimeDir, 'pip-cache', 'http-v2'));
  await assert.rejects(f.runtime.setup({ confirmed: true }), /Symbolic links/);
  await fs.unlink(path.join(f.runtimeDir, 'pip-cache', 'http-v2'));
  await link(f.draftRoot, f.venvDir);
  await assert.rejects(f.runtime.setup({ confirmed: true }), /Symbolic links/);
  await fs.unlink(f.venvDir);
  await f.makeVenv();
  await link(f.draftRoot, path.join(f.workDir, 'jobs'));
  await assert.rejects(f.runtime.build({ timeline: timeline() }), /Symbolic links/);
  assert.deepEqual(await fs.readdir(f.draftRoot), []);
});

test('probe checks local file and validate invokes the bridge with normalized timeline', async (t) => {
  const f = await fixture(t);
  for (const source of ['https://example.com/media', 'missing', '.']) await assert.rejects(f.runtime.probe({ path: source }));
  const result = await f.runtime.probe({ path: 'video.mp4' });
  assert.equal(result.path, path.join(f.workspace, 'video.mp4'));
  assert.equal(await fs.readFile(result.path, 'utf8'), 'media');
  const checked = await f.runtime.validate({ timeline: timeline() });
  assert.equal(checked.duration, 2);
  assert.equal(checked.timeline.width, 1080);
  assert.equal(checked.timeline.clips[0].path, result.path);
  f.state.bridge = async () => reply({ ok: false, error: 'clip exceeds source duration' });
  await assert.rejects(f.runtime.validate({ timeline: timeline() }), /exceeds source duration/);
});

test('rejects unisolated/wrong dependency versions before calling bridge', async (t) => {
  const f = await fixture(t);
  f.state.version = '0.2.0';
  await assert.rejects(f.runtime.validate({ timeline: timeline() }), /setup/);
  f.state.version = '0.3.0'; f.state.isolated = false;
  await assert.rejects(f.runtime.probe({ path: 'video.mp4' }), /setup/);
  assert.ok(f.calls.every((call) => !call.options.input));
});

test('build saves normalized input/result and publishes backup first without changing existing projects/indexes', async (t) => {
  const f = await fixture(t);
  await put(path.join(f.draftRoot, 'existing', 'draft_content.json'), 'keep existing');
  await put(path.join(f.draftRoot, 'draft_meta_info.json'), 'global index');
  await put(path.join(f.draftRoot, 'root_meta_info.json'), 'global root');
  const result = await f.runtime.build({ timeline: timeline() });
  assert.equal(path.dirname(result.jobDir), path.join(f.workDir, 'jobs'));
  assert.equal(result.draftDir, path.join(result.jobDir, 'draft'));
  assert.equal(JSON.parse(await fs.readFile(path.join(result.jobDir, 'result.json'), 'utf8')).jobDir, result.jobDir);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.jobDir, 'timeline.json'), 'utf8')).clips[0].path, path.join(f.workspace, 'video.mp4'));
  await assert.rejects(f.runtime.publish({ jobDir: result.jobDir }), /confirmed:true/);
  const first = await f.runtime.publish({ jobDir: result.jobDir, confirmed: true });
  const second = await f.runtime.publish({ jobDir: result.jobDir, confirmed: true });
  assert.notEqual(first.importedDir, second.importedDir);
  assert.notEqual(first.backupDir, second.backupDir);
  assert.equal(await fs.readFile(path.join(first.backupDir, 'draft_content.json'), 'utf8'), '{"materials":{}}');
  const identities = [];
  for (const directory of [first.importedDir, second.importedDir]) {
    const content = JSON.parse(await fs.readFile(path.join(directory, 'draft_content.json'), 'utf8'));
    const meta = JSON.parse(await fs.readFile(path.join(directory, 'draft_meta_info.json'), 'utf8'));
    assert.deepEqual(content.materials, {});
    assert.equal(content.id, meta.draft_id);
    assert.equal(meta.draft_fold_path, directory);
    assert.equal(meta.draft_root_path, f.draftRoot);
    identities.push(content.id);
  }
  assert.notEqual(identities[0], identities[1]);
  assert.equal(await fs.readFile(path.join(f.draftRoot, 'existing', 'draft_content.json'), 'utf8'), 'keep existing');
  assert.equal(await fs.readFile(path.join(f.draftRoot, 'draft_meta_info.json'), 'utf8'), 'global index');
  assert.equal(await fs.readFile(path.join(f.draftRoot, 'root_meta_info.json'), 'utf8'), 'global root');
  assert.deepEqual(first.warnings, ['必要时重启剪映刷新草稿；素材为原文件绝对路径']);
  await assert.rejects(f.runtime._copyDraft(result.draftDir, first.importedDir), /EEXIST/);
});

test('failed build preserves error/input and never writes a success result', async (t) => {
  const f = await fixture(t);
  f.state.bridge = async () => { throw new Error('mock conversion failed'); };
  await assert.rejects(f.runtime.build({ timeline: timeline() }), /mock conversion failed; jobDir=/);
  const jobs = path.join(f.workDir, 'jobs');
  const [job] = await fs.readdir(jobs);
  assert.match(await fs.readFile(path.join(jobs, job, 'error.txt'), 'utf8'), /mock conversion failed/);
  assert.equal(await exists(path.join(jobs, job, 'timeline.json')), true);
  assert.equal(await exists(path.join(jobs, job, 'result.json')), false);
  await assert.rejects(f.runtime.publish({ jobDir: path.join(jobs, job), confirmed: true }), /ENOENT/);
});

test('bridge must emit one bounded JSON object with valid success fields', async (t) => {
  const f = await fixture(t);
  for (const stdout of ['not json', '{}\n{}', '[]', 'x'.repeat(MAX_OUTPUT + 1), JSON.stringify({ ok: true, duration: -1, warnings: [] }), JSON.stringify({ ok: true, duration: 1, warnings: [1] })]) {
    f.state.bridge = async () => ({ stdout, code: 0 });
    await assert.rejects(f.runtime.validate({ timeline: timeline() }));
  }
  f.state.bridge = async () => ({ stdout: '', code: 1, stderr: 'failed' });
  await assert.rejects(f.runtime.validate({ timeline: timeline() }), /exited 1/);
  f.state.bridge = async () => reply({ ok: true, draftDir: f.draftRoot, title: 'demo', duration: 2, warnings: [] });
  await assert.rejects(f.runtime.build({ timeline: timeline() }), /unexpected draftDir/);
});

test('publish rejects forged paths, nested jobs, unsafe roots and redirected source/target trees', async (t) => {
  const f = await fixture(t);
  const result = await f.runtime.build({ timeline: timeline() });
  const publish = (jobDir = result.jobDir) => f.runtime.publish({ jobDir, confirmed: true });
  for (const jobDir of [f.workDir, f.root, result.draftDir]) await assert.rejects(publish(jobDir), /direct child/);
  const resultFile = path.join(result.jobDir, 'result.json');
  await fs.writeFile(resultFile, JSON.stringify({ ...result, draftDir: f.draftRoot }));
  await assert.rejects(publish(), /forged/);
  await fs.writeFile(resultFile, JSON.stringify(result));
  for (const root of ['', path.parse(f.root).root, os.homedir(), f.workspace, f.workDir, path.join(f.root, 'missing')]) {
    f.settings.draftRoot = root;
    await assert.rejects(publish());
  }
  const alias = path.join(f.root, 'draft-alias');
  await link(f.draftRoot, alias);
  f.settings.draftRoot = alias;
  await assert.rejects(publish(), /Symbolic links/);
  f.settings.draftRoot = f.draftRoot;
  const sourceAlias = path.join(result.draftDir, 'redirected');
  await link(f.draftRoot, sourceAlias);
  await assert.rejects(publish(), /Symbolic links/);
  await fs.unlink(sourceAlias);
  const jobAlias = path.join(f.workDir, 'jobs', 'alias');
  await link(result.jobDir, jobAlias);
  await assert.rejects(publish(jobAlias), /Symbolic links/);
  await put(path.join(result.draftDir, 'root_meta_info.json'), '{}');
  await assert.rejects(publish(), /root_meta_info/);
  assert.deepEqual(await fs.readdir(f.draftRoot), []);
});

test('busy prevents concurrent work and dispose permanently rejects new calls', async (t) => {
  const f = await fixture(t);
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.state.bridge = async () => { entered(); await new Promise((resolve) => { release = resolve; }); return reply({ ok: true, duration: 2, warnings: [] }); };
  const pending = f.runtime.validate({ timeline: timeline() });
  await started;
  await assert.rejects(f.runtime.doctor({}), /busy/);
  release(); await pending;
  await f.runtime.dispose();
  await assert.rejects(f.runtime.doctor({}), /disposed/);
});

test('launch rejects arbitrary executable paths and payloads without launching anything', async (t) => {
  const f = await fixture(t);
  f.settings.jianyingPath = process.execPath;
  await assert.rejects(f.runtime.launch({}), /JianyingPro.exe|Windows only/);
  await assert.rejects(f.runtime.launch({ path: process.execPath }), /Unknown payload/);
});

test('real process runner uses EOF, caps output and reports process failures', async (t) => {
  const runner = new ProcessRunner();
  t.after(() => runner.dispose());
  const output = await runner.run(process.execPath, ['-e', 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(s));'], { input: '{"ok":true}\n', timeout: 5000 });
  assert.equal(output.stdout, '{"ok":true}\n');
  await assert.rejects(runner.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(3*1024*1024)); setInterval(()=>{},1000);'], { timeout: 5000 }), /exceeds 2MB/);
  await assert.rejects(runner.run(process.execPath, ['-e', 'process.stderr.write("failure");process.exit(7);'], { timeout: 5000 }), /exited 7: failure/);
});

test('real timeout kills descendants before returning; dispose terminates active children', async (t) => {
  const f = await fixture(t, { venv: false });
  const runner = new ProcessRunner();
  t.after(() => runner.dispose());
  const lateFile = path.join(f.root, 'must-not-be-written');
  const childCode = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(lateFile)},'bad'),1800);setInterval(()=>{},1000);`;
  const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit',shell:false});setInterval(()=>{},1000);`;
  await assert.rejects(runner.run(process.execPath, ['-e', parentCode], { timeout: 600 }), /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(await exists(lateFile), false);
  const pending = runner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 10000 });
  const rejected = assert.rejects(pending, /disposed/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await runner.dispose();
  await rejected;
  assert.equal(runner.active.size, 0);
});

test('dispose never terminates a launched user editor', async (t) => {
  const f = await fixture(t);
  let killed = false;
  f.runtime.launches.add({ pid: 123456 });
  f.runtime.processes.kill = async () => { killed = true; };
  await f.runtime.dispose();
  assert.equal(killed, false);
});

test('setup rejects hard-linked venv files before overwriting external data', async (t) => {
  const f = await fixture(t);
  const external = path.join(f.root, 'outside-config.txt');
  await put(external, 'outside sentinel');
  const config = path.join(f.venvDir, 'pyvenv.cfg');
  await fs.unlink(config);
  await fs.link(external, config);
  await assert.rejects(f.runtime.setup({ confirmed: true }), /Hard links/);
  assert.equal(await fs.readFile(external, 'utf8'), 'outside sentinel');
  assert.equal(f.calls.some(call => call.args.includes('venv')), false);
});

test('dispose waits for an in-flight file import to finish', async (t) => {
  const f = await fixture(t);
  const job = await f.runtime.build({ timeline: timeline() });
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const copy = f.runtime._copyDraft.bind(f.runtime);
  f.runtime._copyDraft = async (source, destination, overrides) => {
    if (destination.startsWith(f.draftRoot + path.sep)) { enter(); await gate; }
    return copy(source, destination, overrides);
  };
  const pending = f.runtime.publish({ jobDir: job.jobDir, confirmed: true });
  await entered;
  let settled = false;
  const disposing = f.runtime.dispose().then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  release();
  const result = await pending;
  await disposing;
  assert.equal(settled, true);
  assert.equal(result.ok, true);
  assert.equal(await exists(path.join(result.importedDir, 'draft_content.json')), true);
});

test('build accepts the same real Windows directory with different casing', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  f.state.bridge = async request => {
    const draftDir = path.join(request.outputDir, 'draft');
    await put(path.join(draftDir, 'draft_content.json'), '{"materials":{}}');
    await put(path.join(draftDir, 'draft_meta_info.json'), '{}');
    return reply({ ok: true, draftDir: draftDir.toUpperCase(), title: request.timeline.title, duration: 2, warnings: [] });
  };
  const result = await f.runtime.build({ timeline: timeline() });
  assert.equal(result.ok, true);
  assert.equal(await exists(path.join(result.jobDir, 'result.json')), true);
});
