const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ClaudeStatusline, rateLimitInfo } = require('../src/claude-statusline');

const HOOK = path.join(__dirname, '..', 'scripts', 'claude-statusline.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'khlink-statusline-'));
  const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);
  const settings = path.join(root, '.claude', 'settings.json');
  return { root, dataDir, settings, statusline: new ClaudeStatusline({ dataDir, settings }) };
}

test('turning it on and off leaves a missing settings file missing', () => {
  const { root, settings, statusline } = fixture();
  try {
    assert.equal(statusline.status().enabled, false);
    assert.equal(statusline.set(true).enabled, true);
    const written = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(written.statusLine.type, 'command');
    assert.match(written.statusLine.command, /claude-statusline\.js/);
    assert.equal(statusline.set(false).enabled, false);
    assert.equal(fs.existsSync(settings), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('other settings and an existing status line are kept and restored', () => {
  const { root, settings, statusline } = fixture();
  try {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const original = { model: 'opus', permissions: { allow: ['Read'] }, statusLine: { type: 'command', command: 'echo mine', padding: 1 } };
    fs.writeFileSync(settings, JSON.stringify(original));
    const on = statusline.set(true);
    assert.deepEqual([on.enabled, on.chained], [true, true]);
    const during = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(during.model, 'opus');
    assert.deepEqual(during.permissions, original.permissions);
    assert.equal(during.statusLine.padding, 1);
    // Turning it on twice must not save our own command as the "previous" one.
    statusline.set(true);
    statusline.set(false);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a settings file that is not valid JSON is never rewritten', () => {
  const { root, settings, statusline } = fixture();
  try {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{ broken');
    assert.throws(() => statusline.set(true), /没有修改/);
    assert.equal(fs.readFileSync(settings, 'utf8'), '{ broken');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('turning it off keeps a status line the user put there since', () => {
  const { root, settings, statusline } = fixture();
  try {
    statusline.set(true);
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'echo newer' } }));
    statusline.set(false);
    assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command, 'echo newer');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the hook keeps only the quota and runs the previous status line', () => {
  const { root, dataDir, statusline } = fixture();
  try {
    fs.writeFileSync(path.join(dataDir, 'claude-statusline-previous.json'),
      JSON.stringify({ statusLine: { type: 'command', command: `"${process.execPath}" -e "process.stdin.pipe(process.stdout)"` } }));
    const input = JSON.stringify({ session_id: 'abc', transcript_path: 'C:\\secret.jsonl', model: { id: 'x' },
      rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } } });
    const run = spawnSync(process.execPath, [HOOK, statusline.snapshotFile], { input, encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, input);
    const saved = JSON.parse(fs.readFileSync(statusline.snapshotFile, 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['at', 'fiveHour', 'sevenDay']);
    assert.deepEqual(saved.fiveHour, { used: 23.5, resetsAt: 1738425600 });
    const week = rateLimitInfo(saved).unifiedWindows.seven_day;
    assert.ok(Math.abs(week.utilization - 0.412) < 1e-9);
    assert.equal(week.resetsAt, 1738857600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('without quota in the input the hook writes nothing and prints nothing', () => {
  const { root, statusline } = fixture();
  try {
    const run = spawnSync(process.execPath, [HOOK, statusline.snapshotFile], { input: JSON.stringify({ session_id: 'abc' }), encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
    assert.equal(statusline.snapshot(), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the connector hands a new snapshot to the rate-limit path once', async () => {
  const { Connector } = require('../src/connector');
  const { root, statusline } = fixture();
  try {
    const seen = [];
    const connector = Object.create(Connector.prototype);
    connector.claudeStatusline = statusline;
    connector.refreshClaudeCliOrg = async () => 'org-1';
    connector.onClaudeRateLimit = (info, at) => seen.push({ info, at });
    fs.writeFileSync(statusline.snapshotFile, JSON.stringify({ at: 1000, fiveHour: { used: 40, resetsAt: 5 }, sevenDay: null }));
    await connector.pollClaudeStatusline();
    await connector.pollClaudeStatusline();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].at, 1000);
    assert.equal(seen[0].info.unifiedWindows.five_hour.utilization, 0.4);
    assert.equal(seen[0].info.unifiedWindows.seven_day, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
