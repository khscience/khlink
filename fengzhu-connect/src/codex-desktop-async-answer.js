'use strict';

// Native async question replies are ordinary user messages with a structured
// envelope, but putting that envelope in Desktop's rich-text composer makes
// it Markdown-escaped. The native question control sends it unescaped.
const fs = require('node:fs');
const { CodexQuestionTracker, isCodexQuestionReply } = require('./codex-questions');
const MAX_REPLY_BYTES = 16 * 1024 * 1024;

function parseAsyncAnswers(text) {
  const value = String(text || '').trim();
  if (!isCodexQuestionReply(value)) return null;
  const json = value.slice('<send_user_message_question_reply>'.length, -'</send_user_message_question_reply>'.length).trim();
  const rows = JSON.parse(json);
  if (rows.length < 1 || rows.length > 8) return null;
  const replies = [];
  for (const row of rows) {
    let id; try { id = JSON.parse(row.questionItemId); } catch { return null; }
    if (!Array.isArray(id) || id.length !== 3 || id[0] !== 'request_user_input_async' ||
        typeof id[1] !== 'string' || !id[1] || !Number.isSafeInteger(id[2]) || id[2] !== replies.length ||
        !row.question.trim() || row.answer.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(row.answer) ||
        (replies.length && replies[0].callId !== id[1])) return null;
    replies.push({ questionId: row.questionItemId, callId: id[1], question: row.question, value: row.answer.trim() });
  }
  return replies;
}

function parseAsyncAnswer(text) { const replies = parseAsyncAnswers(text); return replies?.length === 1 ? replies[0] : null; }

// The entire original group must remain live: never skip or partially submit.
function prepareAsyncAnswers(replies, evidence) {
  if (!Array.isArray(replies) || !replies.length || !evidence || evidence.status !== 'running' || !evidence.turnStartMarker) return null;
  const tracker = new CodexQuestionTracker();
  for (const event of evidence.questionEvents || []) tracker.apply('desktop', event);
  const callId = replies[0].callId;
  const originalAsk = (evidence.questionEvents || []).findLast(event => event.type === 'ask' && event.callId === callId);
  if (!originalAsk || originalAsk.questions.length !== replies.length) return null;
  const questions = tracker.snapshot('desktop', { running: true })?.questions || [];
  const sameCall = questions.filter(q => {
    try { const id = JSON.parse(q.id); return Array.isArray(id) && id[0] === 'request_user_input_async' && id[1] === callId; }
    catch { return false; }
  });
  // The accessible Desktop panel exposes its text and choices, not the call
  // ID. Two live calls with the same heading cannot be distinguished safely,
  // even if the phone has their distinct IDs.
  if (sameCall.length !== replies.length) return null;
  // A later page with the same heading and choices is indistinguishable from
  // the previous page before Desktop finishes its asynchronous transition.
  const identities = sameCall.map(q => JSON.stringify([q.question, q.options]));
  if (new Set(identities).size !== identities.length) return null;
  const prepared = [];
  for (let i = 0; i < replies.length; i++) {
    const reply = replies[i], question = sameCall[i];
    if (!question || originalAsk.questions[i].id !== reply.questionId || question.id !== reply.questionId ||
        question.question !== reply.question || questions.some(q => q.question === reply.question && !sameCall.includes(q))) return null;
    const options = question.options || [];
    if (options.length < 2 || options.length > 8 ||
        options.some(label => typeof label !== 'string' || !label.trim() || label.length > 512) || new Set(options).size !== options.length) return null;
    prepared.push({ question: { id: question.id, question: question.question, options: options.map(label => ({ label })) },
      answer: { questionId: reply.questionId, value: reply.value, custom: !options.includes(reply.value) } });
  }
  return prepared.length === 1 ? prepared[0] : { questions: prepared.map(p => p.question), answers: prepared.map(p => p.answer) };
}

function prepareAsyncAnswer(reply, evidence) { return reply ? prepareAsyncAnswers([reply], evidence) : null; }

// Look only at complete records written after the native action began. A
// Markdown-escaped message does not prove Desktop recognized the question.
function nativeAsyncAnswerAfter(file, offset, expected) {
  if (!file || !Number.isSafeInteger(offset) || offset < 0 || !expected) return false;
  const expectedReplies = Array.isArray(expected) ? expected : [expected];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < offset || size - offset > MAX_REPLY_BYTES) return false;
    let start = offset;
    if (start > 0) {
      const previous = Buffer.alloc(1); fs.readSync(fd, previous, 0, 1, start - 1);
      if (previous[0] !== 0x0a) {
        const probe = Buffer.alloc(size - start); const count = fs.readSync(fd, probe, 0, probe.length, start);
        const newline = probe.subarray(0, count).indexOf(0x0a);
        if (newline < 0) return false;
        start += newline + 1;
      }
    }
    const buffer = Buffer.alloc(size - start); const count = fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, count).toString('utf8');
    const lines = text.split('\n'); if (!text.endsWith('\n')) lines.pop();
    for (const line of lines) {
      let record; try { record = JSON.parse(line); } catch { continue; }
      const p = record?.payload || {};
      const user = record.type === 'event_msg' && p.type === 'user_message' ||
        record.type === 'response_item' && p.type === 'message' && p.role === 'user';
      if (!user) continue;
      const raw = String(p.message ?? p.text ?? (Array.isArray(p.content) ? p.content.map(part => part.text || '').join('\n') : p.content || '')).trim();
      if (!isCodexQuestionReply(raw)) continue;
      const replies = parseAsyncAnswers(raw);
      if (replies && replies.length === expectedReplies.length && replies.every((row, i) =>
          row.questionId === expectedReplies[i].questionId && row.question === expectedReplies[i].question && row.value === expectedReplies[i].value)) return true;
    }
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return false;
}

module.exports = { parseAsyncAnswer, parseAsyncAnswers, prepareAsyncAnswer, prepareAsyncAnswers, nativeAsyncAnswerAfter };
