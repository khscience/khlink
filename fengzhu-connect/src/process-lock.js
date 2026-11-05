const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

// Windows reuses PIDs quickly. After the connector is killed, the PID in the
// lock file can belong to an unrelated process (seen in practice: svchost),
// and a pure "is the PID alive" check then blocks every later start. Confirm
// the live PID is really a connector: a node process whose command line runs
// fengzhu-connect and that was created no later than the lock was written.
// Returns true/false, or null when the process cannot be inspected (callers
// then keep the conservative "still running" answer).
function describeWindowsProcess(pid) {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { [pscustomobject]@{ name = $p.Name; cmd = $p.CommandLine; created = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return output ? JSON.parse(output) : { gone: true };
}

function processIsConnector(pid, lockStartedAt, describe = describeWindowsProcess) {
  if (process.platform !== 'win32' && describe === describeWindowsProcess) return null;
  let info;
  try { info = describe(pid); } catch { return null; }
  if (!info || info.gone) return false;
  const name = String(info.name || '').toLowerCase();
  const cmd = String(info.cmd || '').toLowerCase();
  if (name !== 'node.exe' && name !== 'node') return false;
  if (info.cmd != null && !cmd.includes('fengzhu-connect')) return false;
  const startedAt = Number(lockStartedAt);
  const created = Number(info.created);
  // A process created after the lock was written cannot be its owner.
  if (Number.isFinite(startedAt) && startedAt > 0 && Number.isFinite(created) && created > startedAt + 5_000) return false;
  return true;
}

class ProcessLock {
  constructor(file, { isConnector = processIsConnector } = {}) {
    this.file = path.resolve(file);
    this.fd = null;
    this.isConnector = isConnector;
    this.owner = { pid: process.pid, startedAt: Date.now(), host: os.hostname() };
  }

  ownerIsRunning(current) {
    const pid = Number(current?.pid);
    if (!processIsAlive(pid)) return false;
    if (pid === process.pid) return true;
    // The lock file is ours; a live PID from it is only trusted when it is
    // still a connector process (see processIsConnector).
    const verdict = this.isConnector(pid, current?.startedAt);
    return verdict !== false;
  }

  acquire() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.fd = fs.openSync(this.file, 'wx');
        fs.writeFileSync(this.fd, JSON.stringify(this.owner));
        return this;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let current = null;
        try { current = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
        if (this.ownerIsRunning(current)) {
          const owner = current?.pid ? `进程 ${current.pid}` : '另一个进程';
          const duplicate = new Error(`khLink 连接器已在运行（${owner}），已阻止重复启动`);
          duplicate.code = 'EALREADY';
          throw duplicate;
        }
        // Reclaim a lock left by a crashed process. Rename is atomic on the
        // same volume, so concurrent starters cannot both delete the owner.
        const stale = `${this.file}.stale-${process.pid}-${attempt}`;
        try { fs.renameSync(this.file, stale); } catch { continue; }
        try { fs.unlinkSync(stale); } catch {}
      }
    }
    throw new Error('无法取得 khLink 连接器单实例锁');
  }

  release() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch {}
      this.fd = null;
    }
    try {
      const current = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Number(current?.pid) === process.pid) fs.unlinkSync(this.file);
    } catch {}
  }
}

module.exports = { ProcessLock, processIsAlive, processIsConnector };
