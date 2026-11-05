// Quota observations, not token/cost counters. No API or credential access.
const STALE_MS = 30 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const { accountIdentity } = require('../account-identity');

function fraction(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

const FIVE_HOURS = 5 * 3600_000;
const WEEK = 7 * 86_400_000;
const ANCHOR_SLACK_MS = 15 * 60_000;
const MAX_BRACKET_MS = { fiveHour: 30 * 60_000, sevenDay: 2 * 3600_000 };

// When each window last restarted, as a bracket (after `lo`, by `hi`) between
// two desktop samples: the weekly figure falling back, or the five-hour figure
// starting from 0 / falling back. Samples are fh/sd percentages (0..100).
function usageResetBrackets(samples) {
  const rows = (samples || []).filter((row) => row?.u && Number.isFinite(row.t)).sort((a, b) => a.t - b.t);
  const bracket = (short, startedAt) => {
    let found = null;
    for (let i = 1; i < rows.length; i += 1) {
      const prev = Number(rows[i - 1].u[short]); const cur = Number(rows[i].u[short]);
      if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
      if (startedAt(prev, cur)) found = [rows[i - 1].t, rows[i].t];
    }
    return found;
  };
  return {
    // A weekly reset shows as a clear fall (usage only grows inside a week).
    sevenDay: bracket('sd', (prev, cur) => cur < prev - 5),
    // A five-hour window starts with the first use after 0, or a fall.
    fiveHour: bracket('fh', (prev, cur) => (prev === 0 && cur > 0) || cur < prev - 5),
  };
}

// The next reset estimated from a restart bracket. A weekly window repeats on
// a fixed schedule: an older exact reset time from the same account that,
// moved by whole weeks, lands inside the bracket confirms the schedule and
// gives the exact time. Otherwise only a narrow bracket is used.
function estimatedReset(key, bracket, knownReset, now) {
  if (!Array.isArray(bracket)) return null;
  const [lo, hi] = bracket;
  const span = key === 'fiveHour' ? FIVE_HOURS : WEEK;
  let start = null;
  if (key === 'sevenDay' && Number.isFinite(knownReset) && knownReset > 0) {
    const shifted = knownReset + Math.ceil((lo - ANCHOR_SLACK_MS - knownReset) / WEEK) * WEEK;
    if (shifted <= hi + ANCHOR_SLACK_MS) start = shifted;
  }
  if (start === null && hi - lo <= MAX_BRACKET_MS[key]) start = hi;
  if (start === null) return null;
  let next = start + span;
  if (key === 'sevenDay') while (next <= now) next += WEEK;
  return next > now ? next : null;
}

function claudeUsageState({ sample, event, latestActivity = 0, refreshResultAt = 0, refreshUnavailableReason = null }, now = Date.now()) {
  const validAt = (at) => Number.isFinite(at) && at > 0 && at <= now + CLOCK_SKEW_MS;
  // A CLI observation with no confirmed organisation is not evidence about
  // the Desktop account. Never mix another account's percentages/reset times.
  if (!event?.org || (sample && sample.org !== event.org)) event = null;
  const windowState = (key) => {
    const row = event?.[key];
    const eventAt = row?.observedAt ?? event?.at;
    const sampleAt = sample?.[`${key}ObservedAt`] ?? sample?.at;
    const candidates = [
      { used: fraction(row?.utilization), at: eventAt, source: 'rate_limit_event' },
      { used: fraction(sample?.[key]), at: sampleAt, source: 'desktop_sample' },
    ].filter((item) => item.used !== null && validAt(item.at)).sort((a, b) => b.at - a.at);
    const observation = candidates[0];
    const at = observation?.at || 0;
    const resetsAt = Number(row?.resetsAt) || null;
    // An explicit, same-account reset time is used as is. Percentages are
    // never manufactured after a reset; an estimated reset time (below) only
    // labels the window and does not make the figure fresh.
    const crossedReset = Boolean(resetsAt && at && at < resetsAt && now >= resetsAt);
    const stale = Boolean(at && (now - at > STALE_MS || crossedReset));
    const remaining = observation ? Math.round((1 - observation.used) * 100) : null;
    const exactReset = resetsAt && resetsAt > now && resetsAt > at && validAt(eventAt) ? resetsAt : null;
    // No exact, current reset: estimate it from the desktop samples (shown as
    // approximate). The old exact reset may only confirm the weekly schedule.
    const estimate = exactReset ? null : estimatedReset(key, sample?.[`${key}ResetBracket`], resetsAt, now);
    return {
      remainingPercent: stale ? null : remaining,
      lastKnownRemainingPercent: stale ? remaining : null,
      resetsAt: exactReset || estimate,
      resetEstimated: Boolean(!exactReset && estimate),
      observedAt: at || null,
      stale,
      staleWhileActive: stale && latestActivity > at,
      atMost: false,
      source: observation?.source || null,
    };
  };
  const fiveHour = windowState('fiveHour');
  const sevenDay = windowState('sevenDay');
  const observedAt = Math.max(fiveHour.observedAt || 0, sevenDay.observedAt || 0) || null;
  const org = sample?.org || event?.org || null;
  const accountFingerprint = org ? accountIdentity('claude-usage', org) : null;
  return { fiveHour, sevenDay, observedAt, updatedAt: observedAt || 0,
    status: event?.status || null, refreshResultAt, refreshUnavailableReason, accountFingerprint };
}

// Managed accounts use exactly the observation selected by the desktop panel.
// Do not blend in older CLI resets/history, or send an inactive-account estimate
// as current usage. The original timestamps remain the phone's expiry evidence.
function officialDesktopUsageState({ usage, org, accountFingerprint: identity, accountState = 'ready', latestActivity = 0, refreshResultAt = 0, refreshUnavailableReason = null }, now = Date.now()) {
  if (!org) usage = null;
  const window = key => {
    const row = usage?.[key];
    const at = Number.isFinite(row?.observedAt) && row.observedAt > 0 && row.observedAt <= now + 60_000 ? row.observedAt : null;
    const remaining = at && Number.isFinite(row?.remaining) && row.remaining >= 0 && row.remaining <= 100 ? Math.round(row.remaining) : null;
    const resetsAt = Number.isFinite(row?.resetsAt) && row.resetsAt > 0 ? row.resetsAt : null;
    const stale = !!at && (now - at > STALE_MS || !!row.stale || !!(resetsAt && now >= resetsAt));
    return {
      remainingPercent: stale ? null : remaining, lastKnownRemainingPercent: stale ? remaining : null,
      resetsAt, resetEstimated: false, observedAt: at, stale,
      staleWhileActive: stale && latestActivity > at, atMost: false,
      source: remaining !== null ? (row.source || usage.source) : null,
    };
  };
  const fiveHour = window('fiveHour'), sevenDay = window('sevenDay');
  const observedAt = Math.max(fiveHour.observedAt || 0, sevenDay.observedAt || 0) || null;
  const accountFingerprint = identity || (org ? accountIdentity('claude-usage', org) : null);
  return { fiveHour, sevenDay, observedAt, updatedAt: observedAt || 0,
    status: null, refreshResultAt, refreshUnavailableReason, accountFingerprint, accountState };
}

module.exports = { claudeUsageState, officialDesktopUsageState, usageResetBrackets, estimatedReset, STALE_MS };
