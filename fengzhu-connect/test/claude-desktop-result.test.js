const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseDesktopResult, ADAPTER_ERRORS } = require('../src/backends/claude-desktop-result');
const { Connector } = require('../src/connector');
const { methods } = require('../src/backends/claude-desktop-sync');

const initFailure = { ok: false, reason: 'adapter_init_failed', delivery: 'not_sent', phase: 'initialize' };

test('missing Claude send assets are reported as not sent before launching PowerShell', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-send-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts'); const bin = path.join(root, 'bin');
  fs.mkdirSync(scripts); fs.mkdirSync(bin);
  const send = path.join(scripts, 'claude-desktop-send.ps1');
  const loader = path.join(scripts, 'claude-desktop-native.ps1');
  const navigation = path.join(scripts, 'claude-desktop-navigation.ps1');
  const native = path.join(bin, 'khlink-claude-desktop-native-v1.dll');
  const owner = { claudeDesktopSendScript: send, claudeDesktopTitle: () => '测试会话',
    execFileFn: () => assert.fail('must not launch an incomplete adapter') };
  for (const missing of [send, loader, native, navigation]) {
    for (const file of [send, loader, native, navigation]) fs.writeFileSync(file, 'fixture');
    fs.unlinkSync(missing);
    const result = await methods.runDesktopSendOnce.call(owner, 'local_test', '你好', '');
    assert.equal(result.ok, false); assert.equal(result.reason, 'adapter_missing'); assert.equal(result.delivery, 'not_sent');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('missing new-task adapter is rejected before opening Claude or creating a draft', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-new-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = { claudeDesktopNewScript: path.join(root, 'missing.ps1'),
    claudeDesktop: { available: () => true, listSessions: () => [] },
    claudeLiveSnapshot: async () => ({ appRunning: true }), config: { workspace: root },
    execFileFn: () => assert.fail('must not launch an incomplete adapter') };
  await assert.rejects(methods.startClaudeDesktopNewSession.call(owner, 'test', { text: '你好' }), error =>
    error.delivery === 'not_sent' && /组件/.test(error.message) && !error.message.includes(root));
});

test('startup failures are proven not sent; timeouts and broken replies remain uncertain', () => {
  assert.deepEqual(parseDesktopResult(null, JSON.stringify(initFailure)), initFailure);
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    assert.equal(parseDesktopResult({ code }, '').delivery, 'not_sent');
  }
  for (const [error, output] of [[{ killed: true }, ''], [{ code: 1 }, ''], [null, 'garbage'], [null, '{}']]) {
    const result = parseDesktopResult(error, output);
    assert.equal(result.delivery, 'uncertain');
    assert.ok(ADAPTER_ERRORS[result.reason]);
  }
  // A valid receipt beats a non-zero exit (the action may already be done).
  assert.deepEqual(parseDesktopResult({ code: 1 }, '{"ok":true,"reason":null}\r\n'), { ok: true, reason: null });
});

test('raw PowerShell exceptions never expose local paths or prompts to phones', () => {
  const raw = 'Command failed: powershell.exe -TextFile C:\\private\\prompt.txt\nAdd-Type: client does not hold a required privilege';
  const result = parseDesktopResult(new Error(raw), '');
  assert.equal(result.reason, 'adapter_failed');
  assert.doesNotMatch(JSON.stringify(result), /private|prompt\.txt|powershell|Add-Type/);
  assert.equal(parseDesktopResult(null, JSON.stringify({ ok: false, reason: raw })).reason, 'adapter_failed');
});

function sender(result) {
  const owner = Object.create(Connector.prototype);
  owner.claudeThreads = new Map([['test-chat', { desktopId: 'local_test', sessionId: 'cli-test' }]]);
  owner.desktopShouldTakeClaudeSession = async () => true;
  owner.claudeAttachmentParts = () => ({ text: 'test only', imagePaths: [] });
  owner.claudeDesktop = { focusedSessionId: () => 'local_test' };
  owner.log = () => {};
  owner.send = () => {};
  owner.runDesktopSend = async () => result;
  return owner;
}

test('a failed init reaches the phone as failed, not the repeated needs-confirmation warning', async () => {
  const owner = sender(initFailure);
  const payload = { action: 'turn.start', requestId: 'init-failure', args: { threadId: 'test-chat', text: 'test only' } };
  const result = await owner.deliverOnce(payload, () => owner.deliverClaudeToDesktop('test-chat', payload.args));
  assert.equal(result.failed, true);
  assert.equal(result.uncertain, false);
  assert.match(result.reason || result.item?.reason || '', /初始化失败/);
  const duplicate = await owner.deliverOnce(payload, () => assert.fail('must not replay the same request'));
  assert.equal(duplicate.failed, true);
});

test('missing assets reach the phone as not sent and do not replay the request', async () => {
  const owner = sender({ ok: false, reason: 'adapter_missing', delivery: 'not_sent' });
  const payload = { action: 'turn.start', requestId: 'missing-assets', args: { threadId: 'test-chat', text: 'test only' } };
  const result = await owner.deliverOnce(payload, () => owner.deliverClaudeToDesktop('test-chat', payload.args));
  assert.equal(result.failed, true);
  assert.equal(result.uncertain, false);
  assert.match(result.reason || result.item?.reason || '', /组件缺失.*没有发出/);
  const duplicate = await owner.deliverOnce(payload, () => assert.fail('must not replay the same request'));
  assert.equal(duplicate.failed, true);
});

test('an unknown desktop failure does not retry or report a definite pre-send failure', async () => {
  const owner = sender(parseDesktopResult({ killed: true }, ''));
  await assert.rejects(owner.deliverClaudeToDesktop('test-chat', {}), error => error.delivery === 'uncertain');
  let count = 0;
  const result = await methods.runDesktopSend.call({ runDesktopSendOnce: async () => {
    count++; return { ok: false, reason: 'TypeInitializationException after a window changed' };
  } }, 'local_test', 'test', '');
  assert.equal(count, 1);
  assert.equal(result.ok, false);
});

test('new-task startup failure is sanitized while a new-task timeout stays uncertain', async () => {
  for (const [error, stdout, delivery] of [
    [null, JSON.stringify(initFailure), 'not_sent'],
    [{ killed: true, message: 'C:\\private\\prompt.txt' }, '', 'uncertain'],
  ]) {
    const owner = {
      claudeDesktop: { available: () => true, listSessions: () => [], focusedSessionId: () => '' },
      claudeLiveSnapshot: async () => ({ appRunning: true }),
      config: { workspace: os.tmpdir() }, log() {},
      execFileFn: (exe, args, options, callback) => callback(error, stdout),
    };
    await assert.rejects(methods.startClaudeDesktopNewSession.call(owner, 'new-test', { text: 'test' }), failure => {
      assert.equal(failure.delivery, delivery);
      assert.doesNotMatch(failure.message, /private|prompt\.txt|powershell/);
      return true;
    });
  }
});

test('packaged native interop loads without invoking C# compilation', { skip: process.platform !== 'win32' }, () => {
  const root = path.join(__dirname, '..');
  const loader = path.join(root, 'scripts', 'claude-desktop-native.ps1');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `. '${loader.replace(/'/g, "''")}'; if (-not (Initialize-KhClaudeDesktopNative)) { throw 'init failed' }; [KhClaudeNative].GetMethods() | Where-Object Name -eq 'IsIconic' | ForEach-Object { $_.Name }`],
  { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  assert.equal(output.trim(), 'IsIconic');
  // Distribution contract: npm's allowlist must actually include the helper.
  assert.ok(require('../package.json').files.includes('bin/khlink-claude-desktop-native-v1.dll'));
});

test('missing native helper exits before any desktop action with a structured startup failure', { skip: process.platform !== 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-native-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const loader = path.join(dir, 'claude-desktop-native.ps1');
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'claude-desktop-native.ps1'), loader);
  // Run each real entry point from an incomplete package. It must stop before
  // reading inputs, deep-link navigation, foreground changes, or Send.
  for (const name of ['claude-desktop-send.ps1', 'claude-desktop-new.ps1', 'claude-desktop-answer.ps1']) {
    const script = path.join(dir, name);
    fs.copyFileSync(path.join(__dirname, '..', 'scripts', name), script);
    const args = name === 'claude-desktop-new.ps1' ? ['-TextFile', 'does-not-exist.txt'] : ['-SessionId', 'local_00000000-0000-4000-8000-000000000001'];
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
    assert.deepEqual(parseDesktopResult(null, output), initFailure);
  }
});

for (const scenario of ['tooltip', 'minimized', 'ambiguous', 'unofficial']) {
  test(`desktop window selection: ${scenario}`, { skip: process.platform !== 'win32' }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-window-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fixture = path.join(dir, 'fixture.json');
    const main = { Current: { Name: 'Claude', ProcessId: 42, NativeWindowHandle: 100, IsOffscreen: scenario === 'minimized' } };
    const windows = [{ Current: { Name: '', ProcessId: 42, NativeWindowHandle: 200 } }, main];
    if (scenario === 'ambiguous') windows.push({ Current: { ...main.Current, NativeWindowHandle: 300 } });
    fs.writeFileSync(fixture, JSON.stringify({ windows, processes: [{ Id: 42, MainWindowHandle: 200,
      Path: scenario === 'unofficial' ? 'G:\\npm\\claude.exe' : 'C:\\Program Files\\WindowsApps\\Claude_2.42304\\app\\claude.exe' }] }));
    const value = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'fixtures', 'claude-window-harness.ps1'), '-Source',
      path.join(__dirname, '..', 'scripts', 'claude-desktop-native.ps1'), '-Fixture', fixture],
    { windowsHide: true, encoding: 'utf8', timeout: 15_000 }).trim());
    if (['tooltip', 'minimized'].includes(scenario)) assert.deepEqual(value, { pid: 42, handle: 100 });
    else assert.equal(value, null, 'ambiguous or unofficial windows cannot receive input');
  });
}

test('a send names the target session so the script never writes into the New session page', async () => {
  const calls = [];
  const owner = Object.create(Connector.prototype);
  owner.claudeThreads = new Map([['test-chat', { desktopId: 'local_test', title: '-明天 杭州天气' }]]);
  owner.claudeDesktop = { listSessions: () => [] };
  owner.execFileFn = (_file, args, _options, done) => { calls.push(args); done(null, '{"ok":true}'); };
  await owner.runDesktopSendOnce('local_test', 'hi', '');
  await owner.runDesktopSendOnce('local_test', '', '', { mode: 'interrupt' });
  const title = calls[0][calls[0].indexOf('-TitleB64') + 1];
  assert.equal(Buffer.from(title, 'base64').toString('utf8'), '-明天 杭州天气');
  assert.equal(calls[1].includes('-TitleB64'), false);
  // The desktop's own current title wins over an older copy.
  owner.claudeDesktop = { listSessions: () => [{ desktopId: 'local_test', title: '杭州天气' }] };
  assert.equal(owner.claudeDesktopTitle('local_test'), '杭州天气');
});

test('a session the window did not open is reported as not sent, in Chinese', async () => {
  const owner = sender({ ok: false, reason: 'session_not_shown' });
  await assert.rejects(owner.deliverClaudeToDesktop('test-chat', {}),
    (error) => error.delivery === 'not_sent' && error.message === '电脑端 Claude 没能打开这个会话，消息没有发出，请稍后重试。');
});
