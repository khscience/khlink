const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transcriptItems, readTranscript, peekTranscriptState } = require('../src/backends/claude-desktop');
const { TOOL, wrapUpItem, needsWrapUpHistoryRebuild } = require('../src/backends/claude-wrap-up');
const block = { type: 'tool_use', id: 'next-1', name: TOOL, input: {
  recap: '整理了两个周末安排。', ask: '你想怎么安排？', blocked: true,
  actions: [{ label: '去公园', message: '去公园吧，想轻松一点。' }, { label: '在家休息', message: '这周想在家休息。' }],
} };
const call = () => ({ type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { stop_reason: 'tool_use', content: [block] } });
const result = (extra = {}) => ({ type: 'user', uuid: 'r1', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: block.id, content: [{ type: 'text', text: 'Shown in the next-step box.' }], ...extra }] } });
const line = row => JSON.stringify(row);

test('a completed native next-step box is visible and ends the turn, even when blocked', () => {
  const state = {}; const items = transcriptItems([line(call()), line(result())], 0, state);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'claudeWrapUp'); assert.equal(items[0].status, 'completed');
  assert.deepEqual(items[0].nextStep, block.input);
  assert.equal(items[0].id, 'a1:0'); assert.equal(items[0].order, 0);
  assert.equal(state.lastEvent, 'end_turn'); assert.equal(state.lastTerminalStatus, null);
  assert.deepEqual(state.wrapUpCalls, {});
});

test('split reads including restart persist correlation and upsert the same card', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrap-up-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const file = path.join(root, 'session.jsonl'); fs.writeFileSync(file, line(call()) + '\n');
  const first = readTranscript(file); assert.equal(first.items[0].status, 'inProgress');
  assert.equal(first.lastEvent, 'assistant');
  const persisted = JSON.parse(JSON.stringify({ wrapUpCalls: first.wrapUpCalls }));
  fs.appendFileSync(file, line(result()) + '\n');
  const second = readTranscript(file, first.offset, first.lineCount, persisted);
  assert.equal(second.lastEvent, 'end_turn'); assert.equal(second.items[0].id, first.items[0].id);
  assert.equal(second.items[0].order, first.items[0].order); assert.equal(second.items[0].status, 'completed');
  assert.equal(peekTranscriptState(file).lastEvent, 'end_turn');
  const reply = '我想换成下午去湖边，先不选这两个。';
  fs.appendFileSync(file, line({ type: 'user', uuid: 'u2', timestamp: new Date().toISOString(), message: { content: reply } }) + '\n');
  const third = readTranscript(file, second.offset, second.lineCount, second);
  assert.equal(third.lastEvent, 'user'); assert.equal(third.items[0].text, reply);
  assert.equal(third.queueOps[0].content, reply);
});

test('failed and unmatched results do not end the turn or fabricate a completed card', () => {
  for (const extra of [{ is_error: true }, { tool_use_id: 'another' }]) {
    const state = {}; const items = transcriptItems([line(call()), line(result(extra))], 0, state);
    assert.notEqual(state.lastEvent, 'end_turn'); assert.notEqual(items[0].status, 'completed');
  }
  const state = {};
  const normal = call(); normal.message.content[0] = { ...block, name: 'AskUserQuestion' };
  transcriptItems([line(normal), line(result())], 0, state);
  assert.notEqual(state.lastEvent, 'end_turn');
});

test('a new real user turn prevents late old results from ending it', () => {
  const state = {};
  transcriptItems([line(call()), line({ type: 'user', uuid: 'u2', message: { content: '我再想想。' } }), line(result())], 0, state);
  assert.notEqual(state.lastEvent, 'end_turn');
});

test('suggestion messages keep exact text and oversized messages are excluded rather than truncated', () => {
  const message = '  我想去公园。\n下午再出门。  ';
  const item = wrapUpItem({ ...block, input: { actions: [{ label: '公园', message }, { label: '太长', message: 'a'.repeat(16001) }, null] } }, {});
  assert.deepEqual(item.nextStep.actions, [{ label: '公园', message }]);
  assert.equal(wrapUpItem({ name: 'Bash', input: block.input }, {}), null);
});

test('bounded migration finds cards across chunk boundaries and preserves the old image migration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrap-up-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, ' '.repeat(1024 * 1024 - 7) + TOOL);
  assert.equal(needsWrapUpHistoryRebuild(file, 5), true);
  fs.writeFileSync(file, '{"type":"image"}');
  assert.equal(needsWrapUpHistoryRebuild(file, 4), true); assert.equal(needsWrapUpHistoryRebuild(file, 5), false);
  fs.writeFileSync(file, '普通历史记录'); assert.equal(needsWrapUpHistoryRebuild(file, 1), false);
});

test('label-only buttons reply with their label, app actions get a Chinese label', () => {
  const item = wrapUpItem({ name: TOOL, input: { recap: '新 skill 写好了', ask: '要不要只提交这个 skill 目录？', actions: [{ label: '只提交 skill 目录' }, { label: '先不提交' }, { action: 'commit' }] } }, {});
  assert.deepEqual(item.nextStep.actions, [
    { label: '只提交 skill 目录', message: '只提交 skill 目录' }, { label: '先不提交', message: '先不提交' }, { label: '提交', message: '提交' }]);
});

test('a session Claude proposes itself is a card; an offer or a start is not', () => {
  const block = { name: 'mcp__ccd_session__start_session', input: { initiation: 'own_initiative', title: '用子代理试迁移评测', prompt: '按评测流程检验' } };
  const card = wrapUpItem(block, { id: 'x' });
  assert.equal(card.type, 'claudeWrapUp');
  assert.equal(card.nextStep.title, 'Claude 建议新开会话');
  assert.equal(card.nextStep.ask, '用子代理试迁移评测');
  assert.deepEqual(card.nextStep.actions.map((a) => a.label), ['新开会话', '在这里做']);
  assert.equal(wrapUpItem({ ...block, input: { ...block.input, initiation: 'offer' } }, {}), null);
  assert.equal(wrapUpItem({ ...block, input: { proposal_id: 'task_1', initiation: 'own_initiative', title: 't' } }, {}), null);
});
