const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encryptJson, decryptJson } = require('./crypto');
const { LatestFileWriter } = require('./latest-file-writer');

class DirectHistory {
  constructor(directory, config) {
    this.directory = directory; this.config = config;
    fs.mkdirSync(directory, { recursive: true });
    this.indexFile = path.join(directory, 'threads.json');
    DirectHistory.cleanup(directory);
    // A damaged index (a write cut short) is set aside and rebuilt by a full
    // sync, instead of failing every phone read with a JSON error.
    if (fs.existsSync(this.indexFile) && !DirectHistory.readable(this.indexFile)) {
      DirectHistory.setAside(this.indexFile);
    }
    this.fresh = !fs.existsSync(this.indexFile);
    this.items = new Map(); this.writers = new Map();
    this.ready = this.read(this.indexFile).then((rows) => { this.threads = new Map(rows.map((row) => [row.id, row])); });
  }
  static readable(file) {
    try { return Array.isArray(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return false; }
  }
  static setAside(file) {
    const aside = `${file}.damaged-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch { try { fs.rmSync(file, { force: true }); } catch {} }
    console.log(`[fengzhu-connect] direct history: set aside a damaged ${path.basename(file)}`);
  }
  // Temporary files of writes that never finished (a killed connector) can
  // be hundreds of MB; damaged copies are kept a week for diagnosis.
  static cleanup(directory, now = Date.now()) {
    let names = [];
    try { names = fs.readdirSync(directory); } catch { return; }
    for (const name of names) {
      const file = path.join(directory, name);
      const limit = /\.tmp$/.test(name) ? 10 * 60_000 : /\.damaged-\d+$/.test(name) ? 7 * 86_400_000 : null;
      if (limit === null) continue;
      try { if (now - fs.statSync(file).mtimeMs > limit) fs.rmSync(file, { force: true }); } catch {}
    }
  }
  async read(file) {
    let text;
    try { text = await fs.promises.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    try { return JSON.parse(text); }
    catch {
      // One damaged conversation file must not break the others: drop it so
      // the next sync of that conversation writes it again.
      DirectHistory.setAside(file);
      try { this.onDamage?.(file); } catch {}
      return [];
    }
  }
  async write(file, value) {
    let entry = this.writers.get(file);
    if (!entry) {
      entry = { error: null };
      entry.writer = new LatestFileWriter(file, { onError: (error) => { entry.error = error; } });
      this.writers.set(file, entry);
    }
    entry.error = null; await entry.writer.write(JSON.stringify(value));
    if (entry.error) throw entry.error;
  }
  async flush() { await this.ready; await Promise.all([...this.writers.values()].map((entry) => entry.writer.running)); }
  itemFile(id) { return path.join(this.directory, `${crypto.createHash('sha256').update(id).digest('hex')}.json`); }
  async withItems(file, use) {
    let entry = this.items.get(file);
    if (!entry) {
      entry = { busy: 0, rows: this.read(file).then((rows) => new Map(rows.map((row) => [row.id, row]))) };
      this.items.set(file, entry);
    } else { this.items.delete(file); this.items.set(file, entry); }
    entry.busy++;
    try { return await use(await entry.rows); }
    finally {
      entry.busy--;
      for (const [key, value] of this.items) {
        if (this.items.size <= 8) break;
        if (!value.busy) this.items.delete(key);
      }
    }
  }
  async put(route, body) {
    await this.ready;
    if (route.endsWith('/history/threads')) {
      this.threads.set(body.id, { ...body, connectorId: this.config.deviceId, savedAt: Date.now() });
      await this.write(this.indexFile, [...this.threads.values()]); return { saved: true };
    }
    const match = /\/history\/threads\/([^/]+)\/items$/.exec(route);
    if (!match) return null;
    const file = this.itemFile(decodeURIComponent(match[1]));
    return this.withItems(file, async (rows) => {
      const byOrder = new Map([...rows.values()].map((row) => [row.itemOrder, row.id]));
      for (const item of body.items || []) {
        const oldId = byOrder.get(item.order);
        if (oldId && oldId !== item.id) rows.delete(oldId);
        rows.set(item.id, { ...item, itemOrder: item.order, savedAt: Date.now() }); byOrder.set(item.order, item.id);
      }
      await this.write(file, [...rows.values()]); return { saved: body.items.length };
    });
  }
  /**
   * What was written since `since`, in the relay's upload format: kept while
   * the relay was off, so it can be caught up once it is back. Rows written
   * before save times were kept count by their creation time.
   */
  async changedSince(since) {
    await this.ready;
    const changes = [];
    for (const row of this.threads.values()) {
      if ((row.savedAt ?? row.updatedAt ?? 0) < since) continue;
      const { connectorId, savedAt, ...thread } = row;
      const items = await this.withItems(this.itemFile(row.id), (values) => [...values.values()]
        .filter((item) => (item.savedAt ?? item.createdAt ?? 0) >= since)
        .map(({ itemOrder, savedAt: itemSavedAt, ...item }) => ({ ...item, order: item.order ?? itemOrder })));
      changes.push({ thread, items });
    }
    return changes;
  }
  async get(route, key) {
    await this.ready;
    const url = new URL(route, 'http://localhost');
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 30));
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null;
    const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : null;
    if (before !== null && after !== null) throw new Error('分页参数冲突');
    let rows, kind, threadId;
    if (url.pathname === '/api/v2/history/threads') {
      rows = [...this.threads.values()].filter((row) => before === null || row.updatedAt < before).sort((a, b) => b.updatedAt - a.updatedAt);
      kind = 'history.thread';
    } else {
      const match = /^\/api\/v2\/history\/threads\/([^/]+)\/items$/.exec(url.pathname);
      if (!match) throw new Error('直连不支持此读取接口');
      threadId = decodeURIComponent(match[1]); kind = 'history.item';
      rows = await this.withItems(this.itemFile(threadId), (values) => [...values.values()]);
      rows = rows.filter((row) => (before === null || row.itemOrder < before) && (after === null || row.itemOrder > after))
        .sort((a, b) => after === null ? b.itemOrder - a.itemOrder : a.itemOrder - b.itemOrder);
    }
    const items = rows.slice(0, limit).map(({ savedAt, ...row }) => {
      const value = decryptJson(this.config.accountKey, { ...row, kind, threadId: threadId || row.id });
      return { ...row, ...encryptJson(key, kind, threadId || row.id, row.id, value) };
    });
    return { items, hasMore: rows.length > limit };
  }
}
module.exports = { DirectHistory };
