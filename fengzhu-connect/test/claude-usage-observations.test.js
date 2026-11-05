'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
// Fixtures go to KHLINK_TEST_DIR or the system temp folder.
const FIXTURES = process.env.KHLINK_TEST_DIR || require('node:os').tmpdir();
const path = require('node:path');
const { readObservations, saveObservations } = require('../src/backends/claude-usage-observations');
const { readOfficialUsage, MAX_AGE, selectUsage } = require('../src/backends/claude-desktop-usage');
const now = Date.parse('2026-10-15T10:00:00Z');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(FIXTURES, 'observations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir: path.join(root, 'observations') };
}
function usage(at = now, remaining = 81) {
  return { source: 'official-desktop-cached-response', observedAt: at,
    fiveHour: { remaining, observedAt: at, resetsAt: now + 3600_000 },
    sevenDay: { remaining: 71, observedAt: at, resetsAt: now + 86400_000 } };
}
test('cache eviction and an older history rewrite cannot roll quota or resets back, even after restart', t => {
  const f = fixture(t), opts = { org: 'registered', alias: 'primary', observationsDir: f.dir,
    historyFile: path.join(f.root, 'history.json'), callbackFile: path.join(f.root, 'callback.json') };
  fs.writeFileSync(opts.callbackFile, JSON.stringify({ source: 'official-statusline', profile: 'primary', observedAt: now,
    rate_limits: { five_hour: { used_percentage: 19, resets_at: (now + 3600_000) / 1000 }, seven_day: { used_percentage: 29 } } }));
  const first = readOfficialUsage(opts, now);
  fs.unlinkSync(opts.callbackFile);
  fs.writeFileSync(opts.historyFile, JSON.stringify({ version: 2, samples: [{ org: opts.org, t: now - 3600_000, u: { fh: 0, sd: 27 } }] }));
  const after = readOfficialUsage(opts, now + 1000);
  assert.equal(first.fiveHour.remaining, 81); assert.equal(after.fiveHour.remaining, 81);
  assert.equal(after.fiveHour.observedAt, now); assert.equal(after.fiveHour.resetsAt, now + 3600_000);
  const stale = readOfficialUsage(opts, now + MAX_AGE + 1);
  assert.equal(stale.fiveHour.remaining, 81); assert.equal(stale.fiveHour.observedAt, now); assert.equal(stale.fiveHour.stale, true);
});
test('late writers cannot replace newer per-window observations or cross organization boundaries', t => {
  const f = fixture(t); saveObservations(f.dir, 'A', usage(now, 81), now);
  saveObservations(f.dir, 'A', usage(now - 1000, 100), now);
  saveObservations(f.dir, 'B', usage(now, 4), now);
  assert.equal(readObservations(f.dir, 'A', now).fiveHour.remaining, 81);
  assert.equal(readObservations(f.dir, 'B', now).fiveHour.remaining, 4);
  assert.equal(readObservations(f.dir, 'C', now), null);
});
test('storage contains only quota numbers, original timestamps and whitelisted provenance', t => {
  const f = fixture(t), sample = usage(); sample.fiveHour.authorization = 'never-store'; sample.email = 'never-store';
  saveObservations(f.dir, 'private-org', sample, now);
  const sub = fs.readdirSync(f.dir)[0]; assert.match(sub, /^[a-f0-9]{64}$/);
  for (const name of fs.readdirSync(path.join(f.dir, sub))) {
    const text = fs.readFileSync(path.join(f.dir, sub, name), 'utf8');
    assert.doesNotMatch(text, /private-org|never-store|authorization|email/);
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['observedAt', 'remaining', 'resetsAt', 'source']);
  }
});
test('malformed records, tampering, future samples and untrusted sources cannot become quota', t => {
  const f = fixture(t); saveObservations(f.dir, 'A', usage(), now);
  const sub = path.join(f.dir, fs.readdirSync(f.dir)[0]);
  for (const name of fs.readdirSync(sub)) fs.appendFileSync(path.join(sub, name), ' ');
  assert.equal(readObservations(f.dir, 'A', now), null);
  saveObservations(f.dir, 'A', { ...usage(now + 120000), source: 'untrusted' }, now);
  assert.equal(readObservations(f.dir, 'A', now), null);
});
test('retention is bounded and ignores unknown files and linked directories', t => {
  const f = fixture(t); saveObservations(f.dir, 'A', usage(), now);
  const sub = path.join(f.dir, fs.readdirSync(f.dir)[0]); fs.writeFileSync(path.join(sub, 'notes.json'), 'keep');
  for (let i = 1; i <= 12; i++) saveObservations(f.dir, 'A', usage(now + i, 81 - i), now + i);
  assert.equal(fs.readdirSync(sub).filter(n => n.startsWith('fiveHour-')).length, 5);
  assert.equal(fs.readdirSync(sub).filter(n => n.startsWith('sevenDay-')).length, 5);
  assert.equal(fs.readFileSync(path.join(sub, 'notes.json'), 'utf8'), 'keep');
  const linked = path.join(f.root, 'linked'); fs.symlinkSync(f.dir, linked, 'junction');
  assert.equal(readObservations(linked, 'A', now + 12), null);
  saveObservations(linked, 'A', usage(now + 20, 1), now + 20);
  assert.equal(readObservations(f.dir, 'A', now + 20).fiveHour.remaining, 69);
});
test('a near-simultaneous compact sample cannot erase an observed exact reset', t => {
  const f = fixture(t), prior = usage(); saveObservations(f.dir, 'A', prior, now);
  const history = { source: 'official-desktop-history', observedAt: now + 70,
    fiveHour: { remaining: 81, observedAt: now + 70 }, sevenDay: { remaining: 71, observedAt: now + 70 } };
  const result = selectUsage(readObservations(f.dir, 'A', now), history, null, now + 70);
  assert.equal(result.fiveHour.observedAt, now + 70); assert.equal(result.fiveHour.resetsAt, prior.fiveHour.resetsAt);
  assert.equal(result.fiveHour.source, 'official-desktop-history');
});
test('same-time cached response outranks history independent of reader/writer order', t => {
  const f = fixture(t), history = { ...usage(), source: 'official-desktop-history' };
  for (const row of [usage(), history]) saveObservations(f.dir, 'A', row, now);
  assert.equal(readObservations(f.dir, 'A', now).fiveHour.source, 'official-desktop-cached-response');
});
