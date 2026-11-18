const test = require('node:test');
const assert = require('node:assert/strict');
const { Connector } = require('../src/connector');
const { parseSteerOutput } = require('../src/codex-desktop-steer');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// A message in Codex's protocol queue for a task Codex Desktop runs: the
// window does not show that queue (26.1027), so a steer leaves the queue and
// goes through the window's own Queue and Steer controls.
function fixture(steerResult) {
  const self = Object.create(Connector.prototype);
  self.followups = {
    items: [{ id: 'm1', requestId: 'm1', threadId: 'thread-05', title: '5.NAS', text: '再短一点', displayText: '再短一点',
      state: 'desktop_queued', queueTransport: 'codex', codexQueueId: 'q-1', steerRequested: true, blocking: true, attachments: [] }],
    get(id) { return this.items.find((row) => row.id === id); },
    update(id, changes) { const row = this.get(id); if (row) Object.assign(row, changes); return row; },
    remove(id) { this.items = this.items.filter((row) => row.id !== id); },
  };
  self.events = []; self.emit = (kind, id, data) => self.events.push({ kind, data }); self.log = () => {};
  self.calls = [];
  self.codex = { request: async (method, params) => {
    self.calls.push(method);
    if (method === 'thread/queue/add') return { queuedSubmission: { id: 'q-2', clientUserMessageId: params.clientUserMessageId } };
    return {};
  } };
  self.steered = [];
  self.codexDesktopSteer = { steer: async (request) => { self.steered.push(request); return steerResult; } };
  self.desktopAdapter = { steer: async () => assert.fail('the blind native adapter is not used') };
  return self;
}

test('a steer leaves the protocol queue and goes into the running turn through the window', async () => {
  const self = fixture({ code: 'steer_accepted', delivery: 'confirmed' });
  const result = await self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true });
  assert.equal(result.accepted, true);
  assert.deepEqual(self.calls, ['thread/queue/delete']);
  assert.equal(self.steered[0].title, '5.NAS');
  assert.match(self.steered[0].text, /^再短一点/);
  assert.equal(self.followups.get('m1').state, 'started');
  assert.ok(self.events.some((e) => e.kind === 'steer.accepted'));
});

test('a window that cannot take it puts the message back in the protocol queue, never sending it twice', async () => {
  const self = fixture({ code: 'composer_unavailable', delivery: 'not_sent' });
  const result = await self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true });
  assert.equal(result.deferred, true);
  assert.deepEqual(self.calls, ['thread/queue/delete', 'thread/queue/add']);
  const item = self.followups.get('m1');
  assert.equal(item.state, 'desktop_queued'); assert.equal(item.codexQueueId, 'q-2');
  assert.match(item.reason, /在等你批准/);
});

test('an interrupted Desktop queue keeps the requested message queued and explains the pause', async () => {
  const self = fixture({ code: 'queue_paused', delivery: 'not_sent' });
  const result = await self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true });
  assert.equal(result.deferred, true);
  assert.deepEqual(self.calls, ['thread/queue/delete', 'thread/queue/add']);
  assert.equal(self.followups.get('m1').codexQueueId, 'q-2');
  assert.match(self.followups.get('m1').reason, /队列.*暂停/);
  assert.equal(self.followups.get('m1').steerRequested, false);
  assert.equal(self.followups.get('m1').steerRetryAt, null);
});

test('a paused native Desktop queue remains intact and does not repeatedly steer', async () => {
  const self = fixture({ code: 'unused', delivery: 'not_sent' });
  self.followups.get('m1').queueTransport = 'desktop';
  self.desktopAdapter.steer = async () => { const error = new Error('queue paused'); error.code = 'queue_paused'; error.delivery = 'not_sent'; throw error; };
  const result = await self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true });
  assert.equal(result.deferred, true);
  assert.equal(self.followups.get('m1').state, 'desktop_queued');
  assert.equal(self.followups.get('m1').steerRequested, false);
  assert.equal(self.followups.get('m1').steerRetryAt, null);
  assert.match(self.followups.get('m1').reason, /队列.*暂停/);
  assert.deepEqual(self.calls, []);
});

test('a message the window kept in its own queue waits there, and an unclear result is never retried', async () => {
  const kept = fixture({ code: 'steer_deferred', delivery: 'confirmed' });
  assert.equal((await kept.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true })).deferred, true);
  assert.equal(kept.followups.get('m1').queueTransport, 'desktop');
  assert.deepEqual(kept.calls, ['thread/queue/delete']);
  const unclear = fixture({ code: 'timeout', delivery: 'uncertain' });
  assert.equal((await unclear.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true })).uncertain, true);
  assert.equal(unclear.followups.get('m1').state, 'uncertain');
  assert.deepEqual(unclear.calls, ['thread/queue/delete']);
});

test('the script output is read safely', () => {
  assert.deepEqual(parseSteerOutput('{"phase":"write"}\r\n{"ok":true,"code":"steer_accepted","delivery":"confirmed","message":"x"}\r\n'),
    { code: 'steer_accepted', delivery: 'confirmed', message: 'x' });
  assert.equal(parseSteerOutput('{"phase":"write"}\n', { killed: true }).delivery, 'uncertain');
  assert.equal(parseSteerOutput('', { killed: true }).delivery, 'not_sent');
  // UI Automation can time out after SetValue wrote a draft but before the
  // send button is reached.  A retry here would create a second copy.
  assert.equal(parseSteerOutput('{"phase":"editing"}\n', { killed: true }).delivery, 'uncertain');
  assert.equal(parseSteerOutput('{"phase":"editing"}\n{"code":"failed","delivery":"not_sent"}').delivery, 'uncertain');
});

test('a write that may have left a draft is never put back in the protocol queue', async () => {
  const self = fixture({ code: 'composer_write_unconfirmed', delivery: 'uncertain' });
  const result = await self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true });
  assert.equal(result.uncertain, true);
  assert.equal(self.followups.get('m1').state, 'uncertain');
  assert.deepEqual(self.calls, ['thread/queue/delete']);
});

test('queue-only handoff keeps a running Desktop turn queued without steering it', async () => {
  const self = fixture({ code: 'queued', delivery: 'confirmed' });
  self.followups.get('m1').steerRequested = false;
  const result = await self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true, queueOnly: true });
  assert.equal(result.deferred, true);
  assert.equal(self.steered[0].mode, 'queue');
  assert.equal(self.followups.get('m1').queueTransport, 'desktop');
  assert.equal(self.followups.get('m1').state, 'desktop_queued');
  assert.deepEqual(self.calls, ['thread/queue/delete']);
});

test('queue-only handoff starts immediately when Desktop is idle', async () => {
  const self = fixture({ code: 'sent', delivery: 'confirmed' });
  self.followups.get('m1').steerRequested = false;
  const result = await self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true, queueOnly: true });
  assert.equal(result.accepted, true);
  assert.equal(self.steered[0].mode, 'queue');
  assert.equal(self.followups.get('m1').state, 'started');
  assert.deepEqual(self.calls, ['thread/queue/delete']);
});

test('an explicit queue stays in the original protocol row while Desktop is running, then hands off once', async () => {
  const self = fixture({ code: 'sent', delivery: 'confirmed' });
  self.followups.get('m1').steerRequested = false;
  self.desktopActivitySnapshotHealthy = true;
  self.desktopActiveThreads = new Set(['thread-05']);
  self.desktopStatuses = new Map([['thread-05', 'desktop_running']]);
  self.retryPendingDesktopSettings = async () => {};
  const request = self.codex.request;
  self.codex.request = async (method, params) => method === 'thread/queue/list'
    ? { data: [{ id: 'q-1', clientUserMessageId: 'm1' }] } : request(method, params);

  const waiting = await self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true, queueOnly: true });
  assert.equal(waiting.deferred, true);
  assert.equal(self.followups.get('m1').codexQueueId, 'q-1');
  assert.equal(self.followups.get('m1').windowQueueRequested, true);
  assert.deepEqual(self.calls, []);
  assert.equal(self.steered.length, 0);

  // Desktop's active-list snapshot can omit a running task. Do not attempt
  // a transfer while the rollout status still says this turn is running.
  self.desktopActiveThreads.delete('thread-05');
  self.followups.update('m1', { steerRetryAt: 0 });
  await self.retryFollowups();
  assert.deepEqual(self.calls, []);
  assert.equal(self.steered.length, 0);

  self.desktopStatuses.set('thread-05', 'completed');
  self.followups.update('m1', { steerRetryAt: 0 });
  await self.retryFollowups();
  assert.deepEqual(self.calls, ['thread/queue/delete']);
  assert.equal(self.steered.length, 1);
  assert.equal(self.steered[0].mode, 'queue');
  assert.equal(self.followups.get('m1').state, 'started');
  assert.equal(self.events.filter(event => event.kind === 'followup.started').length, 1);
  assert.equal(self.events.some(event => event.kind === 'steer.accepted'), false);
});

test('a send-now handoff which finds an idle Desktop emits a new-turn receipt', async () => {
  const self = fixture({ code: 'sent', delivery: 'confirmed' });
  const result = await self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true, queueOnly: false });
  assert.equal(result.accepted, true);
  assert.equal(self.followups.get('m1').desktopWindowSent, true);
  assert.equal(self.events.filter(event => event.kind === 'followup.started').length, 1);
  assert.equal(self.events.some(event => event.kind === 'steer.accepted'), false);
});


test('a lost protocol-delete receipt is uncertain and never writes to the window or adds another row', async () => {
  const self = fixture({ code: 'sent', delivery: 'confirmed' });
  self.codex.request = async method => { self.calls.push(method); throw new Error('lost delete receipt'); };
  const result = await self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true });
  assert.equal(result.uncertain, true);
  assert.equal(self.followups.get('m1').state, 'uncertain');
  assert.deepEqual(self.calls, ['thread/queue/delete']);
  assert.equal(self.steered.length, 0);
});

test('two conversations serialize access to the one Desktop window', async () => {
  const self = fixture({ code: 'sent', delivery: 'confirmed' });
  self.followups.items.push({ ...self.followups.items[0], id: 'm2', requestId: 'm2', threadId: 'thread-06', codexQueueId: 'q-2' });
  let release; const entered = [];
  self.codexDesktopSteer.steer = async request => {
    entered.push(request.threadId);
    if (entered.length === 1) await new Promise(resolve => { release = resolve; });
    return { code: 'sent', delivery: 'confirmed' };
  };
  const first = self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true });
  const second = self.steerFollowup('m2', 'phone', 'thread-06', { retainReceipt: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(entered, ['thread-05']);
  assert.deepEqual(self.calls, ['thread/queue/delete']);
  release(); await Promise.all([first, second]);
  assert.deepEqual(entered, ['thread-05', 'thread-06']);
});

test('a Desktop queue cancellation remains visible if removal is not confirmed', async () => {
  const self = fixture({ code: 'queued', delivery: 'confirmed' });
  Object.assign(self.followups.get('m1'), { queueTransport: 'desktop', steerRequested: false });
  self.desktopAdapter.cancel = async () => { throw new Error('not accessible'); };
  self.releaseFollowupAttachments = () => assert.fail('the live queue item must remain');
  const result = await self.cancelFollowup('m1', 'phone', 'thread-05');
  assert.equal(result.cancelled, false);
  assert.equal(self.followups.get('m1').state, 'desktop_queued');
  assert.match(result.reason, /仍可能执行/);
});

test('a queue-only handoff retries the exact retained row without switching to immediate steer', async () => {
  const self = fixture({ code: 'unused', delivery: 'not_sent' });
  self.followups.get('m1').steerRequested = false;
  let attempts = 0;
  self.codexDesktopSteer.steer = async request => {
    assert.equal(request.mode, 'queue'); attempts++;
    return attempts === 1 ? { code: 'composer_unavailable', delivery: 'not_sent' } : { code: 'queued', delivery: 'confirmed' };
  };
  const rpc = self.codex.request;
  self.codex.request = async (method, params) => method === 'thread/queue/list'
    ? { data: [{ id: 'q-2', clientUserMessageId: 'm1' }] } : rpc(method, params);
  self.retryPendingDesktopSettings = async () => {};
  assert.equal((await self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true, queueOnly: true })).deferred, true);
  assert.equal(self.followups.get('m1').windowQueueRequested, true);
  self.followups.update('m1', { steerRetryAt: 0 });
  await self.retryFollowups();
  assert.equal(attempts, 2);
  assert.equal(self.followups.get('m1').queueTransport, 'desktop');
  assert.equal(self.followups.get('m1').windowQueueRequested, false);
  assert.deepEqual(self.calls, ['thread/queue/delete', 'thread/queue/add', 'thread/queue/delete']);
});

test('Windows steer checks recognize current controls without accepting ambiguous rows or unreadable editors', { skip: process.platform !== 'win32' }, () => {
  const logic = path.join(__dirname, '..', 'scripts', 'codex-desktop-steer-logic.ps1').replace(/'/g, "''");
  const script = `
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
. '${logic}'
$yes = @('发送消息？', '你即将发送一条消息。要清除之前已排队的1 条消息吗？', '清空队列', '发送消息')
$no = @('发送消息？', '清空队列', '发送消息')
@{
 queue = @(Get-CodexQueueButtonNames)
 steer = @(Get-CodexSteerButtonNames)
 knownDialog = Test-CodexQueueSendDialog $yes
 unknownDialog = Test-CodexQueueSendDialog $no
 pausedQueue = Test-CodexQueuePaused @('由于你中断了当前响应，队列已暂停')
 normalQueue = Test-CodexQueuePaused @('运行中')
 composerIndex = Get-CodexComposerIndex @('或自行撰写回复', '和 Codex 一起工作')
 ambiguousEditors = Get-CodexComposerIndex @('unknown one', 'unknown two')
 questionAlone = Get-CodexComposerIndex @('或自行撰写回复')
 matchingRow = Test-CodexQueueRow @('引导', 'Please continue with A') 'Please continue with A'
 similarRow = Test-CodexQueueRow @('引导', 'Please continue with B') 'Please continue with A'
 missingEditor = Test-CodexComposerEmpty $false '' 'placeholder'
 emptyEditor = Test-CodexComposerEmpty $true '' 'placeholder'
 draftEditor = Test-CodexComposerEmpty $true 'draft' 'placeholder'
 duplicatedPlaceholder = Test-CodexComposerEmpty $true '和 Codex 一起工作和 …' '和 Codex 一起工作' @('和 Codex 一起工作', '')
 actualPlaceholderDraft = Test-CodexComposerEmpty $true '和 Codex 一起工作' '和 Codex 一起工作' @('和 Codex 一起工作')
 mixedDraft = Test-CodexComposerEmpty $true '和 Codex 一起工作加字' '和 Codex 一起工作' @('和 Codex 一起工作', '')
 placeholderOnly = Test-CodexComposerEmpty $true '和 Codex 一起工作' '和 Codex 一起工作' @('和 Codex 一起工作', '')
 composerSteer = Test-CodexComposerActionButton 1813 976 28 28 1155 848 682 1140 700 720 350
 rowSteer = Test-CodexComposerActionButton 1760 700 28 28 1155 848 682 1140 700 720 350
 narrowComposer = Test-CodexComposerActionButton 1464 870 28 28 805 866 448 764 647 737 259
 questionSend = Test-CodexComposerActionButton 1464 750 28 28 805 866 448 764 647 737 259
 outsideParent = Test-CodexComposerActionButton 1510 870 28 28 805 866 448 764 647 737 259
 invalidParent = Test-CodexComposerActionButton 1464 870 28 28 805 866 448 1000 647 100 259
 emptyButton = Test-CodexComposerActionButton 1464 870 0 28 805 866 448 764 647 737 259
 queueWithSteerOnly = Get-CodexComposerAction 'queue' $false $false $true
 immediateWithSteer = Get-CodexComposerAction 'steer' $false $false $true
 explicitQueue = Get-CodexComposerAction 'queue' $true $false $false
 idleSend = Get-CodexComposerAction 'queue' $false $true $false
} | ConvertTo-Json -Compress
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 15000 });
  const result = JSON.parse(out.trim());
  assert.ok(result.queue.includes('排队'));
  assert.ok(result.steer.includes('引导'));
  assert.equal(result.knownDialog, true);
  assert.equal(result.unknownDialog, false);
  assert.equal(result.pausedQueue, true);
  assert.equal(result.normalQueue, false);
  assert.equal(result.composerIndex, 1);
  assert.equal(result.ambiguousEditors, -1);
  assert.equal(result.questionAlone, -1);
  assert.equal(result.matchingRow, true);
  assert.equal(result.similarRow, false);
  assert.equal(result.missingEditor, false);
  assert.equal(result.emptyEditor, true);
  assert.equal(result.draftEditor, false);
  assert.equal(result.duplicatedPlaceholder, true);
  assert.equal(result.actualPlaceholderDraft, false);
  assert.equal(result.mixedDraft, false);
  assert.equal(result.placeholderOnly, true);
  // 后续消息 = 引导: the composer's own 引导 button, not a queued row's.
  assert.equal(result.composerSteer, true);
  assert.equal(result.rowSteer, false);
  // Actual test-phone reproduction: the question narrows the editor, while the
  // running turn's 引导 button remains at the edge of its wider parent.
  assert.equal(result.narrowComposer, true);
  assert.equal(result.questionSend, false);
  assert.equal(result.outsideParent, false);
  assert.equal(result.invalidParent, false);
  assert.equal(result.emptyButton, false);
  assert.equal(result.queueWithSteerOnly, 'queue_unavailable');
  assert.equal(result.immediateWithSteer, 'steer');
  assert.equal(result.explicitQueue, 'queue');
  assert.equal(result.idleSend, 'send');
});

test('Windows composer waits through stale reads and preserves a complete multiline answer', { skip: process.platform !== 'win32' }, () => {
  const logic = path.join(__dirname, '..', 'scripts', 'codex-desktop-steer-logic.ps1').replace(/'/g, "''");
  const answer = '<send_user_message_question_reply>\n[{"questionItemId":"选项1","question":"想去哪？","answer":"公园"}]\n</send_user_message_question_reply>';
  const encodedAnswer = Buffer.from(answer, 'utf8').toString('base64');
  const script = `
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
. '${logic}'
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedAnswer}'))
$script:reads = 0
$eventually = Wait-CodexComposerWritten { $script:reads++; if ($script:reads -lt 3) { return @{ readable = $true; value = '' } }; return @{ readable = $true; value = ($expected -replace "\x60n", "\x60r\x60n") } } $expected 5 0
$script:changes = 0
$different = Wait-CodexComposerWritten { $script:changes++; return @{ readable = $true; value = 'someone else' } } $expected 2 0
$stopped = Wait-CodexComposerWritten { return @{ identityChanged = $true; readable = $true; value = $expected } } $expected 2 0
$lines = $expected -split "\x60n"
$segments = @($lines[0], '', $lines[1], '', $lines[2])
$viaChildren = Test-CodexComposerWritten '<send…' $expected $segments
$lostLine = Test-CodexComposerWritten '<send…' $expected @($lines[0], '', $lines[1])
$missingBlank = Test-CodexComposerWritten 'corrupt' "甲\x60n\x60n乙" @('甲', '', '乙')
$exactBlank = Test-CodexComposerWritten 'corrupt' "甲\x60n\x60n乙" @('甲', '', '', '乙')
@{ eventually = $eventually; reads = $script:reads; different = $different; changes = $script:changes; stopped = $stopped; partial = Test-CodexComposerWritten $expected.Substring(0, 20) $expected; viaChildren = $viaChildren; lostLine = $lostLine; missingBlank = $missingBlank; exactBlank = $exactBlank } | ConvertTo-Json -Compress
`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 });
  const result = JSON.parse(out.trim());
  assert.equal(result.eventually, true); assert.equal(result.reads, 3);
  assert.equal(result.different, false); assert.equal(result.changes, 2);
  assert.equal(result.stopped, false); assert.equal(result.partial, false);
  assert.equal(result.viaChildren, true); assert.equal(result.lostLine, false);
  assert.equal(result.missingBlank, false); assert.equal(result.exactBlank, true);
});

test('a started receipt during queue withdrawal or window preparation stops the next write', async () => {
  for (const phase of ['withdraw', 'window']) {
    const self = fixture({ code: 'unused' });
    const rpc = self.codex.request;
    self.codex.request = async (method, params) => {
      const result = await rpc(method, params);
      if (phase === 'withdraw' && method === 'thread/queue/delete') self.followups.remove('m1');
      return result;
    };
    self.codexDesktopSteer.steer = async ({ canSubmit }) => {
      assert.equal(phase, 'window');
      assert.equal(canSubmit(), true);
      self.followups.remove('m1');
      assert.equal(canSubmit(), false);
      return { code: 'task_identity_unconfirmed', delivery: 'not_sent' };
    };
    const receipt = await self.steerFollowup('m1', 'phone', 'thread-05', { retainReceipt: true });
    assert.equal(receipt.duplicate, true);
    assert.deepEqual(self.calls, ['thread/queue/delete']);
  }
});

test('a replay arriving during send and after restart reuses the Codex phone request', async t => {
  const fs = require('node:fs');
  const { SendReceipts } = require('../src/send-receipts');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'khlink-codex-receipt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'receipts');
  const self = fixture({ code: 'unused' });
  self.sendReceipts = new SendReceipts(file);
  let release, writes = 0;
  self.command = () => { writes++; return new Promise(resolve => { release = resolve; }); };
  const request = { requestId: 'replay', action: 'turn.start', args: { threadId: 'thread-05', text: '你好' } };
  const { encryptJson, ready } = require('../src/crypto');
  await ready();
  self.config = { accountKey: require('node:crypto').randomBytes(32) };
  self.defaultBackendId = 'codex';
  self.inFlightCommands = new Set();
  self.saveSequence = () => {};
  const frame = JSON.stringify({ id: 'frame', kind: 'command', threadId: 'thread-05', sourceDeviceId: 'phone',
    ...encryptJson(self.config.accountKey, 'command', 'thread-05', 'frame', request) });
  const original = self.onFrame(frame);
  await self.onFrame(frame);
  assert.equal(self.events.at(-1).data.result.uncertain, true);
  assert.equal(self.inFlightCommands.size, 1);
  release({ accepted: true });
  await original;
  self.sendReceipts = new SendReceipts(file);
  await self.onFrame(frame);
  assert.equal(self.events.at(-1).data.result.duplicate, true);
  assert.equal(self.events.at(-1).data.result.accepted, true);
  // The phone may have been disconnected beyond the detailed receipt's retention.
  self.sendReceipts.get('replay').createdAt = Date.now() - 8 * 86400_000;
  self.sendReceipts.begin('another', 'codex', { threadId: 'thread-05', text: '另一条' });
  self.sendReceipts = new SendReceipts(file);
  assert.equal(self.sendReceipts.get('replay'), undefined);
  await self.onFrame(frame);
  assert.equal(self.events.at(-1).data.result.duplicate, true);
  assert.equal(self.events.at(-1).data.result.accepted, true);
  assert.equal(writes, 1);
  assert.equal(self.inFlightCommands.size, 0);
});

test('Windows reads the delivery receipt again immediately before the submit click', { skip: process.platform !== 'win32' }, async t => {
  const fs = require('node:fs');
  const { CodexDesktopSteer } = require('../src/codex-desktop-steer');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'khlink-before-click-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Exercise the actual two-way pipe using the production receipt check, without opening a window.
  const source = fs.readFileSync(path.join(__dirname, '../scripts/codex-desktop-steer.ps1'), 'utf8');
  const check = source.slice(source.indexOf('function Out-Result'), source.indexOf('if ($ThreadId -notmatch'));
  const script = path.join(dir, 'check.ps1');
  fs.writeFileSync(script, [
    'param($ThreadId, $TitleB64, $TextFile, $Mode, [switch]$CheckReceipt)', check,
    'Confirm-RequestPending', 'Confirm-RequestPending', "Out-Result $true 'sent' 'confirmed' 'submitted'",
  ].join('\n'));
  const adapter = new CodexDesktopSteer({ script, tempDir: dir });
  for (const expected of ['already_handled', 'sent']) {
    let checks = 0;
    const result = await adapter.steer({ threadId: 'test', title: 'test', text: 'test',
      canSubmit: () => ++checks === 1 || expected === 'sent' });
    assert.equal(checks, 2);
    assert.equal(result.code, expected);
  }
});
