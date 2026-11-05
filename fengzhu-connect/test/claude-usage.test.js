const test = require('node:test');
const assert = require('node:assert/strict');
const { claudeUsageState, STALE_MS } = require('../src/backends/claude-usage');

const at = Date.parse('2026-10-08T00:00:00Z');
const sample = { org: 'desktop-org', at, fiveHour: 0.04, sevenDay: 0.98 };

test('fresh same-account desktop usage is the complement of used percent', () => {
  const state = claudeUsageState({ sample }, at + 60_000);
  assert.equal(state.fiveHour.remainingPercent, 96);
  assert.equal(state.sevenDay.remainingPercent, 2);
  assert.equal(state.fiveHour.observedAt, at);
  assert.equal(state.fiveHour.resetsAt, null);
});

test('paused desktop sampling expires even without a Code transcript activity', () => {
  const state = claudeUsageState({ sample, latestActivity: 0 }, at + STALE_MS + 1);
  assert.equal(state.fiveHour.remainingPercent, null);
  assert.equal(state.fiveHour.lastKnownRemainingPercent, 96);
  assert.equal(state.sevenDay.lastKnownRemainingPercent, 2);
  assert.equal(state.fiveHour.stale, true);
});

test('a reset with no later observation never manufactures 100% or next week', () => {
  const resetsAt = at + 10 * 60_000;
  const event = { org: sample.org, at, fiveHour: { utilization: 0.7, resetsAt }, sevenDay: { utilization: 0.98, resetsAt } };
  const state = claudeUsageState({ event }, resetsAt + 1);
  for (const row of [state.fiveHour, state.sevenDay]) {
    assert.equal(row.remainingPercent, null);
    assert.equal(row.resetsAt, null);
    assert.equal(row.stale, true);
  }
  assert.equal(state.fiveHour.lastKnownRemainingPercent, 30);
});

test('a new window sampled after an old reset has its own percentage and unknown reset', () => {
  const event = { org: sample.org, at: at - 60_000, fiveHour: { utilization: 0.7, resetsAt: at } };
  const state = claudeUsageState({ sample, event }, at + 60_000);
  assert.equal(state.fiveHour.remainingPercent, 96);
  assert.equal(state.fiveHour.resetsAt, null);
});

test('one fresh window cannot re-date an expired second window', () => {
  const now = at + 60 * 60_000;
  const event = { org: sample.org, at: now, fiveHour: { utilization: 0.7, observedAt: at }, sevenDay: { utilization: 0.98, observedAt: now } };
  const state = claudeUsageState({ event }, now);
  assert.equal(state.fiveHour.remainingPercent, null);
  assert.equal(state.fiveHour.observedAt, at);
  assert.equal(state.sevenDay.remainingPercent, 2);
});

test('partial desktop samples keep their independent window timestamp', () => {
  const now = at + 60 * 60_000;
  const state = claudeUsageState({ sample: { ...sample, at: now, fiveHourObservedAt: at, sevenDayObservedAt: now } }, now);
  assert.equal(state.fiveHour.remainingPercent, null);
  assert.equal(state.sevenDay.remainingPercent, 2);
});

test('another account and an unidentified event cannot provide percentages or reset times', () => {
  for (const org of ['other-org', null]) {
    const event = { org, at, fiveHour: { utilization: 0.9, resetsAt: at + 10_000_000 } };
    const state = claudeUsageState({ sample, event }, at + 1);
    assert.equal(state.fiveHour.remainingPercent, 96);
    assert.equal(state.fiveHour.resetsAt, null);
  }
});

test('future timestamps and invalid utilizations are not current quota', () => {
  assert.equal(claudeUsageState({ sample: { ...sample, at: at + 6 * 60_000 } }, at).fiveHour.remainingPercent, null);
  for (const used of [-1, 1.01, NaN, null, '0.5']) {
    assert.equal(claudeUsageState({ sample: { ...sample, fiveHour: used } }, at).fiveHour.remainingPercent, null);
  }
});

test('refresh completion does not change the source observation time', () => {
  const state = claudeUsageState({ sample, refreshResultAt: at + 60 * 60_000, refreshUnavailableReason: 'desktop_refresh_required' }, at + 60 * 60_000);
  assert.equal(state.updatedAt, at);
  assert.equal(state.refreshResultAt, at + 60 * 60_000);
  assert.equal(state.refreshUnavailableReason, 'desktop_refresh_required');
  assert.equal(state.fiveHour.remainingPercent, null);
});


test('account fingerprint changes with the source organisation and contains no identifier', () => {
  const one = claudeUsageState({ sample }, at).accountFingerprint;
  const two = claudeUsageState({ sample: { ...sample, org: 'other-org' } }, at).accountFingerprint;
  assert.match(one, /^[0-9a-f]{32}$/);
  assert.notEqual(one, two);
  assert.equal(claudeUsageState({}, at).accountFingerprint, null);
});

test('a weekly reset is taken from an older exact time when it fits the observed fall', () => {
  const { claudeUsageState: state, usageResetBrackets } = require('../src/backends/claude-usage');
  // 2026-10-09: 98% at 12:59, 0% at 14:08; an Oct 5 event said "resets Oct 9 14:00".
  const t = (s) => Date.parse(`2026-10-09T${s}+08:00`);
  const samples = [{ t: t('12:59:15'), u: { fh: 1, sd: 98 } }, { t: t('14:08:24'), u: { fh: 2, sd: 0 } }];
  const brackets = usageResetBrackets(samples);
  assert.deepEqual(brackets.sevenDay, [t('12:59:15'), t('14:08:24')]);
  const sampleNow = { org: 'org', at: t('14:08:24'), fiveHour: 0.02, sevenDay: 0, sevenDayResetBracket: brackets.sevenDay };
  const event = { org: 'org', at: Date.parse('2026-10-05T04:53:53+08:00'), sevenDay: { utilization: 0.7, resetsAt: t('14:00:00') } };
  const result = state({ sample: sampleNow, event }, t('14:20:00'));
  assert.equal(result.sevenDay.resetsAt, t('14:00:00') + 7 * 86_400_000);
  assert.equal(result.sevenDay.resetEstimated, true);
  assert.equal(result.sevenDay.remainingPercent, 100);
});

test('a wide sample bracket gives no reset estimate', () => {
  const { estimatedReset } = require('../src/backends/claude-usage');
  const lo = Date.parse('2026-10-06T09:24:00Z'); const hi = lo + 14 * 3600_000; // startup-only samples
  assert.equal(estimatedReset('sevenDay', [lo, hi], null, hi + 60_000), null);
  assert.equal(estimatedReset('fiveHour', [lo, lo + 45 * 60_000], null, lo + 50 * 60_000), null);
  assert.equal(estimatedReset('fiveHour', [lo, lo + 20 * 60_000], null, lo + 30 * 60_000), lo + 20 * 60_000 + 5 * 3600_000);
});
