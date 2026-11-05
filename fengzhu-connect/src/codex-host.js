const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { WORKER_ENV } = require('./supervisor');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { JsonLineReader, rpcIdFromPrefix, oversizedRpcError, isReadOnlyRpc } = require('./json-line-reader');

const HOST_VERSION = 2;   // 2: unanswered server requests survive a connector restart
const STREAM_VERSION = 1; // bounded, linear NDJSON decoding

function stateFile(config) {
  return path.join(path.dirname(config.configFile), 'codex-host.json');
}

function readState(config) {
  try { return JSON.parse(fs.readFileSync(stateFile(config), 'utf8')); } catch { return null; }
}

function writeState(config, value) {
  const target = stateFile(config);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  const text = JSON.stringify(value);
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  // Windows refuses the rename while another process (a reader, antivirus)
  // has the file open: retry briefly, then write it in place.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.renameSync(temporary, target); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      const until = Date.now() + 60 * (attempt + 1); while (Date.now() < until) { /* short synchronous wait */ }
    }
  }
  fs.writeFileSync(target, text, { mode: 0o600 });
  try { fs.unlinkSync(temporary); } catch { /* ignore */ }
}

function clearState(config, expectedToken = null) {
  const current = readState(config);
  if (!current || !expectedToken || current.token === expectedToken) {
    try { fs.unlinkSync(stateFile(config)); } catch {}
  }
}

class HostTransport extends EventEmitter {
  constructor(socket, state) {
    super(); this.socket = socket; this.state = state; this.closed = false;
    this.reader = new JsonLineReader({ onLine: (line) => this.acceptLine(line), onOverflow: ({ prefix }) => {
      const id = rpcIdFromPrefix(prefix, true);
      if (id !== undefined) this.emit('message', oversizedRpcError(id));
      else this.emit('error', new Error('Oversized Codex host frame was discarded'));
    } });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', () => { this.closed = true; this.emit('close'); });
  }

  onData(chunk) {
    this.reader.push(chunk);
  }

  acceptLine(line, defer = false) {
    // ready + replayed approvals can arrive in one TCP packet. Give the
    // awaiting client time to attach its listeners before emitting that replay.
    if (defer) { setImmediate(() => this.acceptLine(line)); return; }
    let value; try { value = JSON.parse(line); } catch { return; }
    if (value.type === 'rpc' && value.message) this.emit('message', value.message);
    else if (value.type === 'host.error') this.emit('error', new Error(value.error || 'Codex host error'));
  }

  send(message) {
    if (this.closed || !this.socket.writable) throw new Error('Codex host is unavailable');
    this.socket.write(`${JSON.stringify({ type: 'rpc', message })}\n`);
  }

  close() {
    if (!this.closed) this.socket.end();
  }
}

async function connectHost(state, timeoutMs = 5000, { probe = false } = {}) {
  if (!state?.port || !state?.token) throw new Error('Codex host state is incomplete');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: state.port });
    let settled = false; let transport = null;
    const timer = setTimeout(() => finish(new Error('Codex host connection timed out')), timeoutMs);
    const reader = new JsonLineReader({ onLine: (line) => {
        if (transport) { transport.acceptLine(line, true); return; }
        let value; try { value = JSON.parse(line); } catch { return; }
        if (value.type === 'ready') {
          transport = new HostTransport(socket, { ...state, initialized: Boolean(value.initialized) });
          reader.maxBytes = transport.reader.maxBytes;
          finish(null, transport); return;
        }
        if (value.type === 'host.error') { finish(new Error(value.error || 'Codex host rejected connection')); return; }
    }, maxBytes: 64 * 1024, onOverflow: () => finish(new Error('Oversized Codex host handshake')) });
    const onHandshakeData = (chunk) => {
      reader.push(chunk);
      if (transport) {
        // Preserve a partial RPC after the ready line as well as complete ones.
        reader.maxBytes = transport.reader.maxBytes;
        reader.onLine = (line) => transport.acceptLine(line);
        reader.onOverflow = transport.reader.onOverflow;
        transport.reader = reader;
      }
    };
    const finish = (error, transport) => {
      if (settled) return; settled = true; clearTimeout(timer);
      socket.off('data', onHandshakeData);
      if (error) { socket.destroy(); reject(error); } else resolve(transport);
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'auth', token: state.token, probe })}\n`));
    socket.on('data', onHandshakeData);
    socket.once('error', (error) => finish(error));
    socket.once('close', () => { if (!settled) finish(new Error('Codex host closed the connection')); });
  });
}

async function hostIsAlive(state, timeoutMs = 1000) {
  try { const transport = await connectHost(state, timeoutMs, { probe: true }); transport.close(); return true; } catch { return false; }
}

function processExists(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }

async function ensureCodexHost(config, { probeAttempts = 3 } = {}) {
  const existing = readState(config);
  if (existing?.version === HOST_VERSION && await hostIsAlive(existing)) return existing;
  // No answer in a second is not death: on a computer busy to 100% the host
  // can take far longer. Starting a second one beside a live host left two
  // app-servers writing the same tasks (seen). Ask again, longer.
  if (existing?.version === HOST_VERSION && existing.pid && existing.pid !== process.pid && processExists(existing.pid)) {
    for (let attempt = 1; attempt < probeAttempts; attempt++) if (await hostIsAlive(existing, 5000 * attempt)) return existing;
    // Still silent: it is ours (the state file says so) and stuck. Stop it, and
    // its app-server, before a fresh one takes the tasks over.
    try { execFileSync('taskkill', ['/PID', String(existing.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 }); } catch { /* already gone */ }
  }
  // An older host version still answering our token is ours: stop it before
  // starting the new one, or both hold Codex thread-writer locks.
  if (existing?.pid && existing.version !== HOST_VERSION && existing.pid !== process.pid && await hostIsAlive(existing)) {
    // /T: its app-server child too (a plain kill would orphan it on Windows).
    try { execFileSync('taskkill', ['/PID', String(existing.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 }); } catch { /* already gone */ }
  }
  let exited = false;
  // Under the supervisor, it starts the host: one started from here would end
  // with this connector (Node's kill-on-exit job), cutting off a phone turn at
  // every connector update. It tells us when that host exits.
  const supervised = Boolean(process.env[WORKER_ENV]) && typeof process.send === 'function';
  const onHostExit = (message) => { if (message?.type === 'codex-host-exit') exited = true; };
  if (supervised) process.on('message', onHostExit);
  const start = () => {
    exited = false;
    if (supervised) { process.send({ type: 'spawn-codex-host', args: [__filename, '--serve', '--config-file', config.configFile] }); return; }
    const child = spawn(process.execPath, [__filename, '--serve', '--config-file', config.configFile], {
      // Keep the host in the connector's Windows process tree. It may outlive a
      // short connector/socket reconnect, but Task Scheduler can then terminate
      // the whole tree on a real maintenance stop instead of leaving a detached
      // app-server behind holding Codex thread-writer-lock files.
      windowsHide: true, detached: false, stdio: 'ignore',
    });
    child.once('exit', () => { exited = true; });
    child.unref();
  };
  start();
  // Right after a restart the old app-server may still be releasing its files
  // ("failed to initialize sqlite state runtime"): the new one exits at once.
  // Start it again after a short pause instead of waiting on a dead host;
  // giving up here would take the connector offline until the next task run.
  const deadline = Date.now() + 90_000;
  let restartAt = 0;
  try {
    while (Date.now() < deadline) {
      const state = readState(config);
      if (state?.version === HOST_VERSION && await hostIsAlive(state)) return state;
      if (exited) {
        if (!restartAt) restartAt = Date.now() + 3_000;
        else if (Date.now() >= restartAt) { restartAt = 0; start(); }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('Codex host did not become ready');
  } finally { if (supervised) process.off('message', onHostExit); }
}

function spawnCodex(config) {
  // Lazy-load to avoid a circular dependency: CodexClient uses this host
  // transport, while the host reuses the binary discovery helper.
  const { findCodexBinary } = require('./codex-client');
  const bin = findCodexBinary(config.codexBin);
  const version = (() => { try { return execFileSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim(); } catch { return 'unknown'; } })();
  const isCmd = /\.(cmd|bat)$/i.test(bin);
  const child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
    cwd: fs.existsSync(config.workspace) ? config.workspace : process.env.USERPROFILE,
    windowsHide: true, shell: isCmd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Fengzhu Mobile' },
  });
  return { child, version, bin };
}

async function serve(config) {
  const token = crypto.randomBytes(32).toString('base64url');
  const { child, version, bin } = spawnCodex(config);
  console.log(`[fengzhu-codex-host] serving pid=${process.pid} codexVersion=${version} appServerPid=${child.pid}`);
  // The app-server's stderr is otherwise discarded; keep a small ring so a crash
  // leaves its last output in the host log instead of vanishing.
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-4000); });
  let controller = null; let initialized = false; let initializeRequestId = null;
  const pendingRequests = new Map();
  // Requests the app-server made of its client (approvals, questions) that
  // nobody has answered yet. A connector restart must not lose them, or the
  // turn waits forever: they are re-sent to the next controller.
  const openServerRequests = new Map();
  const hostState = { version: HOST_VERSION, streamVersion: STREAM_VERSION, pid: process.pid, port: null, token, startedAt: Date.now(), codexVersion: version, bin, initialized: false };
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8'); let authenticated = false;
    const reject = (message) => { try { socket.write(`${JSON.stringify({ type: 'host.error', error: message })}\n`); } catch {} socket.destroy(); };
    const inputReader = new JsonLineReader({ onLine: (line) => {
        let value; try { value = JSON.parse(line); } catch { reject('Invalid host message'); return; }
        if (!authenticated) {
          if (value.type !== 'auth' || value.token !== token) { reject('Host authentication failed'); return; }
          if (value.probe) {
            socket.write(`${JSON.stringify({ type: 'ready', hostVersion: HOST_VERSION, codexVersion: version, initialized })}\n`);
            socket.end(); return;
          }
          if (controller && controller !== socket) { reject('Codex host is already controlled'); return; }
          authenticated = true; controller = socket;
          socket.write(`${JSON.stringify({ type: 'ready', hostVersion: HOST_VERSION, codexVersion: version, initialized })}\n`);
          for (const message of openServerRequests.values()) socket.write(`${JSON.stringify({ type: 'rpc', message })}\n`);
          return;
        }
        if (value.type !== 'rpc' || !value.message || !child.stdin.writable) { reject('Codex host is unavailable'); return; }
        if (value.message.method === 'initialize') initializeRequestId = value.message.id;
        if (value.message.id !== undefined && value.message.method) pendingRequests.set(value.message.id, value.message.method);
        if (value.message.id !== undefined && !value.message.method) openServerRequests.delete(String(value.message.id));
        child.stdin.write(`${JSON.stringify(value.message)}\n`);
    }, onOverflow: ({ prefix }) => {
      const id = rpcIdFromPrefix(prefix, true);
      if (!authenticated || id === undefined) { reject('Oversized host message'); return; }
      socket.write(`${JSON.stringify({ type: 'rpc', message: oversizedRpcError(id, 'not_sent') })}\n`);
    } });
    socket.on('data', (chunk) => inputReader.push(chunk));
    socket.on('close', () => { if (controller === socket) controller = null; });
    socket.on('error', () => { if (controller === socket) controller = null; });
  });
  child.stdout.setEncoding('utf8');
  const outputReader = new JsonLineReader({ onLine: (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && !message.method) pendingRequests.delete(message.id);
        if (message.id !== undefined && message.method) openServerRequests.set(String(message.id), message);
        // Withdrawn by the app-server (answered elsewhere, turn ended).
        if (/^serverRequest\/resolved$/i.test(message.method || '')) openServerRequests.delete(String(message.params?.requestId ?? message.params?.id));
        if (!controller || controller.destroyed) return;
        if (initializeRequestId !== null && message.id === initializeRequestId && !message.error) {
          initialized = true; hostState.initialized = true; writeState(config, hostState);
        }
        controller.write(`{"type":"rpc","message":${line}}\n`);
      } catch {}
  }, onOverflow: ({ prefix, maxBytes }) => {
    const id = rpcIdFromPrefix(prefix);
    const method = pendingRequests.get(id);
    pendingRequests.delete(id);
    console.error(`[fengzhu-codex-host] discarded oversized RPC id=${id ?? 'unknown'} method=${method || 'unknown'} limit=${maxBytes}`);
    if (id !== undefined && controller && !controller.destroyed) {
      controller.write(`${JSON.stringify({ type: 'rpc', message: oversizedRpcError(id, isReadOnlyRpc(method || '') ? 'not_sent' : 'uncertain') })}\n`);
    }
  } });
  child.stdout.on('data', (chunk) => outputReader.push(chunk));
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  hostState.port = address.port;
  writeState(config, hostState);
  console.log(`[fengzhu-codex-host] listening on 127.0.0.1:${address.port}`);
  const cleanup = () => { clearState(config, token); try { server.close(); } catch {} };
  child.once('close', (code) => {
    console.error(`[fengzhu-codex-host] app-server exited code=${code}${stderrTail ? ` stderr-tail:
${stderrTail.trim()}` : ''}`);
    cleanup();
    // Exit the whole host process so a dead app-server never leaves an idle host
    // holding its loopback port; the connector re-spawns a fresh host on demand.
    process.exit(1);
  });
  process.once('SIGINT', () => { console.log('[fengzhu-codex-host] SIGINT'); cleanup(); child.kill(); });
  process.once('SIGTERM', () => { console.log('[fengzhu-codex-host] SIGTERM'); cleanup(); child.kill(); });
}

function parseArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[2] === '--serve') {
  const { loadConfig } = require('./config');
  const { installFileLog } = require('./file-log');
  const config = loadConfig();
  // The host is spawned with stdio:'ignore', so without this file log every
  // host or app-server failure is invisible. Share the connector's logs dir.
  try { installFileLog(path.join(path.dirname(config.configFile), 'logs'), { prefix: 'codex-host' }); } catch {}
  process.on('uncaughtException', (error) => { console.error(`[fengzhu-codex-host] uncaught: ${error?.stack || error}`); process.exit(1); });
  process.on('unhandledRejection', (reason) => { console.error(`[fengzhu-codex-host] unhandled rejection: ${reason?.stack || reason}`); });
  serve(config).catch((error) => { console.error(`[fengzhu-codex-host] ${error.stack || error}`); process.exit(1); });
}

module.exports = { HOST_VERSION, STREAM_VERSION, HostTransport, connectHost, ensureCodexHost, hostIsAlive, readState, stateFile, serve };
