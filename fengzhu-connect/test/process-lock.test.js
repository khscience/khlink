const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProcessLock, processIsConnector } = require('../src/process-lock');

test('process lock reclaims a lock whose live PID was reused by another program', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-process-lock-reused-'));
  const file = path.join(root, 'connector.lock');
  try {
    // The parent process is alive but is not a connector (like svchost reusing the PID).
    fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, startedAt: 1 }));
    const lock = new ProcessLock(file, { isConnector: () => false }).acquire();
    lock.release();
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('process lock stays conservative when the owner cannot be inspected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-process-lock-unknown-'));
  const file = path.join(root, 'connector.lock');
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, startedAt: 1 }));
    assert.throws(() => new ProcessLock(file, { isConnector: () => null }).acquire(), /已在运行/);
    assert.throws(() => new ProcessLock(file, { isConnector: () => true }).acquire(), /已在运行/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('processIsConnector recognises only a connector created before the lock', () => {
  const lockAt = 1_000_000;
  const connector = { name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" "I:\\x\\fengzhu-connect\\src\\cli.js" start', created: lockAt - 50 };
  assert.equal(processIsConnector(1, lockAt, () => connector), true);
  assert.equal(processIsConnector(1, lockAt, () => ({ name: 'svchost.exe', cmd: 'svchost.exe -k netsvcs', created: lockAt - 50 })), false);
  assert.equal(processIsConnector(1, lockAt, () => ({ ...connector, cmd: 'node other-app.js' })), false);
  assert.equal(processIsConnector(1, lockAt, () => ({ ...connector, created: lockAt + 60_000 })), false, 'created after the lock');
  assert.equal(processIsConnector(1, lockAt, () => ({ gone: true })), false);
  assert.equal(processIsConnector(1, lockAt, () => { throw new Error('access denied'); }), null);
  assert.equal(processIsConnector(1, lockAt, () => ({ ...connector, cmd: null })), true, 'command line hidden (other user): trust name + time');
});

test('process lock allows one connector and rejects a live duplicate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-process-lock-'));
  const file = path.join(root, 'connector.lock');
  try {
    const first = new ProcessLock(file).acquire();
    assert.throws(() => new ProcessLock(file).acquire(), /已在运行/);
    first.release();
    const second = new ProcessLock(file).acquire();
    second.release();
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('process lock reclaims a lock left by a dead process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-process-lock-stale-'));
  const file = path.join(root, 'connector.lock');
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, startedAt: 1 }));
    const lock = new ProcessLock(file).acquire();
    lock.release();
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
