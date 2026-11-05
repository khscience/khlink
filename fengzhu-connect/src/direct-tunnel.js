const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { Event } = require('werift');

// Cross-network direct connections. Phones on mobile data sit behind a
// carrier NAT that gives every peer a new port, and home routers only accept
// replies from the exact port they sent to, so WebRTC cannot get through
// without a third party. Like khQuant's web workbench, the connector then
// opens a Cloudflare quick tunnel (no account, no khLink server): cloudflared
// dials out to Cloudflare and forwards one public https URL to a WebSocket on
// 127.0.0.1. Frames stay sealed with the pairing key end to end; the first
// frame on a connection must open with that key or the connection is closed.
const TUNNEL_URL = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/i;
const READY = /Registered tunnel connection/i;
const MAX_PENDING = 4;
const HELLO_TIMEOUT_MS = 15_000;

function findCloudflared(env = process.env) {
  const names = process.platform === 'win32' ? ['cloudflared.exe'] : ['cloudflared'];
  const roots = [
    env.KHLINK_CLOUDFLARED && path.dirname(env.KHLINK_CLOUDFLARED),
    // The combined installer puts it next to the connector.
    path.join(__dirname, '..', 'tools'),
    path.join(__dirname, '..', '..', 'tools'),
    ...String(env.PATH || '').split(path.delimiter),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'cloudflared'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'cloudflared'),
  ].filter(Boolean);
  if (env.KHLINK_CLOUDFLARED && fs.existsSync(env.KHLINK_CLOUDFLARED)) return env.KHLINK_CLOUDFLARED;
  for (const root of roots) for (const name of names) {
    const candidate = path.join(root, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

/** A WebSocket dressed as the data channel FramedChannel expects. */
function socketChannel(socket) {
  const onMessage = new Event(); const stateChange = new Event();
  socket.on('message', (data) => onMessage.execute(data.toString()));
  socket.on('close', () => stateChange.execute('closed'));
  socket.on('error', () => {});
  return {
    get readyState() { return socket.readyState === 1 ? 'open' : socket.readyState === 0 ? 'connecting' : 'closed'; },
    get bufferedAmount() { return socket.bufferedAmount; },
    send: (raw) => socket.send(raw),
    close: () => { try { socket.close(); } catch {} },
    onMessage, stateChange, transport: 'tunnel',
  };
}

// Whether a pid is a running cloudflared (and not a reused pid).
function isCloudflared(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  try { process.kill(pid, 0); } catch (error) { if (error.code !== 'EPERM') return Promise.resolve(false); }
  const [command, args] = process.platform === 'win32'
    ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']]
    : ['ps', ['-p', String(pid), '-o', 'comm=']];
  return new Promise((resolve) => execFile(command, args, { windowsHide: true, timeout: 5000 },
    (error, stdout) => resolve(!error && /cloudflared/i.test(String(stdout)))));
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }

class DirectTunnel {
  /**
   * With `stateFile`, cloudflared runs as its own process and its address and
   * local port are written down, so a restarted connector takes the same
   * tunnel over: a reload or update no longer leaves the phone with an
   * address that is gone (a restart of the computer still does).
   */
  constructor({ accept, log = () => {}, binary = findCloudflared(), spawnProcess = spawn, stateFile = null, checkProcess = isCloudflared } = {}) {
    this.accept = accept; this.log = log; this.binary = binary; this.spawnProcess = spawnProcess;
    this.stateFile = stateFile; this.checkProcess = checkProcess;
    this.host = null; this.server = null; this.child = null; this.pid = null; this.pending = 0; this.starting = null;
  }
  get available() { return Boolean(this.binary); }
  get running() {
    if (!this.host) return false;
    if (this.child) return this.child.exitCode === null && this.child.signalCode == null;
    return Boolean(this.pid && alive(this.pid));
  }

  /** Starts once and returns the quick tunnel's subdomain (xxx of xxx.trycloudflare.com). */
  async start(timeoutMs = 45_000) {
    if (this.running) return this.host;
    if (this.starting) return this.starting;
    if (!this.binary) throw new Error('缺少跨网络直连组件，请重新安装 khLink 桌面端');
    this.starting = (async () => (await this.reattach()) || this.open(timeoutMs))().finally(() => { this.starting = null; });
    return this.starting;
  }

  readState() { try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return null; } }
  writeState(state) { fs.writeFileSync(this.stateFile, JSON.stringify(state)); }
  clearState() { try { fs.unlinkSync(this.stateFile); } catch {} }

  /** Takes over the tunnel an earlier connector left running; null when there is none. */
  async reattach() {
    if (this.running) return this.host;
    if (!this.stateFile) return null;
    const state = this.readState();
    if (!state?.host || !state.pid || !state.port) return null;
    if (!(await this.checkProcess(state.pid))) { this.clearState(); return null; }
    try { await this.listen(state.port); } catch (error) {
      this.log(`direct tunnel: port ${state.port} is taken (${error.code || error.message}); a new tunnel is needed`);
      this.kill(state.pid); this.clearState(); return null;
    }
    this.pid = state.pid; this.child = null; this.host = state.host;
    console.log('[fengzhu-connect] direct tunnel reattached');
    return this.host;
  }

  async open(timeoutMs) {
    await this.listen();
    const port = this.server.address().port;
    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
    // Its own process, logging to a file, so that it outlives this connector.
    const logFile = this.stateFile ? `${this.stateFile.replace(/\.json$/, '')}.log` : null;
    const logFd = logFile ? fs.openSync(logFile, 'w') : null;
    let child;
    try {
      child = this.spawnProcess(this.binary, args, logFd === null
        ? { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        : { windowsHide: true, detached: true, stdio: ['ignore', logFd, logFd] });
    } finally { if (logFd !== null) fs.closeSync(logFd); }
    this.child = child; this.pid = child.pid || null;
    const host = await new Promise((resolve, reject) => {
      let found = null; let text = ''; let poll = null;
      const timer = setTimeout(() => { finish(); reject(new Error('跨网络通道启动超时，请检查电脑网络后重试')); }, timeoutMs);
      const check = (chunk) => {
        text = (text + chunk).slice(-8000);
        found = found || (text.match(TUNNEL_URL) || [])[1];
        if (found && READY.test(text)) { finish(); resolve(found.toLowerCase()); }
      };
      const onData = (chunk) => check(chunk.toString());
      const onExit = (code) => { finish(); reject(new Error(`跨网络通道没有启动（${code}）`)); };
      const finish = () => { clearTimeout(timer); clearInterval(poll); child.stdout?.off('data', onData); child.stderr?.off('data', onData); child.off('exit', onExit); };
      child.stdout?.on('data', onData); child.stderr?.on('data', onData); child.once('exit', onExit);
      if (logFile) poll = setInterval(() => { try { text = ''; check(fs.readFileSync(logFile, 'utf8')); } catch {} }, 250);
      child.once('error', (error) => { finish(); reject(new Error(`跨网络通道没有启动：${error.message}`)); });
    }).catch((error) => { this.stop(); throw error; });
    child.once('exit', () => {
      if (this.child !== child) return;
      this.log(`direct tunnel exited (${child.exitCode})`); this.host = null; this.child = null; this.pid = null; if (this.stateFile) this.clearState();
    });
    // Drain the pipes so a chatty cloudflared never blocks on a full buffer.
    child.stdout?.resume(); child.stderr?.resume();
    if (logFile) { child.unref?.(); this.writeState({ pid: child.pid, port, host, startedAt: Date.now() }); }
    this.host = host;
    console.log('[fengzhu-connect] direct tunnel ready');
    return host;
  }

  async listen(port = 0) {
    if (this.server) return;
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    server.on('upgrade', (req, socket, head) => {
      const match = /^\/khlink\/(resume|[a-f0-9-]{36})$/i.exec(String(req.url || '').split('?')[0]);
      if (!match || this.pending >= MAX_PENDING) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => this.connection(ws, match[1].toLowerCase()));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    this.server = server; this.wss = wss;
  }

  connection(ws, target) {
    console.log(`[fengzhu-connect] direct tunnel connection (${target === 'resume' ? 'resume' : 'pairing'})`);
    this.pending++;
    let settled = false;
    const channel = socketChannel(ws);
    const settle = () => { if (!settled) { settled = true; this.pending--; clearTimeout(timer); } };
    const timer = setTimeout(() => { settle(); channel.close(); }, HELLO_TIMEOUT_MS);
    ws.once('close', settle);
    // The hub calls `authenticated` once the first frame opened with the key.
    try { this.accept(target, channel, { authenticated: settle, reject: () => { settle(); channel.close(); } }); }
    catch { settle(); channel.close(); }
  }

  kill(pid) { try { process.kill(pid); } catch {} }

  /** Closes this connector's entrance and leaves the tunnel for the next one. */
  detach() {
    if (!this.stateFile || !this.host || !this.pid) { this.stop(); return; }
    this.child = null; this.host = null; this.pid = null;
    this.closeEntrance();
  }

  /** Ends the tunnel for good: nothing is paired any more, or the mode changed. */
  stop() {
    const child = this.child; const pid = this.pid;
    this.child = null; this.host = null; this.pid = null;
    try { child?.kill(); } catch {}
    if (!child && pid) this.kill(pid);
    if (this.stateFile) {
      // Also a tunnel an earlier connector left that this one never took over.
      const state = this.readState();
      if (state?.pid && state.pid !== pid && alive(state.pid)) this.checkProcess(state.pid).then((yes) => { if (yes) this.kill(state.pid); }).catch(() => {});
      this.clearState();
    }
    this.closeEntrance();
  }

  closeEntrance() {
    for (const client of this.wss?.clients || []) try { client.terminate(); } catch {}
    try { this.server?.close(); } catch {}
    this.server = null; this.wss = null; this.pending = 0;
  }
}

module.exports = { DirectTunnel, findCloudflared, socketChannel, isCloudflared, TUNNEL_URL };
