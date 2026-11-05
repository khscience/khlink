const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PcLoad, cpuPercent, gpuPercent } = require('../src/pc-load');

test('CPU share comes from the idle time between two samples', () => {
  assert.equal(cpuPercent({ idle: 1000, total: 2000 }, { idle: 1250, total: 3000 }), 75);
  assert.equal(cpuPercent({ idle: 5, total: 10 }, { idle: 5, total: 10 }), null);
});

test('GPU share is the busiest GPU of an nvidia-smi line', () => {
  assert.equal(gpuPercent('95'), 95);
  assert.equal(gpuPercent('12\n70'), 70);
  assert.equal(gpuPercent('[N/A]'), null);
});

test('one long-lived nvidia-smi feeds the GPU value; a machine without one reports null', async () => {
  const spawned = [];
  const fakeSpawn = (cmd, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => child.emit('exit', 0);
    spawned.push({ cmd, args, child });
    return child;
  };
  const load = new PcLoad({ intervalMs: 20, spawnFn: fakeSpawn });
  load.start();
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.includes('-l'), 'nvidia-smi repeats by itself instead of being restarted');
  spawned[0].child.stdout.emit('data', '42\n');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const snap = load.snapshot();
  assert.equal(snap.gpu, 42);
  assert.ok(Number.isInteger(snap.cpu) && snap.cpu >= 0 && snap.cpu <= 100);
  assert.ok(Number.isInteger(snap.mem) && snap.mem > 0 && snap.mem <= 100);
  load.stop();
  assert.equal(spawned.length, 1, 'stopping does not start another nvidia-smi');

  const missing = new PcLoad({ intervalMs: 20, spawnFn: () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); setImmediate(() => c.emit('error', new Error('ENOENT'))); return c; } });
  missing.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(missing.snapshot().gpu, null);
  missing.stop();
});
