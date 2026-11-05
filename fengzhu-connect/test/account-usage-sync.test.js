const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountUsagePoller, usagePayload } = require('../src/codex-account-usage');
const { Connector } = require('../src/connector');
const { methods } = require('../src/backends/claude-desktop-sync');

const record = (fingerprint, remaining = 75) => ({ loggedIn: true, fingerprint, plan: 'pro',
  usage: { sevenDay: { remaining, resetsAt: 300000, observedAt: 100, windowDurationMins: 10080 } } });

test('Codex phone reader is identical to desktop and absent five-hour remains absent', () => {
  assert.equal(require('../../ops/codex-switch/rpc.cjs').readAccount, require('../src/codex-account-usage').readAccount);
  const p = usagePayload(record('A'), 1000);
  assert.equal(p.rateLimits.primary, null); assert.equal(p.rateLimits.secondary.usedPercent, 25);
  assert.equal(p.rateLimits.secondary.resetsAt, 300); assert.equal(p.accountFingerprint, 'A');
});

test('concurrent push and capabilities reads coalesce, then detect a new account within 30 seconds', async () => {
  let now = 1000, count = 0, current = record('A'), finish;
  const poller = new AccountUsagePoller({ now: () => now, read: () => { count++; return new Promise(r => { finish = r; }); } });
  const a = poller.get(), b = poller.get(); finish(current);
  assert.deepEqual(await a, await b); await poller.get(); assert.equal(count, 1);
  now += 30000; current = record('B', 10); const next = poller.get(); finish(current);
  assert.equal((await next).accountFingerprint, 'B'); assert.equal(count, 2);
});

test('logout, missing windows, and account-read failures publish empty state instead of old quota', async () => {
  let now = 1, current = record('A');
  const poller = new AccountUsagePoller({ ttlMs: 0, now: () => now++, read: async () => { if (current === 'failure') throw Error('PRIVATE'); return current; } });
  assert.ok((await poller.get()).rateLimits);
  current = { loggedIn: false }; assert.equal((await poller.get()).accountState, 'signed_out');
  current = { loggedIn: true, fingerprint: 'B' }; assert.equal((await poller.get()).rateLimits, null);
  current = 'failure'; const failed = await poller.get();
  assert.equal(failed.accountState, 'unavailable'); assert.equal(failed.rateLimits, null); assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
});

test('account-change notification invalidates a still-running old read', async () => {
  let finish;
  const poller = new AccountUsagePoller({ read: () => new Promise(r => { finish = r; }) });
  const old = poller.get(); poller.invalidate(); finish(record('A')); assert.equal(await old, null);
  const fresh = poller.get(); finish(record('B')); assert.equal((await fresh).accountFingerprint, 'B');
});

test('phone push never queries the task host for account quota and reconnect resends unchanged state', async () => {
  let connected = true; const emitted = [], payload = usagePayload(record('B'), 1000);
  const owner = { codex: { request: () => { throw Error('old task host'); } }, isConnected: () => connected,
    readCodexUsage: async () => payload, emit: (...args) => { emitted.push(args); return true; } };
  assert.equal(await Connector.prototype.pushCodexUsage.call(owner), true);
  assert.equal(await Connector.prototype.pushCodexUsage.call(owner), false);
  assert.equal(await Connector.prototype.pushCodexUsage.call(owner, true), true);
  connected = false; assert.equal(await Connector.prototype.pushCodexUsage.call(owner, true), false);
  assert.equal(emitted.length, 2);
});

test('an undelivered quota read remains eligible for a subsequent push', async () => {
  let connected = true; const payload = usagePayload(record('B'), 1000);
  const owner = { codex: { request() {} }, isConnected: () => connected, readCodexUsage: async () => { connected = false; return payload; }, emit: () => true };
  assert.equal(await Connector.prototype.pushCodexUsage.call(owner), false); assert.equal(owner.codexUsageSignature, undefined);
});

test('Claude snapshots order A, switching and older B independently from observation time', () => {
  let official = { org: 'same-org', accountFingerprint: 'A', accountState: 'ready', usage: { fiveHour: { remaining: 90, observedAt: 100 } } };
  const owner = { claudeDesktop: { latestOfficialUsage: () => official } };
  const a = methods.claudeUsageState.call(owner, 500);
  official = { org: null, usage: null, accountState: 'switching' }; const changing = methods.claudeUsageState.call(owner, 500);
  official = { org: 'same-org', accountFingerprint: 'B', accountState: 'ready', usage: { fiveHour: { remaining: 20, observedAt: 50 } } };
  const b = methods.claudeUsageState.call(owner, 500);
  assert.ok(a.snapshotAt < changing.snapshotAt && changing.snapshotAt < b.snapshotAt);
  assert.equal(changing.fiveHour.remainingPercent, null); assert.equal(changing.accountState, 'switching');
  assert.equal(b.accountFingerprint, 'B'); assert.equal(b.fiveHour.remainingPercent, 20);
});

test('Claude conversation scan discards an old profile after an awaited process scan', async () => {
  let profile = 'A', finish, reset = 0;
  const owner = { claudeDesktop: { profileSignature: () => profile, resetProfileCaches: () => reset++,
    listSessions: () => [], pendingPrompts: () => new Map(), liveDesktopSessions: () => new Promise(r => { finish = r; }) },
    claudeThreads: new Map(), setClaudeThreadFields: () => { throw Error('stale mutation'); }, log: () => {} };
  const scan = methods.syncClaudeDesktopSessions.call(owner); profile = 'B'; finish(new Set()); await scan;
  assert.equal(reset, 1); assert.equal(owner._claudeLive, null); assert.equal(owner._claudeDesktopSyncing, false);
});

test('a completed profile rescan publishes an explicit current-conversation refresh once', async () => {
  let profile = 'A', resets = 0; const events = [];
  const owner = { claudeDesktop: { profileSignature: () => profile, resetProfileCaches: () => resets++,
    listSessions: () => [], pendingPrompts: () => new Map(), liveDesktopSessions: async () => new Set() },
    claudeThreads: new Map(), publishClaudeUsage() {}, maybeRefreshFiveHourReset: async () => {}, peekUnwatchedClaudeSessions: async () => {},
    emit: (...args) => events.push(args), log: () => {} };
  await methods.syncClaudeDesktopSessions.call(owner); await methods.syncClaudeDesktopSessions.call(owner);
  profile = 'B'; await methods.syncClaudeDesktopSessions.call(owner);
  assert.equal(resets, 2); assert.equal(events.length, 2);
  for (const [kind, , payload] of events) { assert.equal(kind, 'threads.updated'); assert.equal(payload.accountChanged, true); }
});
