const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.KH_LINK_CLAUDE_ACCOUNT_SWITCH = '1';
// Fixtures go to KHLINK_TEST_DIR or the system temp folder.
const FIXTURES = process.env.KHLINK_TEST_DIR || require('node:os').tmpdir();
const { ClaudeDesktopStore } = require('../src/backends/claude-desktop');
const { officialDesktopUsageState } = require('../src/backends/claude-usage');
const { methods } = require('../src/backends/claude-desktop-sync');
const { usageFor } = require('../../ops/claude-switch/usage.cjs');
const now = Date.parse('2026-10-15T08:00:00+08:00');
const epoch = 11644473600000;

function cache(profile, org, used = [31, 5], at = now) {
  const dir = path.join(profile, 'Cache/Cache_Data'); fs.mkdirSync(dir, { recursive: true });
  const index = Buffer.alloc(372); index.writeUInt32LE(0xc103cac3); index.writeUInt32LE(0x30000, 4); index.writeUInt32LE(0xa0000000, 368);
  const data = Buffer.alloc(8448), e = data.subarray(8192), url = `https://claude.ai/api/organizations/${org}/usage`;
  const body = Buffer.from(JSON.stringify({ five_hour: { utilization: used[0], resets_at: new Date(now + 4 * 3600_000).toISOString() },
    seven_day: { utilization: used[1], resets_at: new Date(now + 6 * 86400_000).toISOString() } }));
  e.writeUInt32LE(0x90010000, 8); e.writeUInt32LE(url.length, 32); e.writeUInt32LE(body.length, 44);
  e.writeUInt32LE(0x80000002, 56); e.writeUInt32LE(0x80000001, 60); e.write(url, 96);
  const info = Buffer.alloc(36); info.writeUInt32LE(300); info.writeUInt32LE(0x80000003, 4); info.writeUInt32LE(4, 8);
  for (const offset of [12, 20, 28]) info.writeBigInt64LE(BigInt(at + epoch) * 1000n, offset);
  for (const [name, bytes] of [['index', index], ['data_0', data], ['data_1', Buffer.alloc(8228)], ['f_000001', body], ['f_000002', Buffer.concat([info, Buffer.from('UNREAD-HTTP-HEADERS')])]]) fs.writeFileSync(path.join(dir, name), bytes);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(FIXTURES, 'official-usage-')), shared = path.join(root, 'shared'); fs.mkdirSync(shared);
  const config = { version: 1, root, activeLink: path.join(root, 'official'), profiles: {} };
  for (const [alias, used] of [['primary', [31, 5]], ['secondary', [80, 70]]]) {
    config.profiles[alias] = `claude-code-sessions/account/${alias}-org`;
    const profile = path.join(root, 'profiles', alias); fs.mkdirSync(path.join(profile, config.profiles[alias]), { recursive: true });
    fs.writeFileSync(path.join(profile, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples: [{ org: `${alias}-org`, t: now - 3600_000, u: { fh: 0, sd: 0 } }] }));
    cache(profile, `${alias}-org`, used);
  }
  fs.writeFileSync(path.join(shared, 'config.json'), JSON.stringify(config));
  fs.symlinkSync(path.join(root, 'profiles/primary'), config.activeLink, 'junction');
  const store = new ClaudeDesktopStore({ root: config.activeLink, profileRegistryRoot: shared, logFiles: [] });
  const switchTo = alias => { fs.unlinkSync(config.activeLink); fs.symlinkSync(path.join(root, 'profiles', alias), config.activeLink, 'junction'); };
  return { root, shared, config, store, switchTo };
}

test('phone uses the same official observation and exact resets as the desktop, not the old 100% sample', () => {
  const f = fixture(); const desktop = usageFor(f.config, 'primary', now);
  const official = f.store.latestOfficialUsage(now); assert.deepEqual(official.usage, desktop);
  const phone = officialDesktopUsageState(official, now);
  for (const key of ['fiveHour', 'sevenDay']) {
    assert.equal(phone[key].remainingPercent, desktop[key].remaining);
    assert.equal(phone[key].resetsAt, desktop[key].resetsAt);
    assert.equal(phone[key].observedAt, desktop[key].observedAt);
    assert.equal(phone[key].source, 'official-desktop-cached-response');
    assert.equal(phone[key].resetEstimated, false);
  }
  assert.equal(phone.fiveHour.remainingPercent, 69); assert.equal(phone.sevenDay.remainingPercent, 95);
});

test('an evicted Chromium usage body stays available to a new phone reader from the shared observation', () => {
  const f = fixture(), first = usageFor(f.config, 'primary', now);
  fs.unlinkSync(path.join(f.root, 'profiles/primary/Cache/Cache_Data/f_000001'));
  const next = f.store.latestOfficialUsage(now + 1000);
  for (const key of ['fiveHour', 'sevenDay']) {
    assert.equal(next.usage[key].remaining, first[key].remaining);
    assert.equal(next.usage[key].resetsAt, first[key].resetsAt);
    assert.equal(next.usage[key].observedAt, first[key].observedAt);
  }
  const old = usageFor(f.config, 'primary', now + 31 * 60_000);
  assert.equal(old.fiveHour.remaining, 69); assert.equal(old.fiveHour.stale, true);
  assert.equal(old.fiveHour.observedAt, now);
});

test('current account changes invalidate the read cache and quota fingerprint immediately', () => {
  const f = fixture(), before = officialDesktopUsageState(f.store.latestOfficialUsage(now), now);
  f.switchTo('secondary');
  const after = officialDesktopUsageState(f.store.latestOfficialUsage(now + 1), now + 1);
  assert.equal(after.fiveHour.remainingPercent, 20); assert.equal(after.sevenDay.remainingPercent, 30);
  assert.notEqual(before.accountFingerprint, after.accountFingerprint);
});

test('different managed accounts in the same organization remain distinct on the phone', () => {
  const f = fixture();
  f.config.profiles.secondary = 'claude-code-sessions/another-account/primary-org';
  fs.mkdirSync(path.join(f.root, 'profiles/secondary', f.config.profiles.secondary), { recursive: true });
  fs.writeFileSync(path.join(f.shared, 'config.json'), JSON.stringify(f.config));
  const before = officialDesktopUsageState(f.store.latestOfficialUsage(now), now);
  f.switchTo('secondary');
  const after = officialDesktopUsageState(f.store.latestOfficialUsage(now + 1), now + 1);
  assert.notEqual(before.accountFingerprint, after.accountFingerprint);
});

test('a switch in progress or an unknown target clears managed quota without a legacy fallback', () => {
  const f = fixture(); f.store.latestOfficialUsage(now);
  const owner = { claudeDesktop: f.store, readClaudeUsageEvent() { throw Error('must not use CLI'); } };
  fs.writeFileSync(path.join(f.shared, 'desktop-switch.lock'), '1');
  const blocked = methods.claudeUsageState.call(owner, now);
  assert.equal(blocked.accountFingerprint, null); assert.equal(blocked.fiveHour.remainingPercent, null);
  fs.unlinkSync(path.join(f.shared, 'desktop-switch.lock'));
  const other = path.join(f.root, 'unregistered'); fs.mkdirSync(other); fs.unlinkSync(f.config.activeLink); fs.symlinkSync(other, f.config.activeLink, 'junction');
  assert.equal(methods.claudeUsageState.call(owner, now).sevenDay.remainingPercent, null);
});

test('a profile changing while its files are read cannot publish the previous account', () => {
  const f = fixture(), original = fs.readFileSync;
  const history = path.join(f.root, 'profiles/primary/plan-usage-history.json');
  let changed = false;
  try {
    fs.readFileSync = function (file, ...args) {
      const value = original.call(this, file, ...args);
      if (!changed && file === history) { changed = true; f.switchTo('secondary'); }
      return value;
    };
    assert.deepEqual(f.store.latestOfficialUsage(now), { org: null, usage: null, accountState: 'unavailable' });
  } finally { fs.readFileSync = original; }
  assert.equal(changed, true);
  assert.equal(f.store.latestOfficialUsage(now).usage.fiveHour.remaining, 20);
});

test('manual phone refresh rereads local files inside the polling cache interval and never launches CLI', async () => {
  const f = fixture(); f.store.latestOfficialUsage(now);
  cache(path.join(f.root, 'profiles/primary'), 'primary-org', [40, 6], now + 1);
  assert.equal(f.store.latestOfficialUsage(now + 1).usage.fiveHour.remaining, 69);
  let published;
  const owner = { claudeProfileLock: { managed: () => true, withLease: action => action() },
    claudeDesktop: { latestOfficialUsage: (_at, options) => f.store.latestOfficialUsage(now + 1, options) },
    currentClaudeBin() { throw Error('must not run CLI'); },
    publishClaudeUsage() { return published = officialDesktopUsageState(f.store.latestOfficialUsage(now + 1), now + 1); } };
  await methods.refreshClaudeUsage.call(owner);
  assert.equal(published.fiveHour.remainingPercent, 60); assert.equal(published.sevenDay.remainingPercent, 94);
  assert.equal(await methods.maybeRefreshFiveHourReset.call(owner), false);
});

test('official observations expire without synthesizing current 100% or moving their times', () => {
  const f = fixture(), official = f.store.latestOfficialUsage(now);
  const old = officialDesktopUsageState(official, now + 31 * 60_000);
  assert.equal(old.fiveHour.remainingPercent, null); assert.equal(old.fiveHour.lastKnownRemainingPercent, 69);
  assert.equal(old.fiveHour.observedAt, now); assert.equal(old.fiveHour.resetsAt, now + 4 * 3600_000);
  assert.equal(officialDesktopUsageState(official, now + 5 * 3600_000).fiveHour.lastKnownRemainingPercent, 69);
});

test('new local observations produce a push; unchanged reads do not republish', () => {
  let remaining = 69; const events = [];
  const owner = { claudeDesktop: { latestOfficialUsage: at => ({ org: 'registered', usage: {
    source: 'official-desktop-cached-response', fiveHour: { remaining, observedAt: now, resetsAt: now + 4 * 3600_000 },
    sevenDay: { remaining: 95, observedAt: now, resetsAt: now + 6 * 86400_000 } } }) },
    claudeUsageState() { return methods.claudeUsageState.call(this, now); }, emit: (...args) => events.push(args),
    readClaudeUsageEvent() { throw Error('must not mix CLI'); } };
  methods.publishClaudeUsage.call(owner); methods.publishClaudeUsage.call(owner);
  remaining = 68; methods.publishClaudeUsage.call(owner);
  assert.equal(events.length, 2); assert.equal(events[1][0], 'claude.usage'); assert.equal(events[1][2].fiveHour.remainingPercent, 68);
});

test('desktop resource map ships the same parser and selector used by the connector', () => {
  const config = require('../../kh-link-desktop/src-tauri/tauri.conf.json');
  for (const file of ['claude-desktop-usage.js', 'claude-usage-cache.js', 'claude-usage-observations.js']) {
    assert.equal(config.bundle.resources[`../../fengzhu-connect/src/backends/${file}`], `claude-switch/${file}`);
  }
  assert.equal(require('../../ops/claude-switch/usage.cjs').readOfficialUsage, require('../src/backends/claude-desktop-usage').readOfficialUsage);
  assert.equal(require('../../ops/claude-switch/usage-cache.cjs').readUsage, require('../src/backends/claude-usage-cache').readUsage);
});

test('offline reads are not treated as delivered and reconnect can force the same observation', () => {
  let connected = false; const events = [];
  const owner = { isConnected: () => connected, claudeUsageState: () => ({ fiveHour: { remainingPercent: 69 }, sevenDay: { remainingPercent: 95 } }), emit: (...args) => events.push(args) };
  methods.publishClaudeUsage.call(owner); assert.equal(events.length, 0);
  connected = true; methods.publishClaudeUsage.call(owner); methods.publishClaudeUsage.call(owner);
  assert.equal(events.length, 1);
  methods.publishClaudeUsage.call(owner, true); assert.equal(events.length, 2);
});

test('quota polling continues while the conversation scan is awaiting desktop work', t => {
  const callbacks = []; t.mock.method(global, 'setInterval', fn => { callbacks.push(fn); return { unref() {} }; });
  let published = 0, scanning = 0;
  const owner = { claude: {}, claudeDesktop: { available: () => true },
    syncClaudeDesktopSessions: () => { scanning++; return new Promise(() => {}); },
    refreshClaudeCliOrg: async () => null, publishClaudeUsage: () => { published++; }, log: error => { throw error; } };
  methods.startClaudeDesktopSync.call(owner);
  assert.equal(scanning, 1); callbacks[0](); assert.equal(published, 1);
});
