const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { RTCPeerConnection } = require('werift');
const { ready, encryptJson, decryptJson } = require('../src/crypto');
const { DirectHub } = require('../src/direct-hub');
const { DirectPairs } = require('../src/direct-resume');
const { DirectTunnel, findCloudflared } = require('../src/direct-tunnel');
const { decodeOffer } = require('../src/direct-compact');

const plain = { protect: (value) => value, unprotect: (value) => value };

// The real cloudflared is not started in tests: the local WebSocket entrance
// is the part that matters, and the phone connects to it directly.
class LocalTunnel extends DirectTunnel {
  constructor(options) { super({ ...options, binary: 'test' }); }
  get running() { return Boolean(this.host); }
  async open() { await this.listen(); this.host = 'test-host'; return this.host; }
  url(target) { return `ws://127.0.0.1:${this.server.address().port}/khlink/${target}`; }
}

function makeHub(directory) {
  const connector = { config: { deviceId: `${crypto.randomUUID()}.connector`, deviceName: '测试电脑', configFile: path.join(directory, 'config.json'), directOnly: false },
    setDirectMode: async (enabled) => { connector.config.directOnly = enabled; }, isConnected: () => false,
    writeStatus() {}, presencePayload: () => ({}), republishActiveThreadStatuses() {},
    pushCodexUsage: async () => {}, syncHistory: async () => {}, onFrame: async () => {}, log: () => {},
    directHistory: { get: () => ({ items: [] }) } };
  const pairs = new DirectPairs(path.join(directory, 'direct-pairs.json'), plain);
  const hub = new DirectHub(connector, { pairs, resume: { port: 0, host: '127.0.0.1' }, signaling: { addresses: ['127.0.0.1'] },
    createPeer: () => new RTCPeerConnection({ iceServers: [], iceAdditionalHostAddresses: ['127.0.0.1'] }),
    tunnel: new LocalTunnel({ accept: (...args) => hub.acceptTunnel(...args) }) });
  return { hub, connector, pairs };
}

function open(url) {
  const socket = new WebSocket(url); const frames = [];
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
  socket.on('error', () => {});
  return { socket, frames, closed, opened: new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }) };
}

async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((resolve) => setTimeout(resolve, 20)); }
}

test('a phone on another network connects through the tunnel, and reconnects with the pairing key', { timeout: 30000 }, async (t) => {
  await ready(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-direct-tunnel-'));
  const { hub, connector, pairs } = makeHub(directory);
  t.after(async () => { await hub.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await hub.start();
  const view = await hub.offer(true);
  const offer = decodeOffer(view.payload);
  assert.equal(offer.tunnel, 'test-host', 'the QR names the tunnel');
  assert.equal(view.tunnel, true);
  // No STUN: the QR carries no public address, only the LAN and the tunnel name.
  assert.equal(offer.stun, false);
  assert.doesNotMatch(offer.sdp, /typ srflx/);
  assert.deepEqual(offer.signaling.endpoints.map((row) => row.host), ['127.0.0.1']);

  // Someone guessing an id or holding no key is dropped.
  const stranger = open(hub.tunnel.url(crypto.randomUUID())); await stranger.opened;
  const strangerId = crypto.randomUUID();
  stranger.socket.send(JSON.stringify({ id: strangerId, kind: 'direct.hello', ...encryptJson(crypto.randomBytes(32).toString('base64'), 'direct.hello', null, strangerId, { id: offer.id, deviceId: crypto.randomUUID() }) }));
  await stranger.closed;
  const wrongKey = open(hub.tunnel.url(offer.id)); await wrongKey.opened;
  wrongKey.socket.send(JSON.stringify({ id: strangerId, kind: 'direct.hello', ...encryptJson(crypto.randomBytes(32).toString('base64'), 'direct.hello', null, strangerId, { id: offer.id, deviceId: crypto.randomUUID() }) }));
  await wrongKey.closed;
  assert.equal(hub.connected, false);

  const deviceId = crypto.randomUUID();
  const phone = open(hub.tunnel.url(offer.id)); await phone.opened;
  const helloId = crypto.randomUUID();
  phone.socket.send(JSON.stringify({ id: helloId, kind: 'direct.hello', ...encryptJson(offer.key, 'direct.hello', null, helloId, { id: offer.id, deviceId, name: '流量手机' }) }));
  await until(() => phone.frames.length > 0);
  assert.equal(phone.frames[0].kind, 'direct.welcome', 'the welcome comes first');
  const welcome = decryptJson(offer.key, phone.frames[0]);
  assert.equal(welcome.tunnel, 'test-host');
  assert.equal(hub.connected, true); assert.equal(hub.status().transport, 'tunnel');
  assert.equal(connector.config.directOnly, true);
  assert.equal(pairs.list()[0].name, '流量手机');

  // The app is killed: the phone comes back on the same tunnel without a scan.
  phone.socket.close(); await phone.closed;
  await until(() => !hub.connected);
  const again = open(hub.tunnel.url('resume')); await again.opened;
  const resumeId = crypto.randomUUID();
  again.socket.send(JSON.stringify({ v: 1, kind: 'direct.resume', id: resumeId, deviceId,
    ...encryptJson(offer.key, 'direct.resume', null, resumeId, { pcId: connector.config.deviceId, deviceId, sentAt: Date.now() }) }));
  await until(() => again.frames.length > 0);
  assert.equal(again.frames[0].kind, 'direct.welcome');
  assert.equal(hub.connected, true);
  // A replayed resume request is refused.
  const replay = open(hub.tunnel.url('resume')); await replay.opened;
  replay.socket.send(JSON.stringify({ v: 1, kind: 'direct.resume', id: resumeId, deviceId,
    ...encryptJson(offer.key, 'direct.resume', null, resumeId, { pcId: connector.config.deviceId, deviceId, sentAt: Date.now() }) }));
  await replay.closed;
  again.socket.close(); await again.closed;
});

test('a same-network QR does not open the tunnel, and the connector finds a bundled cloudflared', async (t) => {
  await ready(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-direct-tunnel-'));
  const { hub } = makeHub(directory);
  t.after(async () => { await hub.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await hub.start();
  const offer = decodeOffer((await hub.offer(false)).payload);
  assert.equal(offer.tunnel, undefined);
  assert.equal(hub.tunnel.running, false);
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-cloudflared-'));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  const binary = path.join(tools, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  fs.writeFileSync(binary, '');
  assert.equal(findCloudflared({ KHLINK_CLOUDFLARED: binary }), binary);
  assert.equal(findCloudflared({ PATH: tools }), binary);
  assert.equal(findCloudflared({ PATH: '' }) === null || typeof findCloudflared({ PATH: '' }) === 'string', true);
});

test('a restarted connector takes over the running tunnel and its address', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-direct-tunnel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'direct-tunnel.json');
  const { EventEmitter } = require('node:events');
  const spawned = [];
  // Stands in for cloudflared: writes its address to the log file it was given.
  const spawnProcess = (binary, args, options) => {
    const child = Object.assign(new EventEmitter(), { pid: process.pid, exitCode: null, signalCode: null, unref() {}, kill() {} });
    spawned.push({ args, options });
    fs.writeSync(options.stdio[1], 'INF |  https://bright-river-1234.trycloudflare.com  |\nINF Registered tunnel connection\n');
    return child;
  };
  const killed = [];
  class Tunnel extends DirectTunnel { kill(pid) { killed.push(pid); } }
  const first = new Tunnel({ binary: 'cloudflared', spawnProcess, stateFile, checkProcess: async () => true });
  assert.equal(await first.start(5000), 'bright-river-1234');
  assert.equal(spawned[0].options.detached, true, 'cloudflared runs on its own');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.host, 'bright-river-1234');
  first.detach();
  assert.equal(first.running, false);
  assert.ok(fs.existsSync(stateFile), 'the tunnel is left for the next connector');

  const second = new Tunnel({ binary: 'cloudflared', spawnProcess, stateFile, checkProcess: async () => true });
  assert.equal(await second.start(5000), 'bright-river-1234', 'same address, no new cloudflared');
  assert.equal(spawned.length, 1);
  assert.equal(second.server.address().port, saved.port);
  assert.equal(second.running, true);
  second.stop();
  assert.deepEqual(killed, [process.pid]);
  assert.equal(fs.existsSync(stateFile), false);

  // After a computer restart the recorded process is gone: nothing to take over.
  fs.writeFileSync(stateFile, JSON.stringify({ pid: 999999, port: 1, host: 'old-host' }));
  const third = new Tunnel({ binary: 'cloudflared', spawnProcess, stateFile, checkProcess: async () => false });
  assert.equal(await third.reattach(), null);
  assert.equal(fs.existsSync(stateFile), false);
});
