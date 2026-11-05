const test = require('node:test');
const assert = require('node:assert/strict');
const { BridgeApi } = require('../src/api');

test('v2 connector uses only account-scoped HTTP and WebSocket routes', () => {
  const api = new BridgeApi({ protocolVersion: 2 });
  assert.equal(api.path('/events'), '/api/v2/events');
  assert.equal(api.path('/history/threads'), '/api/v2/history/threads');
  assert.equal(api.webSocketPath(), '/bridge/v2/ws');
});

test('legacy connector keeps its isolated v1 routes', () => {
  const api = new BridgeApi({ protocolVersion: 1 });
  assert.equal(api.path('/events'), '/api/v1/events');
  assert.equal(api.webSocketPath(), '/bridge/ws');
});
