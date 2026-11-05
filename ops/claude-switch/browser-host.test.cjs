'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const q = s => "'" + s.replaceAll("'", "''") + "'";
function fixture(t) {
  const base = fs.realpathSync.native(process.env.KHLINK_TEST_DIR || os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'khlink-bridge-test-'));
  const profiles = path.join(root, 'profiles'), a = path.join(profiles, 'primary'), b = path.join(profiles, 'secondary');
  for (const dir of [a, b, path.join(root, 'shared')]) fs.mkdirSync(dir, { recursive: true });
  const image = path.join(a, 'ChromeNativeHost/chrome-native-host.exe');
  fs.mkdirSync(path.dirname(image)); fs.writeFileSync(image, 'official program fixture');
  const official = path.join(root, 'official-resource.exe'); fs.copyFileSync(image, official);
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.ok(resolved.startsWith(base + path.sep) && resolved === root && !fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const run = command => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; Import-Module ${q(path.join(__dirname, 'browser-host.psm1'))} -Force; ${command}`],
    { windowsHide: true, timeout: 15000, encoding: 'utf8' }).trim();
  const classify = target => run(`Test-KhIndependentBrowserHost -ImagePath ${q(target)} -OfficialBinary ${q(official)} -ProfileRoot ${q(profiles)} -UserDataRoots @(${q(path.join(root, 'virtual'))})`);
  return { root, profiles, a, b, image, official, run, classify };
}
test('only an exact current official bridge at a recognized profile path is independent', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  assert.equal(f.classify(f.image), 'True');
  const other = path.join(f.a, 'other-helper.exe'); fs.copyFileSync(f.official, other);
  assert.equal(f.classify(other), 'False');
  const unknown = path.join(f.root, 'chrome-native-host.exe'); fs.copyFileSync(f.official, unknown);
  assert.equal(f.classify(unknown), 'False');
  fs.appendFileSync(f.image, ' changed');
  assert.equal(f.classify(f.image), 'False');
});
test('missing or replaced bridge is never exempted and user-data aliases use the same byte check', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), virtual = path.join(f.root, 'virtual/ChromeNativeHost/chrome-native-host.exe');
  fs.mkdirSync(path.dirname(virtual), { recursive: true }); fs.copyFileSync(f.official, virtual);
  assert.equal(f.classify(virtual), 'True');
  fs.unlinkSync(f.official);
  assert.equal(f.classify(virtual), 'False');
  assert.equal(f.classify(path.join(f.a, 'ChromeNativeHost/missing.exe')), 'False');
});
test('swapping only the Junction preserves a live program in the old profile without terminating it', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), link = path.join(f.root, 'active');
  // A local stdin-waiting Windows program models an executable image kept open
  // through the Junction. It is not Claude and never touches an account.
  fs.copyFileSync(path.join(process.env.SystemRoot, 'System32/cmd.exe'), f.image);
  fs.symlinkSync(f.a, link, 'junction');
  const child = spawn(path.join(link, 'ChromeNativeHost/chrome-native-host.exe'), ['/d', '/q'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  await once(child, 'spawn');
  try {
    f.run(`Import-Module ${q(path.join(__dirname, 'profile-links.psm1'))} -Force; Switch-KhProfileLink -Root ${q(f.root)} -Link ${q(link)} -From primary -To secondary`);
    assert.equal(child.exitCode, null);
    assert.equal(fs.realpathSync(link), fs.realpathSync(f.b));
    f.run(`Import-Module ${q(path.join(__dirname, 'profile-links.psm1'))} -Force; Restore-KhProfileLink -Root ${q(f.root)} -Link ${q(link)} -From primary -To secondary`);
    assert.equal(child.exitCode, null);
    assert.equal(fs.realpathSync(link), fs.realpathSync(f.a));
  } finally {
    // Normal EOF, never taskkill or TerminateProcess.
    child.stdin.end();
    if (child.exitCode === null) await once(child, 'exit');
  }
});
