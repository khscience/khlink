const test = require('node:test');
const assert = require('node:assert/strict');
const { methods: dsh } = require('../src/backends/dsh-sync');
const { methods: pi } = require('../src/backends/pi-sync');
const { methods: hermes } = require('../src/backends/hermes-sync');
const { dshConversation } = require('../src/usage-distribution');

for (const backend of ['dsh', 'pi', 'hermes']) {
  test(`${backend} selects the requested model before the first prompt and stops on rejection`, async () => {
    for (const reject of [false, true]) {
      const calls = [];
      const select = async (...args) => { calls.push(['model', ...args]); if (reject) throw Error('unavailable'); };
      const prompt = async () => { calls.push(['prompt']); };
      const common = { probe: async () => 'up', createSession: async () => ({ id: 'new' }), create: async () => ({ sessionId: 'new' }), prompt };
      const ctx = { dsh: { ...common, selectModel: select }, dshThreads: new Map(), saveDshThreads() {}, watchDshTurn() {}, dshAttachmentParts: args => args,
        pi: { ...common, setModel: select }, piThreads: new Map(), piAttachmentParts: args => args, watchPiTurn() {},
        hermesAcp: { newSession: common.create, setModel: select, sessionModels: new Map() }, hermesTransport: { isAbsolute: () => true },
        hermesThreads: new Map(), saveHermesThreads() {}, uploadHermesIndex: async () => {}, hermesPromptBlocks: async () => [], startHermesTurn: prompt, emit() {} };
      const methods = { dsh, pi, hermes }[backend];
      const model = backend === 'hermes' ? 'provider:family/model' : 'provider/family/model';
      const run = methods[`${backend}Command`].call(ctx, { action: 'thread.newWithTurn', args: { model, cwd: '/tmp', text: '你好' } });
      if (reject) await assert.rejects(run, /unavailable/); else await run;
      assert.deepEqual(calls.map(call => call[0]), reject ? ['model'] : ['model', 'prompt']);
      if (backend === 'dsh') assert.deepEqual(calls[0][2], { provider: 'provider', model: 'family/model' });
      if (backend === 'pi') assert.deepEqual(calls[0].slice(-2), ['provider', 'family/model']);
      if (backend === 'hermes') assert.equal(calls[0][2], model);
    }
  });
}

test('DSH speed uses one bounded turn and the final visible block, with duplicate events counted once', () => {
  const user = { type: 'user/message', seq: 1, time: 1000, data: { source: { kind: 'user' } } };
  const assistant = { type: 'assistant/message', seq: 2, time: 2400, data: { usage: { inputTokens: 8, outputTokens: 6 },
    message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }] } } };
  const end = { type: 'turn/end', seq: 3, time: 2500 };
  const result = dshConversation([end, user, assistant, assistant], 'dsh-x', true);
  assert.equal(result.totals.output, 6);
  assert.equal(result.partial, true);
  assert.equal(result.completedTurns[0].partial, false);
  assert.equal(result.completedTurns[0].finalMessageId, 'dsh-x-2-t1');
  assert.equal(dshConversation([assistant, end], 'x', true).completedTurns.length, 0);
  assert.equal(dshConversation([user, assistant], 'x', false).completedTurns.length, 0);
});

test('Hermes only binds ACP usage to the matching stored prompt and final answer', async () => {
  const run = { startedAt: 1000, syncedAtStart: 2, promptText: '问题' };
  const result = { stopReason: 'end_turn', usage: { inputTokens: 150, outputTokens: 30 } };
  let rows = [{ role: 'user', id: 3, content: '问题' }, { role: 'assistant', id: 4, timestamp: 2.4, content: '回答' }];
  const ctx = { saveHermesThreads() {}, hermesTransport: { store: async () => ({ messages: rows }) } };
  const meta = { sessionId: 'x' };
  await hermes.recordHermesTurnUsage.call(ctx, 'hermes-x', meta, run, result, 2500);
  assert.equal(meta.completedUsage[0].finalMessageId, 'hermes-x-m4');
  assert.equal(meta.completedUsage[0].usage.output, 30);
  const older = { sessionId: 'x' };
  await hermes.recordHermesTurnUsage.call(ctx, 'hermes-x', older, run, { stopReason: 'end_turn' }, 3000);
  assert.equal(older.measuredReplyMs['hermes-x-m4'], 2000);
  assert.equal(older.completedUsage, undefined);
  rows = [...rows, { role: 'user', id: 5, content: '下一轮' }];
  await hermes.recordHermesTurnUsage.call(ctx, 'hermes-x', meta, run, result, 4000);
  assert.equal(meta.completedUsage.length, 1);
  assert.equal(meta.completedUsage[0].completedAt, 2500);
});
