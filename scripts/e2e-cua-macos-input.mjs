import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../target/debug/pi-desktop-host-core', import.meta.url));
const data = mkdtempSync(join(tmpdir(), 'pi-cua-input-'));
const note = join(data, 'note.txt');
writeFileSync(note, '');
execFileSync('open', ['-a', 'TextEdit', note]);
const child = spawn(bin, [], { env: { ...process.env, PI_DESKTOP_DATA_DIR: data }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let id = 1;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
function call(method, params = {}) {
  const requestId = id++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 20000);
    pending.set(requestId, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await call('app.handshake', { protocolVersion: 11 });
  await call('settings.set', { computerUse: { enabled: true } });
  const capabilities = await call('computer.capabilities');
  console.log('capabilities', JSON.stringify(capabilities.result));
  await call('computer.requestPermission');
  const created = await call('session.create', { mode: 'agent', title: 'CUA input E2E' });
  const sessionId = created.result?.session?.id;
  if (!sessionId) throw new Error(`session.create failed: ${JSON.stringify(created.error ?? created.result)}`);
  console.log('session', sessionId);
  await sleep(1200);
  let target;
  for (let attempt = 0; attempt < 20 && !target; attempt += 1) {
    const listed = await call('computer.listTargets');
    target = listed.result?.targets?.find((entry) =>
      !entry.refusedReason && (entry.title === 'note.txt' || /文本编辑|textedit/i.test(`${entry.appKey} ${entry.appName}`)),
    );
    if (!target) await sleep(500);
  }
  if (!target) throw new Error(`TextEdit target not found: ${JSON.stringify((await call('computer.listTargets')).result?.targets?.map((entry) => ({ appKey: entry.appKey, appName: entry.appName, title: entry.title, refused: entry.refusedReason })))}`);
  console.log('target', target.appName, target.title);
  const grant = (await call('computer.grantCreate', {
    sessionId,
    origin: 'user',
    targetId: target.targetId,
    inputPolicy: 'autonomous-in-scope',
    capture: 'a11y-and-pixels',
  })).result;
  console.log('grant', grant.grantId, 'budget', grant.remainingBudget);
  const inspectResponse = await call('computer.inspect', { grantId: grant.grantId, sessionId });
  if (inspectResponse.error) throw new Error(`inspect: ${JSON.stringify(inspectResponse.error)}`);
  const inspected = inspectResponse.result;
  const node = inspected.nodes.find((entry) => /AXTextArea|AXTextField/.test(entry.role));
  if (!node) throw new Error('no editable node');
  console.log('editable', node.role, node.uid);
  const set = await call('computer.act', {
    grantId: grant.grantId,
    sessionId,
    expectedRevision: inspected.revision,
    action: { kind: 'set_value', uid: node.uid, text: 'PI-Desktop CUA E2E' },
  });
  console.log('set_value', JSON.stringify(set.result ?? set.error));
  const text = execFileSync('osascript', ['-e', 'tell application "TextEdit" to get text of document 1']).toString();
  console.log('text', JSON.stringify(text.trim()));
  if (!text.includes('PI-Desktop CUA E2E')) throw new Error('typed text was not observed in TextEdit');
  const afterResponse = await call('computer.inspect', { grantId: grant.grantId, sessionId });
  if (afterResponse.error) throw new Error(`inspect after set_value: ${JSON.stringify(afterResponse.error)}`);
  const after = afterResponse.result;
  const menuButton = after.nodes.find((entry) => entry.role === 'AXMenuButton');
  if (!menuButton) throw new Error('no menu button');
  const clicked = await call('computer.act', {
    grantId: grant.grantId,
    sessionId,
    expectedRevision: after.revision,
    action: { kind: 'click', uid: menuButton.uid },
  });
  console.log('click', JSON.stringify(clicked.result ?? clicked.error));
  await call('computer.grantRevoke', { reason: 'e2e-complete' });
  console.log('revoked');
} catch (error) {
  console.error('E2E INPUT FAILED', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  try { execFileSync('osascript', ['-e', 'tell application "TextEdit" to close documents saving no']); } catch {}
  rmSync(data, { recursive: true, force: true });
}
