const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DshClient, DshApiError, readBridge } = require('../src/backends/dsh-api');

function bridgeFile(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-'));
  const file = path.join(dir, 'bridge.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test('reads only a loopback bridge with a launch token', () => {
  const good = bridgeFile({ url: 'http://127.0.0.1:1234/?token=abc', port: 1234, pid: process.pid, updatedAt: Date.now() });
  assert.equal(readBridge(good).port, 1234);
  assert.equal(readBridge(bridgeFile({ url: 'http://192.168.1.2:1234/?token=abc', port: 1234 })), null);
  assert.equal(readBridge(bridgeFile({ url: 'http://127.0.0.1:1234/', port: 1234 })), null);
  assert.equal(readBridge(path.join(os.tmpdir(), 'missing-dsh-bridge.json')), null);
});

test('exchanges the bridge token for an API operator cookie and calls the Host', async () => {
  const file = bridgeFile({ url: 'http://127.0.0.1:4321/?token=launch', port: 4321, pid: process.pid, updatedAt: Date.now() });
  const calls = [];
  const client = new DshClient({ bridgeFile: file, fetchFn: async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/connect')) {
      return new Response('', { status: 302, headers: { 'set-cookie': 'dsh-auth=x; Path=/; HttpOnly', location: './api/remote.mux' } });
    }
    const body = JSON.parse(init.body);
    assert.equal(body.method, 'session/list');
    assert.deepEqual(body.payload, { args: { _request: {} } });
    return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items: [{ sessionId: 's1' }] } } }), { status: 200 });
  } });
  assert.deepEqual(await client.sessionList(), [{ sessionId: 's1' }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.cookie, 'dsh-auth=x');
});

test('maps a Host business error without pretending it was delivered', async () => {
  const file = bridgeFile({ url: 'http://127.0.0.1:4321/?token=launch', port: 4321, pid: process.pid, updatedAt: Date.now() });
  const client = new DshClient({ bridgeFile: file, fetchFn: async (url, init) => {
    if (String(url).includes('/connect')) return new Response('', { status: 302, headers: { 'set-cookie': 'dsh-auth=x' } });
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'session/agent-busy', message: 'busy', details: {} } } }), { status: 200 });
  } });
  await assert.rejects(client.prompt('s1', { text: 'hi', requestId: 'r1' }), (error) => {
    assert.ok(error instanceof DshApiError);
    assert.equal(error.code, 'session/agent-busy');
    return true;
  });
});

test('reads the permission catalog and executes the Host permission command', async () => {
  const file = bridgeFile({ url: 'http://127.0.0.1:4321/?token=launch', port: 4321, pid: process.pid, updatedAt: Date.now() });
  const methods = [];
  const client = new DshClient({ bridgeFile: file, fetchFn: async (url, init) => {
    if (String(url).includes('/connect')) return new Response('', { status: 302, headers: { 'set-cookie': 'dsh-auth=x' } });
    const body = JSON.parse(init.body);
    methods.push(body.method);
    if (body.method === 'permissionPresets/catalog') {
      assert.deepEqual(body.payload.args, {});
      return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { options: [{ value: 'read-only', name: 'read-only' }], defaultPreset: 'workspace-write' } } }), { status: 200 });
    }
    assert.equal(body.method, 'commands/execute');
    assert.deepEqual(body.payload.args, { agentId: 's1', line: '/permission read-only', submittedAttachments: [] });
    return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { result: { kind: 'success', text: 'preset read-only' } } } }), { status: 200 });
  } });
  assert.deepEqual(await client.permissionCatalog(), { options: [{ value: 'read-only', name: 'read-only' }], defaultPreset: 'workspace-write' });
  assert.deepEqual(await client.executeCommand('s1', '/permission read-only'), { result: { kind: 'success', text: 'preset read-only' } });
  assert.deepEqual(methods, ['permissionPresets/catalog', 'commands/execute']);
});

test('a DSH restart on another port is followed, and a non-DSH answer drops the session', async () => {
  const file = bridgeFile({ url: 'http://127.0.0.1:4321/?token=launch', port: 4321, pid: process.pid, updatedAt: Date.now() });
  const hosts = [];
  let garbage = false;
  const client = new DshClient({ bridgeFile: file, fetchFn: async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname === '/connect') return new Response('', { status: 302, headers: { 'set-cookie': 'dsh-auth=x' } });
    hosts.push(target.host);
    if (garbage) return new Response('<html>not dsh</html>', { status: 200 });
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items: [] } } }), { status: 200 });
  } });
  await client.sessionList();
  // DSH restarted: same file, new port.
  fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:5555/?token=launch2', port: 5555, pid: process.pid, updatedAt: Date.now() }));
  await client.sessionList();
  assert.deepEqual(hosts, ['127.0.0.1:4321', '127.0.0.1:5555']);
  garbage = true;
  await assert.rejects(client.sessionList(), (error) => error.code === 'bad-response');
  assert.equal(client.online, false);
  garbage = false;
  await client.sessionList();
  assert.equal(client.online, true);
});
