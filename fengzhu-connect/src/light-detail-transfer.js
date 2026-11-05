'use strict';

const crypto = require('node:crypto');

// A history row is already encrypted. Split its base64 ciphertext before the
// outer command encryption so every websocket frame stays well below 2 MiB.
const DETAIL_CHUNK_CHARS = 192 * 1024;
const MAX_DETAIL_CHARS = 16 * 1024 * 1024;
const MAX_TRANSFER_CACHE_CHARS = 32 * 1024 * 1024;
const TRANSFER_TTL_MS = 120_000;
const LEGACY_DETAIL_JSON_BYTES = 900 * 1024;

class LightDetailTransfers {
  constructor(readRows, { now = Date.now, chunkChars = DETAIL_CHUNK_CHARS, maxDetailChars = MAX_DETAIL_CHARS,
    maxCacheChars = MAX_TRANSFER_CACHE_CHARS, ttlMs = TRANSFER_TTL_MS } = {}) {
    this.readRows = readRows;
    this.now = now;
    this.chunkChars = chunkChars;
    this.maxDetailChars = maxDetailChars;
    this.maxCacheChars = maxCacheChars;
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.cacheChars = 0;
  }

  remove(token) {
    const entry = this.entries.get(token);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.cacheChars -= entry.ciphertext.length;
    this.entries.delete(token);
  }

  async read({ threadId, id, offset = 0, transferId = null } = {}) {
    if (typeof threadId !== 'string' || !threadId || threadId.length > 1024 ||
        typeof id !== 'string' || !id || id.length > 1024 ||
        !Number.isSafeInteger(offset) || offset < 0) throw new Error('详细过程请求无效');
    for (const [token, entry] of this.entries) if (entry.expiresAt <= this.now()) this.remove(token);
    let entry;
    let token = transferId;
    if (!token) {
      if (offset !== 0) throw new Error('详细过程传输已过期，请重新取回');
      const [row] = await this.readRows(threadId, [id]);
      if (!row) return { id, found: false };
      if (row.id !== id || typeof row.nonce !== 'string' || !row.nonce ||
          typeof row.ciphertext !== 'string' || !row.ciphertext) throw new Error('电脑上的详细过程无效');
      if (row.ciphertext.length > this.maxDetailChars) throw new Error('详细过程过大，暂时无法安全取回');
      entry = { threadId, id, nonce: row.nonce, ciphertext: row.ciphertext, expiresAt: this.now() + this.ttlMs };
      if (entry.ciphertext.length > this.chunkChars) {
        if (entry.ciphertext.length > this.maxCacheChars) throw new Error('详细过程过大，暂时无法安全取回');
        while (this.entries.size >= 8 || this.cacheChars + entry.ciphertext.length > this.maxCacheChars) {
          this.remove(this.entries.keys().next().value);
        }
        token = crypto.randomUUID();
        entry.timer = setTimeout(() => this.remove(token), this.ttlMs);
        entry.timer.unref?.();
        this.entries.set(token, entry);
        this.cacheChars += entry.ciphertext.length;
      } else token = null;
    } else {
      entry = this.entries.get(String(token));
      if (!entry || entry.threadId !== threadId || entry.id !== id || entry.expiresAt <= this.now()) {
        throw new Error('详细过程传输已过期，请重新取回');
      }
    }
    if (offset > entry.ciphertext.length) throw new Error('详细过程分片位置无效');
    const chunk = entry.ciphertext.slice(offset, offset + this.chunkChars);
    return { id, found: true, transferId: token, nonce: entry.nonce, total: entry.ciphertext.length,
      offset, chunk, eof: offset + chunk.length === entry.ciphertext.length };
  }
}

module.exports = { LightDetailTransfers, DETAIL_CHUNK_CHARS, MAX_DETAIL_CHARS, LEGACY_DETAIL_JSON_BYTES };
