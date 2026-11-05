'use strict';

// The 115 connector is a Linux-only preview with changes absent from the
// Windows package. Patch a staged copy of the reviewed v11 release only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const V11_SHA256 = 'eb29ebb8dc00df39165ab089e0a180d4fbfcb8d62be514d4ae3905547a513722';
const BEFORE = `      let bytes = null; try { if (fs.statSync(item.path).size <= CLAUDE_IMAGE_MAX_BYTES) bytes = fs.readFileSync(item.path); } catch { /* unreadable */ }
      const mime = bytes ? detectImageMime(bytes) : null;`;
const AFTER = `      const declaredImage = String(item.mimeType || '').toLowerCase().startsWith('image/') || /\\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(item.name || item.path || '');
      let bytes = null; let size = 0;
      try { size = fs.statSync(item.path).size; if (size <= CLAUDE_IMAGE_MAX_BYTES) bytes = fs.readFileSync(item.path); }
      catch { if (declaredImage) throw Object.assign(new Error('图片无法读取，请重新选择后再发送。'), { delivery: 'not_sent' }); }
      const mime = bytes ? detectImageMime(bytes) : null;
      if (declaredImage && !mime) {
        const reason = size > CLAUDE_IMAGE_MAX_BYTES ? '图片超过 5 MB，请压缩后重新选择。' : '图片格式不受支持或文件已损坏，请重新选择。';
        throw Object.assign(new Error(reason), { delivery: 'not_sent' });
      }`;

function patchSource(source) {
  const crlf = source.includes('\r\n');
  const before = crlf ? BEFORE.replace(/\n/g, '\r\n') : BEFORE;
  const after = crlf ? AFTER.replace(/\n/g, '\r\n') : AFTER;
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) throw new Error('Reviewed image code not found exactly once');
  return source.slice(0, at) + after + source.slice(at + before.length);
}

function install(releaseDir) {
  const live = '/opt/khlink115/current';
  if (fs.existsSync(live) && fs.realpathSync(releaseDir) === fs.realpathSync(live)) throw new Error('Refusing to modify the live release');
  const target = path.join(releaseDir, 'src', 'backends', 'claude-desktop-sync.js');
  const source = fs.readFileSync(target, 'utf8');
  if (crypto.createHash('sha256').update(source).digest('hex') !== V11_SHA256) throw new Error('Refusing an unreviewed Linux preview');
  const result = patchSource(source);
  fs.writeFileSync(`${target}.tmp`, result, { flag: 'wx' });
  fs.renameSync(`${target}.tmp`, target);
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('Usage: node khlink115-image-validation-patch.cjs STAGED_RELEASE');
  install(process.argv[2]);
  process.stdout.write('Image validation installed in staged Linux preview.\n');
}

module.exports = { V11_SHA256, BEFORE, AFTER, patchSource, install };
