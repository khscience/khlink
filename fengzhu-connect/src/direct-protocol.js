const crypto = require('node:crypto');
const zlib = require('node:zlib');

// werift asks stun.l.google.com for a public address whenever no STUN server
// is configured (`stunServer ?? google`), so "iceServers: []" still sent this
// computer's real public address to Google, outside any proxy, and waited up
// to 5 s per unroutable adapter. khLink never wants server-reflexive
// candidates: same-network links use LAN addresses, others use the tunnel.
const werift = require('werift');
if (werift.Connection?.prototype?.getCandidatePromises && !werift.Connection.prototype.khlinkNoStun) {
  const gather = werift.Connection.prototype.getCandidatePromises;
  werift.Connection.prototype.getCandidatePromises = function (...args) { this.stunServer = undefined; return gather.apply(this, args); };
  werift.Connection.prototype.khlinkNoStun = true;
}

const MAX_MESSAGE = 8 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024;
const STUN_URL = 'stun:stun.l.google.com:19302';

function encodeQr(role, value) {
  const data = zlib.deflateSync(Buffer.from(JSON.stringify(value))).toString('base64url');
  const result = `khlink://direct/${role}?data=${data}`;
  if (Buffer.byteLength(result) > 2800) throw new Error('连接信息过长，请关闭多余网卡后重新生成二维码');
  return result;
}

function decodeQr(payload, role) {
  if (typeof payload !== 'string' || payload.length > 3000) throw new Error('无效的直连二维码');
  const url = new URL(payload);
  if (url.protocol !== 'khlink:' || url.hostname !== 'direct' || url.pathname !== `/${role}`) throw new Error('二维码类型不匹配');
  const packed = url.searchParams.get('data');
  if (!packed || !/^[A-Za-z0-9_-]+$/.test(packed)) throw new Error('二维码缺少连接信息');
  const value = JSON.parse(zlib.inflateSync(Buffer.from(packed, 'base64url'), { maxOutputLength: 24 * 1024 }).toString());
  if (!(value.v === 1 || role === 'offer' && value.v === 2) || !/^[a-f0-9-]{36}$/i.test(value.id || '') || typeof value.sdp !== 'string' || value.sdp.length > 18000) throw new Error('不支持的直连信息');
  if (!value.sdp.includes('m=application ') || !value.sdp.includes('a=fingerprint:sha-256 ') || / typ relay(?: |\r|\n)/.test(value.sdp)) throw new Error('仅支持无中继的数据直连');
  return value;
}

function answerMac(key, answer) {
  return crypto.createHmac('sha256', Buffer.from(key, 'base64'))
    .update(`${answer.id}\n${answer.deviceId}\n${answer.name}\n${answer.sdp}`).digest('base64');
}

function verifyAnswer(key, answer) {
  if (!/^[a-f0-9-]{36}$/i.test(answer.deviceId || '') || typeof answer.name !== 'string' || answer.name.length > 120) return false;
  const actual = Buffer.from(answer.mac || '', 'base64');
  const expected = Buffer.from(answerMac(key, answer), 'base64');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// A bounded message layer keeps history/file frames below SCTP's message limit.
class FramedChannel {
  constructor(channel, receive, fail = () => {}) {
    this.channel = channel; this.receive = receive; this.fail = fail;
    this.pending = new Map(); this.queue = []; this.queueBytes = 0; this.draining = false;
    channel.onMessage.subscribe((raw) => { try { this.accept(raw.toString()); } catch (error) { fail(error); } });
  }
  accept(raw) {
    if (Buffer.byteLength(raw) > 16 * 1024) throw new Error('直连数据帧过大');
    const packet = JSON.parse(raw);
    if (packet.type !== 'chunk') { this.receive(raw); return; }
    const { id, index, total, data } = packet;
    if (!/^[a-f0-9-]{36}$/i.test(id || '') || !Number.isInteger(total) || total < 2 || total > 1024 || !Number.isInteger(index) || index < 0 || index >= total || typeof data !== 'string' || data.length > 11000) throw new Error('无效的直连分片');
    for (const [key, value] of this.pending) if (Date.now() - value.at > 30000) this.pending.delete(key);
    let entry = this.pending.get(id);
    if (!entry) {
      if (this.pending.size >= 4 || index !== 0) throw new Error('直连分片顺序错误');
      entry = { at: Date.now(), total, parts: [], bytes: 0 }; this.pending.set(id, entry);
    }
    if (entry.total !== total || index !== entry.parts.length) throw new Error('直连分片顺序错误');
    const part = Buffer.from(data, 'base64'); entry.bytes += part.length;
    if (part.length > CHUNK_SIZE || entry.bytes > MAX_MESSAGE) throw new Error('直连消息过大');
    entry.parts.push(part);
    if (entry.parts.length === total) { this.pending.delete(id); this.receive(Buffer.concat(entry.parts).toString()); }
  }
  send(raw, { priority = false } = {}) {
    if (this.channel.readyState !== 'open') return false;
    const bytes = Buffer.from(raw);
    if (bytes.length > MAX_MESSAGE || this.queueBytes + bytes.length > MAX_MESSAGE * 2) return false;
    if (bytes.length <= 12000) { if (priority) this.queue.unshift(raw); else this.queue.push(raw); }
    else {
      const id = crypto.randomUUID(); const total = Math.ceil(bytes.length / CHUNK_SIZE);
      for (let index = 0; index < total; index++) this.queue.push(JSON.stringify({ type: 'chunk', id, index, total, data: bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE).toString('base64') }));
    }
    this.queueBytes = this.queue.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    this.drain().catch(this.fail); return true;
  }
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && this.channel.readyState === 'open') {
        if (this.channel.bufferedAmount > 256 * 1024) { await new Promise((resolve) => setTimeout(resolve, 20)); continue; }
        const raw = this.queue.shift(); this.queueBytes -= Buffer.byteLength(raw); this.channel.send(raw);
      }
    } finally { this.draining = false; }
  }
}

// Only real network adapters go into the QR: virtual adapters (VMware,
// Hyper-V, a proxy's TUN) and their public mappings made the code so dense
// that phones could not read it. A server-reflexive candidate stays when it
// was mapped from a kept host address.
function trimOfferSdp(sdp, allowed) {
  const keep = new Set(allowed);
  const lines = sdp.split(/\r?\n/);
  const seen = new Set();
  const out = lines.filter((line) => {
    if (!line.startsWith('a=candidate:')) return true;
    const parts = line.split(' ');
    const address = parts[4]; const port = parts[5]; const type = parts[parts.indexOf('typ') + 1];
    const related = parts[parts.indexOf('raddr') + 1];
    const ok = type === 'host' ? keep.has(address) : type === 'srflx' && parts.includes('raddr') && keep.has(related);
    const key = `${type} ${address} ${port}`;
    if (!ok || seen.has(key)) return false;
    seen.add(key); return true;
  });
  // Never trim down to nothing: an offer without candidates cannot connect.
  return out.some((line) => line.startsWith('a=candidate:')) ? out.join('\r\n') : sdp;
}

module.exports = { STUN_URL, trimOfferSdp, encodeQr, decodeQr, answerMac, verifyAnswer, FramedChannel, MAX_MESSAGE };
