const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Connector, readRolloutEvidence } = require('../src/connector');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-silent-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = 'silent-codex-thread';
  const file = path.join(dir, 'rollout.jsonl');
  const old = Date.now() - 11 * 60_000;
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date(old).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] } })}\n`);
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([[id, 'desktop_running']]);
  connector.desktopStatusAt = new Map([[id, old]]);
  connector.desktopLastActiveAt = new Map([[id, old]]);
  connector.desktopThreadUpdatedAt = new Map([[id, old]]);
  connector.desktopActiveThreads = new Set();
  connector.desktopActivitySnapshotHealthy = true;
  connector.desktopActivitySnapshotAt = Date.now();
  connector.rolloutFilesByThread = new Map([[id, file]]);
  connector.rolloutStatusScans = new Map();
  connector.rolloutLookupAt = new Map();
  connector.threadState = new Map();
  connector.isBridgeOwnedThread = () => false;
  connector.connectorRunsThread = () => false;
  connector.log = () => {};
  const events = [];
  connector.emit = (kind, threadId, payload) => events.push({ kind, threadId, ...payload });
  return { connector, id, file, old, events };
}

test('a desktop turn missing from the list is not completed just because it was quiet for ten minutes', (t) => {
  const { connector, id, events } = fixture(t);
  connector.sweepStaleDesktopStatuses(new Set());
  assert.equal(connector.desktopStatuses.get(id), 'desktop_running');
  assert.deepEqual(events, []);
});

test('an idle app-server snapshot and a long quiet turn do not mark the desktop turn complete', (t) => {
  const { connector, id, events } = fixture(t);
  connector.reconcileDesktopThreadStatus({ id, status: 'notLoaded' }, false);
  connector.reconcileLiveStatusesFromRollouts();
  assert.match(connector.desktopStatuses.get(id), /running/);
  assert.ok(events.every(event => event.status !== 'completed'));
});

test('a quiet guess never becomes a terminal watermark that blocks later progress in the same turn', (t) => {
  const { connector, id, file, events } = fixture(t);
  const runningEvidence = readRolloutEvidence(file);
  connector.publishRolloutStatus(id, 'completed', file, runningEvidence, false, { quiet: true });
  assert.equal(connector.rolloutTerminalWatermarks.has(id), false);
  connector.publishRolloutStatus(id, 'desktop_running', file, runningEvidence);
  assert.equal(connector.desktopStatuses.get(id), 'desktop_running');
  assert.deepEqual(events.filter(event => event.kind === 'thread.status').map(event => event.status), ['completed', 'desktop_running']);
});

test('the explicit end of the same quiet turn still completes exactly once', (t) => {
  const { connector, id, file, events } = fixture(t);
  connector.reconcileLiveStatusesFromRollouts();
  fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
  connector.reconcileLiveStatusesFromRollouts();
  connector.reconcileLiveStatusesFromRollouts();
  assert.equal(connector.desktopStatuses.get(id), 'completed');
  assert.equal(events.filter(event => event.kind === 'thread.status' && event.status === 'completed' && !event.quiet).length, 1);
});

test('startup recovers a recently active indexed rollout even if its Windows file mtime is old', async (t) => {
  const { DatabaseSync } = require('../src/backends/antigravity').loadSqlite();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-indexed-startup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'sessions'); fs.mkdirSync(root);
  const id = '01a0ef83-9324-7de3-8e7d-cb02aacd49bb';
  const file = path.join(root, `rollout-2026-09-30T07-32-52-${id}.jsonl`);
  const now = Date.now();
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date(now - 30_000).toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`);
  fs.utimesSync(file, new Date(now - 3_600_000), new Date(now - 3_600_000));
  const staleId = '01a0ef83-9324-7de3-8e7d-cb02aacd49bc';
  const staleFile = path.join(root, `rollout-2026-09-30T07-32-52-${staleId}.jsonl`);
  fs.writeFileSync(staleFile, `${JSON.stringify({ timestamp: new Date(now - 3_600_000).toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`);
  // Twenty newer files hide the active file from the mtime-only candidates.
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `unrelated-${i}.jsonl`), '{}\n');
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec('create table threads (id text, rollout_path text, updated_at_ms integer, archived integer)');
  db.prepare('insert into threads values (?, ?, ?, 0)').run(id, file, now - 30_000);
  // A fresh index timestamp alone must not revive a genuinely old rollout.
  db.prepare('insert into threads values (?, ?, ?, 0)').run(staleId, staleFile, now); db.close();

  const connector = Object.create(Connector.prototype);
  connector.rolloutFilesByThread = new Map(); connector.hiddenRollouts = new Set();
  connector.reconcileStartedFollowups = () => {};
  const published = []; const synced = [];
  connector.publishRolloutStatus = (threadId, status) => published.push([threadId, status]);
  connector.syncDesktopRollout = async (threadId) => synced.push(threadId);
  await connector.bootstrapRecentRolloutStatuses(root);
  assert.deepEqual(published, [[id, 'desktop_running']]);
  assert.deepEqual(synced, [id]);
});

test('startup history discovery gives the event loop a turn before parsing rollouts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-startup-yield-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = '01a0ef83-9324-7de3-8e7d-cb02aacd49bd';
  const file = path.join(root, `rollout-2026-09-30T07-32-52-${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`);
  const connector = Object.create(Connector.prototype);
  connector.rolloutFilesByThread = new Map(); connector.hiddenRollouts = new Set();
  let ticked = false; let observedYield = false;
  setImmediate(() => { ticked = true; });
  connector.reconcileStartedFollowups = () => { observedYield = ticked; };
  connector.publishRolloutStatus = () => {};
  connector.syncDesktopRollout = async () => {};
  await connector.bootstrapRecentRolloutStatuses(root);
  assert.equal(observedYield, true, 'relay timers must run before the startup scan finishes');
  assert.equal(connector.rolloutFilesByThread.get(id), file);
});
