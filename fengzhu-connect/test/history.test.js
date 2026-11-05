const test = require('node:test');
const assert = require('node:assert/strict');
const { clip, extractInlineImages, isInternalContextText, normalizeItems, normalizeThread, desktopPinState, applyDesktopPin, stripLocalImageMarkup } = require('../src/history');

test('the plan returned after a blocking question remains visible without its transport wrapper', () => {
  const text = '<proposed_plan>\n# 绿色备忘录\n按用户选择使用绿色。\n</proposed_plan>';
  assert.equal(isInternalContextText(text), false);
  assert.equal(isInternalContextText('<environment_context>hidden</environment_context>'), true);
  const { rolloutItem } = require('../src/connector');
  const item = rolloutItem({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
  assert.equal(item.text, '# 绿色备忘录\n按用户选择使用绿色。');
  const normalized = normalizeItems({ id: 't', turns: [{ items: [{ id: 'p', type: 'agentMessage', text }] }] });
  assert.equal(normalized[0].value.text, item.text);
});

test('large output keeps both ends', () => {
  const result = clip('a'.repeat(100) + 'z'.repeat(100), 40);
  assert.equal(result.truncated, true); assert.match(result.text, /^a+/); assert.match(result.text, /z+$/);
});

test('desktop pin membership follows the exact desktop sidebar order', () => {
  const a = '00000000-0000-0000-0000-00000000000a';
  const b = '00000000-0000-0000-0000-00000000000b';
  const c = '00000000-0000-0000-0000-00000000000c';
  const pins = desktopPinState({
    'pinned-thread-ids': [b, a, c],
    'electron-persisted-atom-state': { 'unified-sidebar-pinned-order-v1': [
      `codex:thread:local:${a}`,
      `codex:thread:local:${b}`,
    ], 'unread-thread-ids-by-host-v1': { local: [a] } },
  });
  assert.deepEqual(pins.ids, [a, b, c]);
  assert.deepEqual(pins.unreadIds, [a]);
  assert.deepEqual(normalizeThread(applyDesktopPin({ id: a }, pins)), expectPin(a, true, 0));
  assert.equal(normalizeThread(applyDesktopPin({ id: 'z' }, pins)).pinned, false);
});

test('desktop unread ids come from the current per-identity read state', () => {
  const a = '00000000-0000-0000-0000-00000000000a';
  const b = '00000000-0000-0000-0000-00000000000b';
  const c = '00000000-0000-0000-0000-00000000000c';
  const pins = desktopPinState({
    'pinned-thread-ids': [],
    'electron-thread-read-state-v1': { version: 1, unreadByIdentity: {
      acct: { 'local:hash1': [a, b], 'remote-ssh-discovered:host': [c] },
    }, legacyMigration: { unreadThreadIdsByHostId: { local: [c] } } },
    'electron-persisted-atom-state': { 'unread-thread-ids-by-host-v1': { local: [c] } },
  });
  assert.deepEqual(pins.unreadIds, [a, b]);
});

test('desktop pin order removes stale duplicate entries after pin changes', () => {
  const a = '00000000-0000-0000-0000-00000000000a';
  const b = '00000000-0000-0000-0000-00000000000b';
  const pins = desktopPinState({
    'pinned-thread-ids': [b, a],
    'electron-persisted-atom-state': { 'unified-sidebar-pinned-order-v1': [
      `codex:thread:local:${a}`,
      `codex:thread:local:${a}`,
      `codex:thread:local:${b}`,
    ] },
  });
  assert.deepEqual(pins.ids, [a, b]);
  assert.deepEqual(pins.orderById, { [a]: 0, [b]: 1 });
});

function expectPin(id, pinned, pinOrder) {
  return { id, title: 'Codex task', cwd: '', status: 'idle', createdAt: 0, updatedAt: 0,
    archived: false, model: null, pinned, pinOrder, unread: id.endsWith('a') };
}

test('internal items are excluded', () => {
  const items = normalizeItems({ id: 't', turns: [{ items: [
    { id: 'a', type: 'worldState' },
    { id: 'ctx', type: 'userMessage', text: '<environment_context>secret</environment_context>' },
    { id: 'b', type: 'agentMessage', text: 'ok' },
  ] }] });
  assert.equal(items.length, 1); assert.equal(items[0].value.text, 'ok');
  assert.equal(isInternalContextText('<recommended_plugins>internal</recommended_plugins>'), true);
  assert.equal(isInternalContextText('请解释 environment_context'), false);
});

test('pure localImage history never exposes the Windows path', () => {
  const raw = '<image name=[Image #1] path="C:\\\\Users\\me\\AppData\\Local\\Temp\\uploads\\photo.png">\\n</image>';
  assert.equal(stripLocalImageMarkup(raw), '');
  const normalized = normalizeItems({ id: 't', turns: [{ items: [{ id: 'image', type: 'userMessage', text: raw }] }] });
  assert.equal(normalized[0].value.text, '图片附件');
  assert.doesNotMatch(normalized[0].value.text, /C:\\|<image/i);
});

test('localImage markup is removed while keeping the attachment context', () => {
  const raw = '<image name=[Image #1] path="C:\\\\Temp\\photo.png">\n</image>\n\n[KH Link 图片附件] photo.png\n附件编号：attachment-1';
  const normalized = normalizeItems({ id: 't', turns: [{ items: [{ id: 'image', type: 'userMessage', text: raw }] }] });
  assert.equal(normalized[0].value.text, '[KH Link 图片附件] photo.png\n附件编号：attachment-1');
  assert.doesNotMatch(normalized[0].value.text, /C:\\|<image/i);
});

test('recent normalization keeps global item order without serializing old output', () => {
  const thread = { id: 't', turns: [{ items: Array.from({ length: 100 }, (_, i) => ({ id: `i${i}`, type: 'agentMessage', text: `${i}` })) }] };
  const items = normalizeItems(thread, 3);
  assert.deepEqual(items.map((item) => [item.id, item.order]), [['i97', 98], ['i98', 99], ['i99', 100]]);
});

test('thread metadata normalizes lazy status and second timestamps', () => {
  const thread = normalizeThread({ id: 't', status: { type: 'notLoaded' }, updatedAt: 1_700_000_000 });
  assert.equal(thread.status, 'idle');
  assert.equal(thread.updatedAt, 1_700_000_000_000);
});

test('extracts inline Codex input images without serializing image data as text', () => {
  const data = `data:image/png;base64,${'a'.repeat(32)}`;
  const item = { type: 'imageView', output: [
    { type: 'text', text: '查看图片' },
    { type: 'input_image', detail: 'original', image_url: data },
  ] };
  assert.deepEqual(extractInlineImages(item), [{ data, mimeType: 'image/png' }]);
  const normalized = normalizeItems({ id: 't', turns: [{ createdAt: 1, items: [{ id: 'image', ...item }] }] });
  assert.equal(normalized[0].value.text, '查看图片');
  assert.deepEqual(normalized[0].value.images, [{ data, mimeType: 'image/png' }]);
});

test('extracts Codex imageGeneration result base64 and keeps it out of visible text', () => {
  const base64 = Buffer.from('generated png bytes').toString('base64');
  const normalized = normalizeItems({ id: 't', turns: [{ createdAt: 1, items: [{
    id: 'generated', type: 'imageGeneration', status: 'completed', result: base64, saved_path: 'generated.png',
  }] }] });
  assert.equal(normalized[0].value.text, '图片已生成');
  assert.deepEqual(normalized[0].value.images, [{ data: `data:image/png;base64,${base64}`, mimeType: 'image/png' }]);
});

test('extracts imageGeneration JSON emitted inside a tool output', () => {
  const base64 = Buffer.from('generated webp bytes').toString('base64');
  const output = JSON.stringify({ type: 'imageGeneration', result: base64, savedPath: 'generated.webp' });
  assert.deepEqual(extractInlineImages(output), [{ data: `data:image/webp;base64,${base64}`, mimeType: 'image/webp' }]);
});

test('normalizes Codex function_call_output images as imageGeneration', () => {
  const data = `data:image/png;base64,${'d'.repeat(32)}`;
  const normalized = normalizeItems({ id: 't', turns: [{ createdAt: 1, items: [{
    id: 'generated', type: 'function_call_output', output: [
      { type: 'input_text', text: 'Generated images are saved to generated.png' },
      { type: 'input_image', image_url: data },
    ],
  }] }] });
  assert.equal(normalized[0].value.type, 'imageGeneration');
  assert.equal(normalized[0].value.text, 'Generated images are saved to generated.png');
  assert.deepEqual(normalized[0].value.images, [{ data, mimeType: 'image/png' }]);
});
