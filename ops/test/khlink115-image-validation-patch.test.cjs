'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { BEFORE, patchSource } = require('../khlink115-image-validation-patch.cjs');

test('Linux image patch refuses an unexpected source or repeated anchor', () => {
  assert.throws(() => patchSource('different source'));
  assert.throws(() => patchSource(`${BEFORE}\n${BEFORE}`));
  assert.ok(patchSource(BEFORE.replace(/\n/g, '\r\n')).includes('\r\n'));
});

test('Linux image patch refuses broken and oversized images before sending text', () => {
  const source = patchSource(`function check(item) {\n${BEFORE}\nreturn mime;\n}`);
  const sandbox = { CLAUDE_IMAGE_MAX_BYTES: 5, detectImageMime: (bytes) => bytes.toString() === 'ok' ? 'image/png' : null,
    fs: { statSync: (file) => { if (file === 'missing') throw new Error('missing'); return { size: file === 'large' ? 6 : 2 }; }, readFileSync: (file) => Buffer.from(file === 'good' ? 'ok' : 'bad') }, Buffer };
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.check({ path: 'good', name: 'good.png' }), 'image/png');
  for (const file of ['large', 'missing', 'bad']) assert.throws(() => sandbox.check({ path: file, name: 'x.png' }), (error) => error.delivery === 'not_sent');
  assert.equal(sandbox.check({ path: 'bad', name: 'notes.txt' }), null);
});
