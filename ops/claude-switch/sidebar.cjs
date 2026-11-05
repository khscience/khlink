'use strict';

// Only these four UI-preference keys are read. Never enumerate values, copy a
// LevelDB directory, or open Cookies / tokens / credential stores. Verified on
// official MSIX 2.37337.1.0: dframe-store version 1 is the legacy mirror; LSS local-slice
// and code-sections are the current persisted stores. Both must agree.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ClassicLevel } = require('classic-level');
const { safePath } = require('./session-share.cjs');
const native = require('./native-prefs.cjs');
const pinDb = require('./pin-idb.cjs');
const KEYS = ['dframe-store', 'LSS-persisted.dframe-local-slice', 'LSS-persisted.dframe-code-sections', 'LSS-persisted.starred-local-code-sessions'];
const prefix = '_https://claude.ai\0\x01';
const keyBytes = key => Buffer.from(prefix + key, 'latin1');
const digest = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clone = v => structuredClone(v);
function check(ok, message) { if (!ok) throw new Error(message); }
function decode(bytes) {
  if (!bytes) return null;
  check(bytes.length < 1024 * 1024 && [0, 1].includes(bytes[0]), 'Unsupported sidebar preference encoding.');
  const value = JSON.parse(bytes.subarray(1).toString(bytes[0] === 0 ? 'utf16le' : 'latin1'));
  check(value && typeof value === 'object' && !Array.isArray(value), 'Invalid sidebar preferences.');
  return value;
}
const encode = value => Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value), 'utf16le')]);
const scopeOf = rel => rel.split(/[\\/]/).slice(-2).join('/');
function extract(values, scope, ids, legacyOrderOnly = false) {
  const legacy = values[0]?.state;
  check(legacy && values[0].version === 1, `Unknown Claude sidebar schema (record=${!!values[0]}, state=${!!legacy}, version=${values[0]?.version ?? 'missing'}); review before switching.`);
  const slice = values[1]?.value;
  const order = slice?.pinnedOrder ?? legacy.pinnedOrder;
  check(Array.isArray(order) && order.every(x => typeof x === 'string'), 'Invalid pinned order.');
  // Current Desktop keeps pin membership separately from its display order.
  // isStarred in a Code index is a native mirror, not the renderer's source.
  const rawMembers = values[3]?.value;
  check(legacyOrderOnly || (Array.isArray(rawMembers) && rawMembers.every(x => typeof x === 'string')), 'Unknown Code pin membership schema.');
  const members = legacyOrderOnly ? order : rawMembers.map(id => id.startsWith('code:') ? id : 'code:' + id);
  const memberSet = new Set(members.filter(id => ids.has(id)));
  const pinned = [...new Set([...order.filter(id => memberSet.has(id)), ...members.filter(id => ids.has(id))])];
  const layout = values[2]?.value?.[scope] ?? legacy.codeSidebarByScope?.[scope];
  check(layout && Array.isArray(layout.sections), 'Current account sidebar layout is missing.');
  const section = layout.sections.find(x => x.id === 'pinned' && x.kind === 'pinned');
  check(section?.v === 2 && typeof section.sortBy === 'string' && typeof section.ascending === 'boolean', 'Unknown pinned section schema.');
  return { pinned, section: Object.fromEntries(['id', 'kind', 'v', 'name', 'order', 'sortBy', 'ascending', 'show', 'collapsed', 'shown'].filter(k => k in section).map(k => [k, clone(section[k])])) };
}
function merge(values, scope, source, ids, now = Date.now()) {
  const next = clone(values);
  check(next[0]?.state && next[0].version === 1 && next[1]?.value && next[2]?.value && Array.isArray(next[3]?.value), 'Target sidebar has not been initialized by Claude.');
  function order(previous) {
    check(Array.isArray(previous), 'Invalid target pinned order.');
    // Preserve Chat / Cowork / other organizations. Shared Code items occupy
    // the same relative sequence as the source, including explicit unpinning.
    const others = previous.filter(id => !ids.has(id));
    return [...source.pinned, ...others];
  }
  next[0].state.pinnedOrder = order(next[0].state.pinnedOrder);
  next[1].value.pinnedOrder = order(next[1].value.pinnedOrder);
  next[3].value = [...source.pinned.map(id => id.slice('code:'.length)), ...next[3].value.filter(id => !ids.has(id.startsWith('code:') ? id : 'code:' + id))];
  for (const scopes of [next[0].state.codeSidebarByScope, next[2].value]) {
    check(scopes?.[scope]?.sections, 'Target account sidebar scope is missing.');
    scopes[scope].sections = scopes[scope].sections.map(s => s.id === 'pinned' && s.kind === 'pinned' ? clone(source.section) : s);
  }
  for (const index of [1, 2, 3]) { next[index].timestamp = now; next[index].tabId = ''; }
  return next;
}
async function openPreferences(config, alias) {
  let dir = safePath(config.root, path.join('profiles', alias));
  for (const name of ['Local Storage', 'leveldb']) {
    dir = path.join(dir, name);
    const st = fs.lstatSync(dir);
    check(st.isDirectory() && !st.isSymbolicLink(), 'Sidebar path must not contain a link.');
  }
  check(fs.existsSync(path.join(dir, 'CURRENT')), 'Claude sidebar database is missing.');
  // Native LevelDB provides an exclusive OS lock and atomic, durable batches.
  const db = new ClassicLevel(dir, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await db.open();
  return db;
}
async function read(db) { return Promise.all(KEYS.map(async key => decode(await db.get(keyBytes(key))))); }
async function write(db, values) {
  await db.batch(KEYS.map((key, index) => values[index] === null ? { type: 'del', key: keyBytes(key) } : { type: 'put', key: keyBytes(key), value: encode(values[index]) }), { sync: true });
}
function save(file, value) {
  const temp = file + '.tmp-' + crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}
async function recoverPrepared(dbs, journal, journalFile, stateFile, locations) {
  const aliases = [...dbs.keys()];
  check([2,3].includes(journal.version) && journal.phase === 'prepared' && aliases.every(a => journal.before?.[a]?.length === KEYS.length && journal.after?.[a]?.length === KEYS.length), 'Unknown sidebar recovery record; original profile retained.');
  // Inspect every account before changing any of them. Only our own recorded
  // before/after images are recoverable; later edits must never be discarded.
  for (const a of aliases) check([digest(journal.before[a]), digest(journal.after[a])].includes(digest(await read(dbs.get(a)))), 'New sidebar data exists; recovery requires review.');
  if(journal.version===3) {
    check(locations, 'Native sidebar recovery paths missing.');
    for(const a of aliases){check([digest(journal.nativeBefore[a]),digest(journal.nativeAfter[a])].includes(digest(native.read(locations[a].native).values)),'Native sidebar changed after transaction.');pinDb.canRestore(locations[a].idb,journal.pinPlans[a]);}
    for(const a of aliases){pinDb.restorePlan(locations[a].idb,journal.pinPlans[a]);native.write(locations[a].native,native.read(locations[a].native).values,journal.nativeBefore[a]);}
  }
  for (const a of aliases) await write(dbs.get(a), journal.before[a]);
  if (journal.previousState) save(stateFile, journal.previousState);
  else if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  journal.phase = 'rolled-back'; save(journalFile, journal);
}
async function synchronize(config, from, guard) {
  guard();
  const aliases = Object.keys(config.profiles);
  const ids = new Set(fs.readdirSync(safePath(config.root, 'shared/code-indexes')).filter(n => /^local_[a-f0-9-]{36}\.json$/i.test(n)).map(n => 'code:' + n.slice(0, -5)));
  const journalFile = safePath(config.root, 'shared/sidebar-journal.json');
  const stateFile = safePath(config.root, 'shared/sidebar-state.json');
  const dbs = new Map();
  const locations=Object.fromEntries(aliases.map(a=>[a,{native:safePath(config.root,path.join('profiles',a,'claude_desktop_config.json')),idb:safePath(config.root,path.join('profiles',a,'IndexedDB/https_claude.ai_0.indexeddb.leveldb'))}]));
  try {
    for (const alias of aliases) dbs.set(alias, await openPreferences(config, alias));
    const existing = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : null;
    if (existing?.phase === 'prepared') { guard(); await recoverPrepared(dbs, existing, journalFile, stateFile,locations); }
    check(!existing || ['committed', 'rolled-back'].includes(existing.phase), 'Unfinished sidebar transaction; recover before switching.');
    const before = Object.fromEntries(await Promise.all(aliases.map(async a => [a, await read(dbs.get(a))])));
    const nativeBefore=Object.fromEntries(aliases.map(a=>[a,native.read(locations[a].native).values]));
    // Desktop writes these mirrors when exiting. Native preferences are what
    // bootstrap hydration reads first; a mismatch must not become an unpin.
    for(const a of aliases)for(let i=0;i<3;i++)check(digest(before[a][i+1]?.value)===digest(nativeBefore[a][i]),'Claude sidebar mirrors disagree; preserve current account and inspect.');
    const source = extract(before[from], scopeOf(config.profiles[from]), ids);
    const previous = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
    for (const a of aliases.filter(a => a !== from)) {
      if (previous?.profiles?.[a]) check(digest(extract(before[a], scopeOf(config.profiles[a]), new Set(previous.ids || ids), previous.version === 1)) === previous.profiles[a], 'Inactive sidebar changed independently; original profile retained.');
    }
    const after = Object.fromEntries(aliases.map(a => [a, a === from ? before[a] : merge(before[a], scopeOf(config.profiles[a]), source, ids)]));
    const nativeAfter=Object.fromEntries(aliases.map(a=>[a,after[a].slice(1).map(v=>v.value)]));
    const pinPlans=Object.fromEntries(aliases.map(a=>[a,a===from?null:pinDb.deletionPlan(locations[a].idb)]));
    const journal = { version: 3, phase: 'prepared', at: Date.now(), before, after, nativeBefore,nativeAfter,pinPlans,previousState: previous };
    save(journalFile, journal); // UI preferences only; never whole storage files.
    guard();
    try {
      for (const a of aliases) {
        check(digest(await read(dbs.get(a))) === digest(before[a]), 'Concurrent sidebar update; stopped.');
        if (a !== from) {await write(dbs.get(a), after[a]);native.write(locations[a].native,nativeBefore[a],nativeAfter[a]);pinDb.applyPlan(locations[a].idb,pinPlans[a]);}
        check(digest(await read(dbs.get(a))) === digest(after[a]), 'Sidebar verification failed.');
      }
      save(stateFile, { version: 3, at: Date.now(), ids: [...ids], pinned: source.pinned.length, profiles: Object.fromEntries(aliases.map(a => [a, digest(extract(after[a], scopeOf(config.profiles[a]), ids))])) });
      journal.phase = 'committed'; save(journalFile, journal);
      return { pinned: source.pinned.length, verified: true };
    } catch (e) {
      for(const a of aliases){pinDb.canRestore(locations[a].idb,pinPlans[a]);check([digest(nativeBefore[a]),digest(nativeAfter[a])].includes(digest(native.read(locations[a].native).values)),'Native settings changed; preserve newer data.');}
      for (const a of aliases) {
        const current = digest(await read(dbs.get(a)));
        check([digest(before[a]), digest(after[a])].includes(current), 'New sidebar data exists; recovery requires review.');
        if (current !== digest(before[a])) await write(dbs.get(a), before[a]);
        pinDb.restorePlan(locations[a].idb,pinPlans[a]);native.write(locations[a].native,native.read(locations[a].native).values,nativeBefore[a]);
      }
      if (previous) save(stateFile, previous);
      else if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
      journal.phase = 'rolled-back'; save(journalFile, journal); throw e;
    }
  } finally { for (const db of dbs.values()) await db.close(); }
}
module.exports = { KEYS, keyBytes, encode, decode, extract, merge, scopeOf, synchronize, recoverPrepared };
