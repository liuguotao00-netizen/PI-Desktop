'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_INPUT = 2 * 1024 * 1024;
const KILL_TIMEOUT = 2000;

// CommandLineToArgvW/CRT quoting, not shell quoting. No shell is involved.
function quoteWindows(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

class ProcessRunner {
  constructor() {
    this.active = new Set();
    this.disposed = false;
    this.children = new WeakMap();
    this.cleanupError = null;
  }

  async kill(child) {
    const state = this.children.get(child);
    if (!state) throw new Error('Cannot confirm termination of an unmanaged process tree');
    if (state.closed || !child.pid) return; // No PID means spawn itself failed.
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        child.removeListener('close', closed);
        if (error) reject(error); else resolve();
      };
      const closed = () => finish();
      const timer = setTimeout(() => finish(new Error(`Process tree did not close within ${KILL_TIMEOUT}ms`)), KILL_TIMEOUT);
      child.once('close', closed);
      try {
        if (process.platform === 'win32') {
          // This PID is the supervisor, NOT the possibly already-exited target.
          // Its sole, non-inheritable job handle enforces KILL_ON_JOB_CLOSE.
          if (!child.kill('SIGKILL') && !state.closed) throw new Error('Could not terminate job supervisor');
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
      } catch (error) { finish(error); }
    });
  }

  run(executable, args, options = {}) {
    if (this.disposed) return Promise.reject(new Error('Runtime is disposed'));
    return new Promise((resolve, reject) => {
      const input = options.input ?? '';
      if (!(typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array)) {
        reject(new TypeError('Process input must be a string or byte buffer')); return;
      }
      if (Buffer.byteLength(input) > MAX_INPUT) { reject(new Error('Process input exceeds 2MB')); return; }
      const timeout = options.timeout ?? 60000;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) {
        reject(new Error('Invalid process timeout')); return;
      }
      const maxOutput = Math.min(options.maxOutput ?? MAX_OUTPUT, MAX_OUTPUT);
      if (!Number.isSafeInteger(maxOutput) || maxOutput < 1) { reject(new Error('Invalid maxOutput')); return; }
      let child;
      let header;
      try {
        if (typeof executable !== 'string' || executable.includes('\0') || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
          throw new TypeError('Executable and arguments must be NUL-free strings');
        }
        let command = executable;
        let commandArgs = args;
        if (process.platform === 'win32') {
          const targetCommand = [executable, ...args].map(quoteWindows).join(' ');
          if (targetCommand.length >= 32767) throw new Error('Windows process command line is too long');
          const config = Buffer.from(JSON.stringify({ executable, command: targetCommand }));
          const length = Buffer.alloc(4);
          length.writeUInt32LE(config.length);
          header = Buffer.concat([length, config]);
          // Prebuilt helper: no runtime compilation, extraction or TEMP writes.
          command = path.join(__dirname, 'process-helper.exe');
          commandArgs = [];
        }
        child = spawn(command, commandArgs, { shell: false, windowsHide: true, detached: process.platform !== 'win32', cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) { reject(error); return; }
      const state = { closed: false };
      this.children.set(child, state);
      let failure;
      let settled = false;
      let stopping = false;
      let stopTimer;
      const stdout = [];
      const stderr = [];
      let size = 0;
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(stopTimer);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.unref();
        this.active.delete(entry);
        const result = { code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
        stdout.length = 0; stderr.length = 0;
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Process exited ${code ?? signal}: ${result.stderr.slice(0, 4000)}`));
        else resolve(result);
        entry.finish();
      };
      const uncertain = (error) => {
        if (settled) return;
        this.cleanupError = new Error(`${failure.message}; could not confirm process tree termination: ${error.message}`);
        failure = this.cleanupError;
        // Release resources in bounded time, but fail closed: no further tasks
        // may start, and dispose must report the unconfirmed cleanup.
        this.disposed = true;
        finish(child.exitCode, child.signalCode);
      };
      const stop = (error) => {
        if (settled || stopping) return;
        stopping = true;
        failure = error;
        // A second bound protects run/dispose even if kill itself malfunctions.
        stopTimer = setTimeout(() => uncertain(new Error('Termination deadline exceeded')), KILL_TIMEOUT + 250);
        Promise.resolve().then(() => this.kill(child)).then(
          () => finish(child.exitCode, child.signalCode), uncertain);
      };
      const entry = { child, stop, done: null };
      entry.done = new Promise((done) => { entry.finish = done; });
      this.active.add(entry);
      const timer = setTimeout(() => stop(new Error(`Process timed out after ${timeout}ms`)), timeout);
      const collect = (target) => (chunk) => {
        // Drain without retaining/counting more data once cancellation begins.
        if (stopping || settled) return;
        if (chunk.length > maxOutput - size) {
          stop(new Error(maxOutput === MAX_OUTPUT ? 'Process output exceeds 2MB' : `Process output exceeds ${maxOutput} bytes`)); return;
        }
        size += chunk.length;
        target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.on('error', (error) => { stop(error); });
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') stop(error); });
      child.once('close', (code, signal) => {
        state.closed = true;
        if (!stopping) finish(code, signal);
      });
      if (header) child.stdin.write(header);
      child.stdin.end(input);
    });
  }

  async dispose() {
    this.disposed = true;
    const entries = [...this.active];
    for (const entry of entries) entry.stop(new Error('Runtime disposed: process cancelled'));
    await Promise.all(entries.map((entry) => entry.done));
    if (this.cleanupError) throw this.cleanupError;
  }
}

module.exports = { ProcessRunner, MAX_OUTPUT, MAX_INPUT, KILL_TIMEOUT };
