const test = require('node:test');
const assert = require('node:assert/strict');
const { Connector } = require('../src/connector');

test('presence availability follows desktop windows, not connector integrations', () => {
  const connector = Object.create(Connector.prototype);
  connector.codex = { ready: true };
  connector.claude = { claudeBin: 'C:\\Claude.exe', sessions: new Map([['live', {}]]) };
  connector.piOnline = false;
  connector.antigravityThreads = new Map([['known', {}]]);
  // Codex app-server, a Claude binary/session and Antigravity history are all
  // present, but the desktop windows are closed.
  connector.desktopAgentPresence = { codex: false, claude: false, antigravity: false };
  assert.deepEqual(connector.agentAvailabilityPayload(), {
    codex: false,
    claude: false,
    pi: false,
    antigravity: false,
    dsh: false,
  });
});

test('a live Claude session does not override a closed Claude desktop window', () => {
  const connector = Object.create(Connector.prototype);
  connector.codex = { ready: false };
  connector.claude = { claudeBin: null, sessions: new Map([['thread', {}]]) };
  connector.piOnline = true;
  connector.antigravityThreads = new Map();
  connector.desktopAgentPresence = { codex: false, claude: false, antigravity: true };
  assert.deepEqual(connector.agentAvailabilityPayload(), {
    codex: false,
    claude: false,
    pi: true,
    antigravity: true,
    dsh: false,
  });
});

test('refreshes the cached desktop presence without spawning a shell process', async () => {
  const connector = Object.create(Connector.prototype);
  connector.stopping = false;
  connector.desktopAgentPresence = { codex: null, claude: null, antigravity: null };
  connector.desktopAdapter = {
    busy: false,
    agentPresence: async () => ({ agentPresence: { codex: true, claude: false, antigravity: true } }),
  };
  connector.isConnected = () => false;
  assert.equal(await connector.refreshAgentAvailability(), true);
  assert.deepEqual(connector.agentAvailabilityPayload(), {
    codex: true,
    claude: false,
    pi: false,
    antigravity: true,
    dsh: false,
  });
});

test('a transient presence scan failure keeps the last good snapshot', async () => {
  const connector = Object.create(Connector.prototype);
  connector.stopping = false;
  connector.desktopAgentPresence = { codex: true, claude: false, antigravity: true };
  connector.desktopAdapter = { busy: false, agentPresence: async () => { throw new Error('adapter restart'); } };
  connector.log = () => {};
  assert.equal(await connector.refreshAgentAvailability(), false);
  assert.deepEqual(connector.agentAvailabilityPayload(), {
    codex: true,
    claude: false,
    pi: false,
    antigravity: true,
    dsh: false,
  });
});

test('isolated Codex launch requires a recent native adapter capability, never an old presence payload', async () => {
  const connector = Object.create(Connector.prototype);
  connector.isConnected = () => false;
  let payload = { codex: true, claude: true, antigravity: false };
  connector.desktopAdapter = { busy: false, agentPresence: async () => ({ agentPresence: payload }) };
  await connector.refreshAgentAvailability();
  assert.equal(connector.codexProfileIsolationReady(), false);
  payload = { ...payload, codexProfileIsolation: true };
  await connector.refreshAgentAvailability();
  const at = connector.desktopAgentPresenceAt;
  assert.equal(connector.codexProfileIsolationReady(at + 29999), true);
  assert.equal(connector.codexProfileIsolationReady(at + 30000), false);
  assert.equal(connector.codexProfileIsolationReady(at - 1), false);
  payload = { ...payload, codexProfileIsolation: false };
  await connector.refreshAgentAvailability();
  assert.equal(connector.codexProfileIsolationReady(), false);
});

test('an isolated-only Codex window never overrides the default account presence', async () => {
  const connector = Object.create(Connector.prototype);
  connector.isConnected = () => false;
  connector.codex = { ready: true };
  connector.desktopAdapter = { busy: false, agentPresence: async () => ({ agentPresence: {
    codex: false, claude: true, antigravity: false, codexProfileIsolation: true,
  } }) };
  await connector.refreshAgentAvailability();
  assert.equal(connector.agentAvailabilityPayload().codex, false);
  assert.equal(connector.codexProfileIsolationReady(), true);
});

test('installed agents: an empty home reports none, and the report is cached for a minute', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-installed-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, DSH_HOME: process.env.DSH_HOME };
  try {
    Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local') });
    delete process.env.DSH_HOME;
    const connector = Object.create(Connector.prototype);
    connector.codexMissing = true;
    assert.deepEqual(connector.agentInstalledPayload(1_000), { codex: false, claude: false, dsh: false, hermes: false, pi: false });
    fs.mkdirSync(path.join(home, '.dsh'));
    assert.equal(connector.agentInstalledPayload(2_000).dsh, false, 'cached');
    connector.codexMissing = false;
    assert.deepEqual(connector.agentInstalledPayload(70_000), { codex: true, claude: false, dsh: true, hermes: false, pi: false });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex in the tray and a windowless Antigravity count as open; the process check is cached', async () => {
  if (process.platform !== 'win32') return;
  const connector = Object.create(Connector.prototype);
  const queries = [];
  connector.desktopAppsQuery = (done) => queries.push(done);
  connector.desktopAdapter = { busy: false, agentPresence: async () => ({ agentPresence: { codex: false, claude: true, antigravity: false } }) };
  connector.isConnected = () => false;
  const now = Date.now();
  assert.deepEqual(connector.desktopAppsRunning(now), { codex: false, antigravity: false });
  queries[0]({ codex: true, antigravity: true });
  assert.deepEqual(connector.desktopAppsRunning(now + 1_000), { codex: true, antigravity: true });
  assert.equal(queries.length, 1, 'cached for 30 s');
  await connector.refreshAgentAvailability();
  assert.deepEqual(connector.desktopAgentPresence, { codex: true, claude: true, antigravity: true });
  connector.desktopAppsRunning(now + 40_000);
  queries[1](null);
  assert.deepEqual(connector.desktopAppsRunning(now + 41_000), { codex: true, antigravity: true }, 'a failed query keeps the last answer');
});
