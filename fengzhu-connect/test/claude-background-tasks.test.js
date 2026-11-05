const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BackgroundTasks } = require('../src/backends/claude-background-tasks');
const { activitySnapshot } = require('../src/account-preflight');
const row = value => JSON.stringify(value) + '\n';
const start = { type: 'user', toolUseResult: { backgroundTaskId: 'bfcih8v8k' }, message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'background' }] } };
const finish = { type: 'user', origin: { kind: 'task-notification' }, promptSource: 'system', message: { content: '<task-notification><task-id>bfcih8v8k</task-id><status>completed</status></task-notification>' } };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-background-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'test.jsonl'); fs.writeFileSync(file, ''); return file;
}
test('real Desktop background result outlives end_turn; only the system completion ends it', t => {
  const file = fixture(t), reader = new BackgroundTasks();
  fs.writeFileSync(file, row(start) + row({ type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }));
  assert.deepEqual(reader.read(file), { known: true, count: 1 });
  fs.appendFileSync(file, row({ ...finish, origin: { kind: 'user' }, promptSource: 'user' }));
  assert.equal(reader.read(file).count, 1);
  fs.appendFileSync(file, row(finish));
  assert.deepEqual(reader.read(file), { known: true, count: 0 });
});
test('bounded incremental reads and partial notifications never report idle prematurely', t => {
  const file = fixture(t), reader = new BackgroundTasks({ maxBytesPerRead: 90 });
  fs.writeFileSync(file, row(start) + row({ type: 'assistant', message: { content: 'x'.repeat(1000) } }));
  assert.equal(reader.read(file).known, false);
  let state; for (let i = 0; i < 30; i++) { state = reader.read(file); if (state.known) break; }
  assert.deepEqual(state, { known: true, count: 1 });
  const end = row(finish); fs.appendFileSync(file, end.slice(0, -2));
  for (let i = 0; i < 10; i++) state = reader.read(file);
  assert.deepEqual(state, { known: false, count: 1 });
  fs.appendFileSync(file, end.slice(-2));
  assert.deepEqual(reader.read(file), { known: true, count: 0 });
});
test('async agent and unknown result stay blocking, errors and completed tasks release their own IDs', t => {
  const file = fixture(t), reader = new BackgroundTasks();
  fs.writeFileSync(file, row({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Agent', input: { run_in_background: true } }] } }));
  assert.equal(reader.read(file).count, 1);
  fs.appendFileSync(file, row({ ...start, toolUseResult: { isAsync: true, agentId: 'agent-1' } }));
  assert.equal(reader.read(file).count, 1);
  fs.appendFileSync(file, row({ ...finish, message: { content: finish.message.content.replace('bfcih8v8k', 'agent-1').replace('completed', 'failed') } }));
  assert.equal(reader.read(file).count, 0);
  fs.appendFileSync(file, row({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'unknown', input: { run_in_background: true } }] } }) + row({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'unknown format' }] } }));
  assert.equal(reader.read(file).count, 1);
  fs.appendFileSync(file, row({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown', is_error: true }] } }));
  assert.equal(reader.read(file).count, 0);
});
test('preflight blocks a live background task despite fresh terminal reply and old file mtime', t => {
  const file = fixture(t);
  fs.writeFileSync(file, row(start) + row({ type: 'assistant', uuid: 'final', timestamp: new Date(100000).toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'reply ended' }] } }));
  fs.utimesSync(file, new Date(1), new Date(1));
  const connector = { _claudeLive: { at: 100000, verified: true, ids: new Set(['test']) }, claudeThreads: new Map([['test', { sessionId: 'test', transcriptFile: file }]]) };
  assert.equal(activitySnapshot(connector, 'primary', 100000).tasks_running, 1);
  fs.appendFileSync(file, row(finish));
  assert.equal(activitySnapshot(connector, 'primary', 100000).tasks_running, 0);
});
test('truncation resets evidence; malformed records fail closed', t => {
  const file = fixture(t), reader = new BackgroundTasks();
  fs.writeFileSync(file, row(start)); assert.equal(reader.read(file).count, 1);
  fs.writeFileSync(file, '{}\n'); assert.deepEqual(reader.read(file), { known: true, count: 0 });
  fs.appendFileSync(file, '{broken}\n'); assert.equal(reader.read(file).known, false);
});
test('Desktop typed queued notifications complete tasks even before the waiting model consumes them', t => {
  const file = fixture(t), reader = new BackgroundTasks();
  const notification = { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' }, prompt: finish.message.content } };
  fs.writeFileSync(file, row(start));
  fs.appendFileSync(file, row({ type: 'queue-operation', operation: 'enqueue', content: finish.message.content }));
  fs.appendFileSync(file, row({ ...notification, attachment: { ...notification.attachment, origin: { kind: 'human' } } }));
  assert.equal(reader.read(file).count, 1);
  fs.appendFileSync(file, row(notification));
  assert.deepEqual(reader.read(file), { known: true, count: 0 });
});
test('typed task_status records retain running tasks and release only terminal statuses', t => {
  const file = fixture(t), reader = new BackgroundTasks();
  const status = value => row({ type: 'attachment', attachment: { type: 'task_status', taskId: 'task-1', status: value } });
  fs.writeFileSync(file, status('running'));
  assert.equal(reader.read(file).count, 1);
  fs.appendFileSync(file, status('unknown'));
  assert.equal(reader.read(file).count, 1);
  fs.appendFileSync(file, status('failed'));
  assert.equal(reader.read(file).count, 0);
});
