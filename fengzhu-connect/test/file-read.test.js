const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Connector } = require('../src/connector');
const { ready, decryptJson, decryptBlob, FILE_BLOB } = require('../src/crypto');

test('file.read sends a binary chunk once-encoded to phones that ask for it and base64 to older ones', async () => {
  await ready();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-read-'));
  const file = path.join(dir, 'a.bin'); const bytes = Buffer.alloc(700 * 1024, 7); fs.writeFileSync(file, bytes);
  try {
    const connector = Object.create(Connector.prototype);
    const legacy = connector.readFile({ path: file, offset: 0 });
    assert.equal(Buffer.from(legacy.data, 'base64').length, 512 * 1024); assert.equal(legacy.eof, false);
    const chunk = connector.readFile({ path: file, offset: 512 * 1024, binary: true });
    assert.equal(chunk.data, undefined); assert.equal(chunk.size, 188 * 1024); assert.equal(chunk.eof, true);
    assert.deepEqual(chunk[FILE_BLOB], bytes.subarray(512 * 1024));
    const sent = []; const key = Buffer.alloc(32, 5);
    connector.config = { accountKey: key }; connector.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
    connector.send('file.result', null, { requestId: 'r1', ok: true, result: chunk }, 'phone');
    const frame = sent[0];
    assert.deepEqual(decryptBlob(key, frame), bytes.subarray(512 * 1024));
    assert.equal(decryptJson(key, frame).result.size, 188 * 1024);
    // One base64 layer: the frame is about 4/3 of the chunk, not 16/9.
    assert.ok(JSON.stringify(frame).length < chunk.size * 1.4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
