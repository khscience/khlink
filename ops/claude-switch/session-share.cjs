'use strict';

// Offline Code-index sharing. No credentials, transcripts, network, UI, or model calls.
// Desktop 2.37337.1.0 atomically replaces local_<uuid>.json; its directory also
// holds scheduled-tasks.json. Hardlinks and whole-directory junctions are unsuitable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const INDEX = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE = 'archived-sessions.idx';
const hash = bytes => bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const same = (a, b) => hash(a) === hash(b);
const equalInventory = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
function check(ok, message) { if (!ok) throw new Error(message); }

// Check every ancestor, including root. Never follow a junction into another
// profile or credential directory. Missing suffixes may be created by our writes.
function safePath(root, relative) {
  check(path.isAbsolute(root), 'Root must be absolute.');
  check(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), 'Invalid relative path.');
  const parts = relative.split(/[\\/]/);
  check(parts.every(p => /^[a-zA-Z0-9_.-]+$/.test(p) && p !== '.' && p !== '..' &&
    !p.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), 'Unsafe path component.');
  const full = path.resolve(root, ...parts);
  check(full.startsWith(path.resolve(root) + path.sep), 'Path escaped sharing root.');
  let current = path.parse(root).root;
  for (const part of path.resolve(root).slice(current.length).split(path.sep).filter(Boolean).concat(parts)) {
    current = path.join(current, part);
    try {
      const st = fs.lstatSync(current);
      check(!st.isSymbolicLink(), 'Reparse points are not allowed in sharing data.');
      check(current === full || st.isDirectory(), 'Invalid path ancestor.');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return full;
}
function read(root, rel) {
  const p = safePath(root, rel);
  try {
    const st = fs.lstatSync(p);
    check(st.isFile() && st.nlink === 1, 'Only ordinary, unlinked files may be shared.');
    check(st.size <= 10 * 1024 * 1024, 'Index or control file exceeds the size limit.');
    return fs.readFileSync(p);
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function parse(bytes) {
  check(bytes !== null, 'Required sharing file is missing.');
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Invalid JSON; contents were not logged.'); }
}
function validateConfig(config, { allowMissing = false, allowEmpty = false } = {}) {
  check(config.version === 1 && typeof config.root === 'string', 'Unsupported configuration.');
  check(typeof config.desktopVersion === 'string' && config.activeLink, 'Desktop identity is required.');
  check(config.profiles && !Array.isArray(config.profiles) && typeof config.profiles === 'object' && (allowEmpty || Object.keys(config.profiles).length >= 1), 'At least one explicit profile is required.');
  const paths = new Set();
  for (const [name, relative] of Object.entries(config.profiles)) {
    check(/^[a-z][a-z0-9-]{0,31}$/.test(name), 'Invalid profile alias.');
    check(/^claude-code-sessions[\\/][a-zA-Z0-9_-]+[\\/][a-zA-Z0-9_-]+$/.test(relative),
      'Select one exact Code account/org directory per profile.');
    const p = safePath(config.root, path.join('profiles', name, relative));
    try { check(fs.statSync(p).isDirectory(), 'Selected Code directory does not exist.'); }
    catch (error) { if (!allowMissing || error.code !== 'ENOENT') throw error; }
    check(!paths.has(p.toLowerCase()), 'Duplicate profile directory.');
    paths.add(p.toLowerCase());
  }
  return config;
}
function validateRecord(name, bytes) {
  const record = parse(bytes);
  check(record.sessionId === name.slice(0, -5) && UUID.test(record.cliSessionId || '') &&
    typeof record.cwd === 'string' && record.cwd.length > 0, 'Unsupported Code index identity.');
  // These need a different import/resume protocol or can start unattended work.
  // Never clear their flags to pretend they are ordinary local sessions.
  for (const key of ['sshConfig', 'wslConfig', 'stagedTranscriptPath', 'pendingFirstStart',
    'armedWorkAtQuit', 'scheduledTaskId', 'remoteControlLiveAtUpdateQuit',
    'interruptedUnseenResume', 'cloudSessionId', 'remoteControlSpawn']) {
    check(!record[key], 'Remote, imported, scheduled, or pending-start session requires manual review.');
  }
  function noCredentials(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'inputSchema') continue; // Tool schema names describe inputs, not secrets.
      check(!/^(cookies?|credentials?|access_?token|refresh_?token|oauth_?token|api_?key|authorization|password|headers)$/i.test(key) ||
        item == null || item === '', 'Credential-shaped data in a session index; sharing stopped.');
      noCredentials(item);
    }
  }
  noCredentials(record);
}
function scan(config, relative) {
  const dir = safePath(config.root, relative);
  if (!fs.existsSync(dir)) return new Map();
  const result = new Map();
  for (const name of fs.readdirSync(dir).sort()) {
    if (!INDEX.test(name)) continue; // Never open other files, including schedules/auth.
    const bytes = read(config.root, path.join(relative, name));
    check(bytes !== null, 'Index changed during scan; retry after Desktop exits.');
    validateRecord(name, bytes);
    result.set(name, bytes);
  }
  return result;
}
const inventory = map => Object.fromEntries([...map].map(([k, v]) => [k, hash(v)]));
const profileDir = (config, alias) => path.join('profiles', alias, config.profiles[alias]);
const STATE = path.join('shared', 'state.json');
const CONFIG = path.join('shared', 'config.json');
const STORE = path.join('shared', 'code-indexes');

function plan(config, { initialize = false, from } = {}) {
  validateConfig(config);
  check(config.profiles[from], 'An explicit active profile is required.');
  const snapshots = new Map();
  for (const alias of Object.keys(config.profiles))
    snapshots.set(profileDir(config, alias), scan(config, profileDir(config, alias)));
  const stored = scan(config, STORE);
  snapshots.set(STORE, stored);
  const previousBytes = read(config.root, STATE);
  const previous = previousBytes === null ? null : parse(previousBytes);
  const wanted = new Map();
  if (initialize) {
    check(previous === null && stored.size === 0 && read(config.root, CONFIG) === null, 'Sharing is already initialized.');
    for (const [dir, entries] of snapshots) {
      if (dir === STORE) continue;
      for (const [name, bytes] of entries) {
        check(!wanted.has(name) || same(wanted.get(name), bytes), 'Conflicting session indexes; no files were changed.');
        wanted.set(name, bytes);
      }
    }
  } else {
    check(previous?.version === 1 && same(read(config.root, CONFIG), json(config)), 'Sharing configuration/state mismatch.');
    check(equalInventory(inventory(stored), previous.records), 'Shared store changed outside the switcher.');
    for (const alias of Object.keys(config.profiles)) {
      if (alias === from) continue;
      check(equalInventory(inventory(snapshots.get(profileDir(config, alias))), previous.records),
        'Inactive profile changed independently; resolve conflict before switching.');
    }
    for (const entry of snapshots.get(profileDir(config, from))) wanted.set(...entry);
  }
  const operations = [];
  function change(rel, before, after) {
    if (!same(before, after)) operations.push({ rel, before, after });
  }
  for (const [relative, entries] of snapshots) {
    const start = operations.length;
    for (const name of new Set([...entries.keys(), ...wanted.keys()]))
      change(path.join(relative, name), entries.get(name) ?? null, wanted.get(name) ?? null);
    if (relative !== STORE && operations.length > start) {
      const rel = path.join(relative, CACHE);
      change(rel, read(config.root, rel), null); // Desktop rebuilds the cache.
    }
  }
  if (initialize) change(CONFIG, null, json(config));
  if (!initialize && operations.length === 0) return { config, from, operations, snapshots, count: wanted.size };
  const id = new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + crypto.randomUUID();
  const state = { version: 1, generation: (previous?.generation || 0) + 1, transaction: id, records: inventory(wanted) };
  change(STATE, previousBytes, json(state));
  return { config, from, id, operations, snapshots, count: wanted.size };
}
// Adopt a newly logged-in profile. Existing profiles must already match the
// last shared inventory; only the new account may contribute new records.
// CONFIG/STATE are backed up by the same journal as the allowed Code indexes.
function enrollPlan(before, alias, relative) {
  check(/^[a-z][a-z0-9-]{0,31}$/.test(alias), 'Invalid profile alias.');
  check(!before.profiles[alias] || before.profiles[alias] === relative, 'Profile directory changed.');
  const config = { ...before, profiles: { ...before.profiles, [alias]: relative } };
  validateConfig(config);
  check(same(read(config.root, CONFIG), json(before)), 'Registration changed during login.');
  const stored = scan(config, STORE), previousBytes = read(config.root, STATE);
  const previous = previousBytes === null ? null : parse(previousBytes);
  const existing = Object.keys(before.profiles).filter(id => id !== alias);
  if (existing.length || stored.size) {
    check(previous?.version === 1 && equalInventory(inventory(stored), previous.records), 'Shared indexes require review before adding this account.');
    for (const id of existing) check(equalInventory(inventory(scan(config, profileDir(config, id))), previous.records), 'Existing profile changed during login.');
  }
  const incoming = scan(config, profileDir(config, alias)), wanted = new Map(stored);
  for (const [name, bytes] of incoming) {
    check(!wanted.has(name) || same(wanted.get(name), bytes), 'Conflicting session indexes; no files were changed.');
    wanted.set(name, bytes);
  }
  const snapshots = new Map([[STORE, stored]]);
  for (const id of Object.keys(config.profiles)) snapshots.set(profileDir(config, id), scan(config, profileDir(config, id)));
  const operations = [];
  for (const [directory, records] of snapshots) {
    let changed = false;
    for (const name of new Set([...records.keys(), ...wanted.keys()])) {
      const old = records.get(name) ?? null, next = wanted.get(name) ?? null;
      if (!same(old, next)) { operations.push({ rel: path.join(directory, name), before: old, after: next }); changed = true; }
    }
    if (changed && directory !== STORE) {
      const rel = path.join(directory, CACHE), old = read(config.root, rel);
      if (old !== null) operations.push({ rel, before: old, after: null });
    }
  }
  if (!same(json(before), json(config))) operations.push({ rel: CONFIG, before: json(before), after: json(config) });
  const id = new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + crypto.randomUUID();
  operations.push({ rel: STATE, before: previousBytes, after: json({ version: 1, generation: (previous?.generation || 0) + 1, transaction: id, records: inventory(wanted) }) });
  return { config, from: alias, id, operations, snapshots, count: wanted.size };
}
function atomicWrite(root, rel, bytes) {
  const p = safePath(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  if (bytes === null) { if (fs.existsSync(p)) fs.unlinkSync(p); return; }
  const tmp = p + '.khshare-' + crypto.randomUUID();
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p); // Never fall back to truncating a live file.
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function transactionRel(id) {
  check(/^[0-9]{17}-[0-9a-f-]{36}$/.test(id), 'Invalid transaction identifier.');
  return path.join('shared', 'transactions', id);
}
function pending(config) {
  const base = safePath(config.root, 'shared/transactions');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter(id => {
    const entry = parse(read(config.root, path.join(transactionRel(id), 'journal.json')));
    return entry.phase === 'applying' || entry.phase === 'prepared';
  });
}
function rollback(config, id, guard) {
  guard();
  const base = transactionRel(id);
  const journalRel = path.join(base, 'journal.json');
  const journal = parse(read(config.root, journalRel));
  check(journal.version === 1 && Array.isArray(journal.operations), 'Invalid rollback journal.');
  const allowedDirs = [STORE, ...Object.keys(config.profiles).map(a => profileDir(config, a))];
  const changes = [];
  for (const entry of journal.operations) {
    check([STATE, CONFIG].includes(entry.rel) || (allowedDirs.includes(path.dirname(entry.rel)) &&
      (INDEX.test(path.basename(entry.rel)) || path.basename(entry.rel) === CACHE)), 'Journal target is outside the index allowlist.');
    const currentHash = hash(read(config.root, entry.rel));
    check(currentHash === entry.beforeHash || currentHash === entry.afterHash, 'New data exists; rollback refused to overwrite it.');
    check(entry.backup === null || /^before[\\/][0-9]+$/.test(entry.backup), 'Invalid backup path.');
    const before = entry.backup === null ? null : read(config.root, path.join(base, entry.backup));
    check(hash(before) === entry.beforeHash, 'Backup verification failed.');
    if (currentHash !== entry.beforeHash) changes.push({ rel: entry.rel, bytes: before, currentHash });
  }
  guard();
  for (const entry of changes.reverse()) {
    check(hash(read(config.root, entry.rel)) === entry.currentHash, 'Data changed during rollback; stopped.');
    atomicWrite(config.root, entry.rel, entry.bytes);
  }
  journal.phase = 'rolled-back';
  atomicWrite(config.root, journalRel, json(journal));
  return { transaction: id, restoredFiles: changes.length };
}
function execute(prepared, { guard, onWritten = () => {} } = {}) {
  check(typeof guard === 'function', 'Offline guard is required.');
  guard();
  const { config, id, operations, snapshots, count } = prepared;
  check(pending(config).length === 0, 'Unfinished transaction; recover it before any switch.');
  if (operations.length === 0) return { sessions: count, changedFiles: 0 };
  const base = transactionRel(id);
  const journalRel = path.join(base, 'journal.json');
  const journal = { version: 1, phase: 'prepared', operations: [] };
  operations.forEach((entry, i) => {
    const backup = entry.before === null ? null : path.join('before', String(i));
    if (backup !== null) {
      atomicWrite(config.root, path.join(base, backup), entry.before);
      check(same(read(config.root, path.join(base, backup)), entry.before), 'Backup mismatch.');
    }
    journal.operations.push({ rel: entry.rel, backup, beforeHash: hash(entry.before), afterHash: hash(entry.after) });
  });
  atomicWrite(config.root, journalRel, json(journal));
  let started = false;
  try {
    guard();
    for (const [dir, files] of snapshots)
      check(equalInventory(inventory(scan(config, dir)), inventory(files)), 'Index inventory changed after preview; stopped.');
    for (const entry of operations)
      check(same(read(config.root, entry.rel), entry.before), 'File changed after preview; stopped.');
    journal.phase = 'applying';
    atomicWrite(config.root, journalRel, json(journal));
    started = true;
    for (const [index, entry] of operations.entries()) {
      check(same(read(config.root, entry.rel), entry.before), 'Concurrent index write; stopped.');
      atomicWrite(config.root, entry.rel, entry.after);
      check(same(read(config.root, entry.rel), entry.after), 'Written index verification failed.');
      onWritten(index);
    }
    guard();
    journal.phase = 'committed';
    atomicWrite(config.root, journalRel, json(journal));
    return { sessions: count, changedFiles: operations.length, transaction: id, verified: true };
  } catch (error) {
    if (started) {
      try { rollback(config, id, guard); }
      catch { throw new Error('Sharing stopped; recover the unfinished transaction after Desktop exits.'); }
    } else {
      journal.phase = 'aborted';
      atomicWrite(config.root, journalRel, json(journal));
    }
    throw error;
  }
}
function liveGuard(config, from, ownerConfirmed) {
  check(process.platform === 'win32' && ownerConfirmed, 'This operation requires owner-confirmed normal exit on Windows.');
  return () => {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, 'assert-offline.ps1'), '-Root', config.root, '-ActiveLink', config.activeLink,
      '-From', from, '-DesktopVersion', config.desktopVersion], { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    check(output.trim() === 'OFFLINE_OK', 'Offline guard did not confirm readiness.');
  };
}
function main(args) {
  const command = args[0];
  const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const configPath = option('--config');
  check(configPath && path.isAbsolute(configPath), 'Pass an explicit --config path.');
  const st = fs.lstatSync(configPath);
  check(st.isFile() && !st.isSymbolicLink() && st.size < 32768, 'Invalid configuration file.');
  const config = validateConfig(parse(fs.readFileSync(configPath)));
  const from = option('--from');
  check(config.profiles[from], 'Select the current --from profile.');
  if (command === 'plan') {
    const p = plan(config, { initialize: args.includes('--initialize'), from });
    return { sessions: p.count, changedFiles: p.operations.length, previewOnly: true };
  }
  const guard = liveGuard(config, from, args.includes('--owner-confirmed-exit'));
  guard();
  check(['init', 'sync', 'rollback', 'recover'].includes(command), 'Unknown command.');
  const lock = safePath(config.root, 'shared/operation.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    if (command === 'rollback') return rollback(config, option('--transaction'), guard);
    if (command === 'recover') return pending(config).map(id => rollback(config, id, guard));
    return execute(plan(config, { initialize: command === 'init', from }), { guard });
  }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
module.exports = { safePath, validateConfig, validateRecord, plan, enrollPlan, execute, rollback, pending, read, hash, inventory, scan, main, liveGuard };
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (e) {
    console.error(e.status !== undefined ? 'Desktop/profile offline check failed; no switch is allowed.' : e.message);
    process.exitCode = 1;
  }
}
