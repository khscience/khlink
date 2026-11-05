'use strict';
// How the connector reaches a Hermes Agent install. Hermes runs on Linux; on
// the 3060 computer that is the local WSL distro (`wsl.exe`), while developing
// it may be another machine reached by `ssh`. Every Hermes interaction goes
// through one of the two commands built here, so the backend code is the same.
//
// Config (`hermes.json` beside the connector config, or HERMES_TRANSPORT):
//   { "transport": "wsl", "distro": "Ubuntu-22.04", "user": "ubuntu" }
//   { "transport": "ssh", "host": "WSL" }
// plus optional "hermesBin" (default ~/.local/bin/hermes), "python" (python3)
// and "home" (Hermes home, default ~/.hermes inside the host).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_BIN = '~/.local/bin/hermes';
const STORE_SCRIPT = path.join(__dirname, 'hermes-store.py');

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(text) && !text.startsWith('~')) return text;
  if (text.startsWith('~/') && /^[A-Za-z0-9_@%+=:,./~-]+$/.test(text)) return text; // keep ~ expansion
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function readTransportConfig(configDir, env = process.env) {
  if (env.HERMES_TRANSPORT) {
    try { return normalize(JSON.parse(env.HERMES_TRANSPORT)); } catch { /* fall through to the file */ }
  }
  const file = path.join(configDir || '.', 'hermes.json');
  try { return normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled === false) return null;
  const transport = raw.transport === 'ssh' ? 'ssh' : 'wsl';
  if (transport === 'ssh' && !raw.host) return null;
  return {
    transport,
    host: raw.host ? String(raw.host) : '',
    distro: raw.distro ? String(raw.distro) : '',
    user: raw.user ? String(raw.user) : '',
    hermesBin: raw.hermesBin ? String(raw.hermesBin) : DEFAULT_BIN,
    python: raw.python ? String(raw.python) : 'python3',
    home: raw.home ? String(raw.home) : '',
    label: raw.label ? String(raw.label) : '',
  };
}

// argv for running one POSIX command line on the Hermes host.
function hostCommand(config, line) {
  if (config.transport === 'ssh') {
    return { file: process.env.HERMES_SSH || 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', config.host, line] };
  }
  const args = [];
  if (config.distro) args.push('-d', config.distro);
  if (config.user) args.push('-u', config.user);
  // `bash -lc` so ~ and the user's PATH resolve like an interactive shell.
  args.push('--', 'bash', '-lc', line);
  return { file: process.env.HERMES_WSL || 'wsl.exe', args };
}

function envPrefix(config) {
  return config.home ? `HERMES_HOME=${shellQuote(config.home)} ` : '';
}

class HermesTransport {
  constructor(config, { spawnFn = spawn } = {}) {
    this.config = config;
    this.spawnFn = spawnFn;
  }

  describe() {
    return this.config.transport === 'ssh' ? `ssh ${this.config.host}` : `wsl${this.config.distro ? ` ${this.config.distro}` : ''}`;
  }

  // Long-lived `hermes acp` (stdio JSON-RPC). The caller owns the child.
  spawnAcp() {
    const { file, args } = hostCommand(this.config, `${envPrefix(this.config)}exec ${shellQuote(this.config.hermesBin)} acp`);
    return this.spawnFn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }

  // Run one command line; resolves { code, stdout(Buffer), stderr }.
  run(line, { input = null, timeoutMs = 30_000, maxBytes = 64 * 1024 * 1024 } = {}) {
    const { file, args } = hostCommand(this.config, line);
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawnFn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch (error) { reject(error); return; }
      const out = []; let outBytes = 0; let err = ''; let done = false;
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(Object.assign(new Error('Hermes 主机响应超时'), { code: 'hermes-timeout' })); }, timeoutMs);
      timer.unref?.();
      child.stdout.on('data', (chunk) => {
        outBytes += chunk.length;
        if (outBytes > maxBytes) { try { child.kill(); } catch {} finish(Object.assign(new Error('Hermes 返回的数据过大'), { code: 'hermes-too-large' })); return; }
        out.push(chunk);
      });
      child.stderr.on('data', (chunk) => { if (err.length < 8192) err += chunk.toString('utf8'); });
      child.on('error', (error) => finish(error));
      child.on('close', (code) => finish(null, { code, stdout: Buffer.concat(out), stderr: err }));
      if (input != null) child.stdin.end(input); else child.stdin.end();
    });
  }

  // The read-only state helper: one JSON document per call.
  async store(...args) {
    const script = fs.readFileSync(STORE_SCRIPT);
    const line = `${envPrefix(this.config)}${shellQuote(this.config.python)} - ${args.map(shellQuote).join(' ')}`;
    const result = await this.run(line, { input: script, timeoutMs: 20_000, maxBytes: 32 * 1024 * 1024 });
    if (result.code !== 0) throw Object.assign(new Error(`Hermes 状态读取失败：${result.stderr.trim().slice(0, 300) || `exit ${result.code}`}`), { code: 'hermes-store' });
    const text = result.stdout.toString('utf8').trim();
    let data; try { data = JSON.parse(text); } catch { throw Object.assign(new Error('Hermes 状态读取返回了无法解析的内容'), { code: 'hermes-store' }); }
    if (data?.error) throw Object.assign(new Error(`Hermes 状态读取失败：${data.error}`), { code: data.error });
    return data;
  }

  async readFile(posixPath, maxBytes = 25 * 1024 * 1024) {
    const result = await this.run(`cat -- ${shellQuote(posixPath)}`, { timeoutMs: 60_000, maxBytes });
    if (result.code !== 0) throw Object.assign(new Error(`读不到 Hermes 主机上的文件：${posixPath}`), { code: 'hermes-file' });
    return result.stdout;
  }

  async writeFile(posixPath, buffer) {
    const dir = path.posix.dirname(posixPath);
    const result = await this.run(`mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(posixPath)}`, { input: buffer, timeoutMs: 60_000 });
    if (result.code !== 0) throw Object.assign(new Error(`没能把附件放到 Hermes 主机：${result.stderr.trim().slice(0, 200)}`), { code: 'hermes-file' });
    return posixPath;
  }

  async hermes(args, options = {}) {
    return this.run(`${envPrefix(this.config)}${shellQuote(this.config.hermesBin)} ${args.map(shellQuote).join(' ')}`, options);
  }
}

module.exports = { HermesTransport, readTransportConfig, normalize, hostCommand, shellQuote };
