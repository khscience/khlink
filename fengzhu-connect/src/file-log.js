// Persistent log for the background connector.
// The scheduled task has no console, so without this every crash or stall left
// no trace. Console output is mirrored into logs/connector-YYYY-MM-DD.log next
// to config.json; files rotate at maxBytes and are kept for keepDays.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const DAY_MS = 24 * 60 * 60 * 1000;

function localDate(now) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTimestamp(now) {
  const d = new Date(now);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${localDate(now)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

class FileLog {
  constructor(dir, { keepDays = 14, maxBytes = 20 * 1024 * 1024, now = Date.now, prefix = 'connector' } = {}) {
    this.dir = dir; this.keepDays = keepDays; this.maxBytes = maxBytes; this.now = now; this.prefix = prefix;
    this.lastCleanupDate = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(date) { return path.join(this.dir, `${this.prefix}-${date}.log`); }

  write(level, args) {
    const now = this.now();
    const date = localDate(now);
    if (this.lastCleanupDate !== date) { this.lastCleanupDate = date; this.cleanup(now); }
    const text = util.format(...args).replace(/\r?\n/g, '\n    ');
    const file = this.fileFor(date);
    try {
      if (fs.existsSync(file) && fs.statSync(file).size >= this.maxBytes) this.rotate(file);
      fs.appendFileSync(file, `${localTimestamp(now)} [${level}] ${text}\n`);
    } catch { /* logging must never take the connector down */ }
  }

  rotate(file) {
    for (let i = 1; i < 1000; i++) {
      const target = `${file}.${i}`;
      if (!fs.existsSync(target)) { fs.renameSync(file, target); return; }
    }
  }

  cleanup(now) {
    try {
      const cutoff = now - this.keepDays * DAY_MS;
      const pattern = new RegExp(`^${this.prefix.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}-(\\d{4})-(\\d{2})-(\\d{2})\\.log(\\.\\d+)?$`);
      for (const name of fs.readdirSync(this.dir)) {
        const match = pattern.exec(name);
        if (!match) continue;
        const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
        if (day < cutoff) fs.rmSync(path.join(this.dir, name), { force: true });
      }
    } catch { /* ignore */ }
  }
}

// Mirror console.log/info/warn/error into the file log. Returns the FileLog.
function installFileLog(dir, options) {
  const log = new FileLog(dir, options);
  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => { log.write(level, args); original(...args); };
  }
  return log;
}

// Remove atomic-write temp leftovers (`<name>.<pid>.tmp`) that a crash between
// writeFileSync and rename can strand in the connector data dir.
function cleanStaleTemps(dir, { maxAgeMs = 60 * 60 * 1000, now = Date.now } = {}) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.\d+\.tmp$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (now() - fs.statSync(full).mtimeMs > maxAgeMs) { fs.rmSync(full, { force: true }); removed += 1; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return removed;
}

module.exports = { FileLog, installFileLog, localDate, cleanStaleTemps };
