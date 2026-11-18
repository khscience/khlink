'use strict';

// What this computer already uploaded to the relay, per conversation item.
//
// Each upload encrypts the row again with a fresh nonce, so the relay cannot
// tell an unchanged row from a new one: after a connector restart or update,
// re-reading the newest part of every conversation sent tens of MB of rows the
// relay already had, and every phone then read them again (2026-11-15: 69 MB
// of September–November rows re-sent in one hour). The connector now keeps a
// keyed digest of each row it uploaded and skips rows whose digest is
// unchanged.
//
// One small file per conversation, written a moment after its uploads. The
// digest is an HMAC under the account key, so another account (or a new key)
// never matches and the file reveals nothing about the content. A
// conversation's record is dropped after MAX_AGE_MS: if the relay lost rows,
// the next sync after that sends them again.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_AGE_MS = 7 * 24 * 3_600_000;
const SAVE_DELAY_MS = 2_000;
const MAX_PENDING_HASHES = 20_000;

class UploadDigests {
  constructor(dir, accountKey, options = {}) {
    this.dir = dir;
    this.key = Buffer.isBuffer(accountKey) ? accountKey : Buffer.from(String(accountKey || ''), 'base64');
    this.now = options.now || Date.now;
    this.maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
    this.threads = new Map();
    this.dirty = new Set();
    this.timer = null;
    // Digest of each encrypted frame not yet uploaded, by its nonce: the frame
    // is spread into the upload row, so this is how the row finds its digest.
    this.pending = new Map();
  }

  /** The digest of one item's plain value (before encryption). */
  digest(threadId, itemId, value) {
    return crypto.createHmac('sha256', this.key).update('khlink-upload-v1\0')
      .update(JSON.stringify([threadId, itemId, value])).digest('base64').slice(0, 22);
  }

  /** Remembers the digest for the frame encrypted from `value`. */
  noteFrame(frame, threadId, itemId, value) {
    if (!frame?.nonce) return;
    if (this.pending.size >= MAX_PENDING_HASHES) this.pending.delete(this.pending.keys().next().value);
    this.pending.set(frame.nonce, { digest: this.digest(threadId, itemId, value), info: describe(value) });
  }

  file(threadId) {
    return path.join(this.dir, `${crypto.createHash('sha256').update(String(threadId)).digest('hex').slice(0, 32)}.json`);
  }

  load(threadId) {
    let entry = this.threads.get(threadId);
    if (entry) {
      if (this.now() - entry.startedAt > this.maxAgeMs) { entry = null; this.threads.delete(threadId); }
      else return entry;
    }
    try {
      const saved = JSON.parse(fs.readFileSync(this.file(threadId), 'utf8'));
      if (saved?.threadId === threadId && saved.items && typeof saved.items === 'object' &&
        Number.isFinite(saved.startedAt) && this.now() - saved.startedAt <= this.maxAgeMs) {
        entry = { startedAt: saved.startedAt, items: new Map(Object.entries(saved.items)) };
      }
    } catch { /* No record yet, or unreadable: start a new one. */ }
    entry ||= { startedAt: this.now(), items: new Map() };
    this.threads.set(threadId, entry);
    return entry;
  }

  rowKey(row, digest) { return `${digest}:${row.order ?? ''}:${row.createdAt ?? ''}`; }

  /**
   * Splits upload rows into those to send and those already on the relay.
   * Rows without a known digest are always sent. Each kept row has `info`
   * (its kind and size, for the traffic log) beside it.
   */
  filter(threadId, rows) {
    const entry = this.load(threadId);
    const send = []; const skipped = [];
    for (const row of rows) {
      const noted = row?.nonce ? this.pending.get(row.nonce) : null;
      if (row?.nonce) this.pending.delete(row.nonce);
      const key = noted ? this.rowKey(row, noted.digest) : null;
      const item = { row, key, info: noted?.info || { kind: 'other' } };
      if (key && entry.items.get(String(row.id)) === key) skipped.push(item);
      else send.push(item);
    }
    return { send, skipped };
  }

  /** Records rows the relay accepted. */
  remember(threadId, items) {
    const entry = this.load(threadId);
    let changed = false;
    for (const { row, key } of items) {
      if (!key || entry.items.get(String(row.id)) === key) continue;
      entry.items.set(String(row.id), key); changed = true;
    }
    if (changed) this.markDirty(threadId);
  }

  /** Forgets one conversation (or all): its next sync sends every row again. */
  forget(threadId) {
    if (threadId === undefined) {
      for (const id of new Set([...this.threads.keys()])) this.forget(id);
      try { for (const name of fs.readdirSync(this.dir)) if (name.endsWith('.json')) fs.rmSync(path.join(this.dir, name), { force: true }); } catch { /* none */ }
      return;
    }
    this.threads.delete(threadId); this.dirty.delete(threadId);
    try { fs.rmSync(this.file(threadId), { force: true }); } catch { /* none */ }
  }

  markDirty(threadId) {
    this.dirty.add(threadId);
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty.size) return;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* reported below */ }
    for (const threadId of this.dirty) {
      const entry = this.threads.get(threadId);
      if (!entry) continue;
      const file = this.file(threadId);
      try {
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ threadId, startedAt: entry.startedAt, items: Object.fromEntries(entry.items) }));
        fs.renameSync(`${file}.tmp`, file);
      } catch { /* A lost record only means rows are sent again. */ }
    }
    this.dirty.clear();
  }
}

/** The kind of a history value, for the traffic log: text, image, tool… */
function describe(value) {
  const type = String(value?.type || 'other');
  const images = Array.isArray(value?.images) ? value.images.length : 0;
  if (images || type === 'imageGeneration' || type === 'imageView') return { kind: 'image', type };
  if (/message$/i.test(type) || type === 'reasoning' || type === 'plan') return { kind: 'text', type };
  if (/command|tool|file|mcp|patch|search/i.test(type)) return { kind: 'tool', type };
  return { kind: 'other', type };
}

/**
 * Hourly totals of what history uploads were for, written to the connector
 * log: bytes and rows sent per kind (text, image, tool…), rows skipped as
 * already uploaded, and the conversations that sent the most.
 */
class UploadStats {
  constructor(log, options = {}) {
    this.log = log;
    this.now = options.now || Date.now;
    this.intervalMs = options.intervalMs ?? 3_600_000;
    this.reset();
  }

  reset() {
    this.since = this.now(); this.kinds = new Map(); this.threads = new Map();
    this.skipped = 0; this.skippedBytes = 0; this.requests = 0;
  }

  add(threadId, sent, skipped) {
    for (const { row, info } of sent) {
      const bytes = String(row.ciphertext || '').length;
      const kind = this.kinds.get(info.kind) || { rows: 0, bytes: 0 };
      kind.rows += 1; kind.bytes += bytes; this.kinds.set(info.kind, kind);
      this.threads.set(threadId, (this.threads.get(threadId) || 0) + bytes);
    }
    for (const { row } of skipped) { this.skipped += 1; this.skippedBytes += String(row.ciphertext || '').length; }
    if (sent.length) this.requests += 1;
    if (this.now() - this.since >= this.intervalMs) this.report();
  }

  report() {
    const total = [...this.kinds.values()].reduce((sum, kind) => sum + kind.bytes, 0);
    if (total || this.skipped) {
      const kinds = [...this.kinds].sort((a, b) => b[1].bytes - a[1].bytes).map(([name, kind]) => `${name} ${mb(kind.bytes)} (${kind.rows})`).join(', ');
      const top = [...this.threads].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, bytes]) => `${String(id).slice(0, 16)} ${mb(bytes)}`).join(', ');
      this.log(`[fengzhu-connect] history upload since ${new Date(this.since).toISOString()}: sent ${mb(total)} in ${this.requests} requests [${kinds || 'none'}]; skipped ${this.skipped} unchanged rows (${mb(this.skippedBytes)}); top ${top || 'none'}`);
    }
    this.reset();
  }
}

function mb(bytes) { return `${(bytes / 1048576).toFixed(2)} MB`; }

module.exports = { UploadDigests, UploadStats, describe, MAX_AGE_MS };
