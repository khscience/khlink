const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { counts, UsageAccumulator, ConversationUsageReader } = require('../src/conversation-usage');
const { Connector } = require('../src/connector');
const { methods: piMethods } = require('../src/backends/pi-sync');

const timestamp = n => new Date(1_800_000_000_000 + n * 1_000).toISOString();
const codexCounts = (input, output, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached,
  reasoning_output_tokens: Math.floor(output / 2), total_tokens: input + output });
const event = (n, type, extra = {}) => ({ timestamp: timestamp(n), type: 'event_msg', payload: { type, ...extra } });
const tokens = (n, input, output, last = codexCounts(20, 2)) => event(n, 'token_count', { info: { total_token_usage: codexCounts(input, output), last_token_usage: last } });
const claude = (n, id, output, stop = 'end_turn') => ({ timestamp: timestamp(n), type: 'assistant', uuid: `fragment-${n}`,
  message: { id, role: 'assistant', model: 'claude-test', stop_reason: stop,
    usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 30, output_tokens: output } } });
const user = (n, content = 'test') => ({ timestamp: timestamp(n), type: 'user', uuid: `turn-${n}`, message: { role: 'user', content } });
const lines = rows => rows.map(JSON.stringify).join('\n') + '\n';

const finalAnswer = (n, id, phase = 'final_answer') => ({ timestamp: timestamp(n), type: 'response_item',
  payload: { type: 'message', role: 'assistant', phase, id, content: [{ type: 'output_text', text: 'done' }] } });

test('completed Codex footers bind the whole turn to its final answer and survive a later running turn', () => {
  const acc = new UsageAccumulator('codex');
  [tokens(1, 1_000, 100), event(2, 'task_started', { turn_id: 'a' }), tokens(3, 1_100, 110),
    finalAnswer(4, 'comment', 'commentary'), tokens(5, 1_300, 130), finalAnswer(6, 'final-a')].forEach(row => acc.consume(row));
  assert.deepEqual(acc.snapshot().completedTurns, []);
  acc.consume(event(7, 'task_complete', { turn_id: 'a' }));
  const footer = acc.snapshot().completedTurns[0];
  assert.equal(footer.usage.total, 330); assert.equal(footer.finalMessageId, 'final-a');
  assert.equal(footer.finalMessageAt, Date.parse(timestamp(6)));
  acc.consume(event(8, 'task_started', { turn_id: 'b' })); acc.consume(tokens(9, 1_400, 140));
  assert.equal(acc.snapshot().turnActive, true); assert.deepEqual(acc.snapshot().completedTurns, [footer]);
});

test('old terminal events and repeated starts cannot end a newer Codex turn or reset its baseline', () => {
  const acc = new UsageAccumulator('codex');
  [tokens(1, 100, 10), event(2, 'task_started', { turn_id: 'b' }), tokens(3, 200, 20),
    event(4, 'task_started', { turn_id: 'b' }), finalAnswer(5, 'b'), event(6, 'task_complete', { turn_id: 'a' })].forEach(row => acc.consume(row));
  assert.equal(acc.snapshot().turnActive, true); assert.equal(acc.snapshot().completedTurns.length, 0);
  acc.consume(event(7, 'task_complete', { turn_id: 'b' }));
  assert.equal(acc.snapshot().completedTurns[0].usage.total, 110);
});

test('a Codex final-looking response without a terminal event or baseline never gets a misleading footer', () => {
  const acc = new UsageAccumulator('codex', { complete: false });
  [event(1, 'task_started'), tokens(2, 1_000, 100), finalAnswer(3, 'unknown')].forEach(row => acc.consume(row));
  assert.equal(acc.snapshot().completedTurns.length, 0);
  acc.consume(event(4, 'task_complete')); assert.equal(acc.snapshot().completedTurns.length, 0);
});

test('a late native token snapshot corrects the finished turn without a new completion event', () => {
  const acc = new UsageAccumulator('codex');
  [event(1, 'task_started'), tokens(2, 100, 10), finalAnswer(3, 'done'), event(4, 'task_complete')].forEach(row => acc.consume(row));
  assert.equal(acc.snapshot().completedTurns[0].usage.total, 110);
  acc.consume(tokens(5, 200, 20));
  assert.equal(acc.snapshot().completedTurns[0].usage.total, 220);
  assert.equal(acc.snapshot().completedTurns[0].completedAt, Date.parse(timestamp(4)));
});

test('Codex commentary alone stays a process message even if the turn is subsequently terminated', () => {
  const acc = new UsageAccumulator('codex');
  [event(1, 'task_started'), tokens(2, 100, 10), finalAnswer(3, 'process', 'commentary'), event(4, 'turn_aborted')].forEach(row => acc.consume(row));
  assert.equal(acc.snapshot().turnActive, false); assert.equal(acc.snapshot().completedTurns.length, 0);
});

test('Claude final footers add all tool calls, deduplicate fragments and retain earlier turns', () => {
  const acc = new UsageAccumulator('claude');
  const text = row => ({ ...row, message: { ...row.message, content: [{ type: 'text', text: 'answer' }] } });
  [user(1), text(claude(2, 'tool', 20, 'tool_use')), text(claude(3, 'final', 30)),
    text(claude(4, 'final', 40))].forEach(row => acc.consume(row));
  const first = acc.snapshot().completedTurns[0];
  assert.equal(first.usage.total, 340); assert.equal(first.finalMessageId, 'fragment-4:0'); assert.equal(first.partial, false);
  acc.consume(user(5)); acc.consume(text(claude(6, 'next', 10, 'tool_use')));
  assert.equal(acc.snapshot().turnActive, true); assert.deepEqual(acc.snapshot().completedTurns, [first]);
});

test('a missing Claude request marks only its own finished turn as partial', () => {
  const acc = new UsageAccumulator('claude');
  const text = row => ({ ...row, message: { ...row.message, content: [{ type: 'text', text: 'answer' }] } });
  const missing = text(claude(2, 'missing', 10, 'tool_use')); delete missing.message.usage;
  [user(1), missing, text(claude(3, 'final', 20)), user(4), text(claude(5, 'clean', 30))].forEach(row => acc.consume(row));
  const rows = acc.snapshot().completedTurns;
  assert.equal(rows[0].partial, true); assert.equal(rows[1].partial, false);
  acc.consume(text(claude(2, 'missing', 10, 'tool_use')));
  assert.equal(acc.snapshot().completedTurns[0].partial, false);
});

test('Pi final footers use stable native entry ids rather than mutable branch display indices', () => {
  const acc = new UsageAccumulator('pi');
  [user(1), { type: 'message', id: 'native-entry', timestamp: timestamp(2), message: { role: 'assistant',
    timestamp: Date.parse(timestamp(2)), content: [{ type: 'text', text: 'OK' }], usage: { input: 100, output: 2, totalTokens: 102 }, stopReason: 'stop' } }].forEach(row => acc.consume(row));
  assert.equal(acc.snapshot().completedTurns[0].finalMessageId, 'native-entry');
  assert.equal(acc.snapshot().completedTurns[0].usage.total, 102);
});

test('history requests rewind a bounded Codex tail to the required turn boundary, then reuse the byte offset', async t => {
  const filler = n => ({ timestamp: timestamp(n), type: 'response_item', payload: { type: 'reasoning', summary: 'x'.repeat(1_000) } });
  const file = await fileFixture(t, [tokens(1, 1_000, 100), event(2, 'task_started', { turn_id: 'old' }),
    ...Array.from({ length: 50 }, (_, i) => filler(i + 3)), tokens(54, 1_300, 130), finalAnswer(55, 'historical'), event(56, 'task_complete', { turn_id: 'old' })]);
  const reader = new ConversationUsageReader({ tailBytes: 2_048, chunkBytes: 512 });
  assert.equal((await reader.read('codex', file)).completedTurns.length, 0);
  const result = await reader.read('codex', file, { historyFrom: Date.parse(timestamp(55)) });
  assert.equal(result.completedTurns[0].usage.total, 330);
  const state = [...reader.states.values()][0], offset = state.offset;
  assert.equal(state.start, 0); await reader.read('codex', file, { historyFrom: Date.parse(timestamp(55)) });
  assert.equal([...reader.states.values()][0], state); assert.equal(state.offset, offset);
});

test('Codex footer identity matches the same raw-line hash as uploaded history', async t => {
  const answer = finalAnswer(3); delete answer.payload.id;
  const file = await fileFixture(t, [event(1, 'task_started'), tokens(2, 100, 10), answer, event(4, 'task_complete')]);
  const result = await new ConversationUsageReader().read('codex', file);
  assert.equal(result.completedTurns[0].finalMessageId, require('node:crypto').createHash('sha256').update(JSON.stringify(answer)).digest('hex'));
});
async function fileFixture(t, rows) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khlink-token-'));
  const file = path.join(root, 'conversation.jsonl');
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(file, lines(rows));
  return file;
}

test('Codex keeps cache and reasoning as subsets without adding them twice', () => {
  assert.deepEqual(counts('codex', codexCounts(100, 20, 80)), { input: 100, output: 20, cacheRead: 80, cacheWrite: null, reasoning: 10, total: 120 });
});
test('Claude inclusive input includes cache read and creation; unsupported reasoning stays unknown', () => {
  assert.deepEqual(counts('claude', claude(1, 'm', 20).message.usage), { input: 140, output: 20, cacheRead: 100, cacheWrite: 30, reasoning: null, total: 160 });
});
test('Pi trusts provider total for inclusive input instead of adding caches a second time', () => {
  assert.equal(counts('pi', { input: 140, output: 20, cacheRead: 100, cacheWrite: 30, totalTokens: 160 }).total, 160);
  assert.equal(counts('pi', { input: 10, output: 20, cacheRead: 100, cacheWrite: 30 }).total, 160);
});
test('missing, invalid and contradictory counts are not represented as zero', () => {
  for (const value of [null, {}, { ...codexCounts(10, 2), input_tokens: -1 }, { ...codexCounts(10, 2), output_tokens: 1.5 },
    { ...codexCounts(10, 2), total_tokens: 13 }, { ...codexCounts(10, 2), cached_input_tokens: 11 }]) assert.equal(counts('codex', value), null);
  assert.equal(new UsageAccumulator('codex').snapshot().totals, null);
});
test('Codex cumulative snapshots are replaced, while one turn can contain many calls', () => {
  const acc = new UsageAccumulator('codex');
  [tokens(1, 1_000, 100), event(2, 'task_started', { turn_id: 'turn-2' }), tokens(3, 1_200, 120), tokens(4, 1_500, 160), tokens(4, 1_500, 160)].forEach(row => acc.consume(row));
  const snapshot = acc.snapshot();
  assert.equal(snapshot.totals.total, 1_660);
  assert.equal(snapshot.turn.total, 560);
  assert.equal(snapshot.latest.total, 22);
  assert.equal(snapshot.turnId, 'turn-2'); assert.equal(snapshot.turnActive, true);
  acc.consume(event(5, 'task_complete', { turn_id: 'turn-2' }));
  assert.equal(acc.snapshot().turnActive, false);
});
test('a Codex tail without the turn baseline never calls the last request the whole turn', () => {
  const acc = new UsageAccumulator('codex', { complete: false });
  acc.consume(event(1, 'task_started')); acc.consume(tokens(2, 100, 10));
  assert.equal(acc.snapshot().turn, null); assert.equal(acc.snapshot().latest.total, 22);
});
test('a fork with inherited Codex counts does not assume a zero starting baseline', () => {
  const acc = new UsageAccumulator('codex');
  acc.consume({ type: 'session_meta', payload: { forked_from_id: 'parent' } });
  acc.consume(event(1, 'task_started')); acc.consume(tokens(2, 100, 10));
  assert.equal(acc.snapshot().turn, null);
});
test('Claude repeated assistant fragments merge per message before sum; tool calls stay in the same turn', () => {
  const acc = new UsageAccumulator('claude');
  [user(1), claude(2, 'm1', 1, 'tool_use'), claude(3, 'm1', 20, 'tool_use'), user(4, [{ type: 'tool_result', content: 'ok' }]),
    user(5, 'steer during running turn'), claude(6, 'm2', 30)].forEach(row => acc.consume(row));
  assert.equal(acc.snapshot().totals.total, 330); assert.equal(acc.snapshot().turn.total, 330);
  assert.equal(acc.snapshot().turnId, 'turn-1'); assert.equal(acc.snapshot().turnActive, false);
  acc.consume(user(7)); assert.equal(acc.snapshot().turn, null);
  acc.consume(claude(8, 'm3', 5)); assert.equal(acc.snapshot().turn.total, 145); assert.equal(acc.snapshot().totals.total, 475);
});
test('a late fragment belonging to an earlier Claude response does not move it into the new turn', () => {
  const acc = new UsageAccumulator('claude');
  [user(1), claude(2, 'm1', 20), user(3), claude(4, 'm2', 5), claude(2, 'm1', 20)].forEach(row => acc.consume(row));
  assert.equal(acc.snapshot().turn.total, 145); assert.equal(acc.snapshot().latest.total, 145);
  assert.equal(acc.snapshot().totals.total, 305);
});
test('missing usage marks partial, later fragments repair it, and a missing terminal usage still ends the turn', () => {
  const acc = new UsageAccumulator('claude');
  const row = claude(2, 'm', 20); delete row.message.usage;
  acc.consume(user(1)); acc.consume(row);
  assert.equal(acc.snapshot().turnActive, false); assert.equal(acc.snapshot().partial, true);
  acc.consume(claude(3, 'm', 20)); assert.equal(acc.snapshot().partial, false);
  acc.consume(row); assert.equal(acc.snapshot().partial, false);
});
test('Claude sidechain and local meta commands do not charge this session or create a new turn', () => {
  const acc = new UsageAccumulator('claude');
  acc.consume({ ...claude(1, 'side', 1), isSidechain: true });
  acc.consume(user(2, '<local-command-stdout>ok</local-command-stdout>'));
  assert.equal(acc.snapshot().status, 'unavailable'); assert.equal(acc.snapshot().turnId, null);
});
test('Pi counts all unique recorded physical requests, including branches, without replay duplicates', () => {
  const acc = new UsageAccumulator('pi');
  const message = id => ({ type: 'message', id, timestamp: timestamp(Number(id)), message: { role: 'assistant', usage: { input: 10, output: 2, totalTokens: 12 }, stopReason: 'stop' } });
  [message('1'), message('2'), message('1')].forEach(row => acc.consume(row));
  assert.equal(acc.snapshot().totals.total, 24); assert.equal(acc.snapshot().latest.total, 12);
});
test('a bounded request ledger advertises incomplete coverage rather than pretending to be full', () => {
  const acc = new UsageAccumulator('claude', { maxRequests: 1 });
  acc.consume(claude(1, 'a', 2)); acc.consume(claude(2, 'b', 3));
  assert.equal(acc.snapshot().partial, true); assert.equal(acc.requests.size, 1);
});
test('reader tracks byte growth despite old Windows mtime, and re-reading unchanged data is idempotent', async t => {
  const file = await fileFixture(t, [tokens(1, 100, 10)]);
  const reader = new ConversationUsageReader();
  assert.equal((await reader.read('codex', file)).totals.total, 110);
  await fs.appendFile(file, lines([tokens(2, 200, 20)])); await fs.utimes(file, 1, 1);
  assert.equal((await reader.read('codex', file)).totals.total, 220);
  assert.equal((await reader.read('codex', file)).totals.total, 220);
});
test('simultaneous first reads share one scan, before even the initial stat finishes', async t => {
  const file = await fileFixture(t, [claude(1, 'a', 20)]);
  const reader = new ConversationUsageReader({ chunkBytes: 32 });
  const scan = reader.scan.bind(reader); let calls = 0;
  reader.scan = (...args) => { calls++; return scan(...args); };
  const values = await Promise.all(Array.from({ length: 10 }, () => reader.read('claude', file)));
  assert.equal(calls, 1); assert.ok(values.every(row => row.totals.total === 160));
});
test('reader retains an incomplete UTF-8 line until append completes it, without losing or double-counting it', async t => {
  const file = await fileFixture(t, []); const row = { ...claude(1, '中', 20), extra: '测试字符' };
  const buffer = Buffer.from(lines([row])); const split = buffer.indexOf(Buffer.from('中')) + 1;
  await fs.writeFile(file, buffer.subarray(0, split));
  const reader = new ConversationUsageReader({ chunkBytes: 17 });
  assert.equal((await reader.read('claude', file)).totals, null);
  await fs.appendFile(file, buffer.subarray(split));
  assert.equal((await reader.read('claude', file)).totals.total, 160);
});
test('oversized chat/image rows are skipped with bounded memory; subsequent usage remains readable', async t => {
  const file = await fileFixture(t, [{ type: 'message', text: 'x'.repeat(10_000) }, tokens(1, 100, 10)]);
  const reader = new ConversationUsageReader({ chunkBytes: 97, rowBytes: 700 });
  const result = await reader.read('codex', file);
  assert.equal(result.totals.total, 110); assert.equal(result.partial, false);
  assert.ok([...reader.states.values()][0].pending.length <= 700);
});
test('tail scans and file truncation never reuse a previous file generation aggregate', async t => {
  const file = await fileFixture(t, [user(1, 'x'.repeat(2_000)), tokens(2, 100, 10)]);
  const reader = new ConversationUsageReader({ tailBytes: 650 });
  assert.equal((await reader.read('codex', file)).totals.total, 110);
  await fs.writeFile(file, lines([tokens(3, 10, 1)]));
  assert.equal((await reader.read('codex', file)).totals.total, 11);
});
test('Antigravity and missing logs return unavailable, never invented zero usage', async () => {
  const reader = new ConversationUsageReader();
  for (const backend of ['antigravity', 'claude']) {
    const result = await reader.read(backend, null);
    assert.equal(result.status, 'unavailable'); assert.equal(result.totals, undefined);
  }
});
test('usage command resolves only the known thread log and never invokes the agent/changes live status', async t => {
  const file = await fileFixture(t, [claude(1, 'a', 20)]);
  const connector = Object.create(Connector.prototype);
  connector.claudeThreads = new Map([['owned', { transcriptFile: file }]]);
  connector.config = { deviceId: 'connector-test' }; connector.log = () => {};
  connector.claudeBackendCommand = () => { throw new Error('must not call backend'); };
  connector.publishThreadStatus = () => { throw new Error('must not change task status'); };
  const result = await connector.command({ action: 'thread.usage.read', args: { threadId: 'owned', path: 'ignored-external-file' } }, 'phone-test');
  assert.equal(result.totals.total, 160); assert.equal(result.backend, 'claude'); assert.equal(result.connectorId, 'connector-test');
});

test('an unchanged Pi session still migrates its known source path for on-demand statistics', async () => {
  const modified = '2020-01-01T00:00:00Z';
  const meta = { entryCount: 2, modifiedAt: Date.parse(modified), name: 'test', running: false, unread: false, itemsSchema: 999, announcedStatus: 'completed' };
  const connector = { piThreads: new Map([['pi-test', meta]]), uploadPiIndex: async () => {}, savePiThreads: () => {}, piThreadStatus: () => 'completed' };
  assert.equal(await piMethods.syncPiSession.call(connector, { id: 'pi-test', modified, messageCount: 2, name: 'test', path: '/known-session.jsonl' }, { cwd: '/workspace' }, false), true);
  assert.equal(meta.sessionFile, '/known-session.jsonl');
});

test('missing Claude transcript returns an explicit read failure without touching credentials or calling Claude', async () => {
  const connector = Object.create(Connector.prototype);
  connector.claudeThreads = new Map([['missing', { transcriptFile: path.join(os.tmpdir(), 'khlink-definitely-missing', 'x.jsonl') }]]);
  connector.log = () => {};
  assert.equal((await connector.readConversationUsage('missing')).status, 'unavailable');
});

test('a slow scan replies promptly and sends its eventual result only to the requesting device', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connector = Object.create(Connector.prototype);
  connector.antigravityThreads = new Map([['slow', {}]]); connector.config = { deviceId: 'pc' };
  let finish; const scan = new Promise(resolve => { finish = resolve; });
  connector.conversationUsageReader = { read: () => scan };
  const events = []; connector.emit = (...args) => events.push(args);
  const result = connector.readConversationUsage('slow', 'phone-one');
  t.mock.timers.tick(3_000);
  assert.equal((await result).status, 'scanning');
  finish({ schemaVersion: 1, backend: 'antigravity', status: 'unavailable' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(events[0][0], 'thread.usage'); assert.equal(events[0][3], 'phone-one'); assert.equal(events[0][2].connectorId, 'pc');
});

test('late Claude terminal fragments cannot end a different currently running turn', () => {
  const acc = new UsageAccumulator('claude');
  [user(1), claude(2, 'old', 20), user(3), claude(2, 'old', 20)].forEach(row => acc.consume(row));
  assert.equal(acc.snapshot().turnActive, true); assert.equal(acc.snapshot().turnId, 'turn-3');
});
test('old Codex counter copies cannot regress the most recently recorded native snapshot', () => {
  const acc = new UsageAccumulator('codex');
  [tokens(2, 200, 20), tokens(1, 100, 10)].forEach(row => acc.consume(row));
  assert.equal(acc.snapshot().totals.total, 220);
});
