const test = require('node:test');
const assert = require('node:assert/strict');
const { withDshBridgeRow } = require('../src/backends/dsh-sync');

// A YAML list parser just strong enough for these patch files: comments,
// "[]" and block items. Enough to tell a valid top-level list from a broken one.
function topLevel(text) {
  const content = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (content.length === 1 && content[0].trim() === '[]') return 'empty-list';
  if (content.some((l) => l.trim() === '[]')) return 'invalid';
  return content.every((l) => l.startsWith('- ') || l.startsWith(' ')) ? 'block-list' : 'invalid';
}

const header = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries.\n';

test('a fresh DSH profile ("[]") gets the bridge row as a valid list', () => {
  const next = withDshBridgeRow(`${header}[]\n`);
  assert.equal(topLevel(next), 'block-list');
  assert.match(next, /- insert:\n    - id: kh-link-dsh-bridge\n/);
  assert.match(next, /^# Your patch layer/);
});

test('a file an older connector broke (row after "[]") is repaired', () => {
  const broken = `${header}[]\n\n# KH Link desktop bridge (managed by khLink; remove this row to disable)\n- insert:\n    - id: kh-link-dsh-bridge\n      name: kh-link-dsh-bridge\n`;
  assert.equal(topLevel(broken), 'invalid');
  const next = withDshBridgeRow(broken);
  assert.equal(topLevel(next), 'block-list');
  assert.equal((next.match(/kh-link-dsh-bridge/g) || []).length, 2);
  assert.equal(withDshBridgeRow(next), next, 'repaired file stays as is');
});

test('an existing block list gets the row appended once', () => {
  const list = `${header}- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n  config:\n    transcriptView: standard\n`;
  const next = withDshBridgeRow(list);
  assert.equal(topLevel(next), 'block-list');
  assert.ok(next.startsWith(list));
  assert.equal(withDshBridgeRow(next), next);
});

test('CRLF files keep CRLF; non-empty flow lists are left alone; empty files get the row', () => {
  const crlf = withDshBridgeRow('# x\r\n[]\r\n');
  assert.ok(!/[^\r]\n/.test(crlf), 'only CRLF line ends');
  assert.equal(topLevel(crlf), 'block-list');
  assert.equal(withDshBridgeRow('[{ id: a }]\n'), null);
  assert.equal(topLevel(withDshBridgeRow('')), 'block-list');
});
