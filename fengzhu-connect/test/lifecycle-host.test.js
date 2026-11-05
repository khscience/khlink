const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { Connector } = require('../src/connector');
const { connectHost, HOST_VERSION, stateFile } = require('../src/codex-host');
const { MAX_RPC_BYTES } = require('../src/json-line-reader');

function lifecycleConnector(root) {
  const connector = Object.create(Connector.prototype);
  connector.threadState = new Map();
  connector.desktopStatuses = new Map();
  connector.inFlightCommands = new Set();
  connector.stopping = false;
  connector.desktopSyncTimers = new Map();
  connector.statusFile = path.join(root, 'status.json');
  connector.config = { deviceName: 'test-desktop' };
  connector.followups = { save() {} };
  connector.ws = null;
  connector.codex = { stop: async () => { connector.stopCalls = (connector.stopCalls || 0) + 1; } };
  connector.log = () => {};
  return connector;
}

test('safe shutdown refuses while a Codex turn is active', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-lifecycle-'));
  try {
    const connector = lifecycleConnector(root);
    connector.threadState.set('task-1', { activeTurnId: 'turn-1' });
    const result = await connector.shutdown();
    assert.deepEqual(result.code, 'active_tasks');
    assert.equal(result.ok, false);
    assert.equal(connector.stopping, false);
    assert.equal(connector.stopCalls || 0, 0);
    const status = JSON.parse(fs.readFileSync(connector.statusFile, 'utf8'));
    assert.equal(status.shutdownBlocked, true);
    assert.equal(status.restartSafe, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('safe shutdown persists state and stops Codex only after idle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-lifecycle-'));
  try {
    const connector = lifecycleConnector(root);
    connector.lifecycle = 'running';
    const result = await connector.shutdown();
    assert.deepEqual(result, { ok: true, code: 'stopped' });
    assert.equal(connector.stopCalls, 1);
    assert.equal(connector.lifecycle, 'offline');
    const status = JSON.parse(fs.readFileSync(connector.statusFile, 'utf8'));
    assert.equal(status.connected, false);
    assert.equal(status.lifecycle, 'offline');
    assert.equal(status.restartSafe, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('safe shutdown does not block on a Desktop-owned task observation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-lifecycle-'));
  try {
    const connector = lifecycleConnector(root);
    connector.desktopStatuses.set('desktop-task', 'desktop_running');
    assert.equal(connector.hasActiveTurns(), false);
    assert.equal(connector.canShutdownSafely(), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('host transport authenticates and carries JSON-RPC without exposing a public port', async () => {
  const token = 'test-host-token';
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const value = JSON.parse(line);
        if (value.type === 'auth' && value.token === token) {
          socket.write(`${JSON.stringify({ type: 'ready', hostVersion: HOST_VERSION })}\n`);
        } else if (value.type === 'rpc') {
          socket.write(`${JSON.stringify({ type: 'rpc', message: { jsonrpc: '2.0', id: value.message.id, result: { ok: true } } })}\n`);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const transport = await connectHost({ port, token, version: HOST_VERSION });
    const message = new Promise((resolve) => transport.once('message', resolve));
    transport.send({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} });
    assert.deepEqual(await message, { jsonrpc: '2.0', id: 7, result: { ok: true } });
    transport.close();
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('real Host Supervisor keeps the Codex child alive across connector reconnect', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-host-e2e-'));
  const fakeJs = path.join(root, 'fake-codex.js');
  const fakeCmd = path.join(root, 'fake-codex.cmd');
  const configFile = path.join(root, 'config.json');
  const hostModule = path.resolve(__dirname, '../src/codex-host.js');
  fs.writeFileSync(fakeJs, [
    "if (process.argv.includes('--version')) { console.log('fake-codex 1.0.0'); process.exit(0); }",
    "let buffer = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => {",
    " buffer += chunk; const lines = buffer.split(/\\r?\\n/); buffer = lines.pop() || '';",
    " for (const line of lines) { if (!line.trim()) continue; const value = JSON.parse(line);",
    " process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { echoed: value.method } }) + '\\n'); } });",
  ].join('\n'));
  fs.writeFileSync(fakeCmd, '@echo off\r\nnode "%~dp0fake-codex.js" %*\r\n');
  fs.writeFileSync(configFile, JSON.stringify({ configFile, workspace: root, codexBin: fakeCmd }));
  const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(hostModule)}).serve(${JSON.stringify({ configFile, workspace: root, codexBin: fakeCmd })})`,], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 10_000;
  let state;
  try {
    while (Date.now() < deadline) {
      try { state = JSON.parse(fs.readFileSync(stateFile({ configFile }), 'utf8')); break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(state?.port, stderr || 'Host state was not created');
    const first = await connectHost(state);
    first.on('error', () => {});
    const firstReply = new Promise((resolve) => first.once('message', resolve));
    first.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.deepEqual(await firstReply, { jsonrpc: '2.0', id: 1, result: { echoed: 'initialize' } });
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await connectHost(state);
    second.on('error', () => {});
    assert.equal(second.state.initialized, true);
    const secondReply = new Promise((resolve) => second.once('message', resolve));
    second.send({ jsonrpc: '2.0', id: 2, method: 'thread/list', params: {} });
    assert.deepEqual(await secondReply, { jsonrpc: '2.0', id: 2, result: { echoed: 'thread/list' } });
    second.close();
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; }
      catch (error) { if (error.code !== 'EBUSY') throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  }
});

test('real host drains an oversized history reply and still acknowledges a following steer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzhu-host-large-'));
  const fakeCmd = path.join(root, 'fake-codex.cmd');
  fs.writeFileSync(fakeCmd, '@echo off\r\nnode "%~dp0fake-codex.js" %*\r\n');
  fs.writeFileSync(path.join(root, 'fake-codex.js'), [
    "if (process.argv.includes('--version')) { console.log('fake-codex 1.0.0'); process.exit(0); }",
    "const {once}=require('node:events'); const rl=require('node:readline').createInterface({input:process.stdin}); let chain=Promise.resolve();",
    "rl.on('line',line=>{ const m=JSON.parse(line); chain=chain.then(async()=>{",
    "if(m.method==='thread/read'){process.stdout.write(JSON.stringify({id:m.id}).slice(0,-1)+',\"result\":{\"text\":\"');",
    `for(let n=0;n<${MAX_RPC_BYTES / 65536 + 8};n++)if(!process.stdout.write('x'.repeat(65536)))await once(process.stdout,'drain');`,
    "process.stdout.write('\"}}\\n');}else process.stdout.write(JSON.stringify({id:m.id,result:{accepted:true}})+'\\n'); }); });",
  ].join('\n'));
  const config = { configFile: path.join(root, 'config.json'), workspace: root, codexBin: fakeCmd };
  const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.resolve(__dirname, '../src/codex-host.js'))}).serve(${JSON.stringify(config)})`], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.resume();
  let transport;
  try {
    let state; const deadline = Date.now() + 10_000;
    while (!state && Date.now() < deadline) {
      try { state = JSON.parse(fs.readFileSync(stateFile(config), 'utf8')); } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    assert.ok(state?.port);
    transport = await connectHost(state); transport.on('error', () => {});
    const replies = new Map();
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('steer starved behind oversized history')), 10_000);
      transport.on('message', (message) => { replies.set(message.id, message); if (replies.size === 2) { clearTimeout(timer); resolve(); } });
    });
    transport.send({ id: 'large-history', method: 'thread/read', params: {} });
    transport.send({ id: 'immediate', method: 'turn/steer', params: {} });
    await received;
    assert.equal(replies.get('large-history').error.code, -32097);
    assert.equal(replies.get('large-history').error.data.delivery, 'not_sent');
    assert.deepEqual(replies.get('immediate').result, { accepted: true });
    assert.equal(child.exitCode, null);
  } finally {
    transport?.close(); child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
    for (let attempt = 0; attempt < 10; attempt++) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; }
      catch (error) { if (error.code !== 'EBUSY') throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  }
});
