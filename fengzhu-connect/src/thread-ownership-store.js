'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STORE_VERSION = 1;
const OWNERS = new Set(['khlink', 'desktop', 'unknown']);
const BRIDGE_LEASE_MS = 2 * 60_000;
const BRIDGE_LEASE_RENEW_THRESHOLD_MS = 30_000;

class ThreadOwnershipStore {
  constructor(file, options = {}) {
    this.file = file;
    this.keepLease = typeof options.keepLease === 'function' ? options.keepLease : null;
    this.records = new Map();
    this.lastSaveError = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const rows = Array.isArray(raw?.threads) ? raw.threads : [];
      for (const row of rows) {
        const normalized = normalizeRecord(row);
        if (normalized) this.records.set(normalized.threadId, normalized);
      }
    } catch {
      // A missing or malformed ownership file must not prevent the connector
      // from starting. The writer lock and protocol response remain the final
      // safety boundary; this file is a durable routing hint only.
      this.records.clear();
    }
    return this.records;
  }

  get(threadId) {
    const id = normalizeThreadId(threadId);
    if (!id) return null;
    this.expireLeases();
    const record = this.records.get(id);
    if (!record) return null;
    return { ...record };
  }

  list() {
    this.expireLeases();
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  expireLeases() {
    const now = Date.now();
    let changed = false;
    for (const record of this.records.values()) {
      // A connector restart can observe its own previously persisted lease
      // after the old process crossed the expiry boundary. If the same
      // persistent Codex host PID is still alive, the record is recoverable;
      // otherwise it remains unknown and will be re-probed normally.
      if (record.owner === 'unknown' && record.source === 'lease' && this.keepLease?.({ ...record })) {
        record.owner = 'khlink';
        record.source = 'bridge_recovered';
        record.reason = null;
        record.leaseExpiresAt = now + BRIDGE_LEASE_MS;
        record.stateVersion = Math.max(0, Number(record.stateVersion) || 0) + 1;
        record.updatedAt = now;
        changed = true;
        continue;
      }
      if (record.owner !== 'khlink' || !record.leaseExpiresAt) continue;
      // A persistent Codex host is the writer for every KH Link-managed task.
      // Its per-thread lock is expected to remain open while the connector is
      // alive, so an idle two-minute lease must not turn that lock into a
      // false Desktop ownership report. The connector supplies a PID-aware
      // guard; only it can renew the lease.
      if (this.keepLease?.({ ...record })) {
        if (record.leaseExpiresAt - now <= BRIDGE_LEASE_RENEW_THRESHOLD_MS) {
          record.leaseExpiresAt = now + BRIDGE_LEASE_MS;
          record.updatedAt = now;
          changed = true;
        }
        continue;
      }
      if (record.leaseExpiresAt > now) continue;
      record.owner = 'unknown';
      record.source = 'lease';
      record.reason = 'khLink lease expired';
      record.leaseExpiresAt = null;
      record.stateVersion = Math.max(0, Number(record.stateVersion) || 0) + 1;
      record.updatedAt = now;
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  set(threadId, owner, changes = {}) {
    const id = normalizeThreadId(threadId);
    const nextOwner = normalizeOwner(owner);
    if (!id) throw new Error('threadId is required');
    const previous = this.records.get(id) || {};
    const record = normalizeRecord({
      ...previous,
      ...changes,
      threadId: id,
      owner: nextOwner,
      stateVersion: Number(previous.stateVersion || 0) + 1,
      updatedAt: Date.now(),
    });
    this.records.set(id, record);
    this.save();
    return { ...record };
  }

  claim(threadId, changes = {}) {
    return this.set(threadId, 'khlink', {
      ...changes,
      source: changes.source || 'mobile',
      leaseExpiresAt: Number(changes.leaseExpiresAt) > Date.now()
        ? Number(changes.leaseExpiresAt)
        : Date.now() + BRIDGE_LEASE_MS,
    });
  }

  markDesktop(threadId, changes = {}) {
    return this.set(threadId, 'desktop', { ...changes, source: changes.source || 'probe', leaseExpiresAt: null });
  }

  release(threadId, changes = {}) {
    return this.set(threadId, 'unknown', { ...changes, source: changes.source || 'release', leaseExpiresAt: null });
  }

  remove(threadId) {
    const id = normalizeThreadId(threadId);
    if (!id || !this.records.has(id)) return false;
    this.records.delete(id);
    this.save();
    return true;
  }

  save() {
    let temporary = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({
        version: STORE_VERSION,
        threads: [...this.records.values()].map((record) => ({ ...record })),
      }, null, 2), { mode: 0o600 });
      renameWithTransientRetry(temporary, this.file);
      this.lastSaveError = null;
      return true;
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      this.lastSaveError = error;
      return false;
    }
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
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 20 * (attempt + 1));
    }
  }
}

function normalizeThreadId(value) {
  const id = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : '';
}

function normalizeOwner(value) {
  const owner = String(value || '').trim().toLowerCase();
  return OWNERS.has(owner) ? owner : 'unknown';
}

function normalizeRecord(value) {
  const threadId = normalizeThreadId(value?.threadId);
  if (!threadId) return null;
  const owner = normalizeOwner(value?.owner);
  const hostPid = Number(value?.hostPid);
  return {
    threadId,
    owner,
    source: String(value?.source || '').trim() || null,
    reason: String(value?.reason || '').trim() || null,
    bridgeId: String(value?.bridgeId || '').trim() || null,
    hostPid: Number.isInteger(hostPid) && hostPid > 0 ? hostPid : null,
    leaseExpiresAt: Number.isFinite(Number(value?.leaseExpiresAt)) && Number(value.leaseExpiresAt) > 0
      ? Number(value.leaseExpiresAt)
      : null,
    stateVersion: Math.max(0, Number(value?.stateVersion) || 0),
    updatedAt: Number(value?.updatedAt) || Date.now(),
  };
}

module.exports = { ThreadOwnershipStore, normalizeOwner, normalizeThreadId };
