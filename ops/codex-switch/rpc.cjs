'use strict';
// Desktop and phone use the same official, credential-free reader.
const fs = require('node:fs');
const path = require('node:path');
const bundled = path.join(__dirname, 'codex-account-usage.js');
module.exports = require(fs.existsSync(bundled) ? bundled : '../../fengzhu-connect/src/codex-account-usage.js');
