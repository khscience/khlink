const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { methods, toolKind, mediaPaths, contentText, unwrapToolResult, threadIdOf, sessionIdOf } = require('../src/backends/hermes-sync');
const { HermesTransport, normalize, hostCommand, shellQuote } = require('../src/backends/hermes-transport');
const { HermesAcp } = require('../src/backends/hermes-acp');

function context(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-sync-'));
  return Object.assign(Object.create(methods), {
    hermesFilesDir: path.join(dir, 'files'),
    hermesThreads: new Map(),
    hermesRunning: new Map(),
    hermesPermissions: new Map(),
    hermesTransport: { readFile: async () => Buffer.from('png-bytes') },
    emit: () => {}, log: () => {}, saveHermesThreads: () => {}, uploadHermesIndex: async () => {},
    ...extra,
  });
}

test('thread ids keep the Hermes session id', () => {
  assert.equal(threadIdOf('local-abc'), 'hermes-local-abc');
  assert.equal(sessionIdOf('hermes-local-abc'), 'local-abc');
  assert.equal(sessionIdOf('dsh-x'), null);
});

test('gateway admission keeps a quiet external Hermes turn running until it finishes', async () => {
  const events = [];
  const indexes = [];
  const ctx = context({
    emit: (kind, id, data) => events.push({ kind, id, status: data.status }),
    uploadHermesIndex: async (id, meta) => indexes.push({ id, status: ctx.hermesThreadStatus(meta), updatedAt: meta.updatedAt }),
  });
  const old = Math.floor(Date.now() / 1000) - 3600;
  const id = threadIdOf('quiet');
  ctx.hermesThreads.set(id, { sessionId: 'quiet', syncedMessageId: 10, itemsSchema: 6, indexed: true,
    title: '长任务', model: 'test', source: 'local', running: false, terminalStatus: 'completed', announcedStatus: 'completed' });
  const summary = { id: 'quiet', title: '长任务', model: 'test', source: 'local', started_at: old,
    last_activity_at: old, max_message_id: 10, last_message: { id: 10, role: 'assistant', calls: 1, timestamp: old },
    execution_state: 'running' };
  assert.equal(await ctx.syncHermesSession(summary), true);
  assert.equal(ctx.hermesThreadStatus(ctx.hermesThreads.get(id)), 'desktop_running');
  assert.equal(indexes[0].updatedAt, old * 1000, 'live status does not fabricate history activity');
  assert.deepEqual(events.filter((e) => e.kind === 'thread.status').map((e) => e.status), ['desktop_running']);
  assert.equal(await ctx.syncHermesSession(summary), false, 'unchanged polling emits no duplicate');

  // A final assistant message and an idle gateway admission end the turn.
  const done = { ...summary, execution_state: 'idle', last_message: { id: 10, role: 'assistant', calls: 0, timestamp: old } };
  assert.equal(await ctx.syncHermesSession(done), true);
  assert.equal(ctx.hermesThreadStatus(ctx.hermesThreads.get(id)), 'completed');
  assert.deepEqual(events.filter((e) => e.kind === 'thread.status').map((e) => e.status), ['desktop_running', 'completed']);
  assert.equal(await ctx.syncHermesSession(done), false);
});

test('unknown or queued gateway admission is not reported as completed', async () => {
  const ctx = context();
  const old = Math.floor(Date.now() / 1000) - 3600;
  const summary = { id: 'uncertain', title: '等待', source: 'local', started_at: old,
    last_activity_at: old, max_message_id: 1, last_message: { role: 'tool', timestamp: old }, execution_state: 'unknown' };
  ctx.hermesThreads.set(threadIdOf('uncertain'), { sessionId: 'uncertain', syncedMessageId: 1, itemsSchema: 6,
    indexed: true, title: '等待', source: 'local', running: false, terminalStatus: 'completed' });
  await ctx.syncHermesSession(summary);
  assert.equal(ctx.hermesThreadStatus(ctx.hermesThreads.get(threadIdOf('uncertain'))), 'unknown_queued');
  await ctx.syncHermesSession({ ...summary, execution_state: 'queued' });
  assert.equal(ctx.hermesThreadStatus(ctx.hermesThreads.get(threadIdOf('uncertain'))), 'queued');
  await ctx.syncHermesSession({ ...summary, execution_state: 'idle', last_message: { role: 'assistant', calls: 0, timestamp: old } });
  assert.equal(ctx.hermesThreadStatus(ctx.hermesThreads.get(threadIdOf('uncertain'))), 'completed');
});

test('own Hermes turns and compressed gateway turns stay running regardless of legacy fallback', async () => {
  const ctx = context();
  const old = Math.floor(Date.now() / 1000) - 3600;
  const summary = { id: 'compressed', title: '压缩对话', source: 'local', ended_at: old,
    started_at: old, last_activity_at: old, max_message_id: 1,
    last_message: { role: 'assistant', calls: 1, timestamp: old }, execution_state: 'running' };
  ctx.hermesThreads.set(threadIdOf('compressed'), { sessionId: 'compressed', syncedMessageId: 1, itemsSchema: 6,
    indexed: true, title: '压缩对话', source: 'local', terminalStatus: 'completed' });
  await ctx.syncHermesSession(summary);
  assert.equal(ctx.hermesThreadStatus(ctx.hermesThreads.get(threadIdOf('compressed'))), 'desktop_running');
  ctx.hermesRunning.set('compressed', { startedAt: Date.now() });
  await ctx.syncHermesSession({ ...summary, execution_state: 'unknown' });
  assert.equal(ctx.hermesThreadStatus(ctx.hermesThreads.get(threadIdOf('compressed'))), 'desktop_running');
});

test('an explicitly interrupted gateway turn does not produce a completed status', async () => {
  const events = [];
  const ctx = context({ emit: (kind, id, data) => events.push({ kind, status: data.status }) });
  const now = Math.floor(Date.now() / 1000);
  const id = threadIdOf('interrupted');
  const base = { id: 'interrupted', title: '任务', source: 'local', started_at: now - 60,
    last_activity_at: now, max_message_id: 1, last_message: { role: 'assistant', calls: 1, timestamp: now },
    execution_state: 'running' };
  ctx.hermesThreads.set(id, { sessionId: 'interrupted', syncedMessageId: 1, itemsSchema: 6, indexed: true,
    title: '任务', source: 'local', running: false, terminalStatus: 'completed' });
  await ctx.syncHermesSession(base);
  assert.equal(ctx.hermesThreadStatus(ctx.hermesThreads.get(id)), 'desktop_running');
  await ctx.syncHermesSession({ ...base, execution_state: 'idle', execution_outcome: 'interrupted' });
  assert.equal(ctx.hermesThreadStatus(ctx.hermesThreads.get(id)), 'interrupted');
  assert.deepEqual(events.filter((e) => e.kind === 'thread.status').map((e) => e.status), ['desktop_running', 'interrupted']);

  // Also correct an old false completed state, even after a connector restart.
  const old = { ...base, id: 'old', last_activity_at: now - 3600, last_message: { role: 'assistant', calls: 1, timestamp: now - 3600 },
    execution_state: 'idle', execution_outcome: 'interrupted' };
  ctx.hermesThreads.set(threadIdOf('old'), { sessionId: 'old', syncedMessageId: 1, itemsSchema: 6, indexed: true,
    title: '任务', source: 'local', running: false, terminalStatus: 'completed' });
  await ctx.syncHermesSession(old);
  assert.equal(ctx.hermesThreadStatus(ctx.hermesThreads.get(threadIdOf('old'))), 'interrupted');
});

test('an old terminal admission does not suppress a recent untracked external turn', async () => {
  const ctx = context();
  const now = Math.floor(Date.now() / 1000);
  const id = threadIdOf('external');
  ctx.hermesThreads.set(id, { sessionId: 'external', syncedMessageId: 1, itemsSchema: 6, indexed: true,
    title: '新一轮', source: 'local', running: false, terminalStatus: 'completed' });
  await ctx.syncHermesSession({ id: 'external', title: '新一轮', source: 'local', started_at: now - 60,
    last_activity_at: now, max_message_id: 1, last_message: { role: 'user', timestamp: now },
    execution_state: 'idle', execution_outcome: 'interrupted' });
  assert.equal(ctx.hermesThreadStatus(ctx.hermesThreads.get(id)), 'desktop_running');
  // The previous gateway turn may have been observed running before this
  // newer input appeared between polls.
  const meta = ctx.hermesThreads.get(id);
  meta.gatewayActive = true;
  meta.gatewayActiveMessageId = 1;
  meta.syncedMessageId = 2;
  await ctx.syncHermesSession({ id: 'external', title: '新一轮', source: 'local', started_at: now - 60,
    last_activity_at: now, max_message_id: 2, last_message: { role: 'user', timestamp: now },
    execution_state: 'idle', execution_outcome: 'interrupted' });
  assert.equal(ctx.hermesThreadStatus(meta), 'desktop_running');
});

test('reads plain and structured message content', () => {
  assert.deepEqual(contentText('你好'), { text: '你好', images: 0 });
  assert.deepEqual(contentText(JSON.stringify([{ type: 'text', text: '看图' }, { type: 'image_url', image_url: {} }])), { text: '看图', images: 1 });
  assert.equal(unwrapToolResult('<untrusted_tool_result source="x">\nThe following content was retrieved.\n{"ok":1}\n</untrusted_tool_result>'), '{"ok":1}');
});

test('describes Hermes tools by kind', () => {
  assert.equal(toolKind('terminal', { command: 'free -h' }).type, 'commandExecution');
  assert.match(toolKind('terminal', { command: 'free -h' }).text, /free -h/);
  assert.equal(toolKind('write_file', { path: '/a' }).type, 'fileChange');
  assert.equal(toolKind('web_search', { query: 'x' }).type, 'webSearch');
  assert.equal(toolKind('delegate_task', { goal: 'x' }).type, 'collabAgentToolCall');
  assert.equal(toolKind('browser_exec', { code: 'x' }).type, 'mcpToolCall');
});

test('finds produced files, keeping documents out of tool output', () => {
  const text = '截图在 /home/ubuntu/.config/b/tmp/shot.png，报告见 /home/ubuntu/out/report.md。';
  assert.deepEqual(mediaPaths(text), ['/home/ubuntu/.config/b/tmp/shot.png', '/home/ubuntu/out/report.md']);
  assert.deepEqual(mediaPaths(text, { documents: false }), ['/home/ubuntu/.config/b/tmp/shot.png']);
  assert.deepEqual(mediaPaths('MEDIA: /tmp/a.bin'), ['/tmp/a.bin']);
  assert.deepEqual(mediaPaths('run /usr/bin/python3 now'), []);
});

test('maps stored messages to stable items; a tool result updates its call', async () => {
  const ctx = context();
  const meta = { pendingCalls: {} };
  const user = await ctx.hermesItemsForMessage('hermes-s', meta, { id: 10, role: 'user', content: '查内存', timestamp: 1_700_000_000 });
  assert.deepEqual(user.map((item) => [item.id, item.order, item.value.type]), [['hermes-s-m10', 1001, 'userMessage']]);
  const assistant = await ctx.hermesItemsForMessage('hermes-s', meta, {
    id: 11, role: 'assistant', content: '', reasoning: '用 free', timestamp: 1_700_000_001,
    tool_calls: JSON.stringify([{ id: 'c1', function: { name: 'terminal', arguments: '{"command":"free -h"}' } }]),
  });
  assert.deepEqual(assistant.map((item) => item.value.type), ['reasoning', 'commandExecution']);
  assert.equal(assistant[1].value.status, 'inProgress');
  const tool = await ctx.hermesItemsForMessage('hermes-s', meta, { id: 12, role: 'tool', tool_call_id: 'c1', content: '{"output":"Mem: 15Gi","exit_code":0}', timestamp: 1_700_000_002 });
  assert.equal(tool[0].id, assistant[1].id);
  assert.equal(tool[0].order, assistant[1].order);
  assert.equal(tool[0].value.status, 'completed');
  assert.match(tool[0].value.text, /15Gi/);
  const failed = await ctx.hermesItemsForMessage('hermes-s', { pendingCalls: { c2: { id: 'x', order: 1, value: { text: 't' } } } }, { id: 13, role: 'tool', tool_call_id: 'c2', content: '{"success":false,"error":"boom"}' });
  assert.equal(failed[0].value.status, 'failed');
  const hidden = await ctx.hermesItemsForMessage('hermes-s', meta, { id: 14, role: 'user', content: 'x', display_kind: 'hidden' });
  assert.equal(hidden.length, 0);
});

test('mirrors a screenshot once per conversation', async () => {
  const ctx = context();
  const meta = { pendingCalls: {} };
  const first = await ctx.hermesItemsForMessage('hermes-s', meta, { id: 20, role: 'tool', tool_call_id: 'none', content: '{"screenshot_path":"/home/u/tmp/shot.png"}' });
  assert.equal(first.length, 1);
  assert.equal(first[0].value.type, 'sentFiles');
  assert.equal(first[0].value.files[0].kind, 'image');
  assert.ok(fs.existsSync(first[0].value.files[0].path));
  const repeat = await ctx.hermesItemsForMessage('hermes-s', meta, { id: 21, role: 'assistant', content: '图在 /home/u/tmp/shot.png' });
  assert.equal(repeat.filter((item) => item.value.type === 'sentFiles').length, 0);
  // Re-syncing the original row keeps its picture.
  const again = await ctx.hermesItemsForMessage('hermes-s', meta, { id: 20, role: 'tool', tool_call_id: 'none', content: '{"screenshot_path":"/home/u/tmp/shot.png"}' });
  assert.equal(again[0].value.type, 'sentFiles');
});

test('a permission prompt waits for the phone and is answered by label', async () => {
  const responses = [];
  const ctx = context({ hermesAcp: { respond: (id, result) => responses.push([id, result]) } });
  const id = threadIdOf('s1');
  ctx.hermesThreads.set(id, { sessionId: 's1' });
  await ctx.onHermesPermission(7, { sessionId: 's1', toolCall: { title: 'Approve edit: /home/u/a.txt' },
    options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] });
  const meta = ctx.hermesThreads.get(id);
  assert.equal(meta.waiting.requestId, 'perm:7');
  assert.deepEqual(meta.waiting.questions[0].options.map((option) => option.label), ['允许这一次', '拒绝']);
  assert.equal(ctx.hermesThreadStatus(meta), 'desktop_waiting');
  const answer = await ctx.hermesCommand.call(ctx, { action: 'claude.desktop.answer', args: { threadId: id, answers: [{ labels: ['拒绝'] }] } });
  assert.equal(answer.ok, true);
  assert.deepEqual(responses, [[7, { outcome: { outcome: 'selected', optionId: 'deny' } }]]);
  assert.equal(meta.waiting, null);
  const stale = await ctx.hermesCommand.call(ctx, { action: 'claude.desktop.answer', args: { threadId: id, answers: [{ labels: ['拒绝'] }] } });
  assert.equal(stale.ok, false);
});

test('a permission for an unknown session is refused, not left hanging', async () => {
  const responses = [];
  const ctx = context({ hermesAcp: { respond: (id, result) => responses.push([id, result]) } });
  await ctx.onHermesPermission(3, { sessionId: 'nope', options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] });
  assert.deepEqual(responses, [[3, { outcome: { outcome: 'selected', optionId: 'no' } }]]);
});

test('a second message during a running turn steers or queues with Hermes commands', async () => {
  const prompts = [];
  const ctx = context({
    hermesOnline: true,
    hermesAcp: { prompt: async (sessionId, blocks) => { prompts.push([sessionId, blocks[0].text]); return { stopReason: 'end_turn' }; } },
    nudgeHermes: () => {},
    hermesPromptBlocks: async (args) => [{ type: 'text', text: args.text }],
  });
  const id = threadIdOf('s2');
  ctx.hermesThreads.set(id, { sessionId: 's2' });
  ctx.hermesRunning.set('s2', { startedAt: Date.now() });
  const queued = await ctx.hermesCommand({ action: 'followup.enqueue', args: { threadId: id, text: '再查下磁盘' } });
  const steered = await ctx.hermesCommand({ action: 'turn.steer', args: { threadId: id, text: '只看根分区' } });
  assert.equal(queued.queued, true);
  assert.equal(steered.steered, true);
  assert.deepEqual(prompts, [['s2', '/queue 再查下磁盘'], ['s2', '/steer 只看根分区']]);
});

test('a running Hermes turn queues the complete image prompt and refuses image steering', async () => {
  const prompts = [];
  let finish;
  const ctx = context({
    hermesOnline: true,
    hermesAcp: { prompt: (sessionId, blocks) => {
      prompts.push({ sessionId, blocks });
      return new Promise((resolve) => { finish = resolve; });
    } },
    nudgeHermes: () => {},
    hermesPromptBlocks: async () => [
      { type: 'text', text: '请看图片' },
      { type: 'image', mimeType: 'image/png', data: 'cG5n' },
    ],
  });
  const id = threadIdOf('image-test');
  ctx.hermesThreads.set(id, { sessionId: 'image-test' });
  ctx.hermesRunning.set('image-test', { startedAt: Date.now() });
  const waiting = ctx.hermesCommand({ action: 'followup.enqueue', args: { threadId: id, text: '请看图片' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompts, [{ sessionId: 'image-test', blocks: [
    { type: 'text', text: '请看图片' }, { type: 'image', mimeType: 'image/png', data: 'cG5n' },
  ] }]);
  let settled = false;
  waiting.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'no unconfirmed queue acknowledgement');
  finish({ stopReason: 'end_turn' });
  assert.equal((await waiting).accepted, true);
  await assert.rejects(ctx.hermesCommand({ action: 'turn.steer', args: { threadId: id } }),
    (error) => error.delivery === 'not_sent' && /请选择排队/.test(error.message));
  assert.equal(prompts.length, 1, 'refused steer did not send a text-only message');
});

test('offline Hermes answers background reads quietly', async () => {
  const ctx = context({ hermesOnline: false });
  assert.deepEqual(await ctx.hermesCommand({ action: 'followup.list', args: {} }), { items: [] });
  assert.equal((await ctx.hermesCommand({ action: 'capabilities', args: {} })).offline, true);
});

test('transport builds wsl and ssh command lines', () => {
  assert.equal(normalize({ transport: 'ssh' }), null);
  assert.equal(normalize({ enabled: false, transport: 'wsl' }), null);
  const wsl = hostCommand(normalize({ transport: 'wsl', distro: 'Ubuntu-22.04', user: 'ubuntu' }), 'echo hi');
  assert.equal(wsl.file, 'wsl.exe');
  assert.deepEqual(wsl.args, ['-d', 'Ubuntu-22.04', '-u', 'ubuntu', '--', 'bash', '-lc', 'echo hi']);
  const ssh = hostCommand(normalize({ transport: 'ssh', host: 'WSL' }), 'echo hi');
  assert.equal(ssh.file, 'ssh');
  assert.equal(ssh.args.at(-2), 'WSL');
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote('~/.local/bin/hermes'), '~/.local/bin/hermes');
});

test('the ACP client answers requests and surfaces permission prompts', async () => {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => child.emit('exit', 0) });
  const written = [];
  stdin.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      const message = JSON.parse(line); written.push(message);
      if (message.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })}\n`);
      if (message.method === 'session/new') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'local-1', models: { currentModelId: 'm', availableModels: [{ modelId: 'moa:panel', name: 'MoA panel' }] } } })}\n`);
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { sessionId: 'local-1', options: [] } })}\n`);
      }
    }
  });
  const acp = new HermesAcp({ spawnAcp: () => child });
  const permissions = [];
  acp.on('permission', (id, params) => permissions.push([id, params.sessionId]));
  const created = await acp.newSession('/home/u');
  assert.equal(created.sessionId, 'local-1');
  assert.equal(acp.models.availableModels[0].modelId, 'moa:panel');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(permissions, [[99, 'local-1']]);
  await acp.cancel('local-1');
  assert.ok(written.some((message) => message.method === 'session/cancel' && message.id === undefined));
  child.emit('exit', 1);
  await assert.rejects(acp._request('session/prompt', {}).catch((error) => { throw error; }));
});

test('transport store helper exists and is read-only', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'backends', 'hermes-store.py'), 'utf8');
  assert.match(script, /mode=ro/);
  assert.doesNotMatch(script, /\b(insert|update|delete)\s+(into|from)?\s*\w+\s+(set|values|where)/i);
  assert.ok(HermesTransport);
});

test('a slash command is kept as the user row and its echoed argument is not repeated', async () => {
  const uploads = [];
  let resolvePrompt;
  const ctx = context({
    hermesAcp: { attach: async () => null, prompt: () => new Promise((resolve) => { resolvePrompt = resolve; }) },
    uploadHermesItems: async (id, rows) => uploads.push(...rows),
    announceHermesStatus: () => {}, watchHermesTurn: () => {}, pollHermes: async () => {},
    hermesTransport: { store: async () => ({ messages: [] }), readFile: async () => Buffer.alloc(0) },
  });
  const id = threadIdOf('s3');
  const meta = { sessionId: 's3', syncedMessageId: 12 };
  ctx.hermesThreads.set(id, meta);
  const turn = ctx.startHermesTurn(id, meta, [{ type: 'text', text: '/goal 查一下磁盘空间' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(uploads[0].value.type, 'userMessage');
  assert.equal(uploads[0].value.text, '/goal 查一下磁盘空间');
  assert.ok(uploads[0].order > 12 * 100 && uploads[0].order < 13 * 100, 'before anything Hermes stores next');
  const echoed = await ctx.hermesItemsForMessage(id, meta, { id: 13, role: 'user', content: '查一下磁盘空间' });
  assert.equal(echoed.length, 0);
  const later = await ctx.hermesItemsForMessage(id, meta, { id: 20, role: 'user', content: '查一下磁盘空间' });
  assert.equal(later.length, 1, 'only the one echo is skipped');
  resolvePrompt({ stopReason: 'end_turn' });
  await turn;
});

test('approval choices are shown in Chinese', async () => {
  const ctx = context({ hermesAcp: { respond: () => {} } });
  const id = threadIdOf('s4');
  ctx.hermesThreads.set(id, { sessionId: 's4' });
  await ctx.onHermesPermission(1, { sessionId: 's4', options: [
    { optionId: 'a', name: 'Allow once', kind: 'allow_once' }, { optionId: 'b', name: 'Allow for session', kind: 'allow_always' },
    { optionId: 'c', name: 'Deny always', kind: 'reject_always' }, { optionId: 'd', name: 'Something new', kind: 'other' }] });
  assert.deepEqual(ctx.hermesThreads.get(id).waiting.questions[0].options.map((option) => option.label), ['允许这一次', '本会话内都允许', '以后都拒绝', 'Something new']);
});

test('a picture the user sent shows as the picture and the words, not Hermes markers', async () => {
  const ctx = context({ hermesTransport: { readFile: async () => Buffer.from([0xff, 0xd8, 0xff]) } });
  const meta = { pendingCalls: {} };
  const text = '[The user sent an image~ Here\'s what I can see:\n一张海报]\n[If you need a closer look, use vision_analyze with image_url: /home/u/.hermes/cache/img_1.jpg ~]\n\n这张图写了什么';
  const [item] = await ctx.hermesItemsForMessage('hermes-s', meta, { id: 5, role: 'user', content: text });
  assert.equal(item.value.text, '这张图写了什么');
  assert.equal(item.value.images.length, 1);
  assert.match(item.value.images[0].data, /^data:image\/jpeg;base64,/);
});
