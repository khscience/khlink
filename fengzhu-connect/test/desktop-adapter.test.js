const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { DesktopAdapter } = require('../src/desktop-adapter');
const { EventEmitter } = require('node:events');

const echo = "let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);process.stdout.write(JSON.stringify({id:m.id,response:{ok:true}})+'\\n')}})";
const spawnNode = (script) => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

for (const wrote of [false, true]) {
  test(`a native queue steer timeout ${wrote ? 'after invocation' : 'during lookup'} has the correct delivery boundary`, async () => {
    const script = `let b='';process.stdin.on('data',d=>{b+=d;if(!b.includes('\\n'))return;const m=JSON.parse(b.trim());${wrote ? "process.stdout.write(JSON.stringify({id:m.id,phase:'write'})+'\\n');" : ''}})`;
    const adapter = new DesktopAdapter({ desktopAdapterBin: 'fake', desktopAdapterSpawn: () => spawnNode(script) });
    try {
      await assert.rejects(adapter.call({ action: 'steer_queued' }, 1000), error => error.delivery === (wrote ? 'uncertain' : 'not_sent'));
    } finally { adapter.child?.kill(); }
  });
}

test('a slow read-only steer lookup can exceed twelve seconds without being killed or sent twice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0, killed = 0;
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter(); child.stdin.writable = true;
    child.stdin.write = text => {
      writes++; const message = JSON.parse(text);
      setTimeout(() => {
        child.stdout.emit('data', JSON.stringify({ id: message.id, phase: 'write' }) + '\n');
        child.stdout.emit('data', JSON.stringify({ id: message.id, response: { ok: true, code: 'steer_accepted' } }) + '\n');
      }, 13_000);
    };
    child.kill = () => { killed++; child.emit('exit'); };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const adapter = new DesktopAdapter({ desktopAdapterBin: 'fake', desktopAdapterSpawn: fakeSpawn });
  const pending = adapter.steer({ threadId: 'test', requestId: 'answer', text: 'answer' }).then(value => ({ value }), error => ({ error }));
  await new Promise(setImmediate);
  t.mock.timers.tick(13_000);
  const result = await pending;
  assert.equal(result.error, undefined);
  assert.equal(result.value.code, 'steer_accepted');
  assert.equal(writes, 1); assert.equal(killed, 0); assert.equal(adapter.busy, false);
});

test('a stuck adapter is replaced after a timeout and later requests still work', async () => {
  let spawned = 0;
  const adapter = new DesktopAdapter({ desktopAdapterBin: 'fake', desktopAdapterSpawn: () => spawnNode(++spawned === 1 ? 'process.stdin.resume()' : echo) });
  try {
    await assert.rejects(adapter.call({ action: 'probe' }, 300), /timed out/);
    assert.equal((await adapter.call({ action: 'probe' }, 5000)).ok, true);
    assert.equal(spawned, 2);
    assert.equal(adapter.busy, false);
  } finally { adapter.child?.kill(); }
});

test('a short scan waits its turn and cannot kill an earlier slow dispatch', async () => {
  const serialServer = "let b='',tail=Promise.resolve();process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);tail=tail.then(()=>new Promise(r=>setTimeout(()=>{process.stdout.write(JSON.stringify({id:m.id,response:{ok:true,action:m.request.action}})+'\\n');r()},m.request.action==='dispatch'?400:10)))}})";
  let spawned = 0;
  const adapter = new DesktopAdapter({ desktopAdapterBin: 'fake', desktopAdapterSpawn: () => { spawned++; return spawnNode(serialServer); } });
  try {
    const sending = adapter.call({ action: 'dispatch' }, 5000);
    const scanning = adapter.call({ action: 'agent_presence' }, 100);
    assert.equal(adapter.busy, true, 'busy includes requests waiting for startup/another call');
    const results = await Promise.all([sending, scanning]);
    assert.deepEqual(results.map((row) => row.action), ['dispatch', 'agent_presence']);
    assert.equal(spawned, 1);
    assert.equal(adapter.busy, false);
  } finally { adapter.child?.kill(); }
});

test('queued requests recover after the preceding adapter process times out', async () => {
  let spawned = 0;
  const adapter = new DesktopAdapter({ desktopAdapterBin: 'fake', desktopAdapterSpawn: () => spawnNode(++spawned === 1 ? 'process.stdin.resume()' : echo) });
  try {
    const stalled = adapter.call({ action: 'probe' }, 300);
    const next = adapter.call({ action: 'agent_presence' }, 5000);
    await assert.rejects(stalled, /timed out/);
    assert.equal((await next).ok, true);
    assert.equal(spawned, 2);
    assert.equal(adapter.busy, false);
  } finally { adapter.child?.kill(); }
});

test('the adapter stderr reaches the connector log line by line', async () => {
  const logged = [];
  const script = `process.stderr.write('settings-category-item="模型 GPT-5.5"\\n');process.stderr.write('settings-failed code=model_option_not_matched\\n');${echo}`;
  const adapter = new DesktopAdapter({ desktopAdapterBin: 'fake', desktopAdapterSpawn: () => spawnNode(script), log: (line) => logged.push(line) });
  try {
    assert.equal((await adapter.call({ action: 'probe' }, 5000)).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(logged, ['desktop adapter: settings-category-item="模型 GPT-5.5"', 'desktop adapter: settings-failed code=model_option_not_matched']);
  } finally { adapter.child?.kill(); }
});

test('a flood of adapter stderr is cut to a bounded number of log lines a minute', async () => {
  const logged = [];
  const flood = `for (let i = 0; i < 100; i += 1) process.stderr.write('menu line ' + i + '\\n');${echo}`;
  const adapter = new DesktopAdapter({ desktopAdapterBin: 'fake', desktopAdapterSpawn: () => spawnNode(flood), log: (line) => logged.push(line) });
  try {
    assert.equal((await adapter.call({ action: 'probe' }, 5000)).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(logged.length, 40);
    assert.equal(logged[0], 'desktop adapter: menu line 0');
  } finally { adapter.child?.kill(); }
});
