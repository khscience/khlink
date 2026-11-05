// Compatibility entry point for local tools/tests; keep one parser in the product.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const bundled = path.join(__dirname, 'claude-usage-cache.js');
module.exports = require(fs.existsSync(bundled) ? bundled : '../../fengzhu-connect/src/backends/claude-usage-cache.js');
