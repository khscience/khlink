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
