'use strict';
// Hermes's own Windows install: programs started directly, files on this computer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HermesTransport } = require('../src/backends/hermes-transport');
const { mediaPaths, methods } = require('../src/backends/hermes-sync');

const config = {
  transport: 'windows', home: 'C:\\Users\\alice\\AppData\\Local\\hermes',
  hermesBin: 'C:\\h\\hermes.exe', python: 'C:\\h\\python.exe',
};

function fakeSpawn(calls, stdout = '{"sessions":[]}') {
  return (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let input = '';
    child.stdin = { end(data) { if (data) input = String(data); setImmediate(() => { child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', 0); }); } };
    child.kill = () => {};
    calls.push({ file, args, env: options.env, input: () => input });
    return child;
  };
}

test('Hermes on Windows runs its own programs with its home, no shell', async () => {
  const calls = [];
  const transport = new HermesTransport(config, { spawnFn: fakeSpawn(calls) });
  assert.equal(transport.windows, true);
  transport.spawnAcp();
  assert.equal(calls[0].file, config.hermesBin);
  assert.deepEqual(calls[0].args, ['acp']);
  assert.equal(calls[0].env.HERMES_HOME, config.home);
  assert.equal(calls[0].env.PYTHONIOENCODING, 'utf-8');
  assert.deepEqual(await transport.store('messages', 's1', '0', '400'), { sessions: [] });
  assert.equal(calls[1].file, config.python);
  assert.deepEqual(calls[1].args, ['-', 'messages', 's1', '0', '400']);
  assert.match(calls[1].input(), /hermes|HERMES_HOME/);
  await transport.hermes(['sessions', 'rename', 's1', '新的 名字']);
  assert.deepEqual([calls[2].file, calls[2].args], [config.hermesBin, ['sessions', 'rename', 's1', '新的 名字']]);
  await assert.rejects(transport.run('printf %s "$HOME"'), /不经 shell/);
  assert.equal(await transport.homeDir(), os.homedir());
});

test('Hermes on Windows reads and writes its files here, with Windows paths', async () => {
  const transport = new HermesTransport(config, { spawnFn: fakeSpawn([]) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-hermes-win-'));
  const file = path.join(dir, 'sub', 'a.png');
  assert.equal(await transport.writeFile(file, Buffer.from('png')), file);
  assert.equal((await transport.readFile(file)).toString(), 'png');
  await assert.rejects(transport.readFile(path.join(dir, 'missing.png')), /读不到/);
  await assert.rejects(transport.readFile(file, 1), /过大/);
  assert.ok(transport.uploadPath('x.png').startsWith(path.join(os.tmpdir(), 'khlink-uploads')));
  for (const yes of ['C:\\work', 'd:/work', '\\\\nas\\share']) assert.equal(transport.isAbsolute(yes), true, yes);
  for (const no of ['/home/u', 'work', '~/work', '']) assert.equal(transport.isAbsolute(no), false, no);
  assert.equal(transport.pathLib.basename('C:\\Users\\alice\\chart.png'), 'chart.png');
});

test('files Hermes names on Windows are picked up from its replies', () => {
  assert.deepEqual(mediaPaths('已保存到 C:\\Users\\alice\\Desktop\\chart.png 和 D:/out/report.pdf。', { windows: true }),
    ['C:\\Users\\alice\\Desktop\\chart.png', 'D:/out/report.pdf']);
  assert.deepEqual(mediaPaths('已保存到 C:\\Users\\alice\\chart.png', { windows: false }), []);
  assert.deepEqual(mediaPaths('saved /home/u/a.png'), ['/home/u/a.png']);
});

test('a new Hermes task on Windows keeps a Windows folder and starts in the user home otherwise', async () => {
  const self = { ...methods, hermesTransport: new HermesTransport(config, { spawnFn: fakeSpawn([]) }) };
  assert.equal(await self.hermesDefaultCwd(), os.homedir());
});

test('Hermes settings read answers the model at the top level too, where the phone looks', async () => {
  const sessionModels = new Map([['s1', 'custom:khsci.vip:claude-sonnet-4-6']]);
  const self = {
    ...methods, hermesOnline: true,
    hermesThreads: new Map([['hermes-s1', { sessionId: 's1', cwd: 'C:\work' }]]),
    hermesAcp: {
      attach: async () => null, sessionModels,
      models: { currentModelId: 'custom:gemini-3.8-flash-high', availableModels: [{ modelId: 'custom:khsci.vip:claude-sonnet-4-6', name: 'Claude Sonnet' }] },
    },
  };
  const read = await self.hermesCommand({ action: 'thread.settings.read', args: { threadId: 'hermes-s1' } });
  assert.equal(read.settings.model, 'custom/khsci.vip:claude-sonnet-4-6');
  assert.equal(read.model, read.settings.model);
});

test('a session Hermes ACP cannot resume is recognised from the provenance it answers with', async () => {
  const { HermesAcp } = require('../src/backends/hermes-acp');
  const acp = new HermesAcp({});
  acp.start = async () => {};
  const answers = {
    'desktop-1': { models: null, _meta: { hermes: { sessionProvenance: { acpSessionId: 'new-empty-session' } } } },
    'phone-1': { models: null, _meta: { hermes: { sessionProvenance: { acpSessionId: 'phone-1' } } } },
    'older-hermes': { models: null },
  };
  acp._request = async (method, params) => answers[params.sessionId];
  for (const id of Object.keys(answers)) await acp.attach(id, 'C:\work');
  assert.equal(acp.resumable('desktop-1'), false);
  assert.equal(acp.resumable('phone-1'), true);
  assert.equal(acp.resumable('older-hermes'), true, 'no provenance: assume it resumed');
  // Not resumed again (each try leaves one more empty session in Hermes), even on a new child.
  let asked = 0; acp._request = async () => { asked++; return {}; }; acp.attached.clear();
  assert.equal(await acp.attach('desktop-1', 'C:\\work'), null);
  assert.equal(asked, 0);
});

function cliContext(stored) {
  const uploads = []; const spawned = [];
  const self = {
    ...methods, hermesOnline: true, hermesRunning: new Map(), log() {},
    hermesThreads: new Map([['hermes-d1', { sessionId: 'd1', cwd: 'C:\work', syncedMessageId: 10 }]]),
    hermesAcp: { attach: async () => null, resumable: (id) => id !== 'd1', prompt: async () => { throw new Error('ACP must not be used'); } },
    hermesTransport: {
      spawnHermes(args, options) {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.killed = true; };
        spawned.push({ args, options, child }); return child;
      },
      store: async () => ({ messages: stored() }),
    },
    hermesPromptBlocks: async (args) => [{ type: 'text', text: args.text }],
    pollHermes: async () => {}, announceHermesStatus() {}, emit() {}, saveHermesThreads() {}, watchHermesTurn() {}, nudgeHermes() {},
    queueHermesLive: async (id, task) => task(), uploadHermesItems: async (id, items) => { uploads.push(...items); },
  };
  return { self, uploads, spawned };
}

test('a turn to such a session goes through `hermes chat -Q -q --resume`, and a missing reply is explained', async () => {
  let rows = [];
  const { self, uploads, spawned } = cliContext(() => rows);
  const started = await self.hermesCommand({ action: 'turn.start', args: { threadId: 'hermes-d1', text: '你好' } });
  assert.equal(started.accepted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(self.hermesThreads.get('hermes-d1').cliOnly, true, 'remembered for later turns');
  assert.deepEqual(spawned[0].args, ['chat', '-Q', '-q', '你好', '--resume', 'd1']);
  assert.equal(spawned[0].options.cwd, 'C:\work');
  assert.ok(self.hermesRunning.get('d1')?.cli, 'running while the process lives');
  await assert.rejects(self.hermesCommand({ action: 'turn.start', args: { threadId: 'hermes-d1', text: '再来' } }), /还在电脑上的 Hermes 里运行/);
  // Hermes answered and stored it: nothing added.
  rows = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好！' }];
  spawned[0].child.stdout.emit('data', Buffer.from('你好！\n')); spawned[0].child.emit('close', 0);
  await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(self.hermesRunning.has('d1'), false);
  assert.equal(uploads.length, 0);
  // Next turn fails at the API: the phone is told why.
  rows = [];
  await self.hermesCommand({ action: 'turn.start', args: { threadId: 'hermes-d1', text: '在吗' } });
  await new Promise((resolve) => setImmediate(resolve));
  spawned[1].child.stdout.emit('data', Buffer.from('↻ Resumed session d1 (1 user message)\n\nsession_id: d1\nAPI call failed after 1 retries: HTTP 429: Resource has been exhausted\n'));
  spawned[1].child.emit('close', 0);
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].value.text, /^Hermes 没有回复：API call failed after 1 retries: HTTP 429/);
  // Images cannot go this way.
  self.hermesPromptBlocks = async () => [{ type: 'text', text: '看图' }, { type: 'image', data: 'x', mimeType: 'image/png' }];
  await assert.rejects(self.hermesCommand({ action: 'turn.start', args: { threadId: 'hermes-d1', text: '看图' } }), /只能从手机给它发文字/);
});

test('stop ends a CLI turn', async () => {
  const { self, spawned } = cliContext(() => []);
  await self.hermesCommand({ action: 'turn.start', args: { threadId: 'hermes-d1', text: '写一首长诗' } });
  await new Promise((resolve) => setImmediate(resolve));
  spawned[0].child.pid = undefined;
  const stopped = await self.hermesCommand({ action: 'turn.stop', args: { threadId: 'hermes-d1' } });
  assert.equal(stopped.stopped, true);
  assert.equal(self.hermesRunning.get('d1').stopped, true);
  assert.equal(spawned[0].child.killed, true);
});
