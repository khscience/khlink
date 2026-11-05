const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transcriptItems, readTranscript } = require('../src/backends/claude-desktop');
const { TOOL } = require('../src/backends/claude-task-list');
const WRAP_UP = 'mcp__ccd_turn__wrap_up';
const line = row => JSON.stringify(row);
let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 25, 1, 0, n)).toISOString();
const call = (name, input) => { n += 1; return line({ type: 'assistant', uuid: `a${n}`, timestamp: at(), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${n}`, name, input }] } }); };
const typed = text => { n += 1; return line({ type: 'user', uuid: `u${n}`, timestamp: at(), message: { content: text } }); };
const steps = (...states) => states.map((status, i) => ({ content: ['看公园', '定路线', '查天气'][i], status }));
const lists = items => items.filter(item => item.type === 'claudeTaskList');

test('update_plan calls become one task list card per turn, kept up to date', () => {
  const items = transcriptItems([
    typed('周末去公园'),
    call(TOOL, { items: steps('in_progress', 'pending', 'pending'), scope: 'first_task' }),
    call(TOOL, { advance: true }),
    call(TOOL, { done: [2], start: 3 }),
  ], 0, {});
  const cards = lists(items);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].taskList.steps.map(step => step.status), ['completed', 'completed', 'in_progress']);
  assert.equal(cards[0].status, 'inProgress');
  assert.match(cards[0].text, /^任务清单 2\/3\n✓ 看公园\n✓ 定路线\n▶ 查天气$/);
  // The calls themselves are not shown as tool rows.
  assert.equal(items.filter(item => item.type === 'mcpToolCall').length, 0);
  assert.equal(items.filter(item => item.type === 'hidden').length, 3);
});

test('the next-step box checks off the running step; a new turn gets a new card', () => {
  const state = {};
  const items = transcriptItems([
    call(TOOL, { items: steps('completed', 'in_progress') }),
    call(WRAP_UP, { recap: '路线定好了。' }),
    typed('再查一下天气'),
    call(TOOL, { advance: true }),
    call(TOOL, { items: steps('in_progress', 'pending', 'pending'), scope: 'continuation' }),
  ], 0, state);
  const cards = lists(items);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].status, 'completed');
  assert.deepEqual(cards[0].taskList.steps.map(step => step.status), ['completed', 'completed']);
  assert.notEqual(cards[1].id, cards[0].id);
  assert.deepEqual(cards[1].taskList.steps.map(step => step.status), ['in_progress', 'pending', 'pending']);
});

test('split reads keep updating the same card', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-list-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, call(TOOL, { items: steps('in_progress', 'pending') }) + '\n');
  const first = readTranscript(file);
  const persisted = JSON.parse(JSON.stringify({ taskList: first.taskList, taskListNewTurn: first.taskListNewTurn }));
  fs.appendFileSync(file, call(TOOL, { advance: true }) + '\n');
  const second = readTranscript(file, first.offset, first.lineCount, persisted);
  const [before] = lists(first.items); const [after] = lists(second.items);
  // Same card, moved to the latest call so it stays in the newest page the phone fetches.
  assert.equal(after.id, before.id); assert.ok(after.order > before.order);
  assert.deepEqual(after.taskList.steps.map(step => step.status), ['completed', 'in_progress']);
});

test('an update with no list to apply to shows nothing', () => {
  const items = transcriptItems([call(TOOL, { advance: true }), call(TOOL, { items: [] })], 0, {});
  assert.equal(lists(items).length, 0);
});

test('each change moves the card to that call, past the rows between', () => {
  const rows = [typed('周末去公园'), call(TOOL, { items: steps('in_progress', 'pending', 'pending') })];
  for (let i = 0; i < 40; i += 1) rows.push(call('Bash', { command: `echo ${i}` }));
  rows.push(call(TOOL, { advance: true }));
  const items = transcriptItems(rows, 0, {});
  const [card] = lists(items);
  const lastCall = items.filter(item => item.type === 'hidden').pop();
  assert.ok(card.order > lastCall.order);
  // Newer than every tool row before it: inside the newest page of 30.
  assert.equal(items.filter(item => item.order > card.order).length, 0);
  assert.deepEqual(card.taskList.steps.map(step => step.status), ['completed', 'in_progress', 'pending']);
});

test('a rebuilt history never puts the card and a hidden call row at one position', () => {
  const items = transcriptItems([
    typed('周末去公园'),
    call(TOOL, { items: steps('in_progress', 'pending', 'pending') }),
    call(TOOL, { advance: true }),
    call(TOOL, { done: [2], start: 3 }),
    call(WRAP_UP, { recap: '路线定好了。' }),
  ], 0, {});
  const orders = items.map(item => item.order);
  assert.equal(new Set(orders).size, orders.length);
  const [card] = lists(items);
  assert.equal(card.status, 'completed');
  // Checked off by the next-step box in place: after every update_plan call,
  // but before the box, which stays the last row so its buttons stay usable.
  assert.ok(card.order > Math.max(...items.filter(item => item.type === 'hidden').map(item => item.order)));
  const box = items.find(item => item.type === 'claudeWrapUp');
  assert.ok(box, 'the next-step box is in the history');
  assert.ok(card.order < box.order);
  assert.equal(items.filter(item => item.type !== 'hidden').sort((a, b) => a.order - b.order).pop().type, 'claudeWrapUp');
});

test('the next-step box checks off steps the turn never advanced past', () => {
  const items = transcriptItems([
    call(TOOL, { items: steps('in_progress', 'pending', 'pending') }),
    call(WRAP_UP, { recap: '都处理好了。' }),
  ], 0, {});
  const card = lists(items)[0];
  assert.equal(card.status, 'completed');
  assert.deepEqual(card.taskList.steps.map(step => step.status), ['completed', 'completed', 'completed']);
});
