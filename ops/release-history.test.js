'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { historyOf } = require('./release-history');

test('Android history includes all recorded skipped releases, without changing the connector cap', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-release-history-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('khlink-release-history-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  for (let version = 1; version <= 45; version++) {
    for (const part of ['android', 'connector']) {
      fs.writeFileSync(path.join(dir, `${part}-0.1.${version}.md`), `- 第 ${version} 版\n`);
    }
  }
  fs.writeFileSync(path.join(dir, 'android-0.1.46.md'), '- 尚未发布\n');
  const android = historyOf('android', '0.1.45', dir);
  assert.equal(android.length, 45);
  assert.equal(android[0].version, '0.1.45');
  assert.deepEqual(android[44], { version: '0.1.1', notes: '第 1 版' });
  assert.equal(historyOf('connector', '0.1.45', dir).length, 30);
});
