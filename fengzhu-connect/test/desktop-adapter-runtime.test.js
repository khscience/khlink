const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installDesktopAdapter } = require('../src/desktop-adapter-runtime');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-adapter-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'bundled.exe');
  fs.writeFileSync(source, 'version one');
  return { source, runtime: path.join(root, 'installed') };
}

test('installs an exact version outside the checkout and reuses it unchanged', t => {
  const { source, runtime } = fixture(t);
  const installed = installDesktopAdapter(source, runtime);
  assert.ok(installed.startsWith(runtime + path.sep));
  assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(source));
  const before = fs.statSync(installed).mtimeMs;
  assert.equal(installDesktopAdapter(source, runtime), installed);
  assert.equal(fs.statSync(installed).mtimeMs, before);
});

test('a new helper version does not overwrite a potentially running old helper', t => {
  const { source, runtime } = fixture(t);
  const first = installDesktopAdapter(source, runtime);
  fs.writeFileSync(source, 'version two');
  const second = installDesktopAdapter(source, runtime);
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(first, 'utf8'), 'version one');
  assert.equal(fs.readFileSync(second, 'utf8'), 'version two');
});

test('a modified installed executable is rejected instead of executed or silently trusted', t => {
  const { source, runtime } = fixture(t);
  const installed = installDesktopAdapter(source, runtime);
  fs.writeFileSync(installed, 'changed');
  assert.throws(() => installDesktopAdapter(source, runtime), /校验失败/);
});
