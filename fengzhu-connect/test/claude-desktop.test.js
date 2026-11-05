const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const d = require('../src/backends/claude-desktop');
const { ready } = require('../src/crypto');
const { Connector } = require('../src/connector');

// Every temporary folder a test makes is removed when the run ends (they
// used to pile up in %TEMP%: 15,000+ by 2026-11-05).
const madeDirs = [];
process.on('exit', () => { for (const dir of madeDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* in use */ } } });
function tmp(prefix = 'khlink-claude-desktop-') { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); madeDirs.push(dir); return dir; }

function varint(n) { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); }
// One LevelDB log record (FULL) holding a single Put.
function logRecord(seq, key, value) {
  const head = Buffer.alloc(12); head.writeBigUInt64LE(BigInt(seq), 0); head.writeUInt32LE(1, 8);
  const batch = Buffer.concat([head, Buffer.from([1]), varint(key.length), key, varint(value.length), value]);
  const header = Buffer.alloc(7); header.writeUInt16LE(batch.length, 4); header[6] = 1;
  return Buffer.concat([header, batch]);
}

function desktopFixture() {
  const root = tmp(); const projects = tmp();
  const account = path.join(root, 'claude-code-sessions', 'acct', 'org'); fs.mkdirSync(account, { recursive: true });
  const write = (id, meta) => fs.writeFileSync(path.join(account, `${id}.json`), JSON.stringify({ sessionId: id, ...meta }));
  write('local_00000000-0000-4000-8000-000000000001', { cliSessionId: '11111111-1111-4111-8111-111111111111', cwd: 'C:\\proj\\a', title: '00 总纲', model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'bypassPermissions', isStarred: true, lastActivityAt: 1000, lastFocusedAt: 5 });
  write('local_00000000-0000-4000-8000-000000000002', { cliSessionId: '22222222-2222-4222-8222-222222222222', cwd: 'C:\\proj\\b', title: '01 编辑器', model: 'sonnet', permissionMode: 'default', isStarred: true, lastActivityAt: 2000, lastFocusedAt: 9 });
  write('local_00000000-0000-4000-8000-000000000003', { cliSessionId: '33333333-3333-4333-8333-333333333333', cwd: 'C:\\proj\\c', title: '临时', isStarred: false, isArchived: false, lastActivityAt: 3000 });
  const ldb = path.join(root, 'Local Storage', 'leveldb'); fs.mkdirSync(ldb, { recursive: true });
  const key = Buffer.from('_https://claude.ai\u0000\u0001dframe-store', 'latin1');
  const stale = Buffer.concat([Buffer.from([1]), Buffer.from('{"state":{"pinnedOrder":["code:local_00000000-0000-4000-8000-000000000001","code:local_00000000-0000-4000-8000-000000000002"]}}', 'latin1')]);
  const fresh = Buffer.concat([Buffer.from([1]), Buffer.from('{"state":{"pinnedOrder":["code:local_00000000-0000-4000-8000-000000000002","code:local_00000000-0000-4000-8000-000000000001"]}}', 'latin1')]);
  fs.writeFileSync(path.join(ldb, '000003.log'), Buffer.concat([logRecord(10, key, stale), logRecord(11, key, fresh)]));
  const projectDir = path.join(projects, d.projectDirName('C:\\proj\\a')); fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, '11111111-1111-4111-8111-111111111111.jsonl');
  return { root, projects, account, transcript, store: new d.ClaudeDesktopStore({ root, projectsRoot: projects, logFiles: [path.join(root, "no-main.log")], execFileFn: (bin, args, opts, cb) => cb(null, "") }) };
}

const line = (o) => `${JSON.stringify(o)}\n`;

test('snappy decompression handles literals and back-references', () => {
  // "abcabcabcabc": literal "abc" then copy offset 3 length 9.
  const compressed = Buffer.from([12, (3 - 1) << 2, 0x61, 0x62, 0x63, ((9 - 1) << 2) | 2, 3, 0]);
  assert.equal(d.snappyDecompress(compressed).toString(), 'abcabcabcabc');
});

test('desktop sessions: account folder, fields, permission mapping and sidebar pin order', () => {
  const { store } = desktopFixture();
  const list = store.listSessions();
  assert.equal(list.length, 3);
  const pinned = list.filter((s) => s.pinned).sort((a, b) => a.pinOrder - b.pinOrder).map((s) => s.title);
  assert.deepEqual(pinned, ['01 编辑器', '00 总纲'], 'newest pinnedOrder write wins');
  const a = list.find((s) => s.title === '00 总纲');
  assert.equal(a.approveMode, 'bypassPermissions', 'desktop permission value kept as-is'); assert.equal(a.effort, 'xhigh'); assert.equal(a.model, 'claude-opus-5-5');
  assert.equal(list.find((s) => s.title === '临时').pinOrder, -1);
  assert.equal(store.focusedSessionId(), 'local_00000000-0000-4000-8000-000000000002');
});

test('transcript → items: user/assistant/thinking/tools, internal turns hidden, incremental and stable', () => {
  const { store, transcript } = desktopFixture();
  fs.writeFileSync(transcript,
    line({ type: 'user', uuid: 'u1', timestamp: '2026-09-27T01:00:00Z', message: { role: 'user', content: '看一下总纲' } }) +
    line({ type: 'user', uuid: 'u0', timestamp: '2026-09-27T01:00:00Z', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }) +
    line({ type: 'assistant', uuid: 'a1', timestamp: '2026-09-27T01:00:01Z', message: { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '想一想' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }) +
    line({ type: 'user', uuid: 't1', timestamp: '2026-09-27T01:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }));
  const file = store.transcriptFor(store.listSessions().find((s) => s.title === '00 总纲'));
  assert.equal(file, transcript);
  const first = d.readTranscript(file);
  assert.deepEqual(first.items.map((i) => i.type), ['userMessage', 'reasoning', 'commandExecution']);
  assert.equal(first.items[2].text, 'ls');
  assert.equal(first.lastStopReason, 'tool_use');
  fs.appendFileSync(transcript, line({ type: 'assistant', uuid: 'a2', timestamp: '2026-09-27T01:00:03Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] } }) + '{"type":"assist');
  const next = d.readTranscript(file, first.offset, first.lineCount);
  assert.deepEqual(next.items.map((i) => [i.id, i.type, i.text]), [['a2:0', 'agentMessage', '完成']], 'partial trailing line is left for later');
  assert.ok(next.items[0].order > first.items[2].order);
  assert.equal(next.lastStopReason, 'end_turn');
});

test('registerSession writes a desktop session file for a phone-created session', () => {
  const { store, account } = desktopFixture();
  const id = store.registerSession({ cliSessionId: '44444444-4444-4444-8444-444444444444', cwd: 'D:\\work', title: '手机任务', model: 'haiku', effort: 'low', approveMode: 'acceptEdits' });
  const meta = JSON.parse(fs.readFileSync(path.join(account, `${id}.json`), 'utf8'));
  assert.match(id, /^local_[0-9a-f-]{36}$/);
  assert.deepEqual([meta.cliSessionId, meta.title, meta.permissionMode, meta.isArchived], ['44444444-4444-4444-8444-444444444444', '手机任务', 'acceptEdits', false]);
  assert.ok(store.listSessions().some((s) => s.desktopId === id));
});

test('model labels and pretty ids match the desktop wording', () => {
  assert.equal(d.modelLabel({ value: 'default', description: 'Opus 5.5 with 1M context · Best for everyday' }), '默认 · Opus 5.5 (1M)');
  assert.equal(d.modelLabel({ value: 'sonnet', description: 'Sonnet 5 · Efficient' }), 'Sonnet 5');
  assert.equal(d.prettyModelId('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(d.prettyModelId('claude-fable-5-1'), 'Fable 5.1');
});

function syncConnector(fixture) {
  const connector = Object.create(Connector.prototype);
  connector.config = { workspace: 'C:\\work', accountKey: Buffer.alloc(32, 5) };
  connector.claudeThreads = new Map(); connector.saveClaudeThreads = () => {}; connector.log = () => {};
  connector.threadState = new Map(); connector.backends = new Map(); connector.defaultBackendId = 'codex';
  connector.claudeDesktop = fixture.store; connector.claude = { id: 'claude', on() {}, isRunning: () => false };
  const requests = []; const frames = [];
  connector.api = { path: (p) => p, request: async (p, opts) => { requests.push({ p, ...opts }); return {}; } };
  connector.emit = (kind, threadId, payload) => frames.push({ kind, threadId, payload });
  return { connector, requests, frames };
}

test('opening pre-upgrade next-step history repairs status, encrypted card and plain replies without duplication', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, requests, frames } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  const now = new Date().toISOString();
  const nextStep = { recap: '想了两个周末安排。', ask: '你想怎么安排？', actions: [{ label: '公园', message: '下午去公园吧。' }], blocked: true };
  fs.writeFileSync(fixture.transcript,
    line({ type: 'assistant', uuid: 'wrap', timestamp: now, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'box', name: 'mcp__ccd_turn__wrap_up', input: nextStep }] } }) +
    line({ type: 'user', uuid: 'result', timestamp: now, message: { content: [{ type: 'tool_result', tool_use_id: 'box', content: 'Shown in the next-step box.' }] } }));
  connector.setClaudeThreadFields(id, { transcriptFile: fixture.transcript, transcriptOffset: fs.statSync(fixture.transcript).size,
    transcriptLines: 2, transcriptSchema: 5, transcriptTerminalStatus: null, transcriptLastEvent: 'user', transcriptLastEventAt: Date.now() });
  assert.equal(connector.claudeDesktopBusy(id), true);
  requests.length = 0; frames.length = 0;
  await connector.syncClaudeTranscript(id, { watch: true });
  assert.equal(connector.claudeDesktopBusy(id), false);
  assert.equal(connector.claudeThreads.get(id).transcriptSchema, 11);
  assert.ok(frames.some(f => f.kind === 'history.updated' && f.payload.fullHistory));
  assert.ok(frames.some(f => f.kind === 'thread.status' && f.payload.status === 'completed'));
  const item = requests.find(r => r.p.endsWith('/items')).body.items[0];
  const decoded = require('../src/crypto').decryptJson(connector.config.accountKey, { ...item, kind: 'history.item', threadId: id });
  assert.deepEqual(decoded.nextStep, nextStep); assert.equal(decoded.type, 'claudeWrapUp'); assert.equal(item.id, 'wrap:0');
  requests.length = 0;
  frames.length = 0;
  await connector.syncClaudeTranscript(id, { watch: true });
  assert.ok(!requests.some(r => r.p.endsWith('/items')), 'already upgraded history is not re-uploaded');
  assert.ok(frames.some(f => f.kind === 'thread.status' && f.payload.status === 'completed'), 'opening repairs an old phone status even without a new transcript event');
  const sent = [];
  connector._claudeLive = { at: Date.now() + 60_000, ids: new Set(['11111111-1111-4111-8111-111111111111']) };
  connector.runDesktopSend = async (desktopId, text) => { sent.push(text); return { ok: true }; };
  const reply = '我更想去湖边走走，下午出门。';
  await connector.command({ action: 'followup.enqueue', requestId: 'natural-reply', args: { threadId: id, text: reply } });
  assert.deepEqual(sent, [reply], 'even a phone with stale running status can send its queued reply immediately');
});

test('findDesktopClaudeBin resolves both desktop bundle layouts and prefers verified hashes', () => {
  const root = tmp(); const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const old = path.join(root, '2.1.286'); fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, executable), 'old');
  const current = path.join(root, '2.1.288');
  const unverified = path.join(current, 'aaaaaaaaaaaaaaaa'); fs.mkdirSync(unverified, { recursive: true });
  fs.writeFileSync(path.join(unverified, executable), 'unverified');
  const verified = path.join(current, '36aa8c97bf86'); fs.mkdirSync(verified, { recursive: true });
  fs.writeFileSync(path.join(verified, '.verified'), 'verified');
  fs.writeFileSync(path.join(verified, executable), 'current');
  const found = d.findDesktopClaudeBin(root);
  assert.equal(found.version, '2.1.288');
  assert.equal(found.bin, path.join(verified, executable));
});

test('findDesktopClaudeBin falls back to a direct executable from an older bundle', () => {
  const root = tmp(); const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const version = path.join(root, '2.1.281'); fs.mkdirSync(version, { recursive: true });
  fs.writeFileSync(path.join(version, executable), 'old');
  assert.deepEqual(d.findDesktopClaudeBin(root), { bin: path.join(version, executable), version: '2.1.281' });
});

test('desktop shutdown, an empty source and a partial metadata write preserve the phone history index', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  const file = path.join(fixture.account, `${id}.json`); const valid = fs.readFileSync(file);
  connector._claudeLive = { at: Date.now() + 60_000, ids: Object.assign(new Set(), { appRunning: true }) };
  fs.writeFileSync(file, '{'); fixture.store.metaCache.clear();
  await connector.syncClaudeDesktopSessions();
  assert.equal(fixture.store.sessionScanComplete, false);
  assert.equal(connector.claudeThreads.get(id).archived, false, 'partial writes are not deletions');
  assert.equal(connector.claudeThreads.get(id).pinned, true);
  fs.writeFileSync(file, valid);
  const base = path.join(fixture.root, 'claude-code-sessions'); const moved = path.join(fixture.root, 'temporarily-moved');
  fs.renameSync(base, moved);
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreads.get(id).archived, false, 'missing data root during migration is not a deletion');
  fs.mkdirSync(base);
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreads.get(id).archived, false, 'an empty root during reopen is not a deletion');
  fs.rmdirSync(base); fs.renameSync(moved, base);
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreads.get(id).pinned, true);
});

test('missing desktop rows require a stable scan with the app open, while explicit archives apply immediately', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  fs.unlinkSync(path.join(fixture.account, `${id}.json`));
  connector._claudeLive = { at: Date.now() + 60_000, ids: new Set() };
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreads.get(id).archived, false, 'closed Desktop cannot confirm deletion');
  connector._claudeLive.ids.appRunning = true;
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreads.get(id).archived, false, 'one missing scan is insufficient');
  connector._claudeMissingSessions.set(id, Date.now() - 31_000);
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreads.get(id).archived, true);
  const other = 'local_00000000-0000-4000-8000-000000000002';
  const file = path.join(fixture.account, `${other}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), isArchived: true })); fixture.store.metaCache.clear();
  connector._claudeLive.ids.appRunning = false;
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreads.get(other).archived, true, 'the actual archive field is authoritative');
});

test('a migrated source restores a wrongly archived session under its existing phone id', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, requests } = syncConnector(fixture);
  const native = fixture.store.readSessions()[0];
  connector.claudeThreads.set('existing-phone-id', { id: 'existing-phone-id', origin: 'desktop', sessionId: native.cliSessionId,
    archived: true, pinned: false, pinOrder: -1, transcriptOffset: 123, transcriptSchema: 6 });
  const missing = path.join(fixture.root, 'retired');
  fixture.store.root = missing; fixture.store.findRoot = () => fixture.root;
  await connector.syncClaudeDesktopSessions();
  const restored = connector.claudeThreads.get('existing-phone-id');
  assert.equal(fixture.store.root, fixture.root);
  assert.equal(restored.archived, false); assert.equal(restored.pinned, true);
  assert.equal(restored.transcriptOffset, 123, 'history cursor is retained');
  assert.equal(connector.claudeThreads.has(native.desktopId), false, 'no duplicate phone thread is created');
  assert.ok(requests.some(r => r.body?.id === 'existing-phone-id' && r.body.archived === false));
});

test('desktop sessions appear in the phone index with the sidebar pin order', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, requests } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const index = requests.filter((r) => r.p === '/history/threads');
  assert.equal(index.length, 3);
  const meta = connector.claudeThreads.get('local_00000000-0000-4000-8000-000000000002');
  assert.deepEqual([meta.origin, meta.pinned, meta.pinOrder, meta.sessionId], ['desktop', true, 0, '22222222-2222-4222-8222-222222222222']);
  assert.equal(connector.threadBackendId('local_00000000-0000-4000-8000-000000000001'), 'claude');
  requests.length = 0;
  await connector.syncClaudeDesktopSessions();
  assert.equal(requests.filter((r) => r.p === '/history/threads').length, 0, 'unchanged sessions are not re-uploaded');
});

test('presence carries the desktop pin order; a deleted pinned session is unpinned on the newest index page', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, requests } = syncConnector(fixture);
  connector.config.deviceId = 'pc-1'; connector.activeThreadSnapshot = () => [];
  assert.equal(connector.presencePayload(1).claudePins, null, 'no snapshot before the first desktop scan');
  // A session deleted in the app earlier, still cached as archived but pinned.
  connector.claudeThreads.set('local_gone', { id: 'local_gone', origin: 'desktop', title: '10 旧会话', archived: true, pinned: true, pinOrder: 0, updatedAt: 1000 });
  await connector.syncClaudeDesktopSessions();
  assert.deepEqual(connector.presencePayload(1).claudePins,
    { connectorId: 'pc-1', ids: ['local_00000000-0000-4000-8000-000000000002', 'local_00000000-0000-4000-8000-000000000001'] });
  const gone = connector.claudeThreads.get('local_gone');
  assert.deepEqual([gone.archived, gone.pinned, gone.pinOrder], [true, false, -1]);
  const row = requests.find((r) => r.p === '/history/threads' && r.body.id === 'local_gone');
  assert.ok(row.body.archived && row.body.updatedAt > 1000, 'moved onto the newest page so a normal refresh sees it');
  assert.equal(gone.updatedAt, 1000, 'real activity time is kept');

  // Reordering on the desktop re-uploads both rows onto the newest page.
  const ldb = path.join(fixture.root, 'Local Storage', 'leveldb');
  const key = Buffer.from('_https://claude.ai\u0000\u0001dframe-store', 'latin1');
  const swapped = Buffer.concat([Buffer.from([1]), Buffer.from('{"state":{"pinnedOrder":["code:local_00000000-0000-4000-8000-000000000001","code:local_00000000-0000-4000-8000-000000000002"]}}', 'latin1')]);
  fs.appendFileSync(path.join(ldb, '000003.log'), logRecord(12, key, swapped));
  requests.length = 0;
  const before = Date.now();
  await connector.syncClaudeDesktopSessions();
  const rows = requests.filter((r) => r.p === '/history/threads');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.body.updatedAt >= before));
  assert.deepEqual(connector.presencePayload(1).claudePins.ids, ['local_00000000-0000-4000-8000-000000000001', 'local_00000000-0000-4000-8000-000000000002']);
});

test('opening a desktop thread syncs its transcript; a phone-created twin is not duplicated', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, requests, frames } = syncConnector(fixture);
  fs.writeFileSync(fixture.transcript, line({ type: 'user', uuid: 'u1', timestamp: '2026-09-27T01:00:00Z', message: { content: '你好' } }) + line({ type: 'assistant', uuid: 'a1', timestamp: '2026-09-27T01:00:01Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '在' }] } }));
  // A phone-created thread already owns session 1111…: it keeps its own id.
  connector.claudeThreads.set('phone-1', { id: 'phone-1', origin: 'phone', sessionId: '11111111-1111-4111-8111-111111111111', workdir: 'C:\\proj\\a', title: '手机建的' });
  await connector.syncClaudeDesktopSessions();
  assert.ok(!connector.claudeThreads.has('local_00000000-0000-4000-8000-000000000001'));
  assert.equal(connector.claudeThreads.get('phone-1').pinned, true);
  const res = await connector.executeClaudeCommand('history.sync', { threadId: 'phone-1' });
  assert.equal(res.items, 2);
  const put = requests.find((r) => r.p === '/history/threads/phone-1/items');
  assert.deepEqual(put.body.items.map((i) => i.id), ['u1:0', 'a1:0']);
  assert.ok(!JSON.stringify(put).includes('你好'), 'history stays end-to-end encrypted');
  assert.ok(frames.some((f) => f.kind === 'history.updated' && f.threadId === 'phone-1'));
  requests.length = 0;
  await connector.syncClaudeTranscript('phone-1');
  assert.equal(requests.length, 0, 'no new lines, nothing uploaded');
});

test('a message to a session the desktop holds open is typed into the desktop, not resumed separately', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, frames } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const sent = [];
  connector._claudeLive = { at: Date.now(), ids: new Set(['22222222-2222-4222-8222-222222222222']) };
  connector.runDesktopSend = async (desktopId, text, restoreId) => { sent.push({ desktopId, text, restoreId }); return { ok: true }; };
  connector.claude.startTurn = () => { throw new Error('must not spawn a second claude for a desktop-held session'); };
  const result = await connector.executeClaudeCommand('turn.start', { threadId: 'local_00000000-0000-4000-8000-000000000002', text: '继续' });
  assert.equal(result.deliveredTo, 'desktop');
  assert.deepEqual(sent, [{ desktopId: 'local_00000000-0000-4000-8000-000000000002', text: '继续', restoreId: '' }], 'already focused, nothing to switch back to');
  assert.ok(frames.some((f) => f.kind === 'thread.status' && f.payload.status === 'desktop_running'));
  // A desktop draft is protected.
  connector.runDesktopSend = async () => ({ ok: false, reason: 'desktop_draft_present' });
  await assert.rejects(connector.executeClaudeCommand('turn.start', { threadId: 'local_00000000-0000-4000-8000-000000000002', text: 'x' }), /草稿/);
  // Images are pasted into the desktop composer; other files are referenced by path.
  const png = path.join(fixture.root, 'shot.png'); fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]));
  const txt = path.join(fixture.root, 'notes.txt'); fs.writeFileSync(txt, 'hello');
  connector.resolveAttachments = (id, list) => list;
  const calls = [];
  connector.runDesktopSend = async (desktopId, text, restoreId, options) => { calls.push({ text, options }); return { ok: true }; };
  await connector.executeClaudeCommand('turn.start', { threadId: 'local_00000000-0000-4000-8000-000000000002', text: '看图', attachments: [{ path: png, name: 'shot.png' }, { path: txt, name: 'notes.txt' }] });
  assert.deepEqual(calls[0].options.imagePaths, [png]);
  assert.match(calls[0].text, /看图[\s\S]*notes\.txt[\s\S]*路径：/);
});

test('a new phone task uses the authenticated Claude Desktop deep link and links its new session', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, frames } = syncConnector(fixture);
  const originalSessions = fixture.store.listSessions.bind(fixture.store);
  const created = {
    desktopId: 'local_00000000-0000-4000-8000-000000000099',
    cliSessionId: '99999999-9999-4999-8999-999999999999',
    cwd: 'C:\\work', title: '手机新任务', model: 'claude-opus-5-5', effort: 'medium',
    approveMode: 'bypassPermissions', archived: false, pinned: false, pinOrder: -1,
    createdAt: Date.now(), updatedAt: Date.now(), focusedAt: Date.now(),
  };
  let sessions = originalSessions();
  fixture.store.available = () => true;
  fixture.store.listSessions = () => sessions;
  fixture.store.focusedSessionId = () => 'local_00000000-0000-4000-8000-000000000002';
  connector.claudeLiveSnapshot = async () => { const live = new Set(); live.appRunning = true; return live; };
  connector.execFileFn = (_bin, _args, _opts, cb) => { sessions = [...sessions, created]; cb(null, '{"ok":true}\n'); };
  connector.scheduleClaudeTranscriptSync = () => {};
  connector.claudeThreads.set('phone-new', { id: 'phone-new', origin: 'phone', title: '手机新任务', workdir: 'C:\\work' });
  const result = await connector.startClaudeDesktopNewSession('phone-new', { text: '只回复 OK', cwd: 'C:\\work' });
  assert.equal(result.deliveredTo, 'desktop');
  assert.equal(result.sessionId, created.cliSessionId);
  const meta = connector.claudeThreads.get('phone-new');
  assert.deepEqual([meta.desktopId, meta.sessionId, meta.desktopLive, meta.transcriptWatched], [created.desktopId, created.cliSessionId, true, true]);
  assert.ok(frames.some((frame) => frame.kind === 'thread.status' && frame.threadId === 'phone-new' && frame.payload.status === 'desktop_running'));
});

test('new tasks answer the desktop trust prompt automatically; a dialog for another folder falls back to the phone', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  fixture.store.available = () => true;
  fixture.store.focusedSessionId = () => 'local_00000000-0000-4000-8000-000000000002';
  connector.claudeLiveSnapshot = async () => { const live = new Set(); live.appRunning = true; return live; };
  connector.claudeThreads.set('phone-trust', { id: 'phone-trust', origin: 'phone', title: '待确认', workdir: 'C:\work' });
  const calls = [];
  const created = {
    desktopId: 'local_00000000-0000-4000-8000-000000000098',
    cliSessionId: '98999999-9999-4999-8999-999999999999',
    cwd: 'C:\work', title: '待确认', createdAt: Date.now(), updatedAt: Date.now(), focusedAt: Date.now(),
    model: 'sonnet', effort: 'medium', approveMode: 'default', archived: false, pinned: false, pinOrder: -1,
  };
  let sessions = fixture.store.listSessions();
  fixture.store.listSessions = () => sessions;
  let dialogMatches = true;
  connector.execFileFn = (_bin, args, _opts, cb) => {
    calls.push(args);
    // The script answers the prompt only when it names the requested folder.
    if (!args.includes('-ConfirmTrust') || !dialogMatches) return cb(null, JSON.stringify({ ok: false, reason: 'trust_required', detail: { folder: 'C:\work' } }));
    sessions = [...sessions, created];
    cb(null, JSON.stringify({ ok: true }));
  };
  connector.scheduleClaudeTranscriptSync = () => {};
  const sent = await connector.startClaudeDesktopNewSession('phone-trust', { text: '只回复 OK', cwd: 'C:\work' });
  assert.equal(sent.deliveredTo, 'desktop');
  assert.ok(calls[0].includes('-ConfirmTrust'), 'every new task is approved automatically');

  dialogMatches = false;
  connector.claudeThreads.set('phone-other', { id: 'phone-other', origin: 'phone', title: '另一个', workdir: 'C:\work' });
  const paused = await connector.startClaudeDesktopNewSession('phone-other', { text: '只回复 OK', cwd: 'C:\work' });
  assert.deepEqual(paused, { requiresConfirmation: { kind: 'workspaceTrust', folder: 'C:\work' } });
  assert.ok(connector.pendingClaudeWorkspaceTrust.has('phone-other'));
  const cancelled = connector.cancelClaudeWorkspaceTrust('phone-other');
  assert.equal(cancelled.cancelled, true);
});

test('phone model / effort for a desktop-run session are switched there with slash commands', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  fixture.store.focusedSessionId = () => 'local_00000000-0000-4000-8000-000000000002';
  const id = 'local_00000000-0000-4000-8000-000000000001';
  connector.claudeThreads.set(id, { id, desktopId: id, sessionId: 's1', model: 'claude-opus-5-5', effort: 'medium' });
  const sent = [];
  connector.runDesktopSend = async (desktopId, text, restoreId) => { sent.push({ desktopId, text, restoreId }); return { ok: true }; };
  connector.claudeDesktopBusy = () => false;
  const idle = await connector.setClaudeDesktopSettings(id, { model: 'sonnet', effort: 'low' });
  assert.deepEqual(idle, { applied: true, pending: false });
  assert.deepEqual(sent.map((item) => item.text), ['/model sonnet', '/effort low']);
  assert.equal(sent[0].restoreId, 'local_00000000-0000-4000-8000-000000000002');
  const meta = connector.claudeThreads.get(id);
  assert.deepEqual([meta.model, meta.effort, meta.pendingDesktopSettings], ['sonnet', 'low', null]);

  // While a turn runs the change waits and goes out right before the next message.
  sent.length = 0;
  connector.claudeDesktopBusy = () => true;
  const busy = await connector.setClaudeDesktopSettings(id, { effort: '' });
  assert.deepEqual(busy, { applied: false, pending: true });
  assert.equal(sent.length, 0);
  assert.equal(connector.claudeSettingsResult(id).effort, '', 'the phone sees its pending choice');
  connector.desktopShouldTakeClaudeSession = async () => true;
  connector.claudeAttachmentParts = (args) => ({ text: args.text, imagePaths: [] });
  connector.scheduleClaudeTranscriptSync = () => {};
  await connector.deliverClaudeToDesktop(id, { text: '继续' });
  assert.deepEqual(sent.map((item) => item.text), ['/effort auto', '继续']);
  assert.throws(() => connector.claudeDesktopSettingCommands({ model: 'sonnet\n/clear' }), /模型名称无效/);
  assert.throws(() => connector.claudeDesktopSettingCommands({ effort: 'turbo' }), /思考强度无效/);
});

test('phone permission mode for a desktop-run session is picked from the desktop mode menu', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, frames } = syncConnector(fixture);
  fixture.store.focusedSessionId = () => 'local_00000000-0000-4000-8000-000000000002';
  const id = 'local_00000000-0000-4000-8000-000000000001';
  connector.claudeThreads.set(id, { id, desktopId: id, sessionId: 's1', model: 'claude-opus-5-5', effort: 'medium', approveMode: 'auto' });
  connector.ensureClaudeSession = () => {};
  connector.desktopShouldTakeClaudeSession = async () => true;
  const sent = [];
  let reply = { ok: true };
  connector.runDesktopSend = async (desktopId, text, restoreId, options) => { sent.push({ desktopId, text, restoreId, mode: options?.mode }); return reply; };
  const result = await connector.executeClaudeCommand('settings.set', { threadId: id, settings: { permissionMode: 'acceptEdits', model: 'claude-opus-5-5', effort: 'medium' } });
  assert.deepEqual(sent, [{ desktopId: id, text: 'Accept edits', restoreId: 'local_00000000-0000-4000-8000-000000000002', mode: 'permission' }]);
  assert.equal(result.permissionMode, 'acceptEdits');
  assert.equal(connector.claudeThreads.get(id).approveMode, 'acceptEdits');
  assert.ok(frames.some((f) => f.kind === 'thread.settings' && f.payload.settings.permissionMode === 'acceptEdits'));

  // The same mode again does nothing on the desktop; legacy values map.
  sent.length = 0;
  await connector.executeClaudeCommand('settings.set', { threadId: id, settings: { permissionMode: 'acceptEdits' } });
  await connector.executeClaudeCommand('settings.set', { threadId: id, settings: { permissionMode: 'yolo' } });
  assert.deepEqual(sent.map((s) => s.text), ['Bypass permissions']);

  // A mode the desktop refused keeps the old one, and the phone is told why.
  reply = { ok: false, reason: 'mode_not_applied' };
  const refused = await connector.executeClaudeCommand('settings.set', { threadId: id, settings: { permissionMode: 'default' } });
  assert.match(refused.failed.permissionMode, /没有接受这个权限模式/);
  assert.match(refused.reason, /^权限模式没有切换成功/);
  assert.equal(connector.claudeThreads.get(id).approveMode, 'bypassPermissions');
});

// Each part of a desktop settings change is applied on its own, and the phone
// is told which part did not change.
function desktopRunSession(connector, id) {
  connector.claudeThreads.set(id, { id, desktopId: id, sessionId: 's1', model: 'claude-opus-5-5', effort: 'medium', approveMode: 'auto' });
  connector.ensureClaudeSession = () => {};
  connector.desktopShouldTakeClaudeSession = async () => true;
}

test('a permission mode the desktop refuses does not stop the model and effort, and the phone is told which part failed', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, frames } = syncConnector(fixture);
  fixture.store.focusedSessionId = () => 'local_00000000-0000-4000-8000-000000000002';
  const id = 'local_00000000-0000-4000-8000-000000000001';
  desktopRunSession(connector, id);
  const logged = []; connector.log = (error) => logged.push(String(error?.message ?? error));
  const sent = [];
  connector.runDesktopSend = async (desktopId, text, restoreId, options) => {
    sent.push(text);
    if (options?.mode === 'permission') return { ok: false, reason: 'mode_option_not_found: Auto | Manual' };
    return { ok: true };
  };
  const result = await connector.executeClaudeCommand('settings.set', { threadId: id, settings: { permissionMode: 'acceptEdits', model: 'sonnet', effort: 'high' } });
  assert.deepEqual(sent, ['Accept edits', '/model sonnet', '/effort high']);
  assert.equal(result.model, 'sonnet');
  assert.equal(result.effort, 'high');
  assert.equal(result.failed.permissionMode, '电脑端的权限模式菜单里没有这个选项，权限模式没有改。');
  assert.equal(result.failed.model, undefined);
  assert.match(result.reason, /^权限模式没有切换成功：电脑端的权限模式菜单里没有这个选项/);
  assert.ok(logged.some((message) => message.includes('Auto | Manual')), 'the options the menu showed are logged');
  assert.ok(frames.some((f) => f.kind === 'thread.settings' && f.payload.settings.model === 'sonnet'));
});

test('a busy desktop keeps the model and effort for the next message and says so in Chinese', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  const id = 'local_00000000-0000-4000-8000-000000000001';
  desktopRunSession(connector, id);
  const sent = [];
  connector.runDesktopSend = async (desktopId, text) => { sent.push(text); return { ok: true }; };
  connector.claudeDesktopBusy = () => true;
  const result = await connector.executeClaudeCommand('settings.set', { threadId: id, settings: { model: 'sonnet', effort: 'high' } });
  assert.deepEqual(sent, []);
  assert.equal(result.pending, true);
  assert.equal(result.pendingDesktop, true);
  assert.equal(result.failed, undefined);
  assert.equal(result.reason, '电脑上正在运行，模型和强度会在下一条消息发出前切换');
});

test('a failed model and effort change is named together once', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  const id = 'local_00000000-0000-4000-8000-000000000001';
  desktopRunSession(connector, id);
  connector.runDesktopSend = async () => ({ ok: false, reason: 'composer_not_found' });
  const result = await connector.executeClaudeCommand('settings.set', { threadId: id, settings: { model: 'sonnet', effort: 'high' } });
  assert.deepEqual(Object.keys(result.failed), ['model', 'effort']);
  assert.equal(result.reason, `模型和思考强度没有切换成功：${result.failed.model}`);
  assert.match(result.failed.model, /没能在电脑端 Claude 窗口里找到输入框/);
});

test('desktop turn completion is detected from end_turn in the transcript', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, frames } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  connector.setClaudeThreadFields(id, { desktopTurnSince: Date.parse('2026-09-27T01:00:00Z') });
  fs.writeFileSync(fixture.transcript, line({ type: 'assistant', uuid: 'a9', timestamp: '2026-09-27T01:05:00Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '好了' }] } }));
  await connector.syncClaudeTranscript(id);
  assert.ok(frames.some((f) => f.kind === 'thread.status' && f.threadId === id && f.payload.status === 'completed'));
  assert.equal(connector.claudeThreads.get(id).desktopTurnSince, null);
});

test('an already consumed desktop transcript restores a missing stop marker without replaying history or queues', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, requests, frames } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(fixture.transcript,
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-27T01:00:00Z', content: 'old queued message' }) +
    line({ type: 'user', uuid: 'stop-1', timestamp: '2026-09-27T01:00:01Z', message: { content: '[Request interrupted by user]' } }));
  connector.setClaudeThreadFields(id, {
    transcriptFile: fixture.transcript, transcriptWatched: true,
    transcriptOffset: fs.statSync(fixture.transcript).size, transcriptLines: 2,
    transcriptLastEvent: 'end_turn', transcriptTerminalStatus: undefined,
  });
  requests.length = 0; frames.length = 0;
  const result = await connector.syncClaudeTranscript(id);
  assert.equal(result.items, 0);
  assert.equal(connector.claudeThreadStatus(id), 'interrupted');
  assert.equal(connector.claudeThreads.get(id).transcriptTerminalStatus, 'interrupted');
  assert.equal(connector.claudeQueueItems(id).length, 0, 'old queue operations are not replayed');
  assert.ok(frames.some((f) => f.kind === 'thread.status' && f.payload.status === 'interrupted'));
  assert.ok(requests.some((r) => r.p === '/history/threads'), 'the corrected state also reaches the index');
  assert.ok(!requests.some((r) => /\/items$/.test(r.p)), 'consumed history is not uploaded again');
  assert.ok(!frames.some((f) => f.kind === 'history.updated' || f.kind === 'followup.queued'));
  requests.length = 0; frames.length = 0;
  await connector.syncClaudeTranscript(id);
  assert.equal(requests.length, 0, 'the migration runs once');
  assert.equal(frames.length, 0);
});

test('the desktop queue is mirrored from transcript queue-operations', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, frames } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  const now = new Date().toISOString();
  fs.writeFileSync(fixture.transcript,
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: now, content: '先做 A' }) +
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: now, content: '<task-notification>x</task-notification>' }) +
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: now, content: '再做 B' }) +
    line({ type: 'queue-operation', operation: 'dequeue', timestamp: now }));
  await connector.syncClaudeTranscript(id, { watch: true });
  const shown = connector.claudeQueueItems(id).map((i) => [i.text, i.origin, i.state]);
  assert.deepEqual(shown, [['再做 B', 'desktop', 'desktop_queued']], 'A started, notification hidden, B waiting');
  const queuedB = frames.find((f) => f.kind === 'followup.queued' && f.payload.text === '再做 B');
  assert.ok(queuedB);
  fs.appendFileSync(fixture.transcript, line({ type: 'queue-operation', operation: 'remove', timestamp: now, content: '再做 B', reason: 'absorbed_mid_turn' }));
  await connector.syncClaudeTranscript(id);
  assert.equal(connector.claudeQueueItems(id).length, 0);
  assert.ok(frames.some((f) => f.kind === 'followup.cancelled' && f.payload.id === queuedB.payload.id));
});

test('a consumed legacy desktop queue is repaired without uploading or resending history', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, requests, frames } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  const at = '2026-10-15T01:00:00Z';
  fs.writeFileSync(fixture.transcript,
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content: '<task-notification>old</task-notification>' }) +
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content: '已经收到的测试消息' }) +
    line({ type: 'queue-operation', operation: 'dequeue', timestamp: at }) +
    line({ type: 'user', uuid: 'received', timestamp: at, message: { content: '已经收到的测试消息' } }));
  connector.setClaudeThreadFields(id, { transcriptFile: fixture.transcript, transcriptOffset: fs.statSync(fixture.transcript).size, transcriptLines: 4,
    transcriptWatched: true, transcriptTerminalStatus: null, desktopQueue: [{ id: 'old-queue', text: '已经收到的测试消息', state: 'desktop_queued', createdAt: Date.parse(at) }] });
  requests.length = 0; frames.length = 0;
  await connector.syncClaudeTranscript(id);
  assert.equal(connector.claudeQueueItems(id).length, 0);
  assert.equal(connector.claudeThreads.get(id).desktopQueueSchema, 2);
  assert.ok(frames.some(f => f.kind === 'followup.cancelled' && f.payload.id === 'old-queue'));
  assert.ok(!frames.some(f => f.kind === 'followup.queued' || f.kind === 'history.updated'));
  assert.ok(!requests.some(r => /\/items$/.test(r.p)));
});

test('a full replay of an empty transcript clears an obsolete desktop queue', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(fixture.transcript, '');
  connector.setClaudeThreadFields(id, { desktopQueue: [{ id: 'stale', text: 'old', state: 'desktop_queued' }] });
  await connector.syncClaudeTranscript(id);
  assert.equal(connector.claudeQueueItems(id).length, 0);
});

test('while the desktop is mid-turn a queued phone message waits, then goes out when the turn ends', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(fixture.transcript, line({ type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 60' } }] } }));
  await connector.syncClaudeTranscript(id, { watch: true });
  assert.equal(connector.claudeDesktopBusy(id), true);
  const sent = [];
  connector._claudeLive = { at: Date.now() + 60_000, ids: new Set(['11111111-1111-4111-8111-111111111111']) };
  connector.runDesktopSend = async (desktopId, text) => { sent.push(text); return { ok: true }; };
  const queued = await connector.command({ action: 'followup.enqueue', requestId: 'q1', args: { threadId: id, text: '跑完再看日志' } });
  assert.equal(queued.queued, true);
  assert.deepEqual(sent, [], 'not typed into the desktop while it is busy');
  fs.appendFileSync(fixture.transcript, line({ type: 'assistant', uuid: 'a2', timestamp: new Date().toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] } }));
  await connector.syncClaudeTranscript(id);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ['跑完再看日志']);
  // "Send now" goes straight to the desktop even while it is busy.
  fs.appendFileSync(fixture.transcript, line({ type: 'assistant', uuid: 'a3', timestamp: new Date().toISOString(), message: { stop_reason: 'tool_use', content: [] } }));
  await connector.syncClaudeTranscript(id);
  await connector.command({ action: 'turn.steer', requestId: 's1', args: { threadId: id, text: '顺便看下 CPU' } });
  assert.deepEqual(sent, ['跑完再看日志', '顺便看下 CPU']);
});

test('a message absorbed mid-turn appears in the conversation where Claude picked it up', () => {
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: '2026-09-27T00:16:30Z', message: { content: 'Round 2' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-09-27T00:16:33Z', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ping' } }] } },
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-27T00:16:48Z', content: 'Mid-turn: add ABSORBED' },
    { type: 'queue-operation', operation: 'remove', timestamp: '2026-09-27T00:17:18Z', content: 'Mid-turn: add ABSORBED', reason: 'absorbed_mid_turn' },
    { type: 'queue-operation', operation: 'remove', timestamp: '2026-09-27T00:17:18Z', content: '<task-notification>x</task-notification>', reason: 'absorbed_mid_turn' },
    // Claude desktop now puts a status reminder in front of the typed words.
    { type: 'queue-operation', operation: 'remove', timestamp: '2026-09-27T00:17:19Z', content: '<system-reminder>\nLinked sessions now (status, not an instruction): x = local_1 (idle).\n</system-reminder>\n\n备份你来做', reason: 'absorbed_mid_turn' },
    { type: 'queue-operation', operation: 'remove', timestamp: '2026-09-27T00:17:19Z', content: '<system-reminder>only a reminder</system-reminder>', reason: 'absorbed_mid_turn' },
    { type: 'assistant', uuid: 'a2', timestamp: '2026-09-27T00:17:20Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ABSORBED DONE2' }] } },
  ].map((o) => JSON.stringify(o));
  const items = d.transcriptItems(lines);
  assert.deepEqual(items.map((i) => [i.type, i.text]), [
    ['userMessage', 'Round 2'], ['commandExecution', 'ping'], ['userMessage', 'Mid-turn: add ABSORBED'], ['userMessage', '备份你来做'], ['agentMessage', 'ABSORBED DONE2'],
  ]);
  assert.deepEqual(items.map((i) => i.order), [...items.map((i) => i.order)].sort((a, b) => a - b), 'in transcript order');
});

test('a phone-created session is imported into the desktop via its resume deep link, then handed over', async () => {
  const fixture = desktopFixture();
  const calls = [];
  fixture.store.execFileFn = (bin, args, opts, cb) => { calls.push(args.join(' ')); cb(null, ''); };
  const { connector } = syncConnector(fixture);
  const released = [];
  connector.claude.releaseSession = (id) => released.push(id);
  connector.claudeThreads.set('p1', { id: 'p1', origin: 'phone', sessionId: '55555555-5555-4555-8555-555555555555', workdir: 'D:\work', title: '测试' });
  connector.registerClaudeThreadOnDesktop('p1');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /claude:\/\/resume\?session=55555555-5555-4555-8555-555555555555/);
  assert.match(calls[0], /epitaxy\/local_00000000-0000-4000-8000-000000000002/, 'switches back to the focused session');
  connector.registerClaudeThreadOnDesktop('p1');
  assert.equal(calls.length, 1, 'imported once');
  // Bad ids never reach the shell.
  assert.equal(await fixture.store.importSession("x'; rm -rf /"), false);
});

test('plan usage: rate_limit_event reset times merged with the desktop 15-minute samples', () => {
  const fixture = desktopFixture(); const { connector, frames } = syncConnector(fixture);
  connector.isConnected = () => true;
  connector.config.configFile = path.join(fixture.root, 'config.json');
  const now = Date.parse('2026-09-27T08:30:00Z');
  connector._claudeCliOrg = 'org'; // the command line uses the desktop's organisation
  connector.onClaudeRateLimit({ status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 0.35, resetsAt: Date.parse('2026-09-27T10:00:00Z') / 1000 },
    seven_day: { utilization: 0.16, resetsAt: Date.parse('2026-10-01T15:00:00Z') / 1000 },
  } }, Date.parse('2026-09-27T08:20:00Z'));
  let state = connector.claudeUsageState(now);
  assert.equal(state.fiveHour.remainingPercent, 65);
  assert.equal(state.fiveHour.resetsAt, Date.parse('2026-09-27T10:00:00Z'));
  assert.equal(state.sevenDay.remainingPercent, 84);
  assert.ok(frames.some((f) => f.kind === 'claude.usage'));
  // A newer desktop sample updates the percentages but keeps the reset times.
  fs.writeFileSync(path.join(fixture.root, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples: [{ t: Date.parse('2026-09-27T08:29:00Z'), org: 'org', u: { fh: 40, sd: 17 } }] }));
  state = connector.claudeUsageState(now);
  assert.deepEqual([state.fiveHour.remainingPercent, state.sevenDay.remainingPercent], [60, 83]);
  assert.equal(state.fiveHour.resetsAt, Date.parse('2026-09-27T10:00:00Z'));
  // Once reset boundaries have passed, only a new observation can say what remains.
  const later = Date.parse('2026-10-02T11:00:00Z');
  state = connector.claudeUsageState(later);
  assert.equal(state.fiveHour.resetsAt, null);
  assert.equal(state.fiveHour.remainingPercent, null);
  assert.equal(state.fiveHour.lastKnownRemainingPercent, 60);
  assert.equal(state.sevenDay.resetsAt, null);
  assert.equal(state.sevenDay.remainingPercent, null);
});

test('waiting = an unanswered desktop prompt from the desktop log (the yellow dot)', async () => {
  await ready();
  const fixture = desktopFixture();
  const log = path.join(fixture.root, 'main.log');
  fixture.store.permissionLog = new d.DesktopPermissionLog([log]);
  const { connector, frames } = syncConnector(fixture);
  const id = 'local_00000000-0000-4000-8000-000000000002';
  const ts = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  fs.writeFileSync(log,
    `${ts(5)} [info] Emitted tool permission request r1 for Bash in session ${id}\n` +
    `${ts(5)} [info] Received permission response for r1: once (tool: Bash)\n` +
    `${ts(1)} [info] Emitted tool permission request r2 for AskUserQuestion in session ${id}\n`);
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreadStatus(id), 'desktop_waiting');
  assert.equal(connector.claudeThreadIndexValue(id).note, 'Claude 在等你回答问题');
  assert.ok(connector.claudeActiveThreadRows().some((r) => r.threadId === id && r.status === 'desktop_waiting'));
  assert.equal(connector.claudeThreadStatus('local_00000000-0000-4000-8000-000000000001'), 'completed', 'no prompt, not waiting');
  // A deep-link second instance does not clear it...
  fs.appendFileSync(log, `${ts(0)} [info] Starting app {\n${ts(0)} [info] Not main instance, returning early from app ready\n`);
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreadStatus(id), 'desktop_waiting');
  // ...answering does.
  fs.appendFileSync(log, `${ts(0)} [info] Received permission response for r2: once (tool: AskUserQuestion)\n`);
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreadStatus(id), 'completed');
  assert.ok(frames.some((f) => f.kind === 'thread.status' && f.threadId === id && f.payload.status === 'completed'));
});

test('a real desktop restart drops prompts that can no longer be answered', () => {
  const dir = tmp('khlink-log-'); const log = path.join(dir, 'main.log');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.writeFileSync(log, `${now} [info] Emitted tool permission request r9 for Bash in session local_00000000-0000-4000-8000-000000000009\n`);
  const reader = new d.DesktopPermissionLog([log]);
  assert.equal(reader.poll().size, 1);
  fs.appendFileSync(log, `${now} [info] Starting app {\n${now} [info] Not main instance, returning early from app ready\n`);
  reader.poll();
  assert.equal(reader.appStartedAt, 0, 'a deep-link second instance is not an app start');
  fs.appendFileSync(log, `${now} [info] Starting app {\n` + Array.from({ length: 20 }, (_, i) => `${now} [info] boot ${i}\n`).join(''));
  assert.equal(reader.poll().size, 0);
  assert.equal(reader.appStartedAt, Date.parse(now.replace(' ', 'T')));
});

test('phone images reach a connector-run Claude turn as image blocks', () => {
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  const png = path.join(fixture.root, 'a.png'); fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]));
  connector.resolveAttachments = (id, list) => list;
  const parts = connector.claudeAttachmentParts({ threadId: 't', text: '这是什么', attachments: [{ path: png, name: 'a.png' }] });
  assert.equal(parts.images.length, 1);
  assert.equal(parts.images[0].mediaType, 'image/png');
  assert.equal(Buffer.from(parts.images[0].data, 'base64').length, 24);
  assert.equal(parts.text, '这是什么');
});

test('invalid or oversized images fail before Claude, Pi, DSH or Hermes can send text alone', (t) => {
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  connector.resolveAttachments = (id, list) => list;
  const invalid = path.join(fixture.root, 'bad.png'); fs.writeFileSync(invalid, 'not an image');
  const tooLarge = path.join(fixture.root, 'large.jpg'); fs.writeFileSync(tooLarge, Buffer.alloc(5 * 1024 * 1024 + 1));
  for (const file of [invalid, tooLarge, path.join(fixture.root, 'missing.png')]) {
    assert.throws(() => connector.claudeAttachmentParts({ threadId: 't', text: '看图', attachments: [{ path: file, name: path.basename(file) }] }),
      (error) => error.delivery === 'not_sent' && /图片/.test(error.message) && !error.message.includes(fixture.root));
  }
  const regular = path.join(fixture.root, 'note.txt'); fs.writeFileSync(regular, 'not an image');
  assert.match(connector.claudeAttachmentParts({ threadId: 't', text: '看文件', attachments: [{ path: regular, name: 'note.txt' }] }).text, /note\.txt/);
});

test('Claude desktop scripts reject any missing image before opening or writing a conversation', { skip: process.platform !== 'win32', timeout: 30_000 }, (t) => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-claude-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const text = path.join(dir, 'message.txt'); const valid = path.join(dir, 'present.png');
  fs.writeFileSync(text, 'test'); fs.writeFileSync(valid, 'test');
  const images = `${valid}|${path.join(dir, 'missing.png')}`;
  const scripts = path.join(__dirname, '..', 'scripts');
  const cases = [
    ['claude-desktop-send.ps1', '-SessionId', 'local_00000000-0000-4000-8000-000000000002', '-TextFile', text, '-ImageFiles', images, '-Mode', 'send', '-DryRun'],
    ['claude-desktop-new.ps1', '-TextFile', text, '-Folder', dir, '-ImageFiles', images],
  ];
  for (const [script, ...args] of cases) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, script), ...args], { encoding: 'utf8', timeout: 12_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { ok: false, reason: 'image_missing' });
  }
});

test('sessions never opened on the phone still show as running when the desktop works on them', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, frames } = syncConnector(fixture);
  fs.writeFileSync(fixture.transcript, line({ type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }));
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  connector.setClaudeThreadFields(id, { updatedAt: Date.now() }); // recently active on the desktop
  assert.equal(connector.claudeThreadStatus(id), 'completed');
  fs.appendFileSync(fixture.transcript, line({ type: 'user', uuid: 'u2', timestamp: new Date().toISOString(), message: { content: '继续' } }));
  const later = new Date(Date.now() + 5000); fs.utimesSync(fixture.transcript, later, later);
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreadStatus(id), 'desktop_running');
  assert.ok(frames.some((f) => f.kind === 'thread.status' && f.threadId === id && f.payload.status === 'desktop_running'));
  assert.ok(!connector.claudeThreads.get(id).transcriptOffset, 'no history upload for an unopened session');
});

test('stop for a desktop-held session presses Esc on the desktop', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  connector._claudeLive = { at: Date.now() + 60_000, ids: new Set(['22222222-2222-4222-8222-222222222222']) };
  const calls = [];
  connector.runDesktopSend = async (desktopId, text, restoreId, options) => { calls.push({ desktopId, mode: options?.mode }); return { ok: true }; };
  connector.claude.interruptTurn = () => { throw new Error('must not touch a connector process'); };
  const res = await connector.executeClaudeCommand('turn.stop', { threadId: 'local_00000000-0000-4000-8000-000000000002' });
  assert.deepEqual(res, { interrupted: true, on: 'desktop' });
  assert.deepEqual(calls, [{ desktopId: 'local_00000000-0000-4000-8000-000000000002', mode: 'interrupt' }]);
  await connector.executeClaudeCommand('claude.desktop.open', { threadId: 'local_00000000-0000-4000-8000-000000000002' });
  assert.equal(calls[1].mode, 'open');
});

test('images the user attached come through with the message, oversized ones are dropped', () => {
  const small = Buffer.from('fake-png').toString('base64');
  const huge = 'A'.repeat(2_100_000);
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: '2026-09-27T00:16:30Z', message: { content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: small } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: huge } },
      { type: 'text', text: '看图' },
    ] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-09-27T00:16:31Z', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: small } }] } },
  ].map((o) => JSON.stringify(o));
  const items = d.transcriptItems(lines);
  assert.equal(items.length, 2, 'an image-only message is still shown');
  assert.deepEqual(items[0].images, [{ data: `data:image/jpeg;base64,${small}`, mimeType: 'image/jpeg' }]);
  assert.equal(items[0].text, '看图');
  assert.equal(items[1].text, '');
  assert.equal(items[1].images.length, 1);
});

test('unread dots are read from the desktop sidebar store, newest write wins', async () => {
  await ready();
  const fixture = desktopFixture();
  const ldb = path.join(fixture.root, 'Local Storage', 'leveldb');
  const key = Buffer.from('_https://claude.ai\u0000\u0001epitaxy-unread-v1', 'latin1');
  const v = (ids) => Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify({ state: { unreadIds: ids, explicitUnreadIds: [] }, version: 0 }), 'latin1')]);
  fs.writeFileSync(path.join(ldb, '000005.log'), Buffer.concat([
    logRecord(20, key, v(['local_00000000-0000-4000-8000-000000000001', 'local_00000000-0000-4000-8000-000000000003'])),
    logRecord(21, key, v(['local_00000000-0000-4000-8000-000000000003'])),
  ]));
  assert.deepEqual([...fixture.store.readUnreadIds()], ['local_00000000-0000-4000-8000-000000000003']);
  const { connector } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreads.get('local_00000000-0000-4000-8000-000000000003').desktopUnread, true);
  assert.equal(connector.claudeThreads.get('local_00000000-0000-4000-8000-000000000001').desktopUnread, false, 'the desktop list, not the time heuristic');
});

test('the details behind a desktop prompt come from the unanswered tool call', () => {
  const file = path.join(tmp(), 't.jsonl');
  const rows = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [
      { question: '用哪个方案？', header: '方案', multiSelect: false, options: [{ label: 'A', description: '快' }, { label: 'B', description: '稳' }] },
    ] } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'rm -rf build', description: '清理' } }] } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const question = d.pendingToolUse(file, 'AskUserQuestion');
  assert.equal(question.kind, 'question');
  assert.deepEqual(question.questions[0].options.map((o) => o.label), ['A', 'B']);
  const bash = d.pendingToolUse(file, 'Bash');
  assert.deepEqual([bash.kind, bash.summary, bash.toolUseId], ['permission', 'rm -rf build', 'b2'], 'the answered ls is skipped');
  assert.equal(d.pendingToolUse(file, 'Write'), null);
});

test('answering a desktop prompt from the phone: only the prompt shown, with its own choices', async () => {
  const connector = Object.create(Connector.prototype);
  connector.log = () => {}; connector.answerPollMs = 1;
  connector.syncClaudeDesktopSessions = async () => {};
  const desktopId = 'local_00000000-0000-4000-8000-0000000000aa';
  let pending = new Map([[desktopId, { requestId: 'r1', tool: 'Bash' }]]);
  connector.claudeDesktop = { pendingPrompts: () => pending, focusedSessionId: () => 'local_00000000-0000-4000-8000-0000000000bb' };
  connector.claudeThreads = new Map([['t', { id: 't', desktopId, waitingDetail: { kind: 'permission', tool: 'Bash', summary: 'rm -rf build', requestId: 'r1' } }]]);
  const calls = [];
  connector.execFileFn = (cmd, args, opts, cb) => { calls.push(args); pending = new Map(); cb(null, '{"ok":true}'); };
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: 'old', choice: 'allow' }), /已经处理过或已经变了/);
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: 'r1', choice: 'always' }), /只能选择/);
  assert.equal(calls.length, 0);
  const done = await connector.answerClaudeOnDesktop('t', { requestId: 'r1', choice: 'allow' });
  assert.deepEqual(done, { answered: true, kind: 'permission', choice: 'allow' });
  const args = calls[0];
  assert.equal(args[args.indexOf('-Kind') + 1], 'permission');
  assert.equal(args[args.indexOf('-RestoreId') + 1], 'local_00000000-0000-4000-8000-0000000000bb');
  // Already answered on the desktop in the meantime.
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: 'r1', choice: 'allow' }), /已经处理过了/);
  // Questions: listed options only; single = exactly one answer, multi = at least one.
  connector.execFileFn = (cmd, args, opts, cb) => { calls.push(args); calls.lastPages = JSON.parse(fs.readFileSync(args[args.indexOf('-Choice') + 1], 'utf8')); pending = new Map(); cb(null, '{"ok":true}'); };
  pending = new Map([[desktopId, { requestId: 'q1', tool: 'AskUserQuestion' }]]);
  connector.claudeThreads.get('t').waitingDetail = { kind: 'question', requestId: 'q1', questions: [{ question: '选哪个？', multiSelect: false, options: [{ label: 'A' }, { label: 'B', description: '稳' }] }] };
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: 'q1', choices: ['C'] }), /对不上/);
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: 'q1', answers: [{ labels: ['A'], other: '都要' }] }), /选一项/);
  assert.equal((await connector.answerClaudeOnDesktop('t', { requestId: 'q1', choices: ['B'] })).kind, 'question');
  assert.deepEqual(calls.lastPages[0].options, [{ name: 'A Choose A', chosen: false }, { name: 'B 稳', chosen: true }]);
  assert.equal(calls.lastPages[0].question, '选哪个？');
  const questionArgs = calls[calls.length - 1];
  assert.equal(questionArgs[questionArgs.indexOf('-RequestId') + 1], 'q1');
  pending = new Map([[desktopId, { requestId: 'q2', tool: 'AskUserQuestion' }]]);
  connector.claudeThreads.get('t').waitingDetail = { kind: 'question', requestId: 'q2', questions: [
    { question: '多选', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    { question: '大小', multiSelect: false, options: [{ label: 'S' }] },
  ] };
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: 'q2', answers: [{ labels: [] }, { labels: ['S'] }] }), /至少选一项/);
  await connector.answerClaudeOnDesktop('t', { requestId: 'q2', answers: [{ labels: ['A', 'B'] }, { labels: [], other: '中号' }] });
  assert.deepEqual(calls.lastPages.map((p) => [p.multi, p.other, p.options.filter((o) => o.chosen).map((o) => o.name)]), [[true, null, ['A Choose A', 'B Choose B']], [false, '中号', []]]);
  // Plans: accept / accept with auto mode / reject / revise with feedback.
  connector.execFileFn = (cmd, args, opts, cb) => { calls.push(args); pending = new Map(); cb(null, '{"ok":true}'); };
  pending = new Map([[desktopId, { requestId: 'p1', tool: 'ExitPlanMode' }]]);
  connector.claudeThreads.get('t').waitingDetail = { kind: 'plan', requestId: 'p1', summary: '# Plan' };
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: 'p1', choice: 'revise' }), /修改意见/);
  await connector.answerClaudeOnDesktop('t', { requestId: 'p1', choice: 'revise', feedback: '再加一步' });
  const planArgs = calls[calls.length - 1];
  assert.equal(planArgs[planArgs.indexOf('-Kind') + 1], 'plan');
  assert.ok(planArgs.includes('-FeedbackFile'));
  // A failed check on the desktop is reported, not retried.
  pending = new Map([[desktopId, { requestId: 'r3', tool: 'Bash' }]]);
  connector.claudeThreads.get('t').waitingDetail = { kind: 'permission', summary: 'ls', requestId: 'r3' };
  connector.execFileFn = (cmd, a, opts, cb) => cb(null, '{"ok":false,"reason":"prompt_mismatch"}');
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: 'r3', choice: 'allow' }), /不一致/);
});

test('a phone message queued behind a Claude turn survives a connector restart', async () => {
  const { Connector } = require('../src/connector');
  const saved = new Map([['t', { id: 't', title: 'x' }]]);
  const first = Object.create(Connector.prototype);
  first.claudeThreads = saved; first.saveClaudeThreads = () => {}; first.emit = () => {};
  first.claudeDesktopBusy = () => true; first.claude = { isRunning: () => false };
  const result = await first.claudeQueueCommand({ action: 'followup.enqueue', requestId: 'r1', args: { threadId: 't', text: 'later' } });
  assert.equal(result.queued, true);
  assert.equal(saved.get('t').mobileQueue.length, 1);
  // A new process reads the saved record and sends it once the session is idle.
  const second = Object.create(Connector.prototype);
  second.claudeThreads = saved; second.saveClaudeThreads = () => {}; second.emit = () => {};
  second.claudeDesktopBusy = () => false; second.claude = { isRunning: () => false };
  const sent = [];
  second.executeClaudeCommand = async (action, args) => { sent.push(args.text); return {}; };
  assert.equal(second.claudeQueueItems('t').length, 1);
  await second.drainClaudeQueue('t');
  assert.deepEqual(sent, ['later']);
  assert.equal(saved.get('t').mobileQueue.length, 0);
});

test('images returned by tools become load-on-request references, read back from the transcript', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const uuid = '11111111-2222-3333-4444-555555555555';
  const row = { type: 'user', uuid, timestamp: '2026-09-28T00:00:00Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }] },
  ] } };
  const items = d.transcriptItems([JSON.stringify(row)], 3);
  assert.deepEqual(items.map((item) => [item.id, item.type, item.order]), [[`${uuid}:img`, 'toolImages', 3 * 16 + 1]]);
  assert.deepEqual(items[0].imageRefs, [{ ref: `${uuid}/0/1`, mimeType: 'image/png', bytes: png.length }]);
  assert.equal(JSON.stringify(items[0]).includes(png.toString('base64')), false);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kh-img-')), 't.jsonl');
  fs.writeFileSync(file, `{"type":"summary"}\n${JSON.stringify(row)}\n`);
  const image = d.readTranscriptImage(file, `${uuid}/0/1`);
  assert.deepEqual(image.bytes, png);
  assert.equal(image.mimeType, 'image/png');
  assert.throws(() => d.readTranscriptImage(file, '../etc/0/0'), /无效/);
});

test('a turn stopped by the user or by an API error is over, so queued messages can go', () => {
  const uuid = (n) => `00000000-0000-0000-0000-00000000000${n}`;
  const assistant = (n, stop) => JSON.stringify({ type: 'assistant', uuid: uuid(n), timestamp: '2026-09-28T00:00:0' + n + 'Z', message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'x' }] } });
  const user = (n, content) => JSON.stringify({ type: 'user', uuid: uuid(n), timestamp: '2026-09-28T00:00:0' + n + 'Z', message: { role: 'user', content } });
  const last = (lines) => { const state = {}; d.transcriptItems(lines, 0, state); return state.lastEvent; };
  assert.equal(last([user(1, 'go'), assistant(2, 'tool_use')]), 'assistant');
  assert.equal(last([user(1, 'go'), assistant(2, 'end_turn')]), 'end_turn');
  assert.equal(last([user(1, 'go'), assistant(2, 'stop_sequence')]), 'end_turn');
  assert.equal(last([user(1, 'go'), assistant(2, 'tool_use'), user(3, [{ type: 'text', text: '[Request interrupted by user]' }])]), 'end_turn');
  assert.equal(last([user(1, 'go'), assistant(2, 'tool_use'), user(3, [{ type: 'tool_result', tool_use_id: 't', content: '[Request interrupted by user for tool use]' }])]), 'end_turn');
  assert.equal(last([user(1, 'go'), assistant(2, 'tool_use'), user(3, [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }])]), 'user');
  const state = {};
  d.transcriptItems([user(1, 'go'), assistant(2, 'tool_use'), user(3, '[Request interrupted by user]')], 0, state);
  assert.equal(state.lastTerminalStatus, 'interrupted');
  d.transcriptItems([user(4, 'new turn'), assistant(5, 'end_turn')], 3, state);
  assert.equal(state.lastTerminalStatus, null, 'a later native turn clears the old stop marker');
});

test('plan usage ignores filesystem mtime and uses the sample timestamp as its source time', () => {
  const fixture = desktopFixture(); const file = path.join(fixture.root, 'plan-usage-history.json');
  const sampleAt = Date.parse('2026-10-06T16:00:00Z');
  fs.writeFileSync(file, JSON.stringify({ version: 2, samples: [{ t: sampleAt, org: 'org', u: { fh: 12, sd: 34 } }] }));
  fs.utimesSync(file, new Date('2026-10-06T09:00:00Z'), new Date('2026-10-06T09:00:00Z'));
  assert.equal(fixture.store.latestUsageSample().at, sampleAt);
  const { connector } = syncConnector(fixture);
  const state = connector.claudeUsageState(Date.parse('2026-10-06T16:05:00Z'));
  assert.equal(state.fiveHour.observedAt, sampleAt);
  assert.equal(state.fiveHour.remainingPercent, 88);
});

test('plan usage keeps the last complete sample while the desktop rewrites the file', () => {
  const fixture = desktopFixture(); const file = path.join(fixture.root, 'plan-usage-history.json');
  const sampleAt = Date.parse('2026-10-06T16:00:00Z');
  fs.writeFileSync(file, JSON.stringify({ version: 2, samples: [{ t: sampleAt, org: 'org', u: { fh: 12, sd: 34 } }] }));
  assert.equal(fixture.store.latestUsageSample().at, sampleAt);
  // A truncate/partial-write window must not make the connector fall back to
  // the much older command-line event.
  fs.writeFileSync(file, '{"version":2,"samples":[');
  assert.equal(fixture.store.latestUsageSample().at, sampleAt);
  fs.writeFileSync(file, JSON.stringify({ version: 2, samples: [] }));
  assert.equal(fixture.store.latestUsageSample().at, sampleAt);
});

test('plan usage never invents a later reset from sparse history', () => {
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  connector.config.configFile = path.join(fixture.root, 'config.json');
  const t = (hm) => Date.parse(`2026-10-06T${hm}:00Z`);
  fs.writeFileSync(path.join(fixture.root, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples: [
    { t: t('06:08'), org: 'org', u: { fh: 4, sd: 50 } },
    { t: t('06:23'), org: 'org', u: { fh: 4, sd: 50 } },
    { t: t('08:38'), org: 'org', u: { fh: 7, sd: 51 } },
    { t: t('10:08'), org: 'org', u: { fh: 21, sd: 52 } },
    { t: t('12:08'), org: 'org', u: { fh: 32, sd: 53 } },
  ] }));
  const state = connector.claudeUsageState(t('12:20'));
  assert.equal(state.fiveHour.remainingPercent, 68);
  assert.equal(state.fiveHour.resetsAt, null);
  assert.equal(state.fiveHour.resetEstimated, false);
});

test('readTranscriptImage finds a row past the first read chunk without loading the whole file', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { readTranscriptImage } = require('../src/backends/claude-desktop');
  const file = path.join(os.tmpdir(), `kh-transcript-${process.pid}.jsonl`);
  const data = Buffer.from('picture bytes').toString('base64');
  const uuid = '12345678-1234-1234-1234-123456789abc';
  const filler = `{"uuid":"00000000-0000-0000-0000-000000000000","message":{"content":"${'x'.repeat(9 << 20)}"}}\n`;
  const row = JSON.stringify({ uuid, message: { content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] } });
  fs.writeFileSync(file, `${filler}${row}\n{"parentUuid":"${uuid}"}\n`);
  try {
    const image = readTranscriptImage(file, `${uuid}/0/0`);
    assert.equal(image.bytes.toString(), 'picture bytes');
    assert.equal(readTranscriptImage(file, `${uuid}/0/0`).mimeType, 'image/png');
    assert.throws(() => readTranscriptImage(file, '99999999-1234-1234-1234-123456789abc/0/0'), /找不到/);
  } finally { fs.rmSync(file, { force: true }); }
});

test('a phone message resent with the same request id is delivered once', async () => {
  const connector = Object.create(Connector.prototype);
  let delivered = 0;
  connector.claudeQueueCommandOnce = async () => { delivered += 1; return { accepted: true, backend: 'claude' }; };
  const payload = { action: 'turn.start', requestId: 'r-1', args: { threadId: 't', text: 'hi' } };
  await connector.claudeQueueCommand(payload);
  const again = await connector.claudeQueueCommand(payload);
  assert.equal(delivered, 1);
  assert.equal(again.duplicate, true);
});

test('user text behind a leading system reminder is kept', () => {
  const row = { type: 'user', uuid: 'u1', timestamp: '2026-09-28T07:59:01Z', message: { role: 'user', content: [
    { type: 'text', text: '<system-reminder>\nThis conversation is now continuing in the Claude desktop app.\n</system-reminder>' },
    { type: 'text', text: 'Count from 1 to 30.' },
  ] } };
  const file = path.join(os.tmpdir(), `kh-reminder-${process.pid}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify(row)}\n`);
  try {
    const items = d.readTranscript(file, 0, 0).items.filter((item) => item.type === 'userMessage');
    assert.deepEqual(items.map((item) => item.text), ['Count from 1 to 30.']);
  } finally { fs.rmSync(file, { force: true }); }
});

test('with the desktop app open, a message to one of its idle sessions still goes to the desktop (never the CLI login)', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000002';
  const sent = []; const released = [];
  // The desktop stopped this session's Claude Code process, but the app is running.
  const idle = new Set(); idle.appRunning = true;
  connector._claudeLive = { at: Date.now() + 60_000, ids: idle };
  connector.runDesktopSend = async (desktopId, text) => { sent.push({ desktopId, text }); return { ok: true }; };
  connector.claude.releaseSession = (threadId) => { released.push(threadId); return true; };
  connector.claude.startTurn = () => { throw new Error('must not resume a desktop session with the command-line login'); };
  const result = await connector.executeClaudeCommand('turn.start', { threadId: id, text: '看一下' });
  assert.equal(result.deliveredTo, 'desktop');
  assert.deepEqual(sent, [{ desktopId: id, text: '看一下' }]);
  assert.deepEqual(released, [id], 'our own idle process for the thread is stopped');
  // Desktop app closed: the connector runs the turn itself.
  connector._claudeLive = { at: Date.now() + 60_000, ids: new Set() };
  let spawned = false;
  connector.claude.startTurn = () => { spawned = true; return { turnId: 't1' }; };
  await connector.executeClaudeCommand('turn.start', { threadId: id, text: '再看一下' });
  assert.equal(spawned, true);
  assert.equal(sent.length, 1);
});

test('liveDesktopSessions notices the desktop app main process', async () => {
  const store = Object.create(d.ClaudeDesktopStore.prototype);
  const app = String.raw`C:\Program Files\WindowsApps\Claude_2.16120.0.0_x64__pzs8sxrjxfjjc\app\claude.exe`;
  const cli = String.raw`C:\Users\me\AppData\Roaming\Claude\claude-code\2.1.284\claude.exe`;
  const run = (stdout) => { store.execFileFn = (_c, _a, _o, cb) => cb(null, stdout); return store.liveDesktopSessions(); };
  if (process.platform !== 'win32') return;
  const helperOnly = await run(`${app}|"${app}" --type=renderer\n`);
  assert.ok(!helperOnly.appRunning);
  const live = await run(`${app}|"${app}" \n${cli}|${cli} --resume 11111111-1111-4111-8111-111111111111\n`);
  assert.equal(live.appRunning, true);
  assert.ok(live.has('11111111-1111-4111-8111-111111111111'));
  const unknown = await run(String.raw`G:\Apps\ClaudeSwitch\profiles\primary\claude-code\2.1.288\hash\claude.exe|claude.exe --worker`);
  assert.equal(unknown.unattributed, true);
});

test('a failed desktop process query never sends a desktop session to the command-line login', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  const failed = () => { const s = new Set(); s.failed = true; return Promise.resolve(s); };
  fixture.store.liveDesktopSessions = failed;
  connector._claudeLive = null;
  assert.equal(await connector.desktopShouldTakeClaudeSession('11111111-1111-4111-8111-111111111111'), true, 'nothing known yet: assume the app is open');
  // Last good look: app closed. A later failure keeps that answer.
  fixture.store.liveDesktopSessions = () => Promise.resolve(new Set());
  connector._claudeLive = null;
  assert.equal(await connector.desktopShouldTakeClaudeSession('11111111-1111-4111-8111-111111111111'), false);
  fixture.store.liveDesktopSessions = failed;
  connector._claudeLive.at = 0;
  assert.equal(await connector.desktopShouldTakeClaudeSession('11111111-1111-4111-8111-111111111111'), false);
});

test('plan usage: another account never provides reset times; narrow sample brackets give estimates', () => {
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  connector.config.configFile = path.join(fixture.root, 'config.json');
  const t = (hm) => Date.parse(`2026-09-30T${hm}:00Z`);
  // The command line is signed in to a different organisation.
  connector._claudeCliOrg = 'other-org';
  connector.onClaudeRateLimit({ status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 0.04, resetsAt: t('14:20') / 1000 },
    seven_day: { utilization: 0.69, resetsAt: Date.parse('2026-10-03T15:00:00Z') / 1000 },
  } });
  const samples = [
    { t: Date.parse('2026-09-23T09:00:00Z'), org: 'org', u: { fh: 0, sd: 80 } },
    { t: Date.parse('2026-09-23T09:15:00Z'), org: 'org', u: { fh: 0, sd: 1 } }, // weekly reset
    { t: t('09:45'), org: 'org', u: { fh: 0, sd: 3 } },
    { t: t('10:00'), org: 'org', u: { fh: 12, sd: 4 } }, // five-hour window starts
    { t: t('10:15'), org: 'org', u: { fh: 20, sd: 4 } },
    { t: t('10:30'), org: 'other-org', u: { fh: 90, sd: 90 } },
  ];
  fs.writeFileSync(path.join(fixture.root, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples }));
  const state = connector.claudeUsageState(t('10:20'));
  assert.equal(state.fiveHour.remainingPercent, 80);
  // Never the other organisation's 14:20 / Oct 3 times; estimated from this
  // account's samples instead (window started 09:45–10:00, week 09:00–09:15).
  assert.equal(state.fiveHour.resetsAt, t('10:00') + 5 * 3600_000);
  assert.equal(state.fiveHour.resetEstimated, true);
  assert.equal(state.sevenDay.remainingPercent, 96);
  assert.equal(state.sevenDay.resetsAt, Date.parse('2026-09-23T09:15:00Z') + 14 * 86_400_000);
  assert.equal(state.sevenDay.resetEstimated, true);
  // Nothing learnt about the weekly reset: unknown, not another account's time.
  fs.writeFileSync(path.join(fixture.root, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples: samples.slice(2) }));
  assert.equal(connector.claudeUsageState(t('10:20')).sevenDay.resetsAt, null);
});

test('plan usage: a new five-hour window never reuses the previous reset', () => {
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  connector.config.configFile = path.join(fixture.root, 'config.json');
  const t = (hm) => Date.parse(`2026-10-01T${hm}:00Z`);
  connector._claudeCliOrg = 'org';
  connector.onClaudeRateLimit({ status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 0.06, resetsAt: t('07:50') / 1000 },
    seven_day: { utilization: 0.12, resetsAt: Date.parse('2026-10-02T06:00:00Z') / 1000 },
  } }, t('04:58'));
  fs.writeFileSync(path.join(fixture.root, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples: [
    { t: t('07:58'), org: 'org', u: { fh: 0, sd: 13 } },
    { t: t('08:13'), org: 'org', u: { fh: 0, sd: 13 } },
    { t: t('08:28'), org: 'org', u: { fh: 4, sd: 14 } }, // the next window started
  ] }));
  const state = connector.claudeUsageState(t('08:48'));
  assert.equal(state.fiveHour.remainingPercent, 96);
  // Not the previous window's 07:50: estimated from the new start (08:13–08:28).
  assert.equal(state.fiveHour.resetsAt, t('08:28') + 5 * 3600_000);
  assert.equal(state.fiveHour.resetEstimated, true);
  assert.equal(state.sevenDay.resetsAt, Date.parse('2026-10-02T06:00:00Z'));
  assert.equal(state.sevenDay.resetEstimated, false);
});

test('an unavailable embedded CLI is tried once per desktop sample, not every poll', async () => {
  const connector = Object.create(Connector.prototype);
  const sampleAt = 1_000_000;
  connector.claudeDesktop = { latestUsageSample: () => ({ at: sampleAt }) };
  connector.claudeUsageState = () => ({ fiveHour: { remainingPercent: 80, resetsAt: null, observedAt: sampleAt } });
  connector.claudeCliMatchesDesktop = async () => false;
  connector._claudeCliOrg = null;
  const logs = []; connector.log = (line) => logs.push(String(line));
  assert.equal(await connector.maybeRefreshFiveHourReset(sampleAt + 1), false);
  assert.equal(await connector.maybeRefreshFiveHourReset(sampleAt + 6 * 60_000), false);
  assert.equal(logs.length, 0, 'a fresh desktop sample is enough; no repeating CLI error');
});

test('plan usage: a 0% sample older than Claude\'s latest work is shown as unknown, not "not started"', () => {
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  connector.config.configFile = path.join(fixture.root, 'config.json');
  const t = (hm) => Date.parse(`2026-10-02T${hm}:00Z`);
  fs.writeFileSync(path.join(fixture.root, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples: [
    { t: t('02:20'), org: 'org', u: { fh: 0, sd: 32 } },
  ] }));
  connector.claudeThreads = new Map([['a', { transcriptLastEventAt: t('02:10') }]]);
  let five = connector.claudeUsageState(t('03:00')).fiveHour;
  assert.equal(five.remainingPercent, null, 'idle in Code does not rule out browser/Cowork activity');
  assert.equal(five.lastKnownRemainingPercent, 100);
  connector.claudeThreads.get('a').transcriptLastEventAt = t('02:50');
  five = connector.claudeUsageState(t('03:00')).fiveHour;
  assert.equal(five.remainingPercent, null);
  assert.equal(five.staleWhileActive, true);
});

test('an old usage figure is explicitly historical while Claude keeps working', () => {
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  connector.config.configFile = path.join(fixture.root, 'config.json');
  const t = (hm) => Date.parse(`2026-10-02T${hm}:00Z`);
  fs.writeFileSync(path.join(fixture.root, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples: [
    { t: t('02:20'), org: 'org', u: { fh: 40, sd: 32 } },
  ] }));
  connector.claudeThreads = new Map([['a', { transcriptLastEventAt: t('02:50') }]]);
  const state = connector.claudeUsageState(t('03:00'));
  // Without an exact boundary, the sample is historical rather than a current upper bound.
  assert.equal(state.fiveHour.remainingPercent, null);
  assert.equal(state.sevenDay.remainingPercent, null);
  assert.equal(state.fiveHour.lastKnownRemainingPercent, 60);
  assert.equal(state.sevenDay.lastKnownRemainingPercent, 68);
  assert.equal(state.fiveHour.atMost, false);
  assert.equal(state.sevenDay.atMost, false);
  assert.equal(state.fiveHour.stale, true);
  assert.equal(state.sevenDay.stale, true);
  assert.equal(state.observedAt, t('02:20'));
});

test('a five-hour figure from a window that has since ended is unknown once Claude works again', () => {
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  connector.config.configFile = path.join(fixture.root, 'config.json');
  const t = (hm) => Date.parse(`2026-10-02T${hm}:00Z`);
  // fh rises from 01:00, so that window ends at ~06:00.
  fs.writeFileSync(path.join(fixture.root, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples: [
    { t: t('01:00'), org: 'org', u: { fh: 5, sd: 30 } },
    { t: t('02:20'), org: 'org', u: { fh: 40, sd: 32 } },
  ] }));
  connector.claudeThreads = new Map([['a', { transcriptLastEventAt: t('05:00') }]]);
  let state = connector.claudeUsageState(t('05:30'));
  assert.equal(state.fiveHour.remainingPercent, null, 'old data cannot establish the current window');
  assert.equal(state.fiveHour.lastKnownRemainingPercent, 60);
  connector.claudeThreads.get('a').transcriptLastEventAt = t('06:30');
  state = connector.claudeUsageState(t('07:00'));
  assert.equal(state.fiveHour.remainingPercent, null, 'a new window runs whose usage is unknown');
  assert.equal(state.sevenDay.remainingPercent, null);
  assert.equal(state.sevenDay.lastKnownRemainingPercent, 68);
});

test('a stale command-line event is historical while Claude is active', () => {
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  connector.config.configFile = path.join(fixture.root, 'config.json');
  connector._claudeCliOrg = 'org';
  connector.onClaudeRateLimit({ status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 0.2, resetsAt: Date.parse('2026-10-02T05:00:00Z') / 1000 },
    seven_day: { utilization: 0.3, resetsAt: Date.parse('2026-10-08T05:00:00Z') / 1000 },
  } }, Date.parse('2026-10-02T02:20:00Z'));
  connector.claudeThreads = new Map([['a', { transcriptLastEventAt: Date.parse('2026-10-02T02:50:00Z') }]]);
  const state = connector.claudeUsageState(Date.parse('2026-10-02T03:00:00Z'));
  assert.equal(state.fiveHour.remainingPercent, null);
  assert.equal(state.sevenDay.remainingPercent, null);
  assert.equal(state.fiveHour.lastKnownRemainingPercent, 80);
  assert.equal(state.sevenDay.lastKnownRemainingPercent, 70);
  assert.equal(state.fiveHour.staleWhileActive, true);
});

test('an older prompt of a session is dropped once a later one of that session is answered', () => {
  const dir = tmp('khlink-log-'); const log = path.join(dir, 'main.log');
  const ts = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  const a = 'local_9b2aa1bf-8820-409c-bafb-afd999dc2a54'; const b = 'local_00000000-0000-4000-8000-000000000002';
  fs.writeFileSync(log,
    `${ts(600)} [info] Emitted tool permission request old for computer:request_access in session ${a}\n` +
    `${ts(500)} [info] Emitted tool permission request other for Bash in session ${b}\n` +
    `${ts(300)} [info] Emitted tool permission request newer for computer:request_access in session ${a}\n`);
  const reader = new d.DesktopPermissionLog([log]);
  assert.equal(reader.poll().get(a).requestId, 'newer', 'two pending: the latest is shown');
  fs.appendFileSync(log, `${ts(296)} [info] Received permission response for newer: always (tool: computer:request_access)\n`);
  const after = reader.poll();
  assert.equal(after.has(a), false, 'the older one, never answered in the log, is gone too');
  assert.equal(after.get(b).requestId, 'other', 'another session is untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a prompt the desktop aborted is no longer waiting', () => {
  const dir = tmp('khlink-log-'); const log = path.join(dir, 'main.log');
  const ts = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  const a = 'local_359c9418-de94-43f1-b528-aa5d10a9c201'; const b = 'local_00000000-0000-4000-8000-000000000002';
  fs.writeFileSync(log,
    `${ts(10)} [info] Emitted tool permission request a6611123-6de0-4ac3-a03f-e35550465528 for computer:request_access in session ${a}\n` +
    `${ts(9)} [info] Emitted tool permission request other for Bash in session ${b}\n`);
  const reader = new d.DesktopPermissionLog([log]);
  assert.equal(reader.poll().size, 2);
  fs.appendFileSync(log, `${ts(5)} [info] Permission request a6611123-6de0-4ac3-a03f-e35550465528 for computer:request_access aborted\n`);
  const after = reader.poll();
  assert.equal(after.has(a), false, 'the aborted prompt is gone');
  assert.equal(after.get(b).requestId, 'other', 'another session is untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a mismatched desktop approval refreshes the actual child request without reusing the phone choice', async () => {
  const connector = Object.create(Connector.prototype);
  const id = 'local_61897d9c-8c85-4ac1-b36d-ff35d151439a';
  connector.claudeThreads = new Map([[id, { desktopId: id, waitingDetail: { kind: 'permission', requestId: 'r1', summary: 'cd x; ./sbx.sh q18' } }]]);
  connector.claudeDesktop = { pendingPrompts: () => new Map([[id, { requestId: 'r1' }]]), focusedSessionId: () => id };
  connector.log = () => {};
  const frames = []; let publications = 0; let calls = 0;
  connector.saveClaudeThreads = () => {}; connector.syncClaudeThreadMetadata = async (threadId, touchIndex) => { assert.equal(touchIndex, true, 'replacement is on the newest metadata page even for an old conversation'); publications++; };
  connector.emit = (kind, threadId, payload) => frames.push({ kind, threadId, payload });
  const prompt = { desktopId: id, name: 'Permission request: run', texts: ['Allow Claude to', 'run', 'T212 逐帧录制', '?', 'T212 逐帧录制', 'echo 审批完成 > approval-smoke.txt'] };
  connector.execFileFn = (file, args, options, callback) => {
    calls++;
    setImmediate(() => callback(null, `${JSON.stringify({ ok: false, reason: 'prompt_mismatch', shown: 'T212 逐帧录制', prompt })}\n`));
  };
  assert.deepEqual(await connector.answerClaudeOnDesktop(id, { requestId: 'r1', choice: 'allow' }), { answered: false, refreshed: true, kind: 'permission' });
  const refreshed = connector.claudeThreads.get(id).waitingDetail;
  assert.equal(calls, 1, 'does not click again with the old choice');
  assert.equal(publications, 1);
  assert.equal(refreshed.summary, 'T212 逐帧录制\necho 审批完成 > approval-smoke.txt');
  assert.equal(refreshed.logRequestId, 'r1');
  assert.notEqual(refreshed.requestId, 'r1');
  assert.equal(frames.some((f) => f.kind === 'threads.updated'), true, 'phone fetches the replacement card');
  await assert.rejects(connector.answerClaudeOnDesktop(id, { requestId: 'r1', choice: 'allow' }), /已经处理过或已经变了/);
  assert.equal(calls, 1, 'an old phone card cannot authorize the replacement');
  connector.execFileFn = (file, args, options, callback) => setImmediate(() => callback(null, `${JSON.stringify({ ok: false, reason: 'session_not_opened' })}\n`));
  await assert.rejects(connector.answerClaudeOnDesktop(id, { requestId: refreshed.requestId, choice: 'allow' }), /没有切到这个会话/);
});

test('a visible permission is bound to its full content, session and native request, not a common prefix', () => {
  const { desktopPermissionDetail } = require('../src/backends/claude-desktop-prompts');
  const id = 'local_00000000-0000-4000-8000-0000000000aa';
  const prefix = 'echo ' + 'a'.repeat(900);
  const prompt = { desktopId: id, name: 'Permission request: run', texts: ['Allow Claude to', 'run', '中文说明', '?', `${prefix} > safe.txt`] };
  const first = desktopPermissionDetail(prompt, { requestId: 'r1' }, id);
  assert.equal(first.summary.endsWith(' > safe.txt'), true, 'keeps the command suffix beyond the old 800-character clip');
  assert.equal(first.requestId, desktopPermissionDetail({ ...prompt, runtimeId: [42, 999] }, { requestId: 'r1' }, id).requestId, 'reopening a session can recreate UI elements');
  assert.notEqual(first.requestId, desktopPermissionDetail({ ...prompt, texts: [...prompt.texts.slice(0, -1), `${prefix} > other.txt`] }, { requestId: 'r1' }, id).requestId);
  assert.notEqual(first.requestId, desktopPermissionDetail(prompt, { requestId: 'r2' }, id).requestId, 'another identical native request still needs its own choice');
  assert.notEqual(desktopPermissionDetail({ ...prompt, texts: ['echo "a b"'] }, { requestId: 'r1' }, id).requestId,
    desktopPermissionDetail({ ...prompt, texts: ['echo "a  b"'] }, { requestId: 'r1' }, id).requestId, 'whitespace inside a command can change its meaning');
  assert.equal(desktopPermissionDetail({ ...prompt, desktopId: 'another-session' }, { requestId: 'r1' }, id), null);
  assert.equal(desktopPermissionDetail({ ...prompt, texts: ['x'.repeat(65537)] }, { requestId: 'r1' }, id), null);
});

test('the sync reads the focused permission without switching sessions and retains it after returning elsewhere', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, frames } = syncConnector(fixture);
  const session = fixture.store.listSessions()[0];
  fixture.store.pendingPrompts = () => new Map([[session.desktopId, { requestId: 'r1', tool: 'Bash', at: 1234 }]]);
  fixture.store.focusedSessionId = () => session.desktopId;
  const calls = [];
  connector.execFileFn = (file, args, options, callback) => {
    calls.push(args);
    callback(null, JSON.stringify({ ok: true, prompt: { desktopId: session.desktopId, name: 'Permission request: run', texts: ['子任务的审批', 'echo approval'] } }));
  };
  await connector.syncClaudeDesktopSessions();
  const detail = connector.claudeThreads.get(session.desktopId).waitingDetail;
  assert.equal(detail.source, 'desktop-ui');
  assert.equal(detail.summary, '子任务的审批\necho approval');
  assert.ok(calls[0].includes('-NoNavigate'));
  const before = frames.length;
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreads.get(session.desktopId).waitingDetail, detail, 'unchanged prompt does not keep publishing a new card');
  assert.equal(frames.length, before);
  fixture.store.focusedSessionId = () => 'another-session';
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreads.get(session.desktopId).waitingDetail, detail);
  assert.equal(calls.length, 2, 'does not navigate to inspect a background session');
});

test('answering a UI permission verifies the snapshot and the live native request before any action', async () => {
  const { desktopPermissionDetail } = require('../src/backends/claude-desktop-prompts');
  const connector = Object.create(Connector.prototype);
  const id = 'local_00000000-0000-4000-8000-0000000000aa';
  const snapshot = { desktopId: id, name: 'Permission request: run', texts: ['审批测试', 'echo 中文 > approval.txt'] };
  const detail = desktopPermissionDetail(snapshot, { requestId: 'r1' }, id);
  connector.claudeThreads = new Map([['t', { desktopId: id, waitingDetail: detail }]]);
  let pending = new Map([[id, { requestId: 'r1' }]]); let calls = 0;
  connector.claudeDesktop = { pendingPrompts: () => pending, focusedSessionId: () => id };
  connector.syncClaudeDesktopSessions = async () => {};
  connector.execFileFn = (file, args, options, callback) => {
    calls++;
    assert.deepEqual(JSON.parse(fs.readFileSync(args[args.indexOf('-PromptFile') + 1], 'utf8')), detail.desktopPrompt);
    assert.equal(options.encoding, 'utf8');
    assert.equal(args[args.indexOf('-RequestId') + 1], 'r1');
    pending = new Map(); callback(null, '{"ok":true}');
  };
  assert.equal((await connector.answerClaudeOnDesktop('t', { requestId: detail.requestId, choice: 'deny' })).answered, true);
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: detail.requestId, choice: 'allow' }), /已经处理过了/);
  assert.equal(calls, 1);
});

test('a mismatched prompt from another session or an answered native request is never published as actionable', async () => {
  const connector = Object.create(Connector.prototype);
  const id = 'local_00000000-0000-4000-8000-0000000000aa';
  connector.claudeThreads = new Map([['t', { desktopId: id, waitingDetail: { kind: 'permission', requestId: 'r1', summary: 'echo before' } }]]);
  let pending = new Map([[id, { requestId: 'r1' }]]);
  connector.claudeDesktop = { pendingPrompts: () => pending, focusedSessionId: () => id };
  let published = false; connector.syncClaudeThreadMetadata = async () => { published = true; };
  connector.execFileFn = (file, args, options, callback) => callback(null, JSON.stringify({ ok: false, reason: 'prompt_mismatch', prompt: { desktopId: 'another-session', name: 'Permission request: run', texts: ['echo other'] } }));
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: 'r1', choice: 'allow' }), /不一致/);
  connector.execFileFn = (file, args, options, callback) => {
    pending = new Map(); callback(null, JSON.stringify({ ok: false, reason: 'prompt_mismatch', prompt: { desktopId: id, name: 'Permission request: run', texts: ['echo other'] } }));
  };
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: 'r1', choice: 'allow' }), /不一致/);
  assert.equal(published, false);
});

test('desktop approval waits for an earlier send to finish navigating', async () => {
  const connector = Object.create(Connector.prototype);
  let release;
  connector._claudeDesktopSendChain = new Promise((resolve) => { release = resolve; });
  let answered = false;
  connector.answerClaudeOnDesktopNow = async () => { answered = true; return { answered: true }; };
  const work = connector.answerClaudeOnDesktop('t', { requestId: 'r1', choice: 'allow' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answered, false);
  release();
  assert.deepEqual(await work, { answered: true });
});


test('usage samples remain monotonic through an older rewrite and partial windows', () => {
  const fixture = desktopFixture(); const file = path.join(fixture.root, 'plan-usage-history.json');
  const at = Date.parse('2026-10-08T00:00:00Z');
  const write = (samples) => fs.writeFileSync(file, JSON.stringify({ version: 2, samples }));
  write([{ t: at, org: 'org', u: { fh: 4, sd: 98 } }]);
  fixture.store.latestUsageSample(at);
  write([{ t: at - 60_000, org: 'org', u: { fh: 0, sd: 60 } }]);
  let sample = fixture.store.latestUsageSample(at);
  assert.equal(sample.fiveHour, 0.04);
  assert.equal(sample.sevenDay, 0.98);
  write([{ t: at + 60_000, org: 'org', u: { sd: 99 } }]);
  sample = fixture.store.latestUsageSample(at + 60_000);
  assert.equal(sample.fiveHourObservedAt, at);
  assert.equal(sample.sevenDayObservedAt, at + 60_000);
});

test('partial and reset-only rate events cannot refresh another percentage', () => {
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  connector.config.configFile = path.join(fixture.root, 'config.json'); connector._claudeCliOrg = 'org';
  const at = Date.parse('2026-10-08T00:00:00Z'); const reset = at + 5 * 3600_000;
  connector.onClaudeRateLimit({ unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: reset / 1000 } } }, at);
  connector.onClaudeRateLimit({ unifiedWindows: { seven_day: { utilization: 0.98 } } }, at + 40 * 60_000);
  assert.equal(connector.claudeUsageState(at + 40 * 60_000).fiveHour.remainingPercent, null);
  connector.onClaudeRateLimit({ rateLimitType: 'five_hour', resetsAt: reset / 1000 }, at + 41 * 60_000);
  const state = connector.claudeUsageState(at + 41 * 60_000);
  assert.equal(state.fiveHour.observedAt, at);
  assert.equal(state.fiveHour.lastKnownRemainingPercent, 80);
  assert.equal(state.sevenDay.remainingPercent, 2);
  connector.onClaudeRateLimit({ unifiedWindows: { seven_day: { utilization: 0.5 } } }, at + 1);
  assert.equal(connector.claudeUsageState(at + 41 * 60_000).sevenDay.remainingPercent, 2, 'older events are discarded');
});

test('a blocked quota refresh reports completion without spawning a model request', async () => {
  const fixture = desktopFixture(); const { connector, frames } = syncConnector(fixture);
  connector.isConnected = () => true;
  connector.config.configFile = path.join(fixture.root, 'config.json');
  connector.currentClaudeBin = () => fixture.transcript; fs.writeFileSync(fixture.transcript, '');
  connector.claudeCliMatchesDesktop = async () => false;
  connector.claudeSpawnFn = () => { throw new Error('must not consume another account'); };
  const state = await connector.refreshClaudeUsage();
  assert.ok(state.refreshResultAt > 0);
  assert.equal(state.refreshUnavailableReason, 'desktop_refresh_required');
  assert.equal(state.updatedAt, 0);
  assert.ok(frames.some((frame) => frame.kind === 'claude.usage' && frame.payload.refreshResultAt > 0));
});

test('without a Desktop account a CLI organisation is not confirmed to match', async () => {
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  connector.refreshClaudeCliOrg = async () => 'cli-org';
  assert.equal(await connector.claudeCliMatchesDesktop(), false);
});

test('a phone effort is re-applied before a message once the desktop stopped the session process', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  fixture.store.focusedSessionId = () => '';
  const id = 'local_00000000-0000-4000-8000-000000000001';
  connector.claudeThreads.set(id, { id, desktopId: id, sessionId: 's1', model: 'sonnet', effort: 'low', effortOverride: { value: 'low', desktopEffort: 'medium' } });
  const sent = [];
  connector.runDesktopSend = async (desktopId, text) => { sent.push(text); return { ok: true }; };
  connector.desktopShouldTakeClaudeSession = async () => true;
  connector.claudeAttachmentParts = (args) => ({ text: args.text, imagePaths: [] });
  connector.scheduleClaudeTranscriptSync = () => {};
  connector.desktopHoldsClaudeSession = async () => true; // process still running: level still applies
  await connector.deliverClaudeToDesktop(id, { text: '一' });
  connector.desktopHoldsClaudeSession = async () => false; // stopped: a new process starts at "medium"
  await connector.deliverClaudeToDesktop(id, { text: '二' });
  assert.deepEqual(sent, ['一', '/effort low', '二']);
});

test('local slash commands in a transcript do not make an idle session look busy', () => {
  const file = path.join(tmp(), 'local-commands.jsonl');
  const rows = [
    { type: 'assistant', uuid: 'a1', timestamp: '2026-10-09T04:00:00Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '好了' }] } },
    { type: 'user', uuid: 'u1', timestamp: '2026-10-09T07:37:56Z', message: { content: '<command-name>/model</command-name>\n<command-args>sonnet</command-args>' } },
    { type: 'user', uuid: 'u2', timestamp: '2026-10-09T07:37:56Z', message: { content: '<local-command-stdout>Set model to `sonnet`</local-command-stdout>' } },
  ];
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const result = d.readTranscript(file);
  assert.equal(result.lastEvent, 'end_turn');
});

test('a turn the desktop marks blocked (Asked a question) waits for a reply on the phone', async () => {
  await ready();
  const fixture = desktopFixture();
  const id = 'local_00000000-0000-4000-8000-000000000003';
  const write = (summary, extra = {}) => fs.writeFileSync(path.join(fixture.account, `${id}.json`), JSON.stringify({
    sessionId: id, cliSessionId: '33333333-3333-4333-8333-333333333333', cwd: 'C:\proj\c', title: '周末出行计划',
    lastActivityAt: Date.now() - 60_000, lastFocusedAt: Date.now() - 120_000, lastAssistantUuid: 'a1', postTurnSummaryFor: 'a1', postTurnSummary: summary, ...extra }));
  write({ status_category: 'blocked', status_detail: '方案待定', needs_action: '回复出发城市和预算', summarizes_uuid: 'a1' });
  const { connector, frames } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreadStatus(id), 'needs_reply');
  assert.equal(connector.claudeThreadIndexValue(id).note, '等你回复：回复出发城市和预算');
  assert.equal(connector.claudeThreadIndexValue(id).waiting, null, 'no prompt card: the reply goes in the input box');
  assert.ok(connector.claudeActiveThreadRows().some((r) => r.threadId === id && r.status === 'needs_reply'));
  // A reply being worked on shows as running, not as still waiting.
  connector.claude.isRunning = (threadId) => threadId === id;
  assert.equal(connector.claudeThreadStatus(id), 'mobile_running');
  assert.ok(connector.claudeActiveThreadRows().some((r) => r.threadId === id && r.status === 'mobile_running'));
  connector.claude.isRunning = () => false;
  // Looked at on the computer: like the desktop's Blocked list, no longer flagged.
  write({ status_category: 'blocked', needs_action: '回复出发城市和预算', summarizes_uuid: 'a1' }, { lastFocusedAt: Date.now() });
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreadStatus(id), 'completed');
  write({ status_category: 'blocked', needs_action: '回复出发城市和预算', summarizes_uuid: 'a1' });
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreadStatus(id), 'needs_reply');
  // The next answer moves the summary on; a summary of an older message is not trusted.
  write({ status_category: 'blocked', needs_action: '回复出发城市和预算', summarizes_uuid: 'a1' }, { lastAssistantUuid: 'a2' });
  await connector.syncClaudeDesktopSessions();
  assert.equal(connector.claudeThreadStatus(id), 'completed');
  assert.ok(frames.some((f) => f.kind === 'thread.status' && f.threadId === id && f.payload.status === 'completed'));
});

test('blocked summaries: only current, recent and blocked ones count, a prompt comes first', () => {
  const { claudeBlockedText, claudeWaiting } = require('../src/backends/claude-desktop-sync');
  const now = Date.now();
  const blocked = { current: true, category: 'blocked', detail: '方案待定', needsAction: '' };
  assert.equal(claudeBlockedText(blocked, now, now), '等你回复：方案待定', 'detail when no action is named');
  assert.equal(claudeBlockedText({ ...blocked, detail: '' }, now, now), 'Claude 在等你回复');
  assert.equal(claudeBlockedText({ ...blocked, current: false }, now, now), '');
  assert.equal(claudeBlockedText({ ...blocked, category: 'done' }, now, now), '');
  assert.equal(claudeBlockedText(blocked, now - 3 * 86_400_000, now), '', 'an old unanswered question is not news');
  assert.equal(claudeBlockedText(null, now, now), '');
  const session = { updatedAt: now, turnSummary: blocked };
  assert.equal(claudeWaiting(session, { tool: 'Bash', at: 5 }).waitingCategory, 'prompt');
  assert.equal(claudeWaiting(session, null).waitingCategory, 'blocked');
  assert.equal(claudeWaiting({ updatedAt: now }, null).waitingCategory, null);
  assert.equal(claudeWaiting(session, null, false).waitingCategory, null, 'seen on the computer');
  assert.equal(claudeWaiting({ ...session, spawned: true, turnReported: true }, null).waitingCategory, null, 'reported to the session that started it');
  assert.equal(claudeWaiting({ ...session, spawned: true }, null).waitingCategory, 'blocked', 'started by a session but nothing reported yet');
  assert.equal(claudeWaiting({ ...session, sideWakes: 3 }, null).waitingCategory, null, 'woken by side sessions, not the user');
  assert.equal(claudeWaiting({ ...session, sideWakes: 3 }, { tool: 'Bash', at: 1 }).waitingCategory, 'prompt', 'a live prompt still waits');
  const first = claudeWaiting(session, null, true, null, now + 5);
  assert.equal(first.waitingAt, now + 5, 'stamped when first seen, after the turn ended');
  assert.equal(claudeWaiting(session, null, true, first, now + 99).waitingAt, now + 5, 'and kept while unchanged');
  assert.equal(claudeWaiting(session, null, true, { ...first, waitingAt: now - 1 }, now + 99).waitingAt, now + 99, 'a stamp from before the turn ended is redone');
  assert.equal(claudeWaiting(session, { tool: 'Bash', at: 5 }, false).waitingCategory, 'prompt', 'a prompt waits regardless');
});

test('files sent with SendUserFile become one sentFiles item, sizes filled in from the result', () => {
  const { store, transcript } = desktopFixture();
  const call = line({ type: 'assistant', uuid: 'send', timestamp: '2026-10-21T01:00:00Z', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'SendUserFile',
    input: { files: ['J:\\mov\\ep1\\video.mp4', 'J:\\mov\\ep1\\cover.jpg', 'J:\\mov\\ep1\\script.json'], caption: '第 1 期样片和封面', status: 'normal' } }] } });
  const result = line({ type: 'user', uuid: 'res', timestamp: '2026-10-21T01:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '3 files delivered to user.' }] },
    toolUseResult: { caption: '第 1 期样片和封面', attachments: [
      { path: 'J:\\mov\\ep1\\video.mp4', size: 39147024, isImage: false, media_type: 'video/mp4' },
      { path: 'J:\\mov\\ep1\\cover.jpg', size: 405166, isImage: true, media_type: 'image/jpeg' },
      { path: 'J:\\mov\\ep1\\script.json', size: 900, isImage: false, media_type: 'application/json' }] } });
  fs.writeFileSync(transcript, call + result);
  const file = store.transcriptFor(store.listSessions().find((s) => s.title === '00 总纲'));
  const whole = d.readTranscript(file);
  const sent = whole.items.filter((i) => i.type === 'sentFiles');
  assert.equal(sent.length, 1, 'one item, not a tool row');
  assert.equal(sent[0].text, '第 1 期样片和封面');
  assert.deepEqual(sent[0].files.map((f) => [f.name, f.kind, f.size]), [['video.mp4', 'video', 39147024], ['cover.jpg', 'image', 405166], ['script.json', 'file', 900]]);
  assert.equal(sent[0].status, 'completed');
  assert.ok(!whole.items.some((i) => i.type === 'mcpToolCall'));
  // Call and result in two reads: the card waits, then gets its sizes.
  fs.writeFileSync(transcript, call);
  const first = d.readTranscript(file);
  assert.equal(first.items[0].files[0].size, undefined);
  fs.appendFileSync(transcript, result);
  const next = d.readTranscript(file, first.offset, first.lineCount, first);
  assert.equal(next.items[0].id, first.items[0].id);
  assert.equal(next.items[0].files[1].size, 405166);
});

test('a desktop answer that lands while Claude redraws is tried once more, only while the prompt is still there', async () => {
  const connector = Object.create(Connector.prototype);
  const logs = [];
  connector.log = (line) => logs.push(String(line)); connector.answerPollMs = 1; connector.answerRetryMs = 1;
  connector.syncClaudeDesktopSessions = async () => {};
  const desktopId = 'local_00000000-0000-4000-8000-0000000000cc';
  let pending = new Map([[desktopId, { requestId: 'q1', tool: 'AskUserQuestion' }]]);
  connector.claudeDesktop = { pendingPrompts: () => pending, focusedSessionId: () => desktopId };
  connector.claudeThreads = new Map([['t', { id: 't', desktopId, waitingDetail: { kind: 'question', requestId: 'q1', questions: [{ question: '选哪个？', multiSelect: false, options: [{ label: 'A' }] }] } }]]);
  // First run: the card is not drawn yet. Second run answers it.
  let runs = 0;
  connector.execFileFn = (cmd, args, opts, cb) => {
    runs += 1;
    assert.ok(fs.existsSync(args[args.indexOf('-Choice') + 1]), 'choice file still there for the second run');
    if (runs === 1) cb(null, '{"ok":false,"reason":"prompt_mismatch"}');
    else { pending = new Map(); cb(null, '{"ok":true}'); }
  };
  assert.equal((await connector.answerClaudeOnDesktop('t', { requestId: 'q1', choices: ['A'] })).answered, true);
  assert.equal(runs, 2);
  assert.ok(logs.some((line) => /retry after prompt_mismatch/.test(line)));
  // The click did go through, just late: no second click.
  runs = 0; pending = new Map([[desktopId, { requestId: 'q1', tool: 'AskUserQuestion' }]]);
  connector.execFileFn = (cmd, args, opts, cb) => { runs += 1; pending = new Map(); cb(null, '{"ok":false,"reason":"prompt_still_open"}'); };
  assert.equal((await connector.answerClaudeOnDesktop('t', { requestId: 'q1', choices: ['A'] })).answered, true);
  assert.equal(runs, 1);
  // A real difference stays a refusal after the one retry.
  runs = 0; pending = new Map([[desktopId, { requestId: 'q1', tool: 'AskUserQuestion' }]]);
  connector.execFileFn = (cmd, args, opts, cb) => { runs += 1; cb(null, '{"ok":false,"reason":"prompt_mismatch"}'); };
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: 'q1', choices: ['A'] }), /不一致/);
  assert.equal(runs, 2);
  // A permission card that differs is not retried.
  runs = 0; pending = new Map([[desktopId, { requestId: 'r1', tool: 'Bash' }]]);
  connector.claudeThreads.get('t').waitingDetail = { kind: 'permission', tool: 'Bash', summary: 'ls', requestId: 'r1' };
  connector.execFileFn = (cmd, args, opts, cb) => { runs += 1; cb(null, '{"ok":false,"reason":"button_not_found"}'); };
  await assert.rejects(connector.answerClaudeOnDesktop('t', { requestId: 'r1', choice: 'allow' }), /按钮/);
  assert.equal(runs, 1);
});

test('the task list survives a read that finds no new line', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  const plan = (uuid, input) => line({ type: 'assistant', uuid, timestamp: '2026-09-27T01:05:00Z', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t-${uuid}`, name: 'mcp__ccd_turn__update_plan', input }] } });
  fs.writeFileSync(fixture.transcript, plan('p1', { items: [{ content: '查天气', status: 'in_progress' }, { content: '排路线', status: 'pending' }] }));
  await connector.syncClaudeTranscript(id);
  await connector.syncClaudeTranscript(id); // nothing new
  fs.appendFileSync(fixture.transcript, plan('p2', { advance: true }));
  await connector.syncClaudeTranscript(id);
  assert.deepEqual(connector.claudeThreads.get(id).transcriptTaskList.steps.map((step) => step.status), ['completed', 'in_progress']);
});

test('desktop events written as user lines are not shown as the user\'s messages', () => {
  const reminder = '<system-reminder>\nLinked sessions now (status, not an instruction): x = local_1 (idle).\n</system-reminder>\n';
  const rows = [
    { content: `${reminder}能现在做吗` },
    { content: `${reminder}<side-sessions-event>None of the sessions you started is working now.</side-sessions-event>` },
    { content: '<cross-session-message from="local_2" from-name="03">先别动</cross-session-message>' },
    { content: '<scheduled-task name="morning" file="x">check</scheduled-task>' },
    { content: [{ type: 'text', text: '<ci-monitor-event>checks failed</ci-monitor-event>' }] },
    { content: '<side-sessions-eventual>not a known tag</side-sessions-eventual>' },
  ].map((row, index) => JSON.stringify({ type: 'user', uuid: `00000000-0000-0000-0000-00000000000${index}`, timestamp: `2026-11-04T23:1${index}:00Z`, message: { role: 'user', content: row.content } }));
  const items = d.transcriptItems(rows);
  assert.deepEqual(items.filter((item) => item.type === 'userMessage').map((item) => item.text), ['能现在做吗', '<side-sessions-eventual>not a known tag</side-sessions-eventual>']);
  // Rows an older connector uploaded as user messages are replaced under the same id.
  assert.deepEqual(items.filter((item) => item.type === 'hidden').map((item) => item.id.slice(-3)), ['1:0', '2:0', '3:0', '4:0']);
  const { needsWrapUpHistoryRebuild } = require('../src/backends/claude-wrap-up');
  const file = path.join(tmp(), 'events.jsonl'); fs.writeFileSync(file, rows.join('\n') + '\n');
  assert.equal(needsWrapUpHistoryRebuild(file, 9), true);
  assert.equal(needsWrapUpHistoryRebuild(file, 10), false);
});

test('a permission mode changed on the desktop reaches the phone as thread settings', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, frames } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000002';
  assert.equal(frames.filter((f) => f.kind === 'thread.settings').length, 0, 'the first scan sends no settings');
  const file = path.join(fixture.account, `${id}.json`);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...meta, permissionMode: 'auto' })); fixture.store.metaCache?.clear?.();
  await connector.syncClaudeDesktopSessions();
  const sent = frames.filter((f) => f.kind === 'thread.settings' && f.threadId === id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.settings.permissionMode, 'auto');
  await connector.syncClaudeDesktopSessions();
  assert.equal(frames.filter((f) => f.kind === 'thread.settings').length, 1, 'nothing more while it stays the same');
});

test('a question card missing from the transcript is read from the window and answered by its option names', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  const session = fixture.store.listSessions()[0];
  fixture.store.pendingPrompts = () => new Map([[session.desktopId, { requestId: 'q1', tool: 'AskUserQuestion', at: 1234 }]]);
  fixture.store.focusedSessionId = () => session.desktopId;
  const card = {
    desktopId: session.desktopId, multi: false,
    question: "Opus 5.5's safeguards flagged this session. Switch to Opus 4.8 and keep going whenever this happens?",
    options: [
      { label: 'Switch automatically', description: 'Continue on Opus 4.8 now, and switch without asking from now on' },
      { label: 'Stay on Opus 5.5', description: 'Stop here without switching, and ask me each time a message is flagged' },
    ],
  };
  const calls = [];
  connector.execFileFn = (file, args, options, callback) => {
    calls.push(args);
    callback(null, JSON.stringify({ ok: true, prompt: { desktopId: session.desktopId, questionCard: card } }));
  };
  await connector.syncClaudeDesktopSessions();
  const meta = connector.claudeThreads.get(session.desktopId);
  assert.equal(meta.waitingDetail.kind, 'question');
  assert.equal(meta.waitingDetail.requestId, 'q1');
  assert.deepEqual(meta.waitingDetail.questions[0].options.map((o) => o.label), ['Switch automatically', 'Stay on Opus 5.5']);
  assert.ok(calls[0].includes('-NoNavigate'));
  await connector.syncClaudeDesktopSessions();
  assert.equal(calls.length, 1, 'a known question is not read from the window again');

  // Answering clicks the option the phone picked, matched by label and description.
  let pages = null;
  connector.claudeDesktop.pendingPrompts = () => new Map([[session.desktopId, { requestId: 'q1', tool: 'AskUserQuestion' }]]);
  connector.syncClaudeDesktopSessions = async () => {};
  connector.execFileFn = (file, args, options, callback) => {
    pages = JSON.parse(fs.readFileSync(args[args.indexOf('-Choice') + 1], 'utf8'));
    callback(null, '{"ok":true}\n');
  };
  await connector.answerClaudeOnDesktop(session.desktopId, { requestId: 'q1', answers: [{ labels: ['Stay on Opus 5.5'] }] });
  assert.equal(pages[0].question, card.question);
  assert.deepEqual(pages[0].options.map((o) => [o.name, o.chosen]), [
    ['Switch automatically Continue on Opus 4.8 now, and switch without asking from now on', false],
    ['Stay on Opus 5.5 Stop here without switching, and ask me each time a message is flagged', true],
  ]);
});

test('a turn end read before a reload is saved with the offset, not after the uploads', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  const now = Date.now();
  fs.writeFileSync(fixture.transcript,
    line({ type: 'user', uuid: 'u1', timestamp: new Date(now - 2000).toISOString(), message: { content: '查一下' } }) +
    line({ type: 'assistant', uuid: 'a1', timestamp: new Date(now - 1000).toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '查完了' }] } }));
  connector.setClaudeThreadFields(id, { transcriptFile: fixture.transcript, transcriptOffset: 0, transcriptLines: 0, transcriptSchema: 11,
    transcriptTerminalStatus: null, transcriptLastEvent: 'user', transcriptLastEventAt: now - 5000, transcriptWatched: true });
  // The connector is replaced while the history upload is in flight.
  let release; connector.uploadClaudeHistoryItems = () => new Promise((resolve) => { release = resolve; });
  const reading = connector.syncClaudeTranscript(id);
  await new Promise((r) => setImmediate(r));
  assert.equal(connector.claudeThreads.get(id).transcriptLastEvent, 'end_turn', 'saved before the upload finishes');
  assert.equal(connector.claudeDesktopBusy(id), false);
  release(); await reading;
});

test('on start, a turn saved as open is checked against the transcript and the phone is told it ended', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector, frames } = syncConnector(fixture);
  const id = 'local_00000000-0000-4000-8000-000000000001';
  const now = Date.now();
  fs.writeFileSync(fixture.transcript,
    line({ type: 'user', uuid: 'u1', timestamp: new Date(now - 30 * 60_000).toISOString(), message: { content: '查一下' } }) +
    line({ type: 'assistant', uuid: 'a1', timestamp: new Date(now - 29 * 60_000).toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '查完了' }] } }));
  connector.claudeThreads.set(id, { id, sessionId: 's1', transcriptFile: fixture.transcript, transcriptOffset: fs.statSync(fixture.transcript).size,
    transcriptLastEvent: 'user', transcriptLastEventAt: now - 30 * 60_000 });
  const published = []; connector.syncClaudeThreadMetadata = async (threadId) => { published.push(threadId); };
  await connector.recheckClaudeOpenTurns();
  assert.equal(connector.claudeThreads.get(id).transcriptLastEvent, 'end_turn');
  assert.deepEqual(published, [id]);
  assert.ok(frames.some((f) => f.kind === 'thread.status' && f.threadId === id && f.payload.status === 'completed'));
  frames.length = 0;
  await connector.recheckClaudeOpenTurns();
  assert.equal(frames.length, 0, 'only once per start');
});

test('a running turn that goes quiet past the busy window is announced as no longer running', async () => {
  const connector = Object.create(Connector.prototype);
  const id = 'local_00000000-0000-4000-8000-000000000001';
  connector.claudeThreads = new Map([[id, { id, transcriptLastEvent: 'user', transcriptLastEventAt: Date.now() - 60_000 }]]);
  connector.claude = { isRunning: () => false };
  const frames = []; connector.emit = (kind, threadId, payload) => frames.push({ kind, threadId, payload });
  const published = []; connector.syncClaudeThreadMetadata = async (threadId) => { published.push(threadId); };
  assert.equal(connector.claudeActiveThreadRows()[0].status, 'desktop_running', 'the heartbeat shows it running');
  await connector.announceClaudeBusyExpiry();
  assert.equal(frames.length, 0, 'still running: nothing to announce');
  connector.claudeThreads.get(id).transcriptLastEventAt = Date.now() - 21 * 60_000;
  await connector.announceClaudeBusyExpiry();
  assert.deepEqual(frames.map((f) => [f.threadId, f.payload.status, f.payload.quiet]), [[id, 'completed', true]]);
  assert.deepEqual(published, [id]);
  await connector.announceClaudeBusyExpiry();
  assert.equal(frames.length, 1, 'announced once');
});

test('callers waiting on one transcript read run one after another', async () => {
  await ready();
  const fixture = desktopFixture(); const { connector } = syncConnector(fixture);
  await connector.syncClaudeDesktopSessions();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(fixture.transcript, line({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { content: '你好' } }));
  connector.setClaudeThreadFields(id, { transcriptFile: fixture.transcript, transcriptOffset: 0, transcriptLines: 0, transcriptSchema: 11, transcriptWatched: true });
  let active = 0; let most = 0;
  connector.uploadClaudeHistoryItems = async () => { active++; most = Math.max(most, active); await new Promise((r) => setTimeout(r, 20)); active--; };
  const first = connector.syncClaudeTranscript(id);
  fs.appendFileSync(fixture.transcript, line({ type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '在' }] } }));
  await Promise.all([first, connector.syncClaudeTranscript(id), connector.syncClaudeTranscript(id)]);
  assert.equal(most, 1);
  assert.equal(connector.claudeThreads.get(id).transcriptLastEvent, 'end_turn');
});

test('the phone can read a background session\'s prompt: open it, read the card, return to the session in view', async () => {
  const connector = Object.create(Connector.prototype);
  const id = 'local_00000000-0000-4000-8000-0000000000cc';
  const inView = 'local_00000000-0000-4000-8000-0000000000dd';
  connector.claudeThreads = new Map([[id, { id, desktopId: id }]]);
  let pending = new Map([[id, { requestId: 'q9', tool: 'AskUserQuestion' }]]);
  connector.claudeDesktop = { pendingPrompts: () => pending, focusedSessionId: () => inView };
  connector.saveClaudeThreads = () => {}; connector.log = () => {};
  const frames = []; connector.emit = (kind, threadId, payload) => frames.push({ kind, threadId, payload });
  const published = []; connector.syncClaudeThreadMetadata = async (threadId) => { published.push(threadId); };
  const card = { desktopId: id, multi: false, question: 'Switch to Opus 4.8?', options: [{ label: 'Switch automatically', description: 'a' }, { label: 'Stay on Opus 5.5', description: 'b' }] };
  const calls = [];
  connector.execFileFn = (file, args, options, callback) => { calls.push(args); callback(null, JSON.stringify({ ok: true, prompt: { desktopId: id, questionCard: card } })); };
  assert.deepEqual(await connector.readClaudeDesktopPrompt(id), { read: true });
  assert.ok(!calls[0].includes('-NoNavigate'), 'opens the session');
  assert.equal(calls[0][calls[0].indexOf('-RestoreId') + 1], inView, 'and returns to the one in view');
  const detail = connector.claudeThreads.get(id).waitingDetail;
  assert.deepEqual([detail.requestId, detail.questions[0].allowOther], ['q9', false]);
  assert.deepEqual(published, [id]);
  assert.ok(frames.some((f) => f.kind === 'thread.status'));
  // Answered on the computer while it was being read: nothing is replaced.
  connector.claudeThreads.get(id).waitingDetail = null;
  connector.execFileFn = (file, args, options, callback) => { pending = new Map(); callback(null, JSON.stringify({ ok: true, prompt: { desktopId: id, questionCard: card } })); };
  assert.equal((await connector.readClaudeDesktopPrompt(id)).read, false);
  assert.equal(connector.claudeThreads.get(id).waitingDetail, null);
  await assert.rejects(connector.readClaudeDesktopPrompt(id), /没有在等你回答/);
});

test('a card read from the window answers by the button\'s own name and gives way to the transcript\'s question', async () => {
  const { desktopQuestionDetail } = require('../src/backends/claude-desktop-prompts');
  const id = 'local_00000000-0000-4000-8000-0000000000ee';
  const long = 'x'.repeat(300);
  const snapshot = { desktopId: id, questionCard: { desktopId: id, question: 'Switch?', options: [
    { label: 'Yes', description: long, name: `Yes ${long}` }, { label: 'No', description: '', name: 'No' }] } };
  const detail = desktopQuestionDetail(snapshot, { requestId: 'q1', tool: 'AskUserQuestion' }, id);
  assert.deepEqual(detail.questions[0].options.map((o) => o.name), [`Yes ${long}`, 'No'], 'full names, not label + clipped description');
  // Later the transcript has the real question: it replaces the window card.
  const connector = Object.create(Connector.prototype);
  connector.claudeDesktop = { projectsRoot: tmp() };
  const session = { desktopId: id, cwd: 'C:\w', cliSessionId: 'cli' };
  const prior = { waitingRequestId: 'q1', waitingDetail: { ...detail } };
  const kept = connector.claudeWaitingDetail(prior, session, { requestId: 'q1', tool: 'AskUserQuestion' });
  assert.equal(kept.waitingDetail, prior.waitingDetail, 'kept while the transcript has nothing');
  const file = path.join(connector.claudeDesktop.projectsRoot, d.projectDirName(session.cwd), `${session.cliSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion',
    input: { questions: [{ question: 'Page one?', options: [{ label: 'A' }, { label: 'B' }] }, { question: 'Page two?', options: [{ label: 'C' }, { label: 'D' }] }] } }] } }) + '\n');
  const replaced = connector.claudeWaitingDetail(prior, session, { requestId: 'q1', tool: 'AskUserQuestion' });
  assert.deepEqual(replaced.waitingDetail.questions.map((q) => q.question), ['Page one?', 'Page two?']);
});
