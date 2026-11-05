const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Connector } = require('../src/connector');
const claudeDesktop = require('../src/backends/claude-desktop-sync');
const antigravity = require('../src/backends/antigravity-sync');
const ag = require('../src/backends/antigravity');

// Backends that publish an inferred quiet status must not produce a reminder;
// Codex itself must wait for its explicit terminal marker instead.
function publisherFor() {
  const connector = Object.create(Connector.prototype);
  connector.desktopStatuses = new Map();
  connector.desktopStatusAt = new Map();
  connector.isBridgeOwnedThread = () => false;
  connector.connectorRunsThread = () => false;
  connector.log = () => {};
  const emitted = [];
  connector.emit = (kind, id, value) => emitted.push({ kind, id, status: value.status, quiet: value.quiet });
  return { connector, emitted };
}

test('a silent completion clears the badge, and the turn real end is still published', () => {
  const threadId = 'thread-quiet-1';
  const { connector, emitted } = publisherFor();
  connector.publishThreadStatus(threadId, 'desktop_running');
  connector.publishThreadStatus(threadId, 'completed', false, { quiet: true });
  connector.publishThreadStatus(threadId, 'completed', false, { quiet: true });
  connector.publishThreadStatus(threadId, 'completed');
  connector.publishThreadStatus(threadId, 'completed');
  connector.publishThreadStatus(threadId, 'completed', false, { quiet: true });
  assert.deepEqual(emitted, [
    { kind: 'thread.status', id: threadId, status: 'desktop_running', quiet: undefined },
    { kind: 'thread.status', id: threadId, status: 'completed', quiet: true },
    { kind: 'thread.status', id: threadId, status: 'completed', quiet: undefined },
  ]);
});

test('a quiet Codex rollout stays running until its real task_complete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-quiet-end-'));
  const previousHome = process.env.CODEX_HOME;
  const threadId = 'abcdef12-6789-1234-1234-123456789abe';
  const directory = path.join(root, 'sessions', '2026', '08', '18');
  const file = path.join(directory, `rollout-${threadId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  const oldAt = Date.now() - 11 * 60_000;
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: new Date(oldAt).toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: new Date(oldAt + 1000).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', name: 'exec' } }),
  ].join('\n') + '\n');
  const old = new Date(oldAt);
  fs.utimesSync(file, old, old);
  process.env.CODEX_HOME = root;
  try {
    const connector = Object.create(Connector.prototype);
    connector.desktopStatuses = new Map([[threadId, 'desktop_running']]);
    connector.desktopStatusAt = new Map();
    connector.desktopActiveThreads = new Set([threadId]);
    connector.rolloutFilesByThread = new Map([[threadId, file]]);
    connector.rolloutStatusScans = new Map();
    connector.rolloutLookupAt = new Map();
    connector.threadState = new Map();
    connector.isBridgeOwnedThread = () => false;
    connector.connectorRunsThread = () => false;
    connector.log = () => {};
    const emitted = [];
    connector.emit = (kind, id, value) => emitted.push({ status: value.status, quiet: value.quiet });
    connector.reconcileLiveStatusesFromRollouts();
    assert.deepEqual(emitted, []);
    // The turn carries on, then really ends with task_complete.
    fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
    connector.reconcileLiveStatusesFromRollouts();
    assert.deepEqual(emitted, [{ status: 'completed', quiet: undefined }]);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Claude desktop turn that only went quiet is a silent completion; an end_turn is not', () => {
  const threadId = 'claude-quiet-1';
  const ctx = { ...claudeDesktop.methods, claude: null, claudeThreads: new Map() };
  const at = (minutesAgo) => Date.now() - minutesAgo * 60_000;
  // Quiet for longer than the busy window, last event a tool use: silent.
  ctx.claudeThreads.set(threadId, { transcriptLastEvent: 'tool_use', transcriptLastEventAt: at(25) });
  assert.equal(ctx.claudeCompletionIsQuiet(threadId), true);
  assert.equal(ctx.claudeThreadStatus(threadId), 'completed');
  // A finished turn is a real end.
  ctx.claudeThreads.set(threadId, { transcriptLastEvent: 'end_turn', transcriptLastEventAt: at(25) });
  assert.equal(ctx.claudeCompletionIsQuiet(threadId), false);
  // Recently written: still running, so there is no completion at all.
  ctx.claudeThreads.set(threadId, { transcriptLastEvent: 'tool_use', transcriptLastEventAt: at(1) });
  assert.equal(ctx.claudeCompletionIsQuiet(threadId), false);
  assert.notEqual(ctx.claudeThreadStatus(threadId), 'completed');
});

test('an Antigravity turn left by silence is a silent end; a finished reply, a stop or a window report is not', () => {
  const ctx = { ...antigravity.methods };
  const stat = { mtimeMs: Date.now() };
  const meta = (fields) => ({ lastAt: Date.now(), lastIdx: 1, ...fields });
  const minutes = (value) => value * 60_000;
  const quietLong = meta({ lastAt: Date.now() - minutes(31), lastType: 9, lastStatus: ag.STATUS_ACTIVE.values().next().value });
  assert.equal(ctx.antigravityRunning(quietLong, stat), false);
  assert.equal(ctx.antigravityEndedBySilence(quietLong, stat), true);
  // No step written for longer than the running quiet period after a finished tool step.
  const quietStep = meta({ lastAt: Date.now() - minutes(3), lastType: 9, lastStatus: 3 });
  assert.equal(ctx.antigravityEndedBySilence(quietStep, stat), true);
  // A finished model reply is the turn's own end.
  const reply = meta({ lastAt: Date.now() - minutes(3), lastType: ag.STEP_MODEL, lastStatus: 3 });
  assert.equal(ctx.antigravityEndedBySilence(reply, stat), false);
  // A stop from the phone and a failure are explicit.
  const stopped = meta({ lastAt: Date.now() - minutes(3), lastType: 9, lastStatus: [...ag.STATUS_STOPPED][0] });
  assert.equal(ctx.antigravityEndedBySilence(stopped, stat), false);
  const failed = meta({ lastAt: Date.now() - minutes(3), lastType: 9, lastStatus: [...ag.STATUS_FAILED][0] });
  assert.equal(ctx.antigravityEndedBySilence(failed, stat), false);
  // The window itself said the turn is over (foreground, no cancel button): explicit.
  const windowEnded = meta({ lastAt: Date.now() - minutes(3), lastType: 9, lastStatus: 3, windowState: { foreground: true, active: false, at: Date.now() - minutes(2) } });
  assert.equal(ctx.antigravityEndedBySilence(windowEnded, stat), false);
  // Still running: nothing has ended.
  const live = meta({ lastAt: Date.now() - 10_000, lastType: 9, lastStatus: 3 });
  assert.equal(ctx.antigravityRunning(live, stat), true);
  assert.equal(ctx.antigravityEndedBySilence(live, stat), false);
});
