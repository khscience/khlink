'use strict';
// Claude Desktop's task list: the steps it pins under the latest message,
// kept with mcp__ccd_turn__update_plan calls ({items}, {advance}, {done, start})
// and checked off by the next-step box. The phone gets one card per turn
// that is updated in place; the calls themselves are not shown.
const TOOL = 'mcp__ccd_turn__update_plan';
const STATUSES = new Set(['pending', 'in_progress', 'completed']);
const MAX_STEPS = 20;

function cleanSteps(items) {
  return (Array.isArray(items) ? items : []).slice(0, MAX_STEPS).map(step => ({
    content: typeof step?.content === 'string' ? step.content.trim().slice(0, 300) : '',
    status: STATUSES.has(step?.status) ? step.status : 'pending',
  })).filter(step => step.content);
}

// The position a card takes on the transcript line of the call that changed
// it: the last slot of that line, which no block uses (blocks take 0..14), so
// the server, which keeps one row per position, does not drop the call's own
// hidden row or the card.
const cardOrder = line => line * 16 + 15;

// The list after one update_plan call, or null when it changes nothing.
// `newTurn`: a typed message came since the last list, so a new list is a new card.
// Every change moves the card to the call's position: the phone only fetches
// the newest page of a conversation, so a card left at the turn's first call
// fell out of it in a long turn and stopped at its first step (2026-10-25).
function applyTaskListUpdate(current, input = {}, base, newTurn = false) {
  if (Array.isArray(input.items)) {
    const steps = cleanSteps(input.items);
    if (!steps.length) return null;
    const card = current && !newTurn ? current : { id: `${base.id}:tasks`, at: base.at };
    return { ...card, order: base.cardOrder ?? base.order, steps, updatedAt: base.at };
  }
  if (!current?.steps?.length) return null;
  const steps = current.steps.map(step => ({ ...step }));
  if (input.advance === true) {
    const running = steps.findIndex(step => step.status === 'in_progress');
    if (running >= 0) steps[running].status = 'completed';
    const next = steps.findIndex((step, index) => index > running && step.status === 'pending');
    if (next >= 0) steps[next].status = 'in_progress';
  }
  for (const n of Array.isArray(input.done) ? input.done : []) if (steps[n - 1]) steps[n - 1].status = 'completed';
  if (Number.isInteger(input.start) && steps[input.start - 1]) {
    for (const step of steps) if (step.status === 'in_progress') step.status = 'pending';
    steps[input.start - 1].status = 'in_progress';
  }
  return { ...current, order: base.cardOrder ?? current.order, steps, updatedAt: base.at };
}

// The next-step box checks off the whole list, as the desktop does: a turn
// often works through its steps without advancing and ends with the box, and
// the phone then showed the list stuck at its first step.
function finishTaskList(current, at, order) {
  if (!current?.steps?.some(step => step.status !== 'completed')) return null;
  return { ...current, ...(order != null ? { order } : {}), steps: current.steps.map(step => step.status === 'completed' ? step : { ...step, status: 'completed' }), updatedAt: at };
}

function taskListItem(list) {
  const done = list.steps.filter(step => step.status === 'completed').length;
  const mark = { completed: '✓', in_progress: '▶', pending: '○' };
  return {
    id: list.id, order: list.order, at: list.at, type: 'claudeTaskList',
    status: done === list.steps.length ? 'completed' : 'inProgress',
    // Older apps show this text as a plain message.
    text: [`任务清单 ${done}/${list.steps.length}`, ...list.steps.map(step => `${mark[step.status]} ${step.content}`)].join('\n'),
    taskList: { steps: list.steps, updatedAt: list.updatedAt },
  };
}

module.exports = { TOOL, applyTaskListUpdate, finishTaskList, taskListItem, cardOrder };
