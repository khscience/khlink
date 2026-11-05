const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { encodeCompactOffer, decodeCompactOffer, base32, unbase32 } = require('../src/direct-compact');

const sdp = ['v=0', 'o=- 15180320 0 IN IP4 0.0.0.0', 's=-', 't=0 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=ice-ufrag:b49f', 'a=ice-pwd:496f31cdee49a85a45240b',
  'a=fingerprint:sha-256 CA:37:BB:E2:CD:7F:DA:3D:1D:FD:A0:1C:62:62:E9:93:3D:E3:EA:B0:B9:EF:B3:A0:C1:D0:17:D3:31:09:71:5E',
  'a=candidate:a1 1 udp 2130706431 192.168.8.178 61008 typ host',
  'a=candidate:a2 1 udp 1694498815 61.13.236.178 35961 typ srflx raddr 192.168.8.178 rport 61008', ''].join('\r\n');

test('base32 roundtrips arbitrary bytes', () => {
  for (const size of [0, 1, 5, 31, 170]) { const bytes = crypto.randomBytes(size); assert.deepEqual(unbase32(base32(bytes)), bytes); }
});

test('the compact QR keeps every field the phone needs and fits QR alphanumeric mode', () => {
  const offer = { v: 2, id: crypto.randomUUID(), expiresAt: Math.floor(Date.now() / 1000) * 1000 + 300_000,
    pcId: `${crypto.randomUUID()}.connector`, pcName: 'DESKTOP-L97PUH4 后台连接器', key: crypto.randomBytes(32).toString('base64'), stun: true,
    signaling: { v: 1, transport: 'udp', endpoints: [{ host: '192.168.8.178', port: 61048 }, { host: '61.13.236.178', port: 60201 }] }, sdp };
  const payload = encodeCompactOffer(offer);
  assert.match(payload, /^[0-9A-Z $%*+\-./:]+$/, 'only QR alphanumeric characters');
  assert.ok(payload.length < 320, `compact payload is ${payload.length} characters`);
  const back = decodeCompactOffer(payload);
  for (const name of ['id', 'expiresAt', 'pcId', 'key', 'stun']) assert.equal(back[name], offer[name], name);
  assert.deepEqual(back.signaling, offer.signaling);
  assert.ok(Buffer.byteLength(offer.pcName) > 24 ? offer.pcName.startsWith(back.pcName.replace(/�$/, '')) : back.pcName === offer.pcName);
  assert.match(back.sdp, /a=ice-ufrag:b49f\r\n/); assert.match(back.sdp, /a=ice-pwd:496f31cdee49a85a45240b\r\n/);
  assert.match(back.sdp, /a=fingerprint:sha-256 CA:37:BB:E2:.*:71:5E\r\n/);
  assert.match(back.sdp, / 192\.168\.8\.178 61008 typ host/); assert.match(back.sdp, / 61\.13\.236\.178 35961 typ srflx/);
  assert.doesNotMatch(back.sdp, /typ relay/);
});

test('an offer that does not fit the compact format falls back to the v2 QR', () => {
  assert.equal(encodeCompactOffer({ id: crypto.randomUUID(), pcId: 'not-a-uuid', key: crypto.randomBytes(32).toString('base64'), sdp, expiresAt: Date.now() }), null);
  assert.throws(() => decodeCompactOffer('KHLINK://D/AAAA'));
});

test('the QR keeps real adapters and their public mappings, drops virtual ones, and never empties the offer', () => {
  const { trimOfferSdp } = require('../src/direct-protocol');
  const offer = ['v=0', 'a=ice-ufrag:x',
    'a=candidate:1 1 udp 2130706431 192.168.8.178 50001 typ host',
    'a=candidate:2 1 udp 2130706430 198.18.0.1 50002 typ host',
    'a=candidate:3 1 udp 2130706429 192.168.146.1 50003 typ host',
    'a=candidate:4 1 udp 1694498815 61.13.236.178 40001 typ srflx raddr 192.168.8.178 rport 50001',
    'a=candidate:5 1 udp 1694498814 61.13.236.178 40002 typ srflx raddr 198.18.0.1 rport 50002', ''].join('\r\n');
  const trimmed = trimOfferSdp(offer, ['192.168.8.178']);
  assert.match(trimmed, /192\.168\.8\.178 50001 typ host/); assert.match(trimmed, /40001 typ srflx/);
  assert.doesNotMatch(trimmed, /198\.18\.0\.1|192\.168\.146\.1|40002/);
  // An adapter list that misses every candidate keeps the whole offer instead of breaking it.
  assert.equal(trimOfferSdp(offer, ['10.9.9.9']), offer);
});
