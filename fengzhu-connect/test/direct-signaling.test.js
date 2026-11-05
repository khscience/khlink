const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ready, encryptJson, decryptJson } = require('../src/crypto');
const { DirectSignaling, signalingAddresses, validSignalHost, signalPackets, stunAddress } = require('../src/direct-signaling');

function fixture(t, accept = async () => {}) {
  const session = { id: crypto.randomUUID(), key: crypto.randomBytes(32).toString('base64'), expiresAt: Date.now() + 300000 };
  const signaling = new DirectSignaling(session, accept, { addresses: ['127.0.0.1'] });
  const acks = [];
  signaling.socket.send = (raw, port, host, callback) => { acks.push({ frame: JSON.parse(raw), port, host }); callback(); };
  t.after(() => signaling.close());
  function packets(payload, key = session.key) {
    return signalPackets(session.id, crypto.randomUUID(), JSON.stringify({ id: session.id, kind: 'direct.answer',
      ...encryptJson(key, 'direct.answer', null, session.id, { payload }) }));
  }
  const remote = { address: '192.168.1.42', port: 45000 };
  return { session, signaling, acks, packets, remote };
}

test('automatic return endpoints exclude loopback, virtual interfaces, invalid numeric hosts and DNS names', () => {
  for (const host of ['192.168.1.20', '10.1.2.3', '203.0.113.7', '172.16.5.8']) assert.equal(validSignalHost(host), true);
  for (const host of ['localhost', 'example.com', '127.0.0.1', '169.254.1.2', '198.18.0.1', '198.19.1.2',
    '224.0.0.1', '0.0.0.0', '256.1.2.3', '01.2.3.4', '::1', '192.168.0.1/24']) assert.equal(validSignalHost(host), false, host);
  const row = (address) => [{ address, family: 'IPv4', internal: false }];
  assert.deepEqual(signalingAddresses({ Ethernet: row('192.168.1.10'), WiFi: row('192.168.1.10'),
    VMware: row('192.168.9.10'), 'vEthernet (WSL)': row('172.25.1.1'), Mihomo: row('198.18.0.1'),
    loopback: row('127.0.0.1'), Extra: [{ address: '10.1.1.1', family: 'IPv4', internal: true }] }), ['192.168.1.10']);
});

test('STUN return mapping requires the current transaction and a complete, usable IPv4 endpoint', () => {
  const transaction = crypto.randomBytes(12); const bytes = Buffer.alloc(32);
  bytes.writeUInt16BE(0x0101); bytes.writeUInt16BE(12, 2); bytes.writeUInt32BE(0x2112a442, 4); transaction.copy(bytes, 8);
  bytes.writeUInt16BE(0x0020, 20); bytes.writeUInt16BE(8, 22); bytes[25] = 1;
  bytes.writeUInt16BE(45000 ^ 0x2112, 26);
  [203, 0, 113, 7].forEach((octet, index) => { bytes[28 + index] = octet ^ bytes[4 + index]; });
  assert.deepEqual(stunAddress(bytes, transaction), { host: '203.0.113.7', port: 45000 });
  assert.equal(stunAddress(bytes, crypto.randomBytes(12)), null);
  assert.equal(stunAddress(bytes.subarray(0, 30), transaction), null);
  bytes.writeUInt16BE(80 ^ 0x2112, 26); assert.equal(stunAddress(bytes, transaction), null);
});

test('reordered, duplicated UDP fragments reassemble once and retransmission receives an encrypted acknowledgement', async (t) => {
  await ready(); let accepted = 0;
  const payload = 'khlink://direct/answer?data=' + 'x'.repeat(2200);
  const f = fixture(t, async (answer) => { assert.equal(answer, payload); accepted++; });
  const packets = f.packets(payload); assert.ok(packets.length > 1);
  for (const packet of [...packets].reverse()) await f.signaling.receive(packet, f.remote);
  for (const packet of packets) await f.signaling.receive(packet, f.remote);
  assert.equal(accepted, 1); assert.equal(f.acks.length, 2);
  assert.equal(decryptJson(f.session.key, f.acks[0].frame).accepted, true);
  assert.throws(() => decryptJson(crypto.randomBytes(32).toString('base64'), f.acks[0].frame));
  // A second answer cannot take over the already accepted one-use capability.
  for (const packet of f.packets('different-phone-answer')) await f.signaling.receive(packet, f.remote);
  assert.equal(accepted, 1); assert.equal(f.acks.length, 2);
});

test('forged or expired answers and cancelled listeners cannot switch connection mode', async (t) => {
  await ready(); let accepted = 0; const f = fixture(t, async () => { accepted++; });
  for (const packet of f.packets('forged', crypto.randomBytes(32).toString('base64')))
    await f.signaling.receive(packet, f.remote).catch(() => {});
  assert.equal(accepted, 0); assert.equal(f.acks.length, 0);
  f.session.expiresAt = Date.now() - 1;
  for (const packet of f.packets('expired')) await f.signaling.receive(packet, f.remote);
  f.session.expiresAt = Date.now() + 300000; f.signaling.close();
  for (const packet of f.packets('cancelled')) await f.signaling.receive(packet, f.remote);
  assert.equal(accepted, 0); assert.equal(f.acks.length, 0);
});

test('partial UDP requests have bounded memory and oversized or invalid fragments are rejected', async (t) => {
  await ready(); const f = fixture(t);
  assert.throws(() => signalPackets(f.session.id, crypto.randomUUID(), Buffer.alloc(16385)), /过大/);
  for (let index = 0; index < 50; index++) await f.signaling.receive(f.packets('x'.repeat(1000))[0], f.remote);
  assert.equal(f.signaling.assemblies.size, 16);
  const invalid = JSON.parse(f.packets('short')[0]); invalid.total = 1000;
  await f.signaling.receive(Buffer.from(JSON.stringify(invalid)), f.remote);
  assert.equal(f.signaling.assemblies.size, 16); assert.equal(f.acks.length, 0);
  f.signaling.close(); assert.equal(f.signaling.assemblies.size, 0);
});

test('a rejected authenticated answer returns its error and allows a corrected retry', async (t) => {
  await ready(); let count = 0;
  const f = fixture(t, async (payload) => { count++; if (payload === 'bad') throw new Error('手机握手不匹配'); });
  for (const packet of f.packets('bad')) await f.signaling.receive(packet, f.remote);
  assert.equal(decryptJson(f.session.key, f.acks[0].frame).error, '手机握手不匹配');
  for (const packet of f.packets('good')) await f.signaling.receive(packet, f.remote);
  assert.equal(decryptJson(f.session.key, f.acks[1].frame).accepted, true); assert.equal(count, 2);
});
