import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const bin = '/Users/macmini/Desktop/个人项目/PI-Desktop-main/target/debug/pi-desktop-host-core';
const data = mkdtempSync(join(tmpdir(), 'pi-cua-e2e-'));
const child = spawn(bin, [], { env: { ...process.env, PI_DESKTOP_DATA_DIR: data }, stdio: ['pipe','pipe','pipe'] });
let buf = ''; const pending = new Map(); let id = 1;
child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
  buf += chunk;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p(msg); }
  }
});
child.stderr.setEncoding('utf8'); child.stderr.on('data', c => { if (process.env.DEBUG) process.stderr.write(c); });
function call(method, params = {}) {
  const rid = id++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 15000);
    pending.set(rid, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
  });
}
try {
  console.log('handshake', JSON.stringify(await call('app.handshake', { protocolVersion: 11 })).slice(0,200));
  console.log('settings', JSON.stringify(await call('settings.set', { computerUse: { enabled: true, defaultInputPolicy: 'autonomous-in-scope', defaultCapture: 'a11y-and-pixels' } })).slice(0,200));
  console.log('capabilities', JSON.stringify(await call('computer.capabilities')).slice(0,300));
  console.log('requestPermission', JSON.stringify(await call('computer.requestPermission')).slice(0,300));
  const listed = await call('computer.listTargets'); console.log('targets', JSON.stringify(listed).slice(0,600));
  let accessibility = (await call('computer.capabilities')).result?.accessibility;
  for (let attempt = 0; attempt < 120 && accessibility !== 'granted'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    accessibility = (await call('computer.capabilities')).result?.accessibility;
  }
  console.log('accessibility', accessibility);
  const grant = await call('computer.grantCreate', { sessionId: 'e2e-session', origin: 'user', inputPolicy: 'autonomous-in-scope', capture: 'a11y-and-pixels' });
  console.log('grant', JSON.stringify(grant).slice(0,400));
  const targetId = grant.result?.targetId;
  if (targetId) {
    const inspect = await call('computer.inspect', { grantId: grant.result.grantId, sessionId: 'e2e-session', targetId });
    console.log('inspect', JSON.stringify(inspect).slice(0,600));
  }
} catch (e) { console.error('E2E ERROR', e.message); }
child.kill('SIGTERM');
