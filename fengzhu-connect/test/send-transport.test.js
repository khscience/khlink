const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonLineReader, rpcIdFromPrefix } = require('../src/json-line-reader');
const { CodexClient } = require('../src/codex-client');
const { connectHost } = require('../src/codex-host');
const { Connector } = require('../src/connector');
const { DesktopAdapter } = require('../src/desktop-adapter');

test('fragmented large UTF-8 replies are assembled once and subsequent receipts are preserved', () => {
  const lines = [];
  const reader = new JsonLineReader({ onLine: (line) => lines.push(JSON.parse(line)) });
  const content = '中文🙂'.repeat(120000);
  const bytes = Buffer.from(JSON.stringify({ id: 'read', result: { content } }) + '\r\n' + JSON.stringify({ id: 'steer', result: { ok: true } }) + '\n');
  for (let i = 0; i < bytes.length; i += 997) reader.push(bytes.subarray(i, i + 997));
  assert.equal(lines[0].result.content, content);
  assert.deepEqual(lines[1], { id: 'steer', result: { ok: true } });
  assert.equal(reader.bytes, 0); assert.equal(reader.parts.length, 0);
});

test('an over-limit unfinished history line is bounded, rejected once and drained without losing the next ACK', () => {
  const overflow = []; const lines = [];
  const reader = new JsonLineReader({ maxBytes: 1024, onLine: (line) => lines.push(JSON.parse(line)), onOverflow: (info) => overflow.push(info) });
  reader.push('{"jsonrpc":"2.0","id":"old-read","result":{"content":"');
  for (let i = 0; i < 10000; i++) {
    reader.push('x'.repeat(4096));
    assert.ok(reader.bytes <= 1024); assert.equal(reader.parts.length, 0);
  }
  reader.push('"}}\n{"id":"send","result":{"ok":true}}\n');
  assert.equal(overflow.length, 1); assert.equal(rpcIdFromPrefix(overflow[0].prefix), 'old-read');
  assert.deepEqual(lines, [{ id: 'send', result: { ok: true } }]);
  assert.equal(reader.discarding, false);
});

test('oversized reply IDs come from the RPC object, never from nested user/tool content', () => {
  assert.equal(rpcIdFromPrefix('{"result":{"id":7,"text":"x"},"id":12,"tail":'), 12);
  assert.equal(rpcIdFromPrefix('{"result":{"id":7,"text":"x'), undefined);
  assert.equal(rpcIdFromPrefix('{"type":"rpc","message":{"jsonrpc":"2.0","id":"abc","result":', true), 'abc');
  assert.equal(rpcIdFromPrefix('{"id":55,"other":{"id":7},"message":{"result":{"id":4}}}', true), undefined);
});

function client() {
  const self = new CodexClient({}); self.mode = 'host'; self.host = new EventEmitter(); self.host.closed = false;
  return self;
}

test('a synchronous protocol ACK cannot race pending registration', async () => {
  const self = client(); self.host.send = (request) => self.onMessage({ id: request.id, result: { accepted: true } });
  assert.deepEqual(await self.request('turn/steer', {}, 100), { accepted: true });
  assert.equal(self.pending.size, 0);
});

test('transport timeout distinguishes pre-send failure, read timeout and an uncertain write', async () => {
  const self = client(); self.host.send = () => {};
  await assert.rejects(self.request('turn/steer', {}, 5), (error) => error.delivery === 'uncertain' && error.code === 'rpc_timeout');
  await assert.rejects(self.request('thread/turns/list', {}, 5), (error) => error.delivery === 'not_sent');
  self.host.send = () => { throw new Error('socket already closed'); };
  await assert.rejects(self.request('turn/start'), (error) => error.delivery === 'not_sent');
  assert.equal(self.pending.size, 0);
});

test('a previous connector reply cannot acknowledge a new connector request', async () => {
  const old = client(); const current = client(); let oldId;
  old.host.send = (request) => { oldId = request.id; old.onMessage({ id: oldId, result: {} }); };
  await old.request('thread/read');
  current.host.send = (request) => {
    current.onMessage({ id: oldId, result: { wrong: true } });
    assert.equal(current.pending.size, 1);
    current.onMessage({ id: request.id, result: { correct: true } });
  };
  assert.deepEqual(await current.request('turn/steer'), { correct: true });
});

test('oversized direct history replies leave the write channel usable and retain RPC delivery metadata', async () => {
  const self = client(); self.reader.maxBytes = 150;
  self.host.send = (request) => {
    if (request.method === 'thread/read') {
      self.onData(JSON.stringify({ id: request.id, result: { content: 'x'.repeat(1000) } }) + '\n');
    } else self.onData(JSON.stringify({ id: request.id, result: { ok: true } }) + '\n');
  };
  await assert.rejects(self.request('thread/read'), (error) => error.code === 'rpc_response_too_large' && error.delivery === 'not_sent');
  assert.deepEqual(await self.request('turn/steer'), { ok: true });
});

test('ready and replayed approval in the same TCP packet survive reconnect', async () => {
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.write('{"type":"ready","initialized":true}\n{"type":"rpc","message":{"id":"approval-1","method":"item/commandExecution/requestApproval","params":{}}}\n'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const transport = await connectHost({ port: server.address().port, token: 'test-only' });
  try {
    const message = await new Promise((resolve) => transport.once('message', resolve));
    assert.equal(message.id, 'approval-1'); assert.equal(transport.state.initialized, true);
  } finally { transport.close(); await new Promise((resolve) => server.close(resolve)); }
});

function connector() {
  const self = Object.create(Connector.prototype);
  self.threadState = new Map(); self.desktopStatuses = new Map(); self.mobileOwnedThreads = new Set();
  self.events = []; self.emit = (...event) => self.events.push(event); self.log = () => {};
  self.resolveAttachments = () => []; self.currentRolloutOffset = () => 0;
  const items = [];
  self.followups = { items, get: (id) => items.find((row) => row.id === id), add: (row) => { items.push(row); return row; },
    update: (id, changes) => { const row = items.find((row) => row.id === id); return row && Object.assign(row, changes); },
    remove: (id) => { const i = items.findIndex((row) => row.id === id); if (i >= 0) items.splice(i, 1); } };
  return self;
}

test('steering after reload fetches only the newest turn status, without any history items', async () => {
  const self = connector(); const calls = [];
  self.codex = { request: async (method, params) => { calls.push([method, params]); return { data: [{ id: 'active-1', status: 'inProgress', items: [] }] }; } };
  assert.equal(await self.activeTurnId('long-conversation'), 'active-1');
  assert.deepEqual(calls, [['thread/turns/list', { threadId: 'long-conversation', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }]]);
  assert.equal(await self.activeTurnId('long-conversation'), 'active-1'); assert.equal(calls.length, 1);
});

test('a KH Link-managed running turn uses the protocol rather than Desktop UI steering', async () => {
  const self = connector(); self.threadOwnership = { get: () => ({ owner: 'khlink' }) };
  self.desktopStatuses.set('managed', 'desktop_running'); self.threadState.set('managed', { activeTurnId: 'turn-1' });
  self.desktopAdapter = { dispatch: () => assert.fail('must not focus Desktop') };
  const calls = [];
  self.codex = { ready: true, request: async (method, params) => { calls.push([method, params]); return { accepted: true }; } };
  const result = await self.command({ requestId: 'new-direction', action: 'turn.steer', args: { threadId: 'managed', text: 'next' } }, 'phone');
  assert.equal(result.accepted, true); assert.equal(calls[0][0], 'turn/steer');
  assert.equal(self.followups.get('new-direction').state, 'started');
});

test('a preflight read timeout is failed before writing, but a lost steer ACK remains uncertain without resend', async () => {
  for (const afterWrite of [false, true]) {
    const self = connector(); self.threadOwnership = { get: () => ({ owner: 'khlink' }) };
    if (afterWrite) self.threadState.set('managed', { activeTurnId: 'turn-1' });
    let writes = 0;
    self.codex = { ready: true, request: async (method) => {
      if (method === 'turn/steer') writes++;
      throw Object.assign(new Error(`${method} timed out`), { delivery: method === 'turn/steer' ? 'uncertain' : 'not_sent' });
    } };
    const payload = { requestId: `failure-${afterWrite}`, action: 'turn.steer', args: { threadId: 'managed', text: 'next' } };
    if (afterWrite) {
      const result = await self.command(payload, 'phone'); assert.equal(result.uncertain, true);
      assert.equal(self.followups.get(payload.requestId).state, 'uncertain');
      await self.command(payload, 'phone'); assert.equal(writes, 1);
    } else {
      await assert.rejects(self.command(payload, 'phone'), /timed out/);
      assert.equal(self.followups.get(payload.requestId).state, 'failed'); assert.equal(writes, 0);
    }
  }
});

test('recent history uses metadata plus a bounded display page rather than full hydration', async () => {
  const self = connector(); const calls = [];
  self.codex = { request: async (method, params) => { calls.push([method, params]);
    return method === 'thread/read' ? { thread: { id: 'long' } } : { data: [{ id: 'new' }, { id: 'old' }], nextCursor: 'page-2' }; } };
  const result = await self.readRecentCodexThread('long');
  assert.deepEqual(result.thread.turns.map((turn) => turn.id), ['old', 'new']); assert.equal(result.nextCursor, 'page-2');
  assert.equal(calls[0][1].includeTurns, false); assert.equal(calls[1][1].limit, 10);
});

test('a rejected background write followed by a lost queue ACK cannot repeat queue/add', async () => {
  const self = connector(); self.followupBlocking = () => true;
  self.confirmCodexHostThread = async () => false; self.threadOwnership = { get: () => ({ owner: 'unknown' }) };
  self.desktopAdapter = { probe: async () => ({ code: 'other_task' }) };
  self.markDesktopThread = () => {};
  self.executeQueuedBackgroundTurn = async () => { throw new Error('Thread is already opened in another application'); };
  let writes = 0;
  self.codex = { request: async (method) => { assert.equal(method, 'thread/queue/add'); writes++;
    throw Object.assign(new Error('queue/add timed out after write'), { delivery: 'uncertain' }); } };
  const item = self.followups.add({ id: 'queue-ack', requestId: 'queue-ack', threadId: 'desktop', state: 'pending', mode: 'queue', text: 'once', createdAt: Date.now() });
  const result = await self.dispatchFollowup(item);
  assert.equal(result.state, 'uncertain'); assert.equal(result.queueTransport, 'codex'); assert.equal(writes, 1);
  await self.dispatchFollowup(item); assert.equal(writes, 1);
});

test('a local queued message can immediately steer a managed turn, and a concurrent queue probe cannot send it again', async () => {
  const self = connector(); self.threadOwnership = { get: () => ({ owner: 'khlink' }) };
  self.threadState.set('managed', { activeTurnId: 'turn-1' });
  let releaseProbe; self.confirmCodexHostThread = () => new Promise((resolve) => { releaseProbe = resolve; });
  let releaseWrite; let writes = 0;
  self.codex = { ready: true, request: async (method) => { assert.equal(method, 'turn/steer'); writes++;
    return new Promise((resolve) => { releaseWrite = resolve; }); } };
  const item = self.followups.add({ id: 'pending', requestId: 'pending', threadId: 'managed', state: 'pending', mode: 'queue', text: 'next', createdAt: Date.now() });
  const dispatch = self.dispatchFollowup(item);
  const steer = self.steerFollowup(item.id, 'phone', 'managed');
  await new Promise((resolve) => setImmediate(resolve));
  releaseProbe(false); await dispatch; assert.equal(writes, 1);
  releaseWrite({ accepted: true }); assert.equal((await steer).accepted, true);
  assert.equal(self.followups.get(item.id), undefined);
});

test('Desktop queue controls match the marked protocol text including attachment context', async () => {
  const adapter = new DesktopAdapter(); const calls = [];
  adapter.call = async (request) => { calls.push(request); return { ok: true }; };
  const item = { id: 'q', threadId: 'desktop', requestId: 'req', displayText: 'check file', queueTransport: 'codex',
    codexQueueText: 'check file\nAttached file: report.txt\n\n[KH_LINK_REQUEST_ID:req]' };
  await adapter.steer(item); await adapter.cancel(item);
  assert.equal(calls[0].text, item.codexQueueText); assert.equal(calls[1].text, item.codexQueueText);
  await adapter.steer({ ...item, queueTransport: undefined, codexQueueText: undefined });
  assert.equal(calls[2].text, 'check file');
});

test('a protocol completion cannot flash back to running when an older watcher read returns', () => {
  const self = connector(); self.desktopStatuses.set('managed', 'completed'); self.desktopStatusAt = new Map();
  self.rememberProtocolTerminalTurn('managed', 'finished-turn');
  const old = { statusTurnId: 'finished-turn', turnStartTurnId: 'finished-turn', turnStartMarker: { at: 10, ordinal: 5 } };
  assert.equal(self.publishRolloutStatus('managed', 'mobile_running', 'file', old), false);
  assert.equal(self.desktopStatuses.get('managed'), 'completed');
  const next = { ...old, statusTurnId: 'new-turn', turnStartTurnId: 'new-turn', turnStartMarker: { at: 20, ordinal: 10 } };
  assert.equal(self.publishRolloutStatus('managed', 'mobile_running', 'file', next), true);
  assert.equal(self.desktopStatuses.get('managed'), 'mobile_running');
});

test('a lost native Desktop steer receipt remains durable and a replay never clicks Send twice', async () => {
  const self = connector(); self.desktopStatuses.set('desktop', 'desktop_running');
  let writes = 0;
  self.desktopAdapter = { dispatch: async () => { writes++;
    assert.equal(self.followups.get('native-steer').state, 'dispatching');
    throw Object.assign(new Error('Desktop adapter timed out after invoke'), { delivery: 'uncertain' }); } };
  const payload = { requestId: 'native-steer', action: 'turn.steer', args: { threadId: 'desktop', text: 'once' } };
  const result = await self.command(payload, 'phone');
  assert.equal(result.uncertain, true); assert.equal(self.followups.get(payload.requestId).state, 'uncertain');
  await self.command(payload, 'phone'); assert.equal(writes, 1);
  self.recoverInterruptedFollowups(); assert.equal(self.followups.get(payload.requestId).state, 'uncertain');
});

test('an expired owner lease after reload cannot route a positively loaded host turn into Desktop UI', async () => {
  const self = connector(); self.desktopStatuses.set('managed', 'desktop_running');
  self.threadState.set('managed', { activeTurnId: 'still-active' });
  let owner = { owner: 'unknown' }; self.threadOwnership = { get: () => owner };
  self.claimBridgeThread = () => { owner = { owner: 'khlink' }; };
  self.desktopAdapter = { dispatch: () => assert.fail('host has the real writer') };
  const calls = [];
  self.codex = { mode: 'host', ready: true, request: async (method) => { calls.push(method);
    return method === 'thread/loaded/list' ? { data: ['managed'] } : { accepted: true }; } };
  const result = await self.command({ requestId: 'reloaded', action: 'turn.steer', args: { threadId: 'managed', text: 'next' } }, 'phone');
  assert.equal(result.accepted, true); assert.deepEqual(calls, ['thread/loaded/list', 'turn/steer']);
});

test('an old parser upgrades only after actual loaded host tasks are confirmed idle, including after reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-stream-update-'));
  try {
    const bin = path.join(root, 'fake-codex.cmd'); fs.writeFileSync(bin, 'fake test binary');
    const configFile = path.join(root, 'config.json');
    fs.writeFileSync(path.join(root, 'codex-host.json'), JSON.stringify({ version: 2, bin }));
    for (const status of ['active', 'idle', 'unresponsive']) {
      const self = connector(); self.config = { configFile, codexBin: bin }; self.writeStatus = () => {};
      let restarts = 0;
      self.codex = { mode: 'host', ready: true, pending: new Map(), restart: async () => { restarts++; }, request: async (method) => {
        if (status === 'unresponsive') throw new Error('read timed out');
        return method === 'thread/loaded/list' ? { data: ['owned'] } : { thread: { id: 'owned', status: { type: status } } };
      } };
      assert.equal(await self.followDesktopCodex(), status === 'idle');
      assert.equal(restarts, status === 'idle' ? 1 : 0);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
