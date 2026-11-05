const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { methods, waitingFor, toolKind, turnStatus, threadIdOf, sessionIdOf } = require('../src/backends/dsh-sync');

function event(type, seq, data) { return { type, seq, time: 1_700_000_000_000 + seq, data }; }

test('thread ids are prefixed without losing the DSH session id', () => {
  assert.equal(threadIdOf('session-abc'), 'dsh-session-abc');
  assert.equal(sessionIdOf('dsh-session-abc'), 'session-abc');
  assert.equal(sessionIdOf('task-1'), null);
});

test('maps user, reasoning, agent text and tool call/result into stable items', () => {
  const meta = { pendingCalls: {} };
  const ctx = { dshItemsForEvent: methods.dshItemsForEvent };
  const user = methods.dshItemsForEvent.call(ctx, 'dsh-s1', meta, event('user/message', 1, { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }));
  assert.equal(user.length, 1);
  assert.equal(user[0].value.type, 'userMessage');
  assert.equal(user[0].value.text, '你好');

  const assistant = methods.dshItemsForEvent.call(ctx, 'dsh-s1', meta, event('assistant/message', 2, { message: { content: [
    { type: 'reasoning', text: '想一想' }, { type: 'text', text: '答案' },
  ] } }));
  assert.deepEqual(assistant.map((item) => item.value.type), ['reasoning', 'agentMessage']);
  assert.equal(assistant[1].value.text, '答案');

  const call = methods.dshItemsForEvent.call(ctx, 'dsh-s1', meta, event('tool/call', 3, { callId: 'c1', name: 'pwsh', arguments: '{"command":"Get-Date"}' }));
  assert.equal(call[0].value.type, 'commandExecution');
  assert.equal(call[0].value.status, 'inProgress');
  const result = methods.dshItemsForEvent.call(ctx, 'dsh-s1', meta, event('tool/result', 4, { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: '现在' }] } }));
  assert.equal(result[0].id, call[0].id);
  assert.equal(result[0].value.status, 'completed');
  assert.match(result[0].value.text, /现在/);
});

test('DSH user history keeps images including image-only turns for display and receipts', () => {
  const ctx = { dshItemsForEvent: methods.dshItemsForEvent };
  const png = Buffer.from('test image').toString('base64');
  const user = methods.dshItemsForEvent.call(ctx, 'dsh-s1', {}, event('user/message', 1, {
    source: { kind: 'user' }, content: [{ type: 'image', mediaType: 'image/png', data: png }],
  }));
  assert.equal(user[0].value.text, '图片附件');
  assert.deepEqual(user[0].value.images, [{ mimeType: 'image/png', data: `data:image/png;base64,${png}` }]);
  const mixed = methods.dshItemsForEvent.call(ctx, 'dsh-s1', {}, event('user/message', 2, {
    source: { kind: 'user' }, message: { content: [{ type: 'text', text: '看图' }, { type: 'image', source: { media_type: 'image/png', data: png } }] },
  }));
  assert.equal(mixed[0].value.text, '看图'); assert.equal(mixed[0].value.images.length, 1);
});

test('DSH attachment-reference events restore only the matching phone receipt preview', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-dsh-image-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const image = Buffer.from('isolated test image'); const file = path.join(dir, 'test.png'); fs.writeFileSync(file, image);
  const receipt = { backend: 'dsh', threadId: 'dsh-s1', attachments: [{ path: file, mimeType: 'image/png', name: 'test.png' }] };
  const ctx = { sendReceipts: { get: (id) => id === 'own' ? receipt : null } };
  const make = (rpcId) => event('user/message', 89, { source: { kind: 'user', rpcId }, content: [
    { type: 'image', attachment: { attachmentId: 'host-ref', mediaType: 'image/png', bytes: image.length } },
  ] });
  const [own] = methods.dshItemsForEvent.call(ctx, 'dsh-s1', {}, make('own'));
  assert.equal(own.receiptRequestId, 'own'); assert.equal(own.receiptImageCount, 1);
  assert.deepEqual(own.value.images, [{ mimeType: 'image/png', data: `data:image/png;base64,${image.toString('base64')}` }]);
  assert.equal(JSON.stringify(own.value).includes(file), false);
  const [other] = methods.dshItemsForEvent.call(ctx, 'dsh-other', {}, make('own'));
  assert.equal(other.value.text, '图片附件（预览不可用）'); assert.equal(other.value.images, undefined);
  const [desktop] = methods.dshItemsForEvent.call(ctx, 'dsh-s1', {}, make('desktop'));
  assert.equal(desktop.value.images, undefined);
  fs.unlinkSync(file);
  const [expired] = methods.dshItemsForEvent.call(ctx, 'dsh-s1', {}, make('own'));
  assert.equal(expired.value.images, undefined);
});

test('DSH running queue and steer pass image blocks and request identity through', async () => {
  const image = { mediaType: 'image/png', data: 'dGVzdA==' }; const calls = [];
  const ctx = { ...methods, dshThreads: new Map([['dsh-s', { sessionId: 's', cwd: 'I:/tmp/khlink-test', running: true }]]),
    dsh: { probe: async () => 'up', prompt: async (id, args) => { calls.push({ id, ...args }); } },
    claudeAttachmentParts: (args) => ({ text: args.text, images: [image] }), watchDshTurn() {} };
  for (const action of ['followup.enqueue', 'turn.steer']) {
    const result = await ctx.dshCommand({ action, requestId: action, args: { threadId: 'dsh-s', text: '看图', attachments: [{ attachmentId: 'a' }] } });
    assert.equal(result.queued, action === 'followup.enqueue');
  }
  assert.deepEqual(calls.map((call) => [call.id, call.mode, call.requestId, call.images]), [
    ['s', 'queue', 'followup.enqueue', [{ ...image, name: undefined }]],
    ['s', 'steer', 'turn.steer', [{ ...image, name: undefined }]],
  ]);
});

test('late DSH receipt restores an already completed status quietly after queue acknowledgement', async () => {
  const emissions = [];
  const id = 'dsh-session-test';
  const meta = { sessionId: 'session-test', syncedSeq: 11, itemsSchema: 4, title: 'test', running: false,
    pendingCalls: {}, terminalStatus: 'completed', announcedStatus: 'completed' };
  const ctx = { ...methods, dshThreads: new Map([[id, meta]]), dshWorkspace: { loaded: false },
    dsh: { sessionPage: async () => ({ records: [
      { event: event('user/message', 10, { source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'image', attachment: { attachmentId: 'ref' } }] }) },
      { event: event('turn/end', 11, { reason: { kind: 'completed' } }) },
    ] }) },
    uploadDshIndex: async () => {}, uploadDshItems: async () => {}, saveDshThreads: () => {},
    reconcileSendReceipts: () => { emissions.push({ kind: 'followup.started' }); return 1; },
    emit: (kind, threadId, value) => emissions.push({ kind, threadId, value }),
  };
  await ctx.syncDshSession({ sessionId: 'session-test', running: false, projections: { asOfSeq: 11, values: { title: 'test' } } });
  assert.deepEqual(emissions.filter((e) => e.kind !== 'history.updated').map((e) => [e.kind, e.value?.status, e.value?.quiet]), [
    ['followup.started', undefined, undefined], ['thread.status', 'completed', true],
  ]);
});

test('describes files, searches and generic tools', () => {
  assert.equal(toolKind('read', { file_path: 'a.txt' }).type, 'mcpToolCall');
  assert.equal(toolKind('write', { file_path: 'a.txt' }).type, 'fileChange');
  assert.equal(toolKind('web_search', { query: 'x' }).type, 'webSearch');
  assert.equal(toolKind('mystery', {}).type, 'mcpToolCall');
});

test('maps turn reasons and answerable questions', () => {
  assert.equal(turnStatus({ kind: 'error' }), 'failed');
  assert.equal(turnStatus({ kind: 'cancelled' }), 'interrupted');
  assert.equal(turnStatus({ kind: 'completed' }), 'completed');
  const waiting = waitingFor({ projections: { values: { userQuestions: { active: [{
    callId: 'call-1', state: 'open', questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }] }],
  }] } } } });
  assert.equal(waiting.requestId, 'uq:call-1');
  assert.equal(waiting.questions[0].question, '继续吗？');
  assert.equal(waitingFor({ projections: { values: {} } }), null);
});

test('reads the Desktop workspace pin and archive sets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-'));
  const file = path.join(dir, 'workspace.json');
  fs.writeFileSync(file, JSON.stringify({ global: {
    pinnedSessionIds: ['session-b', 'session-a'],
    archivedSessionIds: ['session-c'],
  } }));
  const ctx = { dshWorkspaceFile: file, dshWorkspace: { mtimeMs: 0, loaded: false, pinned: new Map(), archived: new Set() } };
  methods.refreshDshWorkspace.call(ctx);
  assert.equal(ctx.dshWorkspace.pinned.get('session-b'), 0);
  assert.equal(ctx.dshWorkspace.pinned.get('session-a'), 1);
  assert.equal(ctx.dshWorkspace.archived.has('session-c'), true);
});

test('counts today usage once per session and ignores old events', () => {
  const now = Date.now();
  const ctx = Object.assign({}, methods, {
    dshUsage: methods.emptyDshUsage.call({}),
    dshUsageSeq: new Map(),
    emitDshUsage: () => {},
  });
  methods.addDshUsage.call(ctx, 'session-a', { type: 'assistant/message', seq: 10, time: now, data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100 } } });
  methods.addDshUsage.call(ctx, 'session-a', { type: 'assistant/message', seq: 10, time: now, data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100 } } });
  methods.addDshUsage.call(ctx, 'session-a', { type: 'assistant/message', seq: 9, time: now - 86400_000, data: { usage: { inputTokens: 999, outputTokens: 999 } } });
  assert.equal(ctx.dshUsage.input, 10);
  assert.equal(ctx.dshUsage.output, 2);
  assert.equal(ctx.dshUsage.cacheRead, 100);
  assert.equal(ctx.dshUsage.total, 112);
});

test('DSH approval audit events keep the phone waiting status aligned with the desktop', async () => {
  const id = 'dsh-session-approval';
  const meta = { sessionId: 'session-approval', syncedSeq: -1, pendingCalls: {}, pendingApprovals: {}, itemsSchema: 4 };
  const emissions = [];
  const ctx = Object.assign({}, methods, {
    dshThreads: new Map([[id, meta]]),
    dsh: { sessionPage: async () => ({ records: [
      { event: { type: 'approval/asked', seq: 1, time: 100, data: { id: 'approval-1', toolName: 'pwsh', reason: '写入测试文件' } } },
    ] }) },
    uploadDshIndex: async () => {}, saveDshThreads: () => {},
    emit: (kind, threadId, value) => emissions.push({ kind, threadId, value }),
  });
  const summary = { sessionId: 'session-approval', cwd: 'I:/work', updatedAt: 100, running: true,
    projections: { asOfSeq: 1, values: { title: '等待审批' } } };
  await methods.syncDshSession.call(ctx, summary);
  assert.equal(meta.pendingApprovals['approval-1'].reason, '写入测试文件');
  assert.equal(meta.waiting.kind, 'approval');
  assert.equal(meta.waiting.requestId, 'ap:approval-1');
  assert.equal(methods.dshThreadStatus.call(ctx, meta), 'desktop_waiting_approval');
  assert.ok(emissions.some((item) => item.kind === 'thread.status' && item.value.status === 'desktop_waiting_approval'));
  // The phone row carries it as a permission prompt it can answer.
  const row = methods.dshIndexValue.call(ctx, id, meta);
  assert.equal(row.status, 'desktop_waiting_approval');
  assert.deepEqual(row.waiting, { kind: 'permission', tool: 'pwsh', requestId: 'ap:approval-1', summary: '写入测试文件', description: '', questions: [], autoOption: false });

  ctx.dsh.sessionPage = async () => ({ records: [
    { event: { type: 'approval/decided', seq: 2, time: 200, data: { id: 'approval-1', outcome: 'allowed-once' } } },
  ] });
  const done = { ...summary, running: false, projections: { asOfSeq: 2, values: { title: '等待审批' } } };
  await methods.syncDshSession.call(ctx, done);
  await methods.syncDshSession.call(ctx, done);
  assert.equal(meta.pendingApprovals['approval-1'], undefined);
  assert.equal(meta.waiting, null);
  assert.equal(methods.dshThreadStatus.call(ctx, meta), 'completed');
});

test('recovers an approval card that was already open before connector start', async () => {
  const id = 'dsh-session-approval-recover';
  const meta = { sessionId: 'session-approval-recover', syncedSeq: 12, pendingCalls: {}, pendingApprovals: {}, itemsSchema: 4,
    permissionMode: 'workspace-write' };
  const ctx = Object.assign({}, methods, {
    dshThreads: new Map([[id, meta]]),
    dsh: { sessionPage: async () => ({ records: [
      { event: { type: 'approval/asked', seq: 10, time: 100, data: { id: 'approval-recover', toolName: 'pwsh', reason: '写入前批准' } } },
    ] }) },
    uploadDshIndex: async () => {}, saveDshThreads: () => {}, emit: () => {},
  });
  const summary = { sessionId: 'session-approval-recover', updatedAt: 100, running: true,
    projections: { asOfSeq: 12, values: { title: '等待审批' } } };
  await methods.syncDshSession.call(ctx, summary);
  assert.equal(meta.waiting.requestId, 'ap:approval-recover');
  assert.equal(methods.dshThreadStatus.call(ctx, meta), 'desktop_waiting_approval');
});

test('new session prompts the created DSH session and reports the phone thread', async () => {
  const calls = [];
  const ctx = Object.assign({}, methods, {
    dsh: { probe: async () => 'up', create: async ({ cwd }) => { calls.push(['create', cwd]); return { sessionId: 'session-new' }; }, prompt: async (sessionId, args) => { calls.push(['prompt', sessionId, args.text]); return { accepted: true }; } },
    dshThreads: new Map(), saveDshThreads: () => {}, watchDshTurn: () => {}, nudgeDsh: () => {}, dshAttachmentParts: (args) => ({ text: args.text, images: [] }),
    config: { accountKey: Buffer.alloc(32) }, emit: () => {}, uploadDshIndex: async () => {},
  });
  const result = await methods.dshCommand.call(ctx, { action: 'thread.newWithTurn', requestId: 'r1', args: { backend: 'dsh', cwd: 'I:\\work', text: '你好' } });
  assert.equal(result.threadId, 'dsh-session-new');
  assert.deepEqual(calls, [['create', 'I:\\work'], ['prompt', 'session-new', '你好']]);
});

test('DSH settings return the permission catalog and switch a permission preset', async () => {
  const meta = { sessionId: 'session-settings', title: '设置测试', model: 'magpie/workbuddy', effort: 'high', permissionMode: 'workspace-write' };
  const calls = [];
  const ctx = Object.assign({}, methods, {
    dshThreads: new Map([['dsh-session-settings', meta]]),
    dsh: {
      probe: async () => 'up',
      modelCatalog: async () => ({ groups: [{ id: 'magpie', name: 'Magpie', models: [{ id: 'workbuddy', name: 'WorkBuddy' }] }] }),
      permissionCatalog: async () => ({ options: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }], defaultPreset: 'workspace-write' }),
      executeCommand: async (sessionId, line) => { calls.push(['execute', sessionId, line]); return { result: { kind: 'success', text: 'preset read-only' } }; },
      selectModel: async (sessionId, selection) => { calls.push(['select', sessionId, selection]); return { selected: { provider: 'magpie', model: 'workbuddy', reasoningEffort: 'max' } }; },
    },
    uploadDshIndex: async () => {}, saveDshThreads: () => {}, emit: () => {},
  });
  const read = await methods.dshCommand.call(ctx, { action: 'thread.settings.read', args: { threadId: 'dsh-session-settings' } });
  assert.equal(read.settings.permissionMode, 'workspace-write');
  assert.deepEqual(read.permissionCatalog.options.map((option) => option.value), ['read-only', 'workspace-write']);
  const saved = await methods.dshCommand.call(ctx, { action: 'settings.set', args: {
    threadId: 'dsh-session-settings', model: 'magpie/workbuddy', effort: 'max', permissionMode: 'read-only',
  } });
  assert.deepEqual(calls, [
    ['execute', 'session-settings', '/permission read-only'],
    ['select', 'session-settings', { provider: 'magpie', model: 'workbuddy', reasoningEffort: 'max' }],
  ]);
  assert.equal(saved.permissionMode, 'read-only');
  assert.equal(meta.permissionMode, 'read-only');
});

test('a question DSH no longer holds is answered on the desktop card, one label per page', async () => {
  const meta = { sessionId: 's1', title: '12 KH Link', waiting: { kind: 'question', requestId: 'uq:call_1', questions: [
    { id: 'form', question: '形态？', options: [{ label: 'Web' }, { label: 'Android APK 壳' }] },
    { id: 'net', question: '网络？', options: [{ label: '局域网' }, { label: '公网/异地访问' }] },
  ] } };
  const runs = []; let apiAnswers = null;
  const ctx = Object.assign(Object.create(methods), {
    dshThreads: new Map([['dsh-s1', meta]]), log() {}, nudgeDsh() {},
    dsh: { probe: async () => 'up', answerQuestion: async (sessionId, callId, answers) => { apiAnswers = { sessionId, callId, answers }; return false; } },
    runDshUia: async (action, m, option, labels) => { runs.push({ action, title: m.title, option, labels }); return { ok: true }; },
  });
  const result = await ctx.dshCommand({ action: 'claude.desktop.answer', args: { threadId: 'dsh-s1', answers: [{ labels: ['Android APK 壳'] }, { labels: ['公网/异地访问'] }] } });
  assert.equal(result.ok, true);
  assert.deepEqual(apiAnswers, { sessionId: 's1', callId: 'call_1', answers: [{ id: 'form', selected: ['Android APK 壳'] }, { id: 'net', selected: ['公网/异地访问'] }] });
  assert.deepEqual(runs, [{ action: 'answer', title: '12 KH Link', option: '', labels: ['Android APK 壳', '公网/异地访问'] }]);

  const typed = await ctx.dshCommand({ action: 'claude.desktop.answer', args: { threadId: 'dsh-s1', answers: [{ labels: [], other: '先做网页' }, { labels: ['局域网'] }] } });
  assert.equal(typed.ok, false, 'typed answers cannot be clicked in; the phone says so');
  assert.equal(runs.length, 1);
});

test('a session whose events end below the summary asOfSeq is synced once, and an unchanged list row is not uploaded again', async () => {
  await require('../src/crypto').ready();
  const id = 'dsh-recording-x'; const puts = []; let pages = 0;
  const meta = { sessionId: 'recording-x', syncedSeq: -1, itemsSchema: 5, pendingCalls: {} };
  const ctx = { ...methods, dshThreads: new Map([[id, meta]]), dshWorkspace: { loaded: false },
    config: { accountKey: Buffer.alloc(32, 3).toString('base64') },
    api: { path: (p) => p, request: async (p, opts) => { puts.push(p); return {}; } },
    dsh: { sessionPage: async () => { pages++; return { records: [{ event: event('turn/end', 206, { reason: { kind: 'completed' } }) }] }; } },
    uploadDshItems: async () => {}, saveDshThreads: () => {}, reconcileSendReceipts: () => 0, emit: () => {} };
  const summary = { sessionId: 'recording-x', running: false, updatedAt: 1000, projections: { asOfSeq: 28165, values: { title: '回测' } } };
  await ctx.syncDshSession(summary);
  assert.equal(meta.syncedSeq, 28165, 'synced through the summary position');
  assert.equal(puts.length, 1);
  assert.equal(await ctx.syncDshSession(summary), false, 'nothing changed');
  assert.equal(pages, 1);
  await ctx.uploadDshIndex(id, meta);
  assert.equal(puts.length, 1, 'the same row is not uploaded again');
  meta.title = '新标题';
  await ctx.uploadDshIndex(id, meta);
  assert.equal(puts.length, 2);
});

test('a waiting row from an older connector is published again in the new shape', async () => {
  const id = 'dsh-session-approval-shape';
  const meta = { sessionId: 'session-approval-shape', syncedSeq: 12, pendingCalls: {}, itemsSchema: 5, title: '等待审批', running: true, model: '', effort: '', permissionMode: '',
    pendingApprovals: { a1: { id: 'a1', toolName: 'pwsh', callId: 'c1', reason: '删除文件', askedAt: 100 } },
    waiting: { kind: 'approval', tool: 'approval', requestId: 'ap:a1', summary: '删除文件', description: '', questions: [] }, pinned: false, pinOrder: -1, archived: false, unread: false };
  const uploads = [];
  const ctx = Object.assign({}, methods, {
    dshThreads: new Map([[id, meta]]), approvalProbeAt: 0,
    dsh: { sessionPage: async () => ({ records: [] }) },
    uploadDshIndex: async (threadId, current, changed) => uploads.push([methods.dshIndexValue.call(ctx, threadId, current).waiting, changed]),
    saveDshThreads: () => {}, emit: () => {},
  });
  meta.approvalProbeAt = Date.now();
  const summary = { sessionId: 'session-approval-shape', updatedAt: 100, running: true, projections: { asOfSeq: 12, values: { title: '等待审批' } } };
  await methods.syncDshSession.call(ctx, summary);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0][1], true);
  assert.equal(uploads[0][0].tool, 'pwsh');
  assert.equal(uploads[0][0].kind, 'permission');
  // Nothing new: no second upload.
  assert.equal(await methods.syncDshSession.call(ctx, summary), false);
  assert.equal(uploads.length, 1);
});

test('a new DSH session gets the Windows form of its folder, so the desktop lists it', { skip: process.platform !== 'win32' }, () => {
  const { normalizeDshCwd } = require('../src/backends/dsh-sync');
  assert.equal(normalizeDshCwd('I:/tmp/khlink-test'), 'I:\x5ctmp\x5ckhlink-test');
  assert.equal(normalizeDshCwd('I:\x5ctmp\x5ckhlink-test\x5c'), 'I:\x5ctmp\x5ckhlink-test');
  assert.equal(normalizeDshCwd('I:/'), 'I:\x5c');
  assert.equal(normalizeDshCwd(''), '');
});
