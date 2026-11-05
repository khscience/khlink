const test = require('node:test');
const assert = require('node:assert/strict');
const { BridgeApi } = require('../src/api');

function stubFetch(handler) {
  const original = global.fetch; const calls = [];
  global.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); };
  return { calls, restore: () => { global.fetch = original; } };
}
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

function api() {
  const a = new BridgeApi({ serverUrl: 'https://relay', protocolVersion: 2, deviceId: 'd', accountId: 'a', refreshToken: 'r' });
  a.config = { ...a.config }; // updateSecrets would write to disk
  a.refreshToken = (() => { let n = 0; return async () => { n += 1; a.refreshCount = n; a.accessToken = `t${n}`; a.expiresAt = Date.now() + 15 * 60_000; return a.accessToken; }; })();
  return a;
}

test('concurrent requests share one token refresh', async () => {
  const a = api(); const f = stubFetch(() => reply(200, {}));
  try {
    await Promise.all([a.request('/x'), a.request('/y'), a.request('/z')]);
    assert.equal(a.refreshCount, 1);
    assert.ok(f.calls.every((c) => c.init.headers.authorization === 'Bearer t1'));
  } finally { f.restore(); }
});

test('a token that expires while the request travels is renewed and the request resent once', async () => {
  const a = api();
  const f = stubFetch((url, init, n) => (n === 1 ? reply(401, { message: 'Token expired' }) : reply(200, { ok: true })));
  try {
    assert.deepEqual(await a.request('/items', { method: 'PUT', body: { a: 1 } }), { ok: true });
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].init.headers.authorization, 'Bearer t2');
  } finally { f.restore(); }
});

test('other 401s are not retried', async () => {
  const a = api(); const f = stubFetch(() => reply(401, { message: 'Account or device revoked' }));
  try {
    await assert.rejects(a.request('/x'), /401/);
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test('the token is renewed three minutes before it runs out', async () => {
  const a = api(); a.accessToken = 'old'; a.expiresAt = Date.now() + 2 * 60_000;
  assert.equal(await a.token(), 't1');
  a.expiresAt = Date.now() + 10 * 60_000;
  assert.equal(await a.token(), 't1');
});

test('idempotent requests retry network errors and 503s; POSTs do not', async () => {
  const a = api(); a.retryDelays = [1, 1];
  let n = 0;
  const f = stubFetch(() => { n += 1; if (n === 1) throw new TypeError('fetch failed'); if (n === 2) return reply(503, 'busy'); return reply(200, { ok: true }); });
  try {
    assert.deepEqual(await a.request('/items', { method: 'PUT', body: {} }), { ok: true });
    assert.equal(f.calls.length, 3);
    n = 0; f.calls.length = 0;
    await assert.rejects(a.request('/cmd', { method: 'POST', body: {} }), /fetch failed/);
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test('retries give up after the last delay', async () => {
  const a = api(); a.retryDelays = [1, 1];
  const f = stubFetch(() => reply(503, 'busy'));
  try {
    await assert.rejects(a.request('/x'), /503/);
    assert.equal(f.calls.length, 3);
  } finally { f.restore(); }
});

test('a saved legacy relay address is read as the current one, where the relay moved', () => {
  const { currentServerUrl } = require('../src/config');
  const current = 'https://relay.example.test/bridge', legacy = ['https://old.example.test/bridge'];
  assert.equal(currentServerUrl('https://old.example.test/bridge/', current, legacy), current);
  assert.equal(currentServerUrl('https://relay.example.test/bridge/', current, legacy), current);
  assert.equal(currentServerUrl('https://example.test/relay', current, legacy), 'https://example.test/relay');
});

test('a relay request that never answers is aborted instead of hanging reconnects', async () => {
  const a = api(); a.retryDelays = [];
  const f = stubFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  // AbortSignal.timeout does not keep the process alive on its own.
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    const started = Date.now();
    await assert.rejects(a.request('/stuck', { method: 'POST', body: {}, timeoutMs: 50 }), (error) => error.name === 'TimeoutError');
    assert.ok(Date.now() - started < 2_000);
    assert.ok(f.calls[0].init.signal, 'every request carries an abort signal');
  } finally { f.restore(); clearTimeout(keepAlive); }
});

test('a dead login is not refreshed again by every caller until a pause or a new sign-in', async () => {
  const a = new BridgeApi({ serverUrl: 'https://relay', protocolVersion: 2, deviceId: 'd', accountId: 'a', refreshToken: 'old' });
  let refreshes = 0;
  const f = stubFetch((url) => {
    if (url.endsWith('/session/refresh')) { refreshes += 1; return reply(401, { message: 'Device revoked or refresh expired' }); }
    return reply(200, {});
  });
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    for (let i = 0; i < 50; i++) await assert.rejects(a.request('/x'), /^Error: 401/);
    assert.equal(refreshes, 1, 'one refresh, not one per sync call');
    now += 61_000;
    await assert.rejects(a.request('/x'), /^Error: 401/);
    assert.equal(refreshes, 2, 'tried again after a minute');
    // A new sign-in writes another refresh token: it is used at once.
    a.config = { ...a.config, refreshToken: 'new' };
    a.refreshToken = async () => { a.accessToken = 'fresh'; a.expiresAt = now + 15 * 60_000; return a.accessToken; };
    await a.request('/x');
    assert.equal(f.calls.at(-1).init.headers.authorization, 'Bearer fresh');
  } finally { Date.now = realNow; f.restore(); }
});

test('a busy relay gets a short pause before the next refresh', async () => {
  const a = new BridgeApi({ serverUrl: 'https://relay', protocolVersion: 2, deviceId: 'd', accountId: 'a', refreshToken: 'r' });
  let refreshes = 0;
  const f = stubFetch(() => { refreshes += 1; return reply(503, { message: 'busy' }); });
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    for (let i = 0; i < 10; i++) await assert.rejects(a.token(), /^Error: 503/);
    assert.equal(refreshes, 1);
    now += 11_000;
    await assert.rejects(a.token(), /^Error: 503/);
    assert.equal(refreshes, 2);
  } finally { Date.now = realNow; f.restore(); }
});

test('a relay that cannot be reached for a minute is reported as an upload issue, and clears on success', async () => {
  const { BridgeApi, serverFailureReason } = require('../src/api');
  const certError = new TypeError('fetch failed'); certError.cause = { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' };
  assert.equal(serverFailureReason(certError), 'certificate');
  assert.equal(serverFailureReason(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(serverFailureReason(new Error('503 busy')), 'server');
  assert.equal(serverFailureReason(new Error('404 not found')), null);
  const api = new BridgeApi({ serverUrl: 'https://relay.invalid' });
  let fail = true;
  api.sendRequest = async () => { if (fail) throw certError; return { ok: true }; };
  await assert.rejects(api.request('/x', { auth: false }));
  const since = api.serverFailure.since;
  assert.equal(api.uploadIssue(since + 30_000), null);
  assert.deepEqual(api.uploadIssue(since + 61_000), { reason: 'certificate', since });
  await assert.rejects(api.request('/x', { auth: false }));
  assert.equal(api.serverFailure.since, since);
  fail = false;
  await api.request('/x', { auth: false });
  assert.equal(api.uploadIssue(since + 61_000), null);
});
