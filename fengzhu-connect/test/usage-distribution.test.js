const test = require('node:test');
const assert = require('node:assert/strict');
const { UsageAccumulator, validPeriodStarts } = require('../src/conversation-usage');
const { dshDistribution, readDshDistribution } = require('../src/usage-distribution');
const base = Date.now() - 10_000;
const periods = { todayFrom: base, monthFrom: base - 10_000 };
const c = (n) => ({ input_tokens: n, output_tokens: 0, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: n });
const tok = (at, n) => ({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'token_count', info: { total_token_usage: c(n) } } });
const claude = (at, id, input, output) => ({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id, role: 'assistant', usage: { input_tokens: input, output_tokens: output }, stop_reason: 'end_turn' } });
test('Codex periods use cumulative differences without repeated snapshots', () => {
  const a = new UsageAccumulator('codex', { periods });
  [tok(base - 20_000, 100), tok(base - 5_000, 150), tok(base + 1_000, 200), tok(base + 2_000, 200)].forEach(x => a.consume(x));
  const p = a.snapshot().periods;
  assert.deepEqual(p.today, { total: 50, partial: false });
  assert.deepEqual(p.month, { total: 100, partial: false });
  assert.deepEqual(p.all, { total: 200, partial: false });
});
test('a truncated tail without an earlier baseline marks affected periods partial', () => {
  const a = new UsageAccumulator('codex', { periods, complete: false });
  a.consume(tok(base + 1_000, 100)); a.consume(tok(base + 2_000, 120));
  assert.deepEqual(a.snapshot().periods.today, { total: 20, partial: true });
  assert.equal(a.snapshot().periods.all, null); // fork identity cannot be verified from this slice
});
test('a counter reset and inherited Codex baseline do not masquerade as complete', () => {
  const a = new UsageAccumulator('codex', { periods });
  a.consume({ type: 'session_meta', payload: { forked_from_id: 'parent' } });
  a.consume(tok(base - 1_000, 100)); a.consume(tok(base + 1_000, 5));
  assert.equal(a.snapshot().periods.all, null);
  assert.equal(a.snapshot().periods.today.partial, true);
});
test('Claude attributes each deduplicated request once, including late fragments', () => {
  const a = new UsageAccumulator('claude', { periods });
  [claude(base - 20_000, 'old', 10, 1), claude(base - 5_000, 'month', 10, 2),
    claude(base + 1_000, 'today', 10, 1), claude(base + 2_000, 'today', 10, 8)].forEach(x => a.consume(x));
  const p = a.snapshot().periods;
  assert.equal(p.today.total, 18); assert.equal(p.month.total, 30); assert.equal(p.all.total, 41);
});
test('timezone boundaries are ordered and bounded', () => {
  assert.ok(validPeriodStarts(periods));
  assert.ok(!validPeriodStarts({ todayFrom: periods.monthFrom, monthFrom: periods.todayFrom }));
  assert.ok(!validPeriodStarts({ todayFrom: Date.now() + 100 * 86400_000, monthFrom: periods.monthFrom }));
});
test('DSH counts native assistant records once, including separately reported cache usage', () => {
  const row = (seq, time, inputTokens) => ({ event: { type: 'assistant/message', seq, time, data: { usage: { inputTokens, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 1 } } } });
  const p = dshDistribution([row(1, base - 5_000, 10), row(2, base + 1_000, 20), row(2, base + 1_000, 20)], periods).periods;
  assert.equal(p.today.total, 28); assert.equal(p.month.total, 46); assert.equal(p.all.total, 46);
  assert.equal(p.all.partial, false);
});
test('truncated DSH pages and missing usage are visibly incomplete', () => {
  const row = { event: { type: 'assistant/message', seq: 1, time: base + 1, data: { usage: { inputTokens: 3, outputTokens: 2 } } } };
  const p = dshDistribution([row, { event: { type: 'assistant/message', seq: 2, time: base + 2, data: {} } }], periods, true).periods;
  assert.equal(p.today.partial, true); assert.equal(p.all.partial, true);
  assert.equal(dshDistribution([], periods).status, 'unavailable');
});
test('DSH reads only the already known session', async () => {
  const calls = [];
  const client = { sessionPage: async (...args) => { calls.push(args); return { records: [{ event: { type: 'assistant/message', seq: 3, time: base + 1, data: { usage: { inputTokens: 10, outputTokens: 1 } } } }] }; } };
  const data = await readDshDistribution(client, { sessionId: 'known', syncedSeq: 6 }, periods);
  assert.equal(data.periods.all.total, 11); assert.deepEqual(calls, [['known', 6, 800]]);
});

test('statistics limit large historical scans and inspect the fork header', async t => {
  const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path');
  const { ConversationUsageReader } = require('../src/conversation-usage');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khlink-stats-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const rows = [{ type: 'session_meta', payload: { forked_from_id: 'parent' } },
    ...Array.from({ length: 120 }, (_, i) => ({ type: 'response_item', timestamp: new Date(base + i).toISOString(), payload: { type: 'reasoning', text: 'x'.repeat(100) } })),
    tok(base + 500, 400)];
  await fs.writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
  const reader = new ConversationUsageReader({ tailBytes: 512, chunkBytes: 128, maxHistoryBytes: 1024 });
  const result = await reader.read('codex', file, { historyFrom: periods.monthFrom, periods });
  const state = [...reader.states.values()][0]; const size = (await fs.stat(file)).size;
  assert.ok(state.start >= size - 1024); assert.equal(result.periods.all, null);
  assert.equal(result.periods.month.partial, true);
});

test('statistics bound Claude and Pi history reads and disclose missing older data', async t => {
  const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path');
  const { ConversationUsageReader } = require('../src/conversation-usage');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khlink-stats-bounded-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const backend of ['claude', 'pi']) {
    const file = path.join(root, `${backend}.jsonl`);
    const entry = backend === 'claude' ? claude(base + 1, 'new', 10, 2)
      : { type: 'message', id: 'new', timestamp: new Date(base + 1).toISOString(), message: { role: 'assistant', usage: { input: 10, output: 2 } } };
    const rows = [...Array.from({ length: 30 }, () => ({ type: 'progress', text: 'x'.repeat(180) })), entry];
    await fs.writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
    const reader = new ConversationUsageReader({ chunkBytes: 128, maxHistoryBytes: 1024 });
    const result = await reader.read(backend, file, { periods });
    const state = [...reader.states.values()][0]; const size = (await fs.stat(file)).size;
    assert.ok(state.start >= size - 1024, `${backend} stays within the scan bound`);
    assert.equal(result.periods.today.partial, true, `${backend} reports a partial history`);
    assert.equal(result.periods.all.partial, true);
  }
});
