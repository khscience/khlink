const test = require('node:test');
const assert = require('node:assert/strict');
const { Connector } = require('../src/connector');
const { DesktopAdapter } = require('../src/desktop-adapter');

function fixture() {
  const self = Object.create(Connector.prototype);
  self.followups = {
    items: [],
    get(id) { return this.items.find(row => row.id === id); },
    add(row) { this.items.push(row); return row; },
    update(id, changes) { const row = this.get(id); if (row) Object.assign(row, changes); return row; },
    list(id) { return this.items.filter(row => row.threadId === id); },
    remove(id) { this.items = this.items.filter(row => row.id !== id); },
  };
  self.threadState = new Map(); self.mobileOwnedThreads = new Set(); self.desktopStatuses = new Map();
  self.events = []; self.emit = (kind, id, data) => self.events.push({ kind, id, data }); self.log = () => {};
  self.markDesktopThread = () => {}; self.executeCommand = () => assert.fail('must not start a second writer');
  self.executeQueuedBackgroundTurn = () => assert.fail('must not resume the Desktop task in the background');
  self.calls = [];
  self.codex = { request: async (method, params) => {
    self.calls.push([method, params]);
    assert.equal(method, 'thread/queue/add');
    return { queuedSubmission: { id: 'queue-1', clientUserMessageId: params.clientUserMessageId, input: params.input } };
  } };
  return self;
}

const request = (args = {}) => ({ action: 'turn.start', requestId: 'once',
  args: { threadId: 'thread-04', title: '04 task', text: 'message', ...args } });

test('a durable Desktop queue receipt stays waiting when the recent active list omits the running thread', async () => {
  const self = fixture(); self.desktopActivitySnapshotHealthy = true; self.desktopActiveThreads = new Set();
  self.desktopAdapter = { probe: async () => ({ code: 'task_active' }) };
  const result = await self.command({ ...request(), action: 'followup.enqueue' }, 'phone');
  assert.equal(result.item.state, 'desktop_queued'); assert.equal(result.item.blocking, true); assert.equal(result.item.queueRequested, true);
  assert.equal(self.calls.length, 1);
  for (const event of self.events.filter(row => row.kind === 'followup.queued')) assert.equal(event.data.blocking, true);
});

test('an idle safe handoff is not presented as executed until the formal queue is consumed', async () => {
  const self = fixture(); self.desktopActiveThreads = new Set();
  self.desktopAdapter = { probe: async () => ({ code: 'task_active' }) };
  const result = await self.command(request(), 'phone');
  assert.equal(result.item.state, 'desktop_queued'); assert.equal(result.item.blocking, true);
  assert.equal(result.item.queueRequested, false);
});

for (const explicitlyQueued of [false, true]) {
  test(`${explicitlyQueued ? 'an explicitly queued' : 'an ordinary'} Desktop text is handed to the Desktop queue without steering`, async () => {
    const self = fixture(); const calls = []; const windowRequests = [];
    self.desktopAdapter = { probe: async () => ({ code: 'task_active' }) };
    self.codex.request = async (method, params) => {
      calls.push(method);
      if (method === 'thread/queue/add') return { queuedSubmission: { id: 'q1', clientUserMessageId: params.clientUserMessageId } };
      assert.equal(method, 'thread/queue/delete'); return {};
    };
    self.codexDesktopSteer = { steer: async value => { windowRequests.push(value); return { code: 'queued', delivery: 'confirmed' }; } };
    const result = await self.command({ ...request(), ...(explicitlyQueued ? { action: 'followup.enqueue' } : {}) }, 'phone');
    assert.equal(result.item.state, 'desktop_queued');
    assert.equal(self.followups.get('once').queueTransport, 'desktop');
    assert.equal(windowRequests[0].mode, 'queue');
    assert.deepEqual(calls, ['thread/queue/add', 'thread/queue/delete']);
  });
}

test('an ordinary Desktop text starts immediately when the actual window is idle', async () => {
  const self = fixture(); const calls = [];
  self.desktopAdapter = { probe: async () => ({ code: 'task_active' }) };
  self.codex.request = async (method, params) => {
    calls.push(method);
    return method === 'thread/queue/add' ? { queuedSubmission: { id: 'q1', clientUserMessageId: params.clientUserMessageId } } : {};
  };
  self.codexDesktopSteer = { steer: async value => { assert.equal(value.mode, 'queue'); return { code: 'sent', delivery: 'confirmed' }; } };
  const result = await self.command(request(), 'phone');
  assert.equal(result.accepted, true); assert.equal(result.queued, false);
  assert.equal(self.followups.get('once').state, 'started');
  assert.deepEqual(calls, ['thread/queue/add', 'thread/queue/delete']);
});

test('a structured async answer uses steer and retains the exact question envelope', async () => {
  const self = fixture(); const calls = []; const windowRequests = [];
  self.desktopAdapter = { probe: async () => ({ code: 'task_active' }) };
  self.codex.request = async (method, params) => {
    calls.push(method);
    return method === 'thread/queue/add' ? { queuedSubmission: { id: 'q1', clientUserMessageId: params.clientUserMessageId } } : {};
  };
  self.codexDesktopSteer = { steer: async value => { windowRequests.push(value); return { code: 'steer_accepted', delivery: 'confirmed' }; } };
  const answer = '<send_user_message_question_reply>\n[{"questionItemId":"题目","question":"想去哪？","answer":"公园"}]\n</send_user_message_question_reply>';
  const result = await self.command({ ...request({ text: answer }), action: 'turn.steer' }, 'phone');
  assert.equal(result.accepted, true); assert.equal(windowRequests[0].mode, 'steer');
  assert.equal(windowRequests[0].text, answer);
  assert.deepEqual(calls, ['thread/queue/add', 'thread/queue/delete']);
});

test('a legacy nonblocking queue row is repaired by positive queue presence, without resending it', async () => {
  const self = fixture(); self.followups.add({ id: 'once', requestId: 'once', threadId: 'thread-04', state: 'desktop_queued', queueTransport: 'codex', blocking: false });
  const calls=[]; self.codex={mode:'host',ready:true,request:async method=>{calls.push(method);return{data:[{id:'queue-1',clientUserMessageId:'once'}]};}};
  self.confirmCodexHostThread=async()=>false;
  await self.reconcileCodexProtocolFollowups();
  assert.equal(self.followups.get('once').blocking,true);
  assert.deepEqual(calls,['thread/queue/list']);assert.equal(self.events.at(-1).data.blocking,true);
});

for (const code of ['desktop_other_task', 'desktop_present']) {
  for (const asError of [false, true]) {
    test(`${code}, reported as ${asError ? 'an adapter error' : 'a probe result'}, opens Desktop before queuing once`, async () => {
      const self = fixture(); const operations = [];
      self.desktopAdapter = {
        probe: async () => { if (asError) throw Object.assign(new Error('Desktop is open'), { code, delivery: 'not_sent' }); return { code }; },
        openThread: async item => { operations.push(`open:${item.threadId}`); },
        dispatch: () => assert.fail('must use a durable protocol queue instead of entering text'),
      };
      const rpc = self.codex.request;
      self.codex.request = async (...args) => { operations.push(args[0]); return rpc(...args); };
      const result = await self.command(request(), 'phone');
      assert.equal(result.item.state, 'desktop_queued');
      assert.deepEqual(operations, ['open:thread-04', 'thread/queue/add']);
      await self.command(request(), 'phone');
      assert.equal(self.calls.length, 1, 'a repeated mobile frame does not queue it twice');
    });
  }
}

test('an already loaded Desktop task queues without opening it or replacing its draft', async () => {
  const self = fixture(); self.desktopAdapter = { probe: async () => ({ code: 'task_active' }),
    openThread: () => assert.fail('must preserve the foreground task and draft') };
  const result = await self.command(request(), 'phone');
  assert.equal(result.item.state, 'desktop_queued'); assert.equal(self.calls.length, 1);
});

test('failed read-only Desktop navigation leaves a retryable unsent item and never writes a queue row', async () => {
  const self = fixture(); self.desktopAdapter = { probe: async () => ({ code: 'desktop_other_task' }),
    openThread: async () => { throw Object.assign(new Error('navigation timed out'), { delivery: 'uncertain', action: 'open_thread' }); } };
  const result = await self.command(request(), 'phone');
  assert.equal(result.item.state, 'pending'); assert.equal(self.calls.length, 0);
  assert.equal(self.events.some(row => row.kind === 'followup.failed'), false);
});

test('an unknown Desktop probe error cannot authorize taking over a conversation', async () => {
  const self = fixture(); self.desktopAdapter = { probe: async () => { throw new Error('UI Automation unavailable'); } };
  const result = await self.command(request(), 'phone');
  assert.equal(result.item.state, 'pending'); assert.equal(self.calls.length, 0);
});

test('Desktop absence still allows mobile background execution', async () => {
  const self = fixture(); self.desktopAdapter = { probe: async () => {
    throw Object.assign(new Error('Codex Desktop was not found'), { code: 'desktop_not_ready', delivery: 'not_sent' });
  } };
  let starts = 0; self.executeCommand = async () => { starts++; return { started: true }; };
  assert.equal((await self.command(request(), 'phone')).started, true); assert.equal(starts, 1);
});

test('opening an untitled mobile request resolves only metadata and retains images in the protocol queue', async () => {
  const self = fixture(); const opened = []; const rpc = self.codex.request;
  self.codex.request = async (method, params) => {
    if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread: { id: 'thread-04', name: '04 task' } }; }
    return rpc(method, params);
  };
  self.desktopAdapter = { probe: async () => ({ code: 'desktop_other_task' }), openThread: async item => opened.push(item) };
  const result = await self.command(request({ title: null, attachments: [{ path: 'C:\\Temp\\photo.png', name: 'photo.png' }] }), 'phone');
  assert.equal(result.item.state, 'desktop_queued'); assert.equal(opened[0].title, '04 task');
  assert.equal(self.calls[0][1].input.some(part => part.type === 'localImage'), true);
});

test('Desktop navigation is a distinct non-submitting adapter request', async () => {
  const adapter = new DesktopAdapter({}); let observed;
  adapter.call = async (payload, timeout) => { observed = { payload, timeout }; return { ok: true }; };
  await adapter.openThread({ threadId: '04', title: 'Task', text: 'must never enter this', attachments: [{}] });
  assert.deepEqual(observed.payload, { action: 'open_thread', threadId: '04', title: 'Task' });
  assert.equal(observed.timeout, 30_000);
});

test('a completed turn after light reload still releases its persistent host even when its memory set is empty', async () => {
  const self = fixture(); let restarted = 0; const operations = [];
  self.threadOwnership = { get: () => ({ owner: 'khlink', hostPid: 123 }) };
  self.codex = { mode: 'host', ready: true, host: { state: { pid: 123 } }, request: async method => {
    operations.push(method); return method === 'thread/loaded/list' ? { data: [] } : { status: 'unsubscribed' };
  }, restart: async () => { restarted++; } };
  self.writeStatus = () => {};
  await self.afterMobileTurn('thread-04');
  assert.equal(operations[0], 'thread/unsubscribe'); assert.equal(restarted, 1);
  assert.equal(self.idleHostReleaseRequested, false);
});

test('a host release deferred by another active turn retries later without interrupting that turn', async () => {
  const self = fixture(); let active = true; let restarted = 0;
  self.threadOwnership = { get: () => ({ owner: 'khlink', hostPid: 123 }) };
  self.codex = { mode: 'host', ready: true, host: { state: { pid: 123 } }, request: async method => {
    if (method === 'thread/loaded/list') return { data: ['other-task'] };
    if (method === 'thread/read') return { thread: { status: { type: active ? 'active' : 'idle' } } };
    return { status: 'unsubscribed' };
  }, restart: async () => { assert.equal(active, false); restarted++; } };
  self.writeStatus = () => {};
  await self.afterMobileTurn('thread-04');
  assert.equal(restarted, 0); assert.equal(self.idleHostReleaseRequested, true);
  active = false;
  await self.retryFollowups();
  assert.equal(restarted, 1); assert.equal(self.idleHostReleaseRequested, false);
});

test('a terminal event for another host cannot authorize releasing our current writer', async () => {
  const self = fixture(); self.threadOwnership = { get: () => ({ owner: 'khlink', hostPid: 100 }) };
  self.codex = { mode: 'host', ready: true, host: { state: { pid: 200 } }, request: () => assert.fail('wrong host'),
    restart: () => assert.fail('wrong host') };
  await self.afterMobileTurn('thread-04'); assert.equal(self.idleHostReleaseRequested, undefined);
});

test('a two-minute advisory lease from a recycled host cannot bypass the Desktop probe', () => {
  const self = fixture(); self.threadOwnership = { get: () => ({ owner: 'khlink', hostPid: 100 }) };
  self.codex = { mode: 'host', ready: true, host: { state: { pid: 200 } } };
  assert.equal(self.isBridgeOwnedThread('thread-04'), false);
});

test('an idle host recycle releases only the advisory leases of the writer it actually replaced', async () => {
  const self = fixture(); const released = [];
  self.threadOwnership = { list: () => [
    { threadId: 'old-task', owner: 'khlink', hostPid: 100 },
    { threadId: 'new-task', owner: 'khlink', hostPid: 200 },
    { threadId: 'desktop-task', owner: 'desktop', hostPid: 100 },
  ] };
  self.releaseThreadOwner = id => released.push(id); self.writeStatus = () => {};
  self.codex = { mode: 'host', ready: true, host: { state: { pid: 100 } },
    request: async () => ({ data: [] }), restart: async () => { self.codex.host.state.pid = 200; } };
  assert.equal(await self.recycleIdleCodexHost(), true);
  assert.deepEqual(released, ['old-task']);
});

test('a Desktop turn that thread/list calls notLoaded can still be immediately steered exactly once', async () => {
  const self = fixture(); self.desktopActivitySnapshotHealthy = true; self.desktopActiveThreads = new Set();
  self.desktopStatuses.set('thread-04', 'desktop_running');
  const steers = [];
  self.desktopAdapter = { probe: async () => ({ code: 'task_active' }), steer: async item => { steers.push(item); return { code: 'steer_accepted' }; },
    dispatch: () => assert.fail('must not replace the Desktop draft') };
  const input = { ...request(), action: 'turn.steer' };
  assert.equal((await self.command(input, 'phone')).accepted, true);
  assert.equal(self.followups.get('once').state, 'started');
  assert.equal(steers[0].codexQueueId, 'queue-1');
  await self.command(input, 'phone');
  assert.equal(self.calls.length, 1); assert.equal(steers.length, 1);
});

test('an immediate Desktop request stays in the existing queue when its steer button is no longer available', async () => {
  const self = fixture(); self.desktopAdapter = { probe: async () => ({ code: 'task_active' }),
    steer: async () => { throw Object.assign(new Error('matching queue row was already consumed'), { delivery: 'not_sent' }); } };
  const result = await self.command({ ...request(), action: 'turn.steer' }, 'phone');
  assert.equal(result.deferred, true); assert.equal(self.calls.length, 1);
  assert.equal(self.followups.get('once').state, 'desktop_queued');
});

test('a lost native steer receipt never issues a second queue/add or clicks Steer again', async () => {
  const self = fixture(); let steers = 0;
  self.desktopAdapter = { probe: async () => ({ code: 'task_active' }), steer: async () => {
    steers++; throw Object.assign(new Error('native receipt timed out'), { delivery: 'uncertain' });
  } };
  const input = { ...request(), action: 'turn.steer' };
  assert.equal((await self.command(input, 'phone')).uncertain, true);
  await self.command(input, 'phone');
  assert.equal(self.calls.length, 1); assert.equal(steers, 1);
});

test('a Desktop-looking badge after reload cannot route stopping a managed turn into another writer', async () => {
  const self = fixture(); self.executeCommand = Connector.prototype.executeCommand;
  self.threadOwnership = { get: () => ({ owner: 'khlink', hostPid: 123 }) };
  self.desktopStatuses.set('thread-04', 'desktop_running'); self.threadState.set('thread-04', { activeTurnId: 'active-04' });
  self.desktopAdapter = { interrupt: () => assert.fail('this is our own active writer') };
  self.codex = { mode: 'host', ready: true, host: { state: { pid: 123 } }, request: async (method, params) => {
    assert.equal(method, 'turn/interrupt'); assert.equal(params.turnId, 'active-04'); return { stopped: true };
  } };
  assert.equal((await self.executeCommand({ action: 'turn.stop', args: { threadId: 'thread-04' } })).stopped, true);
});

test('an immediate request retains its steer intent through a read-only navigation retry', async () => {
  const self = fixture(); let ready = false; let steers = 0;
  self.desktopAdapter = { probe: async () => ({ code: 'desktop_other_task' }), openThread: async () => {
    if (!ready) throw Object.assign(new Error('task still loading'), { delivery: 'not_sent' });
  }, steer: async () => { steers++; return { code: 'steer_accepted' }; } };
  const result = await self.command({ ...request(), action: 'turn.steer' }, 'phone');
  assert.equal(result.item.state, 'pending'); assert.equal(self.followups.get('once').steerRequested, true);
  ready = true; self.followups.update('once', { nextRetryAt: 0 });
  await self.retryFollowups();
  assert.equal(self.followups.get('once').state, 'started'); assert.equal(steers, 1); assert.equal(self.calls.length, 1);
});

test('next-turn settings cannot strand an immediate instruction behind the current Desktop turn', async () => {
  const self = fixture(); self.threadState.set('thread-04', { pendingDesktopSettings: { model: 'next-model' } });
  self.desktopStatuses.set('thread-04', 'desktop_running'); self.applyPendingDesktopSettings = () => assert.fail('must leave settings for the next turn');
  self.desktopAdapter = { probe: async () => ({ code: 'task_active' }), steer: async () => ({ code: 'steer_accepted' }) };
  assert.equal((await self.command({ ...request(), action: 'turn.steer' }, 'phone')).accepted, true);
  assert.equal(self.threadState.get('thread-04').pendingDesktopSettings.model, 'next-model');
});

test('a read-only failed steer lookup retries its exact existing queue row without another queue write', async () => {
  const self = fixture(); let steers = 0; const rpc = self.codex.request;
  self.codex.request = async (method, params) => method === 'thread/queue/list'
    ? { data: [{ id: 'queue-1', clientUserMessageId: 'once' }] } : rpc(method, params);
  self.desktopAdapter = { probe: async () => ({ code: 'task_active' }), steer: async () => {
    if (++steers === 1) throw Object.assign(new Error('lookup timed out'), { delivery: 'not_sent' });
    return { code: 'steer_accepted' };
  } };
  await self.command({ ...request(), action: 'turn.steer' }, 'phone');
  self.followups.update('once', { steerRetryAt: 0 }); await self.retryFollowups();
  assert.equal(self.calls.length, 1); assert.equal(steers, 2); assert.equal(self.followups.get('once').state, 'started');
});

test('the retry sweep and initial steer share one in-flight native click and receipt', async () => {
  const self = fixture(); let release; let steers = 0;
  const receipt = new Promise(resolve => { release = resolve; });
  const rpc = self.codex.request;
  self.codex.request = async (method, params) => method === 'thread/queue/list'
    ? { data: [{ id: 'queue-1', clientUserMessageId: 'once' }] } : rpc(method, params);
  self.desktopAdapter = { probe: async () => ({ code: 'task_active' }), steer: async () => { steers++; return receipt; } };
  const sending = self.command({ ...request(), action: 'turn.steer' }, 'phone');
  while (!steers) await new Promise(resolve => setImmediate(resolve));
  const retrying = self.retryFollowups();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(steers, 1);
  release({ code: 'steer_accepted' });
  await Promise.all([sending, retrying]);
  assert.equal(steers, 1); assert.equal(self.calls.length, 1);
  assert.equal(self.followups.get('once').state, 'started');
  assert.equal(self.events.filter(row => row.kind === 'steer.accepted').length, 1);
});

test('a queue row consumed during a read-only steer lookup cannot be resurrected or emit a false failure', async () => {
  const self = fixture(); self.followups.add({ id: 'once', requestId: 'once', threadId: 'thread-04', state: 'desktop_queued' });
  self.desktopAdapter = { steer: async () => {
    self.followups.remove('once');
    throw Object.assign(new Error('queue row already consumed'), { delivery: 'not_sent' });
  } };
  assert.equal((await self.steerFollowup('once', 'phone', 'thread-04', { retainReceipt: true })).missing, true);
  assert.equal(self.events.length, 0); assert.equal(self.followups.items.length, 0);
});

test('a failed immediate lookup stays visible and manual retry steers the same answer without re-enqueueing', async () => {
  const self = fixture(); self.followups.add({ id: 'answer', requestId: 'answer', threadId: 'thread-04', state: 'desktop_queued', blocking: false, steerRequested: true });
  let calls = 0;
  self.desktopAdapter = { steer: async item => {
    assert.equal(item.requestId, 'answer');
    if (++calls === 1) throw Object.assign(new Error('lookup failed'), { delivery: 'not_sent' });
    return { code: 'steer_accepted' };
  } };
  await self.steerFollowup('answer', 'phone', 'thread-04', { retainReceipt: true });
  assert.equal(self.followups.get('answer').blocking, true);
  assert.equal(self.events.at(-1).kind, 'steer.deferred');
  assert.equal(self.events.at(-1).data.item.blocking, true);
  assert.equal((await self.steerFollowup('answer', 'phone', 'thread-04', { retainReceipt: true })).accepted, true);
  assert.equal(self.followups.get('answer').state, 'started');
  assert.equal(self.followups.get('answer').blocking, false);
  assert.equal(self.calls.length, 0, 'does not write the input to the protocol queue a second time');
});
