const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const d = require('../src/backends/claude-desktop-paths');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'khlink-claude-paths-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const options = { roaming: path.join(base, 'Roaming'), local: path.join(base, 'Local') };
  const legacy = path.join(options.roaming, 'Claude');
  const packaged = path.join(options.local, 'Packages', 'Claude_test', 'LocalCache', 'Roaming', 'Claude');
  const modern = path.join(options.local, 'Claude-Data', 'claude_test');
  const session = root => {
    const dir = path.join(root, 'claude-code-sessions', 'account', 'org');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'local_one.json'); fs.writeFileSync(file, '{}'); return file;
  };
  return { options, legacy, packaged, modern, session };
}

test('discovery keeps legacy installs and follows the post-reopen Claude-Data migration', t => {
  const { options, legacy, packaged, modern, session } = fixture(t);
  assert.equal(d.claudeAppDir(options), legacy);
  const old = session(packaged);
  assert.equal(d.claudeAppDir(options), packaged);
  fs.utimesSync(old, new Date(1000), new Date(1000));
  session(modern);
  assert.equal(d.claudeAppDir(options), modern, 'a leftover populated MSIX directory cannot pin discovery forever');
  fs.unlinkSync(old);
  fs.utimesSync(path.join(packaged, 'claude-code-sessions'), new Date(), new Date(Date.now() + 60_000));
  assert.equal(d.claudeAppDir(options), modern, 'an empty but newer old root cannot hide the migrated sessions');
  assert.ok(!d.claudeDataDirs(options).some(dir => dir.includes('Claude-3p')));
});

test('scratch workspaces and prompt logs use the migrated official data root', t => {
  const { options, legacy, modern, session } = fixture(t); session(modern);
  const scratch = path.join(modern, 'scratch-workspaces', 'test'); fs.mkdirSync(scratch, { recursive: true });
  assert.equal(d.realDesktopPath(path.join(legacy, 'scratch-workspaces', 'test'), options), scratch);
  const log = path.join(modern, 'logs', 'main.log'); fs.mkdirSync(path.dirname(log)); fs.writeFileSync(log, 'new');
  const retired = path.join(legacy, 'logs', 'main.log'); fs.mkdirSync(path.dirname(retired), { recursive: true }); fs.writeFileSync(retired, 'old prompt');
  assert.deepEqual(d.desktopLogFiles(modern, options), [log]);
});

test('live session detection accepts the official migrated binary, not third-party gateways', () => {
  for (const file of [String.raw`C:\Users\me\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\claude-code\2.1.299\hash\claude.exe`,
    String.raw`C:\Users\me\AppData\Roaming\Claude\claude-code\2.1.299\claude.exe`,
    String.raw`G:\Apps\ClaudeSwitch\profiles\primary\claude-code\2.1.299\hash\claude.exe`]) assert.ok(d.isDesktopClaudeBinaryPath(file));
  assert.equal(d.isDesktopClaudeBinaryPath(String.raw`C:\Users\me\AppData\Local\Claude-3p\claude-code\2.1.299\claude.exe`), false);
});

test('the UI scripts locate the new log without launching or interacting with Desktop', { skip: process.platform !== 'win32' }, t => {
  const { options, modern, session } = fixture(t); session(modern);
  const log = path.join(modern, 'logs', 'main.log'); fs.mkdirSync(path.dirname(log)); fs.writeFileSync(log, 'fixture');
  const script = path.resolve(__dirname, '../scripts/claude-desktop-log-path.ps1').replaceAll("'", "''");
  const selected = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `. '${script}'; Desktop-LogPath`],
    { windowsHide: true, encoding: 'utf8', timeout: 15_000, env: { ...process.env, APPDATA: options.roaming, LOCALAPPDATA: options.local } }).trim();
  assert.equal(selected, log);
});
