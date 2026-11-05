'use strict';
// Claude Code workflows (the Workflow tool: many sub-agents in phases) for the
// phone. A launch is recorded in the session transcript as a tool result with
// toolUseResult.taskType "local_workflow"; its progress is the run's
// journal.jsonl (launched / started {agentId, label, phase} / result {key});
// its end is a <task-notification> for its task id. Read-only.

const FINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'error']);

// Workflow launches and task notifications in transcript lines. `firstLine`
// is the line number of lines[0] in the file, so item order matches the
// transcript items (line * 16 + index).
function workflowEvents(lines, firstLine = 0) {
  const launches = []; const notifications = [];
  lines.forEach((line, index) => {
    if (!line.includes('local_workflow') && !line.includes('task-notification')) return;
    let row; try { row = JSON.parse(line); } catch { return; }
    const result = row?.toolUseResult;
    if (result && result.taskType === 'local_workflow' && result.taskId && result.runId) {
      const toolUseId = (Array.isArray(row.message?.content) ? row.message.content : []).find((block) => block?.type === 'tool_result')?.tool_use_id || null;
      launches.push({
        taskId: String(result.taskId), runId: String(result.runId), name: String(result.workflowName || ''),
        summary: String(result.summary || ''), transcriptDir: String(result.transcriptDir || ''), toolUseId,
        launchedAt: Date.parse(row.timestamp) || Date.now(), order: (firstLine + index) * 16 + 15,
      });
    }
    // A notification may be a queued item (queue-operation content) or a
    // delivered user message; either way the tags are in the decoded text.
    const text = typeof row?.content === 'string' ? row.content
      : typeof row?.message?.content === 'string' ? row.message.content
        : JSON.stringify(row?.message?.content || '');
    for (const block of text.split('<task-notification>').slice(1)) {
      const taskId = block.match(/<task-id>\s*([\w-]+)\s*<\/task-id>/)?.[1];
      const status = block.match(/<status>\s*([\w-]+)\s*<\/status>/)?.[1];
      if (taskId && status) notifications.push({ taskId, status: status.toLowerCase(), at: Date.parse(row.timestamp) || Date.now() });
    }
  });
  return { launches, notifications };
}

// Per-phase sub-agent counts from a journal.
function journalProgress(text) {
  const phases = new Map(); const phaseOfKey = new Map(); let started = 0; let done = 0; let lastAt = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'started') {
      const title = String(row.phase || '其它');
      if (!phases.has(title)) phases.set(title, { title, started: 0, done: 0 });
      phases.get(title).started += 1; started += 1;
      if (row.key) phaseOfKey.set(row.key, title);
    } else if (row.type === 'result') {
      done += 1;
      const phase = phases.get(phaseOfKey.get(row.key));
      if (phase) phase.done += 1;
    }
  }
  return { phases: [...phases.values()], started, done, running: Math.max(0, started - done), lastAt };
}

function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function clock(at) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// The history item the phone shows for one workflow.
function workflowItem(workflow, progress, now = Date.now()) {
  const final = FINAL_STATUSES.has(workflow.status);
  const statusText = workflow.status === 'completed' ? '已完成'
    : final ? `已结束（${workflow.status}）` : workflow.status === 'unknown' ? '状态未知' : '运行中';
  // Markdown: blocks are separated by a blank line, list items by one newline.
  const blocks = [`**${workflow.name || workflow.runId}**`];
  if (workflow.summary) blocks.push(workflow.summary);
  const phases = (progress?.phases || []).map((phase) => {
    const running = phase.started - phase.done;
    return `- ${phase.title}：已完成 ${phase.done}${running > 0 ? ` · 进行中 ${running}` : ''}`;
  });
  if (phases.length) blocks.push(phases.join('\n'));
  if (progress?.started) blocks.push(`共 ${progress.started} 个子代理，已完成 ${progress.done}`);
  const end = final ? (workflow.endedAt || now) : now;
  blocks.push(`${statusText} · ${final ? '用时' : '已运行'} ${duration(end - workflow.launchedAt)} · 更新于 ${clock(now)}`);
  return {
    id: `workflow:${workflow.runId}`, order: workflow.order, type: 'workflow', at: workflow.launchedAt,
    text: blocks.join('\n\n'),
    status: workflow.status === 'completed' ? 'completed' : final ? 'failed' : workflow.status === 'unknown' ? 'unknown' : 'inProgress',
  };
}

module.exports = { workflowEvents, journalProgress, workflowItem, FINAL_STATUSES };
