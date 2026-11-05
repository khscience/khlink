const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Connector } = require('../src/connector');
const { DirectHistory } = require('../src/direct-history');
const { relayEnabled } = require('../src/config');

function tmp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-relay-standby-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('direct mode keeps the relay only for a computer that is signed in', () => {
  assert.equal(relayEnabled({ directOnly: false }), true);
  assert.equal(relayEnabled({ directOnly: true, refreshToken: 'r' }), true);
  assert.equal(relayEnabled({ directOnly: true, refreshToken: null }), false, 'QR-only computers stay off the relay');
});

test('the local direct history lists what changed since a time, in upload form', async (t) => {
  const history = new DirectHistory(tmp(t), { deviceId: 'pc.connector' });
  await history.put('/api/v2/history/threads', { id: 'old', updatedAt: 1, nonce: 'n', ciphertext: 'c' });
  const since = Date.now();
  await history.put('/api/v2/history/threads', { id: 't1', updatedAt: since, nonce: 'n', ciphertext: 'c' });
  await history.put('/api/v2/history/threads/t1/items', { items: [{ id: 'i1', order: 16, createdAt: 5, nonce: 'n', ciphertext: 'c' }] });
  const changes = await history.changedSince(since);
  assert.deepEqual(changes.map((change) => change.thread.id), ['t1']);
  assert.deepEqual(changes[0].thread, { id: 't1', updatedAt: since, nonce: 'n', ciphertext: 'c' }, 'no local bookkeeping fields');
  assert.deepEqual(changes[0].items, [{ id: 'i1', order: 16, createdAt: 5, nonce: 'n', ciphertext: 'c' }], 'saved after `since` counts, whatever its creation time');
});

test('on standby only presence goes to the relay; a phone using the relay ends it and catches the relay up', async (t) => {
  const directory = tmp(t);
  const connector = Object.create(Connector.prototype);
  const relayed = []; const uploads = [];
  connector.config = { directOnly: true, refreshToken: 'r', accountKey: Buffer.alloc(32, 1).toString('base64'), configFile: path.join(directory, 'config.json') };
  connector.ws = { readyState: 1, send: (raw) => relayed.push(JSON.parse(raw).kind) };
  connector.direct = { send: () => false };
  connector.log = () => {}; connector.stopping = false;
  connector.republishActiveThreadStatuses = () => {};
  connector.directHistory = { changedSince: async (since) => [{ thread: { id: 't1', since }, items: [{ id: 'i1', order: 16 }] }] };
  connector.api = { path: (route) => `/api/v2${route}`, request: async (route, options) => { uploads.push({ route, skipLocal: options.skipLocal, body: options.body }); return {}; } };

  connector.prepareRelayGap();
  const gap = JSON.parse(fs.readFileSync(path.join(directory, 'relay-gap.json'), 'utf8'));
  assert.ok(gap.since < Date.now() - 6 * 86_400_000, 'a computer already in direct mode catches up the last week');
  assert.equal(connector.relayStandby(), true);
  connector.send('thread.status', 't1', { status: 'running' });
  connector.send('item.completed', 't1', { text: 'x' });
  connector.send('connector.presence', null, {});
  assert.deepEqual(relayed, ['connector.presence'], 'standby relays presence only');
  assert.equal(await connector.replayRelayGap(), undefined, 'no catch-up while on standby');
  assert.equal(uploads.length, 0);

  connector.noteRelayFrame(JSON.stringify({ kind: 'connector.presence' }));
  assert.equal(connector.relayStandby(), true, 'only a phone command ends the standby');
  connector.noteRelayFrame(JSON.stringify({ kind: 'command' }));
  assert.equal(connector.relayStandby(), false);
  await connector.relayGapReplay;
  assert.deepEqual(uploads.map((upload) => [upload.route, upload.skipLocal]), [['/api/v2/history/threads', true], ['/api/v2/history/threads/t1/items', true]]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'relay-gap.json'), 'utf8')).since, null, 'the gap is closed');
  assert.ok(relayed.includes('thread.status'), 'the status held back on standby is sent');
  connector.send('item.completed', 't1', { text: 'y' });
  assert.equal(relayed.at(-1), 'item.completed');
});
