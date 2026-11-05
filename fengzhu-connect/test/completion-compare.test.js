const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'compare-completions.js');
const { readTurns } = require('../scripts/compare-completions');

function run(root, log, at) {
  return spawnSync(process.execPath, [script, '--log', log, '--rollout-root', root, '--since', '2026-10-06 12:00:00', '--until', '2026-10-06 13:00:00', '--json'], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Shanghai' } });
}

test('large image lines cannot hide later turn markers or require a whole-file string', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-compare-large-'));
  const file = path.join(root, 'large.jsonl');
  try {
    fs.writeFileSync(file, JSON.stringify({ timestamp: '2026-10-06T04:00:00Z', type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
    fs.appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'image', content: 'x'.repeat(2 * 1024 * 1024) } }) + '\n');
    fs.appendFileSync(file, JSON.stringify({ timestamp: '2026-10-06T04:01:00Z', type: 'event_msg', payload: { type: 'task_complete' } }));
    const original = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (target, ...args) => {
      if (target === file) throw new RangeError('whole history read forbidden');
      return original(target, ...args);
    });
    assert.deepEqual(readTurns(file), [{ startAt: Date.parse('2026-10-06T04:00:00Z'), terminalAt: Date.parse('2026-10-06T04:01:00Z'), terminalType: 'task_complete' }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('completion comparison keeps archived rollout evidence when its default root is sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-compare-archived-'));
  const sessions = path.join(root, 'sessions'); const archived = path.join(root, 'archived_sessions');
  fs.mkdirSync(sessions); fs.mkdirSync(archived);
  const file = path.join(archived, 'rollout-2026-10-06T12-00-00-abcdef12-1234-1234-1234-123456789abc.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: '2026-10-06T04:00:00Z', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: '2026-10-06T04:01:00Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');
  const log = path.join(root, 'connector.log');
  fs.writeFileSync(log, '2026-10-06 12:02:00.000 [INFO] status abcdef12 mobile_running -> completed (test)\n');
  try { const result = run(sessions, log); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).matched, 1); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('offline completion comparison accepts a terminal rollout event before the log transition', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-compare-'));
  const session = path.join(root, '2026', '10', '06'); fs.mkdirSync(session, { recursive: true });
  const id = 'abcdef12-1234-1234-1234-123456789abc';
  const rollout = path.join(session, `rollout-2026-10-06T12-00-00-${id}.jsonl`);
  const log = path.join(root, 'connector.log');
  fs.writeFileSync(rollout, [
    JSON.stringify({ timestamp: '2026-10-06T04:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: '2026-10-06T04:01:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');
  fs.writeFileSync(log, '2026-10-06 12:02:00.000 [ERROR] [fengzhu-connect] status abcdef12 desktop_running -> completed (test)\n');
  try {
    const result = run(root, log);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).mismatches, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('offline completion comparison flags a transition before the rollout terminal event', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-compare-mismatch-'));
  const session = path.join(root, '2026', '10', '06'); fs.mkdirSync(session, { recursive: true });
  const id = 'abcdef12-1234-1234-1234-123456789abc';
  const rollout = path.join(session, `rollout-2026-10-06T12-00-00-${id}.jsonl`);
  const log = path.join(root, 'connector.log');
  fs.writeFileSync(rollout, [
    JSON.stringify({ timestamp: '2026-10-06T04:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: '2026-10-06T04:05:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');
  fs.writeFileSync(log, '2026-10-06 12:02:00.000 [ERROR] [fengzhu-connect] status abcdef12 desktop_running -> completed (test)\n');
  try {
    const result = run(root, log);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).mismatches, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('offline comparison flags completed to running without a newer task start', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-compare-reverse-'));
  const session = path.join(root, '2026', '10', '06'); fs.mkdirSync(session, { recursive: true });
  const id = 'abcdef12-1234-1234-1234-123456789abc';
  const rollout = path.join(session, `rollout-2026-10-06T12-00-00-${id}.jsonl`);
  const log = path.join(root, 'connector.log');
  fs.writeFileSync(rollout, [
    JSON.stringify({ timestamp: '2026-10-06T04:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: '2026-10-06T04:01:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');
  fs.writeFileSync(log, '2026-10-06 12:02:01.000 [ERROR] [fengzhu-connect] status abcdef12 completed -> desktop_running (stale range)\n');
  try {
    const result = run(root, log);
    assert.equal(result.status, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.runningTransitions, 1);
    assert.equal(json.reverseMismatches, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('offline comparison accepts running after a newer task start', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-compare-reverse-valid-'));
  const session = path.join(root, '2026', '10', '06'); fs.mkdirSync(session, { recursive: true });
  const id = 'abcdef12-1234-1234-1234-123456789abc';
  const rollout = path.join(session, `rollout-2026-10-06T12-00-00-${id}.jsonl`);
  const log = path.join(root, 'connector.log');
  fs.writeFileSync(rollout, [
    JSON.stringify({ timestamp: '2026-10-06T04:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: '2026-10-06T04:05:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
    JSON.stringify({ timestamp: '2026-10-06T04:06:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
  ].join('\n') + '\n');
  fs.writeFileSync(log, '2026-10-06 12:07:00.000 [ERROR] [fengzhu-connect] status abcdef12 completed -> desktop_running (new turn)\n');
  try {
    const result = run(root, log);
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.runningTransitions, 1);
    assert.equal(json.reverseMismatches, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
