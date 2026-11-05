const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Connector, readRolloutEvidence } = require('../src/connector');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-preboot-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = '00000000-0000-4000-8000-000000000001';
  const file = path.join(root, 'rollout.jsonl');
  const now = Date.now();
  const bootAt = now - 2 * 24 * 60 * 60_000;
  const oldAt = now - 7 * 24 * 60 * 60_000;
  const record = (at, type) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type, turn_id: `turn-${at}` } }) + '\n';
  fs.writeFileSync(file, record(oldAt, 'task_started') + record(oldAt + 1_000, 'user_message'));
  const connector = Object.create(Connector.prototype);
  const emitted = []; const retries = [];
  const metadata = { path: file, updatedAt: oldAt + 1_000, originator: 'Codex Desktop' };
  Object.assign(connector, {
    codexPrebootRecoveryEnabled: true, systemBootAt: bootAt, desktopActivitySnapshotHealthy: true, desktopActivitySnapshotAt: now,
    desktopStatuses: new Map([[id, 'desktop_running']]), desktopStatusAt: new Map(), desktopActiveThreads: new Set(),
    desktopThreadUpdatedAt: new Map(), threadState: new Map(), mobileOwnedThreads: new Set(),
    rolloutFilesByThread: new Map([[id, file]]), rolloutStatusScans: new Map(), rolloutLookupAt: new Map(),
    codexStatusMetadata: () => metadata,
    followups: { items: [{ threadId: id, id: 'queued', state: 'pending' }], update: (...args) => retries.push(args) },
    retryFollowups: async () => retries.push('retry'),
    emit: (kind, threadId, payload) => { if (kind === 'thread.status') emitted.push({ threadId, ...payload }); },
    log: () => {}, turnStatus: (_id, status) => `desktop_${status}`,
  });
  return { connector, id, file, now, oldAt, bootAt, record, metadata, emitted, retries };
}

test('a pre-reboot orphan becomes unknown without completion or an immediate queue retry, even for an unchanged rollout', (t) => {
  const f = fixture(t); const evidence = readRolloutEvidence(f.file);
  f.connector.rolloutStatusScans.set(f.file, `${evidence.stat.size}:${evidence.activityAt}`);
  f.connector.reconcileLiveStatusesFromRollouts();
  assert.equal(f.connector.desktopStatuses.get(f.id), 'unknown');
  assert.deepEqual(f.emitted.map((row) => [row.status, row.quiet]), [['unknown', true]]);
  assert.deepEqual(f.retries, []);
  f.connector.publishRolloutStatus(f.id, 'desktop_running', f.file, evidence);
  assert.deepEqual(f.emitted.map((row) => row.status), ['unknown'], 'old history must not revive the badge');
  assert.deepEqual(f.retries, []);
});

test('a history replay after connector restart sends unknown instead of reviving a phone\'s old running state', (t) => {
  const f = fixture(t);
  f.connector.desktopStatuses.clear();
  f.connector.publishRolloutStatus(f.id, 'desktop_running', f.file, readRolloutEvidence(f.file));
  assert.deepEqual(f.emitted.map((row) => [row.status, row.quiet]), [['unknown', true]]);
  assert.deepEqual(f.retries, []);
});

test('reads only bounded valid live thread hints from the previous synthetic connector status', (t) => {
  const f = fixture(t); const statusFile = path.join(path.dirname(f.file), 'status.json');
  const activeThreads = [
    { threadId: f.id, status: 'desktop_running' }, { threadId: 'not-a-thread-id', status: 'running' },
    { threadId: '00000000-0000-4000-8000-000000000002', status: 'completed' },
  ];
  fs.writeFileSync(statusFile, JSON.stringify({ updatedAt: f.now, activeThreads }));
  assert.deepEqual([...f.connector.readPreviousActiveThreadHints(statusFile)], [f.id]);
  fs.writeFileSync(statusFile, JSON.stringify({ updatedAt: f.now - 121_000, activeThreads }));
  assert.deepEqual([...f.connector.readPreviousActiveThreadHints(statusFile)], []);
  fs.writeFileSync(statusFile, '{malformed');
  assert.deepEqual([...f.connector.readPreviousActiveThreadHints(statusFile)], []);
});

test('a fresh local recovery request survives a connector restart but expires quickly', (t) => {
  const f = fixture(t); const root = path.dirname(f.file);
  const statusFile = path.join(root, 'status.json'); const request = path.join(root, 'codex-status-recovery.request.json');
  fs.writeFileSync(statusFile, JSON.stringify({ updatedAt: f.now, activeThreads: [] }));
  const activeThreads = [{ threadId: f.id, status: 'desktop_running' }];
  fs.writeFileSync(request, JSON.stringify({ updatedAt: f.now, activeThreads }));
  assert.deepEqual([...f.connector.readPrebootStatusHints(statusFile, request)], [f.id]);
  fs.writeFileSync(request, JSON.stringify({ updatedAt: f.now - 121_000, activeThreads }));
  assert.deepEqual([...f.connector.readPrebootStatusHints(statusFile, request)], []);
});

function configurePreviousHint(f, request) {
  f.connector.desktopStatuses.clear();
  f.connector.prebootStatusHints = new Set([f.id]);
  f.connector.config = { protocolVersion: 2, accountId: 'synthetic-account', deviceId: 'synthetic-device', accountKey: 'synthetic-key', serverUrl: 'http://127.0.0.1' };
  f.connector.api = { path: (suffix) => `/api/v2${suffix}`, request };
}

test('after restart an account-scoped thread index confirms the old phone badge can be corrected', async (t) => {
  const f = fixture(t);
  configurePreviousHint(f, async () => ({ items: [{ id: f.id, connectorId: 'synthetic-device', archived: false }] }));
  await f.connector.reconcilePrebootStatusHints();
  assert.deepEqual(f.emitted.map((row) => [row.status, row.quiet]), [['unknown', true]]);
  assert.equal(f.connector.prebootStatusHints.size, 0);
  assert.deepEqual(f.retries, []);
});

test('an owned old thread beyond the first 100 history rows is recovered', async (t) => {
  const f = fixture(t); const calls = [];
  configurePreviousHint(f, async (url) => {
    calls.push(url);
    if (calls.length === 1) return { items: Array.from({ length: 100 }, (_, i) => ({ id: `other-${i}`, updatedAt: f.now - i })) };
    return { items: [{ id: f.id, connectorId: 'synthetic-device', archived: false, updatedAt: f.oldAt }] };
  });
  await f.connector.reconcilePrebootStatusHints();
  assert.equal(calls.length, 2);
  assert.match(calls[1], new RegExp(`before=${f.now - 99}$`));
  assert.deepEqual(f.emitted.map((row) => [row.status, row.quiet]), [['unknown', true]]);
  assert.equal(f.connector.prebootStatusHints.size, 0);
});

test('a missing or truncated history page never grants ownership and is retried later', async (t) => {
  const f = fixture(t);
  configurePreviousHint(f, async () => ({ items: Array.from({ length: 100 }, (_, i) => ({ id: `other-${i}` })) }));
  await f.connector.reconcilePrebootStatusHints();
  assert.deepEqual(f.emitted, []);
  assert.equal(f.connector.prebootStatusHints.has(f.id), true);
  assert.ok(f.connector.prebootStatusHintsNextAt >= f.now + 4 * 60_000);
});

test('an account change while fetching a later page discards the result', async (t) => {
  const f = fixture(t); let release; let calls = 0;
  configurePreviousHint(f, async () => {
    calls += 1;
    if (calls === 1) return { items: Array.from({ length: 100 }, (_, i) => ({ id: `other-${i}`, updatedAt: f.now - i })) };
    return new Promise((resolve) => { release = resolve; });
  });
  const check = f.connector.reconcilePrebootStatusHints();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  f.connector.config.accountId = 'different-account';
  release({ items: [{ id: f.id, connectorId: 'synthetic-device', archived: false }] });
  await check;
  assert.deepEqual(f.emitted, []);
});

test('a prior status belonging to another connector is never sent to this account', async (t) => {
  const f = fixture(t);
  configurePreviousHint(f, async () => ({ items: [{ id: f.id, connectorId: 'other-device', archived: false }] }));
  await f.connector.reconcilePrebootStatusHints();
  assert.deepEqual(f.emitted, []);
});

test('an account change while checking prior status discards the delayed result', async (t) => {
  const f = fixture(t); let release;
  configurePreviousHint(f, () => new Promise((resolve) => { release = resolve; }));
  const check = f.connector.reconcilePrebootStatusHints();
  f.connector.config.accountId = 'different-account';
  release({ items: [{ id: f.id, connectorId: 'synthetic-device', archived: false }] });
  await check;
  assert.deepEqual(f.emitted, []);
});

test('a real completion arriving while the account index loads is not replaced by unknown', async (t) => {
  const f = fixture(t); let release;
  configurePreviousHint(f, () => new Promise((resolve) => { release = resolve; }));
  const check = f.connector.reconcilePrebootStatusHints();
  f.connector.desktopStatuses.set(f.id, 'completed');
  release({ items: [{ id: f.id, connectorId: 'synthetic-device', archived: false }] });
  await check;
  assert.equal(f.connector.desktopStatuses.get(f.id), 'completed');
  assert.deepEqual(f.emitted, []);
});

test('a new connector-owned turn arriving while the account index loads stays active', async (t) => {
  const f = fixture(t); let release;
  configurePreviousHint(f, () => new Promise((resolve) => { release = resolve; }));
  const check = f.connector.reconcilePrebootStatusHints();
  f.connector.threadState.set(f.id, { activeTurnId: 'new-turn' });
  release({ items: [{ id: f.id, connectorId: 'synthetic-device', archived: false }] });
  await check;
  assert.deepEqual(f.emitted, []);
});

test('new post-reboot activity can run and later publish its real completion', (t) => {
  const f = fixture(t);
  f.connector.reconcileLiveStatusesFromRollouts();
  fs.appendFileSync(f.file, f.record(f.now - 1_000, 'task_started'));
  f.metadata.updatedAt = f.now - 1_000;
  f.connector.publishRolloutStatus(f.id, 'desktop_running', f.file, readRolloutEvidence(f.file));
  fs.appendFileSync(f.file, f.record(f.now, 'task_complete'));
  f.connector.publishRolloutStatus(f.id, 'completed', f.file, readRolloutEvidence(f.file));
  assert.deepEqual(f.emitted.map((row) => [row.status, row.quiet]), [
    ['unknown', true], ['desktop_running', undefined], ['completed', undefined],
  ]);
});

for (const [name, change] of [
  ['a currently active desktop thread', (f) => f.connector.desktopActiveThreads.add(f.id)],
  ['a platform without verified boot recovery', (f) => { f.connector.codexPrebootRecoveryEnabled = false; }],
  ['a newly active thread in the desktop poll currently in flight', (f) => { f.connector.desktopPollingActiveThreads = new Set([f.id]); }],
  ['a connector-owned live turn', (f) => f.connector.threadState.set(f.id, { activeTurnId: 'live' })],
  ['a mobile-owned live thread', (f) => f.connector.mobileOwnedThreads.add(f.id)],
  ['a stale desktop snapshot', (f) => { f.connector.desktopActivitySnapshotAt = f.now - 120_000; }],
  ['a failed or missing desktop snapshot', (f) => { f.connector.desktopActivitySnapshotHealthy = false; }],
  ['a post-reboot thread metadata update', (f) => { f.metadata.updatedAt = f.now - 30_000; }],
  ['a post-reboot desktop list observation', (f) => { f.connector.desktopThreadUpdatedAt.set(f.id, f.now - 30_000); }],
  ['a thread belonging to another originator', (f) => { f.metadata.originator = 'other'; }],
  ['an unknown local metadata row', (f) => { f.connector.codexStatusMetadata = () => null; }],
  ['a rollout path that does not match', (f) => { f.metadata.path = path.join(path.dirname(f.file), 'other.jsonl'); }],
  ['an old but same-boot turn', (f) => { f.connector.systemBootAt = f.oldAt - 60_000; }],
  ['an unknown system boot time', (f) => { f.connector.systemBootAt = 0; }],
  ['a machine that only just rebooted', (f) => { f.connector.systemBootAt = f.now - 60_000; }],
]) {
  test(`does not retire ${name}`, (t) => {
    const f = fixture(t); change(f);
    f.connector.reconcileLiveStatusesFromRollouts();
    assert.equal(f.connector.desktopStatuses.get(f.id), 'desktop_running');
    assert.equal(f.emitted.some((row) => row.status === 'unknown'), false);
    assert.deepEqual(f.retries, []);
  });
}

test('reads only the synthetic local thread metadata needed for reboot recovery', (t) => {
  const f = fixture(t); const { DatabaseSync } = require('node:sqlite');
  const oldHome = process.env.CODEX_HOME;
  const root = path.dirname(f.file); process.env.CODEX_HOME = root;
  t.after(() => { if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome; });
  const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at_ms INTEGER, updated_at INTEGER, originator TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(f.id, f.file, f.metadata.updatedAt, Math.floor(f.metadata.updatedAt / 1000), 'Codex Desktop');
  db.close();
  delete f.connector.codexStatusMetadata;
  assert.deepEqual(f.connector.codexStatusMetadata(f.id), f.metadata);
  assert.equal(f.connector.codexStatusMetadata('missing'), null);
});

test('a new rollout record arriving while metadata is checked prevents retirement', (t) => {
  const f = fixture(t);
  f.connector.codexStatusMetadata = () => {
    fs.appendFileSync(f.file, f.record(f.now - 1_000, 'task_started'));
    return f.metadata;
  };
  f.connector.reconcileLiveStatusesFromRollouts();
  assert.equal(f.connector.desktopStatuses.get(f.id), 'desktop_running');
  assert.equal(f.emitted.some((row) => row.status === 'unknown'), false);
});

for (const [name, response] of [
  ['malformed data', async () => ({ data: null })],
  ['a failing request', async () => { throw new Error('synthetic poll failure'); }],
]) {
  test(`a desktop poll with ${name} is not a healthy empty snapshot`, async (t) => {
    const f = fixture(t);
    Object.assign(f.connector, {
      realtimeSyncRunning: false, stopping: false, isConnected: () => true,
      codex: { ready: true, request: response }, desktopStateFile: path.join(path.dirname(f.file), 'no-state.json'),
      desktopPins: { ids: [], orderById: {} },
    });
    await f.connector.syncDesktopActivity().catch(() => {});
    assert.equal(f.connector.desktopActivitySnapshotHealthy, false);
    assert.equal(f.connector.desktopStatuses.get(f.id), 'desktop_running');
    assert.deepEqual(f.emitted, []);
  });
}

test('a later active row protects its thread while an earlier row is still uploading', async (t) => {
  const f = fixture(t);
  let release; let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  Object.assign(f.connector, {
    realtimeSyncRunning: false, stopping: false, isConnected: () => true,
    codex: { ready: true, request: async () => ({ data: [
      { id: 'first', status: 'idle', updatedAt: f.now },
      { id: f.id, status: { type: 'active' }, updatedAt: f.oldAt },
    ] }) },
    desktopStateFile: path.join(path.dirname(f.file), 'no-state.json'), desktopPins: { ids: [], orderById: {} },
    realtimeThreads: new Map(), reconcileDesktopThreadStatus: () => {}, sweepStaleDesktopStatuses: () => {},
    syncThreadMetadata: async () => { entered(); await blocked; }, syncNativeDesktopQueues: async () => {},
    syncArchivedDesktopThreads: async () => {}, syncPinnedMetadata: async () => {},
  });
  const poll = f.connector.syncDesktopActivity();
  await started;
  try {
    f.connector.reconcileLiveStatusesFromRollouts();
    assert.equal(f.connector.desktopStatuses.get(f.id), 'desktop_running');
    assert.equal(f.emitted.some((row) => row.status === 'unknown'), false);
  } finally { release(); }
  await poll;
});
