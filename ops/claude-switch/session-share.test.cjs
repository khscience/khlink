'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const share = require('./session-share.cjs');

// Synthetic fixtures only. No test discovers or reads actual profiles, cookies,
// or transcripts. KH_CLAUDE_TEST_ROOT or KHLINK_TEST_DIR can move them.
const base = process.env.KH_CLAUDE_TEST_ROOT || path.join(fs.realpathSync.native(process.env.KHLINK_TEST_DIR || os.tmpdir()), 'kh-claude-share-tests');
fs.mkdirSync(base, { recursive: true });
const guard = () => {};
function fixture() {
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  const config = { version: 1, root, desktopVersion: '2.37337.1.0', activeLink: 'synthetic',
    profiles: { primary: 'claude-code-sessions/acct-a/org-a', secondary: 'claude-code-sessions/acct-b/org-b' } };
  const dirs = Object.fromEntries(Object.entries(config.profiles).map(([k, v]) => [k, path.join(root, 'profiles', k, v)]));
  for (const p of Object.values(dirs)) fs.mkdirSync(p, { recursive: true });
  const record = (extra = {}) => ({ sessionId: 'local_' + crypto.randomUUID(), cliSessionId: crypto.randomUUID(),
    cwd: 'G:\\Synthetic\\中文项目', createdAt: 100, lastActivityAt: 200, title: '中文测试会话', isArchived: false,
    permissionMode: 'default', ...extra });
  const write = (alias, item) => {
    const name = item.sessionId + '.json';
    fs.writeFileSync(path.join(dirs[alias], name), JSON.stringify(item, null, 2) + '\n');
    return name;
  };
  const initialize = () => share.execute(share.plan(config, { initialize: true, from: 'primary' }), { guard });
  const sync = from => share.execute(share.plan(config, { from }), { guard });
  return { root, config, dirs, record, write, initialize, sync };
}
function disk(dir, name) { return fs.readFileSync(path.join(dir, name), 'utf8'); }

test('initial merge preserves exact bytes and leaves schedules/usage/login files alone', () => {
  const f = fixture(), a = f.record(), b = f.record();
  const name = f.write('primary', a), bname = f.write('secondary', b);
  const sentinels = [];
  for (const alias of ['primary', 'secondary']) {
    for (const file of ['scheduled-tasks.json', 'tasks.json', 'Cookies', 'plan-usage-history.json']) {
      const p = path.join(f.dirs[alias], file);
      fs.writeFileSync(p, 'Not JSON: private synthetic sentinel');
      sentinels.push(p);
    }
  }
  const result = f.initialize();
  assert.equal(result.sessions, 2);
  assert.equal(disk(f.dirs.primary, name), disk(f.dirs.secondary, name));
  assert.equal(disk(f.dirs.primary, bname), disk(f.dirs.secondary, bname));
  for (const p of sentinels) assert.equal(fs.readFileSync(p, 'utf8'), 'Not JSON: private synthetic sentinel');
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'shared/code-indexes')).sort(), [name, bname].sort());
});
test('new sessions, title changes, archive and continuation propagate in both directions', () => {
  const f = fixture(), a = f.record();
  const name = f.write('primary', a);
  f.initialize();
  f.write('secondary', { ...a, title: '第二账号续聊', completedTurns: 3, isArchived: true });
  const bname = f.write('secondary', f.record());
  f.sync('secondary');
  assert.equal(JSON.parse(disk(f.dirs.primary, name)).completedTurns, 3);
  assert.equal(JSON.parse(disk(f.dirs.primary, name)).isArchived, true);
  assert.equal(disk(f.dirs.primary, bname), disk(f.dirs.secondary, bname));
  f.write('primary', { ...a, isArchived: false, completedTurns: 4 });
  f.sync('primary');
  assert.equal(JSON.parse(disk(f.dirs.secondary, name)).completedTurns, 4);
});
test('deletion is propagated without resurrection and removed index is backed up', () => {
  const f = fixture(), name = f.write('primary', f.record());
  f.initialize();
  const original = disk(f.dirs.secondary, name);
  fs.unlinkSync(path.join(f.dirs.primary, name));
  const result = f.sync('primary');
  assert.equal(fs.existsSync(path.join(f.dirs.secondary, name)), false);
  assert.equal(f.sync('secondary').changedFiles, 0);
  const dir = path.join(f.root, 'shared/transactions', result.transaction, 'before');
  assert.ok(fs.readdirSync(dir).some(n => disk(dir, n) === original));
});
test('no-op does not create another transaction', () => {
  const f = fixture(); f.write('primary', f.record()); f.initialize();
  const before = fs.readdirSync(path.join(f.root, 'shared/transactions'));
  assert.equal(f.sync('primary').changedFiles, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'shared/transactions')), before);
});
test('initial same-name conflict never overwrites either profile', () => {
  const f = fixture(), a = f.record(); const name = f.write('primary', a);
  f.write('secondary', { ...a, title: 'conflict' });
  assert.throws(f.initialize, /Conflicting/);
  assert.equal(JSON.parse(disk(f.dirs.primary, name)).title, a.title);
  assert.equal(fs.existsSync(path.join(f.root, 'shared')), false);
});
test('independent inactive-profile change blocks sync', () => {
  const f = fixture(), a = f.record(); f.write('primary', a); f.initialize();
  f.write('secondary', { ...a, completedTurns: 2 });
  assert.throws(() => f.sync('primary'), /Inactive profile/);
});
test('out-of-band shared-store change blocks sync', () => {
  const f = fixture(), name = f.write('primary', f.record()); f.initialize();
  fs.unlinkSync(path.join(f.root, 'shared/code-indexes', name));
  assert.throws(() => f.sync('primary'), /Shared store changed/);
});
test('malformed JSON stops without including raw text in errors', () => {
  const f = fixture(), name = f.write('primary', f.record());
  fs.writeFileSync(path.join(f.dirs.primary, name), 'DO_NOT_LOG_THIS');
  assert.throws(f.initialize, e => /Invalid JSON/.test(e.message) && !e.message.includes('DO_NOT_LOG'));
});
test('filename and embedded session identity must match', () => {
  const f = fixture(), name = f.write('primary', f.record());
  fs.writeFileSync(path.join(f.dirs.primary, name), JSON.stringify(f.record()));
  assert.throws(f.initialize, /identity/);
});
test('remote and auto-starting records are rejected without editing their flags', () => {
  for (const key of ['sshConfig', 'stagedTranscriptPath', 'pendingFirstStart', 'armedWorkAtQuit', 'scheduledTaskId']) {
    const f = fixture(), a = f.record({ [key]: 'synthetic' }); const name = f.write('primary', a);
    assert.throws(f.initialize, /manual review/);
    assert.equal(JSON.parse(disk(f.dirs.primary, name))[key], 'synthetic');
  }
});
test('credential containers are rejected but tool schema property names are not secrets', () => {
  const f = fixture(), a = f.record({ remoteMcpServersConfig: [{ headers: { Authorization: 'SYNTHETIC' } }] });
  f.write('primary', a);
  assert.throws(f.initialize, e => /Credential-shaped/.test(e.message) && !e.message.includes('SYNTHETIC'));
  f.write('primary', { ...a, remoteMcpServersConfig: [{ tools: [{ inputSchema: { properties: { password: { type: 'string' } } } }] }] });
  assert.equal(f.initialize().sessions, 1);
});
test('path traversal, alternate streams and credential-directory mapping are rejected', () => {
  const f = fixture();
  for (const relative of ['../outside', 'shared/state.json:stream', 'shared/NUL', 'shared/name.'])
    assert.throws(() => share.safePath(f.root, relative), /Unsafe|escaped/);
  f.config.profiles.secondary = 'Cookies';
  assert.throws(f.initialize, /exact Code/);
});
test('directory junction is rejected before reading its target', () => {
  const f = fixture(), outside = fs.mkdtempSync(path.join(base, 'outside-'));
  fs.rmdirSync(f.dirs.secondary); // Empty synthetic leaf only.
  fs.symlinkSync(outside, f.dirs.secondary, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(f.initialize, /Reparse/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('hardlinked index is rejected', () => {
  const f = fixture(), name = f.write('primary', f.record());
  fs.linkSync(path.join(f.dirs.primary, name), path.join(f.root, 'synthetic-hardlink'));
  assert.throws(f.initialize, /unlinked files/);
});
test('running-process guard prevents writes', () => {
  const f = fixture(); f.write('primary', f.record());
  const p = share.plan(f.config, { initialize: true, from: 'primary' });
  assert.throws(() => share.execute(p, { guard: () => { throw Error('busy'); } }), /busy/);
  assert.equal(fs.existsSync(path.join(f.root, 'shared')), false);
});
test('change after preview stops without replacing new content', () => {
  const f = fixture(), a = f.record(); const name = f.write('primary', a);
  const p = share.plan(f.config, { initialize: true, from: 'primary' });
  f.write('primary', { ...a, title: 'newer live write' });
  assert.throws(() => share.execute(p, { guard }), /changed after preview/);
  assert.equal(JSON.parse(disk(f.dirs.primary, name)).title, 'newer live write');
  assert.equal(fs.existsSync(path.join(f.dirs.secondary, name)), false);
});
test('mid-apply failure rolls back all changed files', () => {
  const f = fixture(), a = f.record(); const name = f.write('primary', a);
  f.initialize();
  const before = disk(f.dirs.secondary, name);
  f.write('primary', { ...a, title: 'new title' });
  const p = share.plan(f.config, { from: 'primary' });
  assert.throws(() => share.execute(p, { guard, onWritten: i => { if (i === 0) throw Error('injected'); } }), /injected/);
  assert.equal(disk(f.dirs.secondary, name), before);
  assert.equal(JSON.parse(disk(f.dirs.primary, name)).title, 'new title');
  assert.deepEqual(share.pending(f.config), []);
});
test('if Desktop restarts during failure, leave recoverable journal and block subsequent switch', () => {
  const f = fixture(), name = f.write('primary', f.record());
  let busy = false;
  const p = share.plan(f.config, { initialize: true, from: 'primary' });
  assert.throws(() => share.execute(p, {
    guard: () => { if (busy) throw Error('busy'); },
    onWritten: () => { busy = true; throw Error('injected'); }
  }), /recover/);
  assert.deepEqual(share.pending(f.config), [p.id]);
  share.rollback(f.config, p.id, guard);
  assert.equal(fs.existsSync(path.join(f.dirs.secondary, name)), false);
  assert.ok(fs.existsSync(path.join(f.dirs.primary, name)));
  assert.deepEqual(share.pending(f.config), []);
});
test('rollback refuses newer writes and does not overwrite them', () => {
  const f = fixture(), a = f.record(); const name = f.write('primary', a);
  const result = f.initialize();
  f.write('secondary', { ...a, title: 'do not overwrite' });
  assert.throws(() => share.rollback(f.config, result.transaction, guard), /New data/);
  assert.equal(JSON.parse(disk(f.dirs.secondary, name)).title, 'do not overwrite');
});
test('archive hint cache is backed up and invalidated; rollback restores it', () => {
  const f = fixture(), name = f.write('primary', f.record({ isArchived: true }));
  fs.writeFileSync(path.join(f.dirs.secondary, 'archived-sessions.idx'), 'old hint');
  const result = f.initialize();
  assert.equal(fs.existsSync(path.join(f.dirs.secondary, 'archived-sessions.idx')), false);
  share.rollback(f.config, result.transaction, guard);
  assert.equal(disk(f.dirs.secondary, 'archived-sessions.idx'), 'old hint');
  assert.equal(fs.existsSync(path.join(f.dirs.secondary, name)), false);
});
test('tampered rollback journal cannot target a login file', () => {
  const f = fixture(); f.write('primary', f.record());
  const result = f.initialize();
  const journalPath = path.join(f.root, 'shared/transactions', result.transaction, 'journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.operations[0].rel = 'profiles/primary/Cookies';
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  assert.throws(() => share.rollback(f.config, result.transaction, guard), /allowlist/);
});
