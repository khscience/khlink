const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DirectHistory } = require('../src/direct-history');

test('a direct history index of NUL bytes is set aside and rebuilt instead of failing every read', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-direct-repair-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // What a connector killed during the Windows copy fallback left behind.
  fs.writeFileSync(path.join(directory, 'threads.json'), Buffer.alloc(4096));
  const stale = path.join(directory, 'abc.json.1234.tmp');
  fs.writeFileSync(stale, 'x'.repeat(100));
  const old = new Date(Date.now() - 3600_000); fs.utimesSync(stale, old, old);
  const fresh = path.join(directory, 'def.json.5678.tmp'); fs.writeFileSync(fresh, 'y');

  const history = new DirectHistory(directory, { accountKey: Buffer.alloc(32).toString('base64') });
  await history.ready;
  assert.equal(history.fresh, true, 'a damaged index triggers a full resync');
  assert.equal(history.threads.size, 0);
  assert.ok(fs.readdirSync(directory).some((name) => /^threads\.json\.damaged-\d+$/.test(name)), 'the damaged file is kept aside');
  assert.equal(fs.existsSync(stale), false, 'an abandoned temporary write is removed');
  assert.equal(fs.existsSync(fresh), true, 'a write that may still be running is left alone');

  // A damaged conversation file reads as empty, so the other files still work.
  let damaged = 0; history.onDamage = () => { damaged++; };
  const item = path.join(directory, 'item.json'); fs.writeFileSync(item, '\0\0\0');
  assert.deepEqual(await history.read(item), []);
  assert.equal(fs.existsSync(item), false);
  assert.equal(damaged, 1, 'the connector is told so it mirrors every conversation again');
});
