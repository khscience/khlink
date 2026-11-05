const test = require('node:test');
const assert = require('node:assert/strict');
const { ready, deriveAccountKey, encryptJson, decryptJson, wrapAccountKey, unwrapAccountKey } = require('../src/crypto');

test('XChaCha payload roundtrip and associated data binding', async () => {
  await ready(); const key = deriveAccountKey('this is a sufficiently long passphrase', Buffer.alloc(16, 7).toString('base64'), 10);
  const encrypted = encryptJson(key, 'event', 'thread-1', 'id-1', { hello: 'world' });
  assert.deepEqual(decryptJson(key, { id: 'id-1', kind: 'event', threadId: 'thread-1', ...encrypted }), { hello: 'world' });
  assert.throws(() => decryptJson(key, { id: 'id-2', kind: 'event', threadId: 'thread-1', ...encrypted }));
});

test('password key wraps a distinct history master key', async () => {
  await ready(); const passwordKey = Buffer.alloc(32, 3); const accountKey = Buffer.alloc(32, 7);
  const envelope = wrapAccountKey(passwordKey, accountKey);
  assert.deepEqual(unwrapAccountKey(passwordKey, envelope), accountKey);
  assert.throws(() => unwrapAccountKey(Buffer.alloc(32, 4), envelope));
});

test('file chunks travel as a sealed blob beside the JSON and are bound to the frame id', async () => {
  const { encryptBlob, decryptBlob, blobFields, FILE_BLOB } = require('../src/crypto');
  await ready(); const key = Buffer.alloc(32, 9); const bytes = Buffer.from([0, 1, 2, 250, 255]);
  const sealed = encryptBlob(key, 'id-1', bytes);
  assert.deepEqual(decryptBlob(key, { id: 'id-1', ...sealed }), bytes);
  assert.throws(() => decryptBlob(key, { id: 'id-2', ...sealed }));
  const value = { requestId: 'r', ok: true, result: { size: 5, [FILE_BLOB]: bytes } };
  assert.equal(JSON.stringify(value).includes('250'), false);
  assert.deepEqual(decryptBlob(key, { id: 'id-3', ...blobFields(key, 'id-3', value) }), bytes);
  assert.deepEqual(blobFields(key, 'id-4', { ok: true, result: { data: 'AA==' } }), {});
});
