// A compact direct-connection QR (v3). The v2 QR carried the whole WebRTC
// offer SDP (about 1000 characters, a QR of 117 x 117 modules that phones
// struggled to read off a monitor). Only a few fields of that SDP matter, so
// v3 packs them into ~170 bytes, written in base32 so the QR uses its compact
// alphanumeric mode (about 57 x 57 modules). The phone rebuilds the SDP from a
// fixed template (`compactSdp`, mirrored in Android's DirectQr).
const PREFIX = 'KHLINK://D/';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base32(bytes) {
  let out = ''; let value = 0; let bits = 0;
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(text) {
  const out = []; let value = 0; let bits = 0;
  for (const char of text) {
    const index = ALPHABET.indexOf(char); if (index < 0) throw new Error('无效的直连二维码');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const uuidBytes = (value) => Buffer.from(value.replace(/-/g, ''), 'hex');
const uuidText = (bytes) => bytes.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const ipBytes = (ip) => Buffer.from(ip.split('.').map(Number));

function sdpFields(sdp) {
  const line = (name) => (sdp.match(new RegExp(`^a=${name}:(.+)$`, 'm')) || [])[1]?.trim();
  const candidates = [...sdp.matchAll(/^a=candidate:\S+ 1 udp \d+ (\d{1,3}(?:\.\d{1,3}){3}) (\d+) typ (host|srflx)/gim)]
    .map(([, ip, port, type]) => ({ ip, port: Number(port), type }));
  return { ufrag: line('ice-ufrag'), pwd: line('ice-pwd'), fingerprint: line('fingerprint')?.replace(/^sha-256 /i, ''), candidates };
}

/** Packs an offer; returns null when a field does not fit, so the caller keeps the v2 QR. */
function encodeCompactOffer(offer) {
  const { ufrag, pwd, fingerprint, candidates } = sdpFields(offer.sdp);
  const pcMatch = /^(.{36})(\.connector)?$/.exec(offer.pcId || '');
  if (!ufrag || !pwd || !fingerprint || !candidates.length || !UUID.test(offer.id) || !pcMatch || !UUID.test(pcMatch[1])) return null;
  const finger = Buffer.from(fingerprint.replace(/:/g, ''), 'hex');
  const key = Buffer.from(offer.key, 'base64');
  if (finger.length !== 32 || key.length !== 32 || ufrag.length > 64 || pwd.length > 128) return null;
  const endpoints = (offer.signaling?.endpoints || []).slice(0, 4);
  const name = Buffer.from(String(offer.pcName || ''), 'utf8').subarray(0, 24);
  const tunnel = typeof offer.tunnel === 'string' && /^[a-z0-9-]{1,80}$/.test(offer.tunnel) ? offer.tunnel : null;
  const flags = (offer.stun ? 1 : 0) | (pcMatch[2] ? 2 : 0) | (tunnel ? 4 : 0);
  const parts = [Buffer.from([3, flags]), uuidBytes(offer.id), uuidBytes(pcMatch[1]), key, finger];
  const expires = Buffer.alloc(4); expires.writeUInt32BE(Math.floor(offer.expiresAt / 1000)); parts.push(expires);
  parts.push(Buffer.from([ufrag.length]), Buffer.from(ufrag), Buffer.from([pwd.length]), Buffer.from(pwd));
  const kept = candidates.slice(0, 4);
  parts.push(Buffer.from([kept.length]));
  for (const row of kept) { const port = Buffer.alloc(2); port.writeUInt16BE(row.port); parts.push(Buffer.from([row.type === 'host' ? 0 : 1]), ipBytes(row.ip), port); }
  parts.push(Buffer.from([endpoints.length]));
  for (const row of endpoints) { const port = Buffer.alloc(2); port.writeUInt16BE(row.port); parts.push(ipBytes(row.host), port); }
  parts.push(Buffer.from([name.length]), name);
  // The cross-network tunnel: only the subdomain of xxx.trycloudflare.com.
  if (tunnel) parts.push(Buffer.from([tunnel.length]), Buffer.from(tunnel));
  return PREFIX + base32(Buffer.concat(parts));
}

function compactSdp({ ufrag, pwd, fingerprint, candidates }) {
  const lines = ['v=0', 'o=- 1 0 IN IP4 0.0.0.0', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic:WMS *',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`, `a=fingerprint:sha-256 ${fingerprint}`, 'a=setup:actpass', 'a=mid:0',
    'a=sctp-port:5000', 'a=max-message-size:16384'];
  candidates.forEach((row, index) => lines.push(row.type === 'host'
    ? `a=candidate:${index + 1} 1 udp ${2130706431 - index} ${row.ip} ${row.port} typ host`
    : `a=candidate:${index + 1} 1 udp ${1694498815 - index} ${row.ip} ${row.port} typ srflx raddr 0.0.0.0 rport 0`));
  lines.push('a=end-of-candidates');
  return `${lines.join('\r\n')}\r\n`;
}

/** The phone's view of a compact QR, in the same shape as a v2 offer. */
function decodeCompactOffer(payload) {
  if (typeof payload !== 'string' || !payload.startsWith(PREFIX) || payload.length > 1200) throw new Error('无效的直连二维码');
  const bytes = unbase32(payload.slice(PREFIX.length)); let at = 0;
  const take = (count) => { if (at + count > bytes.length) throw new Error('直连二维码不完整'); const value = bytes.subarray(at, at + count); at += count; return value; };
  const [version, flags] = take(2);
  if (version !== 3) throw new Error('请更新手机端后重新扫码');
  const id = uuidText(take(16)); const pcId = uuidText(take(16)) + (flags & 2 ? '.connector' : '');
  const key = take(32).toString('base64');
  const fingerprint = take(32).toString('hex').toUpperCase().match(/../g).join(':');
  const expiresAt = take(4).readUInt32BE() * 1000;
  const ufrag = take(take(1)[0]).toString(); const pwd = take(take(1)[0]).toString();
  const candidates = Array.from({ length: take(1)[0] }, () => { const type = take(1)[0] ? 'srflx' : 'host'; const ip = [...take(4)].join('.'); return { type, ip, port: take(2).readUInt16BE() }; });
  const endpoints = Array.from({ length: take(1)[0] }, () => ({ host: [...take(4)].join('.'), port: take(2).readUInt16BE() }));
  const pcName = take(take(1)[0]).toString('utf8');
  const tunnel = flags & 4 ? take(take(1)[0]).toString() : undefined;
  if (tunnel !== undefined && !/^[a-z0-9-]{1,80}$/.test(tunnel)) throw new Error('无效的跨网络通道地址');
  return { v: 2, id, expiresAt, pcId, pcName, key, stun: Boolean(flags & 1),
    signaling: { v: 1, transport: 'udp', endpoints }, sdp: compactSdp({ ufrag, pwd, fingerprint, candidates }),
    ...(tunnel ? { tunnel } : {}) };
}

/** Either QR generation: a compact v3 code or a v2 deflated offer. */
function decodeOffer(payload) {
  if (typeof payload === 'string' && payload.startsWith(PREFIX)) return decodeCompactOffer(payload);
  return require('./direct-protocol').decodeQr(payload, 'offer');
}

module.exports = { decodeOffer, encodeCompactOffer, decodeCompactOffer, compactSdp, base32, unbase32, COMPACT_PREFIX: PREFIX };
