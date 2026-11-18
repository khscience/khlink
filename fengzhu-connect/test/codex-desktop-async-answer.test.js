'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAsyncAnswer, parseAsyncAnswers, prepareAsyncAnswer, prepareAsyncAnswers, nativeAsyncAnswerAfter } = require('../src/codex-desktop-async-answer');
const { CodexDesktopAnswer } = require('../src/codex-desktop-answer');
const { parseSteerOutput } = require('../src/codex-desktop-steer');

const id = JSON.stringify(['request_user_input_async', 'call-a', 0]);
const payload = (questionItemId = id, answer = '咖啡') => `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId, question: '喝什么？', answer }])}\n</send_user_message_question_reply>`;
const start = { type: 'start', at: 1, turnId: 'turn-1' };
const ask = { type: 'ask', at: 2, callId: 'call-a', questions: [{ id, question: '喝什么？', options: ['茶', '咖啡'] }] };
const live = (events = [start, ask]) => ({ status: 'running', turnStartMarker: { at: 1 }, questionEvents: events });
const record = (text, role = 'user') => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } }) + '\n';

test('only a complete valid single async answer is accepted', () => {
  assert.deepEqual(parseAsyncAnswer(payload()), { questionId: id, callId: 'call-a', question: '喝什么？', value: '咖啡' });
  for (const text of ['', '普通消息', `示例 ${payload()}`, payload('bad'), payload(JSON.stringify(['other', 'a', 0])),
    payload(JSON.stringify(['request_user_input_async', 'a', -1])), payload(id, ' '), payload(id, 'a\u0000b')]) {
    assert.equal(parseAsyncAnswer(text), null);
  }
});

test('the exact live single-question call and option are required; free text remains supported', () => {
  const reply = parseAsyncAnswer(payload());
  assert.deepEqual(prepareAsyncAnswer(reply, live()), { question: { id, question: '喝什么？', options: [{ label: '茶' }, { label: '咖啡' }] },
    answer: { questionId: id, value: '咖啡', custom: false } });
  assert.equal(prepareAsyncAnswer(parseAsyncAnswer(payload(id, '热水')), live()).answer.custom, true);
  assert.equal(prepareAsyncAnswer(reply, { ...live(), status: 'completed' }), null);
  assert.equal(prepareAsyncAnswer(reply, { ...live(), turnStartMarker: null }), null);
  assert.equal(prepareAsyncAnswer({ ...reply, question: '不是这个问题' }, live()), null);
  assert.equal(prepareAsyncAnswer(reply, live([start, ask, { type: 'answer', at: 3, ids: [id] }])), null);
  const second = { id: JSON.stringify(['request_user_input_async', 'call-a', 1]), question: '何时？', options: ['现在', '稍后'] };
  assert.equal(prepareAsyncAnswer(reply, live([start, { ...ask, questions: [ask.questions[0], second] }])), null);
  assert.equal(prepareAsyncAnswer(reply, live([start, { ...ask, questions: [ask.questions[0], second] }, { type: 'answer', at: 3, ids: [second.id] }])), null);
  const sameText = { ...ask, callId: 'call-b', at: 3, questions: [{ ...ask.questions[0], id: JSON.stringify(['request_user_input_async', 'call-b', 0]) }] };
  assert.equal(prepareAsyncAnswer(reply, live([start, ask, sameText])), null, 'the native panel cannot disambiguate identical live questions');
  assert.equal(prepareAsyncAnswer(reply, live([start, { ...ask, questions: [{ ...ask.questions[0], options: ['茶', '茶'] }] }])), null);
});

test('native receipt must be a complete new unescaped user record for the exact question and answer', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-native-async-'));
  const file = path.join(dir, 'rollout.jsonl');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  const reply = parseAsyncAnswer(payload());
  fs.writeFileSync(file, record(payload()));
  const offset = fs.statSync(file).size;
  assert.equal(nativeAsyncAnswerAfter(file, offset, reply), false, 'an old matching reply cannot confirm a new send');
  const escaped = payload().replace(/\\/g, '\\\\').replace(/</g, '\\<').replace(/\n/g, '\\\n');
  fs.appendFileSync(file, record(escaped) + record(payload(id, '茶')) + record(payload(), 'assistant'));
  assert.equal(nativeAsyncAnswerAfter(file, offset, reply), false, 'escaped, wrong and assistant text cannot confirm');
  const line = record(payload());
  fs.appendFileSync(file, line.slice(0, -1));
  assert.equal(nativeAsyncAnswerAfter(file, offset, reply), false, 'partial record cannot confirm');
  fs.appendFileSync(file, '\n');
  assert.equal(nativeAsyncAnswerAfter(file, offset, reply), true);
  assert.equal(nativeAsyncAnswerAfter(file, fs.statSync(file).size + 1, reply), false);
});

test('a group must contain every question of the same active call in order', () => {
  const secondId = JSON.stringify(['request_user_input_async', 'call-a', 1]);
  const second = { id: secondId, question: '何时？', options: ['现在', '稍后'] };
  const group = { ...ask, questions: [ask.questions[0], second] };
  const rows = [{ questionItemId: id, question: '喝什么？', answer: '茶' }, { questionItemId: secondId, question: '何时？', answer: '一会儿' }];
  const envelope = value => `<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`;
  const replies = parseAsyncAnswers(envelope(rows));
  const prepared = prepareAsyncAnswers(replies, live([start, group]));
  assert.deepEqual(prepared.answers.map(a => [a.value, a.custom]), [['茶', false], ['一会儿', true]]);
  assert.deepEqual(prepared.questions.map(q => q.id), [id, secondId]);
  assert.equal(prepareAsyncAnswers(parseAsyncAnswers(envelope(rows.slice(0, 1))), live([start, group])), null);
  assert.equal(parseAsyncAnswers(envelope([rows[1], rows[0]])), null);
  assert.equal(parseAsyncAnswers(envelope([rows[0], rows[0]])), null);
  assert.equal(parseAsyncAnswers(envelope([rows[0], { ...rows[1], questionItemId: JSON.stringify(['request_user_input_async', 'call-b', 1]) }])), null);
  assert.equal(prepareAsyncAnswers(replies, live([start, group, { type: 'answer', at: 3, ids: [secondId] }])), null);
  const ambiguous = { ...group, questions: [group.questions[0], { ...group.questions[0], id: secondId }] };
  assert.equal(prepareAsyncAnswers(replies, live([start, ambiguous])), null);
});

test('a grouped receipt requires all answers together, not a partial or escaped record', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-native-group-'));
  const file = path.join(dir, 'rollout.jsonl');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  const secondId = JSON.stringify(['request_user_input_async', 'call-a', 1]);
  const rows = [{ questionItemId: id, question: '喝什么？', answer: '茶' }, { questionItemId: secondId, question: '何时？', answer: '现在' }];
  const envelope = value => `<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`;
  const expected = parseAsyncAnswers(envelope(rows));
  fs.writeFileSync(file, record(envelope(rows.slice(0, 1))) + record(envelope(rows).replace(/</g, '\\<')));
  assert.equal(nativeAsyncAnswerAfter(file, 0, expected), false);
  fs.appendFileSync(file, record(envelope(rows)));
  assert.equal(nativeAsyncAnswerAfter(file, 0, expected), true);
});

test('the native driver receives the whole group and a mid-group failure stays uncertain', async () => {
  const questions = [
    { id, question: '喝什么？', options: [{ label: '茶' }, { label: '咖啡' }] },
    { id: JSON.stringify(['request_user_input_async', 'call-a', 1]), question: '何时？', options: [{ label: '现在' }, { label: '稍后' }] },
  ];
  const answers = [{ questionId: id, value: '茶', custom: false }, { questionId: questions[1].id, value: '一会儿', custom: true }];
  const driver = new CodexDesktopAnswer({ execFileFn: (_exe, args, options, callback) => {
    const data = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
    assert.equal(data.group.length, 2); assert.equal(data.group[1].answer, '一会儿'); assert.equal(data.group[1].custom, true);
    assert.ok(options.timeout >= 60_000);
    callback(null, '{"phase":"editing"}\n{"code":"question_unavailable","delivery":"not_sent"}');
  } });
  const result = await driver.answer({ threadId: 'thread', title: '测试', questions, answers, asynchronous: true });
  assert.equal(result.delivery, 'uncertain');
  assert.equal(parseSteerOutput('{"code":"question_unavailable","delivery":"not_sent"}').delivery, 'not_sent');
});

test('the Windows PowerShell 5 script remains ASCII and accepts a noninteractive preflight', { skip: process.platform !== 'win32' }, t => {
  const { execFileSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'scripts', 'codex-desktop-answer.ps1');
  assert.match(fs.readFileSync(script, 'utf8'), /^[\x00-\x7f]*$/, 'PowerShell 5 interprets UTF-8 without BOM as a legacy code page');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-answer-preflight-'));
  const file = path.join(dir, 'input.json'), prefixFile = path.join(dir, 'prefix.ps1');
  t.after(() => { fs.unlinkSync(file); if (fs.existsSync(prefixFile)) fs.unlinkSync(prefixFile); fs.rmdirSync(dir); });
  // The second question is intentionally invalid, so this cannot open or
  // interact with a real Desktop window even when it exists.
  fs.writeFileSync(file, JSON.stringify({ threadId: '00000000-0000-0000-0000-000000000000', title: '隔离测试',
    question: '测试一', labels: ['甲', '乙'], answer: '甲', asynchronous: true,
    group: [{ question: '测试一', labels: ['甲', '乙'], answer: '甲' }, { question: '测试二', labels: ['甲'], answer: '甲' }] }));
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-InputFile', file], { encoding: 'utf8' }));
  assert.equal(result.code, 'invalid_input'); assert.equal(result.delivery, 'not_sent');
  // Run the actual script's validation prefix only: it never reaches window
  // discovery. PowerShell 5 otherwise unwraps a single item into a scalar.
  const source = fs.readFileSync(script, 'utf8');
  fs.writeFileSync(prefixFile, source.slice(0, source.indexOf('function Get-Window')) + '\n[Console]::Out.WriteLine("steps=$($steps.Count)")\n');
  const valid = { threadId: '00000000-0000-0000-0000-000000000000', title: '隔离测试',
    question: '测试一', labels: ['甲', '乙'], answer: '甲', asynchronous: true };
  for (const [group, count] of [[null, 1], [[valid, { ...valid, question: '测试二' }], 2]]) {
    fs.writeFileSync(file, JSON.stringify({ ...valid, group }));
    const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', prefixFile, '-InputFile', file], { encoding: 'utf8' });
    assert.equal(text.trim(), `steps=${count}`);
  }
});
