const test = require('node:test');
const assert = require('node:assert/strict');
const { messageItems } = require('../src/backends/pi-web');
const { piWaiting } = require('../src/backends/pi-sync');

test('Pi history preserves source identity and encrypted timestamps across branch display index changes', () => {
  const message = { role: 'assistant', sourceMessageId: 'native-entry', timestamp: 1_800_000_000_000,
    content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'last' }] };
  const first = messageItems([message], 2), switched = messageItems([message], 10);
  assert.notEqual(first[1].id, switched[1].id);
  assert.equal(switched[1].value.sourceMessageId, 'native-entry');
  assert.equal(switched[1].value.createdAt, message.timestamp);
});

test('Pi messages become user, thinking, reply and tool items with stable ids', () => {
  const items = messageItems([
    { role: 'user', content: [{ type: 'text', text: '看一下' }], timestamp: 1000 },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: '好' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }], timestamp: 2000 },
    { role: 'toolResult', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'boom' }] },
  ], 10);
  assert.deepEqual(items.map((i) => [i.id, i.order, i.value.type]), [
    ['pi-10-u', 1000, 'userMessage'], ['pi-11-t0', 1100, 'reasoning'], ['pi-11-m1', 1101, 'agentMessage'], ['pi-11-c2', 1102, 'commandExecution']]);
  assert.equal(items[3].value.text, 'ls');
  assert.equal(items[3].value.status, 'failed');
});

test('PI WEB asks and dialogs map to the phone waiting card', () => {
  const ask = piWaiting({ pendingAsk: { askId: 'a1', questions: [{ id: 'q', question: '选哪个？', multiple: true, options: [{ value: 'x', label: 'X', detail: 'd' }] }] } });
  assert.equal(ask.kind, 'question');
  assert.equal(ask.requestId, 'ask:a1');
  assert.deepEqual(ask.questions[0].options, [{ label: 'X', description: 'd' }]);
  assert.equal(ask.questions[0].multiSelect, true);
  const confirm = piWaiting({ pendingDialogs: [{ dialogId: 'd1', kind: 'confirm', title: '删除文件？', message: 'rm a.txt' }] });
  assert.equal(confirm.kind, 'permission');
  assert.equal(confirm.requestId, 'dialog:d1');
  assert.equal(piWaiting({ isStreaming: true }), null);
});

test('a history upload refused for a missing thread row uploads the row and retries once', async () => {
  const { Connector } = require('../src/connector');
  const connector = Object.create(Connector.prototype);
  const calls = [];
  let first = true;
  connector.api = { path: (p) => p, request: async (route) => { calls.push(route); if (first && route.endsWith('/items')) { first = false; throw new Error('500 {"statusCode":500}'); } return { saved: 1 }; } };
  connector.piThreads = new Map([['t', { cwd: 'I:/x' }]]);
  connector.uploadPiIndex = async (id) => { calls.push(`index:${id}`); };
  await connector.putHistoryItems('t', [{ id: 'a' }]);
  assert.deepEqual(calls, ['/history/threads/t/items', 'index:t', '/history/threads/t/items']);
  connector.api.request = async () => { throw new Error('400 bad'); };
  await assert.rejects(connector.putHistoryItems('t', []), /400/);
});

test('messages PI WEB queues behind a running turn are listed for the phone until history confirms them', async () => {
  const { methods } = require('../src/backends/pi-sync');
  const events = [];
  const connector = { ...methods, piThreads: new Map(), emit: (kind, id, payload) => events.push([kind, payload.id, payload.text]),
    _piQueueConfirmationDelay: () => Promise.resolve(), pi: { messages: async () => ({ messages: [] }) } };
  const meta = { cwd: 'I:/x', queue: [{ id: 'req-1', text: '好了吗', createdAt: Date.now(), origin: 'mobile' }] };
  connector.piThreads.set('s1', meta);
  connector.trackPiQueue('s1', meta, { queuedMessages: [{ kind: 'followUp', text: '好了吗' }, { kind: 'followUp', text: '怎么样了' }] });
  assert.deepEqual(meta.queue.map((entry) => entry.text), ['好了吗', '怎么样了']);
  assert.equal(meta.queue[0].id, 'req-1');
  assert.deepEqual(events.map(([kind, , text]) => [kind, text]), [['followup.queued', '怎么样了']]);
  assert.deepEqual(connector.piQueueItems('s1').map((item) => [item.id, item.state, item.backend]), [['req-1', 'desktop_queued', 'pi'], [meta.queue[1].id, 'desktop_queued', 'pi']]);
  events.length = 0;
  connector.trackPiQueue('s1', meta, { queuedMessages: [{ kind: 'followUp', text: '怎么样了' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(([kind, id]) => [kind, id]), [['followup.failed', 'req-1']]);
  assert.equal(connector.sendReceipts.get('req-1').state, 'uncertain');
  const receipt = connector.sendReceipts.get('req-1');
  assert.equal(connector.sendReceipts.reconcile('pi', 's1', [{ id: 'new-user', at: receipt.createdAt + 1, value: { type: 'userMessage', text: '好了吗' } }])[0].state, 'started');
});

test('Pi confirms a dequeued image from matching history before telling the phone it failed', async (t) => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { methods } = require('../src/backends/pi-sync'); const { SendReceipts } = require('../src/send-receipts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-pi-image-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.png'); const data = Buffer.from('isolated test image'); fs.writeFileSync(file, data);
  const attachment = { name: 'sample.png', mimeType: 'image/png', attachmentId: 'image-1', path: file };
  const store = new SendReceipts(); const row = store.begin('image-request', 'pi', { threadId: 's', text: '', attachments: [attachment] });
  store.update(row.id, { state: 'desktop_queued' }); const events = [];
  const meta = { cwd: dir, queue: [{ id: row.id, text: '请看图片', attachments: [attachment], createdAt: row.createdAt, origin: 'mobile', listed: true }] };
  const connector = { ...methods, sendReceipts: store, piThreads: new Map([['s', meta]]), _piQueueConfirmationDelay: () => Promise.resolve(),
    pi: { messages: async () => ({ start: 2, messages: [{ role: 'user', timestamp: row.createdAt + 1,
      content: [{ type: 'text', text: '请看图片' }, { type: 'image', mimeType: 'image/png', data: data.toString('base64') }] }] }) },
    emit: (kind, id, item) => events.push({ kind, item }) };
  const visible = connector.piQueueItem('s', meta.queue[0]);
  assert.equal(visible.attachments[0].attachmentId, 'image-1');
  assert.equal(JSON.stringify(visible).includes(file), false);
  connector.trackPiQueue('s', meta, { queuedMessages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(row.id).state, 'started');
  assert.deepEqual(events.map((event) => event.kind), ['followup.started']);
  assert.equal(JSON.stringify(events).includes(file), false);
});

test('Pi reports a duplicate queued text before PI WEB silently drops it', async () => {
  const { methods } = require('../src/backends/pi-sync'); let calls = 0;
  const self = { ...methods, piThreads: new Map([['s', { cwd: 'I:/x', running: true }]]),
    pi: { probe: async () => 'up', status: async () => ({ isStreaming: true, queuedMessages: [{ text: 'repeat' }] }), prompt: async () => { calls++; } },
    piAttachmentParts: (args) => ({ text: args.text, images: [] }),
  };
  await assert.rejects(self.piCommand({ action: 'followup.enqueue', args: { threadId: 's', text: 'repeat' } }), (error) => error.delivery === 'not_sent');
  assert.equal(calls, 0);
});

test('Pi running queue and immediate steer both send the image blocks', async () => {
  const { methods } = require('../src/backends/pi-sync'); const calls = [];
  const image = { kind: 'image', mimeType: 'image/png', data: 'dGVzdA==', name: 'image-1' };
  const attachments = [{ name: '图.png', attachmentId: 'opaque', mimeType: 'image/png', path: 'I:/tmp/private.png' }];
  const self = { ...methods, piThreads: new Map([['s', { cwd: 'I:/tmp/khlink-test', running: true }]]),
    pi: { probe: async () => 'up', status: async () => ({ isStreaming: true, queuedMessages: [] }), prompt: async (...args) => calls.push(args) },
    piAttachmentParts: (args) => ({ text: args.text, images: [image] }), emit() {}, savePiThreads() {}, watchPiTurn() {} };
  const queued = await self.piCommand({ action: 'followup.enqueue', requestId: 'q1', args: { threadId: 's', text: '看图', attachments } });
  const steered = await self.piCommand({ action: 'turn.steer', requestId: 's1', args: { threadId: 's', text: '再看图', attachments } });
  assert.equal(queued.queued, true); assert.equal(steered.queued, false);
  assert.deepEqual(calls.map((call) => [call[2], call[3], call[4]]), [['看图', 'followUp', [image]], ['再看图', 'steer', [image]]]);
  assert.equal(queued.item.attachments[0].attachmentId, 'opaque');
  assert.equal(JSON.stringify(queued.item).includes('private.png'), false);
});

test('a Pi steer with the same text is not mistaken for a queued image', () => {
  const { methods } = require('../src/backends/pi-sync'); const events = [];
  const attachment = { attachmentId: 'queue-image', name: 'queue.png' };
  const meta = { queue: [{ id: 'q', text: '请看图片', attachments: [attachment], createdAt: Date.now(), origin: 'mobile' }] };
  const self = { ...methods, emit: (kind) => events.push(kind) };
  self.trackPiQueue('s', meta, { queuedMessages: [{ kind: 'steer', text: '请看图片' }, { kind: 'followUp', text: '请看图片' }] });
  assert.equal(meta.queue.length, 1); assert.equal(meta.queue[0].id, 'q');
  assert.deepEqual(meta.queue[0].attachments, [attachment]); assert.deepEqual(events, []);
});

test('Pi refuses to clear a queue when it would lose a native steer or unknown desktop attachments', async () => {
  const { methods } = require('../src/backends/pi-sync'); let clears = 0;
  const mobile = { id: 'm', text: 'mobile', origin: 'mobile' };
  const self = { ...methods, pi: { clearQueue: async () => { clears++; } } };
  const status = { isStreaming: true, queuedMessages: [{ kind: 'steer', text: 'same' }] };
  await assert.rejects(self.changePiQueue('s', { queue: [mobile] }, status, [mobile], 'followup.cancel'), (error) => error.delivery === 'not_sent');
  await assert.rejects(self.changePiQueue('s', { queue: [mobile, { id: 'd', origin: 'desktop' }] }, { isStreaming: true }, [mobile], 'followup.cancel'), (error) => error.delivery === 'not_sent');
  assert.equal(clears, 0);
});

test('a failed Pi model call shows as an error item', () => {
  const items = messageItems([{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Stream ended without finish_reason', timestamp: 5 }], 3);
  assert.deepEqual(items.map((i) => [i.id, i.value.type, i.value.text, i.value.status]), [['pi-3-e', 'turnError', 'Stream ended without finish_reason', 'failed']]);
});

test('a Pi turn stopped by the user reads as stopped, not failed', () => {
  const { messageItems } = require('../src/backends/pi-web');
  const items = messageItems([{ role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request aborted', timestamp: 5 }], 3);
  assert.deepEqual(items.map((i) => [i.value.type, i.value.text, i.value.status]), [['agentMessage', '已停止', 'interrupted']]);
});

test('Pi never announces a turn before its prompt is accepted', async () => {
  const { methods } = require('../src/backends/pi-sync');
  const announcements = [];
  const self = { ...methods, piThreads: new Map([['s', { cwd: 'I:/x', running: false }]]),
    pi: { probe: async () => 'up', status: async () => ({ isStreaming: false }), prompt: async () => { throw new Error('offline'); } },
    piAttachmentParts: (args) => ({ text: args.text, images: [] }), emit: (kind) => announcements.push(kind),
  };
  await assert.rejects(self.piCommand({ action: 'turn.start', args: { threadId: 's', text: 'hi' } }), /offline/);
  assert.equal(self.piThreads.get('s').running, false); assert.deepEqual(announcements, []);
});

test('images in a Pi user message reach the phone history', () => {
  const { messageItems } = require('../src/backends/pi-web');
  const items = messageItems([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }], timestamp: 1 }], 0);
  assert.equal(items[0].value.text, 'look');
  assert.deepEqual(items[0].value.images, [{ mimeType: 'image/png', data: 'data:image/png;base64,AAAA' }]);
});

test('reads the phone makes by itself do not fail while PI WEB is down or busy', async () => {
  const { methods, PI_OFFLINE, PI_BUSY } = require('../src/backends/pi-sync');
  let started = 0;
  const connector = (state) => ({ piThreads: new Map([['t', { cwd: 'C:\w' }]]), pi: { probe: async () => state, start() { started++; } }, nudgePi() {}, log() {}, emit() {} });
  for (const state of ['down', 'busy']) {
    for (const action of ['thread.settings.read', 'thread.ownership.read', 'history.sync', 'capabilities']) {
      assert.deepEqual(await methods.piCommand.call(connector(state), { action, args: { threadId: 't' } }), { backend: 'pi', offline: true });
    }
    assert.deepEqual(await methods.piCommand.call(connector(state), { action: 'followup.list', args: {} }), { items: [] });
  }
  // What the user asked for still says why it cannot be done.
  await assert.rejects(methods.piCommand.call(connector('down'), { action: 'turn.start', args: { threadId: 't', text: 'hi' } }), { message: PI_OFFLINE });
  await assert.rejects(methods.piCommand.call(connector('busy'), { action: 'turn.start', args: { threadId: 't', text: 'hi' } }), { message: PI_BUSY });
  await assert.rejects(methods.piCommand.call(connector('down'), { action: 'pi.providers.list', args: {} }), { message: PI_OFFLINE });
  // Running but slow is not started a second time.
  assert.deepEqual(await methods.piCommand.call(connector('busy'), { action: 'pi.start', args: {} }), { running: true, busy: true });
  assert.equal(started, 0);
});

test('a slow PI WEB is not auto-started again by the poll', async () => {
  const { methods } = require('../src/backends/pi-sync');
  let started = 0;
  const connector = { config: { accountKey: 'k' }, piThreads: new Map([['t', {}]]), pi: { probe: async () => 'busy', start() { started++; } }, log() {} };
  await methods.pollPi.call(connector);
  assert.equal(started, 0);
  assert.equal(connector.piOnline, false);
  connector.pi.probe = async () => 'down';
  await methods.pollPi.call(connector);
  assert.equal(started, 1);
});

test('PI WEB that takes the connection but does not answer is busy, not down', async () => {
  const { PiWebClient } = require('../src/backends/pi-web');
  const client = new PiWebClient();
  client.request = async () => { throw new Error('PI WEB 没有响应'); };
  assert.equal(await client.probe(), 'busy');
  client.request = async () => { const error = new Error('PI WEB 没有运行'); error.offline = true; throw error; };
  assert.equal(await client.probe(), 'down');
  client.request = async () => ({ version: '1' });
  assert.equal(await client.probe(), 'up');
});

test('Pi index preserves errors, interruptions and verified activity independently from file updates', () => {
  const { methods } = require('../src/backends/pi-sync');
  const self = { ...methods };
  const meta = { activityAt: 100, updatedAt: 900, terminalStatus: 'failed' };
  assert.equal(self.piIndexValue('s', meta).activityAt, 100);
  assert.equal(self.piIndexValue('s', meta).status, 'failed');
  assert.equal(self.piThreadStatus({ ...meta, terminalStatus: 'interrupted' }), 'interrupted');
  assert.equal(self.piThreadStatus({ ...meta, running: true }), 'desktop_running');
  assert.equal(self.piThreadStatus({ ...meta, waiting: {} }), 'desktop_waiting');
});

test('removing one Pi queue entry keeps images on the entries being restored and ignores intermediate empty snapshots', async () => {
  const { methods } = require('../src/backends/pi-sync'); const { SendReceipts } = require('../src/send-receipts');
  const first = { id: 'a', text: 'cancel', createdAt: Date.now(), origin: 'mobile' };
  const second = { id: 'b', text: 'keep', attachments: [{ attachmentId: 'image' }], createdAt: Date.now(), origin: 'mobile' };
  const meta = { cwd: 'I:/x', queue: [first, second] }; const calls = [];
  const self = { ...methods, sendReceipts: new SendReceipts(), savePiThreads() {}, emit() {},
    piAttachmentParts: (entry) => ({ text: entry.text, images: entry.attachments || [] }),
    pi: { clearQueue: async () => { self.trackPiQueue('s', meta, { queuedMessages: [] }); assert.equal(meta.queue.length, 2); },
      prompt: async (...args) => calls.push(args) },
  };
  await self.changePiQueue('s', meta, { isStreaming: true }, [first], 'followup.cancel');
  assert.deepEqual(calls[0], ['s', 'I:/x', 'keep', 'followUp', second.attachments]);
  assert.deepEqual(meta.queue, [second]); assert.equal(self.sendReceipts.get('a').state, 'cancelled');
});

test('a partial Pi queue rebuild retains unresolved messages for review rather than losing them', async () => {
  const { methods } = require('../src/backends/pi-sync'); const { SendReceipts } = require('../src/send-receipts');
  const queue = ['a', 'b', 'c'].map((id) => ({ id, text: id, createdAt: Date.now(), origin: 'mobile' }));
  const meta = { cwd: 'I:/x', queue }; let sends = 0;
  const self = { ...methods, sendReceipts: new SendReceipts(), savePiThreads() {}, emit() {},
    piAttachmentParts: (entry) => ({ text: entry.text, images: [] }),
    pi: { clearQueue: async () => {}, prompt: async () => { if (++sends === 2) throw new Error('timeout'); } },
  };
  await assert.rejects(self.changePiQueue('s', meta, { isStreaming: true }, [queue[0]], 'followup.cancel'), /timeout/);
  assert.deepEqual(meta.queue.map((entry) => entry.id), ['b']);
  assert.equal(self.sendReceipts.get('c').state, 'uncertain');
  assert.equal(self.sendReceipts.visible('s')[0].text, 'c');
});

// settings.set: the model and the thinking level are changed separately, and
// whatever PI ends up running is what the record and the phone show.
function piSettingsFixture({ status, setModel, thinkingLevels, setThinking } = {}) {
  const { methods } = require('../src/backends/pi-sync');
  // `current` is what PI runs now; the fake PI changes it the way PI WEB would.
  const current = { value: status };
  const saved = []; const indexes = []; const calls = [];
  const self = { ...methods, piThreads: new Map([['s', { cwd: 'I:/x', model: 'a/x', thinkingLevel: 'high' }]]), emit() {}, nudgePi() {},
    savePiThreads() { saved.push(true); }, uploadPiIndex: async (id, meta) => { indexes.push({ id, model: meta.model, thinkingLevel: meta.thinkingLevel }); },
    pi: {
      probe: async () => 'up',
      status: async () => current.value,
      setModel: async (id, cwd, provider, modelId) => { calls.push(['setModel', `${provider}/${modelId}`]); if (setModel) return setModel(provider, modelId, current, calls); throw new Error('unexpected setModel'); },
      thinkingLevels: async () => { calls.push(['thinkingLevels']); if (thinkingLevels) return thinkingLevels(); return { levels: ['off', 'minimal', 'low', 'medium', 'high'] }; },
      setThinking: async (id, cwd, level) => { calls.push(['setThinking', level]); if (setThinking) return setThinking(level, current); throw new Error('unexpected setThinking'); },
    },
  };
  const send = (settings) => methods.piCommand.call(self, { action: 'settings.set', args: { threadId: 's', settings } });
  return { self, send, calls, saved, indexes, current };
}

test('a Pi model change alone does not touch the thinking level', async () => {
  const fixture = piSettingsFixture({
    status: { model: { provider: 'a', id: 'x' }, thinkingLevel: 'medium' },
    setModel: (provider, modelId) => ({ model: { provider, id: modelId, name: 'Beta' }, thinkingLevel: 'medium' }),
  });
  const result = await fixture.send({ model: 'b/y' });
  assert.deepEqual(fixture.calls.map((c) => c[0]), ['setModel']);
  assert.deepEqual(result, { saved: true, backend: 'pi', model: 'b/y', effort: 'medium', thinkingLevel: 'medium' });
  assert.deepEqual(fixture.indexes.at(-1), { id: 's', model: 'b/y', thinkingLevel: 'medium' });
  assert.ok(fixture.saved.length >= 1);
});

test('a Pi thinking level change alone does not change the model', async () => {
  const fixture = piSettingsFixture({
    status: { model: { provider: 'a', id: 'x' }, thinkingLevel: 'low' },
    setThinking: (level) => ({ model: { provider: 'a', id: 'x' }, thinkingLevel: level }),
  });
  const result = await fixture.send({ thinkingLevel: 'high' });
  assert.deepEqual(fixture.calls, [['thinkingLevels'], ['setThinking', 'high']]);
  assert.deepEqual(result, { saved: true, backend: 'pi', model: 'a/x', effort: 'high', thinkingLevel: 'high' });
});

test('an unchanged model and level make no PI call at all', async () => {
  const fixture = piSettingsFixture({ status: { model: { provider: 'a', id: 'x' }, thinkingLevel: 'high' } });
  const result = await fixture.send({ model: 'a/x', thinkingLevel: 'high' });
  assert.deepEqual(fixture.calls, []);
  assert.equal(result.effort, 'high');
  assert.equal(result.note, undefined);
});

test('a level the new model does not support keeps the new model and says what is running', async () => {
  // Switching the model makes PI clamp the level; the requested "xhigh" is not offered by the new model.
  const fixture = piSettingsFixture({
    status: { model: { provider: 'a', id: 'x' }, thinkingLevel: 'xhigh' },
    setModel: (provider, modelId, current) => { current.value = { model: { provider, id: modelId, name: 'Beta' }, thinkingLevel: 'high' }; return current.value; },
    thinkingLevels: () => ({ levels: ['off', 'minimal', 'low', 'medium', 'high'] }),
  });
  const result = await fixture.send({ model: 'b/y', thinkingLevel: 'xhigh' });
  assert.deepEqual(fixture.calls.map((c) => c[0]), ['setModel', 'thinkingLevels']);
  assert.equal(result.saved, true);
  assert.equal(result.model, 'b/y');
  assert.equal(result.effort, 'high');
  assert.equal(result.note, '已切到 Beta；这个模型不支持强度「极高」，当前为「高」');
  assert.deepEqual(fixture.indexes.at(-1), { id: 's', model: 'b/y', thinkingLevel: 'high' });
});

test('a level PI refuses after the check is reported as a note, not a failure', async () => {
  const fixture = piSettingsFixture({
    status: { model: { provider: 'a', id: 'x' }, thinkingLevel: 'low' },
    thinkingLevels: () => { throw new Error('PI WEB 没有响应'); },
    setThinking: () => { throw new Error('Invalid thinking level: xhigh'); },
  });
  const result = await fixture.send({ thinkingLevel: 'xhigh' });
  assert.equal(result.saved, true);
  assert.equal(result.effort, 'low');
  assert.equal(result.note, '这个模型不支持强度「极高」，当前为「低」');
});

test('a failed Pi model change still records what PI is running', async () => {
  const fixture = piSettingsFixture({
    status: { model: { provider: 'a', id: 'x' }, thinkingLevel: 'medium' },
    setModel: () => { throw new Error('Model not found: b/z'); },
  });
  await assert.rejects(fixture.send({ model: 'b/z' }), /Model not found/);
  assert.deepEqual(fixture.indexes.at(-1), { id: 's', model: 'a/x', thinkingLevel: 'medium' });
  assert.ok(fixture.saved.length >= 1);
});

test('a Pi error from PI reaches the phone in Chinese', () => {
  const { phoneErrorText } = require('../src/connector');
  assert.equal(phoneErrorText('Invalid thinking level: xhigh'), '这个模型不支持所选的思考强度，请换一个强度');
  assert.equal(phoneErrorText('Model not found: b/z'), '找不到这个模型，请在 PI WEB 里确认它仍然可用');
});
