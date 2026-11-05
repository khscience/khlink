const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomic } = require('./atomic-file');
const { home, protect, unprotect } = require('./config');

const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

class AttachmentStore {
  constructor(file = process.env.KH_LINK_ATTACHMENT_STORE || path.join(home, 'mcp-attachments.dat')) {
    this.file = file;
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return [];
      const value = JSON.parse(unprotect(fs.readFileSync(this.file, 'utf8')));
      return Array.isArray(value) ? value : [];
    } catch (error) {
      throw new Error(`Cannot read protected attachment registry: ${error.message}`);
    }
  }

  save(items) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, protect(JSON.stringify(items)), { mode: 0o600 });
  }

  clean(now = Date.now()) {
    const current = this.load();
    const remaining = current.filter((item) => item.expiresAt > now && isAllowedUploadPath(item.path));
    if (remaining.length !== current.length) this.save(remaining);
    return remaining;
  }

  register(item) {
    const expiresAt = Number(item.expiresAt) || Date.now() + DEFAULT_TTL_MS;
    const entry = {
      id: String(item.id),
      threadId: String(item.threadId),
      name: String(item.name || path.basename(item.path)),
      path: validateUploadPath(item.path),
      size: Number(item.size) || 0,
      mimeType: item.mimeType ? String(item.mimeType) : null,
      createdAt: Date.now(),
      expiresAt,
    };
    const items = this.clean().filter((candidate) => candidate.id !== entry.id);
    items.push(entry); this.save(items);
    return entry;
  }

  resolve(id, threadId = null) {
    const entry = this.load().find((item) => item.id === String(id));
    if (!entry || entry.expiresAt <= Date.now()) throw new Error('khLink attachment is unknown or expired');
    if (threadId && entry.threadId !== String(threadId)) throw new Error('khLink attachment belongs to another task');
    const target = validateUploadPath(entry.path);
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size <= 0) throw new Error('khLink attachment is unavailable');
    return { ...entry, path: target, size: stat.size };
  }

  remove(id) {
    const current = this.load();
    const remaining = current.filter((item) => item.id !== String(id));
    if (remaining.length !== current.length) this.save(remaining);
    return remaining.length !== current.length;
  }

  retain(id, expiresAt = Date.now() + 7 * 24 * 60 * 60_000) {
    const current = this.load();
    let changed = false;
    const next = current.map((item) => {
      if (item.id !== String(id) || item.expiresAt >= expiresAt) return item;
      changed = true;
      return { ...item, expiresAt };
    });
    if (changed) this.save(next);
    return next.find((item) => item.id === String(id)) || null;
  }

  readImage(id) {
    const entry = this.resolve(id);
    if (entry.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 25 MB MCP limit');
    const data = fs.readFileSync(entry.path);
    const mimeType = detectImageMime(data);
    if (!mimeType) throw new Error('Attachment is not a supported PNG, JPEG, WebP, GIF, or BMP image');
    return { ...entry, data, mimeType };
  }
}

function uploadRoot() {
  return path.resolve(os.tmpdir(), 'FengzhuAgentBridge', 'uploads');
}

function isAllowedUploadPath(value) {
  try { validateUploadPath(value); return true; } catch { return false; }
}

function validateUploadPath(value) {
  const root = uploadRoot();
  const target = path.resolve(String(value || ''));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Attachment path is outside the khLink upload directory');
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('khLink upload root cannot be a link or junction');
  let current = root;
  const relative = path.relative(root, target);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Attachment links and junctions are not allowed');
  }
  return target;
}

function detectImageMime(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (data.length >= 2 && data.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  return null;
}

function isImageAttachment(item) {
  if (String(item?.mimeType || '').toLowerCase().startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(item?.name || item?.path || '');
}

module.exports = { AttachmentStore, detectImageMime, isImageAttachment, validateUploadPath, MAX_IMAGE_BYTES };
