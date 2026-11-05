const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexBackend, CODEX_CAPABILITIES } = require('../src/backends/codex-backend');
const { DEFAULT_CAPABILITIES } = require('../src/backends/agent-backend');
const { Connector } = require('../src/connector');

// A fake client so the backend can be exercised without spawning Codex.
function fakeClient() {
  const calls = [];
  return {
    calls, ready: true, version: 'codex-cli-test', mode: 'host',
    request: async (method, params, timeout) => { calls.push({ method, params, timeout }); return { ok: method }; },
    start: async () => 'started', stop: async () => 'stopped', restart: async () => 'restarted',
    isAvailable: () => true, on: () => {},
  };
}

test('CodexBackend identity and capabilities', () => {
  const backend = new CodexBackend({}, fakeClient());
  assert.equal(backend.id, 'codex');
  assert.equal(backend.displayName, 'Codex');
  assert.equal(backend.capabilities(), CODEX_CAPABILITIES);
  assert.equal(CODEX_CAPABILITIES.threadQueue, true);
  assert.equal(CODEX_CAPABILITIES.desktopAutomation, true);
  assert.deepEqual(CODEX_CAPABILITIES.permissionModes, ['manual', 'auto', 'yolo']);
  // Default capabilities are the conservative all-off baseline for new backends.
  assert.equal(DEFAULT_CAPABILITIES.threadQueue, false);
  assert.deepEqual(DEFAULT_CAPABILITIES.permissionModes, []);
});

test('CodexBackend neutral operations delegate to the same JSON-RPC', async () => {
  const client = fakeClient();
  const backend = new CodexBackend({}, client);
  await backend.listThreads({ cursor: 1 });
  await backend.startTurn({ threadId: 't1', input: 'hi' }, 24_000);
  await backend.steerTurn({ threadId: 't1' });
  await backend.interruptTurn({ threadId: 't1' });
  await backend.resumeThread('t1', { excludeTurns: true });
  assert.deepEqual(client.calls.map((c) => c.method),
    ['thread/list', 'turn/start', 'turn/steer', 'turn/interrupt', 'thread/resume']);
  assert.equal(client.calls[1].timeout, 24_000);
  assert.deepEqual(client.calls[4].params, { threadId: 't1', excludeTurns: true });
});

test('CodexBackend lifecycle delegates to the client', async () => {
  const client = fakeClient();
  const backend = new CodexBackend({}, client);
  assert.equal(await backend.start(), 'started');
  assert.equal(await backend.restart(), 'restarted');
  assert.equal(backend.ready, true);
  assert.equal(backend.version, 'codex-cli-test');
  assert.equal(backend.isAvailable(), true);
});

test('Connector registers codex as the default backend and routes threads', () => {
  const connector = Object.create(Connector.prototype);
  const backend = new CodexBackend({}, fakeClient());
  connector.backend = backend;
  connector.backends = new Map([[backend.id, backend]]);
  connector.defaultBackendId = backend.id;
  connector.threadState = new Map();
  // Unknown / legacy threads resolve to the default backend.
  assert.equal(connector.threadBackendId('unknown'), 'codex');
  assert.equal(connector.backendForThread('unknown'), backend);
  // A thread tagged with a backendId resolves to it (falls back to default if unregistered).
  connector.threadState.set('t-claude', { backendId: 'claude' });
  assert.equal(connector.threadBackendId('t-claude'), 'claude');
  assert.equal(connector.backendForThread('t-claude'), backend, 'unregistered backend id falls back to default');
});

const { ClaudeBackend, CLAUDE_CAPABILITIES } = require('../src/backends/claude-backend');

// Build a Connector with just enough wired to exercise Claude routing.
function connectorForRouting() {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map();
  connector.config = { workspace: 'C:\work' };
  connector.claudeThreads = new Map();
  connector.saveClaudeThreads = () => {};
  connector.log = () => {};
  connector.resolveAttachments = () => [];
  const calls = [];
  connector.claude = {
    id: 'claude',
    on: () => {}, start: async () => {},
    newThread: (o) => { calls.push(['newThread', o]); return { threadId: 'ct1', workdir: o.workdir }; },
    startTurn: (id, o) => { calls.push(['startTurn', id, o]); return { turnId: 'turn-1' }; },
    steerTurn: (id, o) => { calls.push(['steerTurn', id, o]); return { turnId: 'turn-2' }; },
    interruptTurn: (id) => { calls.push(['interrupt', id]); return true; },
    resolveApproval: (id, rid, ok) => { calls.push(['resolveApproval', id, rid, ok]); return true; },
    answerQuestion: (id, rid, a) => { calls.push(['answerQuestion', id, rid, a]); return true; },
  };
  connector.backend = { id: 'codex' };
  connector.backends = new Map([['codex', { id: 'codex', displayName: 'Codex', capabilities: () => ({}) }], ['claude', { id: 'claude', displayName: 'Claude Code', capabilities: () => CLAUDE_CAPABILITIES }]]);
  connector.defaultBackendId = 'codex';
  connector.emit = () => {};
  return { connector, calls };
}

test('executeCommand routes an explicit Claude creation to the Claude handler', async () => {
  const { connector, calls } = connectorForRouting();
  const res = await connector.executeCommand({ action: 'thread.newWithTurn', args: { backend: 'claude', text: 'hi', title: 'T', model: 'sonnet' } });
  assert.equal(res.backend, 'claude');
  assert.equal(res.threadId, 'ct1');
  assert.equal(connector.threadBackendId('ct1'), 'claude');
  assert.deepEqual(calls[0][0], 'newThread');
  assert.equal(calls[1][0], 'startTurn');
});

test('executeCommand routes turn ops for an existing Claude thread; Codex threads are untouched', async () => {
  const { connector, calls } = connectorForRouting();
  connector.threadState.set('ct1', { backendId: 'claude', model: 'sonnet', permissionMode: 'manual' });
  connector.claudeThreads.set('ct1', { id: 'ct1', model: 'sonnet', approveMode: 'manual' });
  await connector.executeCommand({ action: 'turn.start', args: { threadId: 'ct1', text: 'go' } });
  await connector.executeCommand({ action: 'turn.stop', args: { threadId: 'ct1' } });
  assert.deepEqual(calls.map((c) => c[0]), ['startTurn', 'interrupt']);
  // A codex thread does NOT hit the claude backend.
  connector.threadState.set('cx1', { backendId: 'codex' });
  assert.equal(connector.threadBackendId('cx1'), 'codex');
});

test('backends.capabilities returns the per-backend map', async () => {
  const { connector } = connectorForRouting();
  const res = await connector.executeCommand({ action: 'backends.capabilities', args: {} });
  assert.equal(res.default, 'codex');
  assert.ok(res.backends.codex && res.backends.claude);
  assert.equal(res.backends.claude.displayName, 'Claude Code');
});

const { ready } = require('../src/crypto');

test('legacy (item-persisted) Claude threads keep persisting the user message and items', async () => {
  await ready();
  const { connector } = connectorForRouting();
  const requests = [];
  connector.config = { workspace: 'C:\\work', accountKey: Buffer.alloc(32, 9) };
  connector.api = { path: (p) => p, request: async (p, opts) => { requests.push({ p, ...opts }); return { ok: true }; } };
  connector.threadState.set('ct1', { backendId: 'claude', model: 'sonnet', approveMode: 'manual' });
  connector.claudeThreads.set('ct1', { id: 'ct1', title: 'T', updatedAt: Date.now(), model: 'sonnet', approveMode: 'manual', nextOrder: 3 });
  await connector.executeCommand({ action: 'turn.start', args: { threadId: 'ct1', text: 'hello claude' } });
  // A live 'item' event from the backend is persisted too.
  await connector.persistClaudeItem('ct1', { id: 'i-1', type: 'agentMessage', text: 'hi there', at: Date.now() });
  await new Promise((r) => setImmediate(r)); // let fire-and-forget writes settle
  const itemPuts = requests.filter((r) => r.p === '/history/threads/ct1/items' && r.method === 'PUT');
  assert.ok(itemPuts.length >= 2, 'user message + agent item both persisted');
  // Encrypted payload never leaks plaintext.
  assert.ok(!JSON.stringify(itemPuts).includes('hello claude'));
  assert.ok(!JSON.stringify(itemPuts).includes('hi there'));
  // Distinct order counters keep insertion order.
  const orders = itemPuts.map((r) => r.body.items[0].order);
  assert.deepEqual([...new Set(orders)].length, orders.length, 'each item gets a unique order');
  // Thread index is refreshed so the phone lists the thread.
  assert.ok(requests.some((r) => r.p === '/history/threads' && r.method === 'PUT'));
});

test('resolveApproval routes Claude approvals and questions by backend', () => {
  const { connector, calls } = connectorForRouting();
  connector.threadState.set('ct1', { backendId: 'claude' });
  connector.resolveApproval({ backend: 'claude', threadId: 'ct1', requestId: 'r1', decision: 'accept' });
  connector.resolveApproval({ threadId: 'ct1', requestId: 'q1', answers: { a: 'b' } });
  assert.deepEqual(calls.find((c) => c[0] === 'resolveApproval'), ['resolveApproval', 'ct1', 'r1', true]);
  assert.deepEqual(calls.find((c) => c[0] === 'answerQuestion'), ['answerQuestion', 'ct1', 'q1', { a: 'b' }]);
});

test('after a connector restart, persisted Claude threads still route to Claude and resume', async () => {
  const { ClaudeBackend: RealClaude } = require('../src/backends/claude-backend');
  const { connector } = connectorForRouting();
  const spawns = [];
  const { EventEmitter } = require('node:events');
  connector.claude = new RealClaude({ workspace: 'C:\work' }, { claudeBin: 'claude.exe', spawnFn: (bin, args, opts) => {
    const c = new EventEmitter(); c.exitCode = null; c.killed = false;
    c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {}; c.stderr = new EventEmitter(); c.stderr.setEncoding = () => {};
    c.stdin = { write: () => {} }; c.kill = () => { c.killed = true; c.exitCode = 143; c.emit('exit', 143); };
    spawns.push({ args, opts }); return c;
  } });
  connector._claudeWired = true;
  // Simulate the restart: nothing in threadState, only the persisted index.
  connector.claudeThreads.set('ct9', { id: 'ct9', workdir: 'C:\proj', sessionId: 'sess-9', model: 'opus', effort: 'max', approveMode: 'manual' });
  assert.equal(connector.threadBackendId('ct9'), 'claude');
  await connector.executeCommand({ action: 'turn.start', args: { threadId: 'ct9', text: 'go on' } });
  const a = spawns[0].args;
  assert.equal(a[a.indexOf('--resume') + 1], 'sess-9');
  assert.equal(a[a.indexOf('--effort') + 1], 'max');
  // Settings round-trip: '' resets model to the CLI default.
  const res = await connector.executeCommand({ action: 'settings.set', args: { threadId: 'ct9', settings: { model: '', effort: 'low', permissionMode: 'auto' } } });
  assert.deepEqual([res.model, res.effort, res.permissionMode, res.backend], ['', 'low', 'auto', 'claude']);
  const read = await connector.executeCommand({ action: 'thread.settings.read', args: { threadId: 'ct9' } });
  assert.equal(read.effort, 'low');
  await connector.claude.stop();
});

function claudeQueueHarness() {
  const { ClaudeBackend: RealClaude } = require('../src/backends/claude-backend');
  const { EventEmitter } = require('node:events');
  const { connector } = connectorForRouting();
  const children = [];
  connector.claude = new RealClaude({ workspace: 'C:\work' }, { claudeBin: 'claude.exe', spawnFn: () => {
    const c = new EventEmitter(); c.exitCode = null; c.killed = false; c.writes = [];
    c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {}; c.stderr = new EventEmitter(); c.stderr.setEncoding = () => {};
    c.stdin = { write: (line) => c.writes.push(JSON.parse(line)) }; c.kill = () => { c.killed = true; c.exitCode = 143; c.emit('exit', 143); };
    children.push(c); return c;
  } });
  connector._claudeWired = false;
  const frames = [];
  connector.emit = (kind, threadId, payload) => frames.push({ kind, threadId, payload });
  // Any use of the Codex follow-up store or the Desktop adapter is a bug for Claude threads.
  const forbidden = () => { throw new Error('Codex/Desktop queue must not be used for Claude'); };
  connector.followups = { get: forbidden, add: forbidden, list: forbidden, update: forbidden };
  connector.desktopAdapter = { probe: forbidden, sendInstruction: forbidden };
  connector.claudeThreads.set('cq1', { id: 'cq1', workdir: 'C:\proj', sessionId: null, model: 'sonnet', effort: 'low', approveMode: 'manual' });
  return { connector, children, frames };
}

const userTexts = (child) => child.writes.filter((w) => w.type === 'user').map((w) => w.message.content);

test('Claude queue: instructions sent mid-turn wait, then start when the turn completes', async () => {
  const { connector, children, frames } = claudeQueueHarness();
  await connector.command({ action: 'turn.start', requestId: 'r1', args: { threadId: 'cq1', text: 'first' } });
  assert.deepEqual(userTexts(children[0]), ['first']);
  const queued = await connector.command({ action: 'followup.enqueue', requestId: 'r2', args: { threadId: 'cq1', text: 'second' } });
  assert.equal(queued.queued, true);
  assert.ok(frames.some((f) => f.kind === 'followup.queued' && f.payload.id === 'r2'));
  const listed = await connector.command({ action: 'followup.list', args: {} }).catch(() => null);
  if (listed) assert.ok(listed.items.some((i) => i.id === 'r2'));
  assert.deepEqual(userTexts(children[0]), ['first'], 'not sent while running');
  children[0].emit('exit', 0); // noop guard: still the live child
  children[0].exitCode = null;
  children[0].stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success' }) + '\n');
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.deepEqual(userTexts(children[0]), ['first', 'second']);
  assert.ok(frames.some((f) => f.kind === 'followup.started' && f.payload.id === 'r2'));
  await connector.claude.stop();
});

test('Claude queue: cancel removes a waiting instruction; steer sends it now', async () => {
  const { connector, children, frames } = claudeQueueHarness();
  await connector.command({ action: 'turn.start', requestId: 'a', args: { threadId: 'cq1', text: 'long job' } });
  await connector.command({ action: 'followup.enqueue', requestId: 'b', args: { threadId: 'cq1', text: 'drop me' } });
  await connector.command({ action: 'followup.enqueue', requestId: 'c', args: { threadId: 'cq1', text: 'do this instead' } });
  await connector.command({ action: 'followup.cancel', args: { threadId: 'cq1', id: 'b' } });
  assert.ok(frames.some((f) => f.kind === 'followup.cancelled' && f.payload.id === 'b'));
  await connector.command({ action: 'followup.steer', args: { threadId: 'cq1', id: 'c' } });
  const w = children[0].writes;
  assert.ok(!w.some((x) => x.type === 'control_request' && x.request?.subtype === 'interrupt'), 'send-now is absorbed mid-turn, like typing on the desktop');
  assert.deepEqual(userTexts(children[0]), ['long job', 'do this instead']);
  assert.equal(connector.claudeQueueItems('cq1').length, 0);
  await connector.claude.stop();
});

test('Claude read-only actions the phone sends do not error', async () => {
  const { connector } = claudeQueueHarness();
  assert.equal((await connector.executeCommand({ action: 'history.sync', args: { threadId: 'cq1' } })).queued, false);
  assert.equal((await connector.executeCommand({ action: 'thread.ownership.read', args: { threadId: 'cq1' } })).owner, 'khlink');
});

test('phone uploads on a Claude thread are handled by the connector, not the Claude backend', async () => {
  const { connector, calls } = connectorForRouting();
  connector.threadState.set('ct1', { backendId: 'claude' });
  connector.claudeThreads.set('ct1', { id: 'ct1', approveMode: 'manual' });
  connector.uploads = new Map();
  const begun = await connector.executeCommand({ action: 'file.upload.begin', args: { threadId: 'ct1', name: 'a.jpg', mimeType: 'image/jpeg' } });
  assert.ok(begun.uploadId);
  await connector.executeCommand({ action: 'file.upload.abort', args: { uploadId: begun.uploadId } });
  assert.equal(calls.length, 0);
});

test('file operations do not depend on a missing or recycling Codex host', async () => {
  const connector = Object.create(Connector.prototype);
  connector.codex = { ready: false, restart: async () => { throw new Error('Codex should not be restarted'); } };
  connector.idleHostRecyclePromise = new Promise(() => {});
  const calls = [];
  for (const [action, method] of [['file.read', 'readFile'], ['file.upload.begin', 'beginUpload'],
    ['file.upload.chunk', 'writeUpload'], ['file.upload.finish', 'finishUpload'], ['file.upload.abort', 'abortUpload']]) {
    connector[method] = (args) => { calls.push(action); return { action, threadId: args.threadId }; };
    const result = await Promise.race([
      connector.executeCommand({ action, args: { threadId: 'hermes-test' } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('file operation waited for Codex')), 1000)),
    ]);
    assert.equal(result.action, action);
  }
  assert.equal(calls.length, 5);
});

test('a failure repeating every poll is logged once per window, with a count', () => {
  const connector = Object.create(Connector.prototype);
  const lines = []; const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  const realNow = Date.now; let now = 1_000_000; Date.now = () => now;
  try {
    for (let i = 0; i < 5; i++) connector.log('Desktop queue scan skipped: Codex Desktop was not found');
    assert.equal(lines.length, 1);
    now += 11 * 60_000;
    connector.log('Desktop queue scan skipped: Codex Desktop was not found');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /又出现 4 次/);
    connector.log('x'.repeat(10_000));
    assert.ok(lines[2].length < 4100, 'huge messages are clipped');
  } finally { console.error = original; Date.now = realNow; }
});

test('Claude account switching is closed for the phone while Codex accounts stay available', async () => {
  const connector = Object.create(Connector.prototype);
  const state = await connector.executeCommand({ action: 'accounts.read', args: { backend: 'claude' } });
  assert.equal(state.backend, 'claude');
  assert.equal(state.configured, false);
  assert.equal(state.switching, false);
  assert.deepEqual(state.profiles, []);
  await assert.rejects(connector.executeCommand({ action: 'accounts.switch', args: { backend: 'claude', to: 'opaque' } }),
    (error) => error.code === 'account_switch_disabled');
});
