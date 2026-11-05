const fs = require('node:fs/promises');

// Diagnostic snapshots change every second. Keep only the newest pending
// snapshot and perform disk IO outside the event loop, including Windows'
// rename/copy fallback. One writer also prevents older writes winning races.
class LatestFileWriter {
  constructor(target, { io = fs, onError = () => {} } = {}) {
    this.target = target; this.io = io; this.onError = onError;
    this.pending = null; this.running = null;
  }

  write(text) {
    this.pending = text;
    if (!this.running) this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  async drain() {
    const temporary = `${this.target}.${process.pid}.tmp`;
    while (this.pending !== null) {
      const text = this.pending; this.pending = null;
      try {
        // flush: the data is on disk before the rename makes it the file.
        await this.io.writeFile(temporary, text, { mode: 0o600, flush: true });
        // Windows refuses the rename while a reader has the target open.
        // Retry first: the copy fallback sizes the target before filling it,
        // so a connector killed mid-copy left a file of NUL bytes (seen
        // 2026-11-05: an 832 KB threads.json of zeros, no history on phones).
        let renamed = false;
        for (let attempt = 0; attempt < 6 && !renamed; attempt += 1) {
          try { await this.io.rename(temporary, this.target); renamed = true; }
          catch (error) {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
          }
        }
        if (!renamed) await this.io.copyFile(temporary, this.target);
      } catch (error) { this.onError(error); }
      finally { await this.io.rm(temporary, { force: true }).catch(() => {}); }
    }
  }
}

module.exports = { LatestFileWriter };
