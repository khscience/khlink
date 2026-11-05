'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { reduceQueue } = require('../src/backends/claude-desktop-queue');
const { readDesktopQueue } = require('../src/backends/claude-desktop');

test('an actual user receipt repairs FIFO drift left by an orphan harness notification', () => {
  const state = reduceQueue([], [
    { op: 'enqueue', content: '<task-notification>old</task-notification>', at: 1 },
    { op: 'enqueue', content: '请继续测试', at: 2 },
    { op: 'dequeue', at: 3 },
    { op: 'received', content: '请继续测试', at: 4 },
  ]);
  assert.deepEqual(state.queue, []);
});

test('a dequeue receipt survives incremental reads and keeps an identical queued message', () => {
  const a = reduceQueue([], [
    { op: 'enqueue', content: '请继续', at: 1 },
    { op: 'enqueue', content: '请继续', at: 2 },
    { op: 'dequeue', at: 3 },
  ]);
  const saved = JSON.parse(JSON.stringify(a));
  const b = reduceQueue(saved.queue, [{ op: 'received', content: '请继续', at: 4 }], saved.receipts);
  assert.equal(b.queue.length, 1);
  assert.equal(b.queue[0].createdAt, 2);
  const c = reduceQueue(b.queue, [{ op: 'dequeue', at: 5 }, { op: 'received', content: '请继续', at: 6 }], b.receipts);
  assert.deepEqual(c.queue, []);
});

test('out-of-order older user records cannot consume a later pending message', () => {
  const state = reduceQueue([], [{ op: 'enqueue', content: '稍后运行', at: 20 }, { op: 'received', content: '稍后运行', at: 10 }]);
  assert.equal(state.queue.length, 1);
});

test('queue-only rebuild stops at the committed byte offset and ignores interrupted markers', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test-transcript.jsonl');
  const row = o => JSON.stringify(o) + '\n';
  fs.writeFileSync(file, row({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-15T01:00:00Z', content: '保留待发消息' }));
  const offset = fs.statSync(file).size;
  fs.appendFileSync(file, row({ type: 'user', timestamp: '2026-10-15T01:00:01Z', message: { content: '[Request interrupted by user]' } }));
  assert.equal(readDesktopQueue(file).queue.length, 1);
  fs.appendFileSync(file, row({ type: 'user', timestamp: '2026-10-15T01:00:02Z', message: { content: '保留待发消息' } }));
  assert.equal(readDesktopQueue(file, offset).queue.length, 1);
  assert.equal(readDesktopQueue(file).queue.length, 0);
});
