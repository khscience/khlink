const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { JsonLineReader, rpcIdFromPrefix, oversizedRpcError, isReadOnlyRpc } = require('./json-line-reader');
// Resolved on use: codex-host.js requires this file too (for findCodexBinary),
// and a top-level require would warn about the circular dependency.
const hostModule = () => require('./codex-host');

// A bare command name on PATH, the way spawn() would find it.
function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try { if (fs.statSync(file).isFile()) return file; } catch { /* not here */ }
    }
  }
  return null;
}

// The installed Codex binary, or null when this computer has none. khLink
// works without Codex: the other agents must not wait for, or fail with, it.
function resolveCodexBinary(configured) {
  const found = codexCandidates(configured).find((candidate) => candidate === 'codex' ? onPath('codex') : fs.existsSync(candidate));
  return found === 'codex' ? 'codex' : found || null;
}

function findCodexBinary(configured) { return resolveCodexBinary(configured) || 'codex'; }

function codexNotInstalled() {
  return Object.assign(new Error('这台电脑没有安装 Codex'), { code: 'CODEX_NOT_INSTALLED', delivery: 'not_sent' });
}

function codexCandidates(configured) {
  const candidates = [];
  if (configured) candidates.push(configured);
  const local = process.env.LOCALAPPDATA || '';
  const userBin = path.join(process.env.USERPROFILE || '', '.codex', 'bin', 'codex.cmd');
  const windowsApps = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps');
  try {
    for (const dir of fs.readdirSync(windowsApps).filter((n) => n.startsWith('OpenAI.Codex_')).sort().reverse()) {
      candidates.push(path.join(windowsApps, dir, 'app', 'resources', 'codex.exe'));
    }
  } catch {}
  const desktopLocal = path.join(local, 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(desktopLocal)) {
    // The folder names are content hashes, not versions: the newest install is
    // the one the desktop app runs (and the one with its newest models).
    const installs = [];
    for (const dir of fs.readdirSync(desktopLocal)) {
      const exe = path.join(desktopLocal, dir, 'codex.exe');
      try { installs.push({ exe, mtimeMs: fs.statSync(exe).mtimeMs }); } catch { /* an emptied old install */ }
    }
    for (const install of installs.sort((a, b) => b.mtimeMs - a.mtimeMs)) candidates.push(install.exe);
  }
  candidates.push(userBin, 'codex');
  return candidates;
}

class CodexClient extends EventEmitter {
  constructor(config) {
    super(); this.config = config; this.child = null; this.pending = new Map(); this.serverRequests = new Map();
    this.nextId = 0; this.requestPrefix = crypto.randomUUID(); this.ready = false; this.version = 'unknown'; this.dangerousOperationsEnabled = false;
    this.reader = new JsonLineReader({ onLine: (line) => {
      let message; try { message = JSON.parse(line); } catch { return; }
      this.onMessage(message);
    }, onOverflow: ({ prefix }) => {
      const id = rpcIdFromPrefix(prefix);
      const pending = this.pending.get(id);
      if (pending) this.onMessage(oversizedRpcError(id, isReadOnlyRpc(pending.method) ? 'not_sent' : 'uncertain'));
      this.emit('diagnostic', 'Oversized Codex RPC frame was discarded; use paginated history');
    } });
    this.host = null; this.mode = 'direct'; this.hostInitialized = false;
    this.restartPromise = null;
  }

  async start() {
    if (this.ready) return;
    // Fail at once instead of retrying a host that can never start.
    if (!resolveCodexBinary(this.config.codexBin)) throw codexNotInstalled();
    if (this.useHost()) {
      const state = await hostModule().ensureCodexHost(this.config);
      // Right after a restart the host may not have noticed yet that the old
      // connector's socket is gone; it frees the controller seat within seconds.
      for (let attempt = 0; ; attempt++) {
        try { this.host = await hostModule().connectHost(state); break; }
        catch (error) {
          if (!/already controlled/.test(error.message) || attempt >= 10) throw error;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      this.mode = 'host'; this.version = state.codexVersion || 'unknown';
      this.hostInitialized = Boolean(this.host.state?.initialized);
      this.host.on('message', (message) => this.onMessage(message));
      this.host.on('error', (error) => this.emit('diagnostic', error.message));
      this.host.on('close', () => {
        if (this.host) { this.host = null; this.hostInitialized = false; this.ready = false;
          this.rejectPending('Codex host transport disconnected');
          this.emit('offline', { reason: 'codex_host_disconnect' }); }
      });
      if (!this.hostInitialized) {
        const initialized = await this.request('initialize', { clientInfo: { name: 'fengzhu-connect', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        this.hostInitialized = true; this.ready = true; this.dangerousOperationsEnabled = Boolean(initialized);
      } else {
        this.ready = true; this.dangerousOperationsEnabled = true;
      }
      return;
    }
    const bin = findCodexBinary(this.config.codexBin);
    try { this.version = execFileSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim(); } catch { this.version = 'unknown'; }
    const isCmd = /\.(cmd|bat)$/i.test(bin);
    const child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
      cwd: fs.existsSync(this.config.workspace) ? this.config.workspace : process.env.USERPROFILE,
      windowsHide: true, shell: isCmd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Fengzhu Mobile' },
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.emit('diagnostic', String(chunk).slice(-2000)));
    // A failed spawn has no 'close' handler of its own and crashed the process.
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.child = null; this.ready = false;
      this.rejectPending(`Codex app-server failed to start: ${error.message}`);
    });
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      this.rejectPending(`Codex app-server exited: ${code}`);
      this.emit('offline', { reason: 'app_server_exit', code });
    });
    const initialized = await this.request('initialize', { clientInfo: { name: 'fengzhu-connect', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.ready = true; this.dangerousOperationsEnabled = Boolean(initialized);
  }

  async stop() {
    if (this.mode === 'host') {
      // The host is deliberately detached so a short connector reconnect does
      // not interrupt an in-flight Codex turn. A real connector shutdown is a
      // different operation: leaving that detached process alive keeps its
      // app-server writer locks open and makes the next Desktop/mobile writer
      // report “already opened in another application”. Capture its state
      // before closing the transport and terminate only the host we own.
      const host = this.host;
      const hostState = host?.state || hostModule().readState(this.config);
      this.host = null; this.ready = false; this.reader.reset();
      this.rejectPending('Codex connector transport closed'); this.serverRequests.clear();
      host?.close?.(); this.mode = 'direct'; this.hostInitialized = false;
      await terminateOwnedHost(this.config, hostState);
      return;
    }
    const child = this.child;
    this.child = null; this.ready = false; this.reader.reset();
    this.rejectPending('Codex app-server restarted'); this.serverRequests.clear();
    if (!child || child.exitCode !== null) return;
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }

  async restart() {
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = (async () => {
      // The connector normally talks to an isolated persistent host process.
      // Reconnecting its socket is not enough after Codex reports that the
      // agent loop died: the host may still be forwarding to the same broken
      // app-server child. Terminate only the host recorded by our own state
      // file, wait for that state to disappear, then start a fresh child.
      const hostState = this.mode === 'host' ? (this.host?.state || hostModule().readState(this.config)) : null;
      await this.stop();
      if (hostState?.pid && hostState.pid !== process.pid) {
        try {
          if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(hostState.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
          else process.kill(hostState.pid, 'SIGTERM');
        } catch {}
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const current = hostModule().readState(this.config);
          if (!current || current.pid !== hostState.pid) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      await this.start();
    })();
    try { await this.restartPromise; } finally { this.restartPromise = null; }
  }

  request(method, params = {}, timeoutMs = 30_000) {
    if (!this.isAvailable()) return Promise.reject(Object.assign(new Error('Codex app-server is unavailable'), { delivery: 'not_sent' }));
    // Responses still in the persistent host after a soft reload must never
    // match a new connector's request #1. JSON-RPC accepts string IDs.
    const id = `${this.requestPrefix}:${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`${method} timed out`), {
        code: 'rpc_timeout', method, delivery: isReadOnlyRpc(method) ? 'not_sent' : 'uncertain',
      })); }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      // Register first: a synchronous/very fast transport reply used to be lost.
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { const item = this.pending.get(id); this.pending.delete(id); item?.reject(Object.assign(error, { delivery: 'not_sent', method })); }
    });
  }

  rejectPending(message) {
    for (const item of this.pending.values()) item.reject(Object.assign(new Error(message), {
      code: 'rpc_disconnect', method: item.method, delivery: isReadOnlyRpc(item.method) ? 'not_sent' : 'uncertain',
    }));
    this.pending.clear();
  }

  respond(id, result) { this.send({ jsonrpc: '2.0', id, result }); this.serverRequests.delete(String(id)); }
  send(value) {
    if (this.mode === 'host') this.host.send(value);
    else this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  useHost() { return Boolean(this.config.useCodexHost || process.env.FENGZHU_CODEX_HOST === '1'); }
  isAvailable() { return this.mode === 'host' ? Boolean(this.host && !this.host.closed) : Boolean(this.child?.stdin?.writable); }

  onData(chunk) {
    this.reader.push(chunk);
  }

  onMessage(message) {
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message || 'Codex request failed');
          error.code = message.error.data?.code || message.error.code;
          error.method = pending.method;
          error.delivery = message.error.data?.delivery || 'not_sent';
          if (/agent loop.*(?:died|dead)/i.test(error.message)) error.delivery = 'uncertain';
          pending.reject(error);
        } else pending.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        this.serverRequests.set(String(message.id), message); this.emit('approval', message);
      } else if (message.method) {
        if (/^serverRequest\/resolved$/i.test(message.method)) this.serverRequests.delete(String(message.params?.requestId ?? message.params?.id));
        this.emit('notification', message);
      }
  }
}

async function terminateOwnedHost(config, state) {
  if (!state?.pid || state.pid === process.pid) return;
  // A stale state file must never cause us to kill an unrelated process after
  // PID reuse. The host proves ownership through its loopback auth token.
  if (!(await hostModule().hostIsAlive(state))) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
    } else {
      process.kill(state.pid, 'SIGTERM');
    }
  } catch {}
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = hostModule().readState(config);
    if (!current || current.pid !== state.pid) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

module.exports = { CodexClient, findCodexBinary, resolveCodexBinary };
