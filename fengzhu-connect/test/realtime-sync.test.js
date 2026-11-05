const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ready: readyCrypto } = require('../src/crypto');
const { Connector, typedRolloutItem, isActiveThread, isTerminalThreadStatus, isExplicitTerminalThreadStatus, threadPollSignature, sessionThreadId, isHiddenRollout, chunkByEncodedSize, rolloutItem, rolloutStatus, rolloutUserText, isDuplicateRolloutUserCopy, rolloutErrorText, shouldDiscardPartialRolloutLine, notificationStatus, contextCompactionStatus, rolloutCompactionStatus, mobileOwnedStatus, desktopOwnedStatus, latestRolloutStatus, readRolloutEvidence, latestRolloutStatusEvidence, readRolloutLines, HISTORY_RECENT_TAIL_BYTES, HISTORY_BACKFILL_VERSION, HISTORY_FULL_REPLAY_MAX_BYTES, DESKTOP_STATUS_REACTIVATE_GRACE_MS, DESKTOP_STATUS_IDLE_GRACE_MS } = require('../src/connector');

test('maps context compaction lifecycle events for mobile', () => {
  assert.equal(contextCompactionStatus('thread/compaction/started'), 'started');
  assert.equal(contextCompactionStatus('thread/compaction/completed'), 'completed');
  assert.equal(contextCompactionStatus('thread/compaction/failed'), 'failed');
  assert.equal(rolloutCompactionStatus({ type: 'event_msg', payload: { type: 'context_compaction_started' } }), 'started');
  assert.deepEqual(rolloutItem({ type: 'event_msg', payload: { type: 'context_compaction_completed' } }), {
    type: 'contextCompaction', text: '上下文整理完成', truncated: false, status: 'completed',
  });
});

test('recognizes desktop task states that need live reads', () => {
  assert.equal(isActiveThread({ status: { type: 'active' } }), true);
  assert.equal(isActiveThread({ status: 'inProgress' }), true);
  assert.equal(isActiveThread({ status: 'idle' }), false);
});

test('does not regress a confirmed terminal task when the Desktop list briefly remains active', () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'completed']]);
  connector.desktopStatusAt = new Map([['task-1', Date.now()]]);
  let published = false;
  connector.publishThreadStatus = () => { published = true; };
  connector.reconcileDesktopThreadStatus({ id: 'task-1', status: 'active' }, true);
  assert.equal(published, false);
});

test('re-publishes desktop_running for a genuinely new turn once the reactivate grace window has elapsed', () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'completed']]);
  connector.desktopStatusAt = new Map([['task-1', Date.now() - (DESKTOP_STATUS_REACTIVATE_GRACE_MS + 1000)]]);
  const published = [];
  connector.publishThreadStatus = (threadId, status) => published.push([threadId, status]);
  connector.reconcileDesktopThreadStatus({ id: 'task-1', status: 'active' }, true);
  assert.deepEqual(published, [['task-1', 'desktop_running']]);
});

test('sweepStaleDesktopStatuses does not clear a live badge without rollout evidence', () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['stale-task', 'desktop_running']]);
  connector.desktopStatusAt = new Map([['stale-task', Date.now() - (DESKTOP_STATUS_IDLE_GRACE_MS + 1000)]]);
  connector.desktopLastActiveAt = new Map([['stale-task', Date.now() - (DESKTOP_STATUS_IDLE_GRACE_MS + 1000)]]);
  const published = [];
  connector.publishThreadStatus = (threadId, status) => published.push([threadId, status]);
  connector.sweepStaleDesktopStatuses(new Set());
  assert.deepEqual(published, []);
});

test('sweepStaleDesktopStatuses keeps a recent unfinished rollout running', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-sweep-running-'));
  const threadId = 'stale-task-running';
  const file = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`);
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.desktopStatusAt = new Map([[threadId, Date.now() - (DESKTOP_STATUS_IDLE_GRACE_MS + 1000)]]);
    connector.desktopLastActiveAt = new Map([[threadId, Date.now() - (DESKTOP_STATUS_IDLE_GRACE_MS + 1000)]]);
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    const published = [];
    connector.publishThreadStatus = (id, status) => published.push([id, status]);
    connector.sweepStaleDesktopStatuses(new Set());
    assert.deepEqual(published, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sweepStaleDesktopStatuses waits for a real terminal marker after ten quiet minutes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-sweep-old-'));
  const threadId = 'stale-task-old';
  const file = path.join(root, 'rollout.jsonl');
  const old = Date.now() - 11 * 60_000;
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date(old).toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`);
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.desktopStatusAt = new Map([[threadId, old]]);
    connector.desktopLastActiveAt = new Map([[threadId, old]]);
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    const published = [];
    connector.publishThreadStatus = (id, status) => published.push([id, status]);
    connector.sweepStaleDesktopStatuses(new Set());
    assert.deepEqual(published, []);
    fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
    connector.sweepStaleDesktopStatuses(new Set());
    assert.deepEqual(published, [[threadId, 'completed']]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sweepStaleDesktopStatuses does not reuse a previous terminal marker for a newer turn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-sweep-previous-terminal-'));
  const threadId = 'stale-task-newer-turn';
  const file = path.join(root, 'rollout.jsonl');
  const finishedAt = Date.now() - 60_000;
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: new Date(finishedAt - 1000).toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: new Date(finishedAt).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    connector.desktopThreadUpdatedAt = new Map([[threadId, Date.now()]]);
    connector.turnStatus = (_id, status) => status;
    const published = [];
    connector.publishThreadStatus = (id, status) => published.push([id, status]);
    connector.sweepStaleDesktopStatuses(new Set());
    assert.deepEqual(published, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sweepStaleDesktopStatuses leaves a thread alone while it is still in the polled page', () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['visible-task', 'desktop_running']]);
  connector.desktopStatusAt = new Map([['visible-task', Date.now() - (DESKTOP_STATUS_IDLE_GRACE_MS + 1000)]]);
  connector.desktopLastActiveAt = new Map([['visible-task', Date.now() - (DESKTOP_STATUS_IDLE_GRACE_MS + 1000)]]);
  const published = [];
  connector.publishThreadStatus = (threadId, status) => published.push([threadId, status]);
  connector.sweepStaleDesktopStatuses(new Set(['visible-task']));
  assert.deepEqual(published, []);
});

test('clears a live badge when thread/list is stale but rollout and thread metadata are complete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-active-terminal-'));
  const file = path.join(root, 'rollout.jsonl');
  const finishedAt = Date.now();
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date(finishedAt - 1000).toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n${JSON.stringify({ timestamp: new Date(finishedAt).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
    connector.desktopStatusAt = new Map();
    connector.desktopLastActiveAt = new Map();
    connector.rolloutFilesByThread = new Map([['task-1', file]]);
    connector.turnStatus = (_threadId, status) => status;
    const published = [];
    connector.publishThreadStatus = (threadId, status) => published.push([threadId, status]);
    const updatedAt = finishedAt;
    connector.reconcileDesktopThreadStatus({ id: 'task-1', status: 'active', updatedAt }, true);
    assert.deepEqual(published, [['task-1', 'completed']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishing task completion never navigates the Desktop window', () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map();
  connector.desktopStatusAt = new Map();
  connector.emit = () => {};
  connector.refreshDesktopThread = () => {
    throw new Error('completion must not navigate Codex Desktop');
  };

  connector.publishThreadStatus('task-1', 'completed');

  assert.equal(connector.desktopStatuses.get('task-1'), 'completed');
});

test('rollout completion is published even while the Desktop list is still active', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-terminal-status-'));
  const file = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
    connector.desktopActiveThreads = new Set(['task-1']);
    connector.rolloutFilesByThread = new Map([['task-1', file]]);
    connector.rolloutStatusScans = new Map();
    connector.threadState = new Map();
    connector.mobileOwnedThreads = new Set();
    const published = [];
    connector.publishThreadStatus = (threadId, status) => published.push([threadId, status]);
    connector.turnStatus = (_threadId, status) => status;
    connector.reconcileLiveStatusesFromRollouts();
    assert.deepEqual(published, [['task-1', 'completed']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not mistake a separately queried notLoaded task for a completed task', () => {
  assert.equal(isTerminalThreadStatus({ status: { type: 'notLoaded' } }), false);
  assert.equal(isTerminalThreadStatus({ status: { type: 'idle' } }), true);
  assert.equal(isExplicitTerminalThreadStatus({ status: { type: 'idle' } }), false);
  assert.equal(isExplicitTerminalThreadStatus({ status: { type: 'completed' } }), true);
});

test('poll signature changes when desktop task content metadata changes', () => {
  const before = threadPollSignature({ updatedAt: 1, status: 'active', preview: 'a' });
  const after = threadPollSignature({ updatedAt: 2, status: 'active', preview: 'b' });
  assert.notEqual(before, after);
});

test('extracts a task id from a changed Codex rollout path', () => {
  assert.equal(
    sessionThreadId('2026\\06\\30\\rollout-2026-06-30T23-16-14-019f191a-2ed0-7cf1-9f33-92e3bf5871df.jsonl'),
    '019f191a-2ed0-7cf1-9f33-92e3bf5871df',
  );
  assert.equal(sessionThreadId('state_5.sqlite-wal'), null);
});

test('a paginated thread continued in a new file keeps its own id, not the page id', () => {
  assert.equal(
    sessionThreadId('rollout-2026-09-22T15-18-46-01a0761f-d52a-7921-a641-45a084f1ce30_01a0c7fb-3e61-76e1-9c2e-52791183f5bd.jsonl'),
    '01a0761f-d52a-7921-a641-45a084f1ce30',
  );
  assert.equal(sessionThreadId('rollout-2026-09-22T15-18-46-01a0761f-d52a-7921-a641-45a084f1ce30xjsonl'), null);
});

test('indexes the newest page when a thread has multiple rollout files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-rollout-pages-'));
  const threadId = '01a0761f-d52a-7921-a641-45a084f1ce30';
  const oldFile = path.join(root, `rollout-2026-09-06T17-49-52-${threadId}.jsonl`);
  const newFile = path.join(root, `rollout-2026-09-22T15-18-46-${threadId}_01a0c7fb-3e61-76e1-9c2e-52791183f5bd.jsonl`);
  fs.writeFileSync(oldFile, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
  fs.writeFileSync(newFile, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
  fs.utimesSync(oldFile, new Date(1_000), new Date(1_000));
  fs.utimesSync(newFile, new Date(2_000), new Date(2_000));
  try {
    const connector = Object.create(Connector.prototype);
    connector.rolloutFilesByThread = new Map(); connector.hiddenRollouts = new Set();
    connector.followups = { items: [] }; connector.reconcileStartedFollowups = () => {};
    connector.publishThreadStatus = () => {};
    connector.syncDesktopRollout = async () => true;
    await connector.bootstrapRecentRolloutStatuses(root);
    assert.equal(connector.rolloutFilesByThread.get(threadId), newFile);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recognizes internal subagent rollouts before realtime history upload', () => {
  const file = path.join(os.tmpdir(), `fengzhu-subagent-${process.pid}.jsonl`);
  const userFile = path.join(os.tmpdir(), `fengzhu-user-${process.pid}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { thread_source: 'subagent', source: { subagent: { other: 'guardian' } } } })}\n`);
  fs.writeFileSync(userFile, `${JSON.stringify({ type: 'session_meta', payload: { thread_source: 'cli', source: { cli: {} } } })}\n`);
  try {
    assert.equal(isHiddenRollout(file), true);
    assert.equal(isHiddenRollout(userFile), false);
  } finally {
    fs.unlinkSync(file);
    fs.unlinkSync(userFile);
  }
});

test('history upload batches stay below the encoded request budget', () => {
  const items = Array.from({ length: 5 }, (_, id) => ({ id, ciphertext: 'x'.repeat(600), nonce: 'n' }));
  const batches = chunkByEncodedSize(items, 1500);
  assert.deepEqual(batches.map((batch) => batch.length), [2, 2, 1]);
  for (const batch of batches) assert.ok(Buffer.byteLength(JSON.stringify({ items: batch })) < 1500);
  assert.deepEqual(chunkByEncodedSize(Array.from({ length: 201 }, (_, id) => ({ id }))).map((batch) => batch.length), [100, 100, 1]);
});

test('queues a durable full-history backfill once for a large rollout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-history-backfill-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old' }] } })}\n`);
  try {
    const connector = Object.create(Connector.prototype);
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    connector.rolloutOffsets = new Map();
    connector.historyBackfills = new Map();
    connector.historyBackfillPromises = new Map();
    connector.saveHistoryDigests = () => {};
    connector.emit = () => {};
    let calls = 0;
    connector.syncDesktopRollout = async () => { calls += 1; return true; };
    const first = connector.requestHistoryBackfill(threadId);
    const second = connector.requestHistoryBackfill(threadId);
    assert.equal(first.queued, true);
    assert.equal(second.queued, true);
    await connector.historyBackfillPromises.get(threadId);
    assert.ok(calls >= 1);
    assert.equal(connector.historyBackfills.get(threadId).file, file);
    const third = connector.requestHistoryBackfill(threadId);
    assert.equal(third.already, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history backfill starts with a bounded newest tail before full replay', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-history-tail-first-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  try {
    // Keep the fixture tiny and virtualize only stat.size. This models a large
    // rollout without requiring a sparse file on every test filesystem (some
    // Windows volumes eagerly reserve the space).
    // Keep this below the production very-large-session deferral threshold so
    // the test exercises both the bounded tail and the eventual full pass.
    const totalSize = 128 * 1024 * 1024;
    fs.writeFileSync(file, 'rollout fixture\n');
    const connector = Object.create(Connector.prototype);
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    connector.rolloutOffsets = new Map();
    connector.historyBackfills = new Map();
    connector.historyBackfillPromises = new Map();
    connector.saveHistoryDigests = () => {};
    connector.emit = () => {};
    connector.stopping = false;
    const calls = [];
    connector.syncDesktopRollout = async (_id, _file, options) => { calls.push(options); return true; };
    const realStatSync = fs.statSync;
    fs.statSync = (target, ...args) => {
      const value = realStatSync(target, ...args);
      return path.resolve(String(target)) === path.resolve(file) ? { ...value, size: totalSize } : value;
    };
    const result = connector.requestHistoryBackfill(threadId);
    fs.statSync = realStatSync;
    assert.equal(result.queued, true);
    await connector.historyBackfillPromises.get(threadId);
    assert.ok(calls.length >= 2);
    assert.equal(calls[0].backfillStage, 'tail');
    assert.equal(calls[0].startOffset, totalSize - HISTORY_RECENT_TAIL_BYTES);
    assert.equal(calls[1].backfillStage, 'full');
    assert.equal(calls[1].startOffset, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reuses an unchanged deferred tail and retries it after rollout growth', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-history-tail-cache-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const realStatSync = fs.statSync;
  // The production guard is intentionally above the normal multi-gigabyte
  // range; use a virtual 5 GiB file here to exercise the last-resort
  // recent-tail-only path without allocating it on disk.
  let virtualSize = 5 * 1024 * 1024 * 1024;
  let virtualMtime = Date.now();
  try {
    fs.writeFileSync(file, 'rollout fixture\n');
    const connector = Object.create(Connector.prototype);
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    connector.rolloutOffsets = new Map();
    connector.historyBackfills = new Map();
    connector.historyBackfillPromises = new Map();
    connector.saveHistoryDigests = () => {};
    connector.emit = () => {};
    connector.stopping = false;
    const calls = [];
    connector.syncDesktopRollout = async (_id, _file, options) => {
      calls.push(options);
      return true;
    };
    fs.statSync = (target, ...args) => {
      const value = realStatSync(target, ...args);
      return path.resolve(String(target)) === path.resolve(file)
        ? { ...value, size: virtualSize, mtimeMs: virtualMtime }
        : value;
    };

    const first = connector.requestHistoryBackfill(threadId);
    assert.equal(first.queued, true);
    await connector.historyBackfillPromises.get(threadId);
    assert.equal(calls.filter((options) => options?.backfillStage === 'tail').length, 1);

    const unchanged = connector.requestHistoryBackfill(threadId);
    assert.equal(unchanged.already, true);
    assert.equal(unchanged.mode, 'recent-tail');
    assert.equal(calls.filter((options) => options?.backfillStage === 'tail').length, 1);

    virtualSize += 1024;
    virtualMtime += 1;
    const grown = connector.requestHistoryBackfill(threadId);
    assert.equal(grown.queued, true);
    await connector.historyBackfillPromises.get(threadId);
    assert.equal(calls.filter((options) => options?.backfillStage === 'tail').length, 2);
  } finally {
    fs.statSync = realStatSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replays a fresh deferred-tail digest when the rollout is within the full-replay ceiling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-history-tail-ceiling-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const realStatSync = fs.statSync;
  const virtualSize = HISTORY_FULL_REPLAY_MAX_BYTES;
  try {
    fs.writeFileSync(file, 'rollout fixture\n');
    const realStat = realStatSync(file);
    const connector = Object.create(Connector.prototype);
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    connector.rolloutOffsets = new Map();
    connector.historyBackfills = new Map([[threadId, {
      version: HISTORY_BACKFILL_VERSION,
      file,
      size: virtualSize,
      mtimeMs: realStat.mtimeMs,
      stage: 'recent-tail-only',
    }]]);
    connector.historyBackfillPromises = new Map();
    connector.saveHistoryDigests = () => {};
    connector.emit = () => {};
    connector.stopping = false;
    const calls = [];
    connector.syncDesktopRollout = async (_id, _file, options) => { calls.push(options); return true; };
    fs.statSync = (target, ...args) => {
      const value = realStatSync(target, ...args);
      return path.resolve(String(target)) === path.resolve(file) ? { ...value, size: virtualSize } : value;
    };

    const result = connector.requestHistoryBackfill(threadId);
    assert.equal(result.queued, true);
    await connector.historyBackfillPromises.get(threadId);
    assert.deepEqual(calls.filter((options) => options?.backfillStage).map((options) => options.backfillStage), ['tail', 'full']);
    assert.equal(connector.historyBackfills.get(threadId).stage, 'full');
  } finally {
    fs.statSync = realStatSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not persist a deferred digest when the recent tail sync fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-history-tail-failure-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const realStatSync = fs.statSync;
  let emittedFailure = null;
  try {
    fs.writeFileSync(file, 'rollout fixture\n');
    const connector = Object.create(Connector.prototype);
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    connector.rolloutOffsets = new Map();
    connector.historyBackfills = new Map();
    connector.historyBackfillPromises = new Map();
    connector.saveHistoryDigests = () => {};
    connector.emit = (kind, _threadId, value) => {
      if (kind === 'history.sync.failed') emittedFailure = value;
    };
    connector.stopping = false;
    connector.syncDesktopRollout = async () => false;
    const virtualSize = 300 * 1024 * 1024;
    fs.statSync = (target, ...args) => {
      const value = realStatSync(target, ...args);
      return path.resolve(String(target)) === path.resolve(file) ? { ...value, size: virtualSize } : value;
    };

    const result = connector.requestHistoryBackfill(threadId);
    assert.equal(result.queued, true);
    await connector.historyBackfillPromises.get(threadId);
    assert.equal(connector.historyBackfills.has(threadId), false);
    assert.equal(emittedFailure?.reason, '最近历史同步未完成');
  } finally {
    fs.statSync = realStatSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history backfill keeps an unterminated tail retryable instead of marking it complete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-history-tail-partial-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  let partialEvent = null;
  try {
    fs.writeFileSync(file, 'unterminated rollout record');
    const connector = Object.create(Connector.prototype);
    Object.assign(connector, {
      rolloutFilesByThread: new Map([[threadId, file]]), rolloutOffsets: new Map(), rolloutPartialOffsets: new Map(),
      historyBackfills: new Map(), historyBackfillPromises: new Map(), saveHistoryDigests: () => {}, stopping: false,
      syncDesktopRollout: async () => ({ partial: true, threadId, offset: 0 }),
      emit: (kind, _id, value) => { if (kind === 'history.updated' && value?.historyPartial) partialEvent = value; },
    });
    const result = connector.requestHistoryBackfill(threadId);
    assert.equal(result.queued, true);
    await connector.historyBackfillPromises.get(threadId);
    assert.equal(connector.historyBackfills.has(threadId), false);
    assert.equal(partialEvent?.historyPartial, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('large rollout line reads stay chunked and yield to the event loop', async () => {
  const file = path.join(os.tmpdir(), `fengzhu-stream-lines-${process.pid}.jsonl`);
  const rows = Array.from({ length: 8 }, (_, index) => JSON.stringify({ index, text: 'x'.repeat(20_000) })).join('\n') + '\n';
  fs.writeFileSync(file, rows);
  try {
    const lines = [];
    let timerFired = false;
    setImmediate(() => { timerFired = true; });
    for await (const line of readRolloutLines(file, 0, fs.statSync(file).size, { chunkSize: 4 * 1024 })) lines.push(line);
    assert.equal(lines.length, 8);
    assert.equal(timerFired, true);
    assert.deepEqual(JSON.parse(lines.at(-1)).index, 7);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('large unread range delegates before allocating the legacy buffer', async () => {
  const file = path.join(os.tmpdir(), `fengzhu-stream-guard-${process.pid}.jsonl`);
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { thread_source: 'cli' } })}\n`);
  const originalFstatSync = fs.fstatSync;
  try {
    const connector = Object.create(Connector.prototype);
    connector.rolloutFilesByThread = new Map(); connector.rolloutOffsets = new Map(); connector.hiddenRollouts = new Set();
    let delegated = null;
    connector.syncDesktopRolloutStreaming = async (_threadId, _file, options) => { delegated = options; };
    // Make the descriptor report a large unread range without allocating a
    // large fixture on disk.
    fs.fstatSync = (fd, ...args) => ({ ...originalFstatSync(fd, ...args), size: 2 * 1024 * 1024 });
    await connector.syncDesktopRollout(threadId, file, { allowBackfill: true, startOffset: 0 });
    assert.equal(delegated?.offset, 0);
    assert.equal(delegated?.actualSize, 2 * 1024 * 1024);
  } finally {
    fs.fstatSync = originalFstatSync;
    fs.rmSync(file, { force: true });
  }
});

test('overlapping rollout reads do not save the same history item twice or lose later appends', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-rollout-overlap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const record = (id) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: {
    id, type: 'item_completed', item: { type: 'CommandExecution', command: ['echo', id], aggregated_output: id, exit_code: 0, status: 'completed' },
  } }) + '\n';
  fs.writeFileSync(file, record('first'));
  const connector = Object.create(Connector.prototype);
  const saved = []; const uploaded = [];
  let releaseFirst, markStarted;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  Object.assign(connector, {
    rolloutFilesByThread: new Map([[threadId, file]]), rolloutOffsets: new Map([[file, 0]]),
    rolloutPartialOffsets: new Map(), hiddenRollouts: new Set(), historyBackfillPromises: new Map(),
    desktopMetadataAt: new Map([[threadId, Date.now()]]), desktopActiveThreads: new Set(),
    followups: { matchStarted: () => null, matchStartedByLocalImagePaths: () => null },
    historyItemFrame: async (_thread, id) => {
      saved.push(id);
      if (saved.length === 1) { markStarted(); await gate; }
      return { nonce: 'synthetic', ciphertext: 'synthetic' };
    },
    putHistoryItems: async (_thread, items) => { uploaded.push(...items.map((item) => item.id)); },
    emit: () => {}, log: () => {}, publishRolloutStatus: () => {}, turnStatus: (_id, status) => status,
    releaseFollowupAttachments: () => {}, stopping: false,
  });
  const first = connector.syncDesktopRollout(threadId, file);
  await started;
  fs.appendFileSync(file, record('second'));
  const second = connector.syncDesktopRollout(threadId, file);
  const third = connector.syncDesktopRollout(threadId, file);
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([first, second, third]);
  assert.deepEqual(saved, ['first', 'second']);
  assert.deepEqual(uploaded, ['first', 'second']);
  assert.equal(connector.rolloutOffsets.get(file), fs.statSync(file).size);
});

test('rollout serialization leaves other threads responsive and continues after a failed read', async () => {
  const connector = Object.create(Connector.prototype);
  const calls = [];
  let releaseFirst, markStarted;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  connector.performDesktopRolloutSync = async (id, _file, options) => {
    calls.push(`${id}:${options.label}`);
    if (options.label === 'first') { markStarted(); await gate; throw new Error('simulated read failure'); }
    return options.label;
  };
  const first = connector.syncDesktopRollout('thread-a', 'a.jsonl', { allowBackfill: true, label: 'first' });
  const failed = assert.rejects(first, /simulated read failure/);
  await started;
  const retry = connector.syncDesktopRollout('thread-a', 'a.jsonl', { allowBackfill: true, label: 'retry' });
  const other = connector.syncDesktopRollout('thread-b', 'b.jsonl', { allowBackfill: true, label: 'other' });
  assert.equal(await other, 'other');
  assert.deepEqual(calls, ['thread-a:first', 'thread-b:other']);
  releaseFirst();
  await failed;
  assert.equal(await retry, 'retry');
  assert.deepEqual(calls, ['thread-a:first', 'thread-b:other', 'thread-a:retry']);
});

test('a watcher event after an explicit backfill is not merged into an older queued read', async () => {
  const connector = Object.create(Connector.prototype);
  const calls = [];
  let releaseFirst, markStarted;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  connector.performDesktopRolloutSync = async (_id, _file, options) => {
    calls.push(options.label);
    if (options.label === 'first') { markStarted(); await gate; }
  };
  const first = connector.syncDesktopRollout('thread-a', 'a.jsonl', { allowBackfill: true, label: 'first' });
  await started;
  const before = connector.syncDesktopRollout('thread-a', 'a.jsonl', { label: 'before' });
  const backfill = connector.syncDesktopRollout('thread-a', 'a.jsonl', { allowBackfill: true, label: 'backfill' });
  const after = connector.syncDesktopRollout('thread-a', 'a.jsonl', { label: 'after' });
  releaseFirst();
  await Promise.all([first, before, backfill, after]);
  assert.deepEqual(calls, ['first', 'before', 'backfill', 'after']);
});

test('bursts of watcher events coalesce but an event during the next read gets another pass', async () => {
  const connector = Object.create(Connector.prototype);
  let releaseFirst, releaseSecond, firstStarted, secondStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const firstReady = new Promise((resolve) => { firstStarted = resolve; });
  const secondReady = new Promise((resolve) => { secondStarted = resolve; });
  let reads = 0;
  connector.performDesktopRolloutSync = async () => {
    reads += 1;
    if (reads === 1) { firstStarted(); await firstGate; }
    else if (reads === 2) { secondStarted(); await secondGate; }
    return true;
  };
  const first = connector.syncDesktopRollout('thread-a', 'a.jsonl');
  await firstReady;
  const burst = Array.from({ length: 1000 }, () => connector.syncDesktopRollout('thread-a', 'a.jsonl'));
  assert.equal(new Set(burst).size, 1, 'one pending read should cover the first burst');
  releaseFirst();
  await secondReady;
  const later = connector.syncDesktopRollout('thread-a', 'a.jsonl');
  releaseSecond();
  await Promise.all([first, ...burst, later]);
  assert.equal(reads, 3, 'a later append needs a fresh pass after the current read');
});

test('small rollout retries a middle-of-line tail after the terminating newline arrives', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-partial-small-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const prefix = `${JSON.stringify({ type: 'session_meta', payload: { thread_source: 'cli' } })}\n`;
  const body = JSON.stringify({
    type: 'response_item',
    timestamp: new Date().toISOString(),
    payload: { id: 'small-partial', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `前缀${'x'.repeat(100_000)}` }] },
  });
  try {
    fs.writeFileSync(file, prefix + body);
    const connector = Object.create(Connector.prototype);
    const uploaded = [];
    Object.assign(connector, {
      config: { accountKey: Buffer.alloc(32) },
      api: { path: (value) => value, request: async (_path, options) => { uploaded.push(...(options.body?.items || [])); } },
      rolloutFilesByThread: new Map([[threadId, file]]),
      rolloutOffsets: new Map(), rolloutPartialOffsets: new Map(), hiddenRollouts: new Set(),
      historyBackfillPromises: new Map(), desktopMetadataAt: new Map([[threadId, Date.now()]]), desktopActiveThreads: new Set(),
      followups: { matchStarted: () => null, matchStartedByLocalImagePaths: () => null },
      emit: () => {}, publishThreadStatus: () => {}, syncThreadMetadata: async () => {}, releaseFollowupAttachments: () => {},
      stopping: false,
    });
    const middle = prefix.length + Math.floor(body.length / 2);
    const first = await connector.syncDesktopRollout(threadId, file, { allowBackfill: true, startOffset: middle });
    assert.equal(first?.partial, true);
    assert.equal(connector.rolloutOffsets.get(file), prefix.length);
    assert.equal(uploaded.length, 0);

    fs.appendFileSync(file, '\n');
    const second = await connector.syncDesktopRollout(threadId, file, { allowBackfill: true });
    assert.equal(second, true);
    assert.equal(uploaded.length, 1);
    assert.equal(connector.rolloutOffsets.get(file), fs.statSync(file).size);
    assert.equal(connector.rolloutPartialOffsets.has(file), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('streaming rollout holds an incomplete trailing line and resumes it after append', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-partial-stream-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const record = (id, size) => JSON.stringify({
    type: 'response_item', timestamp: new Date().toISOString(),
    payload: { id, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(size) }] },
  });
  const prefix = `${JSON.stringify({ type: 'session_meta', payload: { thread_source: 'cli' } })}\n`;
  const complete = record('stream-complete', 700_000);
  const pending = record('stream-pending', 700_000);
  try {
    fs.writeFileSync(file, `${prefix}${complete}\n${pending}`);
    const connector = Object.create(Connector.prototype);
    const uploaded = [];
    Object.assign(connector, {
      config: { accountKey: Buffer.alloc(32) },
      api: { path: (value) => value, request: async (_path, options) => { uploaded.push(...(options.body?.items || [])); } },
      rolloutFilesByThread: new Map([[threadId, file]]),
      rolloutOffsets: new Map(), rolloutPartialOffsets: new Map(), hiddenRollouts: new Set(),
      historyBackfillPromises: new Map(), desktopMetadataAt: new Map([[threadId, Date.now()]]), desktopActiveThreads: new Set(),
      followups: { matchStarted: () => null, matchStartedByLocalImagePaths: () => null },
      emit: () => {}, publishThreadStatus: () => {}, syncThreadMetadata: async () => {}, releaseFollowupAttachments: () => {},
      stopping: false,
    });
    const first = await connector.syncDesktopRollout(threadId, file, { allowBackfill: true, startOffset: 0 });
    assert.equal(first?.partial, true);
    assert.equal(uploaded.length, 1);
    const pendingOffset = prefix.length + complete.length + 1;
    assert.equal(connector.rolloutOffsets.get(file), pendingOffset);

    fs.appendFileSync(file, '\n');
    const second = await connector.syncDesktopRollout(threadId, file, { allowBackfill: true });
    assert.equal(second, true);
    assert.equal(uploaded.length, 2);
    assert.equal(connector.rolloutOffsets.get(file), fs.statSync(file).size);
    assert.equal(connector.rolloutPartialOffsets.has(file), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('small rollout sync emits only the latest thread settings snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-settings-dedupe-small-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const settings = (timestamp, model, mode) => JSON.stringify({
    type: 'event_msg', timestamp,
    payload: {
      type: 'thread_settings_updated',
      thread_settings: { model, effort: 'medium', collaborationMode: { mode } },
    },
  });
  try {
    fs.writeFileSync(file, [
      settings('2026-08-24T00:00:00.000Z', 'old-model', 'default'),
      settings('2026-08-24T00:00:01.000Z', 'new-model', 'plan'),
      settings('2026-08-24T00:00:02.000Z', 'new-model', 'plan'),
    ].join('\n') + '\n');
    const emitted = [];
    const connector = Object.create(Connector.prototype);
    Object.assign(connector, {
      config: { accountKey: Buffer.alloc(32) },
      api: { path: (value) => value, request: async () => {} },
      rolloutFilesByThread: new Map([[threadId, file]]), rolloutOffsets: new Map(), rolloutPartialOffsets: new Map(),
      hiddenRollouts: new Set(), historyBackfillPromises: new Map(), desktopMetadataAt: new Map([[threadId, Date.now()]]),
      desktopActiveThreads: new Set(), rolloutSettingsSnapshots: new Map(),
      followups: { matchStarted: () => null, matchStartedByLocalImagePaths: () => null },
      emit: (kind, _id, value) => { if (kind === 'thread.settings') emitted.push(value); },
      publishThreadStatus: () => {}, syncThreadMetadata: async () => {}, releaseFollowupAttachments: () => {},
      stopping: false,
    });
    await connector.syncDesktopRollout(threadId, file, { allowBackfill: true, startOffset: 0 });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].settings.model, 'new-model');
    assert.equal(emitted[0].settings.effectiveCollaborationMode, 'plan');

    // A full replay can finish after a live tail. Older settings must not roll
    // back the value that the phone already received.
    connector.publishRolloutThreadSettings(threadId, emitted[0].settings, Date.parse('2026-08-23T00:00:00.000Z'));
    assert.equal(emitted.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('streaming rollout sync coalesces repeated settings during a large replay', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-settings-dedupe-stream-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const settings = (timestamp, model, mode) => JSON.stringify({
    type: 'event_msg', timestamp,
    payload: {
      type: 'thread_settings_updated',
      thread_settings: { model, effort: 'high', collaborationMode: { mode } },
    },
  });
  try {
    const huge = JSON.stringify({
      type: 'response_item', timestamp: '2026-08-24T00:00:01.000Z',
      payload: { id: 'large-row', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(700_000) }] },
    });
    fs.writeFileSync(file, [
      settings('2026-08-24T00:00:00.000Z', 'old-model', 'default'),
      huge,
      settings('2026-08-24T00:00:02.000Z', 'new-model', 'plan'),
      settings('2026-08-24T00:00:03.000Z', 'new-model', 'plan'),
    ].join('\n') + '\n');
    const emitted = []; const uploaded = [];
    const connector = Object.create(Connector.prototype);
    Object.assign(connector, {
      config: { accountKey: Buffer.alloc(32) },
      api: { path: (value) => value, request: async (_path, options) => uploaded.push(...(options.body?.items || [])) },
      rolloutFilesByThread: new Map([[threadId, file]]), rolloutOffsets: new Map(), rolloutPartialOffsets: new Map(),
      hiddenRollouts: new Set(), historyBackfillPromises: new Map(), desktopMetadataAt: new Map([[threadId, Date.now()]]),
      desktopActiveThreads: new Set(), rolloutSettingsSnapshots: new Map(),
      followups: { matchStarted: () => null, matchStartedByLocalImagePaths: () => null },
      emit: (kind, _id, value) => { if (kind === 'thread.settings') emitted.push(value); },
      publishThreadStatus: () => {}, syncThreadMetadata: async () => {}, releaseFollowupAttachments: () => {},
      stopping: false,
    });
    await connector.syncDesktopRolloutStreaming(threadId, file, {
      allowBackfill: true, offset: 0, actualSize: fs.statSync(file).size, firstRead: true, backfillStage: 'full',
    });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].settings.model, 'new-model');
    assert.equal(emitted[0].settings.effectiveCollaborationMode, 'plan');
    assert.equal(uploaded.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('streaming status re-reads the current tail after a previous task_complete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-stream-status-race-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const old = new Date(Date.now() - 60_000).toISOString();
  const rows = [
    JSON.stringify({ timestamp: old, type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: old, type: 'event_msg', payload: { type: 'task_complete' } }),
    JSON.stringify({ timestamp: old, type: 'response_item', payload: { id: 'large-status-row', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(700_000) }] } }),
  ].join('\n') + '\n';
  fs.writeFileSync(file, rows);
  try {
    const published = [];
    const connector = Object.create(Connector.prototype);
    Object.assign(connector, {
      config: { accountKey: Buffer.alloc(32) },
      api: { path: (value) => value, request: async () => {} },
      rolloutFilesByThread: new Map([[threadId, file]]), rolloutOffsets: new Map(), rolloutPartialOffsets: new Map(),
      hiddenRollouts: new Set(), historyBackfillPromises: new Map(), desktopMetadataAt: new Map([[threadId, Date.now()]]),
      desktopActiveThreads: new Set([threadId]), desktopStatuses: new Map([[threadId, 'desktop_running']]),
      followups: { matchStarted: () => null, matchStartedByLocalImagePaths: () => null },
      emit: () => {}, publishThreadStatus: (id, status) => published.push([id, status]),
      turnStatus: (_id, status) => status,
      syncThreadMetadata: async () => {}, releaseFollowupAttachments: () => {}, stopping: false,
      putHistoryItems: async () => {
        // Simulate Codex appending the next turn while the large range is
        // being replayed. The initial range still ends on the old terminal;
        // the authoritative tail read must see this marker.
        fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`);
      },
    });
    const initialSize = fs.statSync(file).size;
    await connector.syncDesktopRolloutStreaming(threadId, file, {
      allowBackfill: true, offset: 0, actualSize: initialSize, firstRead: true, backfillStage: 'full',
    });
    assert.equal(published.at(-1)?.[1], 'running');
    assert.equal(published.some(([, status]) => status === 'completed'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a live tail inside a serialized full replay completes before the queued watcher', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-full-live-tail-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  fs.writeFileSync(file, '{"old":true}\n');
  let timer;
  try {
    const calls = [];
    const connector = Object.create(Connector.prototype);
    connector.rolloutPartialOffsets = new Map([[file, 4]]);
    connector.performDesktopRolloutSync = async (_id, target, options) => {
      if (options.backfillStage === 'full') {
        calls.push('full-start');
        fs.appendFileSync(target, '{"new":true}\n');
        await connector.syncRecentRolloutTailDuringBackfill(threadId, target);
        calls.push('full-end');
      } else if (options.backfillStage === 'live-tail') {
        assert.equal(connector.rolloutPartialOffsets.has(target), false, 'the full replay cursor must not rewind the tail');
        assert.match(fs.readFileSync(target, 'utf8'), /"new":true/);
        calls.push('live-tail');
      } else calls.push('watcher');
      return true;
    };
    const full = connector.syncDesktopRollout(threadId, file, { allowBackfill: true, startOffset: 0, backfillStage: 'full' });
    const watcher = connector.syncDesktopRollout(threadId, file);
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('full replay deadlocked behind itself')), 1500); });
    await Promise.race([Promise.all([full, watcher]), deadline]);
    assert.deepEqual(calls, ['full-start', 'live-tail', 'full-end', 'watcher']);
    assert.equal(connector.rolloutPartialOffsets.get(file), 4);
    assert.equal(connector.rolloutSyncTails.size, 0);
  } finally {
    clearTimeout(timer);
    fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
});

test('a long streaming replay publishes newly appended messages and releases its watcher', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-full-live-stream-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const rows = Array.from({ length: 110 }, (_, index) => JSON.stringify({
    type: 'response_item', timestamp: '2026-11-01T00:00:00.000Z',
    payload: { id: `old-${index}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(7_000) }] },
  })).join('\n') + '\n';
  fs.writeFileSync(file, rows);
  const realNow = Date.now;
  let timer;
  try {
    let now = realNow();
    Date.now = () => now;
    let appended = false;
    const uploaded = [];
    const connector = Object.create(Connector.prototype);
    Object.assign(connector, {
      rolloutFilesByThread: new Map([[threadId, file]]), rolloutOffsets: new Map(), rolloutPartialOffsets: new Map(),
      hiddenRollouts: new Set(), historyBackfillPromises: new Map(), desktopMetadataAt: new Map([[threadId, Number.MAX_SAFE_INTEGER]]),
      desktopActiveThreads: new Set(), desktopStatuses: new Map(), stopping: false,
      noteRolloutRead: () => {}, trackCodexWaiting: () => false, emit: () => {},
      historyItemFrame: async (_thread, _itemId, value) => value,
      followups: { matchStarted: () => null, matchStartedByLocalImagePaths: () => null },
      turnStatus: (_id, status) => status, publishRolloutStatus: () => {}, releaseFollowupAttachments: () => {},
      putHistoryItems: async (_id, items) => {
        uploaded.push(...items.map((item) => item.id));
        if (!appended) {
          appended = true;
          fs.appendFileSync(file, `${JSON.stringify({ type: 'response_item', timestamp: '2026-11-02T00:00:00.000Z',
            payload: { id: 'new-live-message', type: 'message', role: 'user', content: [{ type: 'input_text', text: '新消息' }] } })}\n`);
          now += 6_000;
        }
      },
    });
    const full = connector.syncDesktopRollout(threadId, file, { allowBackfill: true, startOffset: 0, backfillStage: 'full' });
    const watcher = connector.syncDesktopRollout(threadId, file);
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('streaming replay did not finish')), 5000); });
    await Promise.race([Promise.all([full, watcher]), deadline]);
    assert.ok(uploaded.includes('new-live-message'), 'the live tail must publish the record appended during replay');
    assert.equal(connector.rolloutSyncTails.size, 0);
    assert.equal(connector.rolloutOffsets.get(file), fs.statSync(file).size);
  } finally {
    clearTimeout(timer);
    Date.now = realNow;
    fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
});

test('full replay restores its cursor when a live tail pass changes it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-full-tail-cursor-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const rows = Array.from({ length: 101 }, (_, index) => JSON.stringify({
    type: 'response_item', timestamp: `2026-08-24T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    payload: { id: `cursor-${index}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `row-${index}` }] },
  })).join('\n') + '\n';
  fs.writeFileSync(file, rows);
  const realNow = Date.now;
  try {
    await readyCrypto();
    const connector = Object.create(Connector.prototype);
    const fullOffset = 0;
    const fullPartialOffset = 17;
    Object.assign(connector, {
      config: { accountKey: Buffer.alloc(32) },
      api: { path: (value) => value, request: async () => {} },
      rolloutFilesByThread: new Map([[threadId, file]]),
      rolloutOffsets: new Map([[file, fullOffset]]),
      rolloutPartialOffsets: new Map([[file, fullPartialOffset]]),
      hiddenRollouts: new Set(), historyBackfillPromises: new Map(),
      desktopMetadataAt: new Map([[threadId, Number.MAX_SAFE_INTEGER]]),
      desktopActiveThreads: new Set(),
      followups: { matchStarted: () => null, matchStartedByLocalImagePaths: () => null },
      emit: () => {}, publishThreadStatus: () => {}, syncThreadMetadata: async () => {},
      releaseFollowupAttachments: () => {}, stopping: false,
    });
    let nowCalls = 0;
    Date.now = () => (nowCalls++ === 0 ? 1_000 : 7_000);
    connector.syncRecentRolloutTailDuringBackfill = async () => {
      connector.rolloutOffsets.set(file, 999);
      connector.rolloutPartialOffsets.set(file, 888);
      throw new Error('tail probe failed');
    };

    await assert.rejects(
      connector.syncDesktopRolloutStreaming(threadId, file, {
        allowBackfill: true, offset: 0, actualSize: fs.statSync(file).size,
        firstRead: true, backfillStage: 'full',
      }),
      /tail probe failed/,
    );
    assert.equal(connector.rolloutOffsets.get(file), fullOffset);
    assert.equal(connector.rolloutPartialOffsets.get(file), fullPartialOffset);
  } finally {
    Date.now = realNow;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rollout tail keeps visible messages and ignores internal counters', () => {
  assert.deepEqual(rolloutItem({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'live' }] } }),
    { type: 'agentMessage', text: 'live', truncated: false, status: null });
  assert.deepEqual(rolloutItem({ type: 'event_msg', payload: { type: 'user_message', message: '来自电脑端的用户输入' } }),
    { type: 'userMessage', text: '来自电脑端的用户输入', truncated: false, status: null });
  assert.equal(rolloutItem({ type: 'event_msg', payload: { type: 'token_count' } }), null);
});

test('local image rollout records keep a safe attachment label and inline preview', () => {
  const data = `data:image/png;base64,${'p'.repeat(32)}`;
  const event = rolloutItem({ type: 'event_msg', payload: {
    type: 'user_message', message: '',
    local_images: ['C:\\Users\\me\\AppData\\Local\\Temp\\uploads\\01234567-89ab-cdef-0123-456789abcdef-photo.png'],
  } });
  assert.deepEqual(event, {
    type: 'userMessage', text: '[khLink 图片附件] photo.png\n附件编号：01234567-89ab-cdef-0123-456789abcdef', truncated: false, status: null,
  });
  const response = rolloutItem({ type: 'response_item', payload: {
    type: 'message', role: 'user', content: [
      { type: 'input_image', image_url: data },
      { type: 'input_text', text: '</image>' },
    ],
  } });
  assert.equal(response.type, 'userMessage');
  assert.equal(response.text, '图片附件');
  assert.deepEqual(response.images, [{ data, mimeType: 'image/png' }]);
});

test('deduplicates response user copies when the canonical user event is present', () => {
  const event = { type: 'event_msg', timestamp: '2026-08-21T00:00:00.000Z', payload: { type: 'user_message', message: '继续处理' } };
  const copy = { type: 'response_item', timestamp: '2026-08-21T00:00:00.100Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续处理' }] } };
  const independent = { ...copy, timestamp: '2026-08-21T00:01:00.000Z' };
  assert.equal(isDuplicateRolloutUserCopy(copy, [{ at: Date.parse(event.timestamp), message: '继续处理' }]), true);
  assert.equal(isDuplicateRolloutUserCopy(independent, [{ at: Date.parse(event.timestamp), message: '继续处理' }]), false);
});

test('deduplicates the response copy of a pure local-image user event', () => {
  const data = `data:image/png;base64,${'i'.repeat(32)}`;
  const copy = { type: 'response_item', timestamp: '2026-08-21T00:00:00.100Z', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_image', image_url: data }, { type: 'input_text', text: '</image>' }],
  } };
  assert.equal(isDuplicateRolloutUserCopy(copy, [{
    at: Date.parse('2026-08-21T00:00:00.000Z'), message: '', localImages: ['C:\\Temp\\01234567-89ab-cdef-0123-456789abcdef-photo.png'],
  }]), true);
});

test('keeps Codex desktop image output as a mobile-viewable history item', () => {
  const data = `data:image/jpeg;base64,${'b'.repeat(32)}`;
  const result = rolloutItem({ type: 'response_item', payload: {
    type: 'custom_tool_call_output',
    output: [{ type: 'text', text: '桌面图像' }, { type: 'input_image', detail: 'original', image_url: data }],
  } });
  assert.equal(result.type, 'imageView');
  assert.equal(result.text, '桌面图像');
  assert.deepEqual(result.images, [{ data, mimeType: 'image/jpeg' }]);
});

test('keeps Codex function_call_output image generation visible on mobile', () => {
  const data = `data:image/png;base64,${'c'.repeat(32)}`;
  const result = rolloutItem({ type: 'response_item', payload: {
    type: 'function_call_output',
    output: [
      { type: 'input_text', text: 'Generated images are saved to C:\\Users\\me\\.codex\\generated_images\\logo.png' },
      { type: 'input_image', image_url: data, detail: 'original' },
    ],
  } });
  assert.equal(result.type, 'imageGeneration');
  assert.equal(result.text, '图片已生成');
  assert.deepEqual(result.images, [{ data, mimeType: 'image/png' }]);
});

test('keeps Codex built-in image generation output as a mobile-viewable history item', () => {
  const base64 = Buffer.from('generated png bytes').toString('base64');
  const result = rolloutItem({ type: 'response_item', payload: {
    type: 'image_generation_call', status: 'completed', result: base64, saved_path: 'generated.png',
  } });
  assert.equal(result.type, 'imageGeneration');
  assert.equal(result.text, '图片已生成');
  assert.deepEqual(result.images, [{ data: `data:image/png;base64,${base64}`, mimeType: 'image/png' }]);
});

test('keeps event_msg image_generation_end output as a mobile-viewable history item', () => {
  const base64 = Buffer.from('generated png bytes from event').toString('base64');
  const result = rolloutItem({ type: 'event_msg', payload: {
    type: 'image_generation_end', status: 'completed', result: base64,
  } });
  assert.equal(result.type, 'imageGeneration');
  assert.equal(result.text, '图片已生成');
  assert.deepEqual(result.images, [{ data: `data:image/png;base64,${base64}`, mimeType: 'image/png' }]);
});

test('maps desktop lifecycle and input events to mobile task states', () => {
  assert.equal(rolloutStatus({ type: 'event_msg', payload: { type: 'user_message', message: 'normal user input' } }), 'running');
  assert.equal(rolloutStatus({ type: 'response_item', payload: { type: 'message', role: 'user' } }), 'running');
  assert.equal(rolloutStatus({ type: 'event_msg', payload: { type: 'task_started' } }), 'running');
  assert.equal(rolloutStatus({ type: 'event_msg', payload: { type: 'task_complete' } }), 'completed');
  assert.equal(rolloutStatus({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'request_user_input' } }), 'waiting_input');
  assert.equal(notificationStatus('turn/failed'), 'failed');
  assert.equal(notificationStatus('turn/completed', { turn: { status: 'interrupted' } }), 'cancelled');
  assert.equal(notificationStatus('turn/completed', { turn: { status: 'failed' } }), 'failed');
  assert.equal(notificationStatus('turn/completed', { turn: { status: 'completed' } }), 'completed');
  assert.equal(desktopOwnedStatus('running'), 'desktop_running');
  assert.equal(desktopOwnedStatus('waiting_input'), 'desktop_waiting_input');
  assert.equal(mobileOwnedStatus('running'), 'mobile_running');
  assert.equal(mobileOwnedStatus('completed'), 'completed');
});

test('preserves desktop rollout errors as visible history items', () => {
  const record = { type: 'event_msg', payload: { type: 'task_complete', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } } };
  assert.equal(rolloutStatus(record), 'failed');
  assert.equal(rolloutErrorText(record), 'exceeded retry limit, last status: 429 Too Many Requests');
  assert.deepEqual(rolloutItem(record), {
    type: 'turnError', text: 'exceeded retry limit, last status: 429 Too Many Requests', truncated: false, status: 'failed',
  });
});

test('does not turn normal rollout messages or tool metadata into failures', () => {
  const records = [
    { type: 'event_msg', payload: { type: 'agent_message', message: 'normal progress update' } },
    { type: 'event_msg', payload: { type: 'tool_status', error: 'informational field', message: 'still running' } },
  ];
  for (const record of records) {
    assert.equal(rolloutErrorText(record), '');
    assert.notEqual(rolloutStatus(record), 'failed');
    assert.equal(rolloutItem(record), null);
  }
});

test('recognizes both Codex user-message record shapes for follow-up delivery', () => {
  assert.equal(rolloutUserText({ type: 'event_msg', payload: { type: 'user_message', message: 'next' } }), 'next');
  assert.equal(rolloutUserText({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] } }), 'next');
});

test('keeps the first complete record of an incremental rollout append', () => {
  assert.equal(shouldDiscardPartialRolloutLine(false, 4096), false);
  assert.equal(shouldDiscardPartialRolloutLine(true, 4096), true);
  assert.equal(shouldDiscardPartialRolloutLine(true, 0), false);
});

test('recovers a resumed desktop turn from a user message marker', () => {
  const file = path.join(os.tmpdir(), `fengzhu-resumed-rollout-${process.pid}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message' } })}\n`);
  try { assert.equal(latestRolloutStatus(file, fs.statSync(file).size), 'running'); }
  finally { fs.unlinkSync(file); }
});

test('does not reopen a completed rollout for trailing tool bookkeeping', () => {
  const file = path.join(os.tmpdir(), `fengzhu-completed-tool-tail-${process.pid}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'bookkeeping', output: [] } })}\n`);
  try { assert.equal(latestRolloutStatus(file, fs.statSync(file).size), 'completed'); }
  finally { fs.unlinkSync(file); }
});

test('drops an out-of-order running range after a terminal rollout marker', () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map();
  connector.rolloutTerminalWatermarks = new Map();
  const published = [];
  connector.publishThreadStatus = (threadId, status) => {
    published.push([threadId, status]);
    connector.desktopStatuses.set(threadId, status);
  };
  const file = 'rollout.jsonl';
  const terminal = { status: 'completed', statusMarker: { at: 2_000, ordinal: 20 },
    turnStartMarker: { at: 1_000, ordinal: 10 }, statusTurnId: 'turn-1' };
  const staleRange = { status: 'running', statusMarker: { at: 1_500, ordinal: 15 },
    turnStartMarker: { at: 1_000, ordinal: 10 }, turnStartTurnId: 'turn-1' };
  const newTurn = { status: 'running', statusMarker: { at: 3_000, ordinal: 30 },
    turnStartMarker: { at: 3_000, ordinal: 30 }, turnStartTurnId: 'turn-2' };
  assert.equal(connector.publishRolloutStatus('task-1', 'completed', file, terminal), true);
  assert.equal(connector.publishRolloutStatus('task-1', 'running', file, staleRange), false);
  assert.equal(connector.desktopStatuses.get('task-1'), 'completed');
  assert.equal(connector.publishRolloutStatus('task-1', 'running', file, newTurn), true);
  assert.deepEqual(published, [['task-1', 'completed'], ['task-1', 'running']]);
});

test('rollout status freshness uses record timestamps when file mtime is old', () => {
  const file = path.join(os.tmpdir(), `fengzhu-rollout-fresh-record-${process.pid}.jsonl`);
  const now = Date.now();
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: new Date(now - 1000).toISOString(), ordinal: 100, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
    JSON.stringify({ timestamp: new Date(now).toISOString(), ordinal: 101, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
  ].join('\n') + '\n');
  try {
    fs.utimesSync(file, new Date(now - 60 * 60_000), new Date(now - 60 * 60_000));
    const evidence = readRolloutEvidence(file);
    assert.equal(evidence.status, 'completed');
    assert.equal(evidence.statusMarker.ordinal, 101);
    assert.equal(latestRolloutStatusEvidence(file, fs.statSync(file).size).turnStartMarker.ordinal, 100);
  } finally { fs.unlinkSync(file); }
});

test('recovers the latest desktop state from an existing large rollout', () => {
  const file = path.join(os.tmpdir(), `fengzhu-rollout-${process.pid}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n${'x'.repeat(1024 * 1024 + 10)}\n`);
  try { assert.equal(latestRolloutStatus(file, fs.statSync(file).size), 'running'); }
  finally { fs.unlinkSync(file); }
});

test('replays only active task states for a newly connected mobile client', () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([
    ['running-task', 'desktop_running'],
    ['waiting-task', 'desktop_waiting_input'],
    ['finished-task', 'completed'],
  ]);
  const emitted = [];
  connector.emit = (kind, threadId, value) => emitted.push({ kind, threadId, value });

  connector.republishActiveThreadStatuses();

  assert.deepEqual(emitted.map((item) => [item.kind, item.threadId, item.value.status]), [
    ['thread.status.snapshot', 'running-task', 'desktop_running'],
    ['thread.status.snapshot', 'waiting-task', 'desktop_waiting_input'],
  ]);
});

test('desktop polling refreshes metadata for the newest task and active tasks', async () => {
  const connector = Object.create(Connector.prototype);
  connector.stopping = false;
  connector.realtimeSyncRunning = false;
  connector.realtimeThreads = new Map();
  connector.ws = { readyState: WebSocket.OPEN };
  connector.codex = {
    ready: true,
    request: async (method, params) => params?.archived ? { data: [] } : ({ data: [
      { id: 'newest', status: 'idle', updatedAt: 2 },
      { id: 'active', status: { type: 'active' }, updatedAt: 1 },
      { id: 'old', status: 'idle', updatedAt: 1 },
    ] }),
  };
  connector.emit = () => {};
  const reads = [];
  connector.syncThreadMetadata = async (thread) => { reads.push(thread.id); };

  await connector.syncDesktopActivity();
  await connector.syncDesktopActivity();

  assert.deepEqual(reads, ['newest', 'active']);
});

test('desktop polling keeps a live state when Codex only reports idle', () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([
    ['finished-task', 'desktop_running'],
    ['waiting-task', 'desktop_waiting_input'],
  ]);
  const emitted = [];
  connector.emit = (kind, threadId, value) => emitted.push({ kind, threadId, value });

  connector.reconcileDesktopThreadStatus({ id: 'finished-task', status: 'idle' });
  connector.reconcileDesktopThreadStatus({ id: 'waiting-task', status: { type: 'active' } });

  assert.equal(connector.desktopStatuses.get('finished-task'), 'desktop_running');
  assert.equal(connector.desktopStatuses.get('waiting-task'), 'desktop_waiting_input');
  assert.deepEqual(emitted, []);
});

test('keeps a fresh running rollout when the Desktop list briefly reports idle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-fresh-running-rollout-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`);
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.desktopStatusAt = new Map([[threadId, Date.now() - 60_000]]);
    connector.desktopLastActiveAt = new Map([[threadId, Date.now() - 60_000]]);
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    connector.emit = () => { throw new Error('fresh rollout must not be cleared'); };
    connector.reconcileDesktopThreadStatus({ id: threadId, status: 'idle' }, false);
    assert.equal(connector.desktopStatuses.get(threadId), 'desktop_running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale file mtime cannot complete a rollout whose last record is recent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-stale-mtime-fresh-record-'));
  const previousHome = process.env.CODEX_HOME;
  const threadId = 'abcdef12-3456-1234-1234-123456789abc';
  const directory = path.join(root, 'sessions', '2026', '10', '06');
  const file = path.join(directory, `rollout-${threadId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`);
  const old = new Date(Date.now() - 60 * 60_000); fs.utimesSync(file, old, old);
  process.env.CODEX_HOME = root;
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.desktopActiveThreads = new Set();
    connector.desktopActivitySnapshotHealthy = true;
    connector.desktopActivitySnapshotAt = Date.now();
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    connector.rolloutStatusScans = new Map(); connector.rolloutLookupAt = new Map(); connector.threadState = new Map();
    connector.turnStatus = (_id, status) => status;
    const emitted = [];
    connector.emit = (kind, id, value) => emitted.push([kind, id, value.status]);
    connector.reconcileLiveStatusesFromRollouts();
    assert.equal(connector.desktopStatuses.get(threadId), 'running');
    assert.deepEqual(emitted, [['thread.status', threadId, 'running']]);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rollout fallback clears a live badge when the file watcher misses task completion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-status-reconcile-'));
  const previousHome = process.env.CODEX_HOME;
  const threadId = '12345678-1234-1234-1234-123456789abc';
  const directory = path.join(root, 'sessions', '2026', '08', '17');
  const file = path.join(directory, `rollout-${threadId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
  process.env.CODEX_HOME = root;
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.rolloutFilesByThread = new Map(); connector.rolloutStatusScans = new Map(); connector.threadState = new Map();
    const emitted = [];
    connector.emit = (kind, id, value) => emitted.push([kind, id, value.status]);
    connector.reconcileLiveStatusesFromRollouts();
    assert.equal(connector.desktopStatuses.get(threadId), 'completed');
    assert.deepEqual(emitted, [['thread.status', threadId, 'completed']]);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a recent completion without a start marker cannot override an actively running Desktop task', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-active-status-'));
  const previousHome = process.env.CODEX_HOME;
  const threadId = 'abcdef12-1234-1234-1234-123456789abc';
  const directory = path.join(root, 'sessions', '2026', '08', '18');
  const file = path.join(directory, `rollout-${threadId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
  process.env.CODEX_HOME = root;
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.desktopActiveThreads = new Set([threadId]);
    connector.rolloutFilesByThread = new Map(); connector.rolloutStatusScans = new Map(); connector.threadState = new Map();
    connector.emit = () => {};
    connector.reconcileLiveStatusesFromRollouts();
    assert.equal(connector.desktopStatuses.get(threadId), 'desktop_running');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not manufacture completion from a months-old active rollout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-stale-active-'));
  const previousHome = process.env.CODEX_HOME;
  const threadId = 'abcdef12-5678-1234-1234-123456789abc';
  const directory = path.join(root, 'sessions', '2026', '06', '18');
  const file = path.join(directory, `rollout-${threadId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  const oldAt = Date.now() - 30 * 24 * 60 * 60_000;
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date(oldAt).toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`);
  const old = new Date(oldAt);
  fs.utimesSync(file, old, old);
  process.env.CODEX_HOME = root;
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.desktopActiveThreads = new Set([threadId]);
    connector.rolloutFilesByThread = new Map(); connector.rolloutStatusScans = new Map(); connector.rolloutLookupAt = new Map(); connector.threadState = new Map();
    const emitted = [];
    connector.emit = (kind, id, value) => emitted.push([kind, id, value.status]);
    connector.reconcileLiveStatusesFromRollouts();
    assert.equal(connector.desktopStatuses.get(threadId), 'desktop_running');
    assert.deepEqual(emitted, []);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not complete an old active rollout merely because Desktop no longer lists it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-stale-unlisted-'));
  const previousHome = process.env.CODEX_HOME;
  const threadId = 'abcdef12-3456-1234-1234-123456789abc';
  const directory = path.join(root, 'sessions', '2026', '06', '18');
  const file = path.join(directory, `rollout-${threadId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  const oldAt = Date.now() - 30 * 24 * 60 * 60_000;
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date(oldAt).toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`);
  const old = new Date(oldAt);
  fs.utimesSync(file, old, old);
  process.env.CODEX_HOME = root;
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.desktopActiveThreads = new Set();
    connector.rolloutFilesByThread = new Map(); connector.rolloutStatusScans = new Map(); connector.rolloutLookupAt = new Map(); connector.threadState = new Map();
    connector.emit = () => {};
    connector.reconcileLiveStatusesFromRollouts();
    assert.equal(connector.desktopStatuses.get(threadId), 'desktop_running');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh Desktop snapshot does not complete a quiet unlisted turn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-quiet-orphan-'));
  const previousHome = process.env.CODEX_HOME;
  const threadId = 'abcdef12-6789-1234-1234-123456789abc';
  const directory = path.join(root, 'sessions', '2026', '08', '18');
  const file = path.join(directory, `rollout-${threadId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  const oldAt = Date.now() - 11 * 60_000;
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date(oldAt).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'interrupted' } })}\n`);
  const old = new Date(oldAt);
  fs.utimesSync(file, old, old);
  process.env.CODEX_HOME = root;
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.desktopActiveThreads = new Set();
    connector.desktopActivitySnapshotAt = Date.now();
    connector.desktopActivitySnapshotHealthy = true;
    connector.rolloutFilesByThread = new Map(); connector.rolloutStatusScans = new Map(); connector.rolloutLookupAt = new Map(); connector.threadState = new Map();
    const emitted = [];
    connector.emit = (kind, id, value) => emitted.push([kind, id, value.status]);
    connector.reconcileLiveStatusesFromRollouts();
    assert.equal(connector.desktopStatuses.get(threadId), 'desktop_running');
    assert.deepEqual(emitted, []);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a completed tool is not the end of a quiet turn without task_complete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-quiet-tool-orphan-'));
  const previousHome = process.env.CODEX_HOME;
  const threadId = 'abcdef12-6789-1234-1234-123456789abd';
  const directory = path.join(root, 'sessions', '2026', '08', '18');
  const file = path.join(directory, `rollout-${threadId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  const oldAt = Date.now() - 11 * 60_000;
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: new Date(oldAt).toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: new Date(oldAt + 1000).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', name: 'exec' } }),
  ].join('\n') + '\n');
  const old = new Date(oldAt);
  fs.utimesSync(file, old, old);
  process.env.CODEX_HOME = root;
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.desktopActiveThreads = new Set([threadId]);
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    connector.rolloutStatusScans = new Map(); connector.rolloutLookupAt = new Map(); connector.threadState = new Map();
    const emitted = [];
    connector.emit = (kind, id, value) => emitted.push([kind, id, value.status]);
    connector.reconcileLiveStatusesFromRollouts();
    assert.equal(connector.desktopStatuses.get(threadId), 'desktop_running');
    assert.deepEqual(emitted, []);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not reclaim a quiet rollout without a fresh Desktop snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-quiet-unknown-'));
  const previousHome = process.env.CODEX_HOME;
  const threadId = 'abcdef12-7890-1234-1234-123456789abc';
  const directory = path.join(root, 'sessions', '2026', '08', '18');
  const file = path.join(directory, `rollout-${threadId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  const oldAt = Date.now() - 11 * 60_000;
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date(oldAt).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'still possible' } })}\n`);
  const old = new Date(oldAt);
  fs.utimesSync(file, old, old);
  process.env.CODEX_HOME = root;
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.desktopActiveThreads = new Set();
    connector.desktopActivitySnapshotAt = 0;
    connector.desktopActivitySnapshotHealthy = false;
    connector.rolloutFilesByThread = new Map(); connector.rolloutStatusScans = new Map(); connector.rolloutLookupAt = new Map(); connector.threadState = new Map();
    connector.emit = () => {};
    connector.reconcileLiveStatusesFromRollouts();
    assert.equal(connector.desktopStatuses.get(threadId), 'desktop_running');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps an interactive state even when its rollout has not changed for a day', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-stale-waiting-'));
  const previousHome = process.env.CODEX_HOME;
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const directory = path.join(root, 'sessions', '2026', '06', '18');
  const file = path.join(directory, `rollout-${threadId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  const oldAt = Date.now() - 2 * 24 * 60 * 60_000;
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date(oldAt).toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`);
  const old = new Date(oldAt);
  fs.utimesSync(file, old, old);
  process.env.CODEX_HOME = root;
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_waiting_input']]);
    connector.desktopActiveThreads = new Set([threadId]);
    connector.rolloutFilesByThread = new Map(); connector.rolloutStatusScans = new Map(); connector.rolloutLookupAt = new Map(); connector.threadState = new Map();
    connector.emit = () => {};
    connector.reconcileLiveStatusesFromRollouts();
    assert.equal(connector.desktopStatuses.get(threadId), 'desktop_waiting_input');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('desktop polling recovers a missed start event without replacing a specific live state', () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map();
  const emitted = [];
  connector.emit = (kind, threadId, value) => emitted.push({ kind, threadId, value });

  connector.reconcileDesktopThreadStatus({ id: 'active-task', status: 'inProgress' });

  assert.equal(connector.desktopStatuses.get('active-task'), 'desktop_running');
  assert.deepEqual(emitted.map((item) => [item.kind, item.threadId, item.value.status]), [
    ['thread.status', 'active-task', 'desktop_running'],
  ]);
});

test('typed Codex items map to readable activity and internal messages are dropped', () => {
  assert.equal(rolloutItem({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<multi_agent_role>x</multi_agent_role>' }] } }), null);
  assert.equal(rolloutItem({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<new_context_tag>\nstuff\n</new_context_tag>' }] } }), null);
  assert.equal(rolloutItem({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.apply_patch("..."))' } }), null);
  assert.equal(rolloutItem({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'Script completed' }] } }), null);
  const command = rolloutItem({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution',
    command: ['pwsh.exe', '-Command', 'Get-ChildItem'], aggregated_output: 'a.txt', exit_code: 1, status: 'completed', duration: { secs: 1, nanos: 500000000 } } } });
  assert.equal(command.type, 'commandExecution');
  assert.equal(command.text, 'Get-ChildItem\n\na.txt');
  assert.equal(command.status, 'failed');
  assert.equal(command.durationMs, 1500);
  const change = typedRolloutItem({ type: 'FileChange', changes: { 'I:\\t\\hello.txt': { type: 'add' }, 'I:\\t\\b.txt': { type: 'update' } }, status: 'completed' });
  assert.equal(change.type, 'fileChange');
  assert.equal(change.text, '新增 I:\\t\\hello.txt\n修改 I:\\t\\b.txt');
  const old = rolloutItem({ type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'git status' }) } });
  assert.equal(old.text, 'git status');
  assert.equal(rolloutItem({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [] } } }), null);
});

test('a Codex question (request_user_input function_call) marks the thread waiting until answered', () => {
  const connector = Object.create(Connector.prototype);
  const call = { type: 'response_item', timestamp: '2026-09-27T10:00:00Z', payload: { type: 'function_call', name: 'request_user_input', call_id: 'call_1',
    arguments: JSON.stringify({ questions: [{ header: '交付节奏', question: '怎么交付？', options: [{ label: '一次', description: '全部' }, '分批'] }] }) } };
  assert.equal(rolloutStatus(call), 'waiting_input');
  assert.equal(connector.trackCodexWaiting('t', call), true);
  const waiting = connector.codexWaiting.get('t');
  assert.equal(waiting.kind, 'question');
  assert.equal(waiting.answerable, false);
  assert.deepEqual(waiting.questions[0].options.map((option) => option.label), ['一次', '分批']);
  assert.equal(connector.trackCodexWaiting('t', { type: 'response_item', payload: { type: 'function_call_output', call_id: 'other' } }), false);
  const answer = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1' } };
  assert.equal(rolloutStatus(answer), 'running');
  assert.equal(connector.trackCodexWaiting('t', answer), true);
  assert.equal(connector.codexWaiting.has('t'), false);
});

test('a task renamed on the desktop is re-uploaded even when it is not the newest', async () => {
  const connector = Object.create(Connector.prototype);
  connector.stopping = false; connector.realtimeSyncRunning = false; connector.realtimeThreads = new Map();
  connector.ws = { readyState: WebSocket.OPEN };
  let name = 'old name';
  connector.codex = { ready: true, request: async (method, params) => params?.archived
    ? { data: [{ id: 'gone', name: 'archived one', archived: true }] }
    : { data: [{ id: 'newest', status: 'idle', updatedAt: 2 }, { id: 'other', name, status: 'idle', updatedAt: 1 }] } };
  connector.emit = () => {};
  const reads = [];
  connector.syncThreadMetadata = async (thread, archived) => { reads.push(`${thread.id}:${archived}`); };
  await connector.syncDesktopActivity();
  name = 'new name';
  connector.archivedSyncAt = Date.now();
  await connector.syncDesktopActivity();
  assert.deepEqual(reads, ['newest:false', 'gone:true', 'other:false']);
});

test('an old thread with an unfinished last turn that gets loaded again is not reported running', () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map();
  connector.desktopStatusAt = new Map();
  const published = [];
  connector.publishThreadStatus = (threadId, status) => published.push([threadId, status]);
  const monthsAgo = Date.now() - 90 * 24 * 60 * 60_000;
  connector.reconcileDesktopThreadStatus({ id: 'old-1', status: 'active', updatedAt: Math.floor(monthsAgo / 1000) }, true);
  assert.deepEqual(published, []);
  connector.reconcileDesktopThreadStatus({ id: 'new-1', status: 'active', updatedAt: Math.floor(Date.now() / 1000) }, true);
  assert.deepEqual(published, [['new-1', 'desktop_running']]);
});

test('a queued message on a thread the connector is running waits for the turn to end', async () => {
  const connector = Object.create(Connector.prototype);
  const items = new Map();
  connector.followups = { update: (id, patch) => { const next = { ...items.get(id), ...patch }; items.set(id, next); return next; } };
  connector.emit = () => {};
  connector.threadOwner = () => ({ owner: 'khlink' });
  connector.desktopStatuses = new Map([['t1', 'mobile_running']]);
  let started = 0;
  connector.executeQueuedBackgroundTurn = async () => { started += 1; };
  items.set('q1', { id: 'q1', threadId: 't1', mode: 'queue', state: 'pending', createdAt: Date.now() });
  const waiting = await connector.dispatchFollowup(items.get('q1'));
  assert.equal(waiting.state, 'pending');
  assert.equal(started, 0);
  connector.desktopStatuses.set('t1', 'completed');
  await connector.dispatchFollowup(items.get('q1'));
  assert.equal(started, 1);
});

test('after a connector restart a full-access task keeps its permissions on the next turn', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map();
  connector.mobileOwnedThreads = new Set();
  connector.claimBridgeThread = () => {};
  connector.resolveAttachments = () => [];
  connector.readThreadSettings = () => ({ permissionMode: 'yolo', model: 'gpt-test', effort: 'high' });
  let sent = null;
  connector.codex = { dangerousOperationsEnabled: true, request: async (method, params) => { sent = { method, params }; return { turn: { id: 'turn-1' } }; } };
  await connector.startTurn({ threadId: 't1', text: 'hi' });
  assert.equal(sent.method, 'turn/start');
  assert.equal(sent.params.approvalPolicy, 'never');
  assert.equal(sent.params.sandboxPolicy.type, 'dangerFullAccess');
  assert.equal(sent.params.model, 'gpt-test');
  assert.equal(sent.params.effort, 'high');
});

test('settings for a phone-run task held by Desktop take effect with the next turn instead of queuing', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map();
  connector.emit = () => {};
  connector.log = () => {};
  connector.readThreadSettings = () => ({ permissionMode: 'manual', model: 'gpt-test' });
  connector.connectorRunsThread = () => true;
  connector.desktopAdapter = { settings: async () => { throw new Error('should not use the desktop window'); } };
  connector.codex = { request: async () => { const e = new Error('thread t1 already has an active writer'); throw e; } };
  const result = await connector.executeCommand({ action: 'settings.set', args: { threadId: 't1', title: 'x', settings: { permissionMode: 'yolo', collaborationMode: 'default' } } });
  assert.equal(result.applied, true);
  assert.equal(connector.threadState.get('t1').permissionMode, 'yolo');
  assert.equal(connector.threadState.get('t1').model, 'gpt-test');
});

test('立即发送 into a turn that just ended is delivered as the next turn', async () => {
  const connector = Object.create(Connector.prototype);
  const calls = [];
  connector.executeMobileTurn = async (payload) => {
    calls.push(payload.action);
    if (payload.action === 'turn.steer') throw new Error('No active turn is available for this task');
    return { turn: { id: 'turn-2' } };
  };
  connector.log = () => {};
  connector.followups = { get: () => null, items: [] };
  connector.desktopStatuses = new Map();
  connector.threadState = new Map();
  connector.threadOwner = () => ({ owner: 'khlink' });
  const payload = { action: 'turn.steer', requestId: 'r-steer', args: { threadId: 't1', text: 'more' } };
  let result;
  try { result = await connector.command(payload, 'phone'); } catch (error) { result = { error: error.message }; }
  assert.deepEqual(calls.slice(-2), ['turn.steer', 'turn.start']);
  assert.equal(result.turn?.id, 'turn-2');
});

test('a Desktop start ahead of its rollout record does not complete the turn on old silence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-desktop-ahead-'));
  const previousHome = process.env.CODEX_HOME;
  const threadId = 'abcdef12-3456-1234-1234-1234567890ab';
  const directory = path.join(root, 'sessions', '2026', '10', '09');
  const file = path.join(directory, `rollout-${threadId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  // The previous turn stopped two hours ago on a completed tool, with no task_complete.
  const old = new Date(Date.now() - 2 * 3600_000).toISOString();
  fs.writeFileSync(file, [
    { timestamp: old, type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: old, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', status: 'completed' } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  process.env.CODEX_HOME = root;
  const make = (desktopUpdatedAt) => {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.desktopActiveThreads = new Set([threadId]);
    connector.desktopThreadUpdatedAt = new Map([[threadId, desktopUpdatedAt]]);
    connector.desktopActivitySnapshotHealthy = true;
    connector.desktopActivitySnapshotAt = Date.now();
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    connector.rolloutStatusScans = new Map(); connector.rolloutLookupAt = new Map(); connector.threadState = new Map();
    connector.turnStatus = (_id, status) => status;
    connector.emitted = [];
    connector.emit = (kind, id, value) => connector.emitted.push([kind, id, value.status]);
    return connector;
  };
  try {
    // Desktop reported the new message 2 s ago; its task_started is not written yet.
    const fresh = make(Date.now() - 2_000);
    fresh.reconcileLiveStatusesFromRollouts();
    assert.notEqual(fresh.desktopStatuses.get(threadId), 'completed');
    assert.ok(!fresh.emitted.some(([, , status]) => status === 'completed'));
    // Without a terminal record the old turn is still not proven over.
    const quiet = make(Date.now() - 2 * 3600_000);
    quiet.reconcileLiveStatusesFromRollouts();
    assert.match(quiet.desktopStatuses.get(threadId), /running/);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
