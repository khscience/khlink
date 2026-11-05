const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const windows = { skip: process.platform !== 'win32' };

function run(t, fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-permission-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.json');
  fs.writeFileSync(file, JSON.stringify(fixture));
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'fixtures', 'claude-permission-harness.ps1'), '-Source',
    path.join(__dirname, '..', 'scripts', 'claude-desktop-answer.ps1'), '-Fixture', file],
  { windowsHide: true, encoding: 'utf8', timeout: 15_000 }).trim());
}

for (const [name, fixture, selected, menu] of [
  ['existing once button', { direct: true, choice: 'allow' }, 'Allow once', false],
  ['session-wide default never substitutes for once', { choice: 'allow' }, 'Allow once', true],
  ['current expand-collapse menu', { choice: 'allow', expand: true }, 'Allow once', true],
  ['an expand that opens nothing falls back to a real click', { choice: 'allow', expand: true, expandIgnored: true }, 'Allow once', true],
  ['deny with session-wide default', { choice: 'deny' }, 'Deny', false],
  ['explicit auto choice', { choice: 'allow_auto' }, 'Allow and switch to Auto Auto reviews the rest of this session.', true],
]) test(`desktop permission: ${name}`, windows, t => {
  const r = run(t, fixture);
  assert.equal(r.groups, 1);
  assert.equal(r.reason, null);
  assert.deepEqual(r.invoked, [selected]);
  assert.equal(r.menuOpen, menu);
});

for (const [field, reason] of [['staleAfterMenu', 'request_stale'], ['changedAfterMenu', 'prompt_mismatch']])
  test(`desktop permission: ${field} cannot authorize another operation`, windows, t => {
    const r = run(t, { choice: 'allow', [field]: true });
    assert.equal(r.reason, reason);
    assert.deepEqual(r.invoked, []);
  });

test('desktop permission: a dialog without an allow menu (an MCP tool) refuses "switch to Auto" by name', windows, t => {
  const auto = run(t, { choice: 'allow_auto', noMenu: true });
  assert.equal(auto.reason, 'auto_not_offered');
  assert.deepEqual(auto.invoked, []);
  const once = run(t, { choice: 'allow', noMenu: true });
  assert.equal(once.reason, null);
  assert.deepEqual(once.invoked, ['Allow once']);
});
