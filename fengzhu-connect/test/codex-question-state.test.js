const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexQuestionTracker, questionEvent } = require('../src/codex-questions');
const { Connector, readRolloutEvidence, rolloutItem, rolloutStatus, rolloutUserText } = require('../src/connector');
const { normalizeItems } = require('../src/history');
const { FollowupStore } = require('../src/followup-store');

const base = Date.parse('2026-10-13T08:00:00Z');
const record = (at, type, payload) => ({ timestamp: new Date(base + at).toISOString(), type, payload });
const start = (at = 0, turn = 'turn-1') => record(at, 'event_msg', { type: 'task_started', turn_id: turn });
const end = (at = 100, turn = 'turn-1', type = 'task_complete') => record(at, 'event_msg', { type, turn_id: turn });
const ask = (at = 10, call = 'call_A', name = 'request_user_input_async') => record(at, 'response_item', {
  type: 'function_call', id: `fc_${call}`, call_id: call, name,
  arguments: JSON.stringify({ questions: [{ title: '测试颜色？', options: ['蓝色', '绿色'] }, { title: '测试布局？' }] }),
});
const reply = (at = 30, indexes = [0, 1], call = 'call_A') => record(at, 'event_msg', {
  type: 'user_message', message: `<send_user_message_question_reply>\n${JSON.stringify(indexes.map(i => ({
    questionItemId: JSON.stringify(['request_user_input_async', call, i]), answer: '测试回答',
  })))}\n</send_user_message_question_reply>`,
});
function tracked(...records) {
  const tracker = new CodexQuestionTracker();
  records.forEach(r => tracker.consume('t1', r));
  return tracker;
}

test('missing terminal record cannot make an independently idle thread wait forever', () => {
  const tracker = tracked(start(), ask());
  assert.equal(tracker.snapshot('t1', { running: false }).pending, false);
  assert.equal(tracker.snapshot('t1', { running: true }).pending, true);
  tracker.consume('t1', start(1000, 'turn-2'));
  assert.equal(tracker.snapshot('t1', { running: true }).pending, false);
  assert.equal(tracked(ask()).snapshot('t1').pending, false);
});

test('async receipt and ongoing tools never resolve unanswered questions or stop actual execution', () => {
  const tracker = tracked(start(), ask());
  for (const r of [
    record(20, 'response_item', { type: 'function_call_output', call_id: 'call_A', output: 'Questions presented to user' }),
    record(21, 'response_item', { type: 'function_call_output', call_id: 'call_tool', output: 'ok' }),
    record(22, 'event_msg', { type: 'token_count', info: {} }),
    record(23, 'response_item', { type: 'message', role: 'assistant', content: [{ text: '继续处理' }] }),
  ]) assert.equal(tracker.consume('t1', r), false);
  assert.equal(tracker.snapshot('t1').pending, true);
  assert.equal(tracker.snapshot('t1').questions.length, 2);
  assert.notEqual(rolloutStatus(ask()), 'waiting_input');
});

test('only matching real user answers resolve questions; partial replies retain the rest', () => {
  const tracker = tracked(start(), ask());
  tracker.consume('t1', record(20, 'event_msg', { type: 'user_message', message: '继续，先做其它工作' }));
  assert.equal(tracker.snapshot('t1').questions.length, 2);
  tracker.consume('t1', reply(30, [0]));
  assert.deepEqual(tracker.snapshot('t1').questions.map(q => q.id), ['["request_user_input_async","call_A",1]']);
  tracker.consume('t1', reply(31, [1], 'other_call'));
  assert.equal(tracker.snapshot('t1').pending, true);
  tracker.consume('t1', reply(40, [1]));
  assert.equal(tracker.snapshot('t1').pending, false);
});

test('desktop-native response_item user replies also resolve questions', () => {
  const event = reply();
  const tracker = tracked(start(), ask(), record(30, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: event.payload.message }] }));
  assert.equal(tracker.snapshot('t1').pending, false);
});

test('a delivered Desktop-escaped answer resolves the matching phone question', () => {
  const original = reply(30, [0]);
  original.payload.message = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: '["request_user_input_async","call_A",0]', question: '测试颜色？', answer: '蓝色' }])}\n</send_user_message_question_reply>`;
  const raw = original.payload.message.replace(/\\/g, '\\\\').replace(/</g, '\\<').replace(/\n/g, '\\\n');
  const escaped = record(30, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: raw }] });
  assert.deepEqual(questionEvent(escaped)?.ids, ['["request_user_input_async","call_A",0]']);
  assert.equal(rolloutItem(escaped)?.text, original.payload.message);
  assert.equal(rolloutUserText(escaped), original.payload.message);
  assert.equal(normalizeItems({ id: 't1', turns: [{ items: [{ type: 'userMessage', text: raw }] }] })[0].value.text, original.payload.message);
  const tracker = tracked(start(), ask(), escaped);
  assert.deepEqual(tracker.snapshot('t1').questions.map(q => q.id), ['["request_user_input_async","call_A",1]']);
  assert.equal(questionEvent(record(31, 'response_item', { type: 'message', role: 'user', content: [{ text: `例子 ${raw}` }] })), null);
  assert.equal(rolloutItem(record(31, 'response_item', { type: 'message', role: 'user', content: [{ text: `例子 ${raw}` }] }))?.text, `例子 ${raw}`);
  const corrupt = raw.replace('"answer":"蓝色"', '"answer":');
  assert.equal(questionEvent(record(32, 'response_item', { type: 'message', role: 'user', content: [{ text: corrupt }] })), null);
  assert.equal(rolloutItem(record(32, 'response_item', { type: 'message', role: 'user', content: [{ text: corrupt }] }))?.text, corrupt);
});

test('a confirmed escaped desktop message reconciles only its matching uncertain follow-up', (t) => {
  const questionId = '["request_user_input_async","call_A",0]';
  const body = [{ questionItemId: questionId, question: '测试颜色？', answer: '蓝色' }];
  const original = `<send_user_message_question_reply>\n${JSON.stringify(body)}\n</send_user_message_question_reply>`;
  const escaped = original.replace(/\\/g, '\\\\').replace(/</g, '\\<').replace(/\n/g, '\\\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-escaped-receipt-'));
  const file = path.join(dir, 'rollout.jsonl');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: escaped }],
  } })}\n`);
  const store = Object.create(FollowupStore.prototype);
  store.items = [
    { id: 'one', requestId: 'one', threadId: 't1', state: 'uncertain', createdAt: Date.now() - 1000, text: original },
    { id: 'other', requestId: 'other', threadId: 't1', state: 'uncertain', createdAt: Date.now() - 1000,
      text: original.replace('call_A', 'call_B') },
  ];
  store.remove = (id) => { const i = store.items.findIndex(item => item.id === id); return i < 0 ? null : store.items.splice(i, 1)[0]; };
  const connector = Object.create(Connector.prototype);
  connector.followups = store;
  const events = [];
  connector.emit = (type, threadId, value) => events.push({ type, threadId, value });
  connector.noteMatchedRolloutFollowupStarted = () => {};
  connector.reconcileStartedFollowups('t1', file);
  assert.deepEqual(store.items.map(item => item.id), ['other']);
  assert.deepEqual(events.map(event => [event.type, event.value.id]), [['followup.started', 'one']]);
});

test('out-of-order ask and receipt arriving after a real answer cannot resurrect attention', () => {
  const tracker = tracked(start(), reply(), ask());
  assert.equal(tracker.snapshot('t1').pending, false);
  assert.equal(tracker.snapshot('t1').updatedAt, base + 30);
  tracker.consume('t1', ask());
  assert.equal(tracker.snapshot('t1').pending, false);
});

test('terminal watermarks discard historical asks, while a new native turn can ask again', () => {
  const tracker = tracked(start(), ask(), end(), ask());
  assert.equal(tracker.snapshot('t1').pending, false);
  tracker.consume('t1', start(200, 'turn-2'));
  tracker.consume('t1', ask(210, 'call_B'));
  tracker.consume('t1', end(220, 'turn-1'));
  assert.equal(tracker.snapshot('t1').pending, true);
  assert.equal(tracker.snapshot('t1').turnId, 'turn-2');
  tracker.consume('t1', end(230, 'turn-2', 'turn_aborted'));
  assert.equal(tracker.snapshot('t1').pending, false);
});

test('replayed start markers and partial history never erase current pending questions', () => {
  const tracker = tracked(start(), ask());
  tracker.consume('t1', start());
  assert.equal(tracker.snapshot('t1').pending, true);
  tracker.consume('t1', reply(30, [0]));
  tracker.consume('t1', ask());
  assert.equal(tracker.snapshot('t1').questions.length, 1);
  assert.equal(tracker.snapshot('t1').questions[0].id, '["request_user_input_async","call_A",1]');
});

test('multiple question calls remain pending independently', () => {
  const tracker = tracked(start(), ask(), ask(15, 'call_B'), reply());
  assert.equal(tracker.snapshot('t1').questions.length, 2);
  assert.equal(tracker.snapshot('t1').itemId, 'fc_call_B');
  tracker.consume('t1', reply(40, [0, 1], 'call_B'));
  assert.equal(tracker.snapshot('t1').pending, false);
});

test('namespaced async tool creates the same native IDs and never becomes a blocking execution state', () => {
  for (const name of ['functions.request_user_input_async', 'functions/request_user_input_async']) {
    const r = ask(10, 'call_A', name);
    assert.equal(questionEvent(r).questions[0].id, '["request_user_input_async","call_A",0]');
    assert.equal(rolloutItem(r).type, 'codexQuestion');
    assert.notEqual(rolloutStatus(r), 'waiting_input');
  }
});

test('malformed asks, empty replies and assistant-quoted answers do not change attention', () => {
  const tracker = tracked(start(), ask());
  const empty = reply(30, [0]); empty.payload.message = empty.payload.message.replace('测试回答', '');
  for (const r of [empty, record(40, 'response_item', { type: 'message', role: 'assistant', content: [{ text: reply().payload.message }] }),
    record(50, 'response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'broken', arguments: '{bad' })]) {
    assert.equal(questionEvent(r), null);
    tracker.consume('t1', r);
  }
  assert.equal(tracker.snapshot('t1').questions.length, 2);
});

test('authoritative tail prevents historical question announcements after answer or completion, regardless of mtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-question-tail-'));
  const file = path.join(root, 'rollout.jsonl');
  const connector = Object.create(Connector.prototype);
  const events = [];
  connector.emit = (kind, threadId, payload) => events.push({ kind, threadId, payload });
  try {
    for (const finish of [reply(), end()]) {
      fs.writeFileSync(file, [start(), ask(), finish].map(JSON.stringify).join('\n') + '\n');
      fs.utimesSync(file, new Date(0), new Date(0));
      connector.trackCodexWaiting('t1', ask());
      connector.publishCodexQuestionState('t1', readRolloutEvidence(file));
      assert.equal(connector.codexQuestionTracker.snapshot('t1').pending, false);
    }
    assert.deepEqual(events, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live pending and clear states publish once; tools keep raw execution and repeated questions do not ring again', () => {
  const connector = Object.create(Connector.prototype);
  const events = [];
  connector.emit = (kind, threadId, payload) => events.push({ kind, payload });
  connector.trackCodexWaiting('t1', start());
  connector.trackCodexWaiting('t1', ask());
  connector.publishCodexQuestionState('t1');
  connector.publishCodexQuestionState('t1');
  assert.equal(connector.codexWaiting.size, 0);
  assert.deepEqual(events.map(e => e.kind), ['codex.question.state', 'codex.question']);
  assert.equal(events[0].payload.pending, true);
  connector.trackCodexWaiting('t1', reply());
  connector.publishCodexQuestionState('t1');
  connector.trackCodexWaiting('t1', ask());
  connector.publishCodexQuestionState('t1');
  assert.equal(events.filter(e => e.kind === 'codex.question.state').length, 2);
  assert.equal(events.at(-1).payload.pending, false);
  assert.equal(events.filter(e => e.kind === 'codex.question').length, 1);
});

test('native blocking requests use their original host RPC while Desktop-only requests stay explicitly read-only', () => {
  const r = record(20, 'response_item', { type: 'function_call', name: 'functions.request_user_input', call_id: 'native-input', arguments: JSON.stringify({ questions: [{ id: 'q', question: '测试', options: [{ label: '甲' }, { label: '乙' }] }] }) });
  for (const managed of [true, false]) {
    const connector = Object.create(Connector.prototype);
    connector.isBridgeOwnedThread = () => managed;
    connector.trackCodexWaiting('t1', r);
    assert.equal(connector.codexWaiting.has('t1'), !managed);
    if (!managed) assert.equal(connector.codexWaiting.get('t1').answerable, false);
  }
});
