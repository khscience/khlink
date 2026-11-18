const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sodium = require('libsodium-wrappers-sumo');
const mac = require('../src/mac-secret-store');
const { configRoot } = require('../src/config');
const { loginAccount, publicKeyOf } = require('../src/account-login');
const { wrapAccountKey } = require('../src/device-key');

test('macOS config lives in Application Support', () => {
  assert.equal(configRoot('darwin', {}, '/Users/kh'), path.join('/Users/kh', 'Library', 'Application Support'));
  assert.equal(configRoot('win32', { APPDATA: 'C:\\R' }, 'C:\\Users\\alice'), 'C:\\R');
});

test('mac secret store seals with a Keychain key created once', () => {
  let stored = null; let writes = 0;
  const keychain = { read: () => stored, write: (value) => { writes++; stored = value; } };
  const key = mac.masterKey(keychain);
  assert.equal(key.length, 32);
  assert.deepEqual(mac.masterKey(keychain), key);
  assert.equal(writes, 1);
  const sealed = mac.encryptWithKey('secret text', key);
  assert.ok(!sealed.includes('secret'));
  assert.equal(mac.decryptWithKey(sealed, key), 'secret text');
  const other = Buffer.alloc(32, 7);
  assert.throws(() => mac.decryptWithKey(sealed, other), /验证失败/);
  assert.throws(() => mac.decryptWithKey('bm90IGFuIGVudmVsb3Bl', key), /格式无效/);
});

function fakeServer({ keyPending, holderKey, accountId = 'acct-1' }) {
  const calls = [];
  let joining = null;
  const fetchFn = async (url, init = {}) => {
    const route = new URL(url).pathname.replace(/^.*\/api\/v2/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ route, body, auth: init.headers?.authorization || null });
    const ok = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
    if (route === '/session/oauth/authorization') return ok({ authorizationUrl: 'https://login.example/authorize?x=1', state: 'st-1' });
    if (route === '/session/oauth/complete') {
      joining = body;
      return ok({ profile: { displayName: '示例用户' }, session: { accountId, accessToken: 'desk-access' }, ...(keyPending ? { keyPending: true } : {}) });
    }
    if (route === '/session/key-envelope') {
      const n = calls.filter((c) => c.route === '/session/key-envelope').length;
      if (n < 2) return ok({ pending: true, holders: ['DESKTOP-1'] });
      return ok({ keyEnvelope: JSON.stringify(wrapAccountKey(holderKey, joining.publicKey, accountId, joining.deviceId)) });
    }
    if (route === '/connector/session') return ok({ accountId, deviceId: `${joining.deviceId}.connector`, refreshToken: 'conn-refresh' });
    return { ok: false, status: 404, text: async () => 'no route' };
  };
  return { fetchFn, calls };
}

function harness(server, dir) {
  const saved = [];
  return {
    saved,
    run: () => loginAccount({
      serverUrl: 'https://relay.example/fengzhu-bridge', deviceName: 'mac-mini', workspace: '/Users/kh',
      protect: (v) => `P:${v}`, unprotect: (v) => String(v).replace(/^P:/, ''),
      saveConfig: (input) => { saved.push(input); return { ...input, configFile: path.join(dir, 'config.json') }; },
      dataDir: dir, fetchFn: server.fetchFn, log: () => {}, sleep: async () => {},
      listen: async () => ({ port: 4567, result: Promise.resolve({ code: 'c-1', state: 'st-1' }), close: () => {} }),
    }),
  };
}

test('login joins an account that has a computer and takes its shared key', async () => {
  await sodium.ready;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-login-'));
  const holderKey = Buffer.alloc(32, 9);
  const server = fakeServer({ keyPending: true, holderKey });
  const h = harness(server, dir);
  const result = await h.run();
  const complete = server.calls.find((c) => c.route === '/session/oauth/complete');
  assert.equal(complete.body.deviceType, 'desktop');
  assert.equal(complete.body.codeVerifier.length > 40, true);
  assert.equal(server.calls[0].body.redirectUri, 'http://127.0.0.1:4567/callback');
  assert.equal(h.saved[0].accountKey, holderKey.toString('base64'));
  assert.equal(h.saved[0].refreshToken, 'conn-refresh');
  assert.equal(h.saved[0].protocolVersion, 2);
  assert.equal(h.saved[0].deviceName, 'mac-mini 后台连接器');
  assert.equal(server.calls.find((c) => c.route === '/connector/session').auth, 'Bearer desk-access');
  assert.equal(result.sharedKey, true);
  // Logging in again reuses the same computer identity.
  const again = fakeServer({ keyPending: false, holderKey });
  await harness(again, dir).run();
  assert.equal(again.calls.find((c) => c.route === '/session/oauth/complete').body.deviceId, complete.body.deviceId);
  assert.equal(again.calls.find((c) => c.route === '/session/oauth/complete').body.publicKey, complete.body.publicKey);
});

test('first computer of an account keeps its own key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-login-'));
  const server = fakeServer({ keyPending: false });
  const h = harness(server, dir);
  await h.run();
  assert.equal(Buffer.from(h.saved[0].accountKey, 'base64').length, 32);
  assert.equal(server.calls.some((c) => c.route === '/session/key-envelope'), false);
});

test('login refuses a callback whose state does not match', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-login-'));
  const server = fakeServer({ keyPending: false });
  await assert.rejects(loginAccount({
    serverUrl: 'https://relay.example', protect: (v) => v, unprotect: (v) => v, saveConfig: () => { throw new Error('must not save'); },
    dataDir: dir, fetchFn: server.fetchFn, log: () => {},
    listen: async () => ({ port: 1, result: Promise.resolve({ code: 'c', state: 'other' }), close: () => {} }),
  }), /state/);
});

test('public key derives from the stored private key', async () => {
  await sodium.ready;
  const identity = { privateKey: Buffer.alloc(32, 1).toString('base64') };
  assert.equal(Buffer.from(publicKeyOf(identity), 'base64').length, 32);
});

test('Hermes installed on a Mac is used locally without hermes.json', () => {
  const { readTransportConfig, hostCommand } = require('../src/backends/hermes-transport');
  const none = path.join(os.tmpdir(), 'khlink-no-hermes-json');
  const mac = readTransportConfig(none, {}, { platform: 'darwin', homedir: '/Users/kh', exists: (p) => p === path.join('/Users/kh', '.local', 'bin', 'hermes') });
  assert.equal(mac.transport, 'local');
  assert.deepEqual(hostCommand(mac, 'echo hi'), { file: process.env.HERMES_SHELL || '/bin/bash', args: ['-lc', 'echo hi'] });
  assert.equal(readTransportConfig(none, {}, { platform: 'darwin', homedir: '/Users/kh', exists: () => false }), null);
  // Windows: Hermes's own Windows install is used directly; nothing installed, nothing on.
  const windows = readTransportConfig(none, {}, { platform: 'win32', homedir: 'C:\\Users\\alice', exists: (p) => p.endsWith('hermes.exe') });
  assert.equal(windows.transport, 'windows');
  assert.equal(windows.home, 'C:\\Users\\alice\\AppData\\Local\\hermes');
  assert.equal(windows.hermesBin, 'C:\\Users\\alice\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe');
  assert.equal(windows.python, 'C:\\Users\\alice\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\python.exe');
  assert.equal(readTransportConfig(none, {}, { platform: 'win32', homedir: 'C:\\Users\\alice', exists: () => false }), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-hermes-'));
  fs.writeFileSync(path.join(dir, 'hermes.json'), JSON.stringify({ enabled: false }));
  assert.equal(readTransportConfig(dir, {}, { platform: 'darwin', homedir: '/Users/kh', exists: () => true }), null);
});
