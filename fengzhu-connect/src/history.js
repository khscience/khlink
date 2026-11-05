const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stripRequestMarker } = require('./request-marker');

// Codex imageGeneration.result is a plain base64 string.  Generated PNGs can
// be several megabytes (the app-server item itself is not a data URI), so the
// old 900k limit silently discarded otherwise valid images.
const MAX_INLINE_IMAGE_CHARS = 6_000_000;
const MAX_INLINE_IMAGE_TOTAL_CHARS = 8_000_000;

function clip(value, max = 64 * 1024) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (text.length <= max) return { text, truncated: false };
  const half = Math.floor(max / 2); return { text: `${text.slice(0, half)}\n\n[output truncated]\n\n${text.slice(-half)}`, truncated: true };
}

const INTERNAL_CONTEXT_TAGS = /^<(environment_context|recommended_plugins|in-app-browser-context|app-context|skills_instructions|permissions instructions|collaboration_mode|apps_instructions|plugins_instructions|multi_agent_mode|multi_agent_role)(?:\s|>)/i;
// Context Codex injects for the model: known tags, or any message that is one
// whole <tag>...</tag> block (new tags keep appearing between releases).
// Visible whole-block messages also include the plan returned after answering
// a blocking Plan-mode question. It is assistant output, not injected context.
const USER_BLOCK_TAGS = new Set(['image', 'send_user_message_question_reply', 'proposed_plan']);

function stripProposedPlanMarkup(value) {
  return String(value || '').replace(/^\s*<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>\s*$/i, '$1');
}

function isInternalContextText(value) {
  const text = String(value || '').trim();
  if (INTERNAL_CONTEXT_TAGS.test(text)) return true;
  // The project's AGENTS.md, which Codex sends as a user message (again after each compaction).
  if (/^# AGENTS\.md instructions for /.test(text)) return true;
  const open = text.match(/^<([a-z][a-z0-9_-]{2,60})(?:\s[^>]*)?>/i);
  return Boolean(open) && !USER_BLOCK_TAGS.has(open[1].toLowerCase()) && text.endsWith(`</${open[1]}>`);
}

// Codex can serialize a localImage input in rollout/history text as an XML
// fragment such as `<image name=[Image #1] path="C:\\Users\\...">`.
// That fragment is an implementation detail, not user content.  Keeping it
// in the mobile history both exposes a Windows path and makes a pure-image
// message render as a wall of markup instead of an attachment preview.
const LOCAL_IMAGE_BLOCK_RE = /<image\b[^>]*>[\s\S]*?<\/image\s*>/gi;
const LOCAL_IMAGE_TAG_RE = /<image\b[^>]*\/?>/gi;

function stripLocalImageMarkup(value) {
  return stripRequestMarker(value)
    .replace(LOCAL_IMAGE_BLOCK_RE, '')
    .replace(LOCAL_IMAGE_TAG_RE, '')
    .replace(/<\/image\s*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasLocalImageMarkup(value) {
  return typeof value === 'string' && /<\/?image\b/i.test(value);
}

function normalizeThread(thread) {
  const rawStatus = thread.status;
  const statusType = typeof rawStatus === 'object' && rawStatus ? rawStatus.type || rawStatus.state : rawStatus;
  const status = statusType === 'notLoaded' ? 'idle' : statusType || 'idle';
  const toMillis = (value) => { const number = Number(value) || 0; return number > 0 && number < 1e12 ? number * 1000 : number; };
  const pinOrder = Number(thread._fengzhuPinOrder);
  return { id: thread.id, title: thread.name || thread.preview || 'Codex task', cwd: thread.cwd || '',
    status, createdAt: toMillis(thread.createdAt), updatedAt: toMillis(thread.updatedAt),
    archived: Boolean(thread.archived), model: thread.model || null,
    pinned: Boolean(thread._fengzhuPinned), pinOrder: Number.isFinite(pinOrder) ? pinOrder : -1,
    unread: Boolean(thread._fengzhuUnread) };
}

function desktopPinState(value) {
  const memberIds = Array.isArray(value?.['pinned-thread-ids']) ? value['pinned-thread-ids'].filter((id) => typeof id === 'string') : [];
  const members = new Set(memberIds);
  const rawOrder = value?.['electron-persisted-atom-state']?.['unified-sidebar-pinned-order-v1'];
  const ordered = Array.isArray(rawOrder) ? rawOrder.map((entry) => {
    const match = String(entry).match(/^codex:thread:local:([0-9a-f-]{36})$/i);
    return match?.[1] || null;
  }).filter((id) => id && members.has(id)) : [];
  const uniqueOrdered = [];
  const seen = new Set();
  for (const id of ordered) if (!seen.has(id)) { seen.add(id); uniqueOrdered.push(id); }
  for (const id of memberIds) if (!seen.has(id)) { seen.add(id); uniqueOrdered.push(id); }
  const unreadIds = desktopUnreadIds(value);
  return { ids: uniqueOrdered, orderById: Object.fromEntries(uniqueOrdered.map((id, index) => [id, index])), unreadIds };
}

// Threads the desktop sidebar shows with an unread dot. Current Codex keeps
// them in electron-thread-read-state-v1, keyed by account identity and then by
// host ("local" or "local:<hash>"); older builds used a flat per-host list.
function desktopUnreadIds(value) {
  const ids = new Set();
  const add = (list) => { if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') ids.add(id); };
  const byIdentity = value?.['electron-thread-read-state-v1']?.unreadByIdentity;
  if (byIdentity && typeof byIdentity === 'object') {
    for (const hosts of Object.values(byIdentity)) {
      if (!hosts || typeof hosts !== 'object') continue;
      for (const [host, list] of Object.entries(hosts)) if (host === 'local' || host.startsWith('local:')) add(list);
    }
  } else {
    add(value?.['electron-persisted-atom-state']?.['unread-thread-ids-by-host-v1']?.local);
  }
  return [...ids];
}

// Polled every 2 s; the file is ~400 KB, so re-read it only when it changed.
const desktopPinCache = new Map(); // file -> { mtimeMs, size, value }
function readDesktopPinState(file) {
  const fs = require('node:fs');
  let stat; try { stat = fs.statSync(file); } catch { desktopPinCache.delete(file); return null; }
  const cached = desktopPinCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
  let value; try { value = desktopPinState(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
  desktopPinCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function applyDesktopPin(thread, pins) {
  const order = pins?.orderById?.[thread.id];
  return { ...thread, _fengzhuPinned: Number.isInteger(order), _fengzhuPinOrder: Number.isInteger(order) ? order : -1,
    _fengzhuUnread: Boolean(pins?.unreadIds?.includes(thread.id)) };
}

function extractInlineImages(value) {
  const images = [];
  const seen = new Set();
  let totalChars = 0;

  const mimeTypeFromName = (name) => {
    switch (path.extname(String(name || '')).toLowerCase()) {
      case '.jpg': case '.jpeg': return 'image/jpeg';
      case '.webp': return 'image/webp';
      case '.gif': return 'image/gif';
      case '.bmp': return 'image/bmp';
      case '.avif': return 'image/avif';
      default: return 'image/png';
    }
  };

  const normalizeDataUri = (candidate, fallbackMime = 'image/png') => {
    if (typeof candidate !== 'string') return null;
    const text = candidate.trim();
    if (!text) return null;
    const dataUri = text.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
    if (dataUri) {
      const data = `data:${dataUri[1].toLowerCase()};base64,${dataUri[2].replace(/\s+/g, '')}`;
      return data;
    }
    const base64 = text.replace(/\s+/g, '');
    if (!/^[a-z0-9+/]+={0,2}$/i.test(base64) || base64.length < 16) return null;
    return `data:${fallbackMime};base64,${base64}`;
  };

  const add = (candidate, fallbackMime = 'image/png') => {
    const data = normalizeDataUri(candidate, fallbackMime);
    if (!data || !/^data:image\//i.test(data) || seen.has(data)) return;
    if (data.length > MAX_INLINE_IMAGE_CHARS || totalChars + data.length > MAX_INLINE_IMAGE_TOTAL_CHARS) return;
    seen.add(data); totalChars += data.length;
    images.push({ data, mimeType: data.slice(5, data.indexOf(';')).toLowerCase() });
  };

  const imageGeneration = (current) => {
    if (!current || typeof current !== 'object' || !/image[_-]?generation/i.test(String(current.type || ''))) return;
    const fallbackMime = String(current.mimeType || current.mediaType || '').toLowerCase().startsWith('image/')
      ? String(current.mimeType || current.mediaType).toLowerCase()
      : mimeTypeFromName(current.savedPath || current.saved_path);
    for (const candidate of [current.result, current.b64_json, current.base64, current.image, current.data]) {
      if (typeof candidate === 'string' && candidate.trim()) { add(candidate, fallbackMime); return; }
    }
    const savedPath = current.savedPath || current.saved_path;
    if (typeof savedPath !== 'string' || !savedPath) return;
    try {
      const stat = fs.statSync(savedPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 5 * 1024 * 1024) return;
      add(fs.readFileSync(savedPath).toString('base64'), fallbackMime);
    } catch {
      // The path may belong to another machine or may have been cleaned up;
      // the inline result is preferred and the absence is non-fatal.
    }
  };

  const visit = (current) => {
    if (!current || images.length >= 6) return;
    if (typeof current === 'string') {
      const text = current.trim();
      if (/^data:image\//i.test(text)) add(text);
      else if (text.startsWith('{') || text.startsWith('[')) {
        try { visit(JSON.parse(text)); } catch { /* ordinary tool text */ }
      }
      return;
    }
    if (Array.isArray(current)) { current.forEach(visit); return; }
    if (typeof current !== 'object') return;
    imageGeneration(current);
    for (const key of ['image_url', 'imageUrl', 'imageData', 'data']) {
      const candidate = typeof current[key] === 'object' ? current[key]?.url : current[key];
      if (typeof candidate === 'string' && /^data:image\//i.test(candidate)) add(candidate);
    }
    for (const [key, child] of Object.entries(current)) {
      if (!['image_url', 'imageUrl', 'imageData', 'data', 'result', 'b64_json', 'base64', 'image', 'savedPath', 'saved_path'].includes(key)) visit(child);
    }
  };
  visit(value);
  return images;
}

function hasGeneratedImageMarker(value) {
  if (typeof value === 'string') return /generated[_ ]images?\s+are\s+saved|image[_-]?generation|imagegen/i.test(value);
  if (Array.isArray(value)) return value.some(hasGeneratedImageMarker);
  if (!value || typeof value !== 'object') return false;
  if (/image[_-]?generation/i.test(String(value.type || value.name || ''))) return true;
  return Object.entries(value).some(([key, child]) => {
    if (/^(image_url|imageUrl|imageData|data)$/i.test(key)) return false;
    return hasGeneratedImageMarker(child);
  });
}

function displayText(value) {
  if (typeof value === 'string') return stripLocalImageMarkup(value);
  if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return value == null ? '' : String(value);
  if (/image[_-]?generation/i.test(String(value.type || ''))) return '';
  if (typeof value.text === 'string') return stripLocalImageMarkup(value.text);
  if (value.type === 'input_image' || value.image_url || value.imageUrl || value.imageData) return '';
  if (value.content !== undefined) return displayText(value.content);
  if (value.output !== undefined) return displayText(value.output);
  return stripLocalImageMarkup(JSON.stringify(value, (key, child) => /^(image_url|imageUrl|imageData|data)$/i.test(key) && typeof child === 'string' ? undefined : child));
}

function normalizeItems(thread, limit = null) {
  const source = [];
  for (const turn of thread.turns || []) {
    for (const item of turn.items || []) {
      const type = item.type || 'unknown';
      if (!['userMessage','agentMessage','plan','reasoning','commandExecution','fileChange','mcpToolCall','webSearch','imageView','imageGeneration','function_call_output','custom_tool_call_output','collabAgentToolCall','contextCompaction','error'].includes(type)) continue;
      if ((type === 'userMessage' || type === 'agentMessage') && isInternalContextText(item.text ?? item.content)) continue;
      source.push({ turn, item, type });
    }
  }
  const selected = Number.isInteger(limit) && limit > 0 ? source.slice(-limit) : source;
  const result = []; let order = source.length - selected.length;
  for (const { turn, item, type } of selected) {
      const images = extractInlineImages(item);
      const generated = images.length && (/image[_-]?generation/i.test(type) || hasGeneratedImageMarker(item));
      const displayType = images.length && (type === 'function_call_output' || type === 'custom_tool_call_output')
        ? (generated ? 'imageGeneration' : 'imageView') : type;
      const fallbackText = images.length
        ? (generated ? '图片已生成' : '在电脑端查看了图片')
        : hasLocalImageMarkup(item.text ?? item.content ?? item.output)
          ? '图片附件'
        : '';
      const content = clip(type === 'contextCompaction' ? '上下文已自动压缩' : stripProposedPlanMarkup(displayText(item.text ?? item.content ?? item.output ?? item) || fallbackText));
      result.push({ id: item.id || crypto.createHash('sha256').update(`${thread.id}|${order}|${content.text}`).digest('hex'),
        order: ++order, createdAt: turn.createdAt || thread.updatedAt || Date.now(), value: {
          type: displayType, ...content, status: item.status || null, ...(images.length ? { images } : {})
        } });
  }
  return result;
}

module.exports = { clip, extractInlineImages, hasGeneratedImageMarker, hasLocalImageMarkup, stripLocalImageMarkup, stripProposedPlanMarkup, isInternalContextText, normalizeThread, normalizeItems, desktopPinState, readDesktopPinState, applyDesktopPin };
