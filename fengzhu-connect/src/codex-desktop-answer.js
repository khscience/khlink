'use strict';

// A Desktop-owned request_user_input belongs to Desktop's original RPC. Do
// not turn its answer into a new chat message: drive that exact prompt, then
// verify its call_id in the local rollout before reporting success.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { parseSteerOutput } = require('./codex-desktop-steer');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'codex-desktop-answer.ps1');
const MAX_TAIL = 16 * 1024 * 1024;

function canAnswerDesktopQuestion(waiting) {
  if (!waiting?.requestId || !Array.isArray(waiting.questions) || waiting.questions.length !== 1) return false;
  const q = waiting.questions[0];
  const labels = (q?.options || []).map((option) => option.label);
  return Boolean(q?.id && q.question && !q.multiSelect && !q.secret && labels.length >= 2 && labels.length <= 8 &&
    labels.every((label) => typeof label === 'string' && label.trim() && label.length <= 512) && new Set(labels).size === labels.length);
}

function desktopQuestionAnswer(waiting, args) {
  if (!canAnswerDesktopQuestion(waiting) || args?.requestId !== waiting.requestId || !Array.isArray(args.answers) || args.answers.length !== 1 || args.choice || args.feedback) {
    throw new Error('这个问题已变化或暂不支持在手机回答，请检查电脑上的问题');
  }
  const supplied = args.answers[0] || {};
  const labels = Array.isArray(supplied.labels) ? supplied.labels : [];
  const other = typeof supplied.other === 'string' ? supplied.other.trim() : '';
  if (labels.length + (other ? 1 : 0) !== 1 || other.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(other) ||
      (labels.length && (typeof labels[0] !== 'string' || !waiting.questions[0].options.some((option) => option.label === labels[0])))) {
    throw new Error('回答内容与电脑上的选项不一致，请重新选择');
  }
  return { value: labels[0] || other, custom: Boolean(other), questionId: waiting.questions[0].id };
}

// Only complete records are considered. If the request is absent from the
// bounded tail or the file cannot be read, the caller must fail closed.
function rolloutTailRecords(file) {
  if (!file) return [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_TAIL);
    const bytes = Buffer.alloc(size - start);
    const count = fs.readSync(fd, bytes, 0, bytes.length, start);
    const text = bytes.subarray(0, count).toString('utf8');
    const lines = text.split('\n');
    if (start) lines.shift();
    if (!text.endsWith('\n')) lines.pop();
    const records = [];
    for (const line of lines) {
      if (!/request_user_input|"type"\s*:\s*"(?:task_started|task_complete|turn_aborted|turn_cancelled|turn_interrupted|function_call_output|custom_tool_call_output)"/.test(line)) continue;
      let record; try { record = JSON.parse(line); } catch { continue; }
      records.push(record);
    }
    return records;
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function questionRolloutState(file, callId) {
  if (!file || !callId) return { state: 'missing' };
  let state = 'missing'; let output = null;
  for (const record of rolloutTailRecords(file)) {
      const p = record.payload || {};
      if (record.type === 'event_msg' && /^(task_started|task_complete|turn_aborted|turn_cancelled|turn_interrupted)$/.test(p.type || '')) {
        if (state === 'waiting') state = 'ended';
      } else if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type) && p.call_id === callId && /(?:^|[.\/])request_user_input$/i.test(p.name || '')) {
        state = 'waiting'; output = null;
      } else if (record.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p.type) && p.call_id === callId && state === 'waiting') {
        state = 'answered';
        try { output = typeof p.output === 'string' ? JSON.parse(p.output) : p.output; } catch { output = null; }
      }
  }
  return { state, output };
}

function pendingDesktopQuestion(file) {
  const pending = new Map();
  for (const record of rolloutTailRecords(file)) {
    const p = record.payload || {};
    if (record.type === 'event_msg' && /^(task_started|task_complete|turn_aborted|turn_cancelled|turn_interrupted)$/.test(p.type || '')) pending.clear();
    else if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type) && p.call_id && /(?:^|[.\/])request_user_input$/i.test(p.name || '')) pending.set(p.call_id, record);
    else if (record.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p.type)) pending.delete(p.call_id);
  }
  return pending.size === 1 ? [...pending.values()][0] : null;
}

function questionAnswerMatches(state, answer) {
  const values = state?.output?.answers?.[answer.questionId]?.answers;
  return state?.state === 'answered' && Array.isArray(values) && values.length === 1 && values[0] === answer.value;
}

class CodexDesktopAnswer {
  constructor({ execFileFn = execFile, script = SCRIPT, tempDir = os.tmpdir(), timeoutMs = 35_000 } = {}) {
    this.execFileFn = execFileFn; this.script = script; this.tempDir = tempDir; this.timeoutMs = timeoutMs;
  }

  answer({ threadId, title, question, answer }) {
    const file = path.join(this.tempDir, `khlink-codex-answer-${crypto.randomUUID()}.json`);
    const data = { threadId, title, question: question.question, labels: question.options.map((o) => o.label),
      answer: answer.value, custom: answer.custom, skip: ['跳过', 'Skip'], submit: ['提交', 'Submit'] };
    fs.writeFileSync(file, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    return new Promise((resolve) => {
      this.execFileFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-InputFile', file],
        { windowsHide: true, timeout: this.timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
          try { fs.unlinkSync(file); } catch {}
          resolve(parseSteerOutput(String(stdout || ''), error));
        });
    });
  }
}

module.exports = { CodexDesktopAnswer, canAnswerDesktopQuestion, desktopQuestionAnswer, questionRolloutState, questionAnswerMatches, pendingDesktopQuestion };
