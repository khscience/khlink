const fs = require('node:fs');
const { isInternalContextText } = require('./history');

const cache = new Map();

function isConversationRecord(record) {
  const p = record?.payload || {};
  if (record?.type === 'event_msg') {
    return /^(user_message|agent_message|task_started|task_complete|turn_aborted|turn_cancelled|turn_interrupted|item_completed|image_generation_end)$/.test(p.type || '');
  }
  if (record?.type !== 'response_item') return false;
  if (p.type === 'message') {
    if (p.role === 'assistant') return true;
    if (p.role !== 'user') return false;
    const text = (p.content || []).map((part) => part.text || '').join('\n').trim();
    return !isInternalContextText(text);
  }
  return /^(function_call|function_call_output|custom_tool_call|custom_tool_call_output|image_generation_call)$/.test(p.type || '');
}

// File mtime and Codex's updated_at include settings changes and context
// injection. Only dated conversation records are evidence of chat activity.
function readConversationActivityAt(file) {
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    // Codex keeps the rollout handle open while appending.  On Windows the
    // directory entry's mtime can stay at the time the file was opened for a
    // long-running turn, so it is not a freshness signal.  The byte length is
    // only a cache key; freshness is derived from the timestamp on the last
    // conversation record below.
    const signature = String(stat.size);
    const previous = cache.get(file);
    if (previous?.signature === signature) return previous.at;
    const fd = fs.openSync(file, 'r');
    let end = stat.size; let suffix = ''; let scanned = 0; let at = null;
    try {
      while (end > 0 && scanned < 16 * 1024 * 1024 && at === null) {
        const length = Math.min(512 * 1024, end);
        const start = end - length;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        const lines = (buffer.toString('utf8') + suffix).split(/\r?\n/);
        suffix = start > 0 ? lines.shift() || '' : '';
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const record = JSON.parse(lines[i]);
            const timestamp = Date.parse(record.timestamp);
            if (timestamp > 0 && isConversationRecord(record)) { at = timestamp; break; }
          } catch {}
        }
        end = start; scanned += length;
      }
      if (at === null && end === 0) at = 0;
    } finally { fs.closeSync(fd); }
    if (cache.size >= 2048) cache.delete(cache.keys().next().value);
    cache.set(file, { signature, at });
    return at;
  } catch { return null; }
}

module.exports = { readConversationActivityAt };
