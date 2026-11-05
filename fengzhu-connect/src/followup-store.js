const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { home, protect, unprotect } = require('./config');
const { requestMarkerId, stripRequestMarker } = require('./request-marker');
const { sanitizeUploadReferences, publicAttachments } = require('./attachment-privacy');

class FollowupStore {
  constructor(file = path.join(home, 'followups.dat')) {
    this.file = file;
    this.items = this.load();
    this.saveRetryTimer = null;
    this.lastSaveError = null;
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return [];
      const decoded = JSON.parse(unprotect(fs.readFileSync(this.file, 'utf8')));
      return Array.isArray(decoded) ? decoded : [];
    } catch (error) {
      throw new Error(`Cannot read protected follow-up queue: ${error.message}`);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // A fixed per-process temp name can be observed by Defender/indexers or
    // collide with an earlier interrupted write. Use a unique temp file for
    // every snapshot, then retry the final replace when Windows briefly holds
    // either side of the rename open.
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, protect(JSON.stringify(this.items)), { mode: 0o600 });
      renameWithTransientRetry(temporary, this.file);
      this.lastSaveError = null;
      return true;
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      this.lastSaveError = error;
      try { this.onSaveError?.(error); } catch {}
      this.scheduleSaveRetry();
      // Queue state remains authoritative in memory. A transient filesystem
      // lock must never turn an accepted mobile message into a send failure.
      return false;
    }
  }

  scheduleSaveRetry() {
    if (this.saveRetryTimer) return;
    this.saveRetryTimer = setTimeout(() => {
      this.saveRetryTimer = null;
      this.save();
    }, 500);
    this.saveRetryTimer.unref?.();
  }

  list(threadId = null) {
    return this.items.filter((item) => !threadId || item.threadId === threadId).map(publicItem);
  }

  get(id) { return this.items.find((item) => item.id === id || item.requestId === id); }

  add(item) {
    const existing = this.get(item.requestId);
    if (existing) return existing;
    this.items.push(item); this.save(); return item;
  }

  update(id, changes) {
    const item = this.get(id); if (!item) return null;
    Object.assign(item, changes, { stateVersion: (item.stateVersion || 0) + 1, updatedAt: Date.now() }); this.save(); return item;
  }

  remove(id) {
    const item = this.get(id); if (!item) return null;
    this.items = this.items.filter((candidate) => candidate !== item); this.save(); return item;
  }

  matchStarted(threadId, text, startedAt = Date.now()) {
    const normalized = normalizeText(stripRequestMarker(text));
    const marker = requestMarkerId(text);
    if (marker) {
      const exact = this.items.find((candidate) => candidate.threadId === threadId && candidate.requestId === marker &&
        ['desktop_queued', 'dispatching', 'pending', 'uncertain', 'started'].includes(candidate.state));
      if (exact) return this.remove(exact.id);
    }
    const item = this.items.find((candidate) => candidate.threadId === threadId &&
      ['desktop_queued', 'dispatching', 'pending', 'uncertain', 'started'].includes(candidate.state) && candidate.createdAt <= startedAt + 5000 &&
      startedAt - candidate.createdAt >= -5000 && startedAt - candidate.createdAt < 7 * 24 * 60 * 60_000 && matchesStartedText(candidate, normalized));
    return item ? this.remove(item.id) : null;
  }

  matchStartedByLocalImagePaths(threadId, paths, startedAt = Date.now()) {
    if (!Array.isArray(paths) || !paths.length) return null;
    const attachmentIds = new Set(paths.map((value) => {
      const name = path.basename(String(value || ''));
      return name.match(/^([0-9a-f-]{36})-/i)?.[1]?.toLowerCase() || null;
    }).filter(Boolean));
    if (!attachmentIds.size) return null;
    const item = this.items.find((candidate) => candidate.threadId === threadId &&
      (attachmentIds.has(String(candidate.requestId || '').toLowerCase()) ||
        (Array.isArray(candidate.attachments) && candidate.attachments.some((attachment) => attachmentIds.has(String(attachment.attachmentId || '').toLowerCase())))) &&
      ['desktop_queued', 'dispatching', 'pending', 'uncertain', 'started'].includes(candidate.state) &&
      candidate.createdAt <= startedAt + 5000 && startedAt - candidate.createdAt >= -5000 && startedAt - candidate.createdAt < 7 * 24 * 60 * 60_000);
    return item ? this.remove(item.id) : null;
  }
}

function renameWithTransientRetry(source, target, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (error) {
      const code = String(error?.code || '').toUpperCase();
      const transient = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(code);
      if (!transient || attempt === attempts - 1) throw error;
      // Keep the wait short; this is only to let a file scanner release its
      // handle, not to block normal queue delivery.
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 20 * (attempt + 1));
    }
  }
}

function normalizeText(value) { return String(value || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim(); }
function matchesStartedText(candidate, actual) {
  const expected = normalizeText(candidate.text);
  if (expected === actual) return true;
  // Desktop can prepend environment context to a user message. Use the
  // explicit queued body or attachment marker only for non-trivial messages,
  // keeping the thread/time/state guards above as the identity boundary.
  const body = normalizeText(candidate.displayText || '');
  // Short mobile messages are valid too. An exact body match is still
  // unambiguous because matchStarted already scopes by thread, state and
  // timestamp; rejecting short bodies leaves items such as "处理好了吗"
  // stuck in the mobile queue forever after Desktop has consumed them.
  if (body && body === actual) return true;
  return expected.length >= 12 && (actual.includes(expected) || (body.length >= 12 && actual.includes(body)));
}

function publicItem(item) {
  return {
    id: item.id, requestId: item.requestId, threadId: item.threadId, title: item.title || null, text: sanitizeUploadReferences(item.displayText || item.text || ''),
    attachments: publicAttachments(item.attachments),
    mode: item.mode, state: item.state, reason: item.reason || null, createdAt: item.createdAt,
    stateVersion: item.stateVersion || 0,
    origin: item.origin || 'mobile',
    queueRequested: item.queueRequested === true,
    // Older connectors kept a failed immediate steer marked non-blocking.
    // Its original queue row is still pending and must expose the manual
    // steer control after reconnect, without asking the user to send it again.
    blocking: !['started', 'steered'].includes(item.state) && (item.blocking !== false || item.queueRequested === true ||
      item.state === 'desktop_queued' && (item.queueTransport === 'codex' || item.steerRequested === true && Boolean(item.reason))),
  };
}

module.exports = { FollowupStore, normalizeText, publicItem };
