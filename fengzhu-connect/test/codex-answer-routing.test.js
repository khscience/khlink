const test = require('node:test');
const assert = require('node:assert/strict');
const { isCodexQuestionReply } = require('../src/codex-questions');

test('only a complete native answer payload qualifies for immediate question delivery', () => {
  const wrap = value => `<send_user_message_question_reply>${JSON.stringify(value)}</send_user_message_question_reply>`;
  const answer = { questionItemId: '["request_user_input_async","call-1",0]', question: '想去哪儿？', answer: '公园' };
  assert.equal(isCodexQuestionReply(wrap([answer])), true);
  assert.equal(isCodexQuestionReply(wrap([answer, { ...answer, answer: '其他：植物园' } ])), true);
  for (const text of [wrap([]), wrap({}), wrap([{ ...answer, answer: '' }]), wrap([{ answer: '公园' }]),
    `示例 ${wrap([answer])}`, `${wrap([answer])} 后续文字`, '<send_user_message_question_reply>not json</send_user_message_question_reply>', '公园']) {
    assert.equal(isCodexQuestionReply(text), false, text);
  }
});
