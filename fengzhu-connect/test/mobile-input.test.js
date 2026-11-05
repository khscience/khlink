const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMobileInputRequest, semanticAnswerResult } = require('../src/connector');
const { Connector, codexInput } = require('../src/connector');
const { CodexClient } = require('../src/codex-client');

test('normalizes a Codex user-input request without exposing raw protocol fields', () => {
  const request = normalizeMobileInputRequest('item/tool/requestUserInput', {
    title: 'Choose a path', internalOnly: 'must not be sent as a mobile field', questions: [{
      id: 'target', question: 'Where should this go?', description: 'A safe test only', multiple: true,
      allowCustomInput: true, options: ['Desktop', { value: 'phone', label: 'Phone', description: 'Mobile device' }],
    }],
  });

  assert.equal(request.kind, 'user_input');
  assert.equal(request.questions[0].id, 'target');
  assert.equal(request.questions[0].multiple, true);
  assert.deepEqual(request.questions[0].options.map((item) => item.value), ['Desktop', 'phone', '__custom__']);
  assert.equal(JSON.stringify(request).includes('internalOnly'), false);
});

test('maps semantic selection and custom text back to Codex answers by original question id', () => {
  const result = semanticAnswerResult({
    method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'target' }, { id: 'note' }] },
  }, {
    answers: {
      target: { selected: ['phone', '__custom__'], customText: 'tablet' },
      note: { selected: [], customText: 'use the safe workspace' },
    },
  });

  assert.deepEqual(result, {
    answers: {
      target: { answers: ['phone', 'tablet'] },
      note: { answers: ['use the safe workspace'] },
    },
  });
});

test('does not duplicate a generic approval method in the mobile dialog', () => {
  const request = normalizeMobileInputRequest('item/commandExecution/requestApproval', {});
  assert.equal(request.kind, 'approval');
  assert.equal(request.detail, '');
});

test('keeps native blocking semantics, other input, free text and secret fields', () => {
  for (const blocking of [true, false]) {
    const request = normalizeMobileInputRequest('item/tool/requestUserInput', { isBlocking: blocking, questions: [
      { id: 'choice', question: '选择', isOther: true, options: [{ label: '中文甲', description: '甲' }, { label: '中文乙', description: '乙' }] },
      { id: 'text', question: '填写', isSecret: true },
    ] });
    assert.equal(request.blocking, blocking);
    assert.equal(request.questions[0].options.at(-1).value, '__custom__');
    assert.equal(request.questions[1].secret, true);
    assert.equal(request.questions[1].options.at(-1).value, '__custom__');
  }
});

test('question replies remain exactly parseable by Desktop and retain the native client receipt id separately', () => {
  const body = [{ questionItemId: '["request_user_input_async","call_A",0]', question: '中文选项？', answer: '自由回答\n第二行' }];
  const text = `<send_user_message_question_reply>\n${JSON.stringify(body)}\n</send_user_message_question_reply>`;
  const input = codexInput(text, [], '11111111-1111-4111-8111-111111111111');
  assert.equal(input.length, 1);
  assert.equal(input[0].text.trim(), text);
  assert.deepEqual(JSON.parse(input[0].text.trim().slice(34, -35)), body);
});

test('a real pending request has no invented expiry and only blocking questions override running', () => {
  for (const blocking of [true, false]) {
    const connector = Object.create(Connector.prototype), events = [], statuses = [];
    connector.emit = (...args) => events.push(args); connector.log = () => {};
    connector.publishThreadStatus = (...args) => statuses.push(args);
    connector.onApproval({ id: 42, method: 'item/tool/requestUserInput', params: { threadId: 'test', isBlocking: blocking, questions: [{ id: 'a', question: '测试' }] } });
    assert.equal(events[0][2].expiresAt, 0);
    assert.equal(events[0][2].request.blocking, blocking);
    assert.equal(statuses.length, blocking ? 1 : 0);
  }
});

test('resolved or cross-thread input cannot answer a stale or different RPC', () => {
  const client = new CodexClient({}), connector = Object.create(Connector.prototype), events = [];
  connector.codex = client; connector.emit = (...args) => events.push(args); connector.log = () => {};
  client.onMessage({ id: 42, method: 'item/tool/requestUserInput', params: { threadId: 'first' } });
  connector.resolveApproval({ rpcId: '42', threadId: 'second', semanticAnswer: { answers: {} } });
  assert.equal(events.at(-1)[2].accepted, false);
  assert.equal(client.serverRequests.size, 1);
  client.onMessage({ method: 'serverRequest/resolved', params: { requestId: 42 } });
  assert.equal(client.serverRequests.size, 0);
  connector.resolveApproval({ rpcId: '42', threadId: 'first', semanticAnswer: { answers: {} } });
  assert.equal(events.at(-1)[2].expired, true);
});
