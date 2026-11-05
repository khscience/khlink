const test = require('node:test');
const assert = require('node:assert/strict');
const { Connector, contextCompactionStatus } = require('../src/connector');

// Codex compacts the context on its own. The phone shows a line while it runs,
// from the item lifecycle the app-server sends for the connector's own turns.
test('reads Codex compaction items and the legacy compacted notification', () => {
  const item = { type: 'contextCompaction', id: 'compaction-1' };
  assert.equal(contextCompactionStatus('item/started', { threadId: 't', turnId: 'u', item }), 'started');
  assert.equal(contextCompactionStatus('item/completed', { threadId: 't', turnId: 'u', item }), 'completed');
  assert.equal(contextCompactionStatus('item/completed', { threadId: 't', item: { ...item, status: 'failed' } }), 'failed');
  assert.equal(contextCompactionStatus('thread/compacted', { threadId: 't', turnId: 'u' }), 'completed');
  // Other items and notifications are not compactions.
  assert.equal(contextCompactionStatus('item/started', { item: { type: 'commandExecution', id: 'c' } }), null);
  assert.equal(contextCompactionStatus('item/completed', { item: { type: 'agentMessage', id: 'm' } }), null);
  assert.equal(contextCompactionStatus('turn/started', null), null);
  // The older method-name forms keep working.
  assert.equal(contextCompactionStatus('thread/compaction/started'), 'started');
});

function connectorFor(threadId) {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map();
  connector.desktopStatusAt = new Map();
  connector.mobileOwnedThreads = new Set([threadId]);
  connector.isBridgeOwnedThread = () => false;
  connector.connectorRunsThread = () => false;
  connector.log = () => {};
  const emitted = [];
  connector.emit = (kind, id, value) => emitted.push([kind, id, value.status ?? null]);
  return { connector, emitted };
}

test('a compaction that starts shows the compacting status and no context event', () => {
  const threadId = 'thread-compacting-1';
  const { connector, emitted } = connectorFor(threadId);
  connector.publishThreadStatus(threadId, 'mobile_running');
  connector.noteCodexCompaction(threadId, 'started', { threadId, turnId: 'turn-1' });
  assert.equal(connector.desktopStatuses.get(threadId), 'mobile_compacting');
  assert.deepEqual(emitted, [
    ['thread.status', threadId, 'mobile_running'],
    ['thread.status', threadId, 'mobile_compacting'],
  ]);
});

test('a finished or failed compaction lifts the line and leaves the turn running', () => {
  const threadId = 'thread-compacting-2';
  const { connector, emitted } = connectorFor(threadId);
  connector.publishThreadStatus(threadId, 'mobile_compacting');
  connector.noteCodexCompaction(threadId, 'completed', { threadId, turnId: 'turn-2' });
  assert.equal(connector.desktopStatuses.get(threadId), 'mobile_running');
  connector.noteCodexCompaction(threadId, 'failed', { threadId, turnId: 'turn-2' });
  // A failed compaction does not end the turn: no failed status is published.
  assert.equal(connector.desktopStatuses.get(threadId), 'mobile_running');
  assert.deepEqual(emitted, [
    ['thread.status', threadId, 'mobile_compacting'],
    ['context.compaction', threadId, 'completed'],
    ['thread.status', threadId, 'mobile_running'],
    ['context.compaction', threadId, 'failed'],
  ]);
});
