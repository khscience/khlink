'use strict';

// Only khLink's already-observed quota numbers/times live here. Immutable
// records avoid cross-process writers replacing a newer observation with an
// older one. This directory never contains login material or HTTP headers.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SOURCES = new Set(['official-desktop-history', 'official-statusline', 'official-desktop-cached-response']);
const sourceOrder = source => ({ 'official-desktop-history': 0, 'official-statusline': 1, 'official-desktop-cached-response': 2 }[source] || 0);
const NAME = /^(fiveHour|sevenDay)-(\d{13,16})-([a-f0-9]{16})\.json$/;
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const age = 30 * 60_000;
function directory(base, org, create) {
  if (!base || typeof org !== 'string' || !org) return null;
  const dir = path.join(base, digest(org));
  for (const target of [base, dir]) {
    try { const st = fs.lstatSync(target); if (!st.isDirectory() || st.isSymbolicLink()) return null; }
    catch (e) { if (e.code !== 'ENOENT' || !create) return null; fs.mkdirSync(target, { mode: 0o700 }); }
  }
  return dir;
}
function window(value, fallbackSource, now) {
  const at = Number(value?.observedAt), reset = value?.resetsAt;
  const source = value?.source || fallbackSource;
  if (!SOURCES.has(source) || !Number.isFinite(value?.remaining) || value.remaining < 0 || value.remaining > 100 ||
      !Number.isFinite(at) || at < 1e12 || at > now + 60_000 || reset != null && (!Number.isFinite(reset) || reset <= 0)) return null;
  return { remaining: value.remaining, observedAt: at, resetsAt: reset || null, source, ...(value.notStarted === true ? { notStarted: true } : {}) };
}
function readObservations(base, org, now = Date.now()) {
  try {
    const dir = directory(base, org, false); if (!dir) return null;
    const rows = { fiveHour: [], sevenDay: [] };
    const files = fs.readdirSync(dir).filter(name => NAME.test(name)).sort((a, b) => Number(b.match(NAME)[2]) - Number(a.match(NAME)[2])).slice(0, 40);
    for (const name of files) {
      try {
        const match = name.match(NAME), file = path.join(dir, name), st = fs.lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 2048) continue;
        const text = fs.readFileSync(file, 'utf8'); if (digest(text).slice(0, 16) !== match[3]) continue;
        const row = window(JSON.parse(text), null, now);
        if (row && row.observedAt === Number(match[2])) rows[match[1]].push(row);
      } catch { /* A concurrent write/retention pass cannot supply a record. */ }
    }
    const out = {};
    for (const key of ['fiveHour', 'sevenDay']) {
      rows[key].sort((a, b) => b.observedAt - a.observedAt || sourceOrder(b.source) - sourceOrder(a.source) || Number(!!b.resetsAt) - Number(!!a.resetsAt));
      const row = rows[key][0];
      out[key] = row ? { ...row, stale: now - row.observedAt > age || !!row.resetsAt && now >= row.resetsAt } : null;
    }
    const latest = [out.fiveHour, out.sevenDay].filter(Boolean).sort((a, b) => b.observedAt - a.observedAt)[0];
    return latest ? { ...out, source: latest.source, observedAt: latest.observedAt } : null;
  } catch { return null; }
}
function saveObservations(base, org, usage, now = Date.now()) {
  if (!usage) return;
  try {
    const dir = directory(base, org, true); if (!dir) return;
    for (const key of ['fiveHour', 'sevenDay']) {
      const row = window(usage[key], usage.source, now); if (!row) continue;
      const text = JSON.stringify(row), name = `${key}-${row.observedAt}-${digest(text).slice(0, 16)}.json`;
      try { fs.writeFileSync(path.join(dir, name), text, { flag: 'wx', mode: 0o600 }); }
      catch (e) { if (e.code !== 'EEXIST') continue; }
      const old = fs.readdirSync(dir).filter(file => NAME.test(file) && file.match(NAME)[1] === key)
        .sort((a, b) => Number(b.match(NAME)[2]) - Number(a.match(NAME)[2])).slice(5);
      for (const file of old) {
        // Only remove our content-addressed numeric records, never an unknown file.
        try { const target = path.join(dir, file), st = fs.lstatSync(target); if (!st.isFile() || st.isSymbolicLink() || st.size > 2048) continue;
          const text = fs.readFileSync(target, 'utf8'); if (digest(text).slice(0, 16) === file.match(NAME)[3]) fs.unlinkSync(target);
        } catch { /* Another reader may still hold it; retry next observation. */ }
      }
    }
  } catch { /* Observation persistence must not break passive quota reads. */ }
}
module.exports = { readObservations, saveObservations };
