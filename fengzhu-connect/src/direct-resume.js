const fs = require('node:fs');
const dgram = require('node:dgram');
const { protect, unprotect } = require('./config');
const { encryptJson, decryptJson } = require('./crypto');

// A phone that once scanned this computer's QR keeps the pairing key. When the
// app is restarted, the connector restarts or the computer reboots, the phone
// asks again on the LAN with a request sealed with that key, and the connector
// answers with a fresh WebRTC offer. No server is involved, so this only works
// where the phone can reach the computer directly (same Wi-Fi or hotspot).
const RESUME_PORT = 47820;
const MAX_PAIRS = 4;
const MAX_REQUEST = 1400;
const REQUEST_AGE_MS = 120_000;

class DirectPairs {
  constructor(file, options = {}) {
    this.file = file;
    this.protect = options.protect || protect;
    this.unprotect = options.unprotect || unprotect;
  }
  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { port: Number.isInteger(value.port) ? value.port : null, pairs: Array.isArray(value.pairs) ? value.pairs : [] };
    } catch { return { port: null, pairs: [] }; }
  }
  write(value) {
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, this.file);
  }
  list() { return this.read().pairs.map(({ deviceId, name, pairedAt, lastSeenAt }) => ({ deviceId, name, pairedAt, lastSeenAt })); }
  get(deviceId) {
    const row = this.read().pairs.find((entry) => entry.deviceId === deviceId);
    if (!row) return null;
    try { return { deviceId: row.deviceId, name: row.name, key: this.unprotect(row.key) }; } catch { return null; }
  }
  remember({ deviceId, name, key }) {
    const value = this.read(); const now = Date.now();
    const previous = value.pairs.find((entry) => entry.deviceId === deviceId);
    const row = { deviceId, name: String(name || '手机').slice(0, 120), key: this.protect(key), pairedAt: previous?.pairedAt || now, lastSeenAt: now };
    value.pairs = [row, ...value.pairs.filter((entry) => entry.deviceId !== deviceId)].slice(0, MAX_PAIRS);
    this.write(value);
  }
  setPort(port) { const value = this.read(); if (value.port !== port) { value.port = port; this.write(value); } }
  port() { return this.read().port; }
  clear() { try { fs.unlinkSync(this.file); } catch {} }
}

class DirectResume {
  constructor(hub, options = {}) {
    this.hub = hub; this.options = options; this.socket = null; this.seen = new Map();
  }
  get port() { return this.socket ? this.socket.address().port : null; }
  async start() {
    if (this.socket) return this.port;
    const preferred = [this.options.port ?? RESUME_PORT, this.hub.pairs.port(), 0].filter((value, index, rows) => Number.isInteger(value) && rows.indexOf(value) === index);
    for (const port of preferred) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      try {
        await new Promise((resolve, reject) => {
          socket.once('error', reject);
          socket.bind(port, this.options.host || '0.0.0.0', () => { socket.off('error', reject); resolve(); });
        });
      } catch { try { socket.close(); } catch {} continue; }
      socket.on('error', () => {});
      socket.on('message', (bytes, remote) => this.receive(bytes, remote).catch((error) => this.hub.connector.log?.(error)));
      this.socket = socket;
      this.hub.pairs.setPort(this.port);
      return this.port;
    }
    throw new Error('无法打开直连重连端口');
  }
  stop() {
    const socket = this.socket; this.socket = null; this.seen.clear();
    try { socket?.close(); } catch {}
  }
  async receive(bytes, remote) {
    if (bytes.length > MAX_REQUEST) return;
    const now = Date.now();
    if (!this.windowAt || now - this.windowAt > 1000) { this.windowAt = now; this.windowCount = 0; }
    if (++this.windowCount > 32) return;
    let frame;
    try { frame = JSON.parse(bytes.toString()); } catch { return; }
    if (frame?.v !== 1 || frame.kind !== 'direct.resume' || !/^[a-f0-9-]{36}$/i.test(frame.id || '') || !/^[a-f0-9-]{36}$/i.test(frame.deviceId || '')) return;
    // Unknown phones get no answer at all: the port tells nothing to a scan.
    const pair = this.hub.pairs.get(frame.deviceId);
    if (!pair) return;
    let request;
    try { request = decryptJson(pair.key, { ...frame, threadId: null }); } catch { return; }
    for (const [id, at] of this.seen) if (now - at > REQUEST_AGE_MS * 2) this.seen.delete(id);
    if (this.seen.has(frame.id) || request.deviceId !== frame.deviceId || Math.abs(now - Number(request.sentAt)) > REQUEST_AGE_MS) return;
    this.seen.set(frame.id, now);
    let reply;
    try { reply = { ok: true, offer: await this.hub.resumeOffer(pair, request) }; }
    catch (error) { reply = { ok: false, error: String(error.message || error).slice(0, 180) }; }
    if (!this.socket) return;
    const raw = Buffer.from(JSON.stringify({ v: 1, kind: 'direct.resume.offer', id: frame.id,
      ...encryptJson(pair.key, 'direct.resume.offer', null, frame.id, reply) }));
    this.socket.send(raw, remote.port, remote.address, () => {});
  }
}

module.exports = { DirectPairs, DirectResume, RESUME_PORT };
