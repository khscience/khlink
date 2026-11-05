const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Connector, assertCommandThread, codexInput, withAttachmentContext } = require('../src/connector');
const { readHistoryAttachmentPreviews } = require('../src/connector');
const { FollowupStore } = require('../src/followup-store');
const { DesktopAdapter } = require('../src/desktop-adapter');

test('restarts a dead Codex app-server without dropping relay presence', async () => {
  const connector = Object.create(Connector.prototype);
  const statuses = [];
  connector.stopping = false;
  connector.codexRecoveryPromise = null;
  connector.codexRecoveryAttempts = 0;
  connector.codexLastError = 'app_server_exit';
  connector.lifecycle = 'running';
  connector.ws = { readyState: 1 };
  connector.config = { deviceName: 'Desktop' };
  connector.codex = { ready: false, restart: async () => { connector.codex.ready = true; } };
  connector.writeStatus = (_connected, lifecycle, extra) => statuses.push({ lifecycle, ...extra });
  connector.presencePayload = () => ({ deviceName: 'Desktop', activeThreads: [] });
  connector.emit = () => {};
  connector.republishActiveThreadStatuses = () => {};

  assert.equal(await connector.recoverCodex({ reason: 'app_server_exit' }), true);
  assert.equal(connector.codex.ready, true);
  assert.equal(connector.lifecycle, 'running');
  assert.equal(connector.codexRecoveryAttempts, 0);
  assert.equal(statuses.some((status) => status.codexRecovery === 'restarting'), true);
  assert.equal(statuses.some((status) => status.codexRecovery === 'recovered'), true);
});

test('resumes a known Codex task when it is not loaded in the app-server', async () => {
  const connector = Object.create(Connector.prototype);
  let attempts = 0;
  const requests = [];
  connector.log = () => {};
  connector.codex = { request: async (method, params) => { requests.push([method, params]); return {}; } };
  connector.executeCommand = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('thread not found: task-1');
    return { ok: true };
  };

  assert.deepEqual(await connector.command({ action: 'turn.start', args: { threadId: 'task-1' } }), { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(requests, [['thread/resume', { threadId: 'task-1', excludeTurns: true }]]);
});

test('a KH Link-owned task never probes or dispatches through the Desktop writer', async () => {
  const connector = Object.create(Connector.prototype);
  let probes = 0;
  connector.threadOwnership = { get: () => ({ threadId: 'task-1', owner: 'khlink', stateVersion: 2, updatedAt: Date.now() }) };
  connector.desktopAdapter = { probe: async () => { probes += 1; throw new Error('must not probe managed task'); } };
  connector.emit = () => {};
  connector.log = () => {};

  const routed = await connector.routeTurnThroughDesktop({ args: { threadId: 'task-1', title: 'Managed' } }, 'phone-1');
  assert.equal(routed, null);
  assert.equal(probes, 0);
});

test('a Desktop probe marks ownership and keeps an occupied image in the durable queue', async () => {
  const connector = Object.create(Connector.prototype);
  const items = [];
  connector.threadOwnership = {
    get: () => null,
    markDesktop: (threadId, changes) => ({ threadId, owner: 'desktop', ...changes, stateVersion: 1, updatedAt: Date.now() }),
  };
  connector.bridgeInstanceId = 'bridge-test';
  connector.codex = { host: { state: {} } };
  connector.codex.request = async (method, params) => {
    assert.equal(method, 'thread/queue/add');
    assert.equal(params.threadId, 'task-1');
    return { queuedSubmission: { id: 'queue-1' } };
  };
  connector.emit = () => {};
  connector.log = () => {};
  connector.desktopAdapter = { probe: async () => ({ code: 'task_active' }) };
  connector.followups = {
    update(id, changes) { const item = items.find((value) => value.id === id); Object.assign(item, changes); return item; },
  };
  connector.threadOwner = () => null;
  connector.markDesktopThread = () => { connector.threadOwnership.get = () => ({ owner: 'desktop' }); };

  const item = { id: 'image-1', requestId: 'image-1', threadId: 'task-1', title: 'Desktop task', mode: 'queue', attachments: [{ attachmentId: 'a1' }], state: 'pending', attempts: 0 };
  items.push(item);
  const result = await connector.dispatchFollowup(item);
  assert.equal(result.state, 'desktop_queued');
  assert.equal(result.queueTransport, 'codex');
  assert.equal(items[0].state, 'desktop_queued');
});

test('a stale Desktop owner is corrected from the actual host loaded-thread list without a UI probe', async () => {
  const connector = Object.create(Connector.prototype);
  let owner = 'desktop';
  connector.threadOwner = () => ({ owner });
  connector.claimBridgeThread = (_thread, changes) => { assert.equal(changes.source, 'host_loaded'); owner = 'khlink'; };
  connector.codex = { mode: 'host', ready: true, request: async (method) => { assert.equal(method, 'thread/loaded/list'); return { data: ['task-1'] }; } };
  connector.desktopAdapter = { probe: () => assert.fail('our host owns the lock; do not probe Desktop') };
  assert.equal(await connector.routeTurnThroughDesktop({ args: { threadId: 'task-1' } }, 'phone'), null);
  assert.equal(owner, 'khlink');
});

test('a missing or failed host-loaded result never claims a Desktop thread', async () => {
  const connector = Object.create(Connector.prototype); connector.log = () => {};
  connector.claimBridgeThread = () => assert.fail('no positive ownership evidence');
  connector.codex = { mode: 'host', ready: true, request: async () => ({ data: ['another-task'] }) };
  assert.equal(await connector.confirmCodexHostThread('task-1'), false);
  connector.codex.request = async () => { throw new Error('offline'); };
  assert.equal(await connector.confirmCodexHostThread('task-1'), false);
});

test('a native queue receipt resolves uncertainty and only the owning idle host consumes it', async () => {
  const connector = Object.create(Connector.prototype); connector.followups = memoryFollowups(); connector.emit = () => {}; connector.log = () => {};
  connector.followups.add({ id: 'one', requestId: 'one', threadId: 'task-1', text: 'hello', state: 'uncertain' });
  connector.confirmCodexHostThread = async () => true;
  const calls = [];
  connector.codex = { mode: 'host', ready: true, request: async (method) => {
    calls.push(method);
    if (method === 'thread/queue/list') return { data: [{ id: 'native-1', clientUserMessageId: 'one' }] };
    if (method === 'thread/read') return { thread: { id: 'task-1', status: { type: 'idle' } } };
    if (method === 'thread/queue/start') return { turn: { id: 'turn-1' } };
    assert.fail(method);
  } };
  await connector.reconcileCodexProtocolFollowups();
  assert.deepEqual(calls, ['thread/queue/list', 'thread/read', 'thread/queue/start']);
  assert.equal(connector.followups.get('one').state, 'started');
});

test('an uncertain result with no matching queue receipt stays unresolved and is not sent again', async () => {
  const connector = Object.create(Connector.prototype); connector.followups = memoryFollowups(); connector.emit = () => {}; connector.log = () => {};
  connector.followups.add({ id: 'one', requestId: 'one', threadId: 'task-1', state: 'uncertain' });
  connector.codex = { mode: 'host', ready: true, request: async (method) => { assert.equal(method, 'thread/queue/list'); return { data: [] }; } };
  await connector.reconcileCodexProtocolFollowups();
  assert.equal(connector.followups.get('one').state, 'uncertain');
});

test('a Desktop-owned native queue is never started by a second host', async () => {
  const connector = Object.create(Connector.prototype); connector.followups = memoryFollowups(); connector.emit = () => {}; connector.log = () => {};
  connector.followups.add({ id: 'one', requestId: 'one', threadId: 'task-1', state: 'desktop_queued', queueTransport: 'codex' });
  connector.confirmCodexHostThread = async () => false;
  connector.codex = { mode: 'host', ready: true, request: async (method) => { assert.equal(method, 'thread/queue/list'); return { data: [{ id: 'native-1', clientUserMessageId: 'one' }] }; } };
  await connector.reconcileCodexProtocolFollowups();
  assert.equal(connector.followups.get('one').state, 'desktop_queued');
});

test('does not resurrect a followup removed when history confirms delivery', async () => {
  const connector = Object.create(Connector.prototype);
  let updates = 0;
  connector.followups = {
    get: () => null,
    update: () => { updates += 1; return null; },
  };
  const item = { id: 'sent-1', threadId: 'task-1', state: 'pending', mode: 'queue', text: 'already delivered' };
  assert.equal(await connector.dispatchFollowup(item), null);
  assert.equal(updates, 0);
});

test('reports a followup as delivered when history removes it during dispatch', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups();
  connector.emit = () => {};
  connector.dispatchFollowup = async (item) => { connector.followups.remove(item.id); return null; };
  const result = await connector.enqueueFollowup({ requestId: 'sent-2', args: { threadId: 'task-1', text: 'send once' } }, 'phone-1');
  assert.deepEqual(result, { queued: false, accepted: true, delivered: true, requestId: 'sent-2' });
  assert.equal(connector.followups.list('task-1').length, 0);
});

test('an accepted mobile turn persists KH Link ownership', async () => {
  const connector = Object.create(Connector.prototype);
  const owners = [];
  connector.threadState = new Map([['task-1', { model: 'gpt-5.6-sol', permissionMode: 'manual' }]]);
  connector.config = { workspace: process.cwd() };
  connector.mobileOwnedThreads = new Set();
  connector.resolveDefaultModel = async () => 'gpt-5.6-sol';
  connector.resolveAttachments = () => [];
  connector.codex = { dangerousOperationsEnabled: true, request: async () => ({ turn: { id: 'turn-1' } }) };
  connector.threadOwnership = { claim: (threadId, changes) => { const record = { threadId, owner: 'khlink', ...changes, stateVersion: 1, updatedAt: Date.now() }; owners.push(record); return record; } };
  connector.bridgeInstanceId = 'bridge-test';
  connector.log = () => {};
  connector.emit = () => {};

  const result = await connector.startTurn({ threadId: 'task-1', text: 'hello', requestId: 'req-1' });
  assert.equal(result.turn.id, 'turn-1');
  assert.equal(connector.mobileOwnedThreads.has('task-1'), true);
  assert.equal(owners[0].owner, 'khlink');
  assert.equal(owners[0].source, 'mobile_turn');
});

test('recycles an idle managed Codex host after a mobile turn to release its writer lock', async () => {
  const connector = Object.create(Connector.prototype);
  let restarted = 0;
  connector.mobileOwnedThreads = new Set(['task-1']);
  connector.threadState = new Map();
  connector.followups = { items: [] };
  connector.idleHostRecyclePromise = null;
  connector.codex = {
    mode: 'host',
    ready: true,
    request: async (method, params) => {
      if (method === 'thread/loaded/list') return { data: [] };
      assert.equal(method, 'thread/unsubscribe');
      assert.deepEqual(params, { threadId: 'task-1' });
      return { status: 'unsubscribed' };
    },
    restart: async () => { restarted += 1; },
  };
  connector.ws = { readyState: 1 };
  connector.writeStatus = () => {};
  connector.log = (error) => { throw error; };

  await connector.afterMobileTurn('task-1');
  assert.equal(restarted, 1);
  assert.equal(connector.mobileOwnedThreads.size, 0);
});

test('does not recycle the managed host while another mobile turn is active', async () => {
  const connector = Object.create(Connector.prototype);
  let restarted = 0;
  connector.mobileOwnedThreads = new Set(['task-1', 'task-2']);
  connector.threadState = new Map();
  connector.followups = { items: [] };
  connector.idleHostRecyclePromise = null;
  connector.codex = {
    mode: 'host',
    ready: true,
    request: async () => ({ status: 'unsubscribed' }),
    restart: async () => { restarted += 1; },
  };
  connector.ws = { readyState: 1 };
  connector.writeStatus = () => {};
  connector.log = (error) => { throw error; };

  await connector.afterMobileTurn('task-1');
  assert.equal(restarted, 0);
  assert.deepEqual([...connector.mobileOwnedThreads], ['task-2']);
});

test('a connector reload cannot make its still-running host look idle', async () => {
  const connector = Object.create(Connector.prototype);
  connector.mobileOwnedThreads = new Set(); connector.threadState = new Map(); connector.followups = { items: [] };
  connector.codex = { mode: 'host', ready: true, request: async (method) => method === 'thread/loaded/list'
    ? { data: ['running-before-reload'] } : { thread: { status: { type: 'active', activeFlags: ['waitingOnApproval'] } } },
    restart: () => assert.fail('must preserve the active persistent host') };
  assert.equal(await connector.recycleIdleCodexHost(), false);
});

test('uncertain host activity is never sufficient evidence to recycle it', async () => {
  const connector = Object.create(Connector.prototype); connector.log = () => {};
  connector.codex = { request: async () => { throw new Error('timeout'); } };
  assert.equal(await connector.codexHostHasActiveWork(), true);
  connector.codex.request = async () => ({ data: ['one'] });
  assert.equal(await connector.codexHostHasActiveWork(), true);
});

test('confirmed idle loaded threads allow the managed host to release writer locks', async () => {
  const connector = Object.create(Connector.prototype);
  connector.codex = { request: async (method) => method === 'thread/loaded/list'
    ? { data: ['idle-thread'] } : { thread: { status: { type: 'idle' } } } };
  assert.equal(await connector.codexHostHasActiveWork(), false);
});

test('idle host recycle waits for outstanding history reads', async () => {
  const connector = Object.create(Connector.prototype);
  const pending = new Map([['history', {}]]); let restarted = 0;
  connector.mobileOwnedThreads = new Set(); connector.threadState = new Map(); connector.followups = { items: [] };
  connector.codex = { mode: 'host', ready: true, pending, restart: async () => { assert.equal(pending.size, 0); restarted++; } };
  connector.ws = { readyState: 1 }; connector.writeStatus = () => {};
  const drain = setTimeout(() => pending.clear(), 300);
  try { await connector.recycleIdleCodexHost(); } finally { clearTimeout(drain); }
  assert.equal(restarted, 1);
});

test('a new Codex command waits for an ongoing idle host recycle', async () => {
  const connector = Object.create(Connector.prototype); let release; let requests = 0;
  connector.idleHostRecyclePromise = new Promise((resolve) => { release = resolve; });
  connector.defaultBackendId = 'codex'; connector.codex = { ready: true, request: async () => { requests++; return { data: [] }; } };
  const command = connector.executeCommand({ action: 'thread.list', args: {} });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(requests, 0);
  release(); await command; assert.equal(requests, 1);
});

function memoryFollowups() {
  const items = [];
  return {
    items,
    add(item) { const found = items.find((value) => value.requestId === item.requestId); if (found) return found; items.push(item); return item; },
    get(id) { return items.find((value) => value.id === id || value.requestId === id); },
    update(id, changes) { const item = this.get(id); Object.assign(item, changes); return item; },
    remove(id) { const item = this.get(id); if (item) items.splice(items.indexOf(item), 1); return item; },
    list(threadId) { return items.filter((item) => !threadId || item.threadId === threadId); },
    matchStarted(threadId, text, startedAt = Date.now()) {
      const item = items.find((value) => value.threadId === threadId &&
        ['desktop_queued', 'dispatching', 'pending'].includes(value.state) && value.createdAt <= startedAt + 5000 &&
        String(value.text).trim() === String(text).trim());
      return item ? this.remove(item.id) : null;
    },
  };
}

test('rejects an encrypted command whose envelope and payload target different tasks', () => {
  assert.doesNotThrow(() => assertCommandThread('task-1', 'task-1'));
  assert.throws(() => assertCommandThread('task-1', 'task-2'), /任务标识不一致/);
});

test('thread.settings.read prefers the durable rollout effort over stale connector cache', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['task-1', { model: 'gpt-5.6-sol', effort: 'low', serviceTier: 'default' }]]);
  connector.readThreadSettings = () => ({ model: 'gpt-5.6-sol', effort: 'high', serviceTier: 'default' });

  const result = await connector.executeCommand({ action: 'thread.settings.read', args: { threadId: 'task-1' } });
  assert.equal(result.effort, 'high');
  assert.equal(result.model, 'gpt-5.6-sol');
});

test('thread.settings.read keeps cached fields only when rollout data is absent', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['task-1', { model: 'gpt-5.6-sol', effort: 'high', serviceTier: 'default' }]]);
  connector.readThreadSettings = () => ({ model: null, effort: null, serviceTier: null });

  const result = await connector.executeCommand({ action: 'thread.settings.read', args: { threadId: 'task-1' } });
  assert.equal(result.effort, 'high');
  assert.equal(result.model, 'gpt-5.6-sol');
});

test('refuses to control a queued item through another task id', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups(); connector.emit = () => {}; connector.log = () => {};
  connector.followups.add({ id: 'queued-1', requestId: 'queued-1', threadId: 'task-1', text: 'first', state: 'desktop_queued' });
  connector.desktopAdapter = { steer: async () => assert.fail('must not steer another task') };

  await assert.rejects(
    connector.command({ action: 'followup.steer', args: { id: 'queued-1', threadId: 'task-2' } }, 'phone-1'),
    /任务标识不一致/,
  );
  assert.equal(connector.followups.get('queued-1').threadId, 'task-1');
});

test('mirrors only the exact Desktop task queue into the mobile snapshot', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopQueueItems = new Map(); connector.followups = memoryFollowups(); connector.log = () => {};
  connector.emit = () => {};
  connector.desktopAdapter = { listQueued: async () => ({ activeTitle: 'Task', items: [{ text: 'desktop queued', order: 0 }] }) };
  await connector.syncNativeDesktopQueues([{ id: 'task-1', title: 'Task' }]);
  const item = [...connector.desktopQueueItems.values()][0];
  assert.equal(item.threadId, 'task-1');
  assert.equal(item.origin, 'desktop');
  assert.equal(item.state, 'desktop_queued');
  assert.equal(item.text, 'desktop queued');
});

test('syncs the selected Desktop collaboration mode back to the phone state', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopQueueItems = new Map(); connector.followups = memoryFollowups(); connector.log = () => {};
  connector.threadState = new Map([['task-1', { collaborationMode: 'default' }]]);
  const emitted = [];
  connector.emit = (kind, threadId, value) => emitted.push({ kind, threadId, value });
  connector.desktopAdapter = { listQueued: async () => ({
    activeTitle: 'Task', items: [], effectiveCollaborationMode: 'plan',
  }) };
  await connector.syncNativeDesktopQueues([{ id: 'task-1', title: 'Task' }]);
  assert.equal(connector.threadState.get('task-1').collaborationMode, 'plan');
  assert.equal(emitted.find((item) => item.kind === 'thread.settings').value.settings.effectiveCollaborationMode, 'plan');
});

test('does not guess a Desktop queue when task titles are duplicated', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopQueueItems = new Map(); connector.followups = memoryFollowups(); connector.log = () => {};
  let scans = 0; connector.desktopAdapter = { listQueued: async () => { scans += 1; return { activeTitle: 'Task', items: [{ text: 'must not map' }] }; } };
  await connector.syncNativeDesktopQueues([{ id: 'task-1', title: 'Task' }, { id: 'task-2', title: 'Task' }]);
  assert.equal(scans, 0); assert.equal(connector.desktopQueueItems.size, 0);
});

test('keeps mobile queue entries from being mirrored a second time', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopQueueItems = new Map(); connector.followups = memoryFollowups(); connector.log = () => {};
  connector.followups.add({ id: 'mobile-1', requestId: 'mobile-1', threadId: 'task-1', text: 'same text', state: 'desktop_queued' });
  connector.desktopAdapter = { listQueued: async () => ({ activeTitle: 'Task', items: [{ text: 'same text' }] }) };
  await connector.syncNativeDesktopQueues([{ id: 'task-1', title: 'Task' }]);
  assert.equal(connector.desktopQueueItems.size, 0);
});

test('embeds small uploaded images and skips oversized or unsupported files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-history-'));
  try {
    const small = path.join(root, 'small.png'); fs.writeFileSync(small, Buffer.from('png-data'));
    const large = path.join(root, 'large.png'); fs.writeFileSync(large, Buffer.alloc(650 * 1024 + 1));
    const result = readHistoryAttachmentPreviews([
      { name: 'small.png', path: small, mimeType: 'image/png' },
      { name: 'large.png', path: large, mimeType: 'image/png' },
      { name: 'notes.txt', path: small, mimeType: 'text/plain' },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].data, `data:image/png;base64,${Buffer.from('png-data').toString('base64')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Desktop dispatch carries the uploaded image as a native UI attachment', async () => {
  const adapter = Object.create(DesktopAdapter.prototype);
  let request; adapter.call = async (value) => { request = value; return { ok: true }; };
  await adapter.dispatch({
    requestId: 'image-1', threadId: 'task-1', title: 'Task', mode: 'queue',
    displayText: '看一下图片',
    text: '看一下图片\n\n[KH Link 图片附件] phone.png\n附件编号：image-1',
    attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png', attachmentId: 'image-1' }],
  });
  assert.match(request.text, /附件编号：image-1/);
  assert.deepEqual(request.attachments, [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png' }]);
});

test('background protocol carries the uploaded image as a first-class localImage input', () => {
  const input = codexInput('请查看这张图片', [{
    name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png', attachmentId: 'image-1',
  }]);
  assert.deepEqual(input, [
    { type: 'text', text: '请查看这张图片' },
    { type: 'localImage', path: 'C:\\Temp\\phone.png' },
  ]);
  assert.doesNotMatch(withAttachmentContext('请查看这张图片', [{
    name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png', attachmentId: 'image-1',
  }]), /read_image/);
});

test('adds a Desktop-owned image to Codex queue with the original request id', async () => {
  const connector = Object.create(Connector.prototype);
  let call;
  connector.codex = { request: async (method, params) => { call = { method, params }; return { queuedSubmission: { id: 'queue-1' } }; } };
  await connector.enqueueCodexThreadQueue({
    requestId: '11111111-1111-4111-8111-111111111111', threadId: 'task-1',
    displayText: '请查看图片', attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', mimeType: 'image/png' }],
  });
  assert.equal(call.method, 'thread/queue/add');
  assert.equal(call.params.threadId, 'task-1');
  assert.equal(call.params.clientUserMessageId, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(call.params.input, [
    { type: 'text', text: require('../src/request-marker').withRequestMarker('请查看图片', '11111111-1111-4111-8111-111111111111') },
    { type: 'localImage', path: 'C:\\Temp\\phone.png' },
  ]);
});

test('resets a connector event cursor after the server sequence is restored backwards', async () => {
  const connector = Object.create(Connector.prototype);
  connector.lastSequence = 30_215; connector.followups = memoryFollowups();
  connector.config = { deviceName: 'Desktop' }; connector.desktopStatuses = new Map();
  connector.republishActiveThreadStatuses = () => {}; connector.writeStatus = () => {};
  connector.emit = () => {}; connector.replayEvents = async () => assert.fail('must not replay from a future cursor');
  connector.saveSequence = (sequence) => { connector.lastSequence = sequence; };

  await connector.onFrame(JSON.stringify({ type: 'ready', latestSequence: 3_549 }));

  assert.equal(connector.lastSequence, 3_549);
});

test('publishes fresh connector presence when the relay session becomes ready', async () => {
  const connector = Object.create(Connector.prototype);
  connector.lastSequence = null; connector.followups = memoryFollowups();
  connector.config = { deviceName: 'Desktop' };
  connector.desktopStatuses = new Map([['active-task', 'desktop_running']]);
  connector.republishActiveThreadStatuses = () => {}; connector.writeStatus = () => {};
  connector.saveSequence = (sequence) => { connector.lastSequence = sequence; };
  const events = []; connector.emit = (kind, _threadId, payload) => events.push([kind, payload]);

  await connector.onFrame(JSON.stringify({ type: 'ready', latestSequence: 4 }));

  assert.equal(events.some(([kind, payload]) => kind === 'connector.online' && Number.isFinite(payload.sentAt)), true);
  const presence = events.find(([kind]) => kind === 'connector.presence')?.[1];
  assert.equal(Number.isFinite(presence?.sentAt), true);
  assert.equal(presence.activeThreads.length, 1);
  assert.deepEqual(presence.activeThreads[0].threadId, 'active-task');
  assert.deepEqual(presence.activeThreads[0].status, 'desktop_running');
  assert.equal(Number.isFinite(presence.activeThreads[0].updatedAt), true);
});

test('queues on the original task when Codex Desktop owns the writer', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
  connector.desktopActiveThreads = new Set(['task-1']);
  connector.followups = memoryFollowups();
  connector.desktopAdapter = { dispatch: async () => ({ ok: true }) }; connector.emit = () => {};
  connector.executeCommand = async () => assert.fail('must use the Desktop queue');
  const result = await connector.command({ requestId: 'req-1', action: 'turn.start', args: { threadId: 'task-1', text: 'next' } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.threadId, 'task-1');
  assert.equal(result.item.state, 'desktop_queued');
  // A turn is genuinely running on this thread, so the phone must still show
  // this as a real queued/"待发送" item, not an instant "发送中".
  assert.equal(result.item.blocking, true);
});

test('publishes the persistent pending state before waiting for Desktop UI Automation', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map(); connector.desktopStatuses = new Map(); connector.followups = memoryFollowups();
  const order = [];
  connector.emit = (kind, _threadId, value) => order.push(`${kind}:${value.state}`);
  connector.desktopAdapter = { dispatch: async () => { order.push('desktop.dispatch'); return { code: 'queued' }; } };

  const result = await connector.enqueueFollowup({ requestId: 'req-fast', args: {
    threadId: 'task-1', title: 'Known Desktop task', text: 'next',
  } }, 'phone-1');

  assert.equal(result.item.state, 'desktop_queued');
  assert.deepEqual(order, [
    'followup.queued:pending',
    'followup.queued:dispatching',
    'desktop.dispatch',
    'followup.queued:desktop_queued',
  ]);
  // Nothing is actually busy (desktopStatuses is empty) — this item must
  // report blocking:false throughout so the phone shows "发送中" immediately
  // instead of "待发送", even though it is technically routed through the
  // Desktop-owned enqueue/dispatch path for writer-conflict safety.
  assert.equal(result.item.blocking, false);
});

test('a stale desktop_running left over from the idle-clearing grace period does not force blocking:true', async () => {
  // desktopStatuses is deliberately kept at its last live value for up to
  // DESKTOP_STATUS_IDLE_GRACE_MS (20s) after a turn actually finishes, so the
  // "运行中" thread badge does not flicker off during a lagging poll. A
  // message sent to the SAME thread inside that window must not be treated
  // as genuinely blocking just because of that intentional staleness —
  // desktopActiveThreads (rebuilt fresh every 2s poll, no grace period) is
  // the authority for whether Desktop is showing this thread as active right
  // now.
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
  connector.desktopActiveThreads = new Set();
  connector.followups = memoryFollowups();
  connector.desktopAdapter = { dispatch: async () => ({ ok: true }) }; connector.emit = () => {};
  connector.executeCommand = async () => assert.fail('must use the Desktop queue');
  const result = await connector.command({ requestId: 'req-stale', action: 'turn.start', args: { threadId: 'task-1', text: 'next' } }, 'phone-1');
  assert.equal(result.item.blocking, false);
});

test('registerDirectFollowup always marks a direct dispatch as non-blocking', () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups();
  connector.resolveAttachments = () => [];
  connector.currentRolloutOffset = () => 0;
  connector.emit = () => {};

  const item = connector.registerDirectFollowup({ action: 'turn.start', requestId: 'req-direct', args: { threadId: 'task-1', text: 'hi' } }, 'phone-1');
  assert.equal(item.state, 'dispatching');
  assert.equal(item.blocking, false);
});

test('recoverInterruptedFollowups marks a resumed item as blocking until reconciled', () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups();
  connector.followups.add({ id: 'req-interrupted', requestId: 'req-interrupted', threadId: 'task-1', state: 'dispatching', createdAt: Date.now(), attempts: 1 });

  connector.recoverInterruptedFollowups();

  const item = connector.followups.get('req-interrupted');
  assert.equal(item.state, 'pending');
  assert.equal(item.blocking, true);
});

test('starts an idle known Desktop task directly through the background protocol', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'completed']]); connector.followups = memoryFollowups();
  connector.desktopAdapter = { dispatch: async () => assert.fail('idle tasks do not need the Desktop queue') }; connector.emit = () => {};
  connector.executeCommand = async (payload) => ({ started: true, threadId: payload.args.threadId });
  const result = await connector.command({ requestId: 'req-idle', action: 'turn.start',
    args: { threadId: 'task-1', title: 'Known Desktop task', text: 'next' } }, 'phone-1');
  assert.deepEqual(result, { started: true, threadId: 'task-1' });
});

test('queues an image turn while Desktop owns the writer without touching the picker', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
  connector.followups = memoryFollowups(); connector.emit = () => {};
  connector.desktopAdapter = { dispatch: async () => assert.fail('image turns must not use foreground UI automation') };
  connector.codex = { request: async (method) => { assert.equal(method, 'thread/queue/add'); return { queuedSubmission: { id: 'queue-1' } }; } };
  connector.executeCommand = async () => assert.fail('a Desktop-owned image must use the Codex queue');
  const result = await connector.command({ requestId: 'req-image-background', action: 'turn.start', args: {
    threadId: 'task-1', title: 'Known Desktop task', text: '请查看图片',
    attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png' }],
  } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.state, 'desktop_queued');
  assert.equal(result.item.mode, 'queue');
});

test('keeps an image turn in a durable background queue when Desktop owns the writer', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
  connector.followups = memoryFollowups(); connector.emit = () => {};
  connector.desktopAdapter = { dispatch: async () => assert.fail('must never open the foreground picker') };
  connector.codex = { request: async (method) => { assert.equal(method, 'thread/queue/add'); return { queuedSubmission: { id: 'queue-1' } }; } };
  connector.executeCommand = async () => {
    const error = new Error('This task is already open in another application');
    error.code = 'active_writer';
    throw error;
  };
  const result = await connector.command({ requestId: 'req-image-queued', action: 'turn.start', args: {
    threadId: 'task-1', title: 'Known Desktop task', text: '请查看图片',
    attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png' }],
  } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.state, 'desktop_queued');
  assert.equal(result.item.mode, 'queue');
});

test('recovers an agent-loop image failure into the same durable request', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'completed']]);
  connector.threadState = new Map(); connector.followups = memoryFollowups(); connector.emit = () => {};
  connector.desktopAdapter = { probe: async () => ({ ok: true, code: 'desktop_absent' }) };
  let attempts = 0; let recoveries = 0;
  connector.recoverCodex = async () => { recoveries += 1; };
  connector.executeCommand = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('failed to submit turn input: internal error; agent loop died unexpectedly');
    return { started: true };
  };
  const result = await connector.command({ requestId: 'req-agent-loop-image', action: 'turn.start', args: {
    threadId: 'task-1', title: 'Known task', text: '请查看图片',
    attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png' }],
  } }, 'phone-1');
  assert.equal(recoveries, 1);
  assert.equal(attempts, 2);
  assert.equal(result.queued, true);
  assert.equal(result.item.requestId, 'req-agent-loop-image');
  assert.equal(result.item.state, 'started');
  assert.equal(result.item.blocking, false, 'a real background start receipt is no longer a waiting queue row');
});

test('does not expose a permanent agent-loop error when recovery is still pending', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'completed']]);
  connector.threadState = new Map(); connector.followups = memoryFollowups(); connector.emit = () => {};
  connector.desktopAdapter = { probe: async () => ({ ok: true, code: 'desktop_absent' }) };
  connector.recoverCodex = async () => { throw new Error('Codex host restart timed out'); };
  connector.executeCommand = async () => { throw new Error('failed to submit turn input: internal error; agent loop died unexpectedly'); };
  const result = await connector.command({ requestId: 'req-agent-loop-pending', action: 'turn.start', args: {
    threadId: 'task-1', title: 'Known task', text: '',
    attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png' }],
  } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.state, 'pending');
  assert.match(result.item.reason, /异常退出|自动后台发送|重试/);
  assert.doesNotMatch(result.item.reason, /agent loop died|failed to submit/i);
});

test('does not emit a transient failed event while recovering an unloaded image task', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'completed']]);
  connector.threadState = new Map(); connector.followups = memoryFollowups();
  const events = []; connector.emit = (kind, _threadId, value) => events.push({ kind, value });
  connector.desktopAdapter = { probe: async () => ({ ok: true, code: 'desktop_other_task' }) };
  connector.codex = { request: async () => { throw new Error('thread not found: task-1'); } };
  connector.executeCommand = async () => { throw new Error('thread not found: task-1'); };
  const result = await connector.command({ requestId: 'req-thread-recovery', action: 'turn.start', args: {
    threadId: 'task-1', title: 'Known task', text: '',
    attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png' }],
  } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.state, 'pending');
  assert.equal(events.some(({ kind, value }) => kind === 'followup.failed' && /thread not found/i.test(value?.reason || '')), false);
});

test('probes a Desktop-owned image before dispatch and never opens the foreground picker', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
  connector.followups = memoryFollowups(); connector.emit = () => {};
  const calls = [];
  connector.desktopAdapter = {
    probe: async () => ({ ok: true, code: 'task_active' }),
    dispatch: async () => assert.fail('an image must not use Desktop UI automation'),
  };
  connector.codex = { request: async (method) => { assert.equal(method, 'thread/queue/add'); return { queuedSubmission: { id: 'queue-1' } }; } };
  connector.executeCommand = async () => { calls.push('background'); return { started: true }; };
  const result = await connector.command({ requestId: 'req-image-probe', action: 'turn.start', args: {
    threadId: 'task-1', title: 'Known Desktop task', text: '请查看图片',
    attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png' }],
  } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.state, 'desktop_queued');
  assert.equal(calls.length, 0);
});

test('probes a Desktop-owned image by thread id when the mobile title is unavailable', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'completed']]);
  connector.followups = memoryFollowups(); connector.emit = () => {};
  const calls = [];
  connector.desktopAdapter = {
    probe: async (threadId, title) => { calls.push([threadId, title]); return { ok: true, code: 'task_active' }; },
    dispatch: async () => assert.fail('an image must not use Desktop UI automation'),
  };
  connector.codex = { request: async (method) => { assert.equal(method, 'thread/queue/add'); return { queuedSubmission: { id: 'queue-1' } }; } };
  connector.executeCommand = async () => assert.fail('a Desktop-owned image must use the Codex queue');
  const result = await connector.command({ requestId: 'req-image-no-title', action: 'turn.start', args: {
    threadId: 'task-1', text: '',
    attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png' }],
  } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.state, 'desktop_queued');
  assert.deepEqual(calls, [['task-1', undefined], ['task-1', null]]);
});

test('hides thread recovery errors behind a durable retry state', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups(); connector.emit = () => {};
  connector.desktopAdapter = { probe: async () => ({ ok: true, code: 'desktop_absent' }) };
  connector.executeQueuedBackgroundTurn = async () => { throw new Error('thread not found: task-1'); };
  const result = await connector.enqueueFollowup({ requestId: 'req-image-retry', action: 'turn.start', args: {
    threadId: 'task-1', title: 'Known task', text: '',
    attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png' }],
  } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.state, 'pending');
  assert.match(result.item.reason, /自动重试/);
  assert.doesNotMatch(result.item.reason, /thread not found/i);
});

test('resumes an unloaded task through the background protocol before sending its image', async () => {
  const connector = Object.create(Connector.prototype);
  const calls = [];
  connector.codex = { request: async (method, params) => { calls.push([method, params]); return { thread: { id: params.threadId } }; } };
  connector.executeCommand = async (payload) => {
    if (calls.length === 0) throw new Error('thread not found');
    return { started: true, input: payload.args.attachments };
  };
  const result = await connector.command({ requestId: 'req-image-resume', action: 'turn.start', args: {
    threadId: 'task-1', text: '请查看图片', attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', mimeType: 'image/png' }],
  } }, 'phone-1');
  assert.equal(result.started, true);
  assert.equal(calls[0][0], 'thread/resume');
  assert.equal(result.input[0].path, 'C:\\Temp\\phone.png');
});

test('queues an image steer without opening the Desktop picker', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
  connector.followups = memoryFollowups(); connector.emit = () => {};
  connector.desktopAdapter = { dispatch: async () => assert.fail('image steering must not use foreground UI automation') };
  connector.codex = { request: async (method) => { assert.equal(method, 'thread/queue/add'); return { queuedSubmission: { id: 'queue-1' } }; } };
  connector.executeCommand = async () => assert.fail('a Desktop-owned image must use the Codex queue');
  const result = await connector.command({ requestId: 'req-image-steer', action: 'turn.steer', args: {
    threadId: 'task-1', text: '继续查看图片', turnId: 'turn-1',
    attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', size: 42, mimeType: 'image/png' }],
  } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.state, 'desktop_queued');
  assert.equal(result.item.mode, 'queue');
});

test('routes a titled turn through Desktop only when targeted probe confirms ownership', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'completed']]); connector.followups = memoryFollowups();
  connector.emit = () => {};
  const calls = [];
  connector.desktopAdapter = {
    probe: async () => ({ ok: true, code: 'task_active' }),
    dispatch: async (item) => { calls.push(item); return { code: 'queued' }; },
  };
  connector.executeCommand = async () => assert.fail('must not send a competing background turn/start');
  const result = await connector.command({ requestId: 'req-race', action: 'turn.start', args: {
    threadId: 'task-1', title: 'Known Desktop task', text: 'next',
  } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.state, 'desktop_queued');
  assert.equal(calls[0].threadId, 'task-1');
});

test('keeps an unsent request pending while Desktop is present but an older adapter cannot open it', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'completed']]); connector.followups = memoryFollowups();
  connector.emit = () => {};
  const calls = [];
  connector.desktopAdapter = {
    probe: async () => { const error = new Error('Codex Desktop is open but its composer is still loading'); error.code = 'desktop_present'; throw error; },
    dispatch: async (item) => { calls.push(item); return { code: 'queued' }; },
  };
  connector.executeCommand = async () => assert.fail('must not acquire a competing writer');
  const result = await connector.command({ requestId: 'req-loading', action: 'turn.start', args: {
    threadId: 'task-1', title: 'Known Desktop task', text: 'next',
  } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.state, 'pending');
  assert.match(result.item.reason, /消息尚未发送/);
  assert.deepEqual(calls, []);
});

test('falls back to the background protocol only when Desktop is absent', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'completed']]); connector.followups = memoryFollowups();
  connector.emit = () => {};
  connector.desktopAdapter = { probe: async () => { const error = new Error('Codex Desktop composer was not found'); error.code = 'desktop_not_ready'; throw error; } };
  connector.executeCommand = async (payload) => ({ started: true, threadId: payload.args.threadId });
  const result = await connector.command({ requestId: 'req-absent', action: 'turn.start', args: {
    threadId: 'task-1', title: 'Known Desktop task', text: 'next',
  } }, 'phone-1');
  assert.deepEqual(result, { started: true, threadId: 'task-1' });
});

test('falls back to the Desktop queue when an idle snapshot is stale and the writer is active', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'completed']]); connector.followups = memoryFollowups();
  const calls = []; connector.desktopAdapter = { dispatch: async (item) => calls.push(item) }; connector.emit = () => {};
  connector.executeCommand = async () => {
    const error = new Error('another Codex process is currently controlling this task');
    error.code = 'active_writer';
    throw error;
  };
  const result = await connector.command({ requestId: 'req-stale', action: 'turn.start',
    args: { threadId: 'task-1', title: 'Known Desktop task', text: 'next' } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.state, 'desktop_queued');
  assert.equal(calls[0].title, 'Known Desktop task');
});

test('recognizes newer Codex already-open wording as a Desktop writer conflict', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups();
  connector.emit = () => {};
  connector.log = () => {};
  connector.executeCommand = async () => { throw new Error('This task is already open in another application'); };
  const result = await connector.command({ action: 'turn.start', requestId: 'queued-open', args: { threadId: 'task-1', title: 'Task', text: 'hello' } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(connector.followups.get('queued-open').state, 'pending');
});

test('queues after thread resume returns newer already-open wording', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups();
  connector.emit = () => {};
  connector.log = () => {};
  connector.codex = {
    request: async (method) => {
      if (method === 'thread/resume') throw new Error('This task is already open in another application');
      if (method === 'thread/queue/add') return { queuedSubmission: { id: 'native-1' } };
      return {};
    },
  };
  let attempts = 0;
  connector.executeCommand = async () => {
    attempts += 1;
    throw new Error('thread not found: task-1');
  };
  const result = await connector.command({ action: 'turn.start', requestId: 'queued-resume-open', args: { threadId: 'task-1', title: 'Task', text: 'hello' } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(attempts, 1);
  assert.equal(connector.followups.get('queued-resume-open').state, 'desktop_queued');
  assert.equal(connector.followups.get('queued-resume-open').queueTransport, 'codex');
});

test('turns an image resume failure into a queued retry instead of exposing thread not found', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups(); connector.emit = () => {}; connector.log = () => {};
  connector.codex = { request: async () => { throw new Error('thread not found: task-1'); } };
  connector.desktopAdapter = { probe: async () => ({ ok: true, code: 'desktop_absent' }) };
  connector.executeCommand = async () => { throw new Error('thread not found: task-1'); };
  const result = await connector.command({ action: 'turn.start', requestId: 'image-resume-retry', args: {
    threadId: 'task-1', title: 'Task', text: '',
    attachments: [{ name: 'phone.png', path: 'C:\\Temp\\phone.png', mimeType: 'image/png' }],
  } }, 'phone-1');
  assert.equal(result.queued, true);
  assert.equal(result.item.state, 'pending');
  assert.match(result.item.reason, /自动重试/);
});

test('writes settings through the native Desktop adapter when Desktop owns the task', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['task-1', { model: 'gpt-old', effort: 'low', permissionMode: 'manual' }]]);
  connector.codex = { request: async () => assert.fail('Desktop-owned settings must use the native adapter first') };
  const calls = [];
  connector.desktopAdapter = { settings: async (item) => { calls.push(item); return { code: 'settings_applied' }; } };
  connector.emit = () => {};
  const result = await connector.executeCommand({ action: 'settings.set', args: {
    threadId: 'task-1', title: 'Known Desktop task', settings: { model: 'gpt-new', effort: 'high' },
  } });
  assert.equal(result.applied, true);
  assert.equal(result.model, 'gpt-new');
  assert.deepEqual(calls[0], { threadId: 'task-1', title: 'Known Desktop task', model: 'gpt-new', effort: 'high', serviceTier: undefined, permissionMode: undefined, collaborationMode: undefined });
});

test('maps an explicit default speed selection to the Desktop default option', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['task-1', { serviceTier: 'priority', permissionMode: 'manual' }]]);
  connector.codex = { request: async () => assert.fail('Desktop-owned settings must use the native adapter first') };
  const calls = [];
  connector.desktopAdapter = { settings: async (item) => { calls.push(item); return { code: 'settings_applied' }; } };
  connector.emit = () => {};

  const result = await connector.executeCommand({ action: 'settings.set', args: {
    threadId: 'task-1', title: 'Known Desktop task', settings: { serviceTier: null },
  } });

  assert.equal(result.applied, true);
  // Codex records the standard speed as "default", which the phone shows as 标准.
  assert.equal(result.serviceTier, 'default');
  assert.equal(calls[0].serviceTier, 'default');
  assert.equal(connector.threadState.get('task-1').serviceTier, null);
});

test('queues Desktop settings after an active-writer response instead of opening a second writer', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['task-1', { model: 'gpt-old', effort: 'low' }]]);
  connector.codex = { request: async () => assert.fail('active Desktop settings must not use a second protocol writer') };
  connector.desktopAdapter = { settings: async () => {
    const error = new Error('active writer: Desktop currently controls this task');
    error.code = 'active_writer';
    throw error;
  } };
  connector.emit = () => {};
  const result = await connector.executeCommand({ action: 'settings.set', args: {
    threadId: 'task-1', title: 'Known Desktop task', settings: { effort: 'xhigh' },
  } });
  assert.equal(result.queued, true);
  assert.equal(result.applied, false);
  assert.equal(connector.threadState.get('task-1').pendingDesktopSettings.effort, 'xhigh');
});

test('applies queued Desktop settings before dispatching the next original-task message', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['task-1', {
    model: 'gpt-new', effort: 'xhigh', pendingDesktopSettings: {
      threadId: 'task-1', title: 'Known Desktop task', effort: 'xhigh',
    },
  }]]);
  connector.desktopStatuses = new Map([['task-1', 'completed']]);
  connector.followups = memoryFollowups();
  const calls = [];
  connector.desktopAdapter = {
    settings: async (item) => calls.push(['settings', item]),
    dispatch: async (item) => calls.push(['dispatch', item]),
  };
  connector.startTurn = async (args) => ({ started: true, threadId: args.threadId });
  connector.emit = () => {};
  const result = await connector.command({ requestId: 'req-next', action: 'turn.start', args: {
    threadId: 'task-1', title: 'Known Desktop task', text: 'next',
  } }, 'phone-1');
  assert.deepEqual(result, { started: true, threadId: 'task-1' });
  assert.deepEqual(calls.map(([kind]) => kind), ['settings']);
  assert.equal(connector.threadState.get('task-1').pendingDesktopSettings, null);
});

test('keeps a follow-up pending while the current Desktop turn is still running for queued settings', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['task-1', { pendingDesktopSettings: { effort: 'xhigh' } }]]);
  connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
  connector.followups = memoryFollowups();
  connector.desktopAdapter = {
    settings: async () => assert.fail('settings must wait for the current turn'),
    dispatch: async () => assert.fail('message must wait for the current turn'),
  };
  connector.emit = () => {};
  const result = await connector.command({ requestId: 'req-wait', action: 'turn.start', args: {
    threadId: 'task-1', title: 'Known Desktop task', text: 'next',
  } }, 'phone-1');
  assert.equal(result.item.state, 'pending');
  assert.match(result.item.reason, /当前轮完成/);
});

test('falls back to the protocol when the Desktop adapter cannot address a task', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['task-1', { model: 'gpt-old' }]]);
  connector.codex = { request: async (method) => { assert.equal(method, 'thread/settings/update'); return { protocol: true }; } };
  const calls = [];
  connector.desktopAdapter = { settings: async (item) => { calls.push(item); throw new Error('task is not visible in Desktop'); } };
  connector.emit = () => {};
  const result = await connector.executeCommand({ action: 'settings.set', args: {
    threadId: 'task-1', title: 'Known Desktop task', settings: { serviceTier: 'priority' },
  } });
  assert.equal(result.applied, true);
  assert.equal(result.serviceTier, 'priority');
  assert.equal(calls[0].serviceTier, 'priority');
});

test('applies Desktop plan mode through the Desktop owner without opening a second writer', async () => {
  const connector = Object.create(Connector.prototype);
  connector.defaultModelId = 'gpt-default';
  connector.threadState = new Map([['task-1', { collaborationMode: 'default' }]]);
  const calls = [];
  connector.codex = { request: async () => assert.fail('Desktop-owned plan mode must not open a second writer') };
  connector.desktopAdapter = { settings: async (item) => {
    calls.push(item);
    return { effectiveCollaborationMode: 'plan', desiredCollaborationMode: 'plan', modeSyncState: 'applied' };
  } };
  connector.emit = () => {};
  const result = await connector.executeCommand({ action: 'settings.set', args: {
    threadId: 'task-1', title: 'Known Desktop task', settings: { collaborationMode: 'plan' },
  } });
  assert.equal(result.applied, true);
  assert.equal(result.effectiveCollaborationMode, 'plan');
  assert.equal(result.modeSyncState, 'applied');
  assert.equal(connector.threadState.get('task-1').collaborationMode, 'plan');
  assert.equal(connector.threadState.get('task-1').modeSyncSource, 'desktop');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].collaborationMode, 'plan');
});

test('restores execution mode without sending rejected null optional settings', async () => {
  const connector = Object.create(Connector.prototype);
  connector.defaultModelId = 'gpt-default';
  connector.threadState = new Map([['task-1', { collaborationMode: 'plan' }]]);
  const calls = [];
  connector.codex = { request: async () => assert.fail('Desktop-owned execution restore must not open a second writer') };
  connector.desktopAdapter = { settings: async (item) => {
    calls.push(item);
    return { effectiveCollaborationMode: 'default', desiredCollaborationMode: 'default', modeSyncState: 'applied' };
  } };
  connector.emit = () => {};
  const result = await connector.executeCommand({ action: 'settings.set', args: {
    threadId: 'task-1', title: 'Known Desktop task', settings: { collaborationMode: 'default' },
  } });
  assert.equal(result.applied, true);
  assert.equal(calls[0].collaborationMode, 'default');
  assert.equal(connector.threadState.get('task-1').modeSyncSource, 'desktop');
});

test('queues plan mode when the Desktop-owned thread is not loaded in the background app-server', async () => {
  const connector = Object.create(Connector.prototype);
  connector.defaultModelId = 'gpt-default';
  connector.threadState = new Map([['task-1', { collaborationMode: 'default' }]]);
  connector.codex = { request: async () => assert.fail('a Desktop UI identity conflict must not open a second writer') };
  connector.desktopAdapter = { settings: async () => {
    const error = new Error('Codex Desktop did not confirm the requested task');
    error.code = 'task_identity_unconfirmed';
    throw error;
  } };
  connector.emit = () => {};
  const result = await connector.command({ action: 'settings.set', args: {
    threadId: 'task-1', title: 'Known Desktop task', settings: { collaborationMode: 'plan' },
  } });
  assert.equal(result.queued, true);
  assert.equal(result.modeSyncState, 'pending');
  assert.equal(result.desiredCollaborationMode, 'plan');
  assert.equal(connector.threadState.get('task-1').pendingDesktopSettings.collaborationMode, 'plan');
});

test('uses the background protocol for a mobile-owned plan when Desktop is not involved', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['task-1', { model: 'gpt-old', collaborationMode: 'default' }]]);
  const calls = [];
  connector.codex = { request: async (method, params) => {
    calls.push({ method, params });
    return { effectiveCollaborationMode: 'plan', modeSyncState: 'applied' };
  } };
  connector.desktopAdapter = { settings: async () => {
    assert.fail('mobile-owned plan without a Desktop title must not use the adapter');
  } };
  connector.emit = () => {};
  const result = await connector.executeCommand({ action: 'settings.set', args: {
    threadId: 'task-1', settings: { collaborationMode: 'plan' },
  } });
  assert.equal(result.applied, true);
  assert.equal(result.effectiveCollaborationMode, 'plan');
  assert.equal(connector.threadState.get('task-1').modeSyncSource, 'protocol');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'thread/settings/update');
  assert.equal(calls[0].params.collaborationMode.mode, 'plan');
  assert.equal(connector.threadState.get('task-1').modeSyncState, 'applied');
});

test('keeps a Desktop plan switch queued when the native control cannot identify the task', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['task-1', { model: 'gpt-old', collaborationMode: 'default' }]]);
  const calls = [];
  connector.codex = { request: async () => assert.fail('must not use a second writer after UI identity failure') };
  connector.desktopAdapter = { settings: async () => {
    const error = new Error('Codex Desktop did not confirm the requested task; the message was not sent');
    error.code = 'task_identity_unconfirmed';
    throw error;
  } };
  connector.emit = () => {};
  const result = await connector.executeCommand({ action: 'settings.set', args: {
    threadId: 'task-1', title: 'Known Desktop task', settings: { collaborationMode: 'plan' },
  } });
  assert.equal(result.applied, false);
  assert.equal(result.queued, true);
  assert.equal(result.desiredCollaborationMode, 'plan');
});

test('queues an unverified background plan switch without opening the adapter', async () => {
  const connector = Object.create(Connector.prototype);
  connector.defaultModelId = 'gpt-default';
  connector.threadState = new Map([['task-1', { collaborationMode: 'default' }]]);
  connector.codex = { request: async () => {
    const error = new Error('Codex Desktop did not expose the /plan command suggestion');
    error.code = 'plan_command_not_found';
    throw error;
  } };
  connector.desktopAdapter = { settings: async () => assert.fail('mobile-owned plan without a Desktop title must not use the adapter') };
  connector.emit = () => {};
  const result = await connector.executeCommand({ action: 'settings.set', args: {
    threadId: 'task-1', settings: { collaborationMode: 'plan' },
  } });
  assert.equal(result.queued, true);
  assert.equal(result.applied, false);
  assert.equal(connector.threadState.get('task-1').collaborationMode, 'default');
  assert.equal(connector.threadState.get('task-1').modeSyncState, 'pending');
});

test('queues a timed-out background plan switch for the next turn', async () => {
  const connector = Object.create(Connector.prototype);
  connector.defaultModelId = 'gpt-default';
  connector.threadState = new Map([['task-1', { collaborationMode: 'default' }]]);
  connector.updateThreadSettingsInBackground = async () => { throw new Error('thread/settings/update timed out'); };
  connector.emit = () => {};
  const result = await connector.executeCommand({ action: 'settings.set', args: {
    threadId: 'task-1', title: 'Known Desktop task', settings: { collaborationMode: 'plan' },
  } });
  assert.equal(result.applied, false);
  assert.equal(result.queued, true);
  assert.equal(result.modeSyncState, 'pending');
  assert.equal(result.desiredCollaborationMode, 'plan');
  assert.equal(connector.threadState.get('task-1').pendingDesktopSettings.collaborationMode, 'plan');
});

test('queues a plan switch when resolving the default model loses the connection', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['task-1', { collaborationMode: 'default' }]]);
  connector.codex = { request: async () => { const error = new Error('transport timeout'); error.code = 'timeout'; throw error; } };
  connector.emit = () => {};
  const result = await connector.executeCommand({ action: 'settings.set', args: {
    threadId: 'task-1', title: 'Known Desktop task', settings: { collaborationMode: 'plan' },
  } });
  assert.equal(result.queued, true);
  assert.equal(result.modeSyncState, 'pending');
});

test('applies a pending Desktop plan through the Desktop owner after the active turn becomes idle', async () => {
  const connector = Object.create(Connector.prototype);
  connector.defaultModelId = 'gpt-default';
  connector.threadState = new Map([['task-1', {
    collaborationMode: 'default',
    effectiveCollaborationMode: 'default',
    desiredCollaborationMode: 'plan',
    modeSyncState: 'pending',
    pendingDesktopSettings: { threadId: 'task-1', title: 'Known Desktop task', collaborationMode: 'plan' },
  }]]);
  connector.desktopStatuses = new Map([['task-1', 'completed']]);
  connector.codex = { request: async () => assert.fail('pending Desktop plan must use the Desktop owner') };
  connector.desktopAdapter = { settings: async () => ({
    effectiveCollaborationMode: 'plan', desiredCollaborationMode: 'plan', modeSyncState: 'applied',
  }) };
  const emitted = []; connector.emit = (kind, threadId, value) => emitted.push({ kind, threadId, value });

  await connector.retryPendingDesktopSettings();

  const state = connector.threadState.get('task-1');
  assert.equal(state.effectiveCollaborationMode, 'plan');
  assert.equal(state.modeSyncState, 'applied');
  assert.equal(state.pendingDesktopSettings, null);
  assert.equal(emitted.some((item) => item.kind === 'thread.settings' && item.value.applied), true);
});

test('keeps a pending Desktop plan untouched while the current turn is running', async () => {
  const connector = Object.create(Connector.prototype);
  const pending = { threadId: 'task-1', title: 'Known Desktop task', collaborationMode: 'plan' };
  connector.threadState = new Map([['task-1', {
    collaborationMode: 'default', modeSyncState: 'pending', pendingDesktopSettings: pending,
  }]]);
  connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
  connector.desktopAdapter = { settings: async () => assert.fail('must not touch a running Desktop composer') };

  await connector.retryPendingDesktopSettings();

  assert.equal(connector.threadState.get('task-1').pendingDesktopSettings, pending);
});

test('keeps a transiently unavailable Desktop plan pending for retry', async () => {
  const connector = Object.create(Connector.prototype);
  connector.defaultModelId = 'gpt-default';
  connector.threadState = new Map([['task-1', {
    model: 'gpt-default', collaborationMode: 'default', modeSyncState: 'pending',
    pendingDesktopSettings: { threadId: 'task-1', title: 'Known Desktop task', collaborationMode: 'plan' },
  }]]);
  connector.desktopStatuses = new Map([['task-1', 'completed']]);
  connector.codex = { request: async () => assert.fail('pending plan should retry through the Desktop adapter') };
  connector.desktopAdapter = { settings: async () => {
    const error = new Error('Codex Desktop composer is not available'); error.code = 'composer_unavailable'; throw error;
  } };

  await connector.retryPendingDesktopSettings();

  const state = connector.threadState.get('task-1');
  assert.equal(state.pendingDesktopSettings.collaborationMode, 'plan');
  assert.equal(state.modeSyncState, 'pending');
  assert.ok(state.pendingDesktopSettingsNextRetryAt > Date.now());
});

test('starts a known task directly after a connector restart when no busy status is known', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map(); connector.followups = memoryFollowups();
  connector.desktopAdapter = { dispatch: async () => assert.fail('restart must not force queueing') }; connector.emit = () => {};
  connector.executeCommand = async () => ({ started: true });
  const result = await connector.command({ requestId: 'req-restarted', action: 'turn.start',
    args: { threadId: 'task-1', title: 'Known Desktop task', text: 'next after restart' } }, 'phone-1');
  assert.deepEqual(result, { started: true });
});

test('removes a local queue item even when Desktop no longer exposes its cancel control', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups(); connector.emit = () => {}; connector.log = () => {};
  connector.followups.add({ id: 'stale-1', requestId: 'stale-1', threadId: 'task-1', text: 'stale', state: 'uncertain' });
  connector.desktopAdapter = { cancel: async () => { throw new Error('cancel control not found'); } };
  const result = await connector.cancelFollowup('stale-1', 'phone-1');
  assert.equal(result.cancelled, true);
  assert.equal(connector.followups.items.length, 0);
});

test('steers the exact existing Desktop queue item without dispatching a duplicate', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups();
  connector.followups.add({ id: 'queued-1', requestId: 'queued-1', threadId: 'task-1', title: 'Task', text: 'existing', displayText: 'existing', state: 'desktop_queued' });
  const calls = []; const events = [];
  connector.desktopAdapter = {
    steer: async (item) => { calls.push(['steer', item.id]); return { code: 'steer_accepted' }; },
    dispatch: async () => assert.fail('must not insert the message again'),
  };
  connector.emit = (...args) => events.push(args);

  const result = await connector.command({ action: 'followup.steer', args: { id: 'queued-1', threadId: 'task-1' } }, 'phone-1');

  assert.equal(result.accepted, true);
  assert.deepEqual(calls, [['steer', 'queued-1']]);
  assert.equal(connector.followups.items.length, 0);
  assert.equal(events[0][0], 'steer.accepted');
});

test('steers every collapsed Desktop queue item in order without creating duplicates', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups();
  connector.followups.add({ id: 'queued-1', requestId: 'queued-1', threadId: 'task-1', text: 'first', displayText: 'first', state: 'desktop_queued', createdAt: 1 });
  connector.followups.add({ id: 'queued-2', requestId: 'queued-2', threadId: 'task-1', text: 'second', displayText: 'second', state: 'desktop_queued', createdAt: 2 });
  connector.followups.add({ id: 'queued-3', requestId: 'queued-3', threadId: 'task-1', text: 'third', displayText: 'third', state: 'desktop_queued', createdAt: 3 });
  const calls = []; const events = []; connector.emit = (...args) => events.push(args);
  connector.desktopAdapter = { steer: async (item) => { calls.push(item.id); return { code: 'steer_accepted' }; } };

  const result = await connector.command({ action: 'followup.steer_all', args: { threadId: 'task-1', ids: ['queued-3', 'queued-1', 'queued-2'] } }, 'phone-1');

  assert.equal(result.acceptedCount, 3);
  assert.deepEqual(calls, ['queued-1', 'queued-2', 'queued-3']);
  assert.equal(connector.followups.items.length, 0);
  assert.deepEqual(events.map((event) => event[0]), ['steer.accepted', 'steer.accepted', 'steer.accepted']);
});

test('stops batch steer when delivery is uncertain and preserves later items', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups(); connector.emit = () => {};
  connector.followups.add({ id: 'queued-1', requestId: 'queued-1', threadId: 'task-1', text: 'first', displayText: 'first', state: 'desktop_queued', createdAt: 1 });
  connector.followups.add({ id: 'queued-2', requestId: 'queued-2', threadId: 'task-1', text: 'second', displayText: 'second', state: 'desktop_queued', createdAt: 2 });
  const error = new Error('unknown result'); error.delivery = 'uncertain';
  let calls = 0; connector.desktopAdapter = { steer: async () => { calls += 1; throw error; } };

  const result = await connector.command({ action: 'followup.steer_all', args: { threadId: 'task-1', ids: ['queued-1', 'queued-2'] } }, 'phone-1');

  assert.equal(result.acceptedCount, 0);
  assert.equal(calls, 1);
  assert.equal(connector.followups.items.length, 2);
  assert.equal(connector.followups.get('queued-1').state, 'uncertain');
  assert.equal(connector.followups.get('queued-2').state, 'desktop_queued');
});

test('steers the original Desktop turn without creating a fork', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
  connector.followups = memoryFollowups(); connector.emit = () => {};
  const calls = []; connector.desktopAdapter = { dispatch: async (item) => calls.push(item) };
  const result = await connector.command({ requestId: 'req-2', action: 'turn.steer', args: { threadId: 'task-1', text: 'change direction' } }, 'phone-1');
  assert.equal(result.accepted, true);
  assert.equal(calls[0].mode, 'steer');
  assert.equal(calls[0].threadId, 'task-1');
});

test('keeps a rejected Desktop steer in the original task queue without resending', async () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
  connector.followups = memoryFollowups();
  const events = []; connector.emit = (...args) => events.push(args);
  let calls = 0; connector.desktopAdapter = { dispatch: async () => { calls += 1; return { code: 'steer_deferred', message: 'queued by Desktop' }; } };
  const result = await connector.command({ requestId: 'req-deferred', action: 'turn.steer', args: { threadId: 'task-1', text: 'later' } }, 'phone-1');
  assert.equal(result.deferred, true);
  assert.equal(result.item.state, 'desktop_queued');
  assert.equal(result.item.mode, 'queue');
  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event[0]), ['followup.queued', 'steer.deferred']);
});

test('an uncertain Desktop send is never automatically retried', async () => {
  const connector = Object.create(Connector.prototype);
  connector.stopping = false; connector.followupRetryRunning = false; connector.followups = memoryFollowups(); connector.emit = () => {};
  const error = new Error('unknown result'); error.delivery = 'uncertain';
  let calls = 0; connector.desktopAdapter = { dispatch: async () => { calls += 1; throw error; } };
  const result = await connector.enqueueFollowup({ requestId: 'req-3', args: { threadId: 'task-1', text: 'next' } }, 'phone-1');
  assert.equal(result.item.state, 'uncertain');
  assert.equal(connector.followups.get(result.item.id).nextRetryAt, null);
  connector.followups.update(result.item.id, { nextRetryAt: Date.now() - 1 });
  await connector.retryFollowups();
  assert.equal(calls, 1, 'unknown delivery cannot become a second UI send');
});

test('a read-only probe timeout stays pending and retries without failure notices', async () => {
  const connector = Object.create(Connector.prototype);
  connector.stopping = false; connector.followupRetryRunning = false; connector.followups = memoryFollowups();
  const events = []; connector.emit = (kind) => events.push(kind);
  const error = new Error('unknown result'); error.delivery = 'uncertain';
  let calls = 0;
  connector.desktopAdapter = { probe: async () => {
    calls += 1;
    if (calls === 1) throw error;
    return { code: 'desktop_absent' };
  } };
  connector.executeQueuedBackgroundTurn = async () => {};
  const result = await connector.enqueueFollowup({ requestId: 'req-4', args: { threadId: 'task-1', text: 'next' } }, 'phone-1');
  assert.equal(result.item.state, 'pending');
  assert.equal(connector.followups.get(result.item.id).deliveryPhase, 'probe');
  connector.followups.update(result.item.id, { nextRetryAt: Date.now() - 1 });
  await connector.retryFollowups();
  assert.equal(calls, 2);
  assert.equal(connector.followups.get(result.item.id).state, 'started');
  assert.equal(connector.followups.get(result.item.id).blocking, false);
  assert.equal(events.includes('followup.failed'), false);
});

test('Desktop-owned plain text uses the protocol queue and never UI dispatch', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups(); connector.emit = () => {};
  connector.desktopAdapter = { probe: async () => ({ code: 'task_active' }), dispatch: () => assert.fail('must not navigate Desktop') };
  connector.markDesktopThread = () => {};
  const calls = [];
  connector.codex = { request: async (method, args) => { calls.push({ method, args }); return { queuedSubmission: { id: 'native-1' } }; } };
  const result = await connector.enqueueFollowup({ requestId: 'plain-1', args: { threadId: 'task-1', text: 'plain text' } }, 'phone');
  assert.equal(result.item.state, 'desktop_queued');
  assert.equal(connector.followups.get('plain-1').codexQueueId, 'native-1');
  assert.equal(calls[0].method, 'thread/queue/add');
  assert.equal(calls[0].args.clientUserMessageId, 'plain-1');
  assert.equal(connector.followups.get('plain-1').queueTransport, 'codex');
});

test('an async answer steers its exact existing queue row after the writer-busy fallback without another send', async () => {
  const connector = Object.create(Connector.prototype), calls = [];
  connector.followups = memoryFollowups(); connector.emit = () => {}; connector.log = () => {};
  connector.desktopAdapter = {
    probe: async () => ({ code: 'desktop_absent' }),
    steer: async item => { calls.push(['steer', item.codexQueueId, item.displayText]); return { code: 'steer_accepted' }; },
  };
  connector.markDesktopThread = () => {};
  connector.executeQueuedBackgroundTurn = async () => { throw new Error('thread is already open in another app'); };
  connector.codex = { request: async (method, args) => {
    calls.push([method]); assert.equal(method, 'thread/queue/add');
    return { queuedSubmission: { id: 'exact-native-row', clientUserMessageId: args.clientUserMessageId, input: args.input } };
  } };
  const text = '<send_user_message_question_reply>\n[{"questionItemId":"test-question","question":"中文问题","answer":"中文回答"}]\n</send_user_message_question_reply>';
  const result = await connector.enqueueFollowup({ requestId: 'async-answer', action: 'turn.steer', args: { threadId: 'task-1', text } }, 'phone');
  assert.equal(result.accepted, true); assert.equal(result.steered, true);
  assert.deepEqual(calls, [['thread/queue/add'], ['steer', 'exact-native-row', text]]);
  assert.equal(connector.followups.get('async-answer').state, 'started');
});

test('an immediate answer to a connector-owned busy turn does not wait for completion or start another turn', async () => {
  const connector = Object.create(Connector.prototype), commands = [];
  connector.followups = memoryFollowups(); connector.emit = () => {};
  connector.threadOwner = () => ({ owner: 'khlink' });
  connector.isBridgeOwnedThread = () => true;
  connector.desktopStatuses = new Map([['task-1', 'mobile_running']]);
  connector.desktopAdapter = { probe: () => assert.fail('the original host owns this turn') };
  connector.executeSerializedCommand = async command => { commands.push(command); return { turnId: 'existing-turn' }; };
  const result = await connector.enqueueFollowup({ requestId: 'own-answer', action: 'turn.steer', args: { threadId: 'task-1', text: 'reply' } }, 'phone');
  assert.equal(result.steered, true); assert.equal(result.queued, false);
  assert.equal(commands.length, 1); assert.equal(commands[0].action, 'turn.steer');
  assert.equal(commands[0].args.threadId, 'task-1');
});

test('a historical question from an older phone still uses the exact native send-now row', async () => {
  const connector = Object.create(Connector.prototype), calls = [];
  connector.followups = memoryFollowups(); connector.emit = () => {}; connector.log = () => {};
  connector.markDesktopThread = () => {};
  connector.desktopAdapter = {
    probe: async () => ({ code: 'task_active' }),
    steer: async item => { calls.push(['steer', item.codexQueueId]); return { code: 'steer_accepted' }; },
  };
  connector.codex = { request: async (method, args) => {
    calls.push([method, args.input[0].text]);
    return { queuedSubmission: { id: 'answer-row', clientUserMessageId: args.clientUserMessageId, input: args.input } };
  } };
  const text = '<send_user_message_question_reply>\n[{"questionItemId":"question-1","question":"去哪儿？","answer":"公园"}]\n</send_user_message_question_reply>';
  const result = await connector.enqueueFollowup({ requestId: 'historical-answer', action: 'turn.start', args: { threadId: 'task-1', text } }, 'phone');
  assert.equal(result.steered, true);
  assert.deepEqual(calls, [['thread/queue/add', text], ['steer', 'answer-row']]);
});

test('explicitly queued text keeps its queue intent even if it contains a question reply', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups(); connector.emit = () => {};
  connector.dispatchFollowup = async item => item;
  const text = '<send_user_message_question_reply>[{"questionItemId":"q","question":"去哪儿","answer":"公园"}]</send_user_message_question_reply>';
  const result = await connector.enqueueFollowup({ requestId: 'queued-answer', action: 'followup.enqueue', args: { threadId: 'task-1', text } }, 'phone');
  assert.equal(result.item.queueRequested, true);
  assert.equal(connector.followups.get('queued-answer').steerRequested, false);
});

test('a managed question answered after completion starts once after a definite no-active-turn rejection', async () => {
  const connector = Object.create(Connector.prototype), actions = [];
  connector.executeSerializedCommand = async command => {
    actions.push(command.action);
    if (command.action === 'turn.steer') throw new Error('No active turn is available for this task');
    return { turn: { id: 'new-turn' } };
  };
  await connector.executeQueuedBackgroundTurn({ threadId: 'task-1', requestId: 'answer-1', text: 'answer', steerRequested: true });
  assert.deepEqual(actions, ['turn.steer', 'turn.start']);
  actions.length = 0;
  connector.executeSerializedCommand = async command => {
    actions.push(command.action);
    throw Object.assign(new Error('No active turn reply lost'), { delivery: 'uncertain' });
  };
  await assert.rejects(connector.executeQueuedBackgroundTurn({ threadId: 'task-1', steerRequested: true }), /reply lost/);
  assert.deepEqual(actions, ['turn.steer']);
});

test('unconfirmed desktop navigation stops after three attempts without writing or discarding the answer', async () => {
  const connector = Object.create(Connector.prototype), events = [];
  connector.followups = memoryFollowups(); connector.emit = kind => events.push(kind);
  connector.desktopAdapter = { probe: async () => ({ code: 'desktop_other_task' }) };
  connector.openCodexThreadOnDesktop = async () => {
    throw Object.assign(new Error('target not confirmed'), { code: 'task_identity_unconfirmed', delivery: 'not_sent' });
  };
  connector.executeQueuedBackgroundTurn = () => assert.fail('must not write another task');
  const input = { requestId: 'blocked-answer', action: 'turn.steer', args: { threadId: 'task-1', text: '公园' } };
  await connector.enqueueFollowup(input, 'phone');
  const item = connector.followups.get(input.requestId);
  assert.equal(item.state, 'pending');
  await connector.dispatchFollowup(item);
  assert.equal(item.state, 'pending');
  await connector.dispatchFollowup(item);
  assert.equal(item.state, 'failed');
  assert.equal(item.text, '公园');
  assert.equal(item.attempts, 3);
  assert.equal(events.at(-1), 'followup.failed');
});

test('a lost protocol queue reply is reconciled from its receipt without a second queue write', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups(); connector.stopping = false;
  connector.desktopAdapter = { probe: async () => ({ code: 'task_active' }) };
  connector.markDesktopThread = () => {};
  const events = []; connector.emit = (kind) => events.push(kind);
  const error = new Error('queue reply lost'); error.delivery = 'uncertain';
  const ids = []; connector.codex = { request: async (_method, args) => { ids.push(args.clientUserMessageId); if (ids.length === 1) throw error; return { queuedSubmission: { id: 'native-1' } }; } };
  const result = await connector.enqueueFollowup({ requestId: 'plain-2', args: { threadId: 'task-1', text: 'plain text' } }, 'phone');
  assert.equal(result.item.state, 'uncertain');
  connector.followups.update('plain-2', { nextRetryAt: 0 });
  await connector.retryFollowups();
  assert.deepEqual(ids, ['plain-2']);
  connector.codex = { mode: 'host', ready: true, request: async (method) => {
    assert.equal(method, 'thread/queue/list');
    return { data: [{ id: 'native-1', clientUserMessageId: 'plain-2' }] };
  } };
  connector.confirmCodexHostThread = async () => false;
  await connector.reconcileCodexProtocolFollowups();
  assert.equal(connector.followups.get('plain-2').state, 'desktop_queued');
  assert.equal(events.filter((kind) => kind === 'followup.failed').length, 1);
});

test('interrupted UI sends stay uncertain, while interrupted probes can retry', () => {
  const connector = Object.create(Connector.prototype); connector.followups = memoryFollowups();
  for (const [id, phase] of [['probe', 'probe'], ['ui', 'desktop_dispatch'], ['legacy', null], ['queue', 'codex_queue']])
    connector.followups.add({ id, requestId: id, threadId: 'task-1', mode: 'queue', deliveryPhase: phase, state: 'dispatching' });
  connector.recoverInterruptedFollowups();
  assert.equal(connector.followups.get('probe').state, 'pending');
  assert.equal(connector.followups.get('queue').state, 'uncertain');
  assert.equal(connector.followups.get('ui').state, 'uncertain');
  assert.equal(connector.followups.get('legacy').state, 'uncertain');
});

test('cancels a protocol queue row without addressing a Desktop button', async () => {
  const connector = Object.create(Connector.prototype); connector.followups = memoryFollowups();
  connector.followups.add({ id: 'one', requestId: 'one', threadId: 'task-1', state: 'desktop_queued', queueTransport: 'codex', codexQueueId: 'native-1' });
  connector.desktopAdapter = { cancel: () => assert.fail('protocol queue must not use UI cleanup') };
  connector.emit = () => {}; connector.releaseFollowupAttachments = () => {};
  const calls = []; connector.codex = { request: async (method, args) => { calls.push({ method, args }); return {}; } };
  assert.equal((await connector.cancelFollowup('one', 'phone', 'task-1')).cancelled, true);
  assert.deepEqual(calls, [{ method: 'thread/queue/delete', args: { threadId: 'task-1', queuedSubmissionId: 'native-1' } }]);
});

test('a lost protocol cancellation reply retains its receipt instead of claiming success', async () => {
  const connector = Object.create(Connector.prototype); connector.followups = memoryFollowups();
  connector.followups.add({ id: 'one', requestId: 'one', threadId: 'task-1', state: 'desktop_queued', queueTransport: 'codex', codexQueueId: 'native-1' });
  connector.codex = { request: async () => { throw new Error('offline'); } };
  await assert.rejects(connector.cancelFollowup('one', 'phone', 'task-1'), /offline/);
  assert.equal(connector.followups.get('one').state, 'desktop_queued');
});

test('does not resume Codex for unrelated command failures', async () => {
  const connector = Object.create(Connector.prototype);
  connector.codex = { request: async () => assert.fail('unexpected resume') };
  connector.executeCommand = async () => { throw new Error('permission denied'); };

  await assert.rejects(
    connector.command({ action: 'turn.start', args: { threadId: 'task-1' } }),
    /permission denied/,
  );
});

test('does not resurrect a stale live rollout status on connector startup', async () => {
  const connector = Object.create(Connector.prototype);
  connector.stopping = false;
  const published = [];
  connector.publishThreadStatus = (threadId, status) => published.push([threadId, status]);
  connector.syncDesktopRollout = async () => {};

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-stale-rollout-'));
  const threadId = '019f191a-2ed0-7cf1-9f33-92e3bf5871df';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  const oldAt = Date.now() - 11 * 60_000;
  fs.writeFileSync(file, JSON.stringify({ timestamp: oldAt ? new Date(oldAt).toISOString() : '', type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
  const old = new Date(oldAt);
  fs.utimesSync(file, old, old);

  try {
    await Connector.prototype.bootstrapRecentRolloutStatuses.call(connector, root);
    assert.deepEqual(published, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not resurrect a stale failed rollout status on connector startup', async () => {
  const connector = Object.create(Connector.prototype);
  connector.rolloutFilesByThread = new Map(); connector.hiddenRollouts = new Set();
  connector.reconcileStartedFollowups = () => {}; connector.syncDesktopRollout = async () => {};
  const published = []; connector.publishThreadStatus = (...args) => published.push(args);
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-stale-failed-rollout-'));
  const threadId = '019f191a-2ed0-7cf1-9f33-92e3bf5871df';
  const file = path.join(root, `rollout-${threadId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', error: { message: 'old failure' } } }) + '\n');
  const old = new Date(Date.now() - 11 * 60_000); fs.utimesSync(file, old, old);
  try {
    await Connector.prototype.bootstrapRecentRolloutStatuses.call(connector, root);
    assert.deepEqual(published, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('startup removes a delivered follow-up that predates the one-megabyte live tail', () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups(); connector.emit = () => {};
  connector.followups.add({ id: 'queued-1', requestId: 'queued-1', threadId: 'task-1', text: 'already delivered', state: 'desktop_queued', createdAt: Date.now() - 5000 });
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-followup-reconcile-'));
  const file = path.join(directory, 'rollout-task-1.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'already delivered' }] } })}\n${'x'.repeat(1024 * 1024 + 10)}\n`);
  try {
    connector.reconcileStartedFollowups('task-1', file);
    assert.equal(connector.followups.items.length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('reconciles a Desktop user message with prepended environment context', () => {
  const store = Object.create(FollowupStore.prototype);
  store.items = [{ id: 'queued-2', threadId: 'task-1', state: 'desktop_queued', createdAt: Date.now() - 1000,
    text: 'FENGZHU_ATTACHMENT_SYNC_OK\n\n[风筑附件] shot.png\n路径：C:\\Temp\\shot.png',
    displayText: 'FENGZHU_ATTACHMENT_SYNC_OK' }];
  store.remove = (id) => {
    const index = store.items.findIndex((item) => item.id === id);
    return index >= 0 ? store.items.splice(index, 1)[0] : null;
  };
  const matched = store.matchStarted('task-1', '<environment_context>...</environment_context> FENGZHU_ATTACHMENT_SYNC_OK [风筑附件] shot.png 路径：C:\\Temp\\shot.png');
  assert.equal(matched.id, 'queued-2');
  assert.equal(store.items.length, 0);
});

test('reconciles a short Desktop user message exactly', () => {
  const store = Object.create(FollowupStore.prototype);
  store.items = [{ id: 'queued-short', threadId: 'task-1', state: 'desktop_queued', createdAt: Date.now() - 1000,
    text: '处理好了吗', displayText: '处理好了吗' }];
  store.remove = (id) => {
    const index = store.items.findIndex((item) => item.id === id);
    return index >= 0 ? store.items.splice(index, 1)[0] : null;
  };
  const matched = store.matchStarted('task-1', '处理好了吗');
  assert.equal(matched.id, 'queued-short');
  assert.equal(store.items.length, 0);
});

test('does not execute a replayed request id twice', async () => {
  const connector = Object.create(Connector.prototype);
  connector.followups = memoryFollowups(); connector.emit = () => {}; connector.log = () => {};
  connector.followups.add({ id: 'idempotent-1', requestId: 'idempotent-1', threadId: 'task-1', text: 'already started', displayText: 'already started', mode: 'background', state: 'started', createdAt: Date.now() });
  let calls = 0; connector.executeCommand = async () => { calls += 1; return { started: true }; };
  const result = await connector.command({ requestId: 'idempotent-1', action: 'turn.start', args: { threadId: 'task-1', text: 'already started' } }, 'phone-1');
  assert.equal(calls, 0);
  assert.equal(result.duplicate, true);
  assert.equal(result.item.requestId, 'idempotent-1');
});

test('matches a direct background turn by its opaque request marker', () => {
  const store = Object.create(FollowupStore.prototype);
  const requestId = '019f191a-2ed0-7cf1-9f33-92e3bf5871df';
  store.items = [{ id: requestId, requestId, threadId: 'task-1', state: 'started', createdAt: Date.now() - 1000, text: 'hello' }];
  store.remove = (id) => {
    const index = store.items.findIndex((item) => item.id === id);
    return index >= 0 ? store.items.splice(index, 1)[0] : null;
  };
  const matched = store.matchStarted('task-1', `hello\n\n[KH_LINK_REQUEST_ID:${requestId}]`);
  assert.equal(matched.requestId, requestId);
  assert.equal(store.items.length, 0);
});

test('a stalled event loop is written to the log', async () => {
  const { Connector } = require('../src/connector');
  const connector = Object.create(Connector.prototype);
  const logged = []; connector.log = (error) => logged.push(String(error.message || error));
  connector.startStallWatch(20, 30);
  const until = Date.now() + 120; while (Date.now() < until) { /* block the loop */ }
  await new Promise((resolve) => setTimeout(resolve, 60));
  clearInterval(connector.stallTimer);
  assert.ok(logged.some((line) => /event loop stalled for/.test(line)), logged.join('\n'));
});

test('a stall names the blocking sync work that caused it', async () => {
  const { installSyncProbe, takeSyncTally } = require('../src/sync-probe');
  installSyncProbe();
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  takeSyncTally();
  const file = path.join(os.tmpdir(), `khlink-probe-${process.pid}.bin`);
  fs.writeFileSync(file, Buffer.alloc(64 * 1024 * 1024));
  fs.readFileSync(file);
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['-e', 'const t=Date.now();while(Date.now()-t<50){}']);
  fs.unlinkSync(file);
  const rows = takeSyncTally();
  assert.ok(rows.some((row) => /execFileSync/.test(row)), rows.join('\n'));
  assert.ok(rows.some((row) => /(read|write)FileSync .*khlink-probe/.test(row)), rows.join('\n'));
  assert.deepEqual(takeSyncTally(), [], 'the tally is cleared after each look');
});

test('coalesces Claude thread metadata saves into one write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-claude-threads-'));
  const connector = Object.create(Connector.prototype);
  connector.claudeThreadsFile = path.join(dir, 'claude-threads.json');
  connector.claudeThreads = new Map([['t1', { id: 't1', title: 'a' }]]);
  connector.log = (error) => { throw error; };
  let writes = 0;
  // The periodic save is written asynchronously, off the event loop.
  const write = connector.writeClaudeThreadsAsync;
  connector.writeClaudeThreadsAsync = function () { writes += 1; return write.call(this); };
  for (let i = 0; i < 20; i += 1) { connector.claudeThreads.get('t1').title = `v${i}`; connector.saveClaudeThreads(); }
  assert.equal(fs.existsSync(connector.claudeThreadsFile), false);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await connector._claudeThreadsWrite;
  assert.equal(writes, 1);
  assert.equal(JSON.parse(fs.readFileSync(connector.claudeThreadsFile, 'utf8')).threads[0].title, 'v19');
  // A pending save is written at once on shutdown.
  connector.claudeThreads.get('t1').title = 'last'; connector.saveClaudeThreads(); connector.flushClaudeThreads();
  assert.equal(JSON.parse(fs.readFileSync(connector.claudeThreadsFile, 'utf8')).threads[0].title, 'last');
  assert.equal(connector._claudeThreadsSaveTimer, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Desktop task that is running takes a settings change with its next turn', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map();
  connector.desktopStatuses = new Map([['task-1', 'desktop_running']]);
  connector.desktopAdapter = { settings: async () => assert.fail('a running Desktop task is not driven') };
  connector.codex = { request: async () => assert.fail('a running Desktop task is not written to') };
  connector.readThreadSettings = () => null;
  const emitted = []; connector.emit = (kind, threadId, value) => emitted.push({ kind, value });
  const result = await connector.executeCommand({ action: 'settings.set', args: { threadId: 'task-1', title: 'Known Desktop task', settings: { model: 'gpt-next', effort: 'high' } } });
  assert.equal(result.queued, true);
  assert.equal(result.reason, '电脑上正在运行，下一轮开始时切换');
  assert.equal(connector.threadState.get('task-1').pendingDesktopSettings.model, 'gpt-next');
  assert.ok(emitted.some((item) => item.kind === 'thread.settings' && item.value.queued === true));
});

test('a Desktop setting the menu does not offer is reported in Chinese at once', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['task-1', { model: 'gpt-default', modeSyncState: 'applied', pendingDesktopSettings: { threadId: 'task-1', title: 'Known Desktop task', model: 'gpt-missing' } }]]);
  connector.desktopStatuses = new Map([['task-1', 'completed']]);
  connector.desktopAdapter = { settings: async () => {
    const error = new Error('the settings submenu has no matching option; visible: GPT-5.5'); error.code = 'model_option_not_matched'; throw error;
  } };
  connector.codex = { request: async () => assert.fail('a Desktop-owned task is not written to') };
  const emitted = []; connector.emit = (kind, threadId, value) => emitted.push({ kind, value }); connector.log = () => {};
  await connector.retryPendingDesktopSettings();
  const state = connector.threadState.get('task-1');
  assert.equal(state.pendingDesktopSettings, null);
  assert.equal(state.modeSyncReason, '电脑端 Codex 里没有这个模型，请在电脑上选择');
  const event = emitted.find((item) => item.kind === 'thread.settings');
  assert.deepEqual([event.value.applied, event.value.reason], [false, '电脑端 Codex 里没有这个模型，请在电脑上选择']);
});

test('a Desktop setting whose menu did not open is kept and tried again, then reported after the last try', async () => {
  const connector = Object.create(Connector.prototype);
  const pending = { threadId: 'task-1', title: 'Known Desktop task', effort: 'high' };
  connector.threadState = new Map([['task-1', { modeSyncState: 'applied', pendingDesktopSettings: pending }]]);
  connector.desktopStatuses = new Map([['task-1', 'completed']]);
  connector.desktopAdapter = { settings: async () => {
    const error = new Error('the task settings menu did not open'); error.code = 'settings_menu_not_opened'; throw error;
  } };
  const emitted = []; connector.emit = (kind, threadId, value) => emitted.push({ kind, value }); connector.log = () => {};
  await connector.retryPendingDesktopSettings();
  let state = connector.threadState.get('task-1');
  assert.equal(state.pendingDesktopSettings, pending, 'the first failure keeps the setting');
  assert.equal(state.pendingDesktopSettingsAttempts, 1);
  assert.equal(state.modeSyncReason, '电脑端 Codex 的设置菜单没有打开，稍后会自动重试');
  for (let attempt = 2; attempt <= 6; attempt += 1) {
    state.pendingDesktopSettingsNextRetryAt = 0;
    await connector.retryPendingDesktopSettings();
    state = connector.threadState.get('task-1');
  }
  assert.equal(state.pendingDesktopSettings, null, 'after the last try it is reported and no longer retried');
  assert.equal(emitted.filter((item) => item.kind === 'thread.settings' && item.value.applied === false).length, 1);
});

test('a failure code from the Desktop adapter reaches the phone in Chinese, whatever its English wording', () => {
  const { phoneErrorText } = require('../src/connector');
  assert.equal(phoneErrorText('the settings submenu has no matching option', 'effort_option_not_matched'), '电脑端 Codex 里没有这个推理强度，请在电脑上选择');
  assert.equal(phoneErrorText('confirmation required', 'effort_confirmation_required'), '此推理强度需要在电脑端确认，请在电脑上选择');
  assert.equal(phoneErrorText('Desktop adapter timed out'), '电脑端 Codex 窗口没有及时响应，请稍后再试');
  assert.equal(phoneErrorText('Codex Desktop shows no running turn in this task', 'not_running'), '电脑端未检测到可停止的任务，请在电脑上检查这个对话的状态');
  assert.equal(phoneErrorText('failed to archive session: thread-store internal error: failed to archive thread: 系统无法将文件移到不同的磁盘驱动器。 (os error 17)'), 'Codex 的归档目录和会话文件不在同一磁盘，暂时无法归档；请在电脑检查归档目录设置。');
  assert.equal(phoneErrorText('failed to archive thread: Invalid cross-device link (os error 18)'), 'Codex 的归档目录和会话文件不在同一磁盘，暂时无法归档；请在电脑检查归档目录设置。');
  assert.equal(phoneErrorText('draft exists', 'plan_draft_present'), '电脑端有未发送的草稿，请先处理后再切换计划模式');
  assert.equal(phoneErrorText('some other failure'), 'some other failure');
});

test('a uniquely observed Desktop approval shows waiting without inventing a completion', () => {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map([['test-thread', 'desktop_running'], ['other', 'desktop_running']]);
  connector.emit = () => {}; connector.log = () => {};
  connector.applyDesktopApprovalObservation('test-thread', 'desktop_approval_pending');
  assert.equal(connector.desktopStatuses.get('test-thread'), 'desktop_waiting_approval');
  assert.equal(connector.desktopStatuses.get('other'), 'desktop_running');
  assert.equal(connector.turnStatus('test-thread', 'running'), 'desktop_waiting_approval');
  connector.applyDesktopApprovalObservation('test-thread', undefined);
  assert.equal(connector.desktopStatuses.get('test-thread'), 'desktop_waiting_approval', 'an old adapter response cannot clear it');
  connector.applyDesktopApprovalObservation('test-thread', 'desktop_approval_pending', 'protocol');
  connector.applyDesktopApprovalObservation('test-thread', 'desktop_approval_clear');
  assert.equal(connector.desktopStatuses.get('test-thread'), 'desktop_waiting_approval', 'one source cannot clear another');
  connector.applyDesktopApprovalObservation('test-thread', 'desktop_approval_clear', 'protocol');
  assert.equal(connector.desktopStatuses.get('test-thread'), 'desktop_running');
  connector.applyDesktopApprovalObservation('test-thread', 'desktop_approval_pending');
  connector.publishThreadStatus('test-thread', 'completed');
  connector.applyDesktopApprovalObservation('test-thread', 'desktop_approval_clear');
  assert.equal(connector.desktopStatuses.get('test-thread'), 'completed', 'a late UI snapshot must not reopen a completed turn');
  connector.applyDesktopApprovalObservation('test-thread', 'desktop_approval_pending');
  assert.equal(connector.desktopStatuses.get('test-thread'), 'completed', 'a late approval observation must not reopen a completed turn');
  connector.applyDesktopApprovalObservation('after-restart', 'desktop_approval_pending');
  assert.equal(connector.desktopStatuses.get('after-restart'), 'desktop_waiting_approval', 'a live Desktop approval restores waiting after restart even without a cached running status');
  connector.applyDesktopApprovalObservation('after-restart', 'desktop_approval_clear');
  assert.equal(connector.desktopStatuses.get('after-restart'), 'desktop_running');
});

test('a queued mode-only change does not add an unchanged desktop model', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['test-thread', { model: 'gpt-6-astra', collaborationMode: 'default' }]]);
  connector.emit = () => {};
  connector.queuePendingSettings({ threadId: 'test-thread', title: 'Test', settings: { collaborationMode: 'plan' } }, 'test');
  const pending = connector.threadState.get('test-thread').pendingDesktopSettings;
  assert.equal(pending.collaborationMode, 'plan');
  assert.equal(pending.model, undefined);
  let request;
  connector.buildThreadSettingsUpdate = async () => ({ threadId: 'test-thread', collaborationMode: { mode: 'plan', settings: { model: 'gpt-6-astra' } } });
  connector.applyCollaborationModeSettings = async (value) => { request = value; return { effectiveCollaborationMode: 'plan' }; };
  await connector.applyPendingDesktopSettings({ threadId: 'test-thread' });
  assert.equal(request.model, undefined, 'the UI should only change the requested mode');
});

test('an immediate mode-only change keeps the protocol model but does not change it on Desktop', async () => {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map([['test-thread', { model: 'gpt-6-astra', collaborationMode: 'default' }]]);
  connector.desktopStatuses = new Map([['test-thread', 'completed']]);
  connector.connectorRunsThread = () => false;
  connector.emit = () => {};
  let changed, request;
  connector.buildThreadSettingsUpdate = async (_id, _next, value) => { changed = value; return { threadId: 'test-thread' }; };
  connector.applyCollaborationModeSettings = async (value) => { request = value; return { effectiveCollaborationMode: 'plan' }; };
  await connector.executeCommand({ action: 'settings.set', args: { threadId: 'test-thread', title: 'Test', settings: { collaborationMode: 'plan' } } });
  assert.equal(changed.model, 'gpt-6-astra', 'the protocol fallback still has the current model');
  assert.equal(request.model, undefined, 'the Desktop UI should not touch the model');
  assert.equal(request.collaborationMode, 'plan');
});
