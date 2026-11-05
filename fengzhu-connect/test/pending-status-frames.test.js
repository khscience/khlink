const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { Connector } = require('../src/connector');
const { ready } = require('../src/crypto');

test('status changes made while the relay is down reach the phone once it is back', async () => {
  await ready();
  const connector = Object.create(Connector.prototype);
  const sent = [];
  connector.config = { accountKey: Buffer.alloc(32, 1) };
  connector.ws = { readyState: WebSocket.CONNECTING, send: (raw) => sent.push(JSON.parse(raw)) };
  connector.send('thread.status', 't1', { threadId: 't1', status: 'desktop_waiting' });
  connector.send('thread.status', 't1', { threadId: 't1', status: 'completed' });
  connector.send('thread.status', 't2', { threadId: 't2', status: 'completed' }, 'phone-1');
  connector.send('agent.event', 't1', { threadId: 't1' });
  assert.equal(sent.length, 0);
  assert.deepEqual([...connector.pendingStatusFrames.keys()], ['t1'], 'only the latest broadcast status per session');
  connector.ws.readyState = WebSocket.OPEN;
  connector.flushPendingStatusFrames();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'thread.status');
  assert.equal(sent[0].threadId, 't1');
  assert.equal(connector.pendingStatusFrames, null);
  connector.flushPendingStatusFrames();
  assert.equal(sent.length, 1, 'sent once');
});
