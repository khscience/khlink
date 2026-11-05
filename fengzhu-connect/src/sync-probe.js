// Measures blocking (synchronous) work on the connector's single thread:
// fs *Sync calls, synchronous child processes and node:sqlite statements.
// The connector once stopped answering for 26-40 minutes while using almost
// no CPU; a sync read waiting on a busy disk looks exactly like that. Any call
// slower than a few milliseconds is added to a per-interval tally, which the
// stall watcher prints (and clears) so a stall names what held the thread.
// Must be installed before other modules take references to these functions.
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { performance } = require('node:perf_hooks');

const MIN_MS = 5;
let tally = new Map();
const fdPaths = new Map();

function shorten(target) {
  const text = String(target || '');
  const parts = text.split(/[\\/]+/);
  return parts.length > 4 ? `${parts.slice(0, 2).join('\\')}\\…\\${parts.slice(-2).join('\\')}` : text;
}

function note(key, ms) {
  if (ms < MIN_MS) return;
  const entry = tally.get(key) || { ms: 0, calls: 0, max: 0 };
  entry.ms += ms; entry.calls += 1; entry.max = Math.max(entry.max, ms);
  tally.set(key, entry);
}

function describe(name, args) {
  const first = args[0];
  if (typeof first === 'number') return `${name} ${shorten(fdPaths.get(first) || `fd ${first}`)}`;
  if (typeof first === 'string' || first instanceof URL || Buffer.isBuffer(first)) return `${name} ${shorten(String(first))}`;
  return name;
}

function wrap(target, name, label = (args) => describe(name, args)) {
  const original = target[name];
  if (typeof original !== 'function' || original.__probed) return;
  const wrapped = function probed(...args) {
    const started = performance.now();
    try { return original.apply(this, args); }
    finally { note(label(args), performance.now() - started); }
  };
  // realpathSync.native is a public Node API and is required for Windows
  // extended-length paths. Preserve it when wrapping the parent function.
  if (typeof original.native === 'function') {
    wrapped.native = function probedNative(...args) {
      const started = performance.now();
      try { return original.native.apply(this, args); }
      finally { note(label(args), performance.now() - started); }
    };
  }
  wrapped.__probed = true;
  target[name] = wrapped;
}

let installed = false;
function installSyncProbe() {
  if (installed) return;
  installed = true;
  const openSync = fs.openSync;
  fs.openSync = function probedOpen(file, ...rest) {
    const started = performance.now();
    const fd = openSync.call(this, file, ...rest);
    fdPaths.set(fd, String(file));
    note(`openSync ${shorten(String(file))}`, performance.now() - started);
    return fd;
  };
  const closeSync = fs.closeSync;
  fs.closeSync = function probedClose(fd) { fdPaths.delete(fd); return closeSync.call(this, fd); };
  for (const name of ['readFileSync', 'writeFileSync', 'appendFileSync', 'readSync', 'writeSync', 'statSync', 'lstatSync',
    'fstatSync', 'existsSync', 'readdirSync', 'renameSync', 'copyFileSync', 'unlinkSync', 'mkdirSync', 'realpathSync', 'opendirSync']) wrap(fs, name);
  for (const name of ['execFileSync', 'execSync', 'spawnSync']) {
    wrap(childProcess, name, (args) => `${name} ${shorten(String(args[0]))} ${Array.isArray(args[1]) ? args[1].slice(0, 2).join(' ') : ''}`.trim());
  }
  try {
    const { StatementSync } = require('node:sqlite');
    for (const name of ['get', 'all', 'run', 'iterate']) wrap(StatementSync.prototype, name, () => `sqlite ${name}`);
  } catch { /* no node:sqlite */ }
}

/** The slowest blocking work since the last call, e.g. "readSync G:\…\x.jsonl 41s (3 calls, max 30s)". */
function takeSyncTally(top = 5) {
  const rows = [...tally.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, top)
    .map(([key, v]) => `${key} ${(v.ms / 1000).toFixed(1)}s (${v.calls} calls, max ${(v.max / 1000).toFixed(1)}s)`);
  tally = new Map();
  return rows;
}

module.exports = { installSyncProbe, takeSyncTally };
