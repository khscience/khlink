const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { sanitizeUploadReferences } = require('../src/attachment-privacy');
const { publicItem } = require('../src/followup-store');
const { Connector } = require('../src/connector');
const { ready, decryptJson } = require('../src/crypto');

const uploadId = '3c1c407c-2155-4b43-a761-ed68203b1b0f';
const uploaded = path.join(os.tmpdir(), 'FengzhuAgentBridge', 'uploads', 'test-thread', `${uploadId}-说明.txt`);
const note = `[风筑附件] 说明.txt (27 bytes)\n路径：${uploaded}`;

test('history attachment notes retain the filename and opaque id, not the temporary upload path', () => {
  assert.equal(sanitizeUploadReferences(`请处理\n\n${note}`), `请处理\n\n[风筑附件] 说明.txt (27 bytes)\n附件编号：${uploadId}`);
  const crlf = note.replace(/\n/g, '\r\n');
  assert.equal(sanitizeUploadReferences(crlf), `[风筑附件] 说明.txt (27 bytes)\r\n附件编号：${uploadId}`);
  assert.equal(sanitizeUploadReferences(`${note}\n\n${note}`).split('附件编号：').length - 1, 2);
});

test('ordinary user paths and paths outside the upload directory are not rewritten', () => {
  const userText = `我的文件路径：${uploaded}`;
  const other = `[风筑附件] 说明.txt\n路径：${path.join(os.tmpdir(), `${uploadId}-说明.txt`)}`;
  const noId = `[附件] 原文件.txt\n路径：${path.join(os.tmpdir(), 'FengzhuAgentBridge', 'uploads', 'test-thread', '原文件.txt')}`;
  for (const input of [userText, other, noId]) assert.equal(sanitizeUploadReferences(input), input);
});

test('history encryption removes only generated upload paths and leaves the agent text intact', async () => {
  await ready();
  const key = Buffer.alloc(32, 17);
  const original = { type: 'userMessage', text: `请处理\n\n${note}` };
  const frame = await Connector.prototype.historyItemFrame.call({ config: { accountKey: key } }, 'th', 'item', original);
  const publicValue = decryptJson(key, { kind: 'history.item', threadId: 'th', id: 'item', ...frame });
  assert.equal(original.text.includes(uploaded), true);
  assert.equal(publicValue.text.includes(uploaded), false);
  assert.ok(publicValue.text.includes(uploadId));
  const agent = { type: 'agentMessage', text: note };
  const unchanged = await Connector.prototype.historyItemFrame.call({ config: { accountKey: key } }, 'th', 'other', agent);
  assert.equal(decryptJson(key, { kind: 'history.item', threadId: 'th', id: 'other', ...unchanged }).text, note);
});

test('queued attachments without message text expose their id but not the internal path', () => {
  const base = { id: 'q', threadId: 'th', text: note, displayText: '', attachments: [{ name: '说明.txt', attachmentId: uploadId, path: uploaded }] };
  const actual = publicItem(base);
  assert.ok(actual.text.includes(uploadId));
  assert.equal(JSON.stringify(actual).includes(uploaded), false);
  const legacy = publicItem({ ...base, displayText: undefined });
  assert.ok(legacy.text.includes(uploadId));
  assert.equal(legacy.text.includes(uploaded), false);
});
