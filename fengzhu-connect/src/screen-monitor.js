'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// Windows session status and an opt-in, process-scoped power request. The
// helper is persistent: no PowerShell process is started on each heartbeat.
class ScreenMonitor {
  constructor(home, { platform = process.platform, spawnFn = spawn, onChange = () => {}, now = Date.now, intervalMs = 5_000 } = {}) {
    this.file = path.join(home, 'screen-wake.json');
    this.platform = platform; this.spawnFn = spawnFn; this.onChange = onChange; this.now = now; this.intervalMs = intervalMs;
    this.supported = platform === 'win32'; this.locked = null; this.wakeActive = null; this.wakeError = false; this.enabled = false;
    this.lastKnownLocked = null; this.lockId = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.enabled = saved.enabled === true;
      this.lastKnownLocked = typeof saved.lastKnownLocked === 'boolean' ? saved.lastKnownLocked : null;
      this.lockId = typeof saved.lockId === 'string' && /^[\w-]{1,80}$/.test(saved.lockId) ? saved.lockId : null;
    } catch { /* default off */ }
    this.lastReplyAt = 0; this.lastStartAt = 0; this.buffer = ''; this.child = null; this.stopped = true;
  }

  snapshot() { return { supported: this.supported, locked: this.locked, keepAwake: this.enabled, wakeActive: this.wakeActive, wakeError: this.wakeError, lockId: this.locked === true ? this.lockId : null }; }
  update(values) {
    const before = JSON.stringify(this.snapshot());
    Object.assign(this, values);
    if (before !== JSON.stringify(this.snapshot())) {
      try { this.onChange(this.snapshot()); } catch { /* the next heartbeat still reports this state */ }
    }
  }

  start() {
    if (!this.supported || !this.stopped) return;
    this.stopped = false;
    this.exitHook = () => { try { this.child?.kill(); } catch { /* already exited */ } };
    process.once('exit', this.exitHook);
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs); this.timer.unref?.();
  }

  startHelper() {
    const now = this.now();
    if (this.stopped || this.child || (this.lastStartAt && now - this.lastStartAt < this.intervalMs)) return;
    this.lastStartAt = now;
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = path.join(__dirname, '..', 'scripts', 'screen-monitor.ps1');
    let child;
    try { child = this.spawnFn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { this.update({ locked: null, wakeActive: null, wakeError: this.enabled }); return; }
    this.child = child; this.buffer = ''; this.lastReplyAt = 0;
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      if (this.child !== child) return;
      this.buffer += String(chunk);
      if (this.buffer.length > 8192) { this.buffer = ''; return; }
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.locked !== null && typeof value.locked !== 'boolean') continue;
        if (value.wakeActive !== null && typeof value.wakeActive !== 'boolean') continue;
        if (value.wakeError !== undefined && typeof value.wakeError !== 'boolean') continue;
        this.lastReplyAt = this.now(); this.applySample(value);
      }
    });
    const failed = () => {
      if (this.child !== child) return;
      this.child = null; this.update({ locked: null, wakeActive: null, wakeError: this.enabled });
    };
    child.stdin?.on('error', () => {}); child.on('error', failed); child.on('exit', failed);
  }

  applySample(value) {
    if (typeof value.locked === 'boolean' && (value.locked !== this.lastKnownLocked || value.locked && !this.lockId)) {
      this.lastKnownLocked = value.locked;
      this.lockId = value.locked ? crypto.randomUUID() : null;
      // A stable identifier prevents a connector restart from repeating the
      // same lock alert. Failure to persist must not stop lock detection.
      try { this.persist(this.enabled); } catch { /* retry on next state change */ }
    }
    this.update({ locked: value.locked, wakeActive: value.wakeActive, wakeError: value.wakeError === true });
  }

  persist(enabled) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ enabled, lastKnownLocked: this.lastKnownLocked, lockId: this.lockId }) + '\n');
      fs.renameSync(temp, this.file);
    } finally { try { fs.unlinkSync(temp); } catch { /* renamed or absent */ } }
  }

  poll() {
    if (this.stopped) return;
    const lastActivity = this.lastReplyAt || this.lastStartAt;
    // PowerShell's first Add-Type may be slow on a busy disk. Do not kill an
    // otherwise healthy helper in a startup loop before it can reply.
    const timeout = this.lastReplyAt ? Math.max(30_000, this.intervalMs * 6) : Math.max(60_000, this.intervalMs * 12);
    if (this.child && lastActivity && this.now() - lastActivity > timeout) {
      const stale = this.child; this.child = null; try { stale.kill(); } catch { /* gone */ }
      this.update({ locked: null, wakeActive: null, wakeError: this.enabled });
    }
    if (!this.child) this.startHelper();
    try { this.child?.stdin?.write(this.enabled ? '1\n' : '0\n'); } catch { /* exit handler retries */ }
  }

  setEnabled(enabled) {
    if (!this.supported) throw new Error('这台电脑暂不支持保持屏幕唤醒');
    if (typeof enabled !== 'boolean') throw new Error('无效的屏幕唤醒设置');
    if (enabled === this.enabled) return this.snapshot();
    this.persist(enabled);
    // An acknowledgement from the helper is required before calling it active.
    this.update({ enabled, wakeActive: null, wakeError: false }); this.poll();
    return this.snapshot();
  }

  stop() {
    this.stopped = true; clearInterval(this.timer); this.timer = null;
    if (this.exitHook) { process.removeListener('exit', this.exitHook); this.exitHook = null; }
    const child = this.child; this.child = null;
    try {
      child?.stdin?.end();
      if (child) {
        const deadline = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 2000); deadline.unref?.();
        child.once('exit', () => clearTimeout(deadline));
      }
    } catch { try { child?.kill(); } catch { /* gone */ } }
    this.update({ locked: null, wakeActive: null, wakeError: false });
  }
}

module.exports = { ScreenMonitor };
