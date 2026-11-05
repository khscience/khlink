const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readConversationActivityAt } = require('../src/codex-activity');
const { Connector } = require('../src/connector');
const { ready, decryptJson } = require('../src/crypto');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-activity-'));
  const file = path.join(root, 'rollout.jsonl');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(root); });
  const append = (time, type, payload) => fs.appendFileSync(file, JSON.stringify({ timestamp: new Date(time).toISOString(), type, payload }) + '\n');
  const old = Date.now() - 3 * 86400000;
  append(old, 'event_msg', { type: 'task_complete' });
  append(Date.now(), 'event_msg', { type: 'thread_settings_applied' });
  return { file, append, old };
}

test('settings and injected context do not become chat activity, while a new turn does', (t) => {
  const { file, append, old } = fixture(t);
  assert.equal(readConversationActivityAt(file), old);
  append(Date.now(), 'response_item', { type: 'message', role: 'user', content: [{ text: '<environment_context>updated</environment_context>' }] });
  assert.equal(readConversationActivityAt(file), old);
  const started = Date.now();
  append(started, 'event_msg', { type: 'task_started' });
  assert.equal(readConversationActivityAt(file), started);
  assert.equal(readConversationActivityAt(file + '.missing'), null);
});

test('uses the latest rollout timestamp when the Windows mtime is stale', (t) => {
  const { file, append } = fixture(t);
  const latest = Date.now();
  append(latest, 'event_msg', { type: 'task_started' });
  const old = new Date(latest - 30 * 60_000);
  fs.utimesSync(file, old, old);
  assert.equal(readConversationActivityAt(file), latest);
});

test('metadata uploads repair a settings-bumped date without dropping title or pins', async (t) => {
  await ready();
  const { file, old } = fixture(t);
  const connector = Object.create(Connector.prototype);
  connector.config = { accountKey: Buffer.alloc(32) };
  let value;
  connector.api = { path: p => p, request: async (_p, { body }) => {
    value = decryptJson(connector.config.accountKey, { ...body, kind: 'history.thread', threadId: body.id });
  } };
  await connector.syncThreadMetadata({ id: 'test', path: file, name: 'renamed', updatedAt: Date.now(), _fengzhuPinned: true, _fengzhuPinOrder: 0 }, false);
  assert.equal(value.updatedAt, old);
  assert.equal(value.activityAt, old);
  assert.equal(value.title, 'renamed');
  assert.equal(value.pinned, true);
});

test('loading an old active task after a settings change does not invent a new turn', (t) => {
  const { file } = fixture(t);
  const connector = Object.create(Connector.prototype);
  const events = [];
  connector.publishThreadStatus = (...args) => events.push(args);
  connector.reconcileDesktopThreadStatus({ id: 'old', path: file, updatedAt: Date.now(), status: 'active' }, true);
  assert.deepEqual(events, []);
});
