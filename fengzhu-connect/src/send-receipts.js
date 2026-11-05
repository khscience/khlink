const fs = require('node:fs');
const crypto = require('node:crypto');
const { protect, unprotect } = require('./config');
const { writeFileAtomic } = require('./atomic-file');
const { isImageAttachment } = require('./attachment-store');
const { publicAttachments, sanitizeUploadReferences } = require('./attachment-privacy');

const UNCERTAIN = '发送结果尚未确认，请检查对话；系统不会自动重发。';
const VISIBLE = new Set(['dispatching', 'uncertain', 'failed']);

class SendReceipts {
  constructor(file = null) {
    this.file = file; this.rows = new Map();
    if (file && fs.existsSync(file)) {
      // An unreadable receipt file must fail closed, never forget sends.
      const rows = JSON.parse(unprotect(fs.readFileSync(file, 'utf8')));
      if (!Array.isArray(rows)) throw new Error('发送回执文件损坏');
      this.rows = new Map(rows.map((row) => [row.id, row]));
    }
    let changed = false;
    for (const row of this.rows.values()) if (row.state === 'dispatching') {
      Object.assign(row, { state: 'uncertain', reason: UNCERTAIN, stateVersion: Date.now() }); changed = true;
    }
    if (changed) this.save();
  }

  save() {
    if (this.file) writeFileAtomic(this.file, protect(JSON.stringify([...this.rows.values()])), { mode: 0o600 });
  }

  fingerprint(backend, args) {
    return crypto.createHash('sha256').update(JSON.stringify([backend, args.threadId, args.text || '',
      (args.attachments || []).map((item) => [item.attachmentId, item.name])])).digest('hex');
  }

  get(id) { return this.rows.get(id); }

  begin(id, backend, args) {
    const now = Date.now();
    const row = { id, requestId: id, threadId: args.threadId, backend, text: String(args.text || ''),
      attachments: args.attachments || [], createdAt: now, state: 'dispatching', stateVersion: now,
      origin: 'mobile', blocking: false, historyAfterOrder: args.historyAfterOrder,
      fingerprint: this.fingerprint(backend, args) };
    // Keep unresolved sends indefinitely; bound the resolved request cache.
    const resolved = [...this.rows.values()].filter((item) => !['uncertain', 'dispatching', 'desktop_queued', 'failed'].includes(item.state)).sort((a, b) => b.createdAt - a.createdAt);
    for (const [index, item] of resolved.entries()) if (now - item.createdAt > 7 * 86400_000 || index >= 500) this.rows.delete(item.id);
    this.rows.set(id, row);
    try { this.save(); } catch (error) { this.rows.delete(id); throw error; }
    return row;
  }

  update(id, changes) {
    const row = this.rows.get(id); if (!row) return null;
    Object.assign(row, changes, { stateVersion: Math.max(Date.now(), row.stateVersion + 1) });
    row.blocking = ['desktop_queued', 'uncertain', 'failed'].includes(row.state);
    this.save(); return row;
  }

  event(kind, threadId, value) {
    const id = value?.id || value?.requestId; const row = this.rows.get(id);
    if (!row || row.threadId !== threadId) return;
    const state = ({ 'followup.started': 'started', 'followup.cancelled': 'cancelled', 'followup.failed': value.needsConfirmation ? 'uncertain' : 'failed' })[kind]
      || (kind === 'followup.queued' ? value.state : null);
    if (!state || state === 'dispatching' || row.state === state) return;
    this.update(id, { state, reason: value.reason || null, startedAt: value.startedAt || row.startedAt || null });
  }

  item(row) {
    const { fingerprint, result, ...item } = row;
    return { ...item, text: sanitizeUploadReferences(item.text), attachments: publicAttachments(item.attachments) };
  }

  result(row) {
    return { ...(row.result || {}), accepted: ['started', 'steered'].includes(row.state), queued: row.state === 'desktop_queued',
      uncertain: row.state === 'uncertain', failed: row.state === 'failed', cancelled: row.state === 'cancelled',
      backend: row.backend, item: this.item(row) };
  }

  visible(threadId = null) {
    return [...this.rows.values()].filter((row) => VISIBLE.has(row.state) && (!threadId || row.threadId === threadId)).map((row) => this.item(row));
  }

  reconcile(backend, threadId, items) {
    const normalized = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const used = new Set([...this.rows.values()].filter((row) => row.threadId === threadId && row.historyId).map((row) => row.historyId));
    const changes = [];
    for (const row of this.rows.values()) {
      if (row.backend !== backend || row.threadId !== threadId || !['dispatching', 'uncertain', 'desktop_queued', 'started'].includes(row.state) || row.historyId) continue;
      const text = normalized(row.text);
      const expectedImages = (row.attachments || []).filter(isImageAttachment);
      if (!text && !expectedImages.length) continue;
      const expectedHashes = imageHashes(expectedImages);
      const receipt = items.find((item) => {
        const value = item.value || item;
        const fresh = Number.isFinite(row.historyAfterOrder) ? item.order > row.historyAfterOrder : item.at >= row.createdAt;
        const actualText = normalized(value.text);
        const textMatches = text ? actualText === text :
          (backend === 'pi' ? ['请看图片', '图片', ''].includes(actualText) : ['', '图片', '图片附件'].includes(actualText));
        // DSH's user/message event preserves the original prompt requestId but
        // replaces image bytes with attachment references. That identity plus
        // the exact image count proves delivery without guessing from text or
        // depending on a preview that may already have expired.
        if (backend === 'dsh' && item.receiptRequestId) {
          return fresh && value.type === 'userMessage' && !used.has(item.id) &&
            item.receiptRequestId === row.requestId && item.receiptImageCount === expectedImages.length &&
            (!text || textMatches);
        }
        return fresh && value.type === 'userMessage' && !used.has(item.id) && textMatches &&
          imagesMatch(expectedHashes, value.images);
      });
      if (!receipt) continue;
      const wasUnconfirmed = row.state !== 'started';
      this.update(row.id, { state: 'started', startedAt: receipt.at || Date.now(), reason: null, historyId: receipt.id });
      used.add(receipt.id);
      if (wasUnconfirmed) changes.push(this.item(row));
    }
    return changes;
  }
}

// A matching message body alone cannot prove that an image was delivered.
// Compare all image bytes with the newer history record; if a preview is too
// large or missing, leave the receipt unconfirmed rather than guessing.
function imageHashes(expected) {
  if (!expected.length) return [];
  try {
    const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
    return expected.map((item) => {
      const stat = fs.statSync(item.path);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 5 * 1024 * 1024) throw new Error('image unavailable');
      return hash(fs.readFileSync(item.path));
    }).sort();
  } catch { return null; }
}

function imagesMatch(expected, actual) {
  if (!expected) return false;
  if (!expected.length) return true;
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  try {
    const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
    const fromHistory = actual.map((image) => {
      const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=]+)$/i.exec(String(image?.data || ''));
      if (!match) throw new Error('image unavailable');
      return hash(Buffer.from(match[1], 'base64'));
    }).sort();
    return expected.every((value, index) => value === fromHistory[index]);
  } catch { return false; }
}

module.exports = { SendReceipts, UNCERTAIN };
