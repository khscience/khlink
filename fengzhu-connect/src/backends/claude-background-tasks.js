'use strict';
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const id = value => typeof value === 'string' && /^[\w-]{1,160}$/.test(value) ? value : null;
const finished = status => ['completed', 'failed', 'stopped', 'killed', 'cancelled'].includes(status);
function finishNotification(state, content) {
  if (typeof content !== 'string' || !/^\s*<task-notification>/.test(content)) return;
  const taskId = id(/<task-id>([^<]+)<\/task-id>/.exec(content)?.[1]);
  const status = /<status>([^<]+)<\/status>/.exec(content)?.[1];
  if (taskId && finished(status)) state.tasks.delete(taskId);
}

// Desktop 2.37337.1.0 can end a reply while Bash/Agent still runs in the
// background. Only typed tool results and harness-origin notifications update
// this ledger. User text, assistant prose and end_turn cannot clear a task.
function applyBackgroundRecord(state, row) {
  if (!row || row.isSidechain) return;
  // Desktop 2.37337.1.0 also stores notifications as typed attachments,
  // especially when another foreground turn is waiting. Verified against the
  // local 2026-10-13/15 transcript shapes; queue-operation prose alone is not
  // trusted. A completion need not wait for the model to consume its notice.
  const attachment = row.type === 'attachment' && row.attachment;
  if (attachment?.type === 'queued_command' && attachment.commandMode === 'task-notification' && attachment.origin?.kind === 'task-notification') {
    finishNotification(state, attachment.prompt);
  }
  if (attachment?.type === 'task_status' && id(attachment.taskId)) {
    if (finished(attachment.status)) state.tasks.delete(attachment.taskId);
    else if (attachment.status === 'running') state.tasks.add(attachment.taskId);
  }
  const content = row.message?.content;
  if (row.type === 'assistant' && Array.isArray(content)) {
    for (const block of content) if (block.type === 'tool_use' && block.input?.run_in_background === true && id(block.id)) state.calls.add(block.id);
  }
  if (row.type !== 'user') return;
  const result = row.toolUseResult;
  const task = id(result?.backgroundTaskId) || (result?.isAsync === true ? id(result.agentId) : null);
  if (task) state.tasks.add(task);
  if (Array.isArray(content)) {
    for (const block of content) if (block.type === 'tool_result' && state.calls.has(block.tool_use_id)) {
      if (task || block.is_error === true || typeof result === 'object' && result !== null && (result.interrupted === true || result.status === 'completed')) state.calls.delete(block.tool_use_id);
      // An unknown success format stays unresolved; never guess it finished.
    }
  }
  const systemNotification = row.origin?.kind === 'task-notification' && row.promptSource === 'system';
  if (systemNotification) finishNotification(state, content);
}

class BackgroundTasks {
  constructor({ maxBytesPerRead = 8 * 1024 * 1024 } = {}) { this.cache = new Map(); this.maxBytesPerRead = maxBytesPerRead; }
  read(file) {
    const stat = fs.statSync(file);
    let state = this.cache.get(file);
    if (!state || state.ino !== stat.ino || state.birth !== stat.birthtimeMs || stat.size < state.offset) {
      state = { ino: stat.ino, birth: stat.birthtimeMs, offset: 0, pending: '', decoder: new StringDecoder('utf8'), tasks: new Set(), calls: new Set(), malformed: false };
      this.cache.set(file, state);
      if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value);
    }
    const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, stat.size - state.offset)));
    let remaining = Math.min(this.maxBytesPerRead, stat.size - state.offset);
    try {
      while (remaining > 0) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), state.offset);
        if (!count) break;
        state.offset += count; remaining -= count;
        state.pending += state.decoder.write(buffer.subarray(0, count));
        let end;
        while ((end = state.pending.indexOf('\n')) >= 0) {
          const line = state.pending.slice(0, end); state.pending = state.pending.slice(end + 1);
          if (!line.trim()) continue;
          try { applyBackgroundRecord(state, JSON.parse(line)); } catch { state.malformed = true; }
        }
        if (state.pending.length > 64 * 1024 * 1024) { this.cache.delete(file); throw new Error('background_record_too_large'); }
      }
      return { known: !state.malformed && state.offset === stat.size && !state.pending && !state.decoder.lastNeed,
        count: state.tasks.size + state.calls.size };
    } finally { fs.closeSync(fd); }
  }
}
const defaultReader = new BackgroundTasks();
module.exports = { BackgroundTasks, applyBackgroundRecord, readBackgroundTasks: file => defaultReader.read(file) };
