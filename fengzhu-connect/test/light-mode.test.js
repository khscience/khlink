const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ready, encryptJson, decryptJson } = require('../src/crypto');
const { LightMode, accountThreadTag } = require('../src/light-mode');
const { Connector } = require('../src/connector');

const key = Buffer.alloc(32, 9);
const home = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const open = (threadId, id, frame) => decryptJson(key, { kind: 'history.item', threadId, id, ...frame });
const command = { type: 'commandExecution', text: '$ git status\nOn branch main', tool: 'Bash', status: 'completed', createdAt: 5 };

test('light mode is off by default and its setting survives a restart', (t) => {
  const dir = home(t);
  const light = new LightMode(dir);
  assert.equal(light.enabled(), false);
  assert.equal(light.placeholder(command), null);
  light.set(true);
  assert.equal(new LightMode(dir).enabled(), true);
});

test('only tool rows become placeholders; thinking, replies and cards go up whole', (t) => {
  const light = new LightMode(home(t)); light.set(true);
  assert.deepEqual(light.placeholder(command), { type: 'commandExecution', text: '', light: true, tool: 'Bash', status: 'completed', createdAt: 5 });
  for (const type of ['fileChange', 'mcpToolCall', 'webSearch', 'imageView', 'imageGeneration', 'toolImages']) assert.ok(light.placeholder({ type, text: 'x' }));
  for (const type of ['reasoning', 'agentMessage', 'userMessage', 'claudeWrapUp', 'claudeTaskList', 'plan', 'error', 'turnError']) assert.equal(light.placeholder({ type, text: 'x' }), null);
});

test('an upload in light mode sends the placeholder and keeps the full row for history.details', async (t) => {
  await ready();
  const lightMode = new LightMode(home(t)); lightMode.set(true);
  const connector = { config: { accountKey: key }, lightMode, log() {} };
  const frame = await Connector.prototype.historyItemFrame.call(connector, 'th-1', 'row-1', command);
  assert.deepEqual(open('th-1', 'row-1', frame), { type: 'commandExecution', text: '', light: true, tool: 'Bash', status: 'completed', createdAt: 5 });
  const reply = await Connector.prototype.historyItemFrame.call(connector, 'th-1', 'row-2', { type: 'agentMessage', text: '好了' });
  assert.equal(open('th-1', 'row-2', reply).text, '好了');
  // A rebuild uploads the row again: the newest copy is the one returned.
  await Connector.prototype.historyItemFrame.call(connector, 'th-1', 'row-1', { ...command, text: '$ git status\nclean' });
  const result = await Connector.prototype.executeCommand.call(connector, { action: 'history.details', args: { threadId: 'th-1', ids: ['row-1', 'row-2', 'missing'] } });
  assert.equal(result.items.length, 1);
  assert.equal(open('th-1', 'row-1', result.items[0]).text, '$ git status\nclean');
});

test('the phone turns light mode on and off with connector.lightMode', async (t) => {
  const lightMode = new LightMode(home(t));
  const connector = { config: {}, lightMode, log() {} };
  const set = (args) => Connector.prototype.executeCommand.call(connector, { action: 'connector.lightMode', args });
  assert.deepEqual(await set({ enabled: true, changedAt: 100 }), { enabled: true, changedAt: 100 });
  assert.deepEqual(await set({}), { enabled: true, changedAt: 100 });
  // Another phone's older choice arriving late does not undo the newer one.
  assert.deepEqual(await set({ enabled: false, changedAt: 50 }), { enabled: true, changedAt: 100 });
  assert.deepEqual(await set({ enabled: false, changedAt: 200 }), { enabled: false, changedAt: 200 });
});

test('detail writes yield to the event loop and a placeholder waits until the row is saved', async (t) => {
  await ready();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const io = { ...fs.promises, appendFile: async (...args) => { await gate; return fs.promises.appendFile(...args); } };
  const lightMode = new LightMode(home(t), { io }); lightMode.set(true);
  const connector = { config: { accountKey: key }, lightMode, log() {} };
  let completed = false;
  const frame = Connector.prototype.historyItemFrame.call(connector, 'th', 'row', command).then((value) => { completed = true; return value; });
  const details = lightMode.details('th', ['row']);
  // A slow disk must not block an unrelated timer, and the relay must not see
  // a placeholder for details that are not yet safely written.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(completed, false);
  release();
  assert.equal(open('th', 'row', await frame).light, true);
  assert.equal(open('th', 'row', (await details)[0]).text, command.text);
});

test('failed detail writes upload the full encrypted row instead of a broken placeholder', async (t) => {
  await ready();
  const io = { ...fs.promises, appendFile: async () => { throw Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' }); } };
  const lightMode = new LightMode(home(t), { io }); lightMode.set(true);
  const errors = [];
  const connector = { config: { accountKey: key }, lightMode, log(error) { errors.push(error); } };
  const frame = await Connector.prototype.historyItemFrame.call(connector, 'th', 'row', command);
  assert.equal(open('th', 'row', frame).text, command.text);
  assert.equal(open('th', 'row', frame).light, undefined);
  assert.equal(errors.length, 1);
});

test('after a changed detail fails to save it is retried instead of trusting an old cache entry', async (t) => {
  await ready();
  let failWrite = false;
  const io = { ...fs.promises, appendFile: async (...args) => {
    if (failWrite) throw Object.assign(new Error('simulated write failure'), { code: 'ENOSPC' });
    return fs.promises.appendFile(...args);
  } };
  const lightMode = new LightMode(home(t), { io }); lightMode.set(true);
  const connector = { config: { accountKey: key }, lightMode, log() {} };
  const save = (value) => Connector.prototype.historyItemFrame.call(connector, 'th', 'row', value);
  await save(command);
  const changed = { ...command, text: '新的命令输出' };
  failWrite = true;
  assert.equal(open('th', 'row', await save(changed)).text, changed.text);
  failWrite = false;
  assert.equal(open('th', 'row', await save(changed)).light, true);
  assert.equal(open('th', 'row', (await lightMode.details('th', ['row']))[0]).text, changed.text);
});

test('concurrent updates retain their order and the newest encrypted detail wins', async (t) => {
  const light = new LightMode(home(t));
  const rows = ['first', 'second', 'third'].map((value) => ({ id: '同一条', nonce: value, ciphertext: value }));
  await Promise.all(rows.map((row) => light.save('th', row)));
  assert.deepEqual(await light.details('th', ['同一条']), [rows[2]]);
});

test('identical encrypted detail rebuilds are deduplicated, but a changed row is saved', async (t) => {
  await ready();
  const lightMode = new LightMode(home(t)); lightMode.set(true);
  const connector = { config: { accountKey: key }, lightMode, log() {} };
  const frame = (value) => Connector.prototype.historyItemFrame.call(connector, 'th', 'row', value);
  await Promise.all(Array.from({ length: 30 }, () => frame(command)));
  let lines = (await fs.promises.readFile(lightMode.threadFile('th'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(open('th', 'row', (await lightMode.details('th', ['row']))[0]).text, command.text);
  const updated = { ...command, text: '更新后的输出' };
  await frame(updated);
  await frame(updated);
  lines = (await fs.promises.readFile(lightMode.threadFile('th'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(open('th', 'row', (await lightMode.details('th', ['row']))[0]).text, updated.text);
});

test('a removed, replaced or pruned detail file cannot be hidden by the duplicate cache', async (t) => {
  await ready();
  const lightMode = new LightMode(home(t)); lightMode.set(true);
  const connector = { config: { accountKey: key }, lightMode, log() {} };
  const save = () => Connector.prototype.historyItemFrame.call(connector, 'th', 'row', command);
  await save();
  const file = lightMode.threadFile('th');
  await fs.promises.unlink(file);
  await fs.promises.writeFile(file, JSON.stringify({ id: 'other', nonce: 'n', ciphertext: 'different' }) + '\n');
  await save();
  assert.equal(open('th', 'row', (await lightMode.details('th', ['row']))[0]).text, command.text);
  lightMode.prune(Date.now() + 91 * 86_400_000);
  assert.equal(fs.existsSync(file), false);
  await save();
  assert.equal(open('th', 'row', (await lightMode.details('th', ['row']))[0]).text, command.text);
});

test('the same detail is encrypted again when the account key changes', async (t) => {
  await ready();
  const lightMode = new LightMode(home(t)); lightMode.set(true);
  const connector = { config: { accountKey: key }, lightMode, log() {} };
  const save = () => Connector.prototype.historyItemFrame.call(connector, 'th', 'row', command);
  await save();
  const newKey = Buffer.alloc(32, 8);
  connector.config.accountKey = newKey.toString('base64');
  await save();
  const rows = (await fs.promises.readFile(lightMode.threadFile('th'), 'utf8')).trim().split('\n');
  assert.equal(rows.length, 2);
  const [latest] = await lightMode.details('th', ['row']);
  assert.equal(decryptJson(newKey, { kind: 'history.item', threadId: 'th', id: 'row', ...latest }).text, command.text);
});

test('different thread ids sharing a filename retain their own latest detail', async (t) => {
  await ready();
  const lightMode = new LightMode(home(t)); lightMode.set(true);
  const connector = { config: { accountKey: key }, lightMode, log() {} };
  const save = (threadId) => Connector.prototype.historyItemFrame.call(connector, threadId, 'row', command);
  assert.equal(lightMode.threadFile('a/b'), lightMode.threadFile('a?b'));
  await save('a/b');
  await save('a?b');
  assert.equal(open('a?b', 'row', (await lightMode.details('a?b', ['row']))[0]).text, command.text);
  assert.equal(open('a/b', 'row', (await lightMode.details('a/b', ['row']))[0]).text, command.text);
  assert.equal((await fs.promises.readFile(lightMode.threadFile('a/b'), 'utf8')).trim().split('\n').length, 2);
});

test('old untagged collisions are resolved by authenticated thread context without rewriting the file', async (t) => {
  await ready();
  const light = new LightMode(home(t), { acceptsLegacyRow: (threadId, row) => {
    try { open(threadId, row.id, row); return true; } catch { return false; }
  } });
  const file = light.threadFile('a/b');
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const legacy = (threadId, text, accountKey = key) => ({ id: 'same', ...encryptJson(accountKey, 'history.item', threadId, 'same', { text }) });
  const rows = [legacy('a/b', '旧 A'), legacy('a?b', '旧 B'), legacy('a/b', '其他账号', Buffer.alloc(32, 8))];
  await fs.promises.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const before = await fs.promises.readFile(file, 'utf8');
  assert.equal(open('a/b', 'same', (await light.details('a/b', ['same']))[0]).text, '旧 A');
  assert.equal(open('a?b', 'same', (await light.details('a?b', ['same']))[0]).text, '旧 B');
  assert.equal(await fs.promises.readFile(file, 'utf8'), before);
  await light.save('a/b', legacy('a/b', '新 A'));
  assert.equal(open('a/b', 'same', (await light.details('a/b', ['same']))[0]).text, '新 A');
  assert.equal(open('a?b', 'same', (await light.details('a?b', ['same']))[0]).text, '旧 B');
});

test('untagged legacy rows are not returned if their ownership cannot be authenticated', async (t) => {
  const light = new LightMode(home(t));
  const file = light.threadFile('a/b');
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify({ id: 'same', nonce: 'n', ciphertext: 'c' }) + '\n');
  assert.deepEqual(await light.details('a/b', ['same']), []);
});

test('tagged details stay isolated when the same thread ID is used with another account', async (t) => {
  await ready();
  let currentKey = key;
  const light = new LightMode(home(t), { threadTagFor: (threadId) => accountThreadTag(currentKey, threadId) });
  const add = async (value) => light.save('th', { id: 'same', ...encryptJson(currentKey, 'history.item', 'th', 'same', { text: value }) });
  await add('账号 A');
  const otherKey = Buffer.alloc(32, 8);
  currentKey = otherKey;
  await add('账号 B');
  assert.equal(decryptJson(currentKey, { kind: 'history.item', threadId: 'th', id: 'same', ...(await light.details('th', ['same']))[0] }).text, '账号 B');
  currentKey = key;
  assert.equal(open('th', 'same', (await light.details('th', ['same']))[0]).text, '账号 A');
  assert.throws(() => accountThreadTag(Buffer.alloc(0), 'th'), /无法验证/);
});

test('bounded detail deduplication never trusts an evicted file after it is changed', async (t) => {
  await ready();
  const lightMode = new LightMode(home(t), { maxRecentDetails: 2 }); lightMode.set(true);
  const connector = { config: { accountKey: key }, lightMode, log() {} };
  const save = (threadId) => Connector.prototype.historyItemFrame.call(connector, threadId, 'row', command);
  await save('one'); await save('two'); await save('three');
  assert.ok(lightMode.recentDetails.size <= 2);
  await fs.promises.writeFile(lightMode.threadFile('one'), '');
  await save('one');
  assert.equal(open('one', 'row', (await lightMode.details('one', ['row']))[0]).text, command.text);
});

test('details scan backwards across chunk boundaries without reading an entire old file', async (t) => {
  let bytesRead = 0;
  const io = { ...fs.promises, open: async (...args) => {
    const file = await fs.promises.open(...args);
    return { stat: () => file.stat(), close: () => file.close(), read: async (...readArgs) => {
      const result = await file.read(...readArgs); bytesRead += result.bytesRead; return result;
    } };
  } };
  const light = new LightMode(home(t), { io });
  await light.save('th', { id: 'older', nonce: 'old', ciphertext: 'x'.repeat(300_000) });
  await light.save('th', { id: 'wanted', nonce: 'first', ciphertext: 'first' });
  await light.save('th', { id: 'padding', nonce: 'x', ciphertext: 'x'.repeat(300_000) });
  await light.save('th', { id: 'wanted', nonce: 'latest', ciphertext: '最新' });
  // A partial final append must not hide the last complete row.
  await fs.promises.appendFile(light.threadFile('th'), '{partial');
  const size = (await fs.promises.stat(light.threadFile('th'))).size;
  assert.deepEqual(await light.details('th', ['wanted']), [{ id: 'wanted', nonce: 'latest', ciphertext: '最新' }]);
  assert.ok(bytesRead < size, `read ${bytesRead} of ${size} bytes`);
  const both = await light.details('th', ['older', 'wanted', 'missing']);
  assert.equal(both.find((row) => row.id === 'older').ciphertext.length, 300_000);
  assert.equal(both.find((row) => row.id === 'wanted').nonce, 'latest');
  assert.equal(both.length, 2);
});

test('a long detail scan stops with a clear error rather than running forever', async (t) => {
  let clock = 0;
  const light = new LightMode(home(t), { now: () => clock, scanTimeoutMs: 10 });
  await light.save('th', { id: 'present', nonce: 'n', ciphertext: 'x'.repeat(300_000) });
  const actualOpen = light.io.open;
  light.io = { ...fs.promises, open: async (...args) => {
    const file = await actualOpen(...args);
    return { stat: () => file.stat(), close: () => file.close(), read: async (...readArgs) => {
      const result = await file.read(...readArgs); clock += 11; return result;
    } };
  } };
  await assert.rejects(light.details('th', ['missing']), /查找超时/);
});

test('a long single-detail search resumes rather than rescanning the same suffix', async (t) => {
  let clock = 0, bytesRead = 0;
  const io = { ...fs.promises, open: async (...args) => {
    const file = await fs.promises.open(...args);
    return { stat: () => file.stat(), close: () => file.close(), read: async (...readArgs) => {
      const result = await file.read(...readArgs); clock += 6; bytesRead += result.bytesRead; return result;
    } };
  } };
  const light = new LightMode(home(t), { io, now: () => clock, scanTimeoutMs: 10 });
  await light.save('th', { id: 'old', nonce: 'n', ciphertext: 'wanted' });
  for (let i = 0; i < 18; i++) await light.save('th', { id: `padding-${i}`, nonce: 'n', ciphertext: 'x'.repeat(100_000) });
  const size = (await fs.promises.stat(light.threadFile('th'))).size;
  let result = null, timeouts = 0;
  for (let i = 0; i < 15 && result === null; i++) {
    try { result = await light.details('th', ['old']); }
    catch (error) { assert.equal(error.code, 'LIGHT_DETAILS_RETRY'); timeouts++; }
  }
  assert.ok(timeouts >= 2);
  assert.deepEqual(result, [{ id: 'old', nonce: 'n', ciphertext: 'wanted' }]);
  assert.ok(bytesRead < size * 3, `read ${bytesRead} bytes for a ${size}-byte file`);
  assert.equal(light.detailCursors.size, 0);
});

test('a resumed search checks appended records before continuing the old range', async (t) => {
  let clock = 0;
  const io = { ...fs.promises, open: async (...args) => {
    const file = await fs.promises.open(...args);
    return { stat: () => file.stat(), close: () => file.close(), read: async (...readArgs) => {
      const result = await file.read(...readArgs); clock += 6; return result;
    } };
  } };
  const light = new LightMode(home(t), { io, now: () => clock, scanTimeoutMs: 10 });
  await light.save('th', { id: 'old', nonce: 'old', ciphertext: 'old' });
  for (let i = 0; i < 12; i++) await light.save('th', { id: `p-${i}`, nonce: 'n', ciphertext: 'x'.repeat(100_000) });
  await assert.rejects(light.details('th', ['old']), (error) => error.code === 'LIGHT_DETAILS_RETRY');
  const newer = { id: 'old', nonce: 'new', ciphertext: 'new', threadTag: light.threadTag('th') };
  await fs.promises.appendFile(light.threadFile('th'), JSON.stringify(newer) + '\n');
  assert.deepEqual(await light.details('th', ['old']), [{ id: 'old', nonce: 'new', ciphertext: 'new' }]);
});

test('a newer record appended while a search runs wins over the old snapshot', async (t) => {
  let inject;
  const io = { ...fs.promises, open: async (...args) => {
    const file = await fs.promises.open(...args);
    return { stat: () => file.stat(), close: () => file.close(), read: async (...readArgs) => {
      const result = await file.read(...readArgs);
      if (inject) { const append = inject; inject = null; await append(); }
      return result;
    } };
  } };
  const light = new LightMode(home(t), { io });
  await light.save('th', { id: 'row', nonce: 'old', ciphertext: 'old' });
  const newer = { id: 'row', nonce: 'new', ciphertext: 'new', threadTag: light.threadTag('th') };
  const json = JSON.stringify(newer), cut = 20;
  await fs.promises.appendFile(light.threadFile('th'), json.slice(0, cut));
  inject = () => fs.promises.appendFile(light.threadFile('th'), json.slice(cut) + '\n');
  assert.deepEqual(await light.details('th', ['row']), [{ id: 'row', nonce: 'new', ciphertext: 'new' }]);
});

test('a deadline while checking a new suffix resumes near the found record', async (t) => {
  let clock = 0, inject;
  const io = { ...fs.promises, open: async (...args) => {
    const file = await fs.promises.open(...args);
    return { stat: () => file.stat(), close: () => file.close(), read: async (...readArgs) => {
      const result = await file.read(...readArgs); clock += 11;
      if (inject) { const append = inject; inject = null; await append(); }
      return result;
    } };
  } };
  const light = new LightMode(home(t), { io, now: () => clock, scanTimeoutMs: 10 });
  await light.save('th', { id: 'row', nonce: 'old', ciphertext: 'old' });
  const newer = { id: 'row', nonce: 'new', ciphertext: 'new', threadTag: light.threadTag('th') };
  inject = () => fs.promises.appendFile(light.threadFile('th'), JSON.stringify(newer) + '\n');
  await assert.rejects(light.details('th', ['row']), (error) => error.code === 'LIGHT_DETAILS_RETRY');
  assert.equal(light.detailCursors.size, 1);
  assert.deepEqual(await light.details('th', ['row']), [{ id: 'row', nonce: 'new', ciphertext: 'new' }]);
});

test('a replaced history file invalidates an old search cursor', async (t) => {
  let clock = 0;
  const io = { ...fs.promises, open: async (...args) => {
    const file = await fs.promises.open(...args);
    return { stat: () => file.stat(), close: () => file.close(), read: async (...readArgs) => {
      const result = await file.read(...readArgs); clock += 6; return result;
    } };
  } };
  const light = new LightMode(home(t), { io, now: () => clock, scanTimeoutMs: 10 });
  await light.save('th', { id: 'row', nonce: 'old', ciphertext: 'old' });
  for (let i = 0; i < 12; i++) await light.save('th', { id: `p-${i}`, nonce: 'n', ciphertext: 'x'.repeat(100_000) });
  await assert.rejects(light.details('th', ['row']), (error) => error.code === 'LIGHT_DETAILS_RETRY');
  const file = light.threadFile('th');
  await fs.promises.rename(file, file + '.previous');
  await fs.promises.writeFile(file, JSON.stringify({ id: 'row', nonce: 'new', ciphertext: 'new', threadTag: light.threadTag('th') }) + '\n');
  assert.deepEqual(await light.details('th', ['row']), [{ id: 'row', nonce: 'new', ciphertext: 'new' }]);
});

test('a file replaced during a read cannot return the old file snapshot', async (t) => {
  let inject;
  const io = { ...fs.promises, open: async (...args) => {
    const file = await fs.promises.open(...args);
    return { stat: () => file.stat(), close: () => file.close(), read: async (...readArgs) => {
      const result = await file.read(...readArgs);
      if (inject) { const replace = inject; inject = null; await replace(); }
      return result;
    } };
  } };
  const light = new LightMode(home(t), { io });
  await light.save('th', { id: 'row', nonce: 'old', ciphertext: 'old' });
  const file = light.threadFile('th');
  inject = async () => {
    await fs.promises.rename(file, file + '.previous');
    await fs.promises.writeFile(file, JSON.stringify({ id: 'row', nonce: 'new', ciphertext: 'new', threadTag: light.threadTag('th') }) + '\n');
  };
  await assert.rejects(light.details('th', ['row']), /发生变化/);
  assert.deepEqual(await light.details('th', ['row']), [{ id: 'row', nonce: 'new', ciphertext: 'new' }]);
});

test('a same-size rewrite after the handle snapshot is rejected', async (t) => {
  let inject;
  const io = { ...fs.promises, stat: async (...args) => {
    if (inject) { const rewrite = inject; inject = null; await rewrite(); }
    return fs.promises.stat(...args);
  } };
  const light = new LightMode(home(t), { io });
  await light.save('th', { id: 'row', nonce: 'old', ciphertext: 'old' });
  const file = light.threadFile('th');
  inject = async () => {
    const old = await fs.promises.readFile(file, 'utf8');
    await fs.promises.writeFile(file, old.replace('"nonce":"old","ciphertext":"old"', '"nonce":"new","ciphertext":"new"'));
    const changed = new Date(Date.now() - 60_000);
    await fs.promises.utimes(file, changed, changed);
  };
  await assert.rejects(light.details('th', ['row']), /发生变化/);
  assert.deepEqual(await light.details('th', ['row']), [{ id: 'row', nonce: 'new', ciphertext: 'new' }]);
});

test('an in-place same-size rewrite invalidates the saved cursor', async (t) => {
  let clock = 0;
  const io = { ...fs.promises, open: async (...args) => {
    const file = await fs.promises.open(...args);
    return { stat: () => file.stat(), close: () => file.close(), read: async (...readArgs) => {
      const result = await file.read(...readArgs); clock += 6; return result;
    } };
  } };
  const light = new LightMode(home(t), { io, now: () => clock, scanTimeoutMs: 10 });
  await light.save('th', { id: 'row', nonce: 'old', ciphertext: 'old' });
  for (let i = 0; i < 12; i++) await light.save('th', { id: `p-${i}`, nonce: 'n', ciphertext: 'x'.repeat(100_000) });
  await assert.rejects(light.details('th', ['row']), (error) => error.code === 'LIGHT_DETAILS_RETRY');
  const file = light.threadFile('th');
  const before = await fs.promises.readFile(file, 'utf8');
  const after = before.replace('"id":"p-11"', '"id":"row_"').replace('"nonce":"old","ciphertext":"old"', '"nonce":"new","ciphertext":"new"');
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
  await fs.promises.writeFile(file, after);
  const changed = new Date(Date.now() - 60_000);
  await fs.promises.utimes(file, changed, changed);
  let result = null;
  for (let i = 0; i < 10 && result === null; i++) {
    try { result = await light.details('th', ['row']); }
    catch (error) { assert.equal(error.code, 'LIGHT_DETAILS_RETRY'); }
  }
  assert.deepEqual(result, [{ id: 'row', nonce: 'new', ciphertext: 'new' }]);
});

test('large searches are coalesced and another large scan waits without blocking small files', async (t) => {
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let hold = true;
  const io = { ...fs.promises, open: async (...args) => {
    const file = await fs.promises.open(...args);
    return { stat: () => file.stat(), close: () => file.close(), read: async (...readArgs) => {
      if (hold) { hold = false; entered(); await gate; }
      return file.read(...readArgs);
    } };
  } };
  const light = new LightMode(home(t), { io, largeFileBytes: 500, largeReadDelayMs: 0 });
  await light.save('big', { id: 'a', nonce: 'n', ciphertext: 'x'.repeat(1000) });
  await light.save('big', { id: 'b', nonce: 'n', ciphertext: 'y'.repeat(1000) });
  await light.save('small', { id: 'c', nonce: 'n', ciphertext: 'ok' });
  const first = light.details('big', ['a']);
  await started;
  assert.equal(light.details('big', ['a']), first);
  await assert.rejects(light.details('big', ['b']), (error) => error.code === 'LIGHT_DETAILS_RETRY');
  assert.deepEqual(await light.details('small', ['c']), [{ id: 'c', nonce: 'n', ciphertext: 'ok' }]);
  release();
  assert.equal((await first)[0].id, 'a');
  assert.equal((await light.details('big', ['b']))[0].id, 'b');
});

test('a restart does not append the same details again (the file grew to 14 GB on 2026-11-08)', async (t) => {
  await ready();
  const dir = home(t);
  const run = async (value) => {
    const lightMode = new LightMode(dir); lightMode.set(true); // a fresh connector process
    const connector = { config: { accountKey: key }, lightMode, log() {} };
    await Connector.prototype.historyItemFrame.call(connector, 'th', 'row', value);
    await Connector.prototype.historyItemFrame.call(connector, 'th', 'other', { ...command, text: 'second row' });
    return lightMode;
  };
  const lines = async (lightMode) => (await fs.promises.readFile(lightMode.threadFile('th'), 'utf8')).trim().split('\n');
  let lightMode = await run(command);
  assert.equal((await lines(lightMode)).length, 2);
  for (let restart = 0; restart < 3; restart += 1) lightMode = await run(command);
  assert.equal((await lines(lightMode)).length, 2, 'unchanged rows are not written again after a restart');
  lightMode = await run({ ...command, text: 'changed after restart' });
  assert.equal((await lines(lightMode)).length, 3);
  assert.equal(open('th', 'row', (await lightMode.details('th', ['row']))[0]).text, 'changed after restart');
  // A row written by an older connector (no digest) is written once more, then stays.
  const legacy = new LightMode(home(t)); legacy.set(true);
  const old = JSON.parse((await lines(lightMode))[0]); delete old.h;
  await fs.promises.mkdir(legacy.dir, { recursive: true });
  await fs.promises.writeFile(legacy.threadFile('th'), JSON.stringify(old) + '\n');
  const again = async () => { const l = new LightMode(path.dirname(legacy.dir)); l.set(true); await Connector.prototype.historyItemFrame.call({ config: { accountKey: key }, lightMode: l, log() {} }, 'th', 'row', command); return l; };
  await again(); await again();
  assert.equal((await lines(legacy)).length, 2);
});

test('compaction keeps the last copy of each row per thread and the details still read back', async (t) => {
  await ready();
  const lightMode = new LightMode(home(t)); lightMode.set(true);
  const connector = { config: { accountKey: key }, lightMode, log() {} };
  const frame = (id, value) => Connector.prototype.historyItemFrame.call(connector, 'th', id, value);
  await frame('a', command); await frame('b', { ...command, text: 'b1' });
  const file = lightMode.threadFile('th');
  const original = await fs.promises.readFile(file, 'utf8');
  await fs.promises.appendFile(file, original + original); // what old connectors did on restart
  await frame('b', { ...command, text: 'b2' });
  assert.equal((await fs.promises.readFile(file, 'utf8')).trim().split('\n').length, 7);
  const result = await lightMode.compact(file);
  assert.deepEqual(result, { before: 7, after: 2 });
  assert.equal(open('th', 'a', (await lightMode.details('th', ['a']))[0]).text, command.text);
  assert.equal(open('th', 'b', (await lightMode.details('th', ['b']))[0]).text, 'b2');
  await frame('b', { ...command, text: 'b2' });
  assert.equal((await fs.promises.readFile(file, 'utf8')).trim().split('\n').length, 2, 'no re-append after compaction');
  await lightMode.compactAll({ minBytes: 0 });
  assert.equal((await fs.promises.readFile(file, 'utf8')).trim().split('\n').length, 2);
});
