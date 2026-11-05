const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('sidebar fallback only accepts one matching row and the exact visible session id', { skip: process.platform !== 'win32' }, () => {
  const helper = path.join(__dirname, '..', 'scripts', 'claude-desktop-navigation.ps1');
  const fixture = path.join(__dirname, 'fixtures', 'claude-navigation-harness.ps1');
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Helper', helper],
    { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  assert.deepEqual(JSON.parse(stdout), {
    unique: true, duplicate: false, nestedDuplicate: true, unknownRuntimeId: false,
    statusSuffix: true, ambiguousStatusSuffix: false, prefixWithoutBoundary: false, disabled: false, missing: false,
    correctId: true, wrongIdSameTitle: false, wrongTitle: false,
    missingUrl: false, wrongHost: false, lookalikeUrl: false,
  });
});
