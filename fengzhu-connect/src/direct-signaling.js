const dgram = require('node:dgram');
const dns = require('node:dns').promises;
const os = require('node:os');
const crypto = require('node:crypto');
const { encryptJson, decryptJson } = require('./crypto');

const MAX_SIGNAL = 16 * 1024;
const SIGNAL_CHUNK = 800;
const STUN_COOKIE = 0x2112a442;

function signalingAddresses(interfaces = os.networkInterfaces()) {
  return [...new Set(Object.entries(interfaces)
    .filter(([name]) => !/loopback|vethernet|vmware|virtualbox|docker|mihomo|\bwsl\b/i.test(name))
    .flatMap(([, rows]) => rows || []).filter((row) => !row.internal && row.family === 'IPv4')
    .map((row) => row.address).filter(validSignalHost))].slice(0, 8);
}

// The address the system routes outbound traffic from. Adapter names are only
// a guess (a Hyper-V external switch puts the real LAN address on a
// "vEthernet" adapter), so the routed address is always kept when it is a
// usable one. With a proxy's TUN as the default route it is a 198.18.x.x
// address, which validSignalHost rejects, and the name-based list is used.
// A connected UDP socket sends nothing; it only asks the routing table.
async function routedAddress(target = '223.5.5.5') {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.connect(53, target, resolve); });
    const { address } = socket.address();
    return validSignalHost(address) ? address : null;
  } catch { return null; } finally { try { socket.close(); } catch {} }
}

/** Addresses a phone can reach this computer on: the routed one first, then real adapters. */
async function usableAddresses(interfaces) {
  const routed = await routedAddress();
  return [...new Set([routed, ...signalingAddresses(interfaces)].filter(Boolean))].slice(0, 8);
}

function validSignalHost(host) {
  if (typeof host !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const octets = host.split('.').map(Number);
  return octets.every((value) => value <= 255) && octets.join('.') === host && octets[0] > 0 && octets[0] < 224 && octets[0] !== 127
    && !(octets[0] === 169 && octets[1] === 254) && !(octets[0] === 198 && [18, 19].includes(octets[1]));
}

function signalPackets(id, packet, raw) {
  const bytes = Buffer.from(raw);
  if (!bytes.length || bytes.length > MAX_SIGNAL) throw new Error('握手信息过大');
  const total = Math.ceil(bytes.length / SIGNAL_CHUNK);
  return Array.from({ length: total }, (_, index) => Buffer.from(JSON.stringify({ v: 1, id, packet, index, total,
    data: bytes.subarray(index * SIGNAL_CHUNK, (index + 1) * SIGNAL_CHUNK).toString('base64') })));
}

function stunAddress(bytes, transaction) {
  if (bytes.length < 20 || bytes.readUInt16BE(0) !== 0x0101 || bytes.readUInt32BE(4) !== STUN_COOKIE
    || !bytes.subarray(8, 20).equals(transaction)) return null;
  const end = 20 + bytes.readUInt16BE(2);
  if (end > bytes.length) return null;
  for (let offset = 20; offset + 4 <= end;) {
    const type = bytes.readUInt16BE(offset); const length = bytes.readUInt16BE(offset + 2); offset += 4;
    if (offset + length > end) return null;
    if (type === 0x0020 && length >= 8 && bytes[offset + 1] === 1) {
      const port = bytes.readUInt16BE(offset + 2) ^ (STUN_COOKIE >>> 16);
      const mask = Buffer.alloc(4); mask.writeUInt32BE(STUN_COOKIE);
      const host = Array.from(bytes.subarray(offset + 4, offset + 8), (value, index) => value ^ mask[index]).join('.');
      return validSignalHost(host) && port >= 1024 ? { host, port } : null;
    }
    offset += (length + 3) & ~3;
  }
  return null;
}

// A short-lived, encrypted UDP return path. It exposes no local control APIs,
// account credentials, Agent commands or history. A scanned QR is the capability.
class DirectSignaling {
  constructor(session, accept, options = {}) {
    this.session = session; this.accept = accept; this.options = options;
    this.assemblies = new Map(); this.closed = false;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (bytes, remote) => {
      if (this.stun && remote.address === this.stun.host && remote.port === 19302) {
        const value = stunAddress(bytes, this.stun.transaction);
        if (value) this.stun.resolve(value);
        return;
      }
      this.receive(bytes, remote).catch(() => {});
    });
    this.socket.on('error', () => {});
  }
  async start(stun) {
    const addresses = this.options.addresses || await usableAddresses();
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(0, '0.0.0.0', () => { this.socket.off('error', reject); resolve(); });
    });
    const port = this.socket.address().port;
    const endpoints = addresses.map((host) => ({ host, port }));
    if (stun && !this.closed) {
      const mapped = await this.discoverAddress();
      if (mapped && !endpoints.some((entry) => entry.host === mapped.host && entry.port === mapped.port)) endpoints.push(mapped);
    }
    if (this.closed) throw new Error('配对已取消');
    if (!endpoints.length) throw new Error('未找到可用网卡，请连接 Wi-Fi／热点后重试');
    return { v: 1, transport: 'udp', endpoints: endpoints.slice(0, 8) };
  }
  async discoverAddress() {
    let timer; let active = true;
    try {
      return await Promise.race([
        (async () => {
          const { address } = await dns.lookup('stun.l.google.com', { family: 4 });
          if (this.closed || !active) return null;
          const transaction = crypto.randomBytes(12);
          const request = Buffer.alloc(20); request.writeUInt16BE(1); request.writeUInt32BE(STUN_COOKIE, 4); transaction.copy(request, 8);
          return await new Promise((resolve) => {
            this.stun = { host: address, transaction, resolve };
            this.socket.send(request, 19302, address, (error) => { if (error) resolve(null); });
          });
        })(),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2500); }),
      ]);
    } catch { return null; }
    finally { active = false; clearTimeout(timer); this.stun?.resolve(null); this.stun = null; }
  }
  async receive(bytes, remote) {
    if (this.closed || Date.now() > this.session.expiresAt || bytes.length > 1400) return;
    const now = Date.now();
    if (!this.windowAt || now - this.windowAt > 1000) { this.windowAt = now; this.windowCount = 0; }
    if (++this.windowCount > 128) return;
    const value = JSON.parse(bytes.toString());
    if (value.v !== 1 || value.id !== this.session.id || !/^[a-f0-9-]{36}$/i.test(value.packet || '')
      || !Number.isInteger(value.index) || !Number.isInteger(value.total) || value.total < 1 || value.total > 21
      || value.index < 0 || value.index >= value.total || typeof value.data !== 'string' || value.data.length > 1100
      || !/^[a-z0-9+/]+={0,2}$/i.test(value.data)) return;
    for (const [key, row] of this.assemblies) if (now - row.at > 5000) this.assemblies.delete(key);
    const key = `${remote.address}:${remote.port}:${value.packet}`;
    let row = this.assemblies.get(key);
    if (!row) {
      if (this.assemblies.size >= 16) return;
      row = { total: value.total, at: now, size: 0, parts: new Map() }; this.assemblies.set(key, row);
    }
    if (row.total !== value.total || row.parts.has(value.index)) return;
    const part = Buffer.from(value.data, 'base64'); row.size += part.length;
    if (row.size > MAX_SIGNAL) { this.assemblies.delete(key); return; }
    row.parts.set(value.index, part);
    if (row.parts.size !== row.total) return;
    this.assemblies.delete(key);
    const raw = Buffer.concat(Array.from({ length: row.total }, (_, index) => row.parts.get(index)));
    const frame = JSON.parse(raw.toString());
    if (frame.id !== this.session.id || frame.kind !== 'direct.answer' || frame.threadId) return;
    const payload = decryptJson(this.session.key, frame).payload;
    if (typeof payload !== 'string') return;
    const digest = crypto.createHash('sha256').update(raw).digest('hex');
    // UDP acknowledgement can be lost. Retry the identical encrypted request
    // without applying an answer twice or accepting another phone's answer.
    if (this.pending && this.pending.digest !== digest) return;
    if (!this.pending) this.pending = { digest, promise: Promise.resolve().then(() => this.accept(payload)) };
    let result;
    try { await this.pending.promise; result = { accepted: true, packet: value.packet }; }
    catch (error) { this.pending = null; result = { accepted: false, packet: value.packet, error: String(error.message).slice(0, 180) }; }
    if (this.closed) return;
    const ack = Buffer.from(JSON.stringify({ v: 1, id: this.session.id, kind: 'direct.ack',
      ...encryptJson(this.session.key, 'direct.ack', null, this.session.id, result) }));
    this.socket.send(ack, remote.port, remote.address, () => {});
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.assemblies.clear(); this.stun?.resolve(null);
    try { this.socket.close(); } catch {}
  }
}

module.exports = { DirectSignaling, signalingAddresses, usableAddresses, routedAddress, validSignalHost, signalPackets, stunAddress };
