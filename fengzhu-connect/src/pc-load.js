// How busy the computer is, for the phone's three load rings (CPU, GPU,
// memory). Kept cheap: CPU and memory come from Node's own counters every few
// seconds (no process started); the GPU from one long-lived `nvidia-smi -l`
// that prints a line per interval, instead of starting a process each time.
const os = require('node:os');
const { spawn } = require('node:child_process');

const percent = (value) => (Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null);

function cpuTimes() {
  let idle = 0; let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) { total += ms; if (kind === 'idle') idle += ms; }
  }
  return { idle, total };
}

/** CPU use between two samples of cpuTimes(), in percent. */
function cpuPercent(before, after) {
  const total = after.total - before.total;
  return total > 0 ? percent(100 * (1 - (after.idle - before.idle) / total)) : null;
}

/** GPU utilisation from an `nvidia-smi --format=csv,noheader,nounits` line (busiest GPU). */
function gpuPercent(line) {
  const values = String(line).split(/[,\r\n]+/).map((part) => Number(part.trim())).filter(Number.isFinite);
  return values.length ? percent(Math.max(...values)) : null;
}

class PcLoad {
  constructor({ intervalMs = 5_000, spawnFn = spawn, log = () => {} } = {}) {
    this.intervalMs = intervalMs; this.spawnFn = spawnFn; this.log = log;
    this.cpu = null; this.gpu = null; this.mem = null; this.at = 0;
    this.gpuFailures = 0; this.gpuAt = 0;
  }

  start() {
    if (this.timer) return;
    let previous = cpuTimes();
    const sample = () => {
      const now = cpuTimes();
      this.cpu = cpuPercent(previous, now); previous = now;
      const total = os.totalmem();
      this.mem = total > 0 ? percent(100 * (1 - os.freemem() / total)) : null;
      this.at = Date.now();
    };
    this.timer = setInterval(sample, this.intervalMs);
    this.timer.unref?.();
    this.startGpu();
  }

  startGpu() {
    if (this.stopped || this.gpuFailures >= 3) return;
    const seconds = Math.max(1, Math.round(this.intervalMs / 1000));
    let child;
    try {
      child = this.spawnFn('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits', '-l', String(seconds)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { this.gpuFailures += 1; return; }
    this.gpuChild = child;
    // A helper process must not keep Node alive on its own (tests, shutdown).
    child.unref?.(); child.stdout?.unref?.();
    let buffer = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const value = gpuPercent(line);
        if (value !== null) { this.gpu = value; this.gpuAt = Date.now(); this.gpuFailures = 0; }
      }
    });
    const retry = () => {
      if (this.gpuChild !== child) return;
      this.gpuChild = null; this.gpu = null;
      if (this.stopped) return;
      this.gpuFailures += 1; // no NVIDIA GPU / driver: give up after a few tries
      const timer = setTimeout(() => this.startGpu(), 60_000); timer.unref?.();
    };
    child.on('error', retry); child.on('exit', retry);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer); this.timer = null;
    try { this.gpuChild?.kill(); } catch { /* gone */ }
    this.gpuChild = null;
  }

  /** Latest sample for the phone; null before the first one. GPU null without an NVIDIA GPU. */
  snapshot() {
    if (!this.at) return null;
    const gpuFresh = this.gpuAt && Date.now() - this.gpuAt < 4 * this.intervalMs;
    return { cpu: this.cpu, gpu: gpuFresh ? this.gpu : null, mem: this.mem, at: this.at };
  }
}

module.exports = { PcLoad, cpuPercent, gpuPercent };
