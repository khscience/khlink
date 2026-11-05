const test = require('node:test');
const assert = require('node:assert/strict');
const { methods } = require('../src/backends/claude-desktop-sync');
const { accountIdentity } = require('../src/account-identity');
const { selectUsage } = require('../src/backends/claude-desktop-usage');
const { UsageAccumulator } = require('../src/conversation-usage');

for (const managed of [false, true]) test(`quota refresh is passive on ${managed ? 'managed' : 'ordinary'} installations`, async () => {
  let reads = 0, published = 0;
  const owner = { claudeProfileLock: { managed: () => managed },
    currentClaudeBin() { throw Error('must not inspect/launch CLI for quota'); },
    claudeSpawnFn() { throw Error('must not create a model turn'); },
    claudeDesktop: { latestOfficialUsage() { reads++; } },
    publishClaudeUsage() { published++; return {}; } };
  await methods.refreshClaudeUsage.call(owner);
  assert.equal(await methods.maybeRefreshFiveHourReset.call(owner), false);
  assert.equal(reads, 1); assert.equal(published, 1);
  assert.equal(owner._claudeUsageRefreshUnavailableReason, 'desktop_refresh_required');
});

test('account IDs are stable only within one installation and namespace', () => {
  const a = Buffer.alloc(32, 1), b = Buffer.alloc(32, 2);
  assert.equal(accountIdentity('claude', 'same-org', a), accountIdentity('claude', 'same-org', a));
  assert.notEqual(accountIdentity('claude', 'same-org', a), accountIdentity('claude', 'same-org', b));
  assert.notEqual(accountIdentity('claude', 'same-org', a), accountIdentity('codex', 'same-org', a));
  assert.doesNotMatch(accountIdentity('claude', 'email@example.test', a), /email|example/);
});

test('new compact samples retain exact future reset independently for each window', () => {
  const now = 1792000000000;
  const response = { source: 'cached', observedAt: now - 60000,
    fiveHour: { remaining: 70, observedAt: now - 60000, resetsAt: now + 1000 },
    sevenDay: { remaining: 80, observedAt: now - 60000, resetsAt: now + 100000 } };
  const history = { source: 'history', observedAt: now,
    fiveHour: { remaining: 65, observedAt: now, resetsAt: null }, sevenDay: { remaining: null, observedAt: now } };
  const result = selectUsage(history, null, response, now);
  assert.equal(result.fiveHour.remaining, 65); assert.equal(result.fiveHour.resetsAt, now + 1000);
  assert.equal(result.sevenDay.remaining, 80); assert.equal(result.sevenDay.observedAt, now - 60000);
  history.fiveHour.remaining = 99;
  assert.equal(selectUsage(history, null, response, now).fiveHour.resetsAt, null, 'reset/drop is a different window');
  history.fiveHour.remaining = 65;
  assert.equal(selectUsage(history, null, response, now + 2000).fiveHour.resetsAt, null, 'expired exact time is not reused');
});

test('Claude interruption ends a turn before the next real user message', () => {
  const a = new UsageAccumulator('claude');
  const consume = (uuid, time, role, content, usage) => a.consume({uuid, type:role, timestamp:time,
    message:{id:uuid,role,content,usage,stop_reason:role==='assistant'?'tool_use':null}});
  consume('u1', 1, 'user', '测试一');
  consume('a1', 2, 'assistant', [{type:'text',text:'处理中'}], {input_tokens:2,output_tokens:3});
  consume('stop', 3, 'user', '[Request interrupted by user]');
  consume('u2', 4, 'user', '测试二');
  consume('a2', 5, 'assistant', [{type:'text',text:'新回答'}], {input_tokens:5,output_tokens:7});
  assert.equal(a.snapshot().turnId, 'u2'); assert.equal(a.snapshot().turn.total, 12);
  assert.equal(a.snapshot().completedTurns[0].usage.total, 5);
  assert.equal(a.snapshot().scope, 'main_session_excludes_subagents');
});
