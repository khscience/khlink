const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Hermes read-only store integration tests', (t) => {
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, ['-B', path.join(__dirname, 'hermes-store-test.py'), '-q'], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') return t.skip('Python is needed for the Hermes store integration test');
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
