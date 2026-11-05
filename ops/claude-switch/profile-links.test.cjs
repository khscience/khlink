'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const quote = s => "'" + s.replaceAll("'", "''") + "'";
function fixture(t) {
  const base = fs.realpathSync.native(process.env.KHLINK_TEST_DIR || os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'khlink-link-fixture-'));
  const a = path.join(root, 'profiles/primary'), b = path.join(root, 'profiles/secondary'), link = path.join(root, 'official');
  for (const dir of [a, b, path.join(root, 'shared')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(a, 'sentinel.txt'), 'source stays'); fs.writeFileSync(path.join(b, 'sentinel.txt'), 'target stays');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = command => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; try { Import-Module ${quote(path.join(__dirname, 'profile-links.psm1'))} -Force; ${command}; exit 0 } catch { Write-Error $_; exit 1 }`], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
  const args = `-Root ${quote(root)} -Link ${quote(link)} -From primary -To secondary`;
  const intact = () => { assert.equal(fs.readFileSync(path.join(a, 'sentinel.txt'), 'utf8'), 'source stays'); assert.equal(fs.readFileSync(path.join(b, 'sentinel.txt'), 'utf8'), 'target stays'); };
  return { root, a, b, link, run, args, intact, phase: () => JSON.parse(fs.readFileSync(path.join(root, 'shared/link-transaction.json'), 'utf8')).phase };
}
test('registered Junction switch and restore preserve both directory contents', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); fs.symlinkSync(f.a, f.link, 'junction');
  f.run(`Switch-KhProfileLink ${f.args}`);
  assert.equal(fs.realpathSync(f.link), fs.realpathSync(f.b)); assert.equal(f.phase(), 'done');
  f.run(`Restore-KhProfileLink ${f.args}`);
  assert.equal(fs.realpathSync(f.link), fs.realpathSync(f.a)); assert.equal(f.phase(), 'rolled_back'); f.intact();
});
test('failure between link renames restores source and removes prepared Junction', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); fs.symlinkSync(f.a, f.link, 'junction');
  f.run(`try { Switch-KhProfileLink ${f.args} -AfterPhase { param($phase) if ($phase -eq 'original_preserved') { throw 'injected failure' } }; throw 'missing failure' } catch { if ($_.Exception.Message -ne 'injected failure') { throw } }`);
  assert.equal(fs.realpathSync(f.link), fs.realpathSync(f.a)); assert.equal(fs.existsSync(f.link + '.khlink-next'), false);
  assert.equal(f.phase(), 'rolled_back'); f.intact();
});
test('crash-shaped missing official link restores preserved source without copying data', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); fs.symlinkSync(f.a, f.link + '.khlink-previous', 'junction'); fs.symlinkSync(f.b, f.link + '.khlink-next', 'junction');
  f.run(`Restore-KhProfileLink ${f.args}`);
  assert.equal(fs.realpathSync(f.link), fs.realpathSync(f.a)); assert.equal(f.phase(), 'rolled_back'); f.intact();
});
test('recovery rejects an unrelated link before changing any link', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), unrelated = path.join(f.root, 'unrelated'); fs.mkdirSync(unrelated); fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
  fs.symlinkSync(unrelated, f.link, 'junction'); fs.symlinkSync(f.b, f.link + '.khlink-next', 'junction');
  f.run(`try { Restore-KhProfileLink ${f.args}; throw 'missing failure' } catch { if ($_.Exception.Message -ne 'unknown link') { throw } }`);
  assert.equal(fs.realpathSync(f.link), fs.realpathSync(unrelated)); assert.equal(fs.existsSync(f.link + '.khlink-next'), true);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep'); f.intact();
});
