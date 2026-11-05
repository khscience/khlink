const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { Connector } = require('../src/connector');

class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = WebSocket.CONNECTING; this.pings = 0; this.terminated = false; }
  ping() { this.pings += 1; }
  terminate() { this.terminated = true; this.readyState = WebSocket.CLOSED; this.emit('close', 1006, Buffer.alloc(0)); }
  open() { this.readyState = WebSocket.OPEN; this.emit('open'); }
}

function connectorWithFakeSockets() {
  const connector = Object.create(Connector.prototype);
  const sockets = [];
  connector.stopping = false;
  connector.reconnectMs = 1000;
  connector.config = { serverUrl: 'https://relay.example/bridge', deviceName: 'Desktop' };
  connector.api = { token: async () => 'token', webSocketPath: () => '/ws' };
  connector.createWebSocket = () => { const ws = new FakeSocket(); sockets.push(ws); return ws; };
  connector.republishActiveThreadStatuses = () => {};
  connector.writeStatus = () => {};
  connector.emit = () => {};
  connector.presencePayload = () => ({});
  connector.onFrame = (raw) => { (connector.frames ||= []).push(raw); };
  connector.reconnects = 0;
  connector.scheduleReconnect = () => { connector.reconnects += 1; };
  connector.log = () => {};
  return { connector, sockets };
}

function stopTimers(connector) {
  clearInterval(connector.heartbeat);
  clearInterval(connector.statusHeartbeat);
}

test('every successful relay reconnect republishes current Claude quota', async () => {
  const { connector, sockets } = connectorWithFakeSockets(); const refreshes = [];
  connector.publishClaudeUsage = force => refreshes.push(force);
  try {
    await connector.connect(); sockets[0].open();
    await connector.connect(); sockets[1].open();
    assert.deepEqual(refreshes, [true, true]);
  } finally { stopTimers(connector); }
});

test('a late close from a replaced socket does not schedule a second reconnect', async () => {
  const { connector, sockets } = connectorWithFakeSockets();
  await connector.connect();
  sockets[0].open();
  await connector.connect();
  sockets[1].open();
  try {
    sockets[0].emit('close', 1006, Buffer.alloc(0));
    assert.equal(connector.reconnects, 0, 'stale socket close must be ignored');
    sockets[0].emit('message', Buffer.from('stale'));
    assert.equal(connector.frames, undefined, 'stale socket frames must be ignored');
    sockets[1].emit('close', 1006, Buffer.alloc(0));
    assert.equal(connector.reconnects, 1);
  } finally { stopTimers(connector); }
});

test('liveness check pings a responsive socket and terminates a silent one', async () => {
  const { connector, sockets } = connectorWithFakeSockets();
  await connector.connect();
  const ws = sockets[0];
  ws.open();
  try {
    const start = connector.lastSocketActivity;
    assert.equal(connector.checkSocketLiveness(ws, start + 25_000), 'pinged');
    assert.equal(ws.pings, 1);
    ws.emit('pong');
    assert.ok(connector.lastSocketActivity >= start);
    connector.lastSocketActivity = start;
    assert.equal(connector.checkSocketLiveness(ws, start + 71_000), 'terminated');
    assert.equal(ws.terminated, true);
    assert.equal(connector.reconnects, 1, 'terminating the silent socket reconnects through the close handler');
  } finally { stopTimers(connector); }
});

test('incoming frames count as activity so a busy socket is never terminated', async () => {
  const { connector, sockets } = connectorWithFakeSockets();
  await connector.connect();
  const ws = sockets[0];
  ws.open();
  try {
    connector.lastSocketActivity = 0;
    ws.emit('message', Buffer.from('{}'));
    assert.equal(connector.checkSocketLiveness(ws, connector.lastSocketActivity + 60_000), 'pinged');
    assert.deepEqual(connector.frames, ['{}']);
  } finally { stopTimers(connector); }
});

test('an expired refresh token is replaced from config.json written by the desktop console', async () => {
  const { connector, sockets } = connectorWithFakeSockets();
  let calls = 0;
  connector.api = {
    config: { refreshToken: 'old', deviceId: 'd1' },
    accessToken: null, expiresAt: 0,
    webSocketPath: () => '/ws',
    token: async () => {
      calls += 1;
      if (connector.api.config.refreshToken === 'old') throw new Error('401 {"message":"Device revoked or refresh expired"}');
      return 'fresh-access';
    },
  };
  const realReload = Connector.prototype.reloadCredentialsFromDisk;
  connector.reloadCredentialsFromDisk = () => realReload.call(connector, () => ({ refreshToken: 'new', accountId: 'a1', deviceId: 'd1', accountKey: 'k' }));
  await connector.connect();
  try {
    assert.equal(calls, 2);
    assert.equal(sockets.length, 1, 'connected with the reloaded credentials');
    assert.equal(connector.api.config.refreshToken, 'new');
    assert.equal(connector.config.accountId, 'a1');
    assert.equal(connector.authFailed, false);
  } finally { stopTimers(connector); }
});

test('login expiry is reported once and retried once a minute', async () => {
  const { connector } = connectorWithFakeSockets();
  const statuses = []; const logs = [];
  connector.writeStatus = (connected, lifecycle, extra) => statuses.push({ connected, lifecycle, extra });
  connector.log = (error) => logs.push(String(error?.message || error));
  const error = new Error('401 {"message":"Device revoked or refresh expired"}');
  connector.noteConnectFailure(error);
  connector.noteConnectFailure(error);
  assert.equal(connector.authFailed, true);
  assert.equal(statuses.length, 1, 'repeated expiry is not re-reported');
  assert.equal(statuses[0].lifecycle, 'login_required');
  assert.match(logs[0], /login expired/);

  const delays = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { delays.push(ms); return { unref() {} }; };
  try {
    delete connector.scheduleReconnect; // use the real implementation
    connector.scheduleReconnect();
    connector.authFailed = false; connector.reconnectMs = 1000;
    connector.scheduleReconnect();
  } finally { global.setTimeout = realSetTimeout; }
  assert.deepEqual(delays, [60_000, 1000]);

  connector.noteConnectFailure(new Error('fetch failed'));
  assert.equal(statuses.at(-1).lifecycle, 'offline');
});

test('start() survives a failed first connection and keeps retrying', async () => {
  const connector = Object.create(Connector.prototype);
  const calls = [];
  Object.assign(connector, {
    stopping: false, reconnectMs: 1000,
    processLock: { acquire() {}, release() {} },
    codex: { on() {}, start: async () => {} },
    writeStatus: () => {},
    cleanUploads: () => {},
    attachmentStore: { clean() {} },
    connect: async () => { throw new Error('fetch failed'); },
    noteConnectFailure: (error) => calls.push(['failure', error.message]),
    scheduleReconnect: () => calls.push(['reconnect']),
    startRealtimeSync: () => calls.push(['realtime']),
    startSessionWatcher: () => calls.push(['watcher']),
    retryFollowups: async () => {},
  });
  await connector.start(); // must not reject
  clearInterval(connector.followupRetryTimer);
  assert.deepEqual(calls, [['failure', 'fetch failed'], ['reconnect'], ['realtime'], ['watcher']]);
});

test('liveness check ignores sockets that are not current or not open', async () => {
  const { connector, sockets } = connectorWithFakeSockets();
  await connector.connect();
  const first = sockets[0];
  assert.equal(connector.checkSocketLiveness(first, Date.now() + 999_999), 'ignored', 'still connecting');
  first.open();
  await connector.connect();
  try {
    assert.equal(connector.checkSocketLiveness(first, Date.now() + 999_999), 'ignored', 'replaced socket');
    assert.equal(first.terminated, false);
  } finally { stopTimers(connector); }
});
