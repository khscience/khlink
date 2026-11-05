const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Operations, atomic, read, blockers, leases } = require('../src/account-operations');
const { activitySnapshot, scheduleCount } = require('../src/account-preflight');
const { publicState, AgentAccounts } = require('../src/agent-accounts');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-operations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 100000; const live = new Set([10, 20]);
  const options = { now: () => now, isAlive: pid => live.has(pid) };
  const op = new Operations(root, options), snapshot = { pid: 20, at: now, active: 'primary', known: true };
  return { root, op, snapshot, live, time: n => { now = n; }, begin: (id = 'request-12345') => op.begin({ requestId: id, from: 'primary', to: 'secondary', origin: 'phone', pid: 10 }, 'primary', snapshot) };
}
test('durable request replay never starts a second switch; conflicting reuse fails', t => {
  const f = fixture(t); f.begin();
  const second = new Operations(f.root, { now: () => 100000, isAlive: () => true });
  assert.equal(second.begin({ requestId: 'request-12345', from: 'primary', to: 'secondary', origin: 'phone', pid: 10 }, 'primary', f.snapshot).replay, true);
  assert.throws(() => f.op.begin({ requestId: 'request-12345', from: 'primary', to: 'primary', origin: 'phone', pid: 10 }, 'primary', f.snapshot), { code: 'request_conflict' });
  assert.throws(() => f.begin('different-request'), { code: 'busy' });
  f.op.update('request-12345', 10, 'closing'); f.op.update('request-12345', 10, 'syncing');
  assert.throws(() => f.op.update('request-12345', 10, 'checking'), { code: 'invalid_request' });
  assert.throws(() => f.op.finish('request-12345', 11), { code: 'invalid_request' });
  f.op.finish('request-12345', 10);
  assert.equal(f.begin().replay, true);
});
test('every task / approval / queue / setting / schedule blocker rejects before closing', t => {
  const f = fixture(t);
  for (const reason of ['tasks_running', 'approval_pending', 'messages_queued', 'settings_pending', 'schedule_pending']) {
    f.snapshot[reason] = 1;
    assert.throws(() => f.begin(`request-${reason}`), e => e.code === reason && e.blockers.includes(reason));
    assert.equal(f.op.state('primary').busy, false); delete f.snapshot[reason];
  }
  for (const snapshot of [null, { ...f.snapshot, known: false }, { ...f.snapshot, at: 1 }, { ...f.snapshot, active: 'secondary' }, { ...f.snapshot, pid: 99 }])
    assert.deepEqual(blockers(snapshot, { now: 100000, active: 'primary', isAlive: pid => f.live.has(pid) }), ['status_unknown']);
});
test('phone leases retain live work and clean only demonstrably dead old owners', t => {
  const f = fixture(t), dead = path.join(f.root, 'desktop-operation-99-aaaaaaaa.lock'), live = path.join(f.root, 'desktop-operation-20-bbbbbbbb.lock');
  fs.writeFileSync(dead, '1000'); atomic(live, { pid: 20, startedAt: 1000 });
  assert.deepEqual(leases(f.root, { now: 100000, isAlive: pid => f.live.has(pid) }), ['desktop-operation-20-bbbbbbbb.lock']);
  assert.throws(() => f.begin(), { code: 'operation_active' }); assert.equal(fs.existsSync(dead), false); assert.equal(fs.existsSync(live), true);
});
test('restart recovers ended owner only after grace and a consistent link', t => {
  const f = fixture(t); f.begin(); f.live.delete(10);
  f.time(120000); assert.equal(f.op.state('primary').busy, true);
  f.time(140000); assert.equal(f.op.state(null).code, 'link_unknown'); assert.equal(fs.existsSync(f.op.lock), true);
  assert.equal(f.op.state('secondary').code, 'interrupted'); assert.equal(fs.existsSync(f.op.lock), true);
  f.op.state('secondary', { recover: true }); assert.equal(fs.existsSync(f.op.lock), false);
});
test('timeout leaves mutating child locked; no restart guesses through a link transaction', t => {
  const f = fixture(t); f.live.add(30); f.begin(); f.op.update('request-12345', 10, 'syncing', 30);
  assert.equal(f.op.finish('request-12345', 10, 'helper_timeout').busy, true);
  f.time(150000); assert.equal(f.op.state('primary').busy, true);
  f.live.delete(30); atomic(path.join(f.root, 'link-transaction.json'), { phase: 'original_preserved' });
  assert.equal(f.op.state('primary').code, 'link_unknown');
  atomic(path.join(f.root, 'link-transaction.json'), { phase: 'rolled_back' });
  assert.equal(f.op.state('primary').busy, false);
});
test('launch failure exposes bounded recovery actions and persists across connector restart', t => {
  const f = fixture(t); f.begin(); f.op.update('request-12345', 10, 'opening');
  f.op.finish('request-12345', 10, 'launch_failed');
  const state = new Operations(f.root).state('secondary');
  assert.deepEqual(state.recovery, ['reopen', 'switch_back']); assert.equal(state.from, 'primary');
});

test('browser extension rejection leaves profile untouched and exposes only a fixed public reason', t => {
  const f = fixture(t); f.begin();
  const result = f.op.finish('request-12345', 10, 'browser_extension_active');
  assert.equal(result.phase, 'failed');
  assert.equal(result.busy, false);
  assert.deepEqual(result.recovery, []); // Rejected before closing, so no recovery is needed.
  const state = publicState('claude', { active: 'primary', profiles: [{ id: 'primary' }] }, result, { identity: () => 'anonymous' });
  assert.equal(state.lastSwitch.code, 'browser_extension_active');
  assert.match(state.lastSwitch.message, /浏览器/);
  assert.doesNotMatch(JSON.stringify(state), /chrome-native-host|[A-Z]:\\/);
});

test('successful reopen reports reopening instead of claiming the account was switched', t => {
  const f = fixture(t);
  f.op.begin({ requestId: 'request-reopen', from: 'primary', to: 'primary', origin: 'phone', pid: 10, action: 'reopen' }, 'primary', f.snapshot);
  f.op.update('request-reopen', 10, 'opening');
  const done = f.op.finish('request-reopen', 10);
  assert.equal(done.message, 'Claude 已重新打开');
  const state = publicState('claude', { active: 'primary', profiles: [{ id: 'primary' }] }, done, { identity: () => 'anonymous' });
  assert.equal(state.lastSwitch.message, 'Claude 已重新打开');
  assert.equal(state.active, 'anonymous');
});
test('incomplete link mutation stays locked and explicit repair itself can recover after another crash', t => {
  const f = fixture(t); f.begin();
  atomic(path.join(f.root, 'link-transaction.json'), { from: 'primary', to: 'secondary', phase: 'original_preserved' });
  assert.equal(f.op.finish('request-12345', 10, 'component_failed').busy, true);
  f.time(140000);
  const repaired = f.op.repair({ requestId: 'repair-request1', pid: 10, origin: 'phone' }, null);
  assert.equal(repaired.to, 'primary'); assert.equal(repaired.transactionTo, 'secondary');
  f.op.finish('repair-request1', 10, 'component_failed');
  f.time(180000);
  assert.equal(f.op.repair({ requestId: 'repair-request2', pid: 10, origin: 'desktop' }, null).to, 'primary');
  atomic(path.join(f.root, 'link-transaction.json'), { from: 'primary', to: 'secondary', phase: 'rolled_back' });
  assert.equal(f.op.finish('repair-request2', 10).busy, false);
});
test('activity preflight does not infer idle from quiet metadata or archived/live tasks', () => {
  const connector = { _claudeLive: { at: 100000, verified: true, ids: new Set(['a', 'missing']) },
    claudeThreads: new Map([['one', { sessionId: 'a', desktopLive: true, archived: true, lastStatus: 'completed', transcriptLastEvent: 'tool_result', waitingCategory: 'prompt', pendingDesktopSettings: { model: 'x' }, desktopQueue: [{ status: 'queued' }] }]]), _claudeQueues: new Map([['one', [{}]]]) };
  const s = activitySnapshot(connector, 'primary', 100000);
  assert.equal(s.tasks_running, 1); assert.equal(s.approval_pending, 1); assert.equal(s.messages_queued, 2); assert.equal(s.settings_pending, 1); assert.equal(s.known, false);
});

test('preflight reads fresh live transcript even when mtime and cached completion are old', t => {
  const f = fixture(t), file = path.join(f.root, 'test-transcript.jsonl');
  const row = (type, content) => JSON.stringify({ type, timestamp: new Date(100000).toISOString(), message: { role: type, content } }) + '\n';
  fs.writeFileSync(file, row('assistant', [{ type: 'text', text: 'finished' }]));
  fs.appendFileSync(file, row('user', 'new task'));
  fs.utimesSync(file, new Date(1000), new Date(1000));
  const connector = { _claudeLive: { at: 100000, verified: true, ids: new Set(['a']) }, claudeThreads: new Map([['one', { sessionId: 'a', desktopLive: true, transcriptFile: file, transcriptLastEvent: 'end_turn' }]]) };
  assert.equal(activitySnapshot(connector, 'primary', 100000).tasks_running, 1);
  connector._claudeLive.unattributed = true;
  assert.equal(activitySnapshot(connector, 'primary', 100000, () => ({ lastEvent: 'end_turn' })).known, false);
});

test('desktop-origin phase changes are pushed once, with only the public DTO', async t => {
  const f = fixture(t); f.begin(); const events = [];
  const accounts = new AgentAccounts({ emit: (...args) => events.push(args) }, { operations: f.op });
  accounts.raw = async () => ({ configured: true, active: 'primary', profiles: [{ id: 'primary', name: '主账号' }, { id: 'secondary', name: '备用' }] });
  t.after(() => accounts.stop());
  await accounts.state('claude'); await accounts.progress(); await accounts.progress();
  assert.equal(events.filter(e => e[0] === 'accounts.progress').length, 1);
  f.op.update('request-12345', 10, 'closing'); await accounts.progress();
  f.op.finish('request-12345', 10); await accounts.progress();
  assert.deepEqual(events.filter(e => e[0] === 'accounts.state').map(e => e[2].lastSwitch.phase), ['checking', 'closing', 'done']);
  assert.ok(!JSON.stringify(events).includes(f.root));
});

test('account list and homepage share only an opaque, current-profile quota binding', async t => {
  const f = fixture(t); let alias = 'primary';
  const fingerprint = 'a'.repeat(32);
  const accounts = new AgentAccounts({ claudeDesktop: { latestOfficialUsage: () => ({ accountState: 'ready', profileAlias: alias, accountFingerprint: fingerprint }) } }, { operations: f.op });
  accounts.raw = async () => ({ configured: true, active: 'primary', profiles: [{ id: 'primary' }] });
  t.after(() => accounts.stop());
  assert.equal((await accounts.state('claude')).usageFingerprint, fingerprint);
  alias = 'secondary'; assert.equal((await accounts.state('claude')).usageFingerprint, undefined);
  assert.equal((await accounts.state('codex')).usageFingerprint, undefined);
  alias = 'primary'; f.begin(); assert.equal((await accounts.state('claude')).usageFingerprint, undefined);
});
test('both official Code and Cowork schedules are checked, unknown format blocks', t => {
  const f = fixture(t), dir = path.join(f.root, 'claude-code-sessions', 'account', 'org'), cowork = dir.replace('claude-code-sessions', 'local-agent-mode-sessions');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(cowork, { recursive: true });
  atomic(path.join(dir, 'scheduled-tasks.json'), { scheduledTasks: [{ enabled: false }, { enabled: true }] });
  atomic(path.join(cowork, 'scheduled-tasks.json'), { scheduledTasks: [{}] });
  assert.equal(scheduleCount(f.root, dir), 2);
  atomic(path.join(cowork, 'scheduled-tasks.json'), { other: [] }); assert.throws(() => scheduleCount(f.root, dir));
});

test('only user-visible pending desktop messages block switching; harness entries do not', () => {
  const connector = { _claudeLive: { verified: true, at: 100000, ids: new Set() }, claudeThreads: new Map([['one', { desktopQueue: [{ internal: true }, { state: 'completed' }, { state: 'cancelled' }, { state: 'desktop_queued' }] }]]) };
  assert.equal(activitySnapshot(connector, 'primary', 100000).messages_queued, 1);
});

test('removed profile metadata is not a current pending request, but live archived tasks still block', () => {
  const stale = { sessionId: 'old', archived: true, desktopLive: true, transcriptLastEvent: 'tool_result', waitingCategory: 'prompt', desktopQueue: [{ state: 'desktop_queued' }] };
  const connector = { _claudeLive: { verified: true, at: 100000, ids: new Set() }, _claudeActiveDesktopIds: new Set(), claudeThreads: new Map([['old-thread', stale]]) };
  let s = activitySnapshot(connector, 'primary', 100000);
  assert.equal(s.tasks_running, 0); assert.equal(s.approval_pending, 0); assert.equal(s.messages_queued, 0);
  connector._claudeLive.ids.add('old');
  s = activitySnapshot(connector, 'primary', 100000, () => ({ lastEvent: 'tool_result' }));
  assert.equal(s.tasks_running, 1); assert.equal(s.approval_pending, 1); assert.equal(s.messages_queued, 1);
});
test('account DTO never exposes identities, paths, raw errors, or ambiguous estimates', () => {
  const privateState = { active: 'primary', root: 'C:\\private', profiles: [{ id: 'primary', name: 'person@example.com', accountId: 'org-secret', token: 'secret', home: 'C:\\private', usage: { fiveHour: { remaining: 40, observedAt: 1000, resetsAt: 80000 } } }, { id: 'secondary', name: '备用账号', usage: { fiveHour: { remaining: 2, observedAt: 1000, resetsAt: 80000 } } }] };
  const state = publicState('claude', privateState, { requestId: 'request-12345', from: 'primary', to: 'secondary', phase: 'failed', code: 'C:\\private', message: 'person@example.com', at: 100000 }, { now: 100000, identity: (namespace, id) => id === 'primary' ? 'a'.repeat(32) : 'b'.repeat(32) });
  const output = JSON.stringify(state);
  for (const s of ['person@example.com', 'org-secret', 'private', 'secret', 'primary', 'secondary']) assert.equal(output.includes(s), false);
  assert.equal(state.profiles[0].fiveHour, undefined); assert.equal(state.profiles[0].quota.fiveHour.remaining, 40);
  assert.equal(state.profiles[1].quota.fiveHour.remaining, 100); assert.equal(state.profiles[1].quota.fiveHour.estimated, true);
});
test('Codex account requests are strictly read-only and never spawn a switch', async () => {
  const accounts = new AgentAccounts({}, { spawn: () => { throw Error('must not spawn'); } });
  await assert.rejects(accounts.switch({ backend: 'codex', to: 'x', requestId: 'request-12345' }), { code: 'readonly' });
  const state = publicState('codex', { selected: 'account-other', profiles: [{ id: 'default', name: '默认' }, { id: 'account-other', name: '其他' }] }, null);
  assert.equal(state.readonly, true); assert.equal(state.profiles[0].active, true); assert.equal(state.profiles[0].quota.fiveHour, null);
});
test('desktop-only identity on either backend cannot enter the mobile account snapshot', () => {
  for (const backend of ['claude', 'codex']) {
    const state = publicState(backend, { active: 'primary', profiles: [{ id: 'primary', name: '工作账号',
      identity: { accountId: 'private-account-uuid', shortId: 'private-short' },
      record: { loggedIn: true, identity: { email: 'desktop-only@example.invalid' }, plan: 'pro' } }] }, null);
    assert.doesNotMatch(JSON.stringify(state), /private-|example|identity"|accountId|plan"/);
    assert.equal(state.profiles[0].name, '工作账号');
  }
});

for (const backend of ['claude','codex']) test(`${backend} registry removal and restore push fresh lists without an account switch`, async t => {
  let revision='first',removed=false;const events=[];
  const accounts=new AgentAccounts({emit:(...e)=>events.push(e)},{registryStamp:()=>revision});t.after(()=>accounts.stop());
  accounts.raw=async()=>({configured:true,active:'primary',profiles:[{id:backend==='claude'?'primary':'default',name:'当前账号'},...removed?[]:[{id:'secondary',name:'备用账号'}]],removedProfiles:removed?[{id:'secondary',name:'private@example.invalid',home:'C:\\private'}]:[]});
  await accounts.state(backend);await accounts.progress();events.length=0;
  revision='removed';removed=true;await accounts.progress();await accounts.progress();
  assert.equal(events.length,1);assert.equal(events[0][0],'accounts.state');assert.equal(events[0][2].profiles.length,1);
  assert.doesNotMatch(JSON.stringify(events),/private|secondary|removedProfiles/);
  revision='restored';removed=false;await accounts.progress();assert.equal(events.length,2);assert.equal(events[1][2].profiles.length,2);
  assert.equal(events[1][2].readonly,backend==='codex');
});
test('registry change during an in-flight raw read is retried instead of considered already published',async t=>{
  let revision='old',resolve;const events=[];const accounts=new AgentAccounts({emit:(...e)=>events.push(e)},{registryStamp:()=>revision});t.after(()=>accounts.stop());
  let first=true;accounts.raw=async()=>{if(first){first=false;return new Promise(r=>{resolve=r;});}return {profiles:[{id:'default',name:'默认'}]};};
  const old=accounts.state('codex');revision='new';resolve({profiles:[{id:'default'},{id:'removed'}]});await old;await accounts.progress();
  assert.equal(events.length,1);assert.equal(events[0][2].profiles.length,1);
});

test('a switch progress watcher works before a new client has re-read its cached account list',async t=>{
  const f=fixture(t);f.begin();const events=[];
  const accounts=new AgentAccounts({emit:(...e)=>events.push(e)},{operations:f.op,registryStamp:()=> 'synthetic'});t.after(()=>accounts.stop());
  accounts.raw=async()=>({configured:true,active:'primary',profiles:[{id:'primary',name:'主账号'},{id:'secondary',name:'备用'}]});
  accounts.watch();await accounts.progress();assert.equal(events[0][0],'accounts.progress');assert.equal(events[0][2].phase,'checking');
});
