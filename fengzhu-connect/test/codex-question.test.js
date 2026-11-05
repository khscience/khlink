const test = require('node:test');
const assert = require('node:assert/strict');
const { rolloutItem, rolloutStatus } = require('../src/connector');

test('a non-blocking Codex question becomes a card with its options and the id Codex Desktop answers with', () => {
  const record = { type: 'response_item', timestamp: '2026-10-10T00:00:00Z', payload: { type: 'function_call', id: 'fc_1', name: 'request_user_input_async', call_id: 'call_A',
    arguments: JSON.stringify({ questions: [{ title: '初始资金用多少？', options: ['1,000 万元（推荐）', '沿用 100 万元'] }] }) } };
  const item = rolloutItem(record);
  assert.equal(item.type, 'codexQuestion');
  assert.deepEqual(item.questions, [{ id: '["request_user_input_async","call_A",0]', question: '初始资金用多少？', options: ['1,000 万元（推荐）', '沿用 100 万元'] }]);
  // It doesn't stop the turn, so it isn't a waiting state.
  assert.notEqual(rolloutStatus(record), 'waiting_input');
  assert.equal(rolloutStatus({ ...record, payload: { ...record.payload, name: 'request_user_input' } }), 'waiting_input');
});

test('a finished context compaction shows with how long it took', () => {
  const item = rolloutItem({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'ContextCompaction', id: 'c1' }, started_at_ms: 1000, completed_at_ms: 121000 } });
  assert.equal(item.type, 'contextCompaction');
  assert.equal(item.text, '上下文已自动压缩');
  assert.equal(item.durationMs, 120000);
  assert.equal(rolloutItem({ type: 'compacted', payload: { message: '', replacement_history: [] } }), null);
});

test('compaction refused because Codex Desktop holds the task never marks the task failed', async () => {
  const { Connector } = require('../src/connector');
  const connector = Object.create(Connector.prototype);
  const emitted = [];
  connector.emit = (kind, threadId, value) => emitted.push({ kind, value });
  connector.codex = { request: async () => { throw new Error('thread is already open in another application'); } };
  await assert.rejects(connector.executeCommand({ action: 'thread.compact', args: { threadId: 't1' } }), /请在电脑上整理上下文/);
  assert.deepEqual(emitted.filter((event) => event.kind === 'context.compaction'), []);
  connector.codex = { request: async () => ({}) };
  await connector.executeCommand({ action: 'thread.compact', args: { threadId: 't1' } });
  assert.equal(emitted.find((event) => event.kind === 'context.compaction')?.value.status, 'started');
});

test('an answer stays in the history while AGENTS.md sent as a user message is hidden', () => {
  const { isInternalContextText } = require('../src/history');
  assert.equal(isInternalContextText('<send_user_message_question_reply>\n[{"questionItemId":"x","question":"q","answer":"a"}]\n</send_user_message_question_reply>'), false);
  assert.equal(isInternalContextText('# AGENTS.md instructions for D:\work\code\n\n<INSTRUCTIONS>\n…\n</INSTRUCTIONS>'), true);
  assert.equal(isInternalContextText('<environment_context>x</environment_context>'), true);
});

test('a Claude task that never reached the desktop does not stay in the list as an empty task', async () => {
  const { Connector } = require('../src/connector');
  const connector = Object.create(Connector.prototype);
  const fields = [];
  Object.assign(connector, {
    config: { workspace: 'G:\w' }, threadState: new Map(), log: () => {},
    claude: { newThread: () => ({ threadId: 't-new' }) },
    upsertClaudeThread: () => {}, syncClaudeThreadMetadata: async () => {},
    claudeAttachmentParts: () => ({ images: [], imagePaths: [], text: 'hello' }),
    setClaudeThreadFields: (id, changes) => fields.push({ id, changes }),
    startClaudeDesktopNewSession: async () => { throw Object.assign(new Error('电脑端 Claude 新任务输入框已有草稿，为避免误发已取消。'), { delivery: 'not_sent' }); },
  });
  await assert.rejects(connector.executeClaudeCommand('thread.newWithTurn', { text: 'hello' }), /已有草稿/);
  assert.deepEqual(fields, [{ id: 't-new', changes: { archived: true, pinned: false, pinOrder: -1 } }]);
});
