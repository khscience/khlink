'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Connector } = require('../src/connector');
const { canAnswerDesktopQuestion, desktopQuestionAnswer, questionRolloutState, questionAnswerMatches, pendingDesktopQuestion } = require('../src/codex-desktop-answer');

const question = { id: 'drink', question: '喝什么？', multiSelect: false, options: [{ label: '茶' }, { label: '咖啡' }] };
const waiting = { requestId: 'call-one', questions: [question], answerable: true };
const args = { threadId: 'thread-one', requestId: 'call-one', answers: [{ labels: ['咖啡'], other: '' }] };
const record = (type, payload) => JSON.stringify({ type, payload }) + '\n';

function rollout(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-answer-test-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, record('event_msg', { type: 'task_started' }) + record('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'call-one' }));
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  return file;
}
function output(file, answer = '咖啡') {
  fs.appendFileSync(file, record('response_item', { type: 'function_call_output', call_id: 'call-one', output: JSON.stringify({ answers: { drink: { answers: [answer] } } }) }));
}
function receipts() {
  const rows = new Map();
  return { get: (id) => rows.get(id), begin(id) { const row = { id, state: 'dispatching' }; rows.set(id, row); return row; },
    update(id, value) { Object.assign(rows.get(id), value); return rows.get(id); } };
}

test('only a single non-secret question with distinct named choices can be offered on the phone', () => {
  assert.equal(canAnswerDesktopQuestion(waiting), true);
  for (const q of [{ ...question, multiSelect: true }, { ...question, secret: true }, { ...question, id: '' },
    { ...question, options: [{ label: '茶' }, { label: '茶' }] }]) assert.equal(canAnswerDesktopQuestion({ ...waiting, questions: [q] }), false);
  assert.equal(canAnswerDesktopQuestion({ ...waiting, questions: [question, question] }), false);
});

test('a phone answer must match the exact active request and one option or one custom value', () => {
  assert.deepEqual(desktopQuestionAnswer(waiting, args), { value: '咖啡', custom: false, questionId: 'drink' });
  assert.deepEqual(desktopQuestionAnswer(waiting, { ...args, answers: [{ labels: [], other: '  热水  ' }] }), { value: '热水', custom: true, questionId: 'drink' });
  for (const input of [{ ...args, requestId: 'old' }, { ...args, answers: [{ labels: ['水'] }] },
    { ...args, answers: [{ labels: ['茶', '咖啡'] }] }, { ...args, answers: [{ labels: ['茶'], other: '水' }] }]) {
    assert.throws(() => desktopQuestionAnswer(waiting, input));
  }
});

test('rollout confirmation requires the same call and matching answer, not an older completion', (t) => {
  const file = rollout(t);
  assert.equal(questionRolloutState(file, 'call-one').state, 'waiting');
  fs.appendFileSync(file, record('response_item', { type: 'function_call_output', call_id: 'old', output: '{}' }));
  assert.equal(questionRolloutState(file, 'call-one').state, 'waiting');
  output(file);
  const state = questionRolloutState(file, 'call-one');
  assert.equal(questionAnswerMatches(state, desktopQuestionAnswer(waiting, args)), true);
  assert.equal(questionAnswerMatches(state, { value: '茶', questionId: 'drink' }), false);
});

test('an ended or incomplete rollout question never permits an answer', (t) => {
  const file = rollout(t);
  fs.appendFileSync(file, record('event_msg', { type: 'turn_aborted' }));
  assert.equal(questionRolloutState(file, 'call-one').state, 'ended');
  fs.appendFileSync(file, '{"type":"response_item"');
  assert.equal(questionRolloutState(file, 'call-one').state, 'ended');
  assert.equal(questionRolloutState(file, 'unknown').state, 'missing');
});

test('a pending original question survives a connector restart but disappears after its output', (t) => {
  const file = rollout(t);
  assert.equal(pendingDesktopQuestion(file)?.payload.call_id, 'call-one');
  output(file);
  assert.equal(pendingDesktopQuestion(file), null);
});

test('desktop answer acknowledges only its original rollout output and does not replay a duplicate', async (t) => {
  const file = rollout(t); const self = Object.create(Connector.prototype); let calls = 0;
  self.codexWaiting = new Map([['thread-one', waiting]]); self.codexQuestionReceipts = receipts();
  self.codexQuestionThreadInfo = () => ({ title: '测试', file });
  self.codexDesktopAnswer = { answer: async () => { calls++; output(file); return { delivery: 'confirmed' }; } };
  assert.deepEqual(await self.answerCodexOnDesktop('thread-one', args), { answered: true, backend: 'codex' });
  await assert.rejects(self.answerCodexOnDesktop('thread-one', args), /已变化/);
  assert.equal(calls, 1);
});

test('unconfirmed desktop invocation is durable and never replays, while a proven not-sent result may be retried', async (t) => {
  const file = rollout(t); const self = Object.create(Connector.prototype); let calls = 0;
  self.codexWaiting = new Map([['thread-one', waiting]]); self.codexQuestionReceipts = receipts();
  self.codexQuestionThreadInfo = () => ({ title: '测试', file });
  self.codexDesktopAnswer = { answer: async () => { calls++; return { delivery: 'not_sent', code: 'draft_present' }; } };
  await assert.rejects(self.answerCodexOnDesktop('thread-one', args), /未发送/);
  self.codexDesktopAnswer = { answer: async () => { calls++; fs.appendFileSync(file, record('event_msg', { type: 'turn_aborted' })); return { delivery: 'uncertain' }; } };
  await assert.rejects(self.answerCodexOnDesktop('thread-one', args), /尚未确认/);
  await assert.rejects(self.answerCodexOnDesktop('thread-one', args), /已变化/);
  assert.equal(calls, 2);
});

test('desktop-only question mapping exposes only supported cards on a Windows driver', () => {
  const self = Object.create(Connector.prototype);
  self.codexDesktopAnswer = {}; self.codexQuestionTracker = { consume: () => false };
  self.isBridgeOwnedThread = () => false;
  const row = { type: 'response_item', timestamp: '2026-11-02T10:00:00Z', payload: { type: 'function_call', name: 'request_user_input', call_id: 'call-one', arguments: JSON.stringify({ questions: [question] }) } };
  self.trackCodexWaiting('thread-one', row);
  assert.equal(self.codexWaiting.get('thread-one').answerable, true);
  assert.equal(self.codexWaiting.get('thread-one').questions[0].id, 'drink');
  row.payload.arguments = JSON.stringify({ questions: [{ ...question, multiSelect: true }] });
  self.trackCodexWaiting('thread-one', row);
  assert.equal(self.codexWaiting.get('thread-one').answerable, false);
});
