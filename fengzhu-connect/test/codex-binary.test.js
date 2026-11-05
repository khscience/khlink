const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findCodexBinary } = require('../src/codex-client');
const { Connector } = require('../src/connector');
const { STREAM_VERSION } = require('../src/codex-host');

function fakeInstalls() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-codex-bin-'));
  const bin = path.join(root, 'OpenAI', 'Codex', 'bin');
  const make = (dir, date) => {
    const exe = path.join(bin, dir, 'codex.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, '');
    fs.utimesSync(exe, date, date); return exe;
  };
  // Hash-named folders: the alphabetically last one is the oldest build.
  const older = make('faa963e871dd422c', new Date('2026-09-27T01:04:00Z'));
  const newer = make('c6fe824d725f02d7', new Date('2026-09-30T11:09:00Z'));
  fs.mkdirSync(path.join(bin, '5b9024f90663758b')); // an emptied old install
  return { root, older, newer };
}

async function withEnv(values, fn) {
  const saved = {}; for (const key of Object.keys(values)) { saved[key] = process.env[key]; process.env[key] = values[key]; }
  try { return await fn(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('picks the newest desktop codex.exe, not the alphabetically last folder', async () => {
  const { root, newer } = fakeInstalls();
  try {
    await withEnv({ LOCALAPPDATA: root, ProgramFiles: path.join(root, 'none'), USERPROFILE: path.join(root, 'home') }, () => {
      assert.equal(findCodexBinary(), newer);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an idle host on an older codex build is recycled onto the desktop\'s build', async () => {
  const { root, older, newer } = fakeInstalls();
  try {
    await withEnv({ LOCALAPPDATA: root, ProgramFiles: path.join(root, 'none'), USERPROFILE: path.join(root, 'home') }, async () => {
      const connector = Object.create(Connector.prototype);
      connector.config = { configFile: path.join(root, 'config.json'), codexBin: null };
      connector.codex = { mode: 'host', ready: true };
      connector.log = () => {};
      connector.defaultModelId = 'old-default';
      let recycled = 0; let busy = true;
      connector.recycleIdleCodexHost = async () => { recycled += 1; return true; };
      connector.hasActiveMobileWork = () => busy;
      fs.writeFileSync(path.join(root, 'codex-host.json'), JSON.stringify({ bin: older, streamVersion: STREAM_VERSION }));
      assert.equal(await connector.followDesktopCodex(), false, 'a mobile turn is running');
      busy = false;
      assert.equal(await connector.followDesktopCodex(), true);
      assert.equal(connector.defaultModelId, null, 'the default model is read again');
      fs.writeFileSync(path.join(root, 'codex-host.json'), JSON.stringify({ bin: newer, streamVersion: STREAM_VERSION }));
      assert.equal(await connector.followDesktopCodex(), false, 'already on the newest build');
      assert.equal(recycled, 1);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no Codex anywhere: resolve reports none and the client fails at once', async () => {
  const { resolveCodexBinary, CodexClient } = require('../src/codex-client');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-codex-none-'));
  try {
    await withEnv({ LOCALAPPDATA: root, ProgramFiles: path.join(root, 'none'), USERPROFILE: path.join(root, 'home'), PATH: path.join(root, 'empty') }, async () => {
      assert.equal(resolveCodexBinary(), null);
      assert.equal(findCodexBinary(), 'codex', 'old callers keep their fallback name');
      const client = new CodexClient({ configFile: path.join(root, 'config.json'), workspace: root, useCodexHost: true });
      const started = Date.now();
      await assert.rejects(client.start(), (error) => error.code === 'CODEX_NOT_INSTALLED');
      assert(Date.now() - started < 2000, 'no 90-second host retry loop');
      // A codex on PATH counts as installed.
      fs.mkdirSync(path.join(root, 'empty'), { recursive: true });
      const onPath = path.join(root, 'empty', process.platform === 'win32' ? 'codex.cmd' : 'codex');
      fs.writeFileSync(onPath, '');
      assert.equal(resolveCodexBinary(), 'codex');
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('connector starts the other agents without Codex and picks it up once installed', async () => {
  const connector = Object.create(Connector.prototype);
  const logs = [];
  let started = 0; let recovered = 0;
  connector.config = { configFile: path.join(os.tmpdir(), 'kh-none', 'config.json'), codexBin: null };
  connector.processLock = { acquire() {}, release() { throw new Error('must not release'); } };
  connector.codex = { ready: false, start: async () => { throw Object.assign(new Error('这台电脑没有安装 Codex'), { code: 'CODEX_NOT_INSTALLED' }); } };
  connector.log = (message) => logs.push(String(message));
  // Everything after the Codex step is stubbed: reaching it is the point.
  connector.writeStatus = () => {};
  connector.cleanUploads = () => { started += 1; };
  connector.attachmentStore = { clean() {} };
  for (const name of ['connect', 'startStallWatch', 'startCodexUsageWatch', 'startRealtimeSync', 'startSessionWatcher', 'startAgentAvailabilityWatch', 'wireClaudeBackend', 'startPiSync', 'startDshSync', 'startHermesSync', 'startAntigravitySync', 'startClaudeStatusline', 'retryFollowups', 'provisionPhoneKeys']) connector[name] = async () => {};
  connector.codex.on = () => {};
  connector.watchCodexInstall = Connector.prototype.watchCodexInstall;
  connector.recoverCodex = async () => { recovered += 1; return true; };
  await connector.start();
  assert.equal(started, 1, 'startup went on past Codex');
  assert.equal(connector.codexMissing, true);
  clearInterval(connector.followupRetryTimer); clearInterval(connector.phoneKeyTimer);
  // Codex commands answer plainly; the Codex list is empty.
  connector.idleHostRecyclePromise = null;
  connector.threadBackendId = () => 'codex'; connector.defaultBackendId = 'codex';
  assert.deepEqual(await connector.executeCommand({ action: 'thread.list', args: {} }), { data: [], nextCursor: null });
  await assert.rejects(connector.executeCommand({ action: 'thread.new', args: {} }), (error) => error.code === 'CODEX_NOT_INSTALLED' && /没有安装 Codex/.test(error.message));
  // Installing Codex starts it without a connector restart.
  clearInterval(connector.codexInstallTimer); connector.codexInstallTimer = null;
  const { root, newer } = fakeInstalls();
  try {
    await withEnv({ LOCALAPPDATA: root, ProgramFiles: path.join(root, 'none'), USERPROFILE: path.join(root, 'home') }, async () => {
      connector.watchCodexInstall(5);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(recovered, 1); assert.equal(connector.codexMissing, false); assert.equal(connector.codexInstallTimer, null);
      assert(newer);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
