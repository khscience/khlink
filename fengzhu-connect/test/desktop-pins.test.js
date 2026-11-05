const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { Connector } = require('../src/connector');
const { ready, decryptJson } = require('../src/crypto');
const { desktopPinState } = require('../src/history');

const first = '00000000-0000-0000-0000-000000000001';
const second = '00000000-0000-0000-0000-000000000002';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-pins-'));
  // Remove only files created by this fixture, without recursive deletion.
  const file = path.join(root, 'state.json');
  t.after(() => { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(root); });
  const connector = Object.create(Connector.prototype);
  connector.desktopStateFile = file;
  connector.config = { accountKey: Buffer.alloc(32) };
  const uploads = [];
  connector.api = { path: (p) => p, request: async (_p, { body }) => uploads.push({
    indexUpdatedAt: body.updatedAt,
    ...decryptJson(connector.config.accountKey, { ...body, kind: 'history.thread', threadId: body.id }),
  }) };
  const write = (ids) => fs.writeFileSync(file, JSON.stringify({ 'pinned-thread-ids': ids }));
  return { connector, uploads, write };
}

test('raw history and conversation uploads retain the current Desktop pins and order', async (t) => {
  await ready();
  const { connector, uploads, write } = fixture(t);
  write([second, first]);
  const oldTime = 1_700_000_000_000;
  await connector.syncThreadMetadata({ id: first, updatedAt: oldTime }, false);
  assert.equal(uploads[0].pinned, true);
  assert.equal(uploads[0].pinOrder, 1);
  assert.equal(uploads[0].updatedAt, oldTime);
  // Stale decorated input cannot override a more recent Desktop reorder.
  write([first, second]);
  await connector.syncThreadMetadata({ id: first, _fengzhuPinned: false, _fengzhuPinOrder: -1 }, false);
  assert.equal(uploads[1].pinOrder, 0);
  await connector.syncThreadMetadata({ id: first }, true);
  assert.equal(uploads[2].pinned, false);
});

test('presence supplies a complete current pin set, including explicit empty state', (t) => {
  const { connector, write } = fixture(t);
  connector.config.deviceId = 'computer';
  connector.desktopStatuses = new Map();
  assert.equal(connector.presencePayload().codexPins, null);
  write([second, first]);
  assert.deepEqual(connector.presencePayload().codexPins, { connectorId: 'computer', ids: [second, first] });
  write([]);
  assert.deepEqual(connector.presencePayload().codexPins, { connectorId: 'computer', ids: [] });
});

test('unpinning an old conversation reaches the newest page without changing its activity time', async (t) => {
  await ready();
  const { connector, uploads, write } = fixture(t);
  write([]);
  const oldTime = 1_700_000_000_000;
  const start = Date.now();
  await connector.syncPinnedMetadata(desktopPinState({ 'pinned-thread-ids': [] }), [first], [], [
    { id: first, updatedAt: oldTime, _fengzhuPinned: true, _fengzhuPinOrder: 0 },
  ]);
  assert.equal(uploads[0].pinned, false);
  assert.equal(uploads[0].pinOrder, -1);
  assert.equal(uploads[0].updatedAt, oldTime);
  assert.ok(uploads[0].indexUpdatedAt >= start);
});

test('a failed pin upload retries the removed IDs before acknowledging the new snapshot', async (t) => {
  const { connector, write } = fixture(t);
  write([second]);
  const previous = desktopPinState({ 'pinned-thread-ids': [first] });
  connector.desktopPins = previous;
  connector.desktopPinSignature = 'previous';
  connector.ws = { readyState: WebSocket.OPEN };
  connector.realtimeThreads = new Map();
  connector.desktopStatuses = new Map();
  connector.codex = { ready: true, request: async () => ({ data: [] }) };
  connector.syncNativeDesktopQueues = async () => {};
  connector.syncArchivedDesktopThreads = async () => {};
  connector.reconcileLiveStatusesFromRollouts = () => {};
  const calls = []; const events = [];
  connector.syncPinnedMetadata = async (pins, oldIds) => {
    calls.push({ ids: pins.ids, oldIds });
    if (calls.length === 1) throw new Error('temporary upload failure');
  };
  connector.emit = (kind) => events.push(kind);
  await assert.rejects(connector.syncDesktopActivity(), /temporary upload failure/);
  assert.equal(connector.desktopPinSignature, 'previous');
  assert.equal(connector.desktopPins, previous);
  await connector.syncDesktopActivity();
  assert.deepEqual(calls, [
    { ids: [second], oldIds: [first] },
    { ids: [second], oldIds: [first] },
  ]);
  assert.deepEqual(events, ['threads.updated']);
});

test('re-reads the desktop pin state only when the file changed', () => {
  const { readDesktopPinState } = require('../src/history');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-pin-state-'));
  const file = path.join(dir, '.codex-global-state.json');
  const id1 = '11111111-1111-1111-1111-111111111111'; const id2 = '22222222-2222-2222-2222-222222222222';
  fs.writeFileSync(file, JSON.stringify({ 'pinned-thread-ids': [id1] }));
  const realRead = fs.readFileSync; let reads = 0;
  fs.readFileSync = function (target, ...rest) { if (target === file) reads += 1; return realRead.call(this, target, ...rest); };
  try {
    assert.deepEqual(readDesktopPinState(file).ids, [id1]);
    assert.deepEqual(readDesktopPinState(file).ids, [id1]);
    assert.equal(reads, 1);
    fs.writeFileSync(file, JSON.stringify({ 'pinned-thread-ids': [id1, id2] }));
    assert.deepEqual(readDesktopPinState(file).ids, [id1, id2]);
    assert.equal(reads, 2);
    fs.rmSync(file);
    assert.equal(readDesktopPinState(file), null);
  } finally { fs.readFileSync = realRead; fs.rmSync(dir, { recursive: true, force: true }); }
});
