const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Connector } = require('../src/connector');

// A fake powershell: records the call, reads the title/name files, answers like the script.
function fakeExec(calls, answer = { ok: true, state: 'done' }, onRun = () => {}) {
  return (file, args, options, callback) => {
    const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
    const call = { app: arg('-App'), action: arg('-Action'), title: fs.readFileSync(arg('-TitleFile'), 'utf8'), name: arg('-NameFile') ? fs.readFileSync(arg('-NameFile'), 'utf8') : null };
    calls.push(call); onRun(call);
    setImmediate(() => callback(null, `${JSON.stringify(answer)}\n`));
  };
}

function codexConnector(dir, threads, pinnedIds) {
  const connector = Object.create(Connector.prototype);
  connector.desktopStateFile = path.join(dir, '.codex-global-state.json');
  const writePins = (ids) => fs.writeFileSync(connector.desktopStateFile, JSON.stringify({ 'pinned-thread-ids': ids, extra: 'x'.repeat(ids.length) }));
  writePins(pinnedIds);
  connector.codex = { request: async (method, params) => {
    if (method === 'thread/read') return { thread: threads.find((t) => t.id === params.threadId) };
    if (method === 'thread/list') return { data: threads };
    throw new Error(method);
  } };
  return { connector, writePins };
}

test('Codex pin: done on the desktop and confirmed from its saved pins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-sidebar-'));
  const threads = [{ id: 'a', name: '了凡四训' }, { id: 'b', name: '你好' }];
  const { connector, writePins } = codexConnector(dir, threads, ['b']);
  const calls = [];
  connector.execFileFn = fakeExec(calls, { ok: true, state: 'done' }, () => writePins(['b', 'a']));
  assert.deepEqual(await connector.pinCodexOnDesktop('a', true), { pinned: true, changed: true });
  assert.deepEqual(calls, [{ app: 'codex', action: 'pin', title: '了凡四训', name: null }]);
  // Already in the wanted state: the desktop is not touched.
  assert.deepEqual(await connector.pinCodexOnDesktop('a', true), { pinned: true, changed: false });
  assert.equal(calls.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Codex pin: another recent task with the same title is refused, nothing clicked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-sidebar-'));
  const { connector } = codexConnector(dir, [{ id: 'a', name: '你好' }, { id: 'b', preview: '你好' }], []);
  const calls = []; connector.execFileFn = fakeExec(calls);
  await assert.rejects(connector.pinCodexOnDesktop('a', true), /同名/);
  assert.equal(calls.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Codex pin: the script said done but the desktop did not save it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-sidebar-'));
  const { connector } = codexConnector(dir, [{ id: 'a', name: 'x' }], []);
  connector.execFileFn = fakeExec([]);
  const { waitUntil } = require('../src/desktop-sidebar');
  assert.equal(await waitUntil(() => false, { timeoutMs: 50, stepMs: 10 }), false);
  connector.execFileFn = fakeExec([], { ok: false, reason: 'row_not_found' });
  await assert.rejects(connector.pinCodexOnDesktop('a', true), /侧边栏里没找到/);
  fs.rmSync(dir, { recursive: true, force: true });
});

function claudeConnector(sessions) {
  const connector = Object.create(Connector.prototype);
  connector.claudeThreads = new Map(sessions.map((s) => [s.desktopId, { desktopId: s.desktopId, title: s.title, archived: false }]));
  connector.claudeDesktop = { listSessions: () => sessions.map((s) => ({ ...s })) };
  connector.syncClaudeDesktopSessions = async () => {};
  connector.log = () => {};
  return connector;
}

test('Claude pin and rename go through the desktop sidebar and wait for it', async () => {
  const sessions = [{ desktopId: 'local_1', title: 'Stop Pi errors', pinned: false }, { desktopId: 'local_2', title: '你好', pinned: true }];
  const connector = claudeConnector(sessions);
  const calls = [];
  connector.execFileFn = fakeExec(calls, { ok: true, state: 'done' }, (call) => {
    const session = sessions.find((s) => s.title === call.title);
    if (call.action === 'pin') session.pinned = true;
    if (call.action === 'unpin') session.pinned = false;
    if (call.action === 'rename') session.title = call.name;
  });
  assert.deepEqual(await connector.pinClaudeOnDesktop('local_1', true), { pinned: true, changed: true });
  assert.deepEqual(await connector.pinClaudeOnDesktop('local_2', true), { pinned: true, changed: false }, 'already pinned');
  assert.deepEqual(await connector.renameClaudeOnDesktop('local_1', '  Stop  Pi errors (new) '), { renamed: true, changed: true });
  assert.deepEqual(calls.map((c) => [c.action, c.title, c.name]), [['pin', 'Stop Pi errors', null], ['rename', 'Stop Pi errors', 'Stop Pi errors (new)']]);
});

test('Claude sidebar actions refuse a duplicated title and an empty name', async () => {
  const connector = claudeConnector([{ desktopId: 'local_1', title: '你好', pinned: false }, { desktopId: 'local_2', title: '你好', pinned: false }]);
  const calls = []; connector.execFileFn = fakeExec(calls);
  await assert.rejects(connector.pinClaudeOnDesktop('local_1', true), /同名/);
  await assert.rejects(connector.renameClaudeOnDesktop('local_1', '   '), /不能为空/);
  assert.equal(calls.length, 0);
});

test('Codex rename goes through the desktop app, then our app-server; without the desktop, ours alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-sidebar-'));
  const { connector } = codexConnector(dir, [{ id: '01a0f1fb-9771-7932-8f06-fd8dbcad5a85', name: '小熊猫' }], []);
  const requests = [];
  const read = connector.codex.request;
  connector.codex.request = async (method, params) => { if (method === 'thread/name/set') { requests.push(params); return {}; } return read(method, params); };
  connector.refreshCodexThreadIndex = async () => {};
  const calls = []; connector.execFileFn = fakeExec(calls);
  assert.deepEqual(await connector.renameCodexOnDesktop('01a0f1fb-9771-7932-8f06-fd8dbcad5a85', ' 小熊猫  新 '), { renamed: true, desktop: true });
  assert.deepEqual(calls, [{ app: 'codex', action: 'rename', title: '小熊猫', name: '小熊猫 新' }]);
  assert.deepEqual(requests, [{ threadId: '01a0f1fb-9771-7932-8f06-fd8dbcad5a85', name: '小熊猫 新' }]);
  connector.execFileFn = fakeExec([], { ok: false, reason: 'desktop_not_running' });
  assert.deepEqual(await connector.renameCodexOnDesktop('01a0f1fb-9771-7932-8f06-fd8dbcad5a85', '小熊猫'), { renamed: true, desktop: false });
  connector.execFileFn = fakeExec([], { ok: false, reason: 'menu_not_found' });
  await assert.rejects(connector.renameCodexOnDesktop('01a0f1fb-9771-7932-8f06-fd8dbcad5a85', 'x'), /菜单/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Claude archive and unarchive are done on the desktop and confirmed from its record', async () => {
  const sessions = [{ desktopId: 'local_1', title: 'Acknowledgment', pinned: false, archived: false }];
  const connector = claudeConnector(sessions);
  const upserts = []; connector.upsertClaudeThread = (id, changes) => { upserts.push([id, changes]); return { id, ...changes }; };
  const calls = [];
  connector.execFileFn = fakeExec(calls, { ok: true, state: 'done' }, (call) => {
    if (call.action === 'archive') sessions[0].archived = true;
    if (call.action === 'unarchive') sessions[0].archived = false;
  });
  assert.deepEqual(await connector.archiveClaudeOnDesktop('local_1', true), { archived: true, changed: true });
  connector.claudeThreads.get('local_1').archived = true;
  // Already archived on the desktop: nothing clicked, our record follows it.
  assert.deepEqual(await connector.archiveClaudeOnDesktop('local_1', true), { archived: true, changed: false });
  assert.deepEqual(await connector.archiveClaudeOnDesktop('local_1', false), { archived: false, changed: true });
  assert.deepEqual(calls.map((c) => [c.action, c.title]), [['archive', 'Acknowledgment'], ['unarchive', 'Acknowledgment']]);
  assert.deepEqual(upserts, [['local_1', { archived: true }]]);
});

test('Claude archive: a failure on the desktop is reported, never pretended', async () => {
  const sessions = [{ desktopId: 'local_1', title: 'Acknowledgment', pinned: false, archived: false }];
  const connector = claudeConnector(sessions);
  connector.upsertClaudeThread = () => { throw new Error('must not mark it archived locally'); };
  connector.execFileFn = fakeExec([], { ok: false, reason: 'desktop_not_running' });
  await assert.rejects(connector.archiveClaudeOnDesktop('local_1', true), /电脑端没有打开/);
  connector.execFileFn = fakeExec([], { ok: false, reason: 'status_not_set' });
  connector.claudeThreads.get('local_1').archived = true; sessions[0].archived = true;
  await assert.rejects(connector.archiveClaudeOnDesktop('local_1', false), /已归档/);
  // The script said done but the desktop record never changed.
  sessions[0].archived = false; connector.claudeThreads.get('local_1').archived = false;
  connector.execFileFn = fakeExec([], { ok: true, state: 'done' });
  const { methods } = require('../src/backends/claude-desktop-sync');
  assert.equal(typeof methods.archiveClaudeOnDesktop, 'function');
  sessions.length = 0;
  await assert.rejects(connector.archiveClaudeOnDesktop('local_1', true), /找不到/);
});

test('Claude archive: a session left in the sidebar filter is reported with the result', async () => {
  const sessions = [{ desktopId: 'local_1', title: 'A', pinned: false, archived: true }];
  const connector = claudeConnector(sessions);
  connector.claudeThreads.get('local_1').archived = true;
  connector.execFileFn = fakeExec([], { ok: true, state: 'status_not_restored:Active' }, () => { sessions[0].archived = false; });
  const result = await connector.archiveClaudeOnDesktop('local_1', false);
  assert.equal(result.archived, false);
  assert.match(result.reason, /筛选/);
});

test('thread.archive on a desktop Claude session goes to the desktop, not just our list', async () => {
  const connector = claudeConnector([{ desktopId: 'local_1', title: 'A', pinned: false, archived: false }]);
  connector.config = {}; connector.ensureClaudeSession = () => {};
  const seen = []; connector.archiveClaudeOnDesktop = async (id, archived) => { seen.push([id, archived]); return { archived, changed: true }; };
  connector.upsertClaudeThread = () => { throw new Error('must not write our record directly'); };
  assert.deepEqual(await connector.executeClaudeCommand('thread.archive', { threadId: 'local_1', archived: true }), { archived: true, changed: true });
  assert.deepEqual(seen, [['local_1', true]]);
});

test('a sidebar script that fails, times out or prints nonsense is explained in Chinese', async () => {
  const { runSidebarScript, sidebarError } = require('../src/desktop-sidebar');
  const run = (error, stdout) => runSidebarScript({ app: 'claude', action: 'archive', title: 'A', execFileFn: (file, args, options, callback) => setImmediate(() => callback(error, stdout)) });
  const failed = await run(Object.assign(new Error('Command failed: powershell.exe'), { killed: false }), '');
  assert.equal(failed.reason, 'script_failed');
  assert.equal((await run(Object.assign(new Error('timeout'), { killed: true }), '')).reason, 'timeout');
  assert.equal((await run(null, 'The argument "x.ps1" to the -File parameter does not exist.\r\n')).reason, 'bad_output');
  for (const reason of ['script_failed', 'timeout', 'bad_output']) assert.doesNotMatch(sidebarError(reason).message, /[a-z]_[a-z]/);
});
