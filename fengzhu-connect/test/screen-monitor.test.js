'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ScreenMonitor } = require('../src/screen-monitor');

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, 'khlink-screen-test-'));
  t.after(() => { const target = fs.realpathSync(dir); assert.ok(target.startsWith(base + path.sep)); fs.rmSync(target, { recursive: true, force: true }); });
  return dir;
}
function fakeProcess() {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.writes = [];
  child.stdin.write = text => child.writes.push(text);
  child.stdin.end = () => { child.ended = true; };
  child.kill = () => { child.killed = true; child.emit('exit'); };
  return child;
}

test('keeps one helper, reports lock transitions and persists only the desired setting', t => {
  const home = fixture(t), children = [], changes = []; let now = 1000;
  const monitor = new ScreenMonitor(home, { platform: 'win32', now: () => now, intervalMs: 5000,
    spawnFn: () => { const child = fakeProcess(); children.push(child); return child; }, onChange: value => changes.push(value) });
  t.after(() => monitor.stop());
  monitor.start(); assert.equal(children.length, 1); assert.deepEqual(children[0].writes, ['0\n']);
  children[0].stdout.emit('data', '{"locked":false,"wakeActive":false}\n');
  assert.equal(monitor.snapshot().locked, false);
  monitor.setEnabled(true); assert.deepEqual(children[0].writes, ['0\n', '1\n']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'screen-wake.json'), 'utf8')).enabled, true);
  children[0].stdout.emit('data', '{"locked":true,"wakeActive":true}\n');
  const locked = monitor.snapshot();
  assert.deepEqual({ ...locked, lockId: 'id' }, { supported: true, locked: true, keepAwake: true, wakeActive: true, wakeError: false, lockId: 'id' });
  assert.match(locked.lockId, /^[\w-]+$/);
  const count = changes.length; monitor.poll(); children[0].stdout.emit('data', '{"locked":true,"wakeActive":true}\n');
  assert.equal(changes.length, count, 'identical samples do not trigger more notifications');
  assert.equal(children.length, 1, 'polling does not start a new process');
  monitor.setEnabled(false); children[0].stdout.emit('data', '{"locked":false,"wakeActive":false}\n');
  assert.equal(monitor.snapshot().locked, false); assert.equal(monitor.snapshot().wakeActive, false);
  children[0].stdout.emit('data', '{"locked":true,"wakeActive":false}\n');
  assert.notEqual(monitor.snapshot().lockId, locked.lockId, 'a new lock gets a new notification id');
  monitor.stop(); assert.equal(children[0].ended, true);
});

test('a connector restart retains the same lock id until an unlock is observed', t => {
  const home = fixture(t), first = new ScreenMonitor(home, { platform: 'win32' });
  first.applySample({ locked: true, wakeActive: false }); const id = first.snapshot().lockId;
  const restarted = new ScreenMonitor(home, { platform: 'win32' });
  restarted.applySample({ locked: null, wakeActive: null });
  restarted.applySample({ locked: true, wakeActive: false }); assert.equal(restarted.snapshot().lockId, id);
  restarted.applySample({ locked: false, wakeActive: false });
  restarted.applySample({ locked: true, wakeActive: false }); assert.notEqual(restarted.snapshot().lockId, id);
});

test('unknown, stale or broken helper never reports a false unlocked or active state', t => {
  const home = fixture(t), children = []; let now = 1000;
  const monitor = new ScreenMonitor(home, { platform: 'win32', now: () => now, intervalMs: 5000,
    spawnFn: () => { const child = fakeProcess(); children.push(child); return child; } });
  t.after(() => monitor.stop()); monitor.start();
  children[0].stdout.emit('data', '{"locked":true,"wakeActive":false}\n');
  children[0].stdout.emit('data', '{"locked":"bad","wakeActive":true}\n');
  assert.equal(monitor.snapshot().locked, true);
  now += 31000; monitor.poll(); assert.equal(children[0].killed, true);
  assert.equal(monitor.snapshot().locked, null); assert.equal(monitor.snapshot().wakeActive, null);
  assert.equal(children.length, 2);
  children[1].stdout.emit('data', '{"locked":null,"wakeActive":null}\n');
  assert.equal(monitor.snapshot().locked, null);
});

test('a slow first helper startup gets a full grace period without spawning repeatedly', t => {
  const children = []; let now = 1000;
  const monitor = new ScreenMonitor(fixture(t), { platform: 'win32', now: () => now, intervalMs: 5000,
    spawnFn: () => { const child = fakeProcess(); children.push(child); return child; } });
  t.after(() => monitor.stop()); monitor.start();
  now += 45000; monitor.poll(); assert.equal(children.length, 1); assert.notEqual(children[0].killed, true);
  now += 16000; monitor.poll(); assert.equal(children[0].killed, true); assert.equal(children.length, 2);
});

test('unsupported platforms do not start a helper or enable a fake wake request', t => {
  const monitor = new ScreenMonitor(fixture(t), { platform: 'linux', spawnFn: () => { throw new Error('must not spawn'); } });
  monitor.start(); assert.equal(monitor.snapshot().supported, false); assert.throws(() => monitor.setEnabled(true), /不支持/);
});

test('cannot claim a wake setting was saved if its storage fails', t => {
  const home = fixture(t), obstacle = path.join(home, 'not-a-directory');
  fs.writeFileSync(obstacle, 'test');
  const monitor = new ScreenMonitor(obstacle, { platform: 'win32' });
  assert.throws(() => monitor.setEnabled(true));
  assert.equal(monitor.snapshot().keepAwake, false);
});
