const test = require('node:test');
const assert = require('node:assert/strict');
const { LightDetailTransfers, DETAIL_CHUNK_CHARS, MAX_NEGOTIATED_CHUNK_CHARS, LEGACY_DETAIL_JSON_BYTES } = require('../src/light-detail-transfer');
const { Connector } = require('../src/connector');
const { ready, encryptJson, decryptJson } = require('../src/crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('large encrypted details are reconstructed from bounded, consistent chunks', async () => {
  const original = 'abcdefghijklmnopqrstuvwxyz';
  let current = original;
  const transfer = new LightDetailTransfers(async (_threadId, ids) => [{ id: ids[0], nonce: 'nonce', ciphertext: current }], { chunkChars: 8 });
  const first = await transfer.read({ threadId: 'th', id: 'row' });
  assert.equal(first.chunk, 'abcdefgh');
  assert.equal(first.eof, false);
  assert.ok(first.transferId);
  current = 'changed-after-transfer-start';
  let assembled = first.chunk;
  let part = first;
  while (!part.eof) {
    part = await transfer.read({ threadId: 'th', id: 'row', transferId: first.transferId, offset: assembled.length });
    assert.equal(part.nonce, first.nonce);
    assert.equal(part.total, original.length);
    assembled += part.chunk;
  }
  assert.equal(assembled, original);
  assert.equal((await transfer.read({ threadId: 'th', id: 'row' })).chunk, 'changed-');
  // A lost last response can be retried while the snapshot is still alive.
  assert.equal((await transfer.read({ threadId: 'th', id: 'row', transferId: first.transferId, offset: 24 })).chunk, 'yz');
});

test('detail chunks reject wrong task, item, offset, expired token and oversized records', async () => {
  let clock = 0;
  const transfer = new LightDetailTransfers(async (_threadId, ids) => [{ id: ids[0], nonce: 'n', ciphertext: 'abcdefghijklmno' }],
    { chunkChars: 4, maxDetailChars: 20, maxCacheChars: 20, ttlMs: 100, now: () => clock });
  const first = await transfer.read({ threadId: 'th', id: 'row' });
  await assert.rejects(transfer.read({ threadId: 'other', id: 'row', transferId: first.transferId, offset: 4 }), /已过期/);
  await assert.rejects(transfer.read({ threadId: 'th', id: 'other', transferId: first.transferId, offset: 4 }), /已过期/);
  await assert.rejects(transfer.read({ threadId: 'th', id: 'row', offset: 4 }), /已过期/);
  await assert.rejects(transfer.read({ threadId: 'th', id: 'row', transferId: first.transferId, offset: 99 }), /位置无效/);
  clock = 101;
  await assert.rejects(transfer.read({ threadId: 'th', id: 'row', transferId: first.transferId, offset: 4 }), /已过期/);
  const large = new LightDetailTransfers(async () => [{ id: 'row', nonce: 'n', ciphertext: 'x'.repeat(21) }], { maxDetailChars: 20 });
  await assert.rejects(large.read({ threadId: 'th', id: 'row' }), /过大/);
});

test('detail transfer cache is bounded and evicted snapshots do not silently change', async () => {
  const transfer = new LightDetailTransfers(async (_threadId, ids) => [{ id: ids[0], nonce: 'n', ciphertext: 'x'.repeat(12) }],
    { chunkChars: 4, maxDetailChars: 20, maxCacheChars: 20 });
  const first = await transfer.read({ threadId: 'th', id: 'one' });
  const second = await transfer.read({ threadId: 'th', id: 'two' });
  assert.ok(transfer.cacheChars <= 20);
  await assert.rejects(transfer.read({ threadId: 'th', id: 'one', transferId: first.transferId, offset: 4 }), /已过期/);
  assert.equal((await transfer.read({ threadId: 'th', id: 'two', transferId: second.transferId, offset: 4 })).chunk, 'xxxx');
});

test('an active slow transfer renews its idle timeout but an abandoned one expires', async () => {
  let clock = 0;
  const transfer = new LightDetailTransfers(async () => [{ id: 'row', nonce: 'n', ciphertext: 'abcdefghijklmnopqrstuvwxyz' }],
    { chunkChars: 4, ttlMs: 100, now: () => clock });
  const first = await transfer.read({ threadId: 'th', id: 'row' });
  clock = 90;
  const second = await transfer.read({ threadId: 'th', id: 'row', transferId: first.transferId, offset: 4 });
  clock = 180; // Past the original deadline, still within the last activity window.
  assert.equal((await transfer.read({ threadId: 'th', id: 'row', transferId: first.transferId, offset: 8 })).chunk, 'ijkl');
  clock = 281;
  await assert.rejects(transfer.read({ threadId: 'th', id: 'row', transferId: second.transferId, offset: 12 }), /已过期/);
});

test('new phones can negotiate larger relay-safe parts without changing older phones', async () => {
  await ready();
  const transfer = new LightDetailTransfers(async () => [{ id: 'row', nonce: 'n', ciphertext: 'A'.repeat(MAX_NEGOTIATED_CHUNK_CHARS + 100) }]);
  const old = await transfer.read({ threadId: 'th', id: 'row' });
  const fast = await transfer.read({ threadId: 'th', id: 'row', maxChunkChars: 99 * 1024 * 1024 });
  assert.equal(old.chunk.length, DETAIL_CHUNK_CHARS);
  assert.equal(fast.chunk.length, MAX_NEGOTIATED_CHUNK_CHARS);
  const encrypted = encryptJson(Buffer.alloc(32, 11), 'file.result', 'th', 'request', { ok: true, result: fast });
  assert.ok(Buffer.byteLength(JSON.stringify(encrypted)) < 2 * 1024 * 1024);
});

test('old generated-image details recover all images from the matching rollout only', async () => {
  await ready();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-generated-image-recovery-'));
  const threadId = 'abcdef12-9012-1234-1234-123456789abc';
  const id = 'fco_generated_image';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const images = ['one', 'two', 'three', 'four'].map(value => `data:image/png;base64,${Buffer.from(value.repeat(10)).toString('base64')}`);
  const record = { type: 'response_item', timestamp: '2026-11-09T12:50:03Z', payload: { id, type: 'function_call_output',
    output: [{ type: 'input_text', text: 'Generated images are saved' }, ...images.map(image_url => ({ type: 'input_image', image_url }))] } };
  fs.writeFileSync(file, JSON.stringify(record) + '\n');
  try {
    const key = Buffer.alloc(32, 9);
    const oldValue = { type: 'imageGeneration', text: '图片已生成', images: images.slice(0, 3).map(data => ({ data, mimeType: 'image/png' })), status: 'completed' };
    const row = { id, ...encryptJson(key, 'history.item', threadId, id, oldValue) };
    let saved;
    const connector = Object.create(Connector.prototype);
    Object.assign(connector, { config: { accountKey: key }, rolloutFilesByThread: new Map([[threadId, file]]),
      lightMode: { details: async () => [saved || row], save: async (thread, value) => { assert.equal(thread, threadId); saved = value; } }, stopping: false });
    const part = await connector.executeCommand({ action: 'file.historyDetailPart', args: { threadId, id } });
    const restored = decryptJson(key, { kind: 'history.item', threadId, id, nonce: part.nonce, ciphertext: part.chunk });
    assert.deepEqual(restored.images.map(image => image.data), images);
    assert.deepEqual(decryptJson(key, { kind: 'history.item', threadId, id, nonce: saved.nonce, ciphertext: saved.ciphertext }).images.map(image => image.data), images);
    fs.unlinkSync(file);
    const later = await connector.lightDetailsForTransfer(threadId, [id]);
    assert.deepEqual(decryptJson(key, { kind: 'history.item', threadId, id, nonce: later[0].nonce, ciphertext: later[0].ciphertext }).images.map(image => image.data), images);
    // A different item id may never borrow the original's images.
    const wrong = await connector.lightDetailsForTransfer(threadId, ['other']);
    assert.equal(wrong[0].ciphertext, saved.ciphertext);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy replies are bounded and new chunks remain below the relay websocket limit', async () => {
  await ready();
  const row = { id: 'row', nonce: 'n', ciphertext: 'x'.repeat(LEGACY_DETAIL_JSON_BYTES + 1) };
  const connector = Object.create(Connector.prototype);
  connector.lightMode = { details: async () => [row] };
  await assert.rejects(connector.executeCommand({ action: 'history.details', args: { threadId: 'th', ids: ['row'] } }), /更新手机端/);
  const part = await connector.executeCommand({ action: 'file.historyDetailPart', args: { threadId: 'th', id: 'row', offset: 0 } });
  assert.equal(part.chunk.length, DETAIL_CHUNK_CHARS);
  const encrypted = encryptJson(Buffer.alloc(32, 11), 'file.result', 'th', 'request', { ok: true, result: part });
  assert.ok(Buffer.byteLength(JSON.stringify(encrypted)) < 2 * 1024 * 1024);
});

test('detail reads bypass agent routing and the running-turn lock for all backends', async () => {
  const connector = Object.create(Connector.prototype);
  connector.pi = {}; connector.piThreads = new Map([['pi-thread', {}]]);
  connector.dsh = {}; connector.dshThreads = new Map([['dsh-thread', {}]]);
  connector.hermesTransport = {}; connector.hermesThreads = new Map([['hermes-thread', {}]]);
  connector.antigravityThreads = new Map([['ag-thread', {}]]);
  connector.lightMode = { details: async (_thread, ids) => [{ id: ids[0], nonce: 'n', ciphertext: 'abc' }] };
  for (const threadId of ['pi-thread', 'dsh-thread', 'hermes-thread', 'ag-thread']) {
    const result = await connector.command({ action: 'file.historyDetailPart', args: { threadId, id: 'row' } });
    assert.equal(result.chunk, 'abc');
    const legacy = await connector.command({ action: 'history.details', args: { threadId, ids: ['row'] } });
    assert.equal(legacy.items[0].id, 'row');
  }
});

test('resumable detail scans signal pending only to phones that opted in', async () => {
  const connector = Object.create(Connector.prototype);
  connector.lightMode = { details: async () => { throw Object.assign(new Error('继续查找'), { code: 'LIGHT_DETAILS_RETRY' }); } };
  const payload = { action: 'file.historyDetailPart', args: { threadId: 'th', id: 'row' } };
  await assert.rejects(connector.executeCommand(payload), /继续查找/);
  assert.deepEqual(await connector.executeCommand({ ...payload, args: { ...payload.args, resumeSearch: true } }),
    { id: 'row', found: false, pending: true });
});
