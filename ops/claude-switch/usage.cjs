// One implementation ships with both the desktop installer and connector.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { safePath } = require('./session-share.cjs');
const bundled = path.join(__dirname, 'claude-desktop-usage.js');
const shared = require(fs.existsSync(bundled) ? bundled : '../../fengzhu-connect/src/backends/claude-desktop-usage.js');
function usageFor(config, alias, now = Date.now()) {
  const org = config.profiles[alias].split(/[\\/]/).at(-1);
  return shared.readOfficialUsage({ org, alias,
    historyFile: safePath(config.root, path.join('profiles', alias, 'plan-usage-history.json')),
    callbackFile: safePath(config.root, path.join('usage', alias + '.json')),
    cacheDir: safePath(config.root, path.join('profiles', alias, 'Cache/Cache_Data')),
    hintFile: safePath(config.root, path.join('usage', alias + '-cache-address.json')),
    observationsDir: safePath(config.root, path.join('usage', alias + '-official-observations')),
  }, now);
}
module.exports = { ...shared, usageFor };
