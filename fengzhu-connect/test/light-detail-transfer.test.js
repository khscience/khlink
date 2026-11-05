const test = require('node:test');
const assert = require('node:assert/strict');
const { LightDetailTransfers, DETAIL_CHUNK_CHARS, LEGACY_DETAIL_JSON_BYTES } = require('../src/light-detail-transfer');
const { Connector } = require('../src/connector');
const { ready, encryptJson } = require('../src/crypto');

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
