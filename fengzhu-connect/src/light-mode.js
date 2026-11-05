'use strict';
// Light mode (轻量模式): the phone turns it on to keep the relay small. Tool
// activity (commands, tool input and output, file changes, screenshots and
// images) then goes up as a placeholder of the same id, order and type, so the
// phone still shows "执行了 N 项操作" with its counts; the full encrypted row
// stays here, and the phone fetches it on request (history.details) and keeps
// it. Thinking, replies, cards and statuses are unchanged.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LIGHT_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageView', 'imageGeneration', 'collabAgentToolCall', 'toolImages']);
const KEEP_DAYS = 90;
const READ_CHUNK = 256 * 1024;
const MAX_DETAIL_LINE = 64 * 1024 * 1024;
const DETAIL_SCAN_TIMEOUT_MS = 30_000;
const MAX_RECENT_DETAILS = 4096;
const DETAIL_CURSOR_TTL_MS = 30 * 60_000;
const MAX_DETAIL_CURSORS = 64;
const LARGE_DETAIL_FILE_BYTES = 512 * 1024 * 1024;
const LARGE_DETAIL_READ_DELAY_MS = 3;

function accountThreadTag(accountKey, threadId) {
  const key = Buffer.isBuffer(accountKey) ? accountKey : Buffer.from(accountKey, 'base64');
  if (key.length !== 32) throw new Error('无法验证历史详情的账户');
  return crypto.createHmac('sha256', key).update('khlink-light-thread-v1\0').update(String(threadId), 'utf8').digest('hex');
}

// Only trust the in-memory duplicate cache while the file still has the
// identity and metadata observed after our last append. A removed, replaced,
// truncated or externally modified detail file must be written again.
function detailFileSignature(stat) {
  if (!stat?.isFile?.() || !Number.isFinite(stat.ino) || !stat.ino || !Number.isFinite(stat.size)) return null;
  return [stat.dev, stat.ino, stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs, stat.size].join(':');
}

function detailFileIdentity(stat) {
  if (!stat?.isFile?.() || !Number.isFinite(stat.ino) || !stat.ino || !Number.isFinite(stat.size)) return null;
  return [stat.dev, stat.ino, stat.birthtimeMs].join(':');
}

class LightMode {
  constructor(home, { io = fs.promises, now = Date.now, scanTimeoutMs = DETAIL_SCAN_TIMEOUT_MS, maxRecentDetails = MAX_RECENT_DETAILS, acceptsLegacyRow = null, threadTagFor = null, largeFileBytes = LARGE_DETAIL_FILE_BYTES, largeReadDelayMs = LARGE_DETAIL_READ_DELAY_MS } = {}) {
    this.file = path.join(home, 'light-mode.json');
    this.dir = path.join(home, 'light-details');
    this.io = io;
    this.now = now;
    this.acceptsLegacyRow = acceptsLegacyRow;
    this.threadTagFor = threadTagFor;
    this.largeFileBytes = largeFileBytes;
    this.largeReadDelayMs = largeReadDelayMs;
    this.largeScanActive = false;
    this.scanTimeoutMs = scanTimeoutMs;
    this.writes = new Map();
    this.directoryReady = null;
    this.recentDetails = new Map();
    this.detailFiles = new Map();
    this.detailCursors = new Map();
    this.detailReads = new Map();
    this.maxRecentDetails = Math.max(0, Math.min(MAX_RECENT_DETAILS, Number(maxRecentDetails) || 0));
    try { const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.on = saved.enabled === true; this.at = Number(saved.changedAt) || 0; } catch { this.on = false; this.at = 0; }
  }

  enabled() { return this.on; }
  changedAt() { return this.at; }

  // The newest change wins: with several phones on one account, an older
  // choice arriving late does not undo a newer one. False when ignored.
  set(enabled, changedAt = Date.now()) {
    if (changedAt < this.at) return false;
    this.on = enabled === true; this.at = changedAt;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ enabled: this.on, changedAt: this.at }) + '\n');
    return true;
  }

  // The placeholder for a tool row, or null when the row goes up whole.
  placeholder(value) {
    if (!this.on || !value || !LIGHT_TYPES.has(value.type)) return null;
    return { type: value.type, text: '', light: true,
      ...(value.tool ? { tool: value.tool } : {}), ...(value.status ? { status: value.status } : {}), ...(value.createdAt ? { createdAt: value.createdAt } : {}) };
  }

  threadFile(threadId) { return path.join(this.dir, `${String(threadId).replace(/[^\w.-]/g, '_')}.jsonl`); }

  // Different thread IDs can map to the same legacy filename (and Windows
  // filenames are case-insensitive). Tag new rows without moving old files;
  // older connectors can still read them with their original collision limit.
  threadTag(threadId) { return this.threadTagFor ? this.threadTagFor(threadId) : crypto.createHash('sha256').update(String(threadId), 'utf8').digest('hex'); }

  forgetRecentDetails(file) {
    this.detailFiles.delete(file);
    for (const [key, entry] of this.recentDetails) if (entry.file === file) this.recentDetails.delete(key);
  }

  // Keep the full encrypted row ({id, nonce, ciphertext}) for history.details.
  save(threadId, row, contentHash = null) {
    const file = this.threadFile(threadId);
    const line = JSON.stringify({ id: row.id, nonce: row.nonce, ciphertext: row.ciphertext, threadTag: this.threadTag(threadId) }) + '\n';
    // Serialize per file so updates to the same id remain in order. Different
    // threads can write concurrently without blocking heartbeats or RPCs.
    const previous = this.writes.get(file) || Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      if (!this.directoryReady) {
        this.directoryReady = this.io.mkdir(this.dir, { recursive: true }).catch((error) => {
          this.directoryReady = null;
          throw error;
        });
      }
      await this.directoryReady;
      const key = JSON.stringify([file, row.id]);
      const expected = this.detailFiles.get(file);
      if (expected) {
        let observed = null;
        try { observed = detailFileSignature(await this.io.stat(file)); } catch { /* replaced or removed */ }
        if (!observed || observed !== expected) this.forgetRecentDetails(file);
      }
      const cached = contentHash && this.detailFiles.has(file) ? this.recentDetails.get(key) : null;
      if (cached?.hash === contentHash) {
        this.recentDetails.delete(key);
        this.recentDetails.set(key, cached);
        return;
      }
      try { await this.io.appendFile(file, line); }
      catch (error) {
        this.forgetRecentDetails(file);
        if (error.code === 'ENOENT') this.directoryReady = null;
        throw error;
      }
      // Without a digest the caller may have written a newer version of any
      // row, so conservatively forget the file's cached contents.
      if (!contentHash || !this.maxRecentDetails) { this.forgetRecentDetails(file); return; }
      let signature = null;
      try { signature = detailFileSignature(await this.io.stat(file)); } catch { /* a later write will retry */ }
      if (!signature) { this.forgetRecentDetails(file); return; }
      this.detailFiles.set(file, signature);
      this.recentDetails.delete(key);
      this.recentDetails.set(key, { file, hash: contentHash });
      while (this.recentDetails.size > this.maxRecentDetails) {
        const oldest = this.recentDetails.keys().next().value;
        const evicted = this.recentDetails.get(oldest);
        this.recentDetails.delete(oldest);
        // Entries for a file may only be used together with its signature.
        // Dropping all of them avoids trusting stale entries if that file is
        // replaced while its signature is absent.
        if (evicted) this.forgetRecentDetails(evicted.file);
      }
    });
    this.writes.set(file, write);
    const forget = () => { if (this.writes.get(file) === write) this.writes.delete(file); };
    write.then(forget, forget);
    return write;
  }

  details(threadId, ids) {
    const wanted = new Set(ids);
    if (!wanted.size) return Promise.resolve([]);
    const file = this.threadFile(threadId), threadTag = this.threadTag(threadId);
    // The phone requests one row at a time. Keep a bounded cursor so a large
    // file can continue after the per-request deadline instead of rescanning
    // the same suffix forever. Distinguish account, thread and item.
    const cursorKey = wanted.size === 1 ? JSON.stringify([file, threadTag, [...wanted][0]]) : null;
    if (cursorKey && this.detailReads.has(cursorKey)) return this.detailReads.get(cursorKey);
    const read = this.readDetails(threadId, wanted, file, threadTag, cursorKey);
    if (cursorKey) {
      this.detailReads.set(cursorKey, read);
      const forget = () => { if (this.detailReads.get(cursorKey) === read) this.detailReads.delete(cursorKey); };
      read.then(forget, forget);
    }
    return read;
  }

  async scanDetails(handle, threadId, threadTag, wanted, position, floor, deadline, throttle) {
    const found = new Map(); let fragments = []; let fragmentSize = 0; let crossedFloor = false; let foundPosition = null;
    const consume = (head) => {
      const total = fragmentSize + head.length;
      if (total > MAX_DETAIL_LINE) throw new Error('历史详情中的单条记录过大，无法安全读取');
      if (total) {
        const line = Buffer.concat([head, ...fragments.reverse()], total).toString('utf8').replace(/\r$/, '');
        try {
          const row = JSON.parse(line);
          if (wanted.has(row.id) && !found.has(row.id)) {
            const tagged = Object.prototype.hasOwnProperty.call(row, 'threadTag');
            const valid = tagged ? row.threadTag === threadTag : Boolean(this.acceptsLegacyRow?.(threadId, row));
            if (valid) found.set(row.id, { id: row.id, nonce: row.nonce, ciphertext: row.ciphertext });
          }
        } catch { /* a partly written or malformed line */ }
      }
      fragments = []; fragmentSize = 0;
    };
    while (position > 0 && found.size < wanted.size && !crossedFloor) {
      // Re-read only the unfinished line on the next request; never keep its
      // potentially large ciphertext in the cursor cache.
      if (this.now() >= deadline) return { found, timedOut: true, position: position + fragmentSize };
      const size = Math.min(READ_CHUNK, position), start = position - size;
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buffer, 0, size, start);
      if (bytesRead !== size) throw new Error('历史详情读取中断，请重试');
      if (throttle && this.largeReadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.largeReadDelayMs));
      let end = bytesRead;
      for (let i = bytesRead - 1; i >= 0; i--) {
        if (buffer[i] !== 10) continue;
        const recordEnd = start + end + fragmentSize, before = found.size;
        consume(buffer.subarray(i + 1, end)); end = i;
        if (found.size > before) foundPosition = recordEnd;
        if (found.size === wanted.size) break;
        // Include a row straddling the old snapshot boundary, then stop at
        // its preceding newline. This also handles a partial append safely.
        if (floor > 0 && start + i < floor) { crossedFloor = true; break; }
      }
      if (found.size === wanted.size || crossedFloor) break;
      if (end) { fragments.push(buffer.subarray(0, end)); fragmentSize += end; }
      if (fragmentSize > MAX_DETAIL_LINE) throw new Error('历史详情中的单条记录过大，无法安全读取');
      position = start;
    }
    if (position === 0 && fragments.length && found.size < wanted.size) {
      const recordEnd = fragmentSize, before = found.size;
      consume(Buffer.alloc(0));
      if (found.size > before) foundPosition = recordEnd;
    }
    return { found, timedOut: false, position: foundPosition ?? position };
  }

  async readDetails(threadId, wanted, file, threadTag, cursorKey) {
    const pending = this.writes.get(file);
    if (pending) await pending.catch(() => {});
    let handle;
    try { handle = await this.io.open(file, 'r'); }
    catch (error) { if (cursorKey) this.detailCursors.delete(cursorKey); if (error.code === 'ENOENT') return []; throw error; }
    const timeout = (resumable) => Object.assign(new Error(resumable
      ? '历史详情文件较大，查找超时；再次取回可继续查找'
      : '历史详情文件较大，查找超时；请稍后重试'), resumable ? { code: 'LIGHT_DETAILS_RETRY' } : {});
    let largeLease = false;
    try {
      const stat = await handle.stat(), identity = detailFileIdentity(stat), deadline = this.now() + this.scanTimeoutMs;
      if (stat.size >= this.largeFileBytes) {
        if (this.largeScanActive) throw Object.assign(new Error('电脑正在检索另一条较大的历史详情，请稍后重试'), { code: 'LIGHT_DETAILS_RETRY' });
        this.largeScanActive = true; largeLease = true;
      }
      let cursor = cursorKey ? this.detailCursors.get(cursorKey) : null;
      if (cursor && (!identity || cursor.identity !== identity || cursor.expiresAt <= this.now() || stat.size < cursor.size ||
          (stat.size === cursor.size && (stat.mtimeMs !== cursor.mtimeMs || stat.ctimeMs !== cursor.ctimeMs)))) {
        this.detailCursors.delete(cursorKey); cursor = null;
      }
      let scan = null;
      if (cursor && stat.size > cursor.size) {
        const tail = await this.scanDetails(handle, threadId, threadTag, wanted, stat.size, cursor.size, deadline, largeLease);
        if (tail.timedOut) throw timeout(true);
        if (tail.found.size) scan = tail;
      }
      if (!scan) scan = await this.scanDetails(handle, threadId, threadTag, wanted, cursor ? cursor.position : stat.size, 0, deadline, largeLease);
      if (scan.timedOut) {
        if (cursorKey && identity) {
          this.detailCursors.delete(cursorKey);
          this.detailCursors.set(cursorKey, { file, identity, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
            position: scan.position, expiresAt: this.now() + DETAIL_CURSOR_TTL_MS });
          while (this.detailCursors.size > MAX_DETAIL_CURSORS) this.detailCursors.delete(this.detailCursors.keys().next().value);
        }
        throw timeout(Boolean(cursorKey && identity));
      }
      // A newer update may have been appended while this snapshot was read.
      // Check that suffix before returning a previously found detail.
      const after = await handle.stat();
      let currentPath;
      try { currentPath = await this.io.stat(file); } catch { currentPath = null; }
      if (!currentPath || (identity && detailFileIdentity(currentPath) !== identity) || currentPath.size < after.size ||
          (currentPath.size === after.size && (currentPath.mtimeMs !== after.mtimeMs || currentPath.ctimeMs !== after.ctimeMs))) {
        if (cursorKey) this.detailCursors.delete(cursorKey);
        throw new Error('历史详情在查找时发生变化，请重试');
      }
      if (detailFileIdentity(after) !== identity || after.size < stat.size ||
          (after.size === stat.size && (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs))) {
        if (cursorKey) this.detailCursors.delete(cursorKey);
        throw new Error('历史详情在查找时发生变化，请重试');
      }
      if (after.size > stat.size) {
        const tail = await this.scanDetails(handle, threadId, threadTag, wanted, after.size, stat.size, deadline, largeLease);
        if (tail.timedOut) {
          if (cursorKey && identity) {
            // Resume at the found row (or EOF for a missing row), so a busy
            // append stream cannot make us rescan the entire old file again.
            this.detailCursors.delete(cursorKey);
            this.detailCursors.set(cursorKey, { file, identity, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
              position: scan.position, expiresAt: this.now() + DETAIL_CURSOR_TTL_MS });
            while (this.detailCursors.size > MAX_DETAIL_CURSORS) this.detailCursors.delete(this.detailCursors.keys().next().value);
          }
          throw timeout(Boolean(cursorKey && identity));
        }
        for (const [id, row] of tail.found) scan.found.set(id, row);
      }
      if (cursorKey) this.detailCursors.delete(cursorKey);
      return [...scan.found.values()];
    } catch (error) {
      if (cursorKey && error.code !== 'LIGHT_DETAILS_RETRY') this.detailCursors.delete(cursorKey);
      throw error;
    } finally { if (largeLease) this.largeScanActive = false; await handle.close(); }
  }

  // Details of conversations quiet for KEEP_DAYS go (the phone keeps what it fetched).
  prune(now = Date.now()) {
    let names = []; try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > KEEP_DAYS * 86_400_000) {
          this.forgetRecentDetails(file);
          for (const [key, entry] of this.detailCursors) if (entry.file === file) this.detailCursors.delete(key);
          fs.rmSync(file, { force: true });
        }
      } catch { /* gone already */ }
    }
  }
}

module.exports = { LightMode, LIGHT_TYPES, accountThreadTag };
