const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ClaudeBackend, CLAUDE_CAPABILITIES, toolItemType, cleanEnv, buildContent } = require('../src/backends/claude-backend');

// A fake `claude` process: captures stdin JSON, lets tests push stdout events.
function makeFakeSpawn() {
  const spawns = [];
  const spawnFn = (bin, args, opts) => {
    const stdout = new EventEmitter(); stdout.setEncoding = () => {};
    const stderr = new EventEmitter(); stderr.setEncoding = () => {};
    const writes = [];
    const child = new EventEmitter();
    child.exitCode = null; child.killed = false;
    child.stdout = stdout; child.stderr = stderr;
    child.stdin = { write: (s) => writes.push(JSON.parse(s.trim())) };
    child.kill = () => { child.killed = true; child.exitCode = 143; child.emit('exit', 143); };
    child.emitLine = (obj) => stdout.emit('data', JSON.stringify(obj) + '\n');
    child.writes = writes;
    spawns.push({ bin, args, opts, child });
    return child;
  };
  return { spawnFn, spawns };
}

function backend(extra = {}) {
  const { spawnFn, spawns } = makeFakeSpawn();
  const be = new ClaudeBackend({ workspace: 'C:\\work' }, { spawnFn, claudeBin: 'claude.exe', ...extra });
  const events = [];
  for (const e of ['item', 'status', 'approval', 'question', 'error', 'turnComplete']) be.on(e, (p) => events.push({ e, ...p }));
  return { be, spawns, events };
}

test('capabilities: Claude has permission modes but no Codex-only features', () => {
  assert.deepEqual(CLAUDE_CAPABILITIES.permissionModes, ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'], 'same modes as the desktop app');
  assert.equal(CLAUDE_CAPABILITIES.threadQueue, false);
  assert.equal(CLAUDE_CAPABILITIES.desktopAutomation, false);
  assert.equal(CLAUDE_CAPABILITIES.compact, true);
});

test('tool names map to the connector item vocabulary', () => {
  assert.equal(toolItemType('Bash'), 'commandExecution');
  assert.equal(toolItemType('Edit'), 'fileChange');
  assert.equal(toolItemType('Write'), 'fileChange');
  assert.equal(toolItemType('TodoWrite'), 'plan');
  assert.equal(toolItemType('WebFetch'), 'webSearch');
  assert.equal(toolItemType('mcp__kh_link__x'), 'mcpToolCall');
  assert.equal(toolItemType('Read'), 'mcpToolCall');
});

test('cleanEnv strips CLAUDE*/ANTHROPIC* (never borrow desktop auth)', () => {
  const env = cleanEnv({ PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'sk', ANTHROPIC_API_KEY: 'k', HOME: 'h' });
  assert.deepEqual(env, { PATH: 'x', HOME: 'h' });
});

test('startTurn spawns stream-json with manual approval and writes the user message', () => {
  const { be, spawns, events } = backend();
  const { threadId } = be.newThread({ workdir: 'C:\\proj' });
  be.startTurn(threadId, { text: 'hello' });
  const s = spawns[0];
  assert.equal(s.bin, 'claude.exe');
  assert.ok(s.args.includes('--input-format') && s.args.includes('stream-json'));
  assert.ok(s.args.includes('--permission-prompt-tool') && s.args.includes('stdio'));
  assert.ok(!s.args.includes('--resume'));
  assert.equal(s.opts.cwd, 'C:\\proj');
  // Child env must not carry any CLAUDE*/ANTHROPIC* var.
  assert.ok(!Object.keys(s.opts.env).some((k) => /^(CLAUDE|ANTHROPIC)/i.test(k)));
  assert.deepEqual(s.child.writes[0], { type: 'user', message: { role: 'user', content: 'hello' } });
  assert.ok(events.some((e) => e.e === 'status' && e.status === 'running'));
});

test('yolo mode uses bypassPermissions instead of the stdio prompt tool', () => {
  const { be, spawns } = backend();
  const { threadId } = be.newThread({ approveMode: 'yolo' });
  be.startTurn(threadId, { text: 'go' });
  assert.ok(spawns[0].args.includes('--permission-mode') && spawns[0].args.includes('bypassPermissions'));
  assert.ok(!spawns[0].args.includes('--permission-prompt-tool'));
});

test('assistant blocks map to items; result completes the turn', () => {
  const { be, spawns, events } = backend();
  const { threadId } = be.newThread();
  be.startTurn(threadId, { text: 'hi' });
  const c = spawns[0].child;
  c.emitLine({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  c.emitLine({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }] } });
  c.emitLine({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } });
  c.emitLine({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 5 }, total_cost_usd: 0.01 });
  const items = events.filter((e) => e.e === 'item').map((e) => e.item);
  assert.deepEqual(items.map((i) => i.type), ['reasoning', 'agentMessage', 'commandExecution']);
  assert.equal(items[2].tool, 'Bash');
  const done = events.find((e) => e.e === 'turnComplete');
  assert.equal(done.sessionId, 'sess-1');
  assert.ok(events.some((e) => e.e === 'status' && e.status === 'completed'));
});

test('after the process exits, the next turn resumes the captured session id', () => {
  const { be, spawns } = backend();
  const { threadId } = be.newThread();
  be.startTurn(threadId, { text: 'one' });
  spawns[0].child.emitLine({ type: 'system', subtype: 'init', session_id: 'sess-9' });
  spawns[0].child.emitLine({ type: 'result', subtype: 'success' });
  spawns[0].child.exitCode = 0; spawns[0].child.emit('exit', 0); // idle process exits
  be.startTurn(threadId, { text: 'two' });
  assert.equal(spawns.length, 2, 'a fresh process is spawned after exit');
  const resumeIdx = spawns[1].args.indexOf('--resume');
  assert.ok(resumeIdx >= 0 && spawns[1].args[resumeIdx + 1] === 'sess-9');
});

test('a live process handles a second turn without respawning', () => {
  const { be, spawns } = backend();
  const { threadId } = be.newThread();
  be.startTurn(threadId, { text: 'one' });
  spawns[0].child.emitLine({ type: 'system', subtype: 'init', session_id: 'sess-9' });
  spawns[0].child.emitLine({ type: 'result', subtype: 'success' });
  be.startTurn(threadId, { text: 'two' });
  assert.equal(spawns.length, 1, 'same live process reused');
  assert.equal(spawns[0].child.writes.filter((w) => w.type === 'user').length, 2);
});

test('approval flow: request -> resolve allow writes control_response', () => {
  const { be, spawns, events } = backend();
  const { threadId } = be.newThread();
  be.startTurn(threadId, { text: 'run' });
  const c = spawns[0].child;
  c.emitLine({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm x' } } });
  const ap = events.find((e) => e.e === 'approval');
  assert.equal(ap.requestId, 'r1');
  assert.equal(ap.tool, 'Bash');
  assert.equal(ap.summary, 'rm x');
  assert.equal(be.resolveApproval(threadId, 'r1', true), true);
  const resp = c.writes.find((w) => w.type === 'control_response');
  assert.equal(resp.response.response.behavior, 'allow');
  assert.deepEqual(resp.response.response.updatedInput, { command: 'rm x' });
  // A second resolve for the same id is a no-op.
  assert.equal(be.resolveApproval(threadId, 'r1', true), false);
});

test('deny writes a deny control_response', () => {
  const { be, spawns } = backend();
  const { threadId } = be.newThread();
  be.startTurn(threadId, { text: 'run' });
  const c = spawns[0].child;
  c.emitLine({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  be.resolveApproval(threadId, 'r2', false);
  const resp = c.writes.find((w) => w.type === 'control_response');
  assert.equal(resp.response.response.behavior, 'deny');
});

test('AskUserQuestion surfaces a question and answerQuestion replies', () => {
  const { be, spawns, events } = backend();
  const { threadId } = be.newThread();
  be.startTurn(threadId, { text: 'ask me' });
  const c = spawns[0].child;
  const questions = [{ question: '红还是蓝?', options: [{ label: '红' }, { label: '蓝' }] }];
  c.emitLine({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } } });
  const q = events.find((e) => e.e === 'question');
  assert.deepEqual(q.questions, questions);
  be.answerQuestion(threadId, 'q1', { '红还是蓝?': '蓝' });
  const resp = c.writes.find((w) => w.type === 'control_response');
  assert.deepEqual(resp.response.response.updatedInput.answers, { '红还是蓝?': '蓝' });
});

test('interruptTurn writes an interrupt control_request', () => {
  const { be, spawns } = backend();
  const { threadId } = be.newThread();
  be.startTurn(threadId, { text: 'long' });
  assert.equal(be.interruptTurn(threadId), true);
  const req = spawns[0].child.writes.find((w) => w.type === 'control_request' && w.request?.subtype === 'interrupt');
  assert.ok(req);
});

test('image input builds a base64 content array', () => {
  const { be, spawns } = backend();
  const { threadId } = be.newThread();
  be.startTurn(threadId, { text: '什么颜色', images: [{ mediaType: 'image/png', data: 'AAAA' }] });
  const msg = spawns[0].child.writes[0].message.content;
  assert.equal(msg[0].type, 'image');
  assert.equal(msg[0].source.data, 'AAAA');
  assert.equal(msg[1].text, '什么颜色');
});

test('a crash mid-turn emits failed status and an error', () => {
  const { be, spawns, events } = backend();
  const { threadId } = be.newThread();
  be.startTurn(threadId, { text: 'boom' });
  spawns[0].child.exitCode = 1;
  spawns[0].child.emit('exit', 1);
  assert.ok(events.some((e) => e.e === 'status' && e.status === 'failed'));
  assert.ok(events.some((e) => e.e === 'error' && e.terminal));
});

test('buildContent returns a plain string when there are no images', () => {
  assert.equal(buildContent('hi', []), 'hi');
  assert.equal(buildContent('hi'), 'hi');
});

test('effort and model are passed as launch flags; invalid values are dropped', () => {
  const { be, spawns } = backend();
  const { threadId } = be.newThread({ model: 'opus', effort: 'xhigh' });
  be.startTurn(threadId, { text: 'hi' });
  const a = spawns[0].args;
  assert.equal(a[a.indexOf('--model') + 1], 'opus');
  assert.equal(a[a.indexOf('--effort') + 1], 'xhigh');
  const bad = be.newThread({ model: 'opus --dangerously-skip-permissions', effort: 'turbo' });
  be.startTurn(bad.threadId, { text: 'x' });
  assert.ok(!spawns[1].args.includes('--model'), 'model with spaces is rejected');
  assert.ok(!spawns[1].args.includes('--effort'), 'unknown effort is rejected');
});

test('changing settings on an idle live process respawns it with --resume and new flags', () => {
  const { be, spawns } = backend();
  const { threadId } = be.newThread({ model: 'sonnet' });
  be.startTurn(threadId, { text: 'one' });
  spawns[0].child.emitLine({ type: 'system', subtype: 'init', session_id: 'sess-5' });
  spawns[0].child.emitLine({ type: 'result', subtype: 'success' });
  be.updateSettings(threadId, { model: 'opus', effort: 'high' });
  be.startTurn(threadId, { text: 'two' });
  assert.equal(spawns.length, 2, 'process restarted for new flags');
  assert.ok(spawns[0].child.killed);
  const a = spawns[1].args;
  assert.equal(a[a.indexOf('--model') + 1], 'opus');
  assert.equal(a[a.indexOf('--effort') + 1], 'high');
  assert.equal(a[a.indexOf('--resume') + 1], 'sess-5');
  // The killed old process must not flip the new turn to failed.
  assert.equal(be.sessions.get(threadId).status, 'running');
});

test('unchanged settings keep reusing the live process', () => {
  const { be, spawns } = backend();
  const { threadId } = be.newThread({ model: 'sonnet', effort: 'low' });
  be.startTurn(threadId, { text: 'one' });
  spawns[0].child.emitLine({ type: 'result', subtype: 'success' });
  be.updateSettings(threadId, { model: 'sonnet', effort: 'low' });
  be.startTurn(threadId, { text: 'two' });
  assert.equal(spawns.length, 1);
});

test('adoptThread re-attaches a persisted thread and resumes its session', () => {
  const { be, spawns } = backend();
  be.adoptThread({ threadId: 'persisted-1', workdir: 'C:\p', sessionId: 'sess-old', model: 'haiku', effort: 'medium' });
  assert.equal(be.hasThread('persisted-1'), true);
  be.startTurn('persisted-1', { text: 'continue' });
  const a = spawns[0].args;
  assert.equal(a[a.indexOf('--resume') + 1], 'sess-old');
  assert.equal(a[a.indexOf('--effort') + 1], 'medium');
  assert.equal(spawns[0].opts.cwd, 'C:\p');
});

test('claude.exe is looked up again before each start (the desktop app updates it in place)', () => {
  const { be, spawns } = backend({ claudeBin: 'C:/old/2.1.281/claude.exe' });
  be.resolveBin = () => ({ bin: 'C:/new/2.1.280/claude.exe', version: '2.1.280' });
  const { threadId } = be.newThread({ workdir: 'C:\\work' });
  be.startTurn(threadId, { text: 'hi' });
  assert.equal(spawns[0].bin, 'C:/new/2.1.280/claude.exe');
});

test('the command line saying it is not logged in reaches the phone as what to do, in Chinese', () => {
  const { cliErrorText } = require('../src/backends/claude-backend');
  assert.match(cliErrorText('Not logged in · Please run /login'), /打开 Claude 桌面版/);
  assert.equal(cliErrorText('API Error: 529 overloaded'), 'API Error: 529 overloaded');
});
