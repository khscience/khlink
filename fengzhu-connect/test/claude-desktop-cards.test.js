const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClaudeDesktopStore, pendingToolUse, START_SESSION_TOOL, OFFER_NEW, OFFER_HERE } = require('../src/backends/claude-desktop');

const SESSION = 'local_833f635e-606d-4025-beda-4b530ea4fc40';
function store(t, lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-cards-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const log = path.join(root, 'main.log');
  fs.writeFileSync(log, lines.join('\n') + '\n');
  return new ClaudeDesktopStore({ root, logFiles: [log], projectsRoot: root });
}
const at = (time) => `2026-10-27 ${time}`;
const now = Date.parse('2026-10-27T08:30:00');

test('a suggested side session is followed until it is answered or expires', t => {
  const desktop = store(t, [
    `${at('08:19:11')} [info] [CCD] side session offered task_98df84a2 <- ${SESSION}`,
    `${at('08:19:30')} [info] [CCD] side session offered task_aaaaaaaa <- local_00000000-0000-0000-0000-000000000001`,
    `${at('08:20:00')} [info] [CCD] offer task_aaaaaaaa brief -> local_00000000-0000-0000-0000-000000000002`,
  ]);
  desktop.pendingPrompts(now);
  const offers = desktop.pendingOffers(now);
  assert.deepEqual([...offers.keys()], [SESSION]);
  assert.equal(offers.get(SESSION).task, 'task_98df84a2');
});

test('a folder checked for trust and trusted since is no longer waiting', t => {
  const desktop = store(t, [
    `${at('08:16:00')} [info] LocalSessions.checkTrust: cwd=I:\tmp\khlink-test`,
    `${at('08:16:10')} [info] LocalSessions.checkTrust: cwd=I:\tmp\khlink-test-newfolder`,
    `${at('08:16:22')} [info] LocalSessions.saveTrust: cwd=I:\tmp\khlink-test-newfolder`,
  ]);
  desktop.pendingPrompts(now);
  assert.deepEqual(desktop.pendingTrustChecks(now).map(item => item.folder), ['I:\tmp\khlink-test']);
  assert.deepEqual(desktop.pendingTrustChecks(now + 20 * 60_000), []);
});

test('an unanswered offer becomes a two-choice question; an answered one is gone', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-offer-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const file = path.join(root, 'session.jsonl');
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: START_SESSION_TOOL, input: { initiation: 'offer', title: '查询后天上海天气' } }] } };
  fs.writeFileSync(file, JSON.stringify(call) + '\n');
  const pending = pendingToolUse(file, START_SESSION_TOOL);
  assert.equal(pending.source, 'session-offer');
  assert.equal(pending.title, '查询后天上海天气');
  assert.deepEqual(pending.questions[0].options.map(o => o.label), [OFFER_NEW, OFFER_HERE]);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }) + '\n');
  assert.equal(pendingToolUse(file, START_SESSION_TOOL), null);
  // A session Claude starts directly is no question for the phone.
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: START_SESSION_TOOL, input: { initiation: 'user_asked', title: '查天气' } }] } }) + '\n');
  assert.equal(pendingToolUse(file, START_SESSION_TOOL).kind, 'sessionStart');
});
