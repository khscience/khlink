'use strict';

const fs = require('node:fs');
const MAX_AGE = 30 * 60 * 1000;
const sourceOrder = source => ({ 'official-desktop-history': 0, 'official-statusline': 1, 'official-desktop-cached-response': 2 }[source] || 0);
const percent = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
function timestamp(n) {
  if (typeof n === 'string') n = Date.parse(n);
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}
function windowValue(used, reset, observedAt, now) {
  const remaining = percent(used) === null ? null : Math.round((100 - used) * 10) / 10;
  const resetsAt = timestamp(reset);
  return { remaining, resetsAt, observedAt, stale: now - observedAt > MAX_AGE || (resetsAt !== null && resetsAt <= now) };
}
function fromHistory(data, org, now = Date.now()) {
  if (data?.version !== 2 || !Array.isArray(data.samples)) return null;
  // Match the explicitly registered organization, never the most recent folder.
  const samples = data.samples.filter(x => x.org === org && Number.isFinite(x.t) && x.t > 0 && x.t <= now + 60_000 && x.u && (percent(x.u.fh) !== null || percent(x.u.sd) !== null));
  const row = samples.sort((a, b) => b.t - a.t)[0];
  if (!row) return null;
  return { source: 'official-desktop-history', observedAt: row.t,
    fiveHour: windowValue(row.u.fh, null, row.t, now), sevenDay: windowValue(row.u.sd, null, row.t, now) };
}
function fromStatusline(data, alias, now = Date.now()) {
  if (data?.source !== 'official-statusline' || data.profile !== alias || data.synthetic === true) return null;
  const at = timestamp(data.observedAt);
  if (!at || at > now + 60_000) return null;
  const r = data.rate_limits;
  if (!r || (percent(r.five_hour?.used_percentage) === null && percent(r.seven_day?.used_percentage) === null)) return null;
  return { source: 'official-statusline', observedAt: at,
    fiveHour: windowValue(r.five_hour?.used_percentage, r.five_hour?.resets_at, at, now),
    sevenDay: windowValue(r.seven_day?.used_percentage, r.seven_day?.resets_at, at, now) };
}
function readJson(file) {
  try { const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || s.size > 4 * 1024 * 1024) return null; return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function selectUsage(history,callback,response,now=Date.now()){
  // Desktop writes its compact history just after processing this response.
  // Treat it as the same sample only when both percentages match AND the times
  // differ by at most 5 seconds. Keep the response's original observation time.
  const same=history&&response&&Math.abs(history.observedAt-response.observedAt)<=5000&&['fiveHour','sevenDay'].every(k=>history[k]?.remaining===response[k]?.remaining);
  if (same && !callback) return response;
  const sources=[same?null:history,callback,response].filter(Boolean).sort((a,b)=>b.observedAt-a.observedAt||sourceOrder(b.source)-sourceOrder(a.source));
  if(!sources.length)return {source:'unavailable',observedAt:null,fiveHour:null,sevenDay:null};
  const result={...sources[0]};
  for(const key of ['fiveHour','sevenDay']){
    const rows=sources.map(source=>({...source[key],observedAt:source[key]?.observedAt||source.observedAt,source:source[key]?.source||source.source})).filter(row=>percent(row.remaining)!==null&&row.observedAt>0).sort((a,b)=>b.observedAt-a.observedAt||sourceOrder(b.source)-sourceOrder(a.source));
    const latest=rows[0];
    if(!latest){result[key]=null;continue;}
    // These sources have already been resolved to one registered profile.
    // A newer compact percentage must not erase a still-future exact reset.
    // A usage decrease or explicit notStarted marks a different window.
    const exact=latest.resetsAt ? latest : !latest.notStarted && rows.find(row=>row.resetsAt>now&&row.resetsAt>latest.observedAt&&latest.remaining<=row.remaining);
    const resetsAt=latest.resetsAt||exact?.resetsAt||null;
    result[key]={...latest,resetsAt,stale:now-latest.observedAt>MAX_AGE||!!resetsAt&&resetsAt<=now};
  }
  result.observedAt=Math.max(...['fiveHour','sevenDay'].map(key=>result[key]?.observedAt||0))||null;
  return result;
}
// Both Desktop and the connector call this selector with the same registered
// profile. File paths are supplied by the guarded profile resolver; no auth file
// is ever opened, and this reader cannot make requests or launch Claude.
function readOfficialUsage({ historyFile, callbackFile, cacheDir, hintFile, observationsDir, org, alias }, now = Date.now()) {
  const history = fromHistory(readJson(historyFile), org, now);
  const callback = fromStatusline(readJson(callbackFile), alias, now);
  const cached = require('./claude-usage-cache.js').readUsage(cacheDir, org, hintFile, now);
  const response = cached ? fromStatusline({ ...cached, profile: alias, source: 'official-statusline' }, alias, now) : null;
  if (response) {
    response.source = 'official-desktop-cached-response';
    for (const key of ['fiveHour', 'sevenDay']) if (response[key].remaining === 100 && response[key].resetsAt === null) response[key].notStarted = true;
  }
  const observations = require('./claude-usage-observations');
  const prior = observations.readObservations(observationsDir, org, now);
  const current = selectUsage(history, callback, response, now);
  // The middle slot deliberately avoids the history/response same-sample fast
  // path: a compact sample must not discard a previously observed exact reset.
  const selected = prior ? selectUsage(prior, current, null, now) : current;
  observations.saveObservations(observationsDir, org, selected, now);
  return selected;
}
module.exports = { MAX_AGE, percent, timestamp, fromHistory, fromStatusline, readOfficialUsage, selectUsage };
