const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSupervised } = require('../src/supervisor');

const WORKER = path.join(__dirname, 'fixtures', 'supervisor-worker.js');

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test('a reload swaps the connector process; a connector that exits on its own ends the supervisor with its code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-supervisor-'));
  const script = WORKER;
  fs.writeFileSync(path.join(dir, 'reload.request'), ''); // stale request from before: ignored
  let exitCode = null; const logs = [];
  const sup = runSupervised({ dataDir: dir, argv: [script, dir], log: (l) => logs.push(l), pollMs: 30, handoverMs: 2000, exit: (code) => { exitCode = code; } });
  assert.ok(await until(() => lines(path.join(dir, 'pids.txt')).length === 1));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(lines(path.join(dir, 'pids.txt')).length, 1, 'the stale request did not reload');
  fs.writeFileSync(path.join(dir, 'reload.request'), '');
  assert.ok(await until(() => lines(path.join(dir, 'pids.txt')).length === 2), 'a new connector started');
  const [first, second] = lines(path.join(dir, 'pids.txt'));
  assert.notEqual(first, second);
  assert.deepEqual(lines(path.join(dir, 'left.txt')), [first], 'the old one left on its own (handed over)');
  assert.equal(fs.existsSync(path.join(dir, 'reload.request')), false);
  fs.writeFileSync(path.join(dir, 'crash'), '');
  assert.ok(await until(() => exitCode !== null));
  assert.equal(exitCode, 7);
  sup.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the supervisor starts only the Codex host script for the connector, and the host outlives a reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-supervisor-host-'));
  const hostScript = path.join(dir, 'host.js');
  fs.writeFileSync(hostScript, "require('fs').appendFileSync(require('path').join(process.argv[2], 'hosts.txt'), process.pid + require('os').EOL); setInterval(() => {}, 1000);");
  const spawned = [];
  const { spawn } = require('node:child_process');
  const spawnFn = (exe, args, options) => { spawned.push(args[0]); return spawn(exe, args, options); };
  process.env.SPAWN_HOST = hostScript;
  const sup = runSupervised({ dataDir: dir, argv: [WORKER, dir], log: () => {}, pollMs: 30, handoverMs: 2000, spawnFn, hostScript, exit: () => {} });
  try {
    assert.ok(await until(() => lines(path.join(dir, 'hosts.txt')).length === 1), 'host started');
    const [hostPid] = lines(path.join(dir, 'hosts.txt'));
    assert.equal(spawned.filter((s) => s.endsWith('evil.js')).length, 0, 'another script is refused');
    fs.writeFileSync(path.join(dir, 'reload.request'), '');
    assert.ok(await until(() => lines(path.join(dir, 'pids.txt')).length === 2), 'connector swapped');
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotThrow(() => process.kill(Number(hostPid), 0), 'the host is still running');
    assert.equal(lines(path.join(dir, 'hosts.txt')).length, 1, 'no second host');
    try { process.kill(Number(hostPid)); } catch { /* gone */ }
  } finally {
    delete process.env.SPAWN_HOST;
    sup.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
