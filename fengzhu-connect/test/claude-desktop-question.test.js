const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function run(t, fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-question-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.json');
  fs.writeFileSync(file, JSON.stringify(fixture));
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'fixtures', 'claude-question-harness.ps1'), '-Source',
    path.join(__dirname, '..', 'scripts', 'claude-desktop-answer.ps1'), '-Fixture', file],
  { windowsHide: true, encoding: 'utf8', timeout: 15_000 }).trim());
}
const windows = { skip: process.platform !== 'win32' };
const page = (question, selected, multi = false, other = null) => ({ question, multi, other,
  options: ['蓝色 选择蓝色', '绿色 选择绿色'].map(name => ({ name, chosen: selected.includes(name) })) });

test('current desktop unnumbered single choices, checkbox multi-select, and Other submit together', windows, t => {
  const result = run(t, { pages: [page('颜色？', ['蓝色 选择蓝色']), page('功能？', ['蓝色 选择蓝色', '绿色 选择绿色'], true), page('尺寸？', [], false, '自填答案')] });
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.answers.map(a => a.labels), [['蓝色 选择蓝色'], ['蓝色 选择蓝色', '绿色 选择绿色'], []]);
  assert.equal(result.answers[2].other, '自填答案');
  assert.equal(result.pending, false);
});

test('older numbered single-choice buttons still advance without skipping the next question', windows, t => {
  const result = run(t, { legacy: true, pages: [page('颜色一？', ['绿色 选择绿色']), page('颜色二？', ['蓝色 选择蓝色'])] });
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.answers.map(a => a.labels), [['绿色 选择绿色'], ['蓝色 选择蓝色']]);
});

test('a partial attempt on a later page returns to page one and applies all answers', windows, t => {
  const result = run(t, { startPage: 1, pages: [page('第一页？', ['蓝色 选择蓝色']), page('第二页？', ['绿色 选择绿色'])] });
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.answers.map(a => a.labels), [['蓝色 选择蓝色'], ['绿色 选择绿色']]);
});

for (const [name, extra, reason] of [
  ['stale request', { stale: true }, 'request_stale'],
  ['different session', { wrongSession: true }, 'prompt_mismatch'],
  ['ambiguous option', { ambiguous: true }, 'option_not_found'],
]) test(`${name} refuses without any UI mutation`, windows, t => {
  const result = run(t, { ...extra, pages: [page('颜色？', ['蓝色 选择蓝色'])] });
  assert.equal(result.result.ok, false);
  assert.equal(result.result.reason, reason);
  assert.equal(result.mutations, 0);
});
