'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { identityFor } = require('./identity.cjs');
const id = '11111111-2222-4333-8444-555555555555';
function fixture(t, content) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'khlink-public-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'profiles/primary'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), content);
  return { root, profiles: { primary: `claude-code-sessions/${id}/org-registered` } };
}
test('Claude card verifies its registered account and exposes only public identity fields', t => {
  const config = fixture(t, JSON.stringify({ lastKnownAccountUuid: id, unrelated: { email: 'not-used@example.invalid', token: 'SYNTHETIC_DO_NOT_EXPORT' } }));
  assert.deepEqual(identityFor(config, 'primary'), { status: 'matched', accountId: id, shortId: '11111111…5555', source: 'official-last-account' });
  assert.doesNotMatch(JSON.stringify(identityFor(config, 'primary')), /SYNTHETIC|example|org-/);
});
test('unrelated JSON values are skipped structurally instead of decoded', t => {
  const config = fixture(t, `{"lastKnownAccountUuid":"${id}","unrelated":{"opaque":not_a_JSON_scalar}}`);
  assert.equal(identityFor(config, 'primary').status, 'matched');
});
test('another official account never inherits the previous registered identity', t => {
  const config = fixture(t, JSON.stringify({ lastKnownAccountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }));
  assert.deepEqual(identityFor(config, 'primary'), { status: 'changed' });
});
test('missing, duplicate, malformed or oversized public metadata is unavailable', t => {
  for (const content of ['{}', '{"lastKnownAccountUuid":null}', `{"lastKnownAccountUuid":"${id}","lastKnownAccountUuid":"${id}"}`, '{broken', ' '.repeat(4 * 1024 * 1024 + 1)]) {
    const config = fixture(t, content);
    assert.ok(['unavailable', 'changed'].includes(identityFor(config, 'primary').status));
    assert.equal(identityFor(config, 'primary').accountId, undefined);
  }
});
test('linked profile metadata is rejected without following the target', t => {
  const config = fixture(t, '{}'), file = path.join(config.root, 'profiles/primary/config.json');
  const target = path.join(config.root, 'other.json'); fs.writeFileSync(target, JSON.stringify({ lastKnownAccountUuid: id }));
  fs.unlinkSync(file); fs.linkSync(target, file);
  assert.deepEqual(identityFor(config, 'primary'), { status: 'unavailable' });
});
