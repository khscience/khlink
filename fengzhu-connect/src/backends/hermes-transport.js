'use strict';
// How the connector reaches a Hermes Agent install. Hermes runs on Linux; on
// the 3060 computer that is the local WSL distro (`wsl.exe`), while developing
// it may be another machine reached by `ssh`. Every Hermes interaction goes
// through one of the two commands built here, so the backend code is the same.
//
// Config (`hermes.json` beside the connector config, or HERMES_TRANSPORT):
//   { "transport": "wsl", "distro": "Ubuntu-22.04", "user": "ubuntu" }
//   { "transport": "ssh", "host": "WSL" }
//   { "transport": "local" }   (macOS/Linux: Hermes on this computer)
//   { "transport": "windows" } (Hermes's own Windows install, run directly;
//                               found by itself in %LOCALAPPDATA%\hermes)
// plus optional "hermesBin" (default ~/.local/bin/hermes), "python" (python3)
// and "home" (Hermes home, default ~/.hermes inside the host).
const fs = require('node:fs');
const os = require('node:os');
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

function readTransportConfig(configDir, env = process.env, { platform = process.platform, homedir = os.homedir(), exists = fs.existsSync } = {}) {
  if (env.HERMES_TRANSPORT) {
    try { return normalize(JSON.parse(env.HERMES_TRANSPORT)); } catch { /* fall through to the file */ }
  }
  const file = path.join(configDir || '.', 'hermes.json');
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { raw = null; }
  if (raw) return normalize(raw);
  // macOS/Linux with Hermes installed in its default place: use it directly,
  // no hermes.json needed (hermes.json with "enabled": false turns it off).
  if (platform !== 'win32' && exists(path.join(homedir, '.local', 'bin', 'hermes'))) return normalize({ transport: 'local' });
  // Windows with Hermes's own Windows installer: likewise.
  if (platform === 'win32') return windowsInstall(env, { homedir, exists });
  return null;
}

// Hermes's Windows installer keeps its home in %LOCALAPPDATA%\hermes and the
// program in a venv under it (hermes.exe, with python.exe beside it).
function windowsInstall(env = process.env, { homedir = os.homedir(), exists = fs.existsSync, home = '' } = {}) {
  const hermesHome = home || env.HERMES_HOME || path.win32.join(env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local'), 'hermes');
  const scripts = path.win32.join(hermesHome, 'hermes-agent', 'venv', 'Scripts');
  const bin = path.win32.join(scripts, 'hermes.exe');
  if (!exists(bin)) return null;
  return { transport: 'windows', host: '', distro: '', user: '', hermesBin: bin, python: path.win32.join(scripts, 'python.exe'), home: hermesHome, label: '' };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled === false) return null;
  if (raw.transport === 'windows') {
    const found = windowsInstall(process.env, { home: raw.home ? String(raw.home) : '' });
    if (!found) return null;
    if (raw.hermesBin) found.hermesBin = String(raw.hermesBin);
    if (raw.python) found.python = String(raw.python);
    if (raw.label) found.label = String(raw.label);
    return found;
  }
  const transport = raw.transport === 'ssh' ? 'ssh' : raw.transport === 'local' ? 'local' : 'wsl';
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
  // A login shell, so ~ and the user's PATH resolve as in a terminal.
  if (config.transport === 'local') return { file: process.env.HERMES_SHELL || '/bin/bash', args: ['-lc', line] };
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
  constructor(config, { spawnFn = spawn, fsApi = fs.promises } = {}) {
    this.config = config;
    this.spawnFn = spawnFn;
    this.fs = fsApi;
    // Hermes on Windows itself: its programs are started directly (no shell)
    // and its folders and files are Windows paths on this computer.
    this.windows = config.transport === 'windows';
    this.pathLib = this.windows ? path.win32 : path.posix;
  }

  /** Whether a folder the user typed names one place on the Hermes host. */
  isAbsolute(dir) {
    const text = String(dir || '');
    return this.windows ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(text) : text.startsWith('/');
  }

  /** Where a file sent from the phone is put for Hermes to read. */
  uploadPath(name) { return this.windows ? path.win32.join(os.tmpdir(), 'khlink-uploads', name) : `/tmp/khlink-uploads/${name}`; }

  /** The user's home folder on the Hermes host ('' when it cannot be told). */
  async homeDir() {
    if (this.windows) return os.homedir();
    const result = await this.run('printf %s "$HOME"', { timeoutMs: 20_000 });
    const home = result.stdout.toString('utf8').trim();
    return home.startsWith('/') ? home : '';
  }

  // Hermes's programs find their home through HERMES_HOME; Python speaks UTF-8.
  windowsEnv() {
    return { ...process.env, HERMES_HOME: this.config.home, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  }

  describe() {
    if (this.windows) return `Windows (${this.config.home})`;
    if (this.config.transport === 'local') return 'this computer';
    return this.config.transport === 'ssh' ? `ssh ${this.config.host}` : `wsl${this.config.distro ? ` ${this.config.distro}` : ''}`;
  }

  // Long-lived `hermes acp` (stdio JSON-RPC). The caller owns the child.
  spawnAcp() {
    if (this.windows) return this.spawnFn(this.config.hermesBin, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.windowsEnv() });
    const { file, args } = hostCommand(this.config, `${envPrefix(this.config)}exec ${shellQuote(this.config.hermesBin)} acp`);
    return this.spawnFn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }

  // Run one command line; resolves { code, stdout(Buffer), stderr }.
  run(line, options = {}) {
    if (this.windows) return Promise.reject(Object.assign(new Error('Windows 上的 Hermes 不经 shell 运行命令'), { code: 'hermes-no-shell' }));
    const { file, args } = hostCommand(this.config, line);
    return this.execute(file, args, options);
  }

  // Run one program; resolves { code, stdout(Buffer), stderr }.
  execute(file, args, { input = null, timeoutMs = 30_000, maxBytes = 64 * 1024 * 1024, env } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawnFn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(env ? { env } : {}) }); }
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
    const options = { input: script, timeoutMs: 20_000, maxBytes: 32 * 1024 * 1024 };
    const result = this.windows
      ? await this.execute(this.config.python, ['-', ...args.map(String)], { ...options, env: this.windowsEnv() })
      : await this.run(`${envPrefix(this.config)}${shellQuote(this.config.python)} - ${args.map(shellQuote).join(' ')}`, options);
    if (result.code !== 0) throw Object.assign(new Error(`Hermes 状态读取失败：${result.stderr.trim().slice(0, 300) || `exit ${result.code}`}`), { code: 'hermes-store' });
    const text = result.stdout.toString('utf8').trim();
    let data; try { data = JSON.parse(text); } catch { throw Object.assign(new Error('Hermes 状态读取返回了无法解析的内容'), { code: 'hermes-store' }); }
    if (data?.error) throw Object.assign(new Error(`Hermes 状态读取失败：${data.error}`), { code: data.error });
    return data;
  }

  async readFile(posixPath, maxBytes = 25 * 1024 * 1024) {
    if (this.windows) {
      let stat = null;
      try { stat = await this.fs.stat(posixPath); } catch { stat = null; }
      if (!stat || !stat.isFile()) throw Object.assign(new Error(`读不到 Hermes 主机上的文件：${posixPath}`), { code: 'hermes-file' });
      if (stat.size > maxBytes) throw Object.assign(new Error('Hermes 返回的数据过大'), { code: 'hermes-too-large' });
      return this.fs.readFile(posixPath);
    }
    const result = await this.run(`cat -- ${shellQuote(posixPath)}`, { timeoutMs: 60_000, maxBytes });
    if (result.code !== 0) throw Object.assign(new Error(`读不到 Hermes 主机上的文件：${posixPath}`), { code: 'hermes-file' });
    return result.stdout;
  }

  async writeFile(posixPath, buffer) {
    if (this.windows) {
      try {
        await this.fs.mkdir(path.win32.dirname(posixPath), { recursive: true });
        await this.fs.writeFile(posixPath, buffer);
      } catch (error) { throw Object.assign(new Error(`没能把附件放到 Hermes 主机：${error.message}`), { code: 'hermes-file' }); }
      return posixPath;
    }
    const dir = path.posix.dirname(posixPath);
    const result = await this.run(`mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(posixPath)}`, { input: buffer, timeoutMs: 60_000 });
    if (result.code !== 0) throw Object.assign(new Error(`没能把附件放到 Hermes 主机：${result.stderr.trim().slice(0, 200)}`), { code: 'hermes-file' });
    return posixPath;
  }

  /** A long-running `hermes …` the caller follows and may kill (one CLI turn). */
  spawnHermes(args, { cwd } = {}) {
    if (this.windows) {
      return this.spawnFn(this.config.hermesBin, args.map(String), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: this.windowsEnv(), ...(cwd ? { cwd } : {}) });
    }
    const line = `${cwd ? `cd ${shellQuote(cwd)} && ` : ''}${envPrefix(this.config)}${shellQuote(this.config.hermesBin)} ${args.map(shellQuote).join(' ')}`;
    const { file, args: argv } = hostCommand(this.config, line);
    return this.spawnFn(file, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  }

  async hermes(args, options = {}) {
    if (this.windows) return this.execute(this.config.hermesBin, args.map(String), { ...options, env: this.windowsEnv() });
    return this.run(`${envPrefix(this.config)}${shellQuote(this.config.hermesBin)} ${args.map(shellQuote).join(' ')}`, options);
  }
}

module.exports = { HermesTransport, readTransportConfig, normalize, hostCommand, shellQuote, windowsInstall };
