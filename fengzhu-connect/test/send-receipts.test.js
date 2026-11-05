const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Connector } = require('../src/connector');
const { SendReceipts } = require('../src/send-receipts');

function connector(store = new SendReceipts()) {
  const self = Object.create(Connector.prototype);
  self.sendReceipts = store; self.frames = [];
  self.send = (kind, id, value) => self.frames.push({ kind, id, value });
  self.log = (error) => { throw error; };
  return self;
}
const payload = (id = 'req', threadId = 'chat') => ({ requestId: id, action: 'turn.start', args: { threadId, text: 'hello' } });

test('simultaneous Claude/Pi replays wait for the same durable result', async () => {
  for (const backend of ['claude', 'pi']) {
    const self = connector(); let sends = 0; let release;
    const run = async () => { sends++; await new Promise((resolve) => { release = resolve; }); return { accepted: true }; };
    const first = self.deliverOnce(payload(), run, backend);
    const second = self.deliverOnce(payload(), run, backend);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sends, 1);
    assert.equal(self.frames[0].value.state, 'dispatching');
    release(); const results = await Promise.all([first, second]);
    assert.ok(results.every((result) => result.accepted)); assert.equal(results[1].duplicate, true);
  }
});

test('different sessions can send independently and reused IDs cannot change content', async () => {
  const self = connector(); let release;
  const first = self.deliverOnce(payload('one', 'a'), () => new Promise((resolve) => { release = resolve; }));
  const other = await self.deliverOnce(payload('two', 'b'), async () => ({ accepted: true }));
  assert.equal(other.accepted, true); release({ accepted: true }); await first;
  await assert.rejects(self.deliverOnce({ ...payload('one', 'a'), args: { threadId: 'a', text: 'changed' } }, async () => {}), /内容不一致/);
});

test('encrypted receipts survive restart and unfinished dispatches are not repeated', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-receipts-'));
  const file = path.join(root, 'receipts.dat');
  t.after(() => { fs.rmSync(file, { force: true }); fs.rmdirSync(root); });
  const store = new SendReceipts(file);
  const self = connector(store);
  await self.deliverOnce(payload('done'), async () => ({ accepted: true }), 'pi');
  store.begin('interrupted', 'claude', payload('interrupted').args);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('hello'));
  const recovered = connector(new SendReceipts(file));
  const done = await recovered.deliverOnce(payload('done'), () => assert.fail('repeat'), 'pi');
  const uncertain = await recovered.deliverOnce(payload('interrupted'), () => assert.fail('repeat'), 'claude');
  assert.equal(done.accepted, true); assert.equal(uncertain.uncertain, true);
  assert.equal(recovered.sendReceipts.visible()[0].id, 'interrupted');
  fs.writeFileSync(file, 'corrupted'); assert.throws(() => new SendReceipts(file));
});

test('receipt persistence fails before sending and uncertain errors remain reviewable', async () => {
  const self = connector(); self.sendReceipts.save = () => { throw new Error('disk'); };
  await assert.rejects(self.deliverOnce(payload(), () => assert.fail('send')), /disk/);
  const live = connector();
  const result = await live.deliverOnce(payload(), async () => { throw new Error('timeout after handover'); });
  assert.equal(result.uncertain, true); assert.equal(result.accepted, false);
  const repeat = await live.deliverOnce(payload(), () => assert.fail('repeat'));
  assert.equal(repeat.uncertain, true);
  const dismissed = await live.deliverOnce({ action: 'followup.cancel', args: { threadId: 'chat', id: 'req' } }, () => assert.fail('offline backend'));
  assert.equal(dismissed.dismissed, true); assert.deepEqual(live.sendReceipts.visible(), []);
});

test('known pre-send failures are failed and a started queue receipt never replays as queued', async () => {
  const self = connector();
  const result = await self.deliverOnce(payload('bad'), async () => { throw Object.assign(new Error('draft'), { delivery: 'not_sent' }); });
  assert.equal(result.failed, true); assert.equal(result.uncertain, false);
  await self.deliverOnce(payload('queue'), async () => ({ queued: true }));
  self.emit('followup.started', 'chat', { id: 'queue', startedAt: Date.now() });
  const replay = await self.deliverOnce(payload('queue'), () => assert.fail('repeat'));
  assert.equal(replay.accepted, true); assert.equal(replay.queued, false);
});

test('Claude queue handover keeps a durable dispatch until acceptance and retains failures', async () => {
  const self = connector();
  self.claudeThreads = new Map([['chat', { mobileQueue: [{ id: 'queued', text: 'later', state: 'desktop_queued', createdAt: Date.now() }] }]]);
  self.saveClaudeThreads = () => {}; self.claudeDesktopBusy = () => false; self.claude = { isRunning: () => false };
  self.executeClaudeCommand = async () => {
    assert.equal(self.claudeQueue('chat')[0].state, 'dispatching');
    assert.equal(self.sendReceipts.get('queued').state, 'dispatching');
    throw new Error('unknown timeout');
  };
  await self.drainClaudeQueue('chat');
  assert.equal(self.claudeQueue('chat').length, 0);
  assert.equal(self.sendReceipts.visible('chat')[0].state, 'uncertain');
  await self.drainClaudeQueue('chat');
});

test('Claude keeps image attachments when a running conversation queues and then starts', async () => {
  const self = connector(); const delivered = [];
  const attachment = { name: '图.png', attachmentId: 'id', mimeType: 'image/png', path: 'I:/tmp/private.png' };
  let busy = true;
  self.claudeThreads = new Map([['chat', {}]]); self.claude = { isRunning: () => busy };
  self.claudeDesktopBusy = () => false; self.saveClaudeThreads = () => {}; self.setClaudeThreadFields = () => {};
  self.executeClaudeCommand = async (action, args) => { delivered.push({ action, args }); return { accepted: true }; };
  const result = await self.claudeQueueCommand({ action: 'followup.enqueue', requestId: 'image-q', args: { threadId: 'chat', text: '看图', attachments: [attachment] } });
  assert.equal(result.queued, true);
  assert.equal(JSON.stringify(self.claudeQueueItems('chat')).includes('private.png'), false);
  assert.equal(JSON.stringify(self.frames).includes('private.png'), false);
  busy = false; await self.drainClaudeQueue('chat');
  assert.deepEqual(delivered[0].args.attachments, [attachment]);
  assert.equal(self.sendReceipts.get('image-q').state, 'started');
});

test('Claude does not publish fake user history when its process rejects the send', async () => {
  const self = connector(); self.claudeThreads = new Map([['chat', {}]]);
  self.config = {}; self.ensureClaudeSession = () => {};
  self.deliverClaudeToDesktop = async () => null; self.claudeAttachmentParts = () => ({ text: 'hello', images: [] });
  self.persistClaudeUserMessage = () => assert.fail('fake history');
  self.claude = { startTurn: () => { throw new Error('not available'); } };
  await assert.rejects(self.executeClaudeCommand('turn.start', { threadId: 'chat' }), /not available/);
});

test('late Claude/Pi history resolves uncertainty without matching an older identical message twice', () => {
  const store = new SendReceipts();
  const row = store.begin('late', 'pi', { threadId: 'chat', text: 'hello' });
  store.update('late', { state: 'uncertain' });
  const old = { id: 'old', order: 1, at: row.createdAt - 1, value: { type: 'userMessage', text: 'hello' } };
  assert.deepEqual(store.reconcile('pi', 'chat', [old]), []);
  const fresh = { ...old, id: 'fresh', order: 2, at: row.createdAt + 100 };
  assert.equal(store.reconcile('pi', 'chat', [fresh])[0].state, 'started');
  store.begin('second', 'pi', { threadId: 'chat', text: 'hello' }); store.update('second', { state: 'uncertain' });
  assert.deepEqual(store.reconcile('pi', 'chat', [fresh]), []);
});

test('image receipts need a newer message with the exact images, including image-only Pi messages', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-image-receipt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.png'); const bytes = Buffer.from('test image bytes'); fs.writeFileSync(file, bytes);
  const attachment = { name: 'sample.png', path: file, mimeType: 'image/png', attachmentId: 'opaque-id' };
  const store = new SendReceipts();
  const row = store.begin('img', 'pi', { threadId: 'chat', text: '', attachments: [attachment], historyAfterOrder: 10 });
  store.update(row.id, { state: 'dispatching' });
  const candidate = (id, order, value) => ({ id, order, at: row.createdAt + 1, value: { type: 'userMessage', text: '请看图片', ...value } });
  const good = { mimeType: 'image/png', data: `data:image/png;base64,${bytes.toString('base64')}` };
  const wrong = { mimeType: 'image/png', data: `data:image/png;base64,${Buffer.from('different').toString('base64')}` };
  assert.deepEqual(store.reconcile('pi', 'chat', [candidate('old', 10, { images: [good] })]), []);
  assert.deepEqual(store.reconcile('pi', 'chat', [candidate('missing', 11, {})]), []);
  assert.deepEqual(store.reconcile('pi', 'chat', [candidate('wrong', 12, { images: [wrong] })]), []);
  assert.equal(store.reconcile('pi', 'chat', [candidate('right', 13, { images: [good] })])[0].state, 'started');
  assert.equal(JSON.stringify(store.item(row)).includes(file), false);
  const mixed = store.begin('mixed', 'claude', { threadId: 'chat', text: '看图', attachments: [attachment] });
  store.update(mixed.id, { state: 'uncertain' });
  const sameText = { id: 'same-text', order: 14, at: mixed.createdAt + 1, value: { type: 'userMessage', text: '看图' } };
  assert.deepEqual(store.reconcile('claude', 'chat', [sameText]), []);
  sameText.value.images = [good];
  assert.equal(store.reconcile('claude', 'chat', [sameText])[0].state, 'started');
});

test('DSH image references confirm only the exact newer request with all images', () => {
  const store = new SendReceipts();
  const row = store.begin('rpc-1', 'dsh', { threadId: 'chat', text: '', historyAfterOrder: 50,
    attachments: [{ name: 'one.png', path: 'expired.png', mimeType: 'image/png' }] });
  store.update(row.id, { state: 'desktop_queued' });
  const record = (overrides = {}) => ({ id: 'record', order: 51, at: row.createdAt + 1, receiptRequestId: 'rpc-1', receiptImageCount: 1,
    value: { type: 'userMessage', text: '图片附件（预览不可用）' }, ...overrides });
  assert.deepEqual(store.reconcile('dsh', 'chat', [record({ order: 50 })]), []);
  assert.deepEqual(store.reconcile('dsh', 'chat', [record({ receiptRequestId: 'another-rpc' })]), []);
  assert.deepEqual(store.reconcile('dsh', 'chat', [record({ receiptImageCount: 0 })]), []);
  assert.deepEqual(store.reconcile('dsh', 'other-chat', [record()]), []);
  assert.equal(store.reconcile('dsh', 'chat', [record()])[0].state, 'started');
  const other = store.begin('rpc-2', 'dsh', { threadId: 'chat', text: '', historyAfterOrder: 50,
    attachments: [{ name: 'two.png', path: 'expired.png', mimeType: 'image/png' }] });
  store.update(other.id, { state: 'desktop_queued' });
  assert.deepEqual(store.reconcile('dsh', 'chat', [record()]), []);
});
