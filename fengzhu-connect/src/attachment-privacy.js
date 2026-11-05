'use strict';

const os = require('node:os');
const path = require('node:path');

// Only rewrite the machine-generated attachment note for this connector's
// own upload directory. User-written paths and the text delivered to the agent
// remain unchanged. The id keeps phone-side queue reconciliation possible.
function sanitizeUploadReferences(value) {
  if (typeof value !== 'string') return value;
  const root = path.resolve(os.tmpdir(), 'FengzhuAgentBridge', 'uploads');
  return value.replace(/(^\[(?:风筑附件|附件)\][^\r\n]*\r?\n)路径：([^\r\n]+)/gm, (whole, heading, raw) => {
    const target = raw.trim();
    if (!path.isAbsolute(target)) return whole;
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return whole;
    const name = path.basename(target);
    const id = name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-.+$/i)?.[1];
    return id ? `${heading}附件编号：${id}` : whole;
  });
}

// Attachment paths and inline data are only needed by the local sender. A
// queue snapshot or receipt must never expose them to a phone.
function publicAttachments(attachments) {
  return Array.isArray(attachments) ? attachments.filter((attachment) => attachment && typeof attachment === 'object').map((attachment) => ({
    name: attachment.name, size: attachment.size || 0, mimeType: attachment.mimeType || null,
    attachmentId: attachment.attachmentId || null, previewState: attachment.previewState || 'available',
  })) : [];
}

module.exports = { sanitizeUploadReferences, publicAttachments };
