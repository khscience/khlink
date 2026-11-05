'use strict';
// Desktop-only public identity. Never open a login file, request a service,
// parse unrelated configuration values, or export this record to the phone.
const fs = require('node:fs');
const path = require('node:path');
const { safePath } = require('./session-share.cjs');
const { locate } = require('./native-prefs.cjs');
const ACCOUNT = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function identityFor(config, alias) {
  const account = config.profiles[alias]?.split(/[\\/]/)[1];
  if (!ACCOUNT.test(account || '')) return null;
  const shortId = UUID.test(account) ? account.slice(0, 8) + '…' + account.slice(-4) : account;
  try {
    const file = safePath(config.root, path.join('profiles', alias, 'config.json'));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) return { status: 'unavailable' };
    const bytes = fs.readFileSync(file);
    // The official Electron store also contains unrelated sensitive fields.
    // Locate JSON spans structurally and parse ONLY this public UUID scalar.
    const span = locate(bytes, new Set(['lastKnownAccountUuid'])).get('lastKnownAccountUuid');
    if (!span) return { status: 'unavailable' };
    const observed = JSON.parse(bytes.subarray(span[0], span[1]).toString('utf8'));
    if (typeof observed !== 'string' || observed.toLowerCase() !== account.toLowerCase()) return { status: 'changed' };
    return { status: 'matched', accountId: account, shortId, source: 'official-last-account' };
  } catch { return { status: 'unavailable' }; }
}
module.exports = { identityFor };
