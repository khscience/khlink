// Question attention is separate from execution: an async call returns a
// receipt immediately, but its questions still need the user's actual reply.
function isCodexQuestionReply(text) {
  const match = String(text || '').trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
  if (!match) return false;
  try {
    const answers = JSON.parse(match[1]);
    return Array.isArray(answers) && answers.length > 0 && answers.every(row =>
      typeof row?.questionItemId === 'string' && row.questionItemId.trim() &&
      typeof row.question === 'string' && typeof row.answer === 'string' && row.answer.trim());
  } catch { return false; }
}

function questionEvent(record) {
  const p = record?.payload || {}, at = Date.parse(record?.timestamp || '') || 0;
  if (!at) return null;
  if (record.type === 'event_msg' && p.type === 'task_started') return { type: 'start', at, turnId: p.turn_id || null };
  if (record.type === 'event_msg' && /^(task_complete|turn_aborted|turn_cancelled|turn_interrupted)$/.test(p.type || ''))
    return { type: 'end', at, turnId: p.turn_id || null };
  if (record.type === 'response_item' && p.type === 'function_call' && /(?:^|[.\/])request_user_input_async$/i.test(p.name || '')) {
    let args; try { args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments; } catch { return null; }
    const callId = String(p.call_id || p.id || '');
    if (!callId) return null;
    const questions = (Array.isArray(args?.questions) ? args.questions : []).map((q, i) => ({
      id: JSON.stringify(['request_user_input_async', callId, i]),
      question: String(q?.title ?? q?.question ?? q?.prompt ?? '').trim(),
      options: (Array.isArray(q?.options) ? q.options : []).map(o => String(typeof o === 'string' ? o : o?.label ?? o?.value ?? '').trim()).filter(Boolean),
    })).filter(q => q.question);
    return questions.length ? { type: 'ask', at, callId, itemId: String(p.id || callId), questions } : null;
  }
  const user = record.type === 'event_msg' && p.type === 'user_message' || record.type === 'response_item' && p.type === 'message' && p.role === 'user';
  if (!user) return null;
  const text = String(p.message ?? p.text ?? (Array.isArray(p.content) ? p.content.map(c => c.text || '').join('\n') : p.content || ''));
  const ids = [];
  for (const match of text.matchAll(/<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/g)) {
    try { const values = JSON.parse(match[1]); if (Array.isArray(values)) for (const row of values) {
      const id = row?.questionItemId || row?.id;
      if (typeof id === 'string' && id && typeof row?.answer === 'string' && row.answer.trim()) ids.push(id);
    } } catch { /* plain conversation text cannot resolve a structured question */ }
  }
  return ids.length ? { type: 'answer', at, ids } : null;
}

class CodexQuestionTracker {
  constructor() { this.threads = new Map(); }
  consume(threadId, record) { const event = questionEvent(record); return event ? this.apply(threadId, event) : false; }
  apply(threadId, event) {
    let state = this.threads.get(threadId);
    if (!state) {
      state = { calls: new Map(), resolved: new Map(), startAt: 0, endAt: 0, updatedAt: 0, turnId: null };
      this.threads.set(threadId, state);
      if (this.threads.size > 256) this.threads.delete(this.threads.keys().next().value);
    }
    const before = JSON.stringify(this.snapshot(threadId)?.questions);
    const { at } = event;
    if (event.type === 'start') {
      if (at <= state.endAt || at < state.startAt || event.turnId && event.turnId === state.turnId) return false;
      state.calls.clear(); state.startAt = at; state.turnId = event.turnId;
    } else if (event.type === 'end') {
      if (at < state.startAt || event.turnId && state.turnId && event.turnId !== state.turnId) return false;
      state.endAt = Math.max(state.endAt, at);
      for (const [id, call] of state.calls) if (call.at <= at) {
        for (const q of call.questions) state.resolved.set(q.id, at);
        state.calls.delete(id);
      }
    } else if (event.type === 'ask') {
      if (at <= state.endAt || at < state.startAt || at < (state.calls.get(event.callId)?.at || 0)) return false;
      const questions = event.questions.filter(q => (state.resolved.get(q.id) || 0) < at);
      if (questions.length) state.calls.set(event.callId, { ...event, questions });
      if (state.calls.size > 32) state.calls.delete(state.calls.keys().next().value);
    } else if (event.type === 'answer') {
      for (const id of event.ids) state.resolved.set(id, Math.max(state.resolved.get(id) || 0, at));
      for (const [id, call] of state.calls) {
        const questions = call.questions.filter(q => (state.resolved.get(q.id) || 0) < call.at);
        if (questions.length) state.calls.set(id, { ...call, questions }); else state.calls.delete(id);
      }
    }
    while (state.resolved.size > 1_000) state.resolved.delete(state.resolved.keys().next().value);
    state.updatedAt = Math.max(state.updatedAt, at);
    return before !== JSON.stringify(this.snapshot(threadId)?.questions);
  }
  snapshot(threadId, { running } = {}) {
    const state = this.threads.get(threadId);
    if (!state) return null;
    const active = running ?? (state.startAt > state.endAt);
    const calls = active ? [...state.calls.values()].sort((a, b) => a.at - b.at) : [];
    return { schemaVersion: 1, threadId, pending: calls.length > 0, questions: calls.flatMap(c => c.questions),
      itemId: calls.at(-1)?.itemId || '', askedAt: calls.at(-1)?.at || 0,
      updatedAt: state.updatedAt, turnId: state.turnId };
  }
}
module.exports = { CodexQuestionTracker, questionEvent, isCodexQuestionReply };
