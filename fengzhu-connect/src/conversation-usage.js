// Local conversation records only. No model requests, credentials or prices.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { setImmediate: yieldLoop } = require('node:timers/promises');
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'];
const zero = () => Object.fromEntries(FIELDS.map(key => [key, 0]));
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const at = value => typeof value === 'number' ? value : Date.parse(value || '') || 0;

function counts(backend, value) {
  if (!value || typeof value !== 'object') return null;
  let input, output, cacheRead, cacheWrite, reasoning, total;
  if (backend === 'codex') {
    input = number(value.input_tokens); output = number(value.output_tokens);
    cacheRead = number(value.cached_input_tokens); cacheWrite = number(value.cache_write_input_tokens);
    reasoning = number(value.reasoning_output_tokens); total = number(value.total_tokens);
  } else if (backend === 'claude') {
    input = number(value.input_tokens); output = number(value.output_tokens);
    cacheRead = number(value.cache_read_input_tokens); cacheWrite = number(value.cache_creation_input_tokens);
    reasoning = null;
    if (input != null) input += (cacheRead || 0) + (cacheWrite || 0);
  } else {
    output = number(value.output); cacheRead = number(value.cacheRead); cacheWrite = number(value.cacheWrite);
    reasoning = number(value.reasoning); total = number(value.totalTokens);
    // Pi providers can report cached input separately. The native total is
    // authoritative; derive inclusive input from it instead of adding twice.
    input = total != null && output != null && total >= output ? total - output : number(value.input);
    if (total == null && input != null) input += (cacheRead || 0) + (cacheWrite || 0);
  }
  if (input == null || output == null || !Number.isSafeInteger(input + output)) return null;
  if (total == null) total = input + output;
  if (total !== input + output || (cacheRead || 0) + (cacheWrite || 0) > input || (reasoning || 0) > output) return null;
  return { input, output, cacheRead, cacheWrite, reasoning, total };
}

function add(rows) {
  const result = zero();
  for (const row of rows) for (const key of FIELDS) {
    result[key] = result[key] == null || row[key] == null ? null : result[key] + row[key];
  }
  return result;
}

function subtract(total, baseline) {
  if (!total || !baseline) return null;
  const result = {};
  for (const key of FIELDS) {
    result[key] = total[key] == null || baseline[key] == null ? null : total[key] - baseline[key];
    if (result[key] != null && result[key] < 0) return null;
  }
  return result;
}

class UsageAccumulator {
  constructor(backend, { complete = true, maxRequests = 100_000 } = {}) {
    this.backend = backend; this.complete = complete; this.maxRequests = maxRequests;
    this.requests = new Map(); this.missing = new Map(); this.updatedAt = 0; this.usageUpdatedAt = 0;
    this.turnId = null; this.turnActive = false; this.turnStartedAt = 0; this.turnBaseline = null; this.latest = null; this.total = null;
    this.model = null; this.limited = false; this.inherited = false;
    this.turns = new Map();
  }

  startTurn(id, timestamp, baseline = null) {
    if (timestamp < this.turnStartedAt || this.turns.has(id)) return;
    this.turnId = id; this.turnActive = true; this.turnStartedAt = timestamp; this.turnBaseline = baseline;
    this.turns.set(id, { turnId: id, startedAt: timestamp, baseline, total: null,
      completedAt: 0, finalMessageAt: 0, finalMessageId: null });
    if (this.turns.size > 1_000) this.turns.delete(this.turns.keys().next().value);
  }

  consume(row, sourceId = null) {
    const timestamp = at(row.timestamp);
    this.updatedAt = Math.max(this.updatedAt, timestamp);
    if (this.backend === 'codex') {
      const p = row.payload || {};
      if (row.type === 'session_meta') this.inherited ||= Boolean(p.forked_from_id || p.forkedFromId);
      if (row.type === 'turn_context') this.model = p.model || this.model;
      const descriptor = this.turns.get(this.turnId);
      if (row.type === 'response_item' && p.type === 'message' && p.role === 'assistant'
        && (!p.phase || p.phase === 'final_answer') && descriptor && timestamp >= descriptor.startedAt) {
        descriptor.finalMessageAt = timestamp; descriptor.finalMessageId = p.id || sourceId;
      }
      if (row.type !== 'event_msg') return;
      if (p.type === 'task_started') {
        this.startTurn(p.turn_id || String(timestamp), timestamp,
          this.total ? { ...this.total } : this.complete && !this.inherited ? zero() : null);
      }
      if (['task_complete', 'turn_aborted', 'turn_cancelled', 'turn_interrupted'].includes(p.type)
        && descriptor && timestamp >= descriptor.startedAt && (!p.turn_id || p.turn_id === this.turnId)) {
        this.turnActive = false; descriptor.completedAt = Math.max(descriptor.completedAt, timestamp);
        descriptor.total = this.total;
      }
      if (p.type !== 'token_count') return;
      const total = counts('codex', p.info?.total_token_usage);
      if (!total) return;
      if (timestamp < this.usageUpdatedAt) return;
      // Each record is a cumulative snapshot, never another amount to add.
      this.total = total; this.latest = counts('codex', p.info?.last_token_usage);
      if (descriptor) descriptor.total = total;
      // A later native cumulative snapshot covers earlier skipped image or
      // chat rows. They do not make its cumulative counters incomplete.
      this.limited = false;
      this.usageUpdatedAt = Math.max(this.usageUpdatedAt, timestamp);
      return;
    }
    if (this.backend === 'claude' && (row.isSidechain || row.isMeta)) return;
    const message = row.message;
    if (!message) return;
    if (message.role === 'user' || (this.backend === 'claude' && row.type === 'user')) {
      const content = message.content;
      const toolResult = Array.isArray(content) && content.some(part => part.type === 'tool_result');
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
      if (this.backend === 'claude' && /^\s*\[Request interrupted\b/.test(text)) {
        const interrupted = this.turns.get(this.turnId);
        if (interrupted && timestamp >= interrupted.startedAt) {
          interrupted.completedAt = Math.max(interrupted.completedAt, timestamp);
          this.turnActive = false;
        }
        return;
      }
      const internal = /^\s*(<(command-name|command-message|local-command|system-reminder|task-notification)|\[Request interrupted)/.test(text);
      // User input absorbed during a tool call stays in the same running turn.
      if (!toolResult && !internal && !this.turnActive) {
        this.startTurn(row.uuid || row.id || String(timestamp), timestamp);
      }
      return;
    }
    if (message.role !== 'assistant' && row.type !== 'assistant') return;
    const id = this.backend === 'claude' ? message.id || row.requestId || row.uuid : row.id || message.id;
    const known = id ? this.requests.get(id) : null;
    const owner = known?.turnId ?? this.missing.get(id) ?? this.turnId;
    const descriptor = this.turns.get(owner);
    const content = Array.isArray(message.content) ? message.content : [];
    const lastText = content.findLastIndex(part => part.type === 'text' && part.text?.trim());
    const visibleText = lastText >= 0 || (typeof message.content === 'string' && message.content.trim());
    if (visibleText && descriptor && timestamp >= descriptor.finalMessageAt) {
      descriptor.finalMessageAt = this.backend === 'pi' ? at(message.timestamp) || timestamp : timestamp;
      descriptor.finalMessageId = this.backend === 'claude' && row.uuid ? `${row.uuid}:${Math.max(0, lastText)}` : this.backend === 'pi' ? row.id : null;
    }
    const stop = message.stop_reason || message.stopReason;
    if (stop && !['tool_use', 'toolUse', 'pause_turn'].includes(stop) && descriptor && timestamp >= descriptor.startedAt) {
      descriptor.completedAt = Math.max(descriptor.completedAt, timestamp);
      if (owner === this.turnId) this.turnActive = false;
    }
    if (!id) { this.limited = true; return; }
    const usage = counts(this.backend, message.usage);
    if (!usage) { if (!this.requests.has(id)) { if (this.missing.size < this.maxRequests) this.missing.set(id, owner); else this.limited = true; } return; }
    this.missing.delete(id);
    if (!known && this.requests.size >= this.maxRequests) { this.limited = true; return; }
    // Claude writes the same response in several transcript fragments. Merge
    // its largest observed counters per message, rather than charging twice.
    const merged = known ? Object.fromEntries(FIELDS.map(key => [key,
      usage[key] == null ? known.usage[key] : known.usage[key] == null ? usage[key] : Math.max(usage[key], known.usage[key])])) : usage;
    merged.total = merged.input + merged.output;
    this.requests.set(id, { usage: merged, turnId: owner });
    if (timestamp >= this.usageUpdatedAt) {
      this.latest = merged;
      this.model = message.model ? String(message.model) : this.model;
    }
    this.usageUpdatedAt = Math.max(this.usageUpdatedAt, timestamp);
  }

  snapshot(historyFrom = 0) {
    const rows = [...this.requests.values()];
    const total = this.backend === 'codex' ? this.total : rows.length ? add(rows.map(row => row.usage)) : null;
    const turnRows = rows.filter(row => row.turnId === this.turnId);
    const turn = this.backend === 'codex' ? subtract(this.total, this.turnBaseline)
      : this.turnId && turnRows.length ? add(turnRows.map(row => row.usage)) : null;
    const byTurn = new Map();
    for (const row of rows) { if (!byTurn.has(row.turnId)) byTurn.set(row.turnId, []); byTurn.get(row.turnId).push(row.usage); }
    const incomplete = new Set(this.missing.values());
    const completedTurns = [...this.turns.values()].filter(row => row.completedAt && row.finalMessageAt && row.completedAt >= historyFrom).map(row => {
      const usage = this.backend === 'codex' ? subtract(row.total, row.baseline)
        : byTurn.has(row.turnId) ? add(byTurn.get(row.turnId)) : null;
      return { turnId: row.turnId, startedAt: row.startedAt, completedAt: row.completedAt,
        finalMessageAt: row.finalMessageAt, finalMessageId: row.finalMessageId, usage,
        partial: this.backend !== 'codex' && (!this.complete || this.limited || incomplete.has(row.turnId)) };
    }).filter(row => row.usage).slice(-200);
    const covered = [...this.turns.values()].filter(row => this.backend !== 'codex' || row.baseline);
    return { schemaVersion: 1, backend: this.backend, status: total ? 'ready' : 'unavailable',
      totals: total, turn, latest: this.latest, turnId: this.turnId, turnActive: this.turnActive,
      completedTurns, historyFromAt: this.complete ? 0 : covered[0]?.startedAt || this.updatedAt,
      model: this.model, updatedAt: this.updatedAt, usageUpdatedAt: this.usageUpdatedAt,
      partial: this.limited || this.missing.size > 0 || (this.backend !== 'codex' && !this.complete),
      scope: this.backend === 'claude' ? 'main_session_excludes_subagents' : 'session_records', reason: total ? null : '此对话尚无可读取的 token 用量记录' };
  }
}

class ConversationUsageReader {
  constructor({ chunkBytes = 256 * 1024, tailBytes = 8 * 1024 * 1024, rowBytes = 512 * 1024, maxFiles = 24 } = {}) {
    this.chunkBytes = chunkBytes; this.tailBytes = tailBytes; this.rowBytes = rowBytes; this.maxFiles = maxFiles;
    this.states = new Map(); this.inFlight = new Map();
    this.historyRequests = new Map();
  }

  async read(backend, file, { historyFrom = 0 } = {}) {
    if (!['codex', 'claude', 'pi'].includes(backend) || !file) return { schemaVersion: 1, backend, status: 'unavailable', reason: backend === 'antigravity' ? '反重力尚无可靠的 token 用量数据源' : '暂时找不到此对话的用量记录' };
    const key = `${backend}:${file}`;
    if (Number.isSafeInteger(historyFrom) && historyFrom > 1_000_000_000_000)
      this.historyRequests.set(key, Math.min(this.historyRequests.get(key) || historyFrom, historyFrom));
    const running = this.inFlight.get(key);
    if (running) return running;
    // Register before the first asynchronous stat. Otherwise two first reads
    // can both scan and advance the same file offset.
    const work = this.readFile(backend, file, key);
    this.inFlight.set(key, work);
    try { return await work; } finally { this.inFlight.delete(key); }
  }

  async readFile(backend, file, key) {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('用量来源不是对话文件');
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    let state = this.states.get(key);
    if (!state || stat.size < state.offset || state.identity !== identity) {
      const start = backend === 'codex' ? Math.max(0, stat.size - this.tailBytes) : 0;
      state = { identity, start, offset: start, pending: Buffer.alloc(0), discard: start > 0,
        accumulator: new UsageAccumulator(backend, { complete: start === 0 }) };
      this.states.set(key, state);
    }
    // In-flight scans are never evicted. Only opened statistics panels read
    // files; large history is scanned once asynchronously, then by size growth.
    for (const [old, value] of this.states) {
      if (this.states.size <= this.maxFiles) break;
      if (old !== key && !value.running) { this.states.delete(old); this.historyRequests.delete(old); }
    }
    const work = (async () => {
      let result = await this.scan(file, state, stat.size);
      // Rewind only when the visible history needs an older turn boundary.
      // Subsequent polls still read appended bytes only, even on GB rollouts.
      while (backend === 'codex' && state.start > 0 && this.historyRequests.has(key)
        && result.historyFromAt > this.historyRequests.get(key)) {
        const start = Math.max(0, state.start - Math.max(this.tailBytes, stat.size - state.start));
        state = { identity, start, offset: start, pending: Buffer.alloc(0), discard: start > 0,
          accumulator: new UsageAccumulator(backend, { complete: start === 0 }) };
        state.running = work;
        this.states.set(key, state);
        result = await this.scan(file, state, stat.size);
      }
      return state.accumulator.snapshot(this.historyRequests.get(key) || 0);
    })();
    state.running = work;
    try { return await work; } finally { state.running = null; }
  }

  async scan(file, state, target) {
    const fd = await fs.open(file, 'r');
    const scratch = Buffer.alloc(this.chunkBytes);
    try {
      while (state.offset < target) {
        const { bytesRead } = await fd.read(scratch, 0, Math.min(scratch.length, target - state.offset), state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        const data = Buffer.concat([state.pending, scratch.subarray(0, bytesRead)]);
        let from = 0;
        while (true) {
          const end = data.indexOf(10, from);
          if (end < 0) break;
          if (state.discard) state.discard = false;
          else if (end - from > this.rowBytes) state.accumulator.limited = true;
          else {
            try {
              const line = data.subarray(from, end).toString('utf8');
              const row = JSON.parse(line);
              const sourceId = state.accumulator.backend === 'codex' && row.type === 'response_item'
                && row.payload?.type === 'message' && row.payload.role === 'assistant'
                ? row.payload.id || crypto.createHash('sha256').update(line).digest('hex') : null;
              state.accumulator.consume(row, sourceId);
            }
            catch { if (end > from + 1) state.accumulator.limited = true; }
          }
          from = end + 1;
        }
        const rest = data.subarray(from);
        if (state.discard) state.pending = Buffer.alloc(0);
        else if (rest.length > this.rowBytes) {
          state.pending = Buffer.alloc(0); state.discard = true; state.accumulator.limited = true;
        } else state.pending = Buffer.from(rest);
        await yieldLoop();
      }
      return state.accumulator.snapshot();
    } finally { await fd.close(); }
  }
}

module.exports = { ConversationUsageReader, UsageAccumulator, counts, subtract };
