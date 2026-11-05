const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Connector } = require('../src/connector');
const { withRequestMarker } = require('../src/request-marker');

for (const instrumented of [false, true]) for (const streaming of [false, true]) {
  test(`a ${streaming ? 'streaming' : 'small'} rollout publishes the end through aliased paths${instrumented ? ' with the production sync probe' : ''}`, async (t) => {
    if (instrumented) require('../src/sync-probe').installSyncProbe();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-rollout-alias-'));
    const realDir = path.join(root, 'real'); const aliasDir = path.join(root, 'alias');
    fs.mkdirSync(realDir); fs.symlinkSync(realDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const id = '01a19060-ee3e-7530-b147-6023d163dd4e';
    const name = `rollout-2026-10-31T13-13-54-${id}.jsonl`;
    const realFile = path.join(realDir, name); const watchedFile = path.join(aliasDir, name);
    const indexedFile = process.platform === 'win32' ? `\\\\?\\${realFile}` : realFile;
    const now = Date.now();
    fs.writeFileSync(realFile, [
      { timestamp: new Date(now - 3_000).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } },
      { timestamp: new Date(now - 2_000).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: '你好' } },
      { timestamp: new Date(now - 1_000).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'new-turn' } },
    ].map(JSON.stringify).join('\n') + '\n');

    const connector = Object.create(Connector.prototype); const published = [];
    Object.assign(connector, {
      rolloutFilesByThread: new Map([[id, indexedFile]]), rolloutOffsets: new Map(), rolloutPartialOffsets: new Map(),
      hiddenRollouts: new Set(), historyBackfillPromises: new Map(), desktopMetadataAt: new Map([[id, now]]),
      desktopActiveThreads: new Set(), desktopStatuses: new Map([[id, 'desktop_running']]),
      followups: { matchStarted: () => null, matchStartedByLocalImagePaths: () => null },
      noteRolloutRead: () => {}, trackCodexWaiting: () => false, historyItemFrame: () => ({}),
      putHistoryItems: async () => {}, syncThreadMetadata: async () => {}, emit: () => {}, log: () => {},
      turnStatus: (_id, status) => status, publishRolloutStatus: (_id, status) => published.push(status), stopping: false,
    });
    if (streaming) await connector.syncDesktopRolloutStreaming(id, watchedFile, { offset: 0, actualSize: fs.statSync(realFile).size, firstRead: false });
    else await connector.syncDesktopRollout(id, watchedFile, { startOffset: 0 });
    assert.deepEqual(published, ['completed']);
  });
}

test('a new finished turn publishes its own terminal event even when the previous turn was also completed', () => {
  const id = 'fast-turn'; const connector = Object.create(Connector.prototype); const emitted = [];
  Object.assign(connector, {
    desktopStatuses: new Map([[id, 'completed']]), desktopStatusAt: new Map(),
    rolloutTerminalWatermarks: new Map([[id, { marker: { at: 1_000, ordinal: 10 }, turnId: 'old' }]]),
    followups: { items: [] }, log: () => {}, emit: (kind, _id, payload) => { if (kind === 'thread.status') emitted.push(payload); },
  });
  const evidence = { status: 'completed', statusMarker: { at: 3_000, ordinal: 30 },
    turnStartMarker: { at: 2_000, ordinal: 20 }, statusTurnId: 'new', turnStartTurnId: 'new' };
  connector.publishRolloutStatus(id, 'completed', 'rollout.jsonl', evidence);
  connector.publishRolloutStatus(id, 'completed', 'rollout.jsonl', evidence);
  assert.deepEqual(emitted.map((event) => [event.status, event.turnId]), [['completed', 'new']]);
});

test('a slow desktop poll cannot block the independent rollout end check', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-slow-desktop-poll-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = 'slow-desktop-poll'; const file = path.join(root, 'rollout.jsonl'); const now = Date.now();
  fs.writeFileSync(file, [
    { timestamp: new Date(now - 2_000).toISOString(), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: new Date(now - 1_000).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const connector = Object.create(Connector.prototype); const emitted = [];
  Object.assign(connector, {
    realtimeSyncRunning: true, stopping: false, isConnected: () => true, codex: { ready: true },
    syncDesktopActivity: async () => {},
    desktopStatuses: new Map([[id, 'desktop_running']]), desktopStatusAt: new Map(), desktopActiveThreads: new Set(),
    rolloutFilesByThread: new Map([[id, file]]), rolloutStatusScans: new Map(), rolloutLookupAt: new Map(),
    threadState: new Map(), followups: { items: [] }, log: () => {},
    emit: (kind, _id, payload) => { if (kind === 'thread.status') emitted.push(payload.status); },
    turnStatus: (_id, status) => status,
  });
  await connector.pollRealtimeSync();
  assert.deepEqual(emitted, ['completed']);
});

test('a matched mobile follow-up is watched for its real terminal record even during a slow desktop poll', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-followup-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = 'matched-followup'; const file = path.join(root, 'rollout.jsonl'); const now = Date.now();
  const record = (time, type) => JSON.stringify({ timestamp: new Date(time).toISOString(), type: 'event_msg', payload: { type } }) + '\n';
  fs.writeFileSync(file, record(now - 20_000, 'task_complete') + record(now - 2_000, 'task_started') + record(now - 1_000, 'user_message'));
  const connector = Object.create(Connector.prototype); const emitted = [];
  Object.assign(connector, {
    realtimeSyncRunning: true, stopping: false, isConnected: () => true, codex: { ready: true }, syncDesktopActivity: async () => {},
    desktopStatuses: new Map(), desktopStatusAt: new Map(), desktopActiveThreads: new Set(),
    rolloutFilesByThread: new Map([[id, file]]), rolloutStatusScans: new Map(), rolloutLookupAt: new Map(),
    threadState: new Map(), followups: { items: [] }, log: () => {}, turnStatus: (_id, status) => status,
    emit: (kind, _id, payload) => { if (kind === 'thread.status') emitted.push(payload.status); },
  });
  connector.noteMatchedRolloutFollowupStarted(id, file, now - 1_000);
  assert.deepEqual(emitted, ['running']);
  fs.appendFileSync(file, record(now, 'task_complete'));
  await connector.pollRealtimeSync();
  assert.deepEqual(emitted, ['running', 'completed']);
});

test('a delayed matched follow-up publishes its already completed turn without reviving it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-followup-finished-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = 'finished-followup'; const file = path.join(root, 'rollout.jsonl'); const now = Date.now();
  fs.writeFileSync(file, [
    { timestamp: new Date(now - 2_000).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: '好' } },
    { timestamp: new Date(now - 1_000).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const connector = Object.create(Connector.prototype); const emitted = [];
  Object.assign(connector, {
    desktopStatuses: new Map([[id, 'completed']]), desktopStatusAt: new Map(),
    rolloutFilesByThread: new Map([[id, file]]), rolloutStatusScans: new Map(), followups: { items: [] },
    log: () => {}, turnStatus: (_id, status) => status,
    emit: (kind, _id, payload) => { if (kind === 'thread.status') emitted.push(payload.status); },
  });
  connector.noteMatchedRolloutFollowupStarted(id, file, now - 2_000);
  assert.deepEqual(emitted, ['completed']);
});

for (const messageType of ['event_msg', 'response_item']) test(`a direct started receipt matches its ${messageType} rollout message while the desktop poll is busy`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-direct-started-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = '01a19060-ee3e-7530-b147-6023d163dd4e'; const requestId = '5a960026-8562-4d3a-9e5a-746f877d416a';
  const file = path.join(root, 'rollout.jsonl'); const now = Date.now();
  const record = (time, payload) => JSON.stringify({ timestamp: new Date(time).toISOString(), type: 'event_msg', payload }) + '\n';
  const old = record(now - 30_000, { type: 'task_complete' });
  const user = messageType === 'event_msg'
    ? record(now - 2_000, { type: 'user_message', message: withRequestMarker('谢谢', requestId) })
    : JSON.stringify({ timestamp: new Date(now - 2_000).toISOString(), type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: withRequestMarker('谢谢', requestId) }] } }) + '\n';
  fs.writeFileSync(file, old + user);
  const item = { id: requestId, requestId, threadId: id, state: 'started', rolloutOffset: Buffer.byteLength(old) };
  const followups = { items: [item], get: (key) => followups.items.find((row) => row.id === key),
    remove: (key) => { const found = followups.get(key); followups.items = followups.items.filter((row) => row.id !== key); return found; } };
  const connector = Object.create(Connector.prototype); const emitted = [];
  Object.assign(connector, {
    realtimeSyncRunning: true, stopping: false, isConnected: () => true, codex: { ready: true }, syncDesktopActivity: async () => {},
    desktopStatuses: new Map(), desktopStatusAt: new Map(), desktopActiveThreads: new Set(),
    rolloutFilesByThread: new Map([[id, file]]), rolloutStatusScans: new Map(), rolloutLookupAt: new Map(),
    threadState: new Map(), followups, log: () => {}, turnStatus: (_id, status) => status,
    send: (kind, _id, payload) => { if (kind === 'thread.status') emitted.push(payload.status); },
  });
  connector.emit('followup.started', id, { id: requestId });
  await connector.pollRealtimeSync();
  assert.deepEqual(emitted, ['running']);
  assert.equal(followups.items.length, 0);
  fs.appendFileSync(file, record(now, { type: 'task_complete' }));
  await connector.pollRealtimeSync();
  assert.deepEqual(emitted, ['running', 'completed']);
});
