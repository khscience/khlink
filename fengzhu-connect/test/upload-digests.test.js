const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ready } = require('../src/crypto');
const { Connector } = require('../src/connector');
const { UploadDigests, UploadStats, describe } = require('../src/upload-digests');

const key = Buffer.alloc(32, 5);
const home = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-digests-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

function connectorIn(dir, puts) {
  const connector = Object.create(Connector.prototype);
  connector.config = { accountKey: key, configFile: path.join(dir, 'config.json'), serverUrl: 'https://relay.example' };
  connector.uploadDedupe = true;
  connector.api = { path: (p) => p, request: async (route, options) => { puts.push(options.body.items.map((row) => row.id)); return { saved: options.body.items.length }; } };
  connector.log = () => {};
  return connector;
}

async function rows(connector, threadId, values) {
  const out = [];
  for (const [id, value] of values) out.push({ id, order: value.createdAt * 1000, createdAt: value.createdAt, ...await connector.historyItemFrame(threadId, id, value) });
  return out;
}

test('after a restart, rows already uploaded unchanged are not sent again; changed and new rows are', async (t) => {
  await ready();
  const dir = home(t); const puts = [];
  const values = [['a', { type: 'userMessage', text: '看一下', createdAt: 1 }], ['b', { type: 'agentMessage', text: '好', createdAt: 2 }]];
  const first = connectorIn(dir, puts);
  await first.putHistoryItems('th', await rows(first, 'th', values));
  first.uploadDigests.flush();
  assert.deepEqual(puts, [['a', 'b']]);

  // A new connector process (restart or update) re-reads the same rows:
  // each is encrypted again with a new nonce, and none goes up.
  const second = connectorIn(dir, puts);
  const result = await second.putHistoryItems('th', await rows(second, 'th', values));
  assert.deepEqual(result, { saved: 0, skipped: 2 });
  assert.equal(puts.length, 1);

  // A reply that grew, and a new row: only those two.
  const next = [values[0], ['b', { type: 'agentMessage', text: '好了，改完了', createdAt: 2 }], ['c', { type: 'agentMessage', text: '还有', createdAt: 3 }]];
  await second.putHistoryItems('th', await rows(second, 'th', next));
  assert.deepEqual(puts[1], ['b', 'c']);
  // Rows encrypted elsewhere (no digest known) always go up.
  await second.putHistoryItems('th', [{ id: 'x', order: 9, nonce: 'n', ciphertext: 'c' }]);
  assert.deepEqual(puts[2], ['x']);
});

test('another account, another relay or a forgotten conversation sends everything again', async (t) => {
  await ready();
  const dir = home(t); const puts = [];
  const values = [['a', { type: 'userMessage', text: 'hi', createdAt: 1 }]];
  const first = connectorIn(dir, puts);
  await first.putHistoryItems('th', await rows(first, 'th', values)); first.uploadDigests.flush();
  const otherRelay = connectorIn(dir, puts); otherRelay.config.serverUrl = 'https://self-hosted.example';
  await otherRelay.putHistoryItems('th', await rows(otherRelay, 'th', values));
  assert.equal(puts.length, 2);
  const same = connectorIn(dir, puts);
  same.historyUploadDigests().forget('th');
  await same.putHistoryItems('th', await rows(same, 'th', values));
  assert.equal(puts.length, 3);
});

test('a relay without the conversation row gets every item again after the row is restored', async (t) => {
  await ready();
  const dir = home(t); const puts = [];
  const connector = connectorIn(dir, puts);
  const values = [['a', { type: 'userMessage', text: 'hi', createdAt: 1 }]];
  await connector.putHistoryItems('th', await rows(connector, 'th', values));
  let refused = true;
  connector.api.request = async (route, options) => {
    if (refused) { refused = false; throw new Error('500 {"statusCode":500}'); }
    puts.push(options.body.items.map((row) => row.id)); return { saved: 1 };
  };
  connector.ensureThreadIndexed = async () => true;
  await connector.putHistoryItems('th', await rows(connector, 'th', [['b', { type: 'agentMessage', text: 'new', createdAt: 2 }]]));
  assert.deepEqual(puts.at(-1), ['b']);
  // The record was dropped with the refusal: the old row goes up again.
  await connector.putHistoryItems('th', await rows(connector, 'th', values));
  assert.deepEqual(puts.at(-1), ['a']);
});

test('a record older than its age limit is dropped', (t) => {
  let now = 1_000;
  const digests = new UploadDigests(home(t), key, { now: () => now, maxAgeMs: 100 });
  digests.noteFrame({ nonce: 'n1' }, 'th', 'a', { text: 'x' });
  const first = digests.filter('th', [{ id: 'a', nonce: 'n1', order: 1 }]);
  digests.remember('th', first.send); digests.flush();
  digests.noteFrame({ nonce: 'n2' }, 'th', 'a', { text: 'x' });
  assert.equal(digests.filter('th', [{ id: 'a', nonce: 'n2', order: 1 }]).skipped.length, 1);
  now += 200;
  digests.noteFrame({ nonce: 'n3' }, 'th', 'a', { text: 'x' });
  assert.equal(digests.filter('th', [{ id: 'a', nonce: 'n3', order: 1 }]).send.length, 1);
});

test('the hourly upload log says how much went to text, images and tools, and what was skipped', () => {
  const lines = []; let now = 0;
  const stats = new UploadStats((line) => lines.push(line), { now: () => now, intervalMs: 1000 });
  stats.add('thread-one-long-id', [{ row: { ciphertext: 'x'.repeat(2 * 1048576) }, info: describe({ type: 'userMessage', images: [{}] }) },
    { row: { ciphertext: 'y'.repeat(1048576) }, info: describe({ type: 'agentMessage' }) }], [{ row: { ciphertext: 'z'.repeat(10) } }]);
  now = 1500;
  stats.add('other', [{ row: { ciphertext: 'c' }, info: describe({ type: 'commandExecution' }) }], []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /sent 3\.00 MB in 2 requests \[image 2\.00 MB \(1\), text 1\.00 MB \(1\), tool 0\.00 MB \(1\)\]; skipped 1 unchanged rows/);
  assert.match(lines[0], /top thread-one-long- 3\.00 MB/);
});
