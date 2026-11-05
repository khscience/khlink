const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileLog, localDate, cleanStaleTemps } = require('../src/file-log');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-log-')); }

test('writes timestamped lines into a per-day file', () => {
  const dir = tempDir();
  const now = new Date(2026, 8, 26, 19, 30, 5, 7).getTime();
  const log = new FileLog(dir, { now: () => now });
  log.write('ERROR', ['[fengzhu-connect]', 'relay socket silent\n  at x']);
  const text = fs.readFileSync(path.join(dir, `connector-${localDate(now)}.log`), 'utf8');
  assert.match(text, /^2026-09-26 19:30:05\.007 \[ERROR\] \[fengzhu-connect\] relay socket silent\n {6}at x\n$/);
});

test('rotates a file that reached maxBytes', () => {
  const dir = tempDir();
  const now = new Date(2026, 8, 26, 12).getTime();
  const log = new FileLog(dir, { now: () => now, maxBytes: 100 });
  for (let i = 0; i < 5; i++) log.write('INFO', ['x'.repeat(60)]);
  const files = fs.readdirSync(dir).sort();
  assert.ok(files.includes('connector-2026-09-26.log'));
  assert.ok(files.some((name) => name.startsWith('connector-2026-09-26.log.')), `rotated file expected, got ${files}`);
});

test('removes log files older than keepDays', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'connector-2026-08-01.log'), 'old');
  fs.writeFileSync(path.join(dir, 'connector-2026-08-01.log.1'), 'old');
  fs.writeFileSync(path.join(dir, 'connector-2026-09-20.log'), 'recent');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
  const log = new FileLog(dir, { now: () => new Date(2026, 8, 26).getTime(), keepDays: 14 });
  log.write('INFO', ['hello']);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['connector-2026-09-20.log', 'connector-2026-09-26.log', 'notes.txt']);
});

test('uses a custom prefix for the host log and prunes only its own files', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'codex-host-2026-08-01.log'), 'old');
  fs.writeFileSync(path.join(dir, 'connector-2026-08-01.log'), 'keep-other-prefix');
  const log = new FileLog(dir, { now: () => new Date(2026, 8, 26, 12).getTime(), keepDays: 14, prefix: 'codex-host' });
  log.write('INFO', ['host up']);
  const files = fs.readdirSync(dir).sort();
  assert.ok(files.includes('codex-host-2026-09-26.log'));
  assert.ok(!files.includes('codex-host-2026-08-01.log'), 'old host log pruned');
  assert.ok(files.includes('connector-2026-08-01.log'), 'other-prefix files are left alone');
});

test('cleanStaleTemps removes only aged atomic-write leftovers', () => {
  const dir = tempDir();
  const now = 10_000_000;
  fs.writeFileSync(path.join(dir, 'status.json.1234.tmp'), 'x');
  fs.writeFileSync(path.join(dir, 'codex-host.json.5678.tmp'), 'x');
  fs.writeFileSync(path.join(dir, 'status.json'), 'live');
  fs.writeFileSync(path.join(dir, 'recent.9999.tmp'), 'x');
  const old = now - 2 * 60 * 60 * 1000;
  fs.utimesSync(path.join(dir, 'status.json.1234.tmp'), old / 1000, old / 1000);
  fs.utimesSync(path.join(dir, 'codex-host.json.5678.tmp'), old / 1000, old / 1000);
  const removed = cleanStaleTemps(dir, { now: () => now });
  const files = fs.readdirSync(dir).sort();
  assert.equal(removed, 2);
  assert.deepEqual(files, ['recent.9999.tmp', 'status.json']);
});
