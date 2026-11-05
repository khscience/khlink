'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ThreadOwnershipStore } = require('../src/thread-ownership-store');

const THREAD_ID = '01a031a3-ef84-7da0-84f2-221815841a7b';

test('persists and reloads bridge ownership without storing secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-ownership-'));
  const file = path.join(dir, 'thread-ownership.json');
  const first = new ThreadOwnershipStore(file);
  const claimed = first.claim(THREAD_ID, { source: 'mobile', bridgeId: 'bridge-test', hostPid: 42 });

  assert.equal(claimed.owner, 'khlink');
  assert.equal(claimed.threadId, THREAD_ID);
  assert.equal(claimed.hostPid, 42);

  const second = new ThreadOwnershipStore(file);
  assert.deepEqual(second.get(THREAD_ID), claimed);
  assert.equal(fs.readFileSync(file, 'utf8').includes('accountKey'), false);
});

test('desktop probe can replace an advisory bridge record and release returns unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-ownership-'));
  const store = new ThreadOwnershipStore(path.join(dir, 'thread-ownership.json'));

  store.claim(THREAD_ID);
  const desktop = store.markDesktop(THREAD_ID, { reason: 'active writer' });
  assert.equal(desktop.owner, 'desktop');
  assert.equal(desktop.reason, 'active writer');

  const released = store.release(THREAD_ID, { reason: 'writer released' });
  assert.equal(released.owner, 'unknown');
  assert.equal(released.reason, 'writer released');
});

test('invalid thread IDs are ignored when loading and rejected when writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-ownership-'));
  const file = path.join(dir, 'thread-ownership.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, threads: [{ threadId: 'bad', owner: 'khlink' }] }));
  const store = new ThreadOwnershipStore(file);
  assert.equal(store.list().length, 0);
  assert.throws(() => store.claim('bad'), /threadId is required/);
});

test('an expired KH Link lease falls back to unknown ownership', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-ownership-'));
  const store = new ThreadOwnershipStore(path.join(dir, 'thread-ownership.json'));
  store.set(THREAD_ID, 'khlink', { leaseExpiresAt: Date.now() - 1 });
  const expired = store.get(THREAD_ID);
  assert.equal(expired.owner, 'unknown');
  assert.match(expired.reason, /lease expired/);
  assert.equal(expired.leaseExpiresAt, null);
  assert.equal(store.list()[0].owner, 'unknown');
});

test('an expired lease is renewed while the same persistent Codex host is alive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-ownership-'));
  const store = new ThreadOwnershipStore(path.join(dir, 'thread-ownership.json'), {
    keepLease: (record) => record.hostPid === 42,
  });
  store.set(THREAD_ID, 'khlink', { hostPid: 42, leaseExpiresAt: Date.now() - 1 });

  const recovered = store.get(THREAD_ID);
  assert.equal(recovered.owner, 'khlink');
  assert.equal(recovered.hostPid, 42);
  assert.ok(recovered.leaseExpiresAt > Date.now());
});

test('a previously expired record is recovered when the same host reconnects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-ownership-'));
  const file = path.join(dir, 'thread-ownership.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, threads: [{
    threadId: THREAD_ID,
    owner: 'unknown',
    source: 'lease',
    reason: 'KH Link lease expired',
    hostPid: 42,
    leaseExpiresAt: null,
    stateVersion: 3,
  }] }));
  const store = new ThreadOwnershipStore(file, { keepLease: (record) => record.hostPid === 42 });

  const recovered = store.get(THREAD_ID);
  assert.equal(recovered.owner, 'khlink');
  assert.equal(recovered.source, 'bridge_recovered');
  assert.equal(recovered.reason, null);
  assert.ok(recovered.leaseExpiresAt > Date.now());
});
