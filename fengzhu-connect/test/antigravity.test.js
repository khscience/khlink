const test = require('node:test');
const assert = require('node:assert/strict');
const ag = require('../src/backends/antigravity');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Build protobuf bytes by hand (varint keys / length-delimited fields).
function varint(n) { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); }
function field(num, value) {
  if (typeof value === 'number') return Buffer.concat([varint(num * 8), varint(value)]);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([varint(num * 8 + 2), varint(bytes.length), bytes]);
}
const msg = (...parts) => Buffer.concat(parts);
const header = (seconds, extra = Buffer.alloc(0)) => field(5, msg(field(1, msg(field(1, seconds), field(2, 0))), extra));

test('Antigravity steps become user, thinking, reply and tool items', () => {
  const user = ag.stepItems({ idx: 0, step_type: 14, status: 3, step_payload: msg(field(1, 14), header(1790000000), field(19, msg(field(2, '看一下')))) });
  assert.deepEqual(user.map((i) => [i.id, i.value.type, i.value.text, i.at]), [['ag-0', 'userMessage', '看一下', 1790000000000]]);
  const reply = ag.stepItems({ idx: 1, step_type: 15, status: 3, step_payload: msg(header(1790000001), field(20, msg(field(1, '好了'), field(3, 'thinking')))) });
  assert.deepEqual(reply.map((i) => [i.id, i.value.type]), [['ag-1-think', 'reasoning'], ['ag-1', 'agentMessage']]);
  const call = msg(field(1, 'call_1'), field(2, 'run_command'), field(3, JSON.stringify({ CommandLine: 'git status', toolSummary: 'Check git' })));
  const tool = ag.stepItems({ idx: 2, step_type: 132, status: 6, step_payload: header(1790000002, field(4, call)) });
  assert.equal(tool[0].value.type, 'commandExecution');
  assert.equal(tool[0].value.text, 'git status\n\nCheck git');
  assert.equal(tool[0].value.status, 'interrupted');
  const trimmed = ag.stepItems({ idx: 3, step_type: 14, status: 5, step_payload: header(1790000003) });
  assert.deepEqual(trimmed, []);
});

test('Antigravity workspace URIs', () => {
  assert.equal(ag.workspaceFromUri('file:///i%3A/qmt5/code'), 'I:\\qmt5\\code');
  assert.equal(ag.workspaceFromUri('outside-of-project'), '');
});

test('Antigravity error steps, refused and open tool calls', () => {
  const failure = (headline, detail) => field(24, msg(field(3, msg(...[headline && field(1, headline), field(2, detail)].filter(Boolean)))));
  const error = ag.stepItems({ idx: 4, step_type: 17, status: 3, step_payload: msg(header(1790000004), failure('Agent execution terminated due to error.', 'INVALID_ARGUMENT (code 400)\nTrace...')) });
  assert.deepEqual(error.map((i) => [i.value.type, i.value.text]), [['error', 'Agent execution terminated due to error.\nINVALID_ARGUMENT (code 400)']]);
  const retry = ag.stepItems({ idx: 5, step_type: 17, status: 3, step_payload: msg(header(1790000005), failure('', 'API error (attempt 1): request failed (code 502)')) });
  assert.deepEqual(retry, []);
  const call = msg(field(1, 'call_2'), field(2, 'grep_search'), field(3, JSON.stringify({ Query: 'x' })));
  const refused = ag.stepItems({ idx: 6, step_type: 132, status: 4, step_payload: msg(header(1790000006, field(4, call)), field(31, msg(field(2, 'invalid arguments')))) });
  assert.equal(refused[0].value.status, 'failed');
  assert.match(refused[0].value.text, /invalid arguments/);
  assert.equal(ag.stepState(2), 'inProgress');
  assert.equal(ag.stepState(8), 'inProgress');
  assert.equal(ag.stepState(6), 'interrupted');
  assert.equal(ag.stepState(12), 'interrupted');
  assert.equal(ag.stepState(3), 'completed');
});

test('Antigravity running state follows the last step', () => {
  const { install } = require('../src/backends/antigravity-sync');
  const self = {}; install({ prototype: self });
  const now = Date.now();
  const at = (ago) => ({ mtimeMs: now - ago, size: 1 });
  // A reply that is not the last one: the next step can take a while to appear.
  assert.equal(self.antigravityRunning({ lastType: ag.STEP_MODEL, lastStatus: 3 }, at(12_000)), true);
  assert.equal(self.antigravityRunning({ lastType: ag.STEP_MODEL, lastStatus: 3 }, at(30_000)), false);
  assert.equal(self.antigravityRunning({ lastType: ag.STEP_TOOL, lastStatus: 3 }, at(60_000)), true);
  assert.equal(self.antigravityRunning({ lastType: ag.STEP_TOOL, lastStatus: 3 }, at(100_000)), false);
  assert.equal(self.antigravityRunning({ lastType: ag.STEP_TOOL, lastStatus: 2 }, at(10 * 60_000)), true);
  assert.equal(self.antigravityRunning({ lastType: ag.STEP_TOOL, lastStatus: 2 }, at(40 * 60_000)), false);
  assert.equal(self.antigravityRunning({ lastType: ag.STEP_MODEL, lastStatus: 3, sentAt: now - 5_000 }, at(60_000)), true);
  assert.equal(self.antigravityThreadStatus({ running: false, lastType: ag.STEP_ERROR }), 'failed');
});

test('Antigravity ask_question: waiting card, then question and answer in history', () => {
  const args = JSON.stringify({ questions: [{ question: '选哪个？', options: ['(Recommended) 甲', '乙'], is_multi_select: false }] });
  const call = msg(field(1, 'call_9'), field(2, 'ask_question'), field(3, args));
  const waiting = ag.waitingFor({ idx: 7, status: 9, step_payload: header(1790000007, field(4, call)) });
  assert.equal(waiting.kind, 'question');
  assert.equal(waiting.requestId, 'call_9');
  assert.deepEqual(waiting.questions[0].options.map((o) => o.label), ['(Recommended) 甲', '乙']);
  assert.equal(ag.waitingFor({ idx: 7, status: 3, step_payload: header(1790000007, field(4, call)) }), null);
  const answered = ag.stepItems({ idx: 7, step_type: 132, status: 3, step_payload: msg(header(1790000007, field(4, call)), field(140, msg(field(2, msg(field(1, 'A1: (Recommended) 甲')))))) });
  assert.equal(answered[0].value.text, '提问\n选哪个？\n回答：(Recommended) 甲');
  const { install } = require('../src/backends/antigravity-sync');
  const self = {}; install({ prototype: self });
  assert.equal(self.antigravityThreadStatus({ waiting, running: false }), 'desktop_waiting');
});

test('Antigravity send waits while the computer is in use', async () => {
  const { install } = require('../src/backends/antigravity-sync');
  const self = {}; install({ prototype: self });
  const id = '11111111-1111-1111-1111-111111111111';
  const calls = []; let active = true;
  Object.assign(self, {
    antigravityThreads: new Map([[id, { lastIdx: 1 }]]), events: [],
    saveAntigravityThreads() {}, announceAntigravityStatus() {}, pollAntigravity: async () => {}, log() {},
    readAntigravitySendState(_id, text) { return { lastIdx: 1, receipt: text ? { idx: 2, at: Date.now() } : null }; },
    emit(type) { this.events.push(type); },
    execFileFn(_cmd, args, _opts, done) {
      const mode = args[args.indexOf('-Mode') + 1]; calls.push(args.includes('-IdleSeconds') ? `${mode}+idle` : mode);
      if (mode === 'list') return done(null, JSON.stringify({ ok: true, ids: [id] }));
      done(null, JSON.stringify(active && args.includes('-IdleSeconds') ? { ok: false, reason: 'user_active' } : { ok: true, reason: 'sent' }));
    },
  });
  const queued = await self.antigravityCommand({ action: 'turn.start', args: { threadId: id, text: 'hi' } });
  assert.equal(queued.queued, true);
  assert.deepEqual(calls, ['send+idle']);
  await self.drainAntigravityQueues();            // still in use: kept, retried later
  assert.equal(self.antigravityThreads.get(id).queue.length, 1);
  active = false; self.antigravityThreads.get(id).queue[0].retryAt = 0;
  await self.drainAntigravityQueues();
  assert.equal(self.antigravityThreads.get(id).queue.length, 0);
  assert.ok(self.events.includes('followup.started'));
  await assert.rejects(self.antigravityCommand({ action: 'turn.start', args: { threadId: id.replace(/1/g, '2'), text: 'x' } }), /没有找到/);
});

test('terminal and stopped Antigravity turns are not kept running by fresh file writes', () => {
  const { methods } = require('../src/backends/antigravity-sync');
  const self = { ...methods };
  const now = Date.now(); const fresh = { mtimeMs: now };
  for (const lastStatus of [4, 6, 7, 10, 12]) {
    const meta = { lastType: ag.STEP_TOOL, lastStatus, lastAt: now - 1000 };
    assert.equal(self.antigravityRunning(meta, fresh), false);
    assert.equal(self.antigravityThreadStatus(meta), [6, 10, 12].includes(lastStatus) ? 'interrupted' : 'failed');
  }
  const stopped = { lastType: ag.STEP_TOOL, lastStatus: 2, lastAt: now - 2000, stoppedAt: now - 1000 };
  assert.equal(self.antigravityRunning(stopped, fresh), false);
  assert.equal(self.antigravityThreadStatus(stopped), 'interrupted');
  assert.equal(self.antigravityRunning({ lastType: ag.STEP_MODEL, lastStatus: 3, lastAt: now - 60_000 }, fresh), false);
  assert.equal(self.antigravityRunning({ ...stopped, lastAt: now }, fresh), true, 'a new desktop turn supersedes the earlier stop');
});

function deliveryFixture(t) {
  const { methods } = require('../src/backends/antigravity-sync');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-ag-receipt-'));
  const id = '44444444-4444-4444-4444-444444444444';
  fs.mkdirSync(path.join(home, 'conversations'));
  const file = path.join(home, 'conversations', `${id}.db`);
  const { DatabaseSync } = ag.loadSqlite(); const db = new DatabaseSync(file);
  db.exec('create table steps(idx integer primary key, step_type integer, status integer, step_payload blob); create table trajectory_metadata_blob(data blob); create table gen_metadata(idx integer, data blob)');
  const addUser = (idx, text) => db.prepare('insert into steps values(?, 14, 3, ?)').run(idx, msg(header(Math.floor(Date.now() / 1000)), field(19, msg(field(2, text)))));
  addUser(1, 'earlier message');
  const createSelf = () => ({
    ...methods, antigravityHomeDir: home, antigravityFile: path.join(home, 'outbox.json'),
    antigravityThreads: new Map([[id, { lastIdx: 1 }]]), antigravitySendConfirmMs: 0,
    frames: [], emit(kind, threadId, payload) { this.frames.push({ kind, threadId, payload }); }, log(error) { throw error; },
    announceAntigravityStatus() {}, pollAntigravity: async () => {},
    uploadAntigravityIndex: async () => {}, uploadAntigravityItems: async () => {},
  });
  const self = createSelf();
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { self, createSelf, id, file, home, addUser };
}

test('native generating replies stay open and upgrade rebuilds the old interrupted history once', async (t) => {
  const { self, id, file, home } = deliveryFixture(t);
  const { DatabaseSync } = ag.loadSqlite(); const db = new DatabaseSync(file);
  db.prepare('insert into steps values(?, 15, 8, ?)').run(2, msg(header(Math.floor(Date.now() / 1000)), field(20, field(1, 'partial reply'))));
  const meta = self.antigravityThreads.get(id);
  Object.assign(meta, { itemsVersion: 1, lastIdx: 2, lastStatus: 8, lastType: ag.STEP_MODEL });
  const uploaded = [];
  self.uploadAntigravityItems = async (_id, items) => uploaded.push(...items);
  await self.syncAntigravityConversation(path.join(home, 'conversations'), `${id}.db`, id);
  assert.equal(meta.openIdx, 2, 'generating is reread until it finishes');
  assert.equal(meta.running, true);
  assert.equal(self.antigravityThreadStatus(meta), 'desktop_running');
  assert.ok(uploaded.some((item) => item.id === 'ag-2' && item.value.status !== 'interrupted'));
  assert.ok(self.frames.some((frame) => frame.kind === 'history.updated' && frame.payload.fullHistory));
  uploaded.length = 0; self.frames.length = 0;
  await self.syncAntigravityConversation(path.join(home, 'conversations'), `${id}.db`, id);
  assert.equal(uploaded.length, 0, 'unchanged history is not rebuilt repeatedly');
  const quiet = { ...meta, lastAt: Date.now() - 60_000, sentAt: 0 };
  assert.equal(self.antigravityRunning(quiet, { mtimeMs: Date.now() }), true, 'a long stream is still running');
  db.prepare('update steps set status=3 where idx=2').run(); db.close();
  const finished = ag.readConversation(file, 2, meta.openIdx);
  assert.equal(finished.openIdx, null);
  assert.equal(finished.lastStatus, 3);
  assert.equal(self.antigravityRunning({ ...quiet, lastStatus: 3 }, { mtimeMs: Date.now() }), false);
});

test('send receipts require a new matching user step in the intended conversation', (t) => {
  const { file, addUser } = deliveryFixture(t);
  assert.equal(ag.readSendState(file, 'earlier message', 1).receipt, null);
  addUser(2, 'different message');
  assert.equal(ag.readSendState(file, 'earlier message', 1).receipt, null);
  addUser(3, 'line one\nline two');
  assert.equal(ag.readSendState(file, 'line one  line two', 1).receipt.idx, 3);
  assert.equal(ag.readSendState(file).lastIdx, 3);
});

test('verified idle window ends the running badge and cannot outlive a newer send', () => {
  const { methods } = require('../src/backends/antigravity-sync'); const now = Date.now();
  const meta = { lastType: ag.STEP_MODEL, lastStatus: 3, lastAt: now - 1000, windowState: { at: now, active: false, foreground: true } };
  assert.equal(methods.antigravityRunning.call(methods, meta, { mtimeMs: now }), false);
  assert.equal(methods.antigravityRunning.call(methods, { ...meta, sentAt: now + 1 }, { mtimeMs: now }), true);
  assert.equal(methods.antigravityRunning.call(methods, { ...meta, windowState: { at: now - 20_000, active: false } }, { mtimeMs: now }), true);
  assert.equal(methods.antigravityRunning.call(methods, { ...meta, lastAt: now - 30_000, windowState: { at: now, active: true, foreground: false } }, { mtimeMs: now }), false, 'cached background Cancel cannot keep a completed reply running');
  assert.equal(methods.antigravityRunning.call(methods, { ...meta, waiting: { kind: 'question' }, windowState: { at: now, active: true, foreground: true } }, { mtimeMs: now }), false);
});

test('background window probes cannot override native history', async () => {
  const { methods } = require('../src/backends/antigravity-sync'); const now = Date.now();
  for (const result of [
    { foreground: false, active: false }, { foreground: false, active: true },
    { foreground: true, active: false, observedAt: now - 1000 },
  ]) {
    const meta = { running: true, sentAt: now }; let announcements = 0;
    const self = { runAntigravitySend: async () => ({ ok: true, current: true, box: true, send: true, ...result }), announceAntigravityStatus() { announcements++; } };
    methods.refreshAntigravityWindowState.call(self, 'own-test', meta);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(meta.running, true); assert.equal(announcements, 0); assert.equal(meta.windowState, undefined);
  }
});

test('concurrent replay of a confirmed Antigravity send presses Send only once', async (t) => {
  const { self, id, addUser } = deliveryFixture(t); let sends = 0;
  self.runAntigravitySend = async (_id, _mode, text) => {
    assert.ok(self.frames.some((frame) => frame.kind === 'followup.queued' && frame.payload.state === 'dispatching' && !frame.payload.blocking), 'phone sees durable processing before the window is driven');
    sends++; addUser(2, text); return { ok: true, reason: 'clicked' };
  };
  const payload = { action: 'turn.start', requestId: 'confirmed', args: { threadId: id, text: 'hello' } };
  const results = await Promise.all([self.antigravityCommand(payload), self.antigravityCommand(payload)]);
  assert.equal(sends, 1); assert.ok(results.every((result) => result.accepted)); assert.ok(results[1].duplicate);
  assert.equal(self.antigravityThreads.get(id).deliveries[0].receiptIdx, 2);
});

test('a new message verified by the intended window acknowledges without waiting for SQLite', async (t) => {
  const { self, id } = deliveryFixture(t);
  self.runAntigravitySend = async () => ({ ok: true, reason: 'confirmed', receiptSource: 'window', confirmedAt: Date.now() });
  const result = await self.antigravityCommand({ action: 'turn.start', requestId: 'window-receipt', args: { threadId: id, text: 'new' } });
  assert.equal(result.accepted, true);
  assert.equal(self.antigravityThreads.get(id).deliveries[0].receiptSource, 'window');
  assert.equal(self.antigravityThreads.get(id).deliveries[0].receiptIdx, undefined);
  const meta = self.antigravityThreads.get(id);
  assert.equal(meta.sentAt, meta.deliveries[0].attemptedAt);
});

test('a pre-click timeout is failed rather than falsely accepted or uncertain', async (t) => {
  const { self, id } = deliveryFixture(t);
  self.runAntigravitySend = async () => ({ ok: false, reason: 'automation_timeout', phase: 'finding', mayHaveSent: false });
  const result = await self.antigravityCommand({ action: 'turn.start', requestId: 'pre-click-timeout', args: { threadId: id, text: 'new' } });
  assert.equal(result.accepted, false); assert.equal(result.failed, true); assert.equal(result.uncertain, false);
});

test('cancelling during handoff cannot falsely cancel an already sent message', async (t) => {
  const { self, id } = deliveryFixture(t); let release;
  self.runAntigravitySend = () => new Promise((resolve) => { release = () => resolve({ ok: true, receiptSource: 'window', confirmedAt: Date.now() }); });
  const send = self.antigravityCommand({ action: 'turn.start', requestId: 'sending', args: { threadId: id, text: 'new' } });
  await new Promise((resolve) => setImmediate(resolve));
  const cancellation = assert.rejects(self.antigravityCommand({ action: 'followup.cancel', args: { threadId: id, id: 'sending' } }), /已经开始发送/);
  release(); assert.equal((await send).accepted, true); await cancellation;
  assert.equal(self.antigravityThreads.get(id).deliveries[0].state, 'started');
  assert.equal(self.frames.some((frame) => frame.kind === 'followup.cancelled'), false);
});

test('Antigravity queue cancellation is durable before acknowledgement', async (t) => {
  const { self, id } = deliveryFixture(t); const meta = self.antigravityThreads.get(id);
  meta.waiting = { kind: 'question' };
  await self.antigravityCommand({ action: 'followup.enqueue', requestId: 'waiting', args: { threadId: id, text: 'later' } });
  self.saveAntigravityThreads = () => { throw new Error('disk busy'); };
  await assert.rejects(self.antigravityCommand({ action: 'followup.cancel', args: { threadId: id, id: 'waiting' } }), /disk busy/);
  assert.equal(meta.queue.length, 1); assert.equal(meta.queue[0].state, undefined);
  assert.equal(self.frames.some((frame) => frame.kind === 'followup.cancelled'), false);
});

test('uncertain sends survive a connector restart and are never automatically resent', async (t) => {
  const { self, id, createSelf } = deliveryFixture(t); let sends = 0;
  self.runAntigravitySend = async () => { sends++; return { ok: true, reason: 'clicked' }; };
  const payload = { action: 'turn.start', requestId: 'uncertain', args: { threadId: id, text: 'hello' } };
  const result = await self.antigravityCommand(payload);
  assert.equal(result.accepted, false); assert.equal(result.uncertain, true); assert.equal(result.item.blocking, false);
  const restarted = createSelf(); restarted.antigravityThreads = restarted.readAntigravityThreads(); restarted.recoverAntigravityDeliveries();
  restarted.runAntigravitySend = async () => { throw new Error('must not resend'); };
  const replay = await restarted.antigravityCommand(payload);
  assert.equal(replay.uncertain, true); assert.equal(replay.duplicate, true); assert.equal(sends, 1);
  assert.equal(restarted.antigravityQueueItems(id)[0].state, 'uncertain');
  await restarted.drainAntigravityQueues();
});

test('a crash between clicking Send and saving its receipt recovers from history', async (t) => {
  const { self, id, addUser } = deliveryFixture(t);
  const entry = { id: 'crashed', text: 'hello', createdAt: Date.now(), state: 'dispatching', afterIdx: 1 };
  const meta = self.antigravityThreads.get(id); meta.queue = [entry]; meta.deliveries = [entry];
  addUser(2, 'hello'); self.saveAntigravityThreads(); self.recoverAntigravityDeliveries();
  assert.equal(meta.queue.length, 0); assert.equal(entry.state, 'started');
  self.runAntigravitySend = async () => { throw new Error('must not resend'); };
  const replay = await self.antigravityCommand({ action: 'turn.start', requestId: entry.id, args: { threadId: id, text: entry.text } });
  assert.equal(replay.accepted, true); assert.equal(replay.duplicate, true);
});

test('late history receipt clears an uncertain Antigravity delivery', async (t) => {
  const { self, id, home, addUser } = deliveryFixture(t);
  self.runAntigravitySend = async () => ({ ok: false, reason: 'bad_output' });
  await self.antigravityCommand({ action: 'turn.start', requestId: 'late', args: { threadId: id, text: 'hello' } });
  const entry = self.antigravityThreads.get(id).deliveries[0]; const olderVersion = entry.stateVersion;
  addUser(2, 'hello');
  await self.syncAntigravityConversation(path.join(home, 'conversations'), `${id}.db`, id);
  assert.equal(entry.state, 'started'); assert.ok(entry.stateVersion > olderVersion);
  assert.ok(self.frames.some((frame) => frame.kind === 'followup.started'));
});

test('known pre-send failures stay failed and outbox write failures never click Send', async (t) => {
  const { self, id } = deliveryFixture(t);
  self.runAntigravitySend = async () => ({ ok: false, reason: 'conversation_not_opened' });
  const result = await self.antigravityCommand({ action: 'turn.start', requestId: 'wrong-page', args: { threadId: id, text: 'hello' } });
  assert.equal(result.failed, true); assert.equal(result.accepted, false); assert.equal(result.uncertain, false);
  self.saveAntigravityThreads = () => { throw new Error('disk full'); };
  self.runAntigravitySend = async () => { throw new Error('must not touch window'); };
  await assert.rejects(self.antigravityCommand({ action: 'turn.start', requestId: 'disk', args: { threadId: id, text: 'hello' } }), /disk full/);
});

test('Antigravity question answered from the phone through the app window', async () => {
  const { install } = require('../src/backends/antigravity-sync');
  const fs = require('node:fs');
  const self = {}; install({ prototype: self });
  const id = '33333333-3333-3333-3333-333333333333'; let sent = null;
  Object.assign(self, {
    antigravityThreads: new Map([[id, { lastIdx: 1, waiting: { kind: 'question', requestId: 'call_1', questions: [{ question: 'Q', options: [{ label: 'Banana' }] }] } }]]),
    pollAntigravity: async () => {}, log() {},
    execFileFn(_cmd, args, _opts, done) {
      sent = { mode: args[args.indexOf('-Mode') + 1], body: JSON.parse(fs.readFileSync(args[args.indexOf('-TextFile') + 1], 'utf8')) };
      done(null, JSON.stringify({ ok: true, reason: 'answered' }));
    },
  });
  const result = await self.antigravityCommand({ action: 'claude.desktop.answer', args: { threadId: id, requestId: 'call_1', answers: [{ labels: ['Banana'], other: '' }] } });
  assert.equal(result.ok, true);
  assert.deepEqual(sent, { mode: 'answer', body: { answers: [{ labels: ['Banana'], other: '' }] } });
  await assert.rejects(self.antigravityCommand({ action: 'claude.desktop.answer', args: { threadId: id, requestId: 'call_old', answers: [{ labels: ['Banana'] }] } }), /没有正在等待/);
});

test('stopping a native questionnaire does not restore its stale SQLite waiting card', async (t) => {
  const { self, id, file, home } = deliveryFixture(t);
  const { DatabaseSync } = ag.loadSqlite(); const db = new DatabaseSync(file);
  const call = msg(field(1, 'stop-question'), field(2, 'ask_question'), field(3, JSON.stringify({ questions: [{ question: 'Choose', options: ['A', 'B'] }] })));
  db.prepare('insert into steps values(?, 132, 9, ?)').run(2, header(Math.floor(Date.now() / 1000) - 1, field(4, call)));
  db.close();
  const dir = path.join(home, 'conversations');
  await self.syncAntigravityConversation(dir, `${id}.db`, id);
  assert.equal(self.antigravityThreadStatus(self.antigravityThreads.get(id)), 'desktop_waiting');
  self.runAntigravitySend = async (_id, mode) => {
    assert.equal(mode, 'stop'); return { ok: true, questionCancelled: true };
  };
  await self.antigravityCommand({ action: 'turn.stop', args: { threadId: id } });
  // Force another checkpoint read containing the old unanswered question.
  self.antigravityThreads.get(id).mtimeMs = 0;
  await self.syncAntigravityConversation(dir, `${id}.db`, id);
  const meta = self.antigravityThreads.get(id);
  assert.equal(meta.waiting, null);
  assert.equal(meta.waitingId, null);
  assert.equal(self.antigravityThreadStatus(meta), 'interrupted');
  assert.deepEqual(self.antigravityActiveThreadRows(), []);
});

test('an unchanged annotation is not read again; a changed one is', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const ag = require('../src/backends/antigravity');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-ag-'));
  fs.mkdirSync(path.join(home, 'annotations'));
  const file = path.join(home, 'annotations', 'a.pbtxt');
  fs.writeFileSync(file, 'title:"First" last_user_view_time:{seconds:10}');
  assert.deepEqual(ag.readAnnotation(home, 'a'), { title: 'First', viewedAt: 10_000 });
  const realRead = fs.readFileSync; let reads = 0;
  fs.readFileSync = (...args) => { reads += 1; return realRead.apply(fs, args); };
  try {
    assert.equal(ag.readAnnotation(home, 'a').title, 'First');
    assert.equal(reads, 0, 'served from the cache');
    fs.writeFileSync(file, 'title:"Second title" last_user_view_time:{seconds:20}');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    assert.equal(ag.readAnnotation(home, 'a').title, 'Second title');
    assert.equal(reads, 1);
  } finally { fs.readFileSync = realRead; fs.rmSync(home, { recursive: true, force: true }); }
});

test('a deleted Antigravity conversation stops being announced as running', async () => {
  const { install } = require('../src/backends/antigravity-sync');
  const self = {}; install({ prototype: self });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-ag-ghost-'));
  fs.mkdirSync(path.join(home, 'conversations'));
  const frames = [];
  Object.assign(self, {
    config: { accountKey: 'k' }, antigravityHomeDir: home, antigravityInstanceId: 'x',
    antigravityThreads: new Map([['a5f02de2-0ec2-4954-8d5d-cb4c6ef55bcd', { running: true, announcedAt: 0, title: 'gone' }]]),
    saveAntigravityThreads() {}, emit(kind, id, payload) { frames.push({ kind, id, payload }); }, log() {},
    drainAntigravityQueues: async () => {},
  });
  await self.pollAntigravity();
  const meta = self.antigravityThreads.get('a5f02de2-0ec2-4954-8d5d-cb4c6ef55bcd');
  assert.equal(meta.running, false);
  assert.ok(frames.some((f) => f.kind === 'thread.status' && f.payload.status !== 'desktop_running'));
  assert.ok(!frames.some((f) => f.kind === 'thread.status' && f.payload.status === 'desktop_running'), 'not re-announced as running');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a deleted Antigravity conversation is archived on the relay once, even when no longer running', async () => {
  const { install } = require('../src/backends/antigravity-sync');
  const self = {}; install({ prototype: self });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-ag-deleted-'));
  fs.mkdirSync(path.join(home, 'conversations'));
  const requests = [];
  const id = 'a5f02de2-0ec2-4954-8d5d-cb4c6ef55bce';
  Object.assign(self, {
    config: { accountKey: Buffer.alloc(32, 7) }, antigravityHomeDir: home, antigravityInstanceId: 'x',
    // Seen 2026-10-09: not running here, but the relay row still said running.
    antigravityThreads: new Map([[id, { running: false, announcedAt: 0, title: '01 khMarkdown', lastAt: Date.parse('2026-09-29T10:10:33Z') }]]),
    api: { path: (p) => p, request: async (p, opts) => { requests.push({ p, body: opts.body }); return {}; } },
    saveAntigravityThreads() {}, emit() {}, log() {}, drainAntigravityQueues: async () => {},
  });
  await self.pollAntigravity();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].p, '/history/threads');
  assert.equal(requests[0].body.id, id);
  assert.equal(requests[0].body.archived, true);
  await self.pollAntigravity();
  assert.equal(requests.length, 1, 'archived only once');
  fs.rmSync(home, { recursive: true, force: true });
});
