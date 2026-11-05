const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const { Event } = require('werift');
const { RTCPeerConnection } = require('werift');
const { ready, encryptJson, decryptJson } = require('../src/crypto');
const { encodeQr, decodeQr, answerMac, verifyAnswer, FramedChannel } = require('../src/direct-protocol');
const { DirectHistory } = require('../src/direct-history');
const { DirectHub } = require('../src/direct-hub');
const { decodeOffer } = require('../src/direct-compact');
const { signalPackets } = require('../src/direct-signaling');
const { BridgeApi } = require('../src/api');

const key = crypto.randomBytes(32).toString('base64');
const sdp = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AB:CD\r\n';
const id = crypto.randomUUID();
const answer = () => ({ v: 1, id, deviceId: crypto.randomUUID(), name: '测试手机', sdp });

test('QR compression roundtrips and binds the answer to the original offer', () => {
  const value = answer(); value.mac = answerMac(key, value);
  assert.deepEqual(decodeQr(encodeQr('answer', value), 'answer'), value);
  assert.equal(verifyAnswer(key, value), true);
  assert.equal(verifyAnswer(key, { ...value, sdp: `${sdp}a=candidate:tampered\r\n` }), false);
  assert.equal(verifyAnswer(crypto.randomBytes(32).toString('base64'), value), false);
  assert.throws(() => decodeQr(encodeQr('answer', value), 'offer'));
  assert.throws(() => decodeQr(encodeQr('answer', { ...value, sdp: `${sdp}a=candidate:1 1 UDP 1 127.0.0.1 123 typ relay\r\n` }), 'answer'));
});

test('data-channel fragmentation keeps large UTF-8 history intact and rejects reordered chunks', async () => {
  let result;
  const receiver = new FramedChannel({ onMessage: new Event() }, (raw) => { result = raw; });
  const packets = [];
  const sender = new FramedChannel({ readyState: 'open', bufferedAmount: 0, onMessage: new Event(), send: (raw) => packets.push(raw) }, () => {});
  const raw = JSON.stringify({ history: '中文🙂'.repeat(30000) });
  assert.equal(sender.send(raw), true);
  for (const packet of packets) { assert.ok(Buffer.byteLength(packet) < 16384); receiver.accept(packet); }
  assert.equal(result, raw);
  assert.throws(() => receiver.accept(packets[1]));
  assert.equal(sender.send('x'.repeat(9 * 1024 * 1024)), false);
});

test('direct history persists encrypted rows, changes transport keys, and matches cursor semantics', async (t) => {
  await ready(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-direct-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { accountKey: key, deviceId: 'pc' }; const history = new DirectHistory(directory, config);
  await history.put('/api/v2/history/threads', { id, updatedAt: 100, ...encryptJson(key, 'history.thread', id, id, { title: '私密任务' }) });
  await history.put(`/api/v2/history/threads/${id}/items`, { items: [1, 2, 3].map((order) => ({ id: `item${order}`, order, ...encryptJson(key, 'history.item', id, `item${order}`, { text: `消息${order}` }) })) });
  const newKey = crypto.randomBytes(32).toString('base64');
  const restored = new DirectHistory(directory, config);
  const rows = await restored.get(`/api/v2/history/threads/${id}/items?limit=1&after=1`, newKey);
  assert.equal(rows.hasMore, true); assert.equal(rows.items[0].itemOrder, 2);
  assert.equal(decryptJson(newKey, { ...rows.items[0], kind: 'history.item', threadId: id }).text, '消息2');
  assert.throws(() => decryptJson(key, { ...rows.items[0], kind: 'history.item', threadId: id }));
  assert.equal(fs.readFileSync(restored.indexFile, 'utf8').includes('私密任务'), false);
  await assert.rejects(restored.get('/api/v2/session/key-envelope', newKey));
});

test('heartbeats pass a queued fragmented history message without breaking reassembly', async () => {
  const packets = []; const received = [];
  const channel = { readyState: 'open', bufferedAmount: 300000, onMessage: new Event(), send: (raw) => packets.push(raw) };
  const sender = new FramedChannel(channel, () => {});
  const receiver = new FramedChannel({ onMessage: new Event() }, (raw) => received.push(raw));
  const history = JSON.stringify({ text: '历史'.repeat(30000) });
  sender.send(history); sender.send(JSON.stringify({ kind: 'connector.presence' }), { priority: true });
  channel.bufferedAmount = 0;
  const until = Date.now() + 1000;
  while (!packets.length && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(JSON.parse(packets[0]).kind, 'connector.presence');
  for (const packet of packets) receiver.accept(packet);
  assert.equal(received[1], history);
});

test('a failed local history mirror cannot stop existing cloud synchronization', async (t) => {
  const previous = global.fetch; t.after(() => { global.fetch = previous; });
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ saved: true }) }; };
  const api = new BridgeApi({ serverUrl: 'https://example.invalid' });
  api.token = async () => 'test'; api.localHistory = { put: async () => { throw new Error('disk unavailable'); } };
  assert.deepEqual(await api.request('/api/v2/history/threads', { method: 'PUT', body: {} }), { saved: true });
  assert.equal(calls, 1);
  api.config.directOnly = true;
  await assert.rejects(api.request('/api/v2/history/threads', { method: 'PUT', body: {} }), /disk unavailable/);
  assert.equal(calls, 1);
});

test('direct-only API never calls the business server, including token refresh', async () => {
  const api = new BridgeApi({ directOnly: true, protocolVersion: 2, serverUrl: 'https://must-not-connect.invalid' });
  let saved = false; api.localHistory = { put: () => { saved = true; return { saved: true }; } };
  assert.deepEqual(await api.request('/api/v2/history/threads', { method: 'PUT', body: {} }), { saved: true });
  assert.equal(saved, true);
  await assert.rejects(api.request('/api/v2/account'), /已关闭业务服务器/);
  await assert.rejects(api.refreshToken(), /login required/);
});

test('cancelling a QR while ICE gathers preserves the original account connection', async () => {
  let gathered;
  const pending = new Promise((resolve) => { gathered = resolve; });
  const channel = { readyState: 'connecting', onMessage: new Event(), stateChange: new Event() };
  let closed = 0;
  const peer = { connectionStateChange: new Event(), createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer', sdp }), setLocalDescription: async () => { await pending; peer.localDescription = { sdp }; },
    close: async () => { closed++; } };
  const connector = { config: { configFile: path.join(os.tmpdir(), 'unused-direct-config.json'), directOnly: false },
    setDirectMode: async () => { throw new Error('preparation must not switch transport'); } };
  const hub = new DirectHub(connector, { createPeer: () => peer });
  const creating = hub.offer(false);
  await new Promise((resolve) => setImmediate(resolve));
  await hub.end('idle'); gathered();
  await assert.rejects(creating, /配对已取消/);
  assert.equal(connector.config.directOnly, false);
  assert.equal(hub.status().status, 'idle');
  assert.equal(closed, 1);
});

test('a single phone scan returns an encrypted UDP answer, connects serverless WebRTC and transports history', { timeout: 25000 }, async (t) => {
  await ready(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-direct-peer-'));
  const frames = [];
  const connector = { config: { accountKey: key, deviceId: crypto.randomUUID(), deviceName: '测试电脑', configFile: path.join(directory, 'config.json') },
    setDirectMode: async (enabled) => { connector.config.directOnly = enabled; }, isConnected: () => hub.connected,
    writeStatus() {}, presencePayload: () => ({ deviceName: '测试电脑' }), republishActiveThreadStatuses() {},
    pushCodexUsage: async () => {}, syncHistory: async () => {}, onFrame: async (raw, options) => { frames.push({ frame: JSON.parse(raw), options }); }, log: () => {},
    directHistory: { get: () => ({ items: [{ text: '不经服务器的历史' }] }) } };
  const hub = new DirectHub(connector, { signaling: { addresses: ['127.0.0.1'] },
    createPeer: () => new RTCPeerConnection({ iceServers: [], iceAdditionalHostAddresses: ['127.0.0.1'] }) });
  const phone = new RTCPeerConnection({ iceServers: [], iceAdditionalHostAddresses: ['127.0.0.1'] });
  t.after(async () => { await phone.close(); await hub.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await hub.start(); const view = await hub.offer(false); const offer = decodeOffer(view.payload);
  assert.equal(offer.v, 2); assert.equal(view.singleScan, true);
  assert.equal(offer.stun, false); assert.notEqual(offer.key, key);
  // werift falls back to a public STUN server unless khLink switches it off.
  assert.doesNotMatch(offer.sdp, /typ srflx/);
  assert.notEqual(connector.config.directOnly, true, 'preparing a QR preserves the account connection');
  const deviceId = crypto.randomUUID(); let channel; const received = [];
  const connected = new Promise((resolve, reject) => {
    phone.onDataChannel.subscribe((value) => {
      channel = new FramedChannel(value, (raw) => { received.push(JSON.parse(raw)); resolve(); }, reject);
      value.stateChange.subscribe((state) => {
        if (state === 'open') {
          const helloId = crypto.randomUUID(); channel.send(JSON.stringify({ id: helloId, kind: 'direct.hello', ...encryptJson(offer.key, 'direct.hello', null, helloId, { id: offer.id, deviceId }) }));
        }
      });
    });
  });
  await phone.setRemoteDescription({ type: 'offer', sdp: offer.sdp }); await phone.setLocalDescription(await phone.createAnswer());
  const response = { v: 1, id: offer.id, deviceId, name: '测试手机', sdp: phone.localDescription.sdp };
  response.mac = answerMac(offer.key, response);
  await assert.rejects(hub.answer(encodeQr('answer', { ...response, mac: answerMac(key, response) })), /不匹配/);
  assert.notEqual(connector.config.directOnly, true, 'an invalid confirmation cannot switch transport');
  const socket = dgram.createSocket('udp4'); t.after(() => { try { socket.close(); } catch {} });
  const packetId = crypto.randomUUID();
  const encrypted = JSON.stringify({ id: offer.id, kind: 'direct.answer',
    ...encryptJson(offer.key, 'direct.answer', null, offer.id, { payload: encodeQr('answer', response) }) });
  const acknowledgement = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('automatic answer acknowledgement timed out')), 5000);
    socket.once('message', (bytes) => { clearTimeout(timer); resolve(decryptJson(offer.key, JSON.parse(bytes))); });
  });
  const target = offer.signaling.endpoints[0];
  for (const packet of signalPackets(offer.id, packetId, encrypted)) socket.send(packet, target.port, target.host);
  assert.deepEqual(await acknowledgement, { accepted: true, packet: packetId }); await connected;
  assert.equal(connector.config.directOnly, true);
  assert.equal(hub.connected, true);
  await assert.rejects(hub.answer(encodeQr('answer', response)), /已过期/);
  const commandId = crypto.randomUUID(); const command = JSON.stringify({ id: commandId, kind: 'command', sourceDeviceId: 'spoofed', ...encryptJson(offer.key, 'command', null, commandId, { action: 'thread.list', args: {} }) });
  channel.send(command); channel.send(command);
  const requestId = crypto.randomUUID(); channel.send(JSON.stringify({ id: requestId, kind: 'direct.request', ...encryptJson(offer.key, 'direct.request', null, requestId, { requestId, path: '/api/v2/history/threads' }) }));
  const until = Date.now() + 3000; while (!received.some((frame) => frame.kind === 'direct.response') && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  const result = received.find((frame) => frame.kind === 'direct.response');
  assert.equal(decryptJson(offer.key, result).result.items[0].text, '不经服务器的历史');
  const forwarded = frames.filter((row) => row.frame.kind === 'command'); assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].frame.sourceDeviceId, deviceId); assert.equal(forwarded[0].options.direct, true);
  // A QR past its deadline cannot authorize another phone.
  await hub.end('idle'); const expired = await hub.offer(false); const expiredOffer = decodeOffer(expired.payload);
  hub.session.expiresAt = Date.now() - 1;
  await assert.rejects(hub.answer(encodeQr('answer', { ...response, id: expiredOffer.id })), /已过期/);
});
