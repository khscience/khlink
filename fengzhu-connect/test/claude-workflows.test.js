const test = require('node:test');
const assert = require('node:assert/strict');
const { workflowEvents, journalProgress, workflowItem } = require('../src/backends/claude-workflows');

const launchRow = {
  type: 'user', timestamp: '2026-10-09T06:17:19.057Z',
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Workflow launched in background. Task ID: w8wajug1w' }] },
  toolUseResult: { status: 'async_launched', taskId: 'w8wajug1w', taskType: 'local_workflow', workflowName: 'review-v3-tutorial-part2',
    runId: 'wf_c59ece70-c89', summary: '只读审校 V3 教程', transcriptDir: 'C:\\x\\subagents\\workflows\\wf_c59ece70-c89' },
};

test('workflow launches and end notices are read from transcript lines', () => {
  const notice = { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-09T08:00:00Z',
    content: '<task-notification>\n<task-id>w8wajug1w</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n</task-notification>' };
  const lines = ['{"type":"assistant"}', JSON.stringify(launchRow), JSON.stringify(notice)];
  const { launches, notifications } = workflowEvents(lines, 100);
  assert.equal(launches.length, 1);
  assert.deepEqual([launches[0].taskId, launches[0].runId, launches[0].name, launches[0].toolUseId], ['w8wajug1w', 'wf_c59ece70-c89', 'review-v3-tutorial-part2', 'toolu_1']);
  assert.equal(launches[0].order, 101 * 16 + 15, 'placed right after the launching tool result');
  assert.deepEqual(notifications.map((item) => [item.taskId, item.status]), [['w8wajug1w', 'completed']]);
});

test('journal progress counts sub-agents per phase', () => {
  const journal = [
    { type: 'launched' },
    { type: 'started', key: 'k1', agentId: 'a1', label: 'review:1', phase: 'Review' },
    { type: 'started', key: 'k2', agentId: 'a2', label: 'review:2', phase: 'Review' },
    { type: 'result', key: 'k1', value: {} },
    { type: 'started', key: 'k3', agentId: 'a3', label: 'verify:1', phase: 'Verify' },
  ].map((row) => JSON.stringify(row)).join('\n');
  const progress = journalProgress(journal);
  assert.deepEqual(progress.phases, [{ title: 'Review', started: 2, done: 1 }, { title: 'Verify', started: 1, done: 0 }]);
  assert.deepEqual([progress.started, progress.done, progress.running], [3, 1, 2]);
});

test('the workflow card shows phases, totals and state', () => {
  const launchedAt = Date.parse('2026-10-09T06:17:19Z');
  const workflow = { runId: 'wf_1', name: 'review', summary: '审校', launchedAt, order: 1615, status: 'running' };
  const progress = { phases: [{ title: 'Review', started: 19, done: 19 }, { title: 'Verify', started: 148, done: 139 }], started: 167, done: 158, running: 9 };
  const running = workflowItem(workflow, progress, launchedAt + 62 * 60_000);
  assert.equal(running.id, 'workflow:wf_1');
  assert.equal(running.type, 'workflow');
  assert.equal(running.status, 'inProgress');
  assert.match(running.text, /Review：已完成 19\n/);
  assert.match(running.text, /Verify：已完成 139 · 进行中 9/);
  assert.match(running.text, /运行中 · 已运行 1 小时 2 分/);
  const done = workflowItem({ ...workflow, status: 'completed', endedAt: launchedAt + 90 * 60_000 }, progress, launchedAt + 95 * 60_000);
  assert.equal(done.status, 'completed');
  assert.match(done.text, /已完成 · 用时 1 小时 30 分/);
  assert.equal(workflowItem({ ...workflow, status: 'killed', endedAt: launchedAt }, progress).status, 'failed');
  assert.equal(workflowItem({ ...workflow, status: 'unknown' }, progress).status, 'unknown');
});
