'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Connector } = require('../src/connector');
const { FollowupStore } = require('../src/followup-store');

const id = JSON.stringify(['request_user_input_async', 'call-drink', 0]);
const reply = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: id, question: '喝什么？', answer: '咖啡' }])}\n</send_user_message_question_reply>`;
const now = () => new Date().toISOString();
const record = (type, payload) => JSON.stringify({ timestamp: now(), type, payload }) + '\n';
const userRecord = text => record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-native-routing-'));
  const file = path.join(dir, 'rollout.jsonl');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  fs.writeFileSync(file, record('event_msg', { type: 'task_started', turn_id: 'turn-a' }) +
    record('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'call-drink',
      arguments: JSON.stringify({ questions: [{ question: '喝什么？', options: [{ label: '茶' }, { label: '咖啡' }] }] }) }));
  const self = Object.create(Connector.prototype);
  self.followups = Object.create(FollowupStore.prototype);
  self.followups.items = [{ id: 'm1', requestId: 'm1', threadId: 'thread-a', title: '测试饮品', text: reply, displayText: reply,
    mode: 'queue', state: 'pending', steerRequested: true, createdAt: Date.now(), attachments: [] }];
  self.followups.save = () => true;
  self.events = []; self.emit = (kind, thread, value) => self.events.push({ kind, value }); self.log = () => {};
  self.nativeAsyncReceiptChecks = 0;
  self.codexQuestionThreadInfo = () => ({ title: '测试饮品', file });
  self.noteMatchedRolloutFollowupStarted = () => {};
  self.threadState = new Map(); self.desktopStatuses = new Map(); self.desktopActiveThreads = new Set();
  self.threadOwner = () => ({ owner: 'desktop' }); self.isBridgeOwnedThread = () => false;
  self.confirmCodexHostThread = async () => false; self.markDesktopThread = () => {};
  self.desktopAdapter = { probe: async () => ({ code: 'task_active' }) };
  self.probeDesktopThread = async () => ({ code: 'task_active' });
  self.codex = { request: async () => assert.fail('native answer must not enter the protocol queue') };
  self.codexDesktopSteer = { steer: async () => assert.fail('native answer must not enter the ordinary composer') };
  return { self, file };
}

test('Desktop-owned async reply is submitted by the native question control and confirmed by the raw record', async t => {
  const { self, file } = fixture(t); let calls = 0;
  self.codexDesktopAnswer = { answer: async value => {
    calls++; assert.equal(value.asynchronous, true); assert.equal(value.answer.value, '咖啡');
    fs.appendFileSync(file, userRecord(reply)); return { code: 'invoked', delivery: 'confirmed' };
  } };
  const result = await self.dispatchFollowup(self.followups.get('m1'));
  assert.equal(result.state, 'started'); assert.equal(calls, 1);
  assert.equal(self.events.filter(e => e.kind === 'steer.accepted').length, 1);
  assert.equal(self.followups.matchStarted('thread-a', reply), null, 'generic text reconciliation cannot consume a native receipt');
  self.reconcileStartedFollowups('thread-a', file);
  assert.equal(self.followups.get('m1'), undefined);
});

test('an escaped lookalike or missing receipt stays uncertain and is never resent; a late raw receipt resolves it', async t => {
  const { self, file } = fixture(t); let calls = 0;
  self.codexDesktopAnswer = { answer: async () => {
    calls++; const escaped = reply.replace(/\\/g, '\\\\').replace(/</g, '\\<').replace(/\n/g, '\\\n');
    fs.appendFileSync(file, userRecord(escaped)); return { code: 'invoked', delivery: 'confirmed' };
  } };
  const result = await self.dispatchFollowup(self.followups.get('m1'));
  assert.equal(result.state, 'uncertain');
  self.reconcileStartedFollowups('thread-a', file);
  assert.equal(self.followups.get('m1').state, 'uncertain'); assert.equal(calls, 1);
  fs.appendFileSync(file, userRecord(reply));
  self.reconcileStartedFollowups('thread-a', file);
  assert.equal(self.followups.get('m1'), undefined);
  assert.equal(self.events.filter(e => e.kind === 'followup.started').length, 1);
});

test('missing, changed or completed questions fail closed without typing or queueing', async t => {
  const { self, file } = fixture(t); let calls = 0;
  self.codexDesktopAnswer = { answer: async () => { calls++; return { delivery: 'not_sent' }; } };
  fs.appendFileSync(file, record('event_msg', { type: 'task_complete', turn_id: 'turn-a' }));
  const result = await self.dispatchFollowup(self.followups.get('m1'));
  assert.equal(result.state, 'failed'); assert.equal(calls, 0);
  assert.match(result.reason, /选项/);
});

test('an incomplete multi-question group fails without skipping any question', async t => {
  const { self, file } = fixture(t); let calls = 0;
  fs.appendFileSync(file, record('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'call-drink',
    arguments: JSON.stringify({ questions: [
      { question: '喝什么？', options: [{ label: '茶' }, { label: '咖啡' }] },
      { question: '何时？', options: [{ label: '现在' }, { label: '稍后' }] },
    ] }) }));
  self.codexDesktopAnswer = { answer: async () => { calls++; } };
  const result = await self.dispatchFollowup(self.followups.get('m1'));
  assert.equal(result.state, 'failed'); assert.match(result.reason, /选项/); assert.equal(calls, 0);
});

test('a full multi-question group uses one native control invocation and one complete receipt', async t => {
  const { self, file } = fixture(t);
  const id2 = JSON.stringify(['request_user_input_async', 'call-drink', 1]);
  const grouped = `<send_user_message_question_reply>\n${JSON.stringify([
    { questionItemId: id, question: '喝什么？', answer: '咖啡' },
    { questionItemId: id2, question: '何时？', answer: '一会儿' },
  ])}\n</send_user_message_question_reply>`;
  const item = self.followups.get('m1'); item.text = grouped; item.displayText = grouped;
  fs.appendFileSync(file, record('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'call-drink',
    arguments: JSON.stringify({ questions: [
      { question: '喝什么？', options: [{ label: '茶' }, { label: '咖啡' }] },
      { question: '何时？', options: [{ label: '现在' }, { label: '稍后' }] },
    ] }) }));
  let calls = 0;
  self.codexDesktopAnswer = { answer: async value => {
    calls++; assert.equal(value.questions.length, 2); assert.deepEqual(value.answers.map(a => a.value), ['咖啡', '一会儿']);
    fs.appendFileSync(file, userRecord(grouped)); return { code: 'invoked', delivery: 'confirmed' };
  } };
  const result = await self.dispatchFollowup(item);
  assert.equal(result.state, 'started'); assert.equal(calls, 1);
  self.reconcileStartedFollowups('thread-a', file);
  assert.equal(self.followups.get('m1'), undefined);
});

test('a definite unavailable native control preserves the choice without automatic retry', async t => {
  const { self } = fixture(t);
  self.codexDesktopAnswer = { answer: async () => ({ code: 'question_unavailable', delivery: 'not_sent' }) };
  const result = await self.dispatchFollowup(self.followups.get('m1'));
  assert.equal(result.state, 'failed'); assert.equal(result.nextRetryAt, null);
  assert.equal(self.events.some(e => e.kind === 'steer.accepted'), false);
});

test('racing answers to one question invoke the native control at most once', async t => {
  const { self, file } = fixture(t); let calls = 0;
  const first = self.followups.get('m1');
  const second = { ...first, id: 'm2', requestId: 'm2' };
  self.followups.add(second);
  self.codexDesktopAnswer = { answer: async () => {
    calls++; fs.appendFileSync(file, userRecord(reply)); return { code: 'invoked', delivery: 'confirmed' };
  } };
  const results = await Promise.all([
    self.withCodexDesktopWindowLock(() => self.answerNativeAsyncFollowup(first, 'phone', { retainReceipt: true })),
    self.withCodexDesktopWindowLock(() => self.answerNativeAsyncFollowup(second, 'phone', { retainReceipt: true })),
  ]);
  assert.equal(calls, 1); assert.equal(results[0].accepted, true); assert.equal(results[1].failed, true);
  assert.equal(self.events.filter(e => e.kind === 'steer.accepted').length, 1);
});

test('an older queued question answer is removed from the protocol queue before using the native control', async t => {
  const { self, file } = fixture(t); const item = self.followups.get('m1');
  Object.assign(item, { state: 'desktop_queued', queueTransport: 'codex', codexQueueId: 'old-row' });
  const calls = [];
  self.codex.request = async (method, args) => { calls.push([method, args.queuedSubmissionId]); return {}; };
  self.codexDesktopAnswer = { answer: async () => {
    fs.appendFileSync(file, userRecord(reply)); return { code: 'invoked', delivery: 'confirmed' };
  } };
  const result = await self.steerCodexQueueThroughWindow(item, 'phone', { retainReceipt: true });
  assert.equal(result.accepted, true); assert.deepEqual(calls, [['thread/queue/delete', 'old-row']]);
});
