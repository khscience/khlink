const test = require('node:test');
const assert = require('node:assert/strict');
const { LatestFileWriter } = require('../src/latest-file-writer');

test('a slow status write coalesces newer snapshots and leaves the event loop free', async () => {
  const writes = []; let release;
  const io = {
    writeFile: async (_, text) => { writes.push(text); if (writes.length === 1) await new Promise((resolve) => { release = resolve; }); },
    rename: async () => {}, rm: async () => {},
  };
  const writer = new LatestFileWriter('status.json', { io });
  const done = writer.write('first');
  writer.write('old'); writer.write('latest');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ['first']);
  release(); await done;
  assert.deepEqual(writes, ['first', 'latest']);
  await writer.write('offline');
  assert.equal(writes.at(-1), 'offline');
});

test('Windows file locking uses asynchronous fallback and IO errors do not stop later snapshots', async () => {
  const events = []; let fail = true;
  const writer = new LatestFileWriter('status.json', {
    io: {
      writeFile: async () => { if (fail) { fail = false; throw new Error('disk'); } },
      rename: async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
      copyFile: async () => { events.push('copy'); }, rm: async () => {},
    }, onError: (error) => events.push(error.message),
  });
  await writer.write('first'); await writer.write('second');
  assert.deepEqual(events, ['disk', 'copy']);
});
