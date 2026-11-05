const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FollowupStore } = require('../src/followup-store');

test('old persisted protocol queue receipts remain waiting regardless of the recent-list busy flag', () => {
  const { publicItem } = require('../src/followup-store');
  const queued = { id: 'queued', state: 'desktop_queued', queueTransport: 'codex', blocking: false };
  assert.equal(publicItem(queued).blocking, true);
  assert.equal(publicItem({ ...queued, state: 'started', queueRequested: true }).blocking, false);
  assert.equal(publicItem({ ...queued, state: 'steered', queueRequested: true }).blocking, false);
  assert.equal(publicItem({ state: 'pending', blocking: false, queueRequested: true }).blocking, true);
});

test('retries a transient Windows rename lock without rejecting a queued message', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-followups-'));
  const file = path.join(directory, 'followups.dat');
  const originalRename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (source, target) => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('file temporarily locked'); error.code = 'EPERM'; throw error;
    }
    return originalRename(source, target);
  };
  try {
    const store = new FollowupStore(file);
    assert.doesNotThrow(() => store.add({
      id: 'queued-1', requestId: 'queued-1', threadId: 'task-1', text: 'stress', state: 'pending', createdAt: Date.now(),
    }));
    assert.equal(attempts, 3);
    assert.equal(store.lastSaveError, null);
    assert.equal(new FollowupStore(file).items[0].text, 'stress');
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('defers a persistent rename lock instead of surfacing a send failure', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-followups-'));
  const file = path.join(directory, 'followups.dat');
  const originalRename = fs.renameSync;
  const errors = [];
  fs.renameSync = () => { const error = new Error('file locked'); error.code = 'EPERM'; throw error; };
  try {
    const store = new FollowupStore(file); store.onSaveError = (error) => errors.push(error);
    assert.doesNotThrow(() => store.add({
      id: 'queued-2', requestId: 'queued-2', threadId: 'task-1', text: 'deferred', state: 'pending', createdAt: Date.now(),
    }));
    assert.equal(store.items.length, 1);
    assert.equal(errors.length, 1);
    assert.ok(store.lastSaveError);
    clearTimeout(store.saveRetryTimer);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('matches a pure-image rollout by its durable request id in the local image path', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-followups-image-'));
  try {
    const store = new FollowupStore(path.join(directory, 'followups.dat'));
    const requestId = '01234567-89ab-cdef-0123-456789abcdef';
    store.add({ id: requestId, requestId, threadId: 'task-1', text: '[KH Link 图片附件] photo.png', displayText: '', state: 'pending', createdAt: Date.now() });
    const matched = store.matchStartedByLocalImagePaths('task-1', [`C:\\Temp\\uploads\\${requestId}-photo.png`]);
    assert.equal(matched.requestId, requestId);
    assert.equal(store.items.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('historical replay cannot consume a newer queued message with the same text', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-followups-replay-'));
  try {
    const store = new FollowupStore(path.join(directory, 'followups.dat'));
    const now = Date.now();
    store.add({ id: 'queued-new', requestId: 'queued-new', threadId: 'task-1', text: '继续处理', displayText: '继续处理', state: 'pending', createdAt: now });
    assert.equal(store.matchStarted('task-1', '继续处理', now - 60_000), null);
    assert.equal(store.items.length, 1);
    assert.equal(store.matchStarted('task-1', '继续处理', now + 1_000).requestId, 'queued-new');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the request id rides along invisibly and still matches the started turn exactly', () => {
  const { withRequestMarker, requestMarkerId, stripRequestMarker } = require('../src/request-marker');
  const id = '11111111-1111-4111-8111-111111111111';
  const text = withRequestMarker('请继续', id);
  assert.equal(text.includes('KH_LINK_REQUEST_ID'), false);
  assert.equal(stripRequestMarker(text), '请继续');
  assert.equal(requestMarkerId(text), id);
  assert.equal(requestMarkerId(`请继续\n\n[KH_LINK_REQUEST_ID:${id}]`), id);
  assert.equal(stripRequestMarker(`请继续\n\n[KH_LINK_REQUEST_ID:${id}]`), '请继续');
  assert.equal(withRequestMarker('x', 'req'), 'x\n\n[KH_LINK_REQUEST_ID:req]');
});

test('an answer to a Codex question is sent without a request id, exactly as Codex Desktop sends it', () => {
  const { withRequestMarker } = require('../src/request-marker');
  const reply = '<send_user_message_question_reply>\n[{"questionItemId":"x","question":"q","answer":"a"}]\n</send_user_message_question_reply>';
  assert.equal(withRequestMarker(reply, '11111111-1111-4111-8111-111111111111'), reply);
});

test('an older failed immediate answer exposes its original pending queue row on reconnect', () => {
  const { publicItem } = require('../src/followup-store');
  const item = { id: 'answer', state: 'desktop_queued', blocking: false, steerRequested: true, reason: 'lookup failed' };
  assert.equal(publicItem(item).blocking, true);
  assert.equal(publicItem({ ...item, reason: null }).blocking, false);
  assert.equal(publicItem({ ...item, state: 'started', steerRequested: false }).blocking, false);
});
