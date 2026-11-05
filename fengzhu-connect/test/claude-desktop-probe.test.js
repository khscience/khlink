const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClaudeDesktopStore } = require('../src/backends/claude-desktop');
const { methods } = require('../src/backends/claude-desktop-sync');

// Every temporary folder a test makes is removed when the run ends (they
// used to pile up in %TEMP%: 15,000+ by 2026-11-05).
const madeDirs = [];
process.on('exit', () => { for (const dir of madeDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* in use */ } } });
function tmp(prefix = 'khlink-claude-probe-') { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); madeDirs.push(dir); return dir; }

test('a store made before the desktop app is installed finds its folder later', () => {
  const base = tmp(); const missing = path.join(base, 'Roaming', 'Claude'); const installed = path.join(base, 'Packages', 'Claude_x', 'Claude');
  let found = missing; let logLookups = 0;
  const store = new ClaudeDesktopStore({ findRoot: () => found, findLogFiles: () => { logLookups++; return []; } });
  assert.equal(store.available(), false);
  assert.equal(store.relocate(), false);
  fs.mkdirSync(path.join(installed, 'claude-code-sessions'), { recursive: true }); found = installed;
  assert.equal(store.relocate(), true);
  assert.equal(store.root, installed); assert.equal(store.available(), true); assert.equal(logLookups, 2);
  assert.equal(store.relocate(), false);
});

test('a store given a root never moves', () => {
  const base = tmp(); const other = path.join(base, 'other');
  fs.mkdirSync(path.join(other, 'claude-code-sessions'), { recursive: true });
  const store = new ClaudeDesktopStore({ root: path.join(base, 'given'), logFiles: [], findRoot: () => other });
  assert.equal(store.relocate(), false); assert.equal(store.root, path.join(base, 'given'));
});

test('a running store relocates even when the former data directory still exists', () => {
  const base = tmp(); const old = path.join(base, 'old'); const migrated = path.join(base, 'Claude-Data', 'claude_test');
  for (const root of [old, migrated]) fs.mkdirSync(path.join(root, 'claude-code-sessions'), { recursive: true });
  let found = old; const logs = [];
  const store = new ClaudeDesktopStore({ findRoot: () => found, findLogFiles: root => { logs.push(root); return []; } });
  store.metaCache.set('old', {}); store.usageSampleCache = {}; store.officialUsageCache = {};
  found = migrated;
  assert.equal(store.relocate(), true); assert.equal(store.root, migrated);
  assert.equal(store.metaCache.size, 0); assert.equal(store.usageSampleCache, null); assert.equal(store.officialUsageCache, null);
  assert.deepEqual(logs, [old, migrated]);
  fs.rmSync(base, { recursive: true, force: true });
});

test('sync keeps checking until the desktop app appears, then starts once', t => {
  const timers = []; t.mock.method(global, 'setInterval', fn => { const timer = { fn, unref() {} }; timers.push(timer); return timer; });
  const cleared = []; t.mock.method(global, 'clearInterval', timer => { if (timer) cleared.push(timer); });
  t.mock.method(console, 'log', () => {});
  let available = false, relocations = 0, scans = 0, binLookups = 0, modelRefreshes = 0;
  const owner = { claude: {}, claudeDesktop: { relocate: () => { relocations++; }, available: () => available },
    syncClaudeDesktopSessions: async () => { scans++; }, refreshClaudeCliOrg: async () => null, publishClaudeUsage() {},
    useDesktopClaudeBinary: () => { binLookups++; }, refreshClaudeModels: async () => { modelRefreshes++; },
    pollClaudeWorkflows: async () => {}, log: error => { throw error; } };
  owner.startClaudeDesktopSync = methods.startClaudeDesktopSync;
  owner.startClaudeDesktopSync();
  assert.equal(timers.length, 1); assert.equal(scans, 0);
  const probe = timers[0];
  probe.fn(); // still missing: no second probe timer, nothing started
  assert.equal(timers.length, 1); assert.equal(scans, 0); assert.equal(relocations, 2);
  available = true; probe.fn();
  assert.ok(cleared.includes(probe)); assert.equal(owner._claudeDesktopProbeTimer, null);
  assert.equal(scans, 1); assert.equal(binLookups, 1); assert.equal(modelRefreshes, 1);
  assert.ok(owner._claudeDesktopTimer); assert.equal(timers.length, 3);
  owner.startClaudeDesktopSync(); // already running
  assert.equal(scans, 1); assert.equal(timers.length, 3);
});

test('stopping sync also stops the search for the desktop app', t => {
  const cleared = []; t.mock.method(global, 'clearInterval', timer => { if (timer) cleared.push(timer); });
  const probe = {}; const owner = { _claudeDesktopProbeTimer: probe };
  methods.stopClaudeDesktopSync.call(owner);
  assert.ok(cleared.includes(probe)); assert.equal(owner._claudeDesktopProbeTimer, null);
});
