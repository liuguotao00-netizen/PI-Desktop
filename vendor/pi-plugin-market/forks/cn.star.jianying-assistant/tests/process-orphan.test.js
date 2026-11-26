'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ProcessRunner, MAX_INPUT, KILL_TIMEOUT } = require('../process-runner');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail('Condition did not become true before deadline');
    await delay(20);
  }
}
async function fixture(t) {
  assert.ok(process.env.PI_SCRATCH_DIR, 'PI_SCRATCH_DIR required: no system temp');
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'process-orphan-'));
  const runner = new ProcessRunner();
  const pids = [];
  t.after(async () => {
    await runner.dispose().catch(() => {});
    // Emergency test cleanup also runs when assertions fail.
    for (const pid of pids) { if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, runner, pids, env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } };
}
async function orphan(f, { timeout = 10000, ignored = false } = {}) {
  const record = path.join(f.root, 'pids.json');
  const heartbeat = path.join(f.root, 'heartbeat');
  // Both parent and child exit immediately after spawning; the grandchild keeps
  // the parent's stdout/stderr handles open (or closes both in the ignored case).
  const leaf = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({leaf:process.pid,parent:Number(process.env.TEST_PARENT)}));setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),30);`;
  // Windows detached skips Node/libuv's own kill-on-exit job, reproducing the
  // original orphan bug. POSIX keeps the runner's process group intentionally.
  const detached = process.platform === 'win32';
  const middle = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:${JSON.stringify(ignored ? 'ignore' : 'inherit')},detached:${detached},shell:false}).unref();process.exit(0);`;
  const parent = `process.env.TEST_PARENT=String(process.pid);require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'inherit',detached:${detached},shell:false}).unref();process.exit(0);`;
  const started = Date.now();
  // Observe rejections immediately so readiness assertions never hide one.
  let completed;
  const outcome = f.runner.run(process.execPath, ['-e', parent], { env: f.env, timeout }).then(
    (value) => (completed = { value }), (error) => (completed = { error }));
  await until(async () => {
    assert.equal(completed, undefined, completed?.error?.message || 'process ended before descendant readiness');
    try { await fs.access(record); return true; } catch { return false; }
  });
  const pids = JSON.parse(await fs.readFile(record, 'utf8'));
  f.pids.push(pids.leaf);
  await until(() => !alive(pids.parent));
  assert.equal(alive(pids.leaf), true, 'descendant genuinely started and outlived parent');
  await until(async () => { try { return (await fs.stat(heartbeat)).size > 0; } catch { return false; } });
  return { outcome, started, pids, heartbeat };
}
async function assertStopped(f, run) {
  await until(() => !alive(run.pids.leaf), 1000);
  const before = await fs.readFile(run.heartbeat, 'utf8');
  await delay(150);
  assert.equal(await fs.readFile(run.heartbeat, 'utf8'), before, 'no background writes after termination');
  assert.equal(f.runner.active.size, 0);
}

test('timeout kills inherited-pipe descendants after their Node parent has already exited', { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const run = await orphan(f, { timeout: 4500 });
  const result = await run.outcome;
  assert.match(result.error?.message || '', /timed out/);
  assert.doesNotMatch(result.error.message, /could not confirm/);
  assert.ok(Date.now() - run.started < 4500 + KILL_TIMEOUT + 750, 'run has a bounded deadline');
  await assertStopped(f, run);
});

test('dispose kills inherited-pipe descendants after their Node parent has already exited', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const run = await orphan(f);
  const started = Date.now();
  await f.runner.dispose();
  assert.ok(Date.now() - started < KILL_TIMEOUT + 750, 'dispose is bounded');
  assert.match((await run.outcome).error?.message || '', /disposed/);
  await assertStopped(f, run);
});

test('Windows job retains descendants even when they inherit no output handles', { skip: process.platform !== 'win32', timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const run = await orphan(f, { ignored: true });
  assert.equal(f.runner.active.size, 1, 'supervisor tracks job membership, not just pipes');
  await f.runner.dispose();
  assert.match((await run.outcome).error?.message || '', /disposed/);
  await assertStopped(f, run);
});

test('Windows supervisor crash also closes its job and kills orphan descendants', { skip: process.platform !== 'win32', timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const run = await orphan(f);
  [...f.runner.active][0].child.kill('SIGKILL');
  assert.ok((await run.outcome).error);
  await assertStopped(f, run);
});

test('normal EOF, literal argv, cwd and environment work with nonexistent TEMP without creating it', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const missingTemp = path.join(f.root, 'not-created', 'temp');
  const args = ['', 'space value', '中文', 'a"b', 'trailing\\', 'a\\"b', '$env:PATH; & echo bad'];
  const code = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({args:process.argv.slice(1),input,cwd:process.cwd(),temp:process.env.TEMP})));`;
  const result = await f.runner.run(process.execPath, ['-e', code, '--', ...args], {
    cwd: f.root, env: { ...f.env, TEMP: missingTemp, TMP: missingTemp, TMPDIR: missingTemp }, input: 'hello 中文\n', timeout: 5000,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { args, input: 'hello 中文\n', cwd: f.root, temp: missingTemp });
  assert.deepEqual(await fs.readdir(f.root), [], 'doctor-style call must not create TEMP or compiler/cache files');
});

test('stdin is bounded before spawning; output limit can be lowered, never raised', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.runner.run(process.execPath, [], { input: Buffer.alloc(MAX_INPUT + 1) }), /input exceeds 2MB/);
  assert.equal(f.runner.active.size, 0);
  const counted = await f.runner.run(process.execPath, ['-e', 'let n=0;process.stdin.on("data",c=>n+=c.length);process.stdin.on("end",()=>console.log(n));'], { env: f.env, input: Buffer.alloc(MAX_INPUT), timeout: 5000 });
  assert.equal(Number(counted.stdout), MAX_INPUT, 'supervisor framing must not consume target stdin');
  await assert.rejects(f.runner.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(100));'], { env: f.env, maxOutput: 50, timeout: 5000 }), /exceeds 50 bytes/);
  await assert.rejects(f.runner.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(3*1024*1024));'], { env: f.env, maxOutput: 10 * 1024 * 1024, timeout: 5000 }), /exceeds 2MB/);
});

test('hung kill cannot hang run/dispose or claim successful cleanup', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const run = await orphan(f);
  const child = [...f.runner.active][0].child;
  const realKill = f.runner.kill.bind(f.runner);
  f.runner.kill = () => new Promise(() => {});
  const started = Date.now();
  try {
    await assert.rejects(f.runner.dispose(), /could not confirm process tree termination/);
    assert.match((await run.outcome).error?.message || '', /could not confirm process tree termination/);
    assert.ok(Date.now() - started < KILL_TIMEOUT + 750);
    await assert.rejects(f.runner.run(process.execPath, []), /disposed/);
  } finally {
    // This fault injection deliberately suppressed termination; clean it up.
    await realKill(child);
  }
  await assertStopped(f, run);
});

test('continuous output with failed kill remains bounded and reports unconfirmed cleanup', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const realKill = f.runner.kill.bind(f.runner);
  f.runner.kill = () => new Promise(() => {});
  const started = Date.now();
  const pending = f.runner.run(process.execPath, ['-e', 'const b=Buffer.alloc(65536);setInterval(()=>process.stdout.write(b),1);'], { env: f.env, timeout: 5000 });
  const child = [...f.runner.active][0].child;
  let drained = 0;
  child.stdout.on('data', (chunk) => { drained += chunk.length; });
  try {
    await assert.rejects(pending, /output exceeds 2MB; could not confirm process tree termination/);
    assert.ok(drained > 4 * 1024 * 1024, 'output continues after cap, without being retained');
    assert.ok(Date.now() - started < 5000);
    await assert.rejects(f.runner.dispose(), /could not confirm/);
  } finally { await realKill(child); }
  assert.equal(f.runner.active.size, 0);
});
