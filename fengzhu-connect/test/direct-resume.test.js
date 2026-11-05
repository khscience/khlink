const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const { RTCPeerConnection } = require('werift');
const { ready, encryptJson, decryptJson } = require('../src/crypto');
const { encodeQr, decodeQr, answerMac, FramedChannel } = require('../src/direct-protocol');
const { DirectHub } = require('../src/direct-hub');
const { DirectPairs } = require('../src/direct-resume');
const { decodeOffer } = require('../src/direct-compact');
const { signalPackets } = require('../src/direct-signaling');

const plain = { protect: (value) => value, unprotect: (value) => value };

function makeHub(directory, pcId, pairs) {
  const connector = { config: { deviceId: pcId, deviceName: '测试电脑', configFile: path.join(directory, 'config.json'), directOnly: false },
    setDirectMode: async (enabled) => { connector.config.directOnly = enabled; }, isConnected: () => false,
    writeStatus() {}, presencePayload: () => ({}), republishActiveThreadStatuses() {},
    pushCodexUsage: async () => {}, syncHistory: async () => {}, onFrame: async () => {}, log: () => {},
    directHistory: { get: () => ({ items: [] }) } };
  const hub = new DirectHub(connector, { pairs, resume: { port: 0, host: '127.0.0.1' }, signaling: { addresses: ['127.0.0.1'] },
    createPeer: () => new RTCPeerConnection({ iceServers: [], iceAdditionalHostAddresses: ['127.0.0.1'] }) });
  return { hub, connector };
}

// The phone side of one handshake: answer the offer, return it over UDP, say hello, wait for welcome.
async function phoneJoins(t, offer, key, deviceId) {
  const phone = new RTCPeerConnection({ iceServers: [], iceAdditionalHostAddresses: ['127.0.0.1'] });
  t.after(() => phone.close());
  const welcome = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no welcome')), 10000);
    phone.onDataChannel.subscribe((value) => {
      const channel = new FramedChannel(value, (raw) => { const frame = JSON.parse(raw); if (frame.kind !== 'direct.welcome') return; clearTimeout(timer); resolve(decryptJson(key, frame)); }, reject);
      value.stateChange.subscribe((state) => {
        if (state !== 'open') return;
        const helloId = crypto.randomUUID();
        channel.send(JSON.stringify({ id: helloId, kind: 'direct.hello', ...encryptJson(key, 'direct.hello', null, helloId, { id: offer.id, deviceId }) }));
      });
    });
  });
  await phone.setRemoteDescription({ type: 'offer', sdp: offer.sdp }); await phone.setLocalDescription(await phone.createAnswer());
  const response = { v: 1, id: offer.id, deviceId, name: '测试手机', sdp: phone.localDescription.sdp };
  response.mac = answerMac(key, response);
  const encrypted = JSON.stringify({ id: offer.id, kind: 'direct.answer',
    ...encryptJson(key, 'direct.answer', null, offer.id, { payload: encodeQr('answer', response) }) });
  const socket = dgram.createSocket('udp4'); t.after(() => { try { socket.close(); } catch {} });
  const target = offer.signaling.endpoints[0];
  for (const packet of signalPackets(offer.id, crypto.randomUUID(), encrypted)) socket.send(packet, target.port, target.host);
  return welcome;
}

async function askResume(port, key, deviceId, pcId, { wait = 3000 } = {}) {
  const socket = dgram.createSocket('udp4');
  try {
    const id = crypto.randomUUID();
    const raw = JSON.stringify({ v: 1, kind: 'direct.resume', id, deviceId, ...encryptJson(key, 'direct.resume', null, id, { pcId, deviceId, sentAt: Date.now() }) });
    const reply = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), wait);
      socket.on('message', (bytes) => { clearTimeout(timer); resolve(JSON.parse(bytes)); });
    });
    socket.send(raw, port, '127.0.0.1');
    const frame = await reply;
    return frame && { frame, value: decryptJson(key, { ...frame, threadId: null }) };
  } finally { socket.close(); }
}

test('a paired phone reconnects over the LAN after the connector restarts, without a new QR', { timeout: 40000 }, async (t) => {
  await ready(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-direct-resume-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pcId = crypto.randomUUID(); const deviceId = crypto.randomUUID();
  const pairs = new DirectPairs(path.join(directory, 'direct-pairs.json'), plain);

  const first = makeHub(directory, pcId, pairs);
  await first.hub.start();
  assert.equal(first.hub.resume.port, null, 'nothing listens before any phone is paired');
  const offer = decodeOffer((await first.hub.offer(false)).payload);
  const welcome = await phoneJoins(t, offer, offer.key, deviceId);
  assert.ok(Number.isInteger(welcome.resume?.port), 'the welcome tells the phone where to ask again');
  assert.equal(pairs.list().length, 1);
  await first.hub.close();

  // A new process (connector restart or reboot) with the same saved pairing.
  const second = makeHub(directory, pcId, pairs); second.connector.config.directOnly = true;
  t.after(() => second.hub.close());
  await second.hub.start();
  const port = second.hub.resume.port; assert.ok(port);

  // Strangers and wrong keys get silence, not an error that reveals the port.
  assert.equal(await askResume(port, offer.key, crypto.randomUUID(), pcId, { wait: 800 }), null);
  assert.equal(await askResume(port, crypto.randomBytes(32).toString('base64'), deviceId, pcId, { wait: 800 }), null);

  const answer = await askResume(port, offer.key, deviceId, pcId);
  assert.equal(answer.value.ok, true);
  const resumed = answer.value.offer;
  assert.equal(resumed.pcId, pcId); assert.equal(resumed.key, undefined, 'the key never travels again');
  assert.equal(second.hub.status().payload, undefined, 'a resume offer is not shown as a QR');
  const again = await phoneJoins(t, resumed, offer.key, deviceId);
  assert.equal(again.pcId, pcId);
  assert.equal(second.hub.connected, true);

  // Back to account mode: the pairing is forgotten and the port closes.
  second.connector.config.refreshToken = 'x';
  second.hub.connector.setDirectMode = async (enabled) => { second.connector.config.directOnly = enabled; };
  await second.hub.end('idle'); pairs.clear(); await second.hub.syncResume();
  assert.equal(second.hub.resume.port, null);
});

test('resume is refused while the computer is in account mode or another phone is connected', async (t) => {
  await ready(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-direct-resume-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pcId = crypto.randomUUID(); const deviceId = crypto.randomUUID(); const key = crypto.randomBytes(32).toString('base64');
  const pairs = new DirectPairs(path.join(directory, 'direct-pairs.json'), plain);
  pairs.remember({ deviceId, name: '测试手机', key });
  const { hub, connector } = makeHub(directory, pcId, pairs);
  t.after(() => hub.close());
  await hub.resume.start();
  const port = hub.resume.port;
  const account = await askResume(port, key, deviceId, pcId);
  assert.equal(account.value.ok, false); assert.match(account.value.error, /账户连接/);
  connector.config.directOnly = true;
  hub.session = { authenticated: true, deviceId: crypto.randomUUID(), lastReceived: Date.now(), channel: { readyState: 'open' } };
  const busy = await askResume(port, key, deviceId, pcId);
  assert.equal(busy.value.ok, false); assert.match(busy.value.error, /另一台手机/);
  hub.session = null;
  const wrongPc = await askResume(port, key, deviceId, crypto.randomUUID());
  assert.equal(wrongPc.value.ok, false);
});
