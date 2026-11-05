'use strict';
const path = require('node:path');

// Claude Desktop's SendUserFile puts files on the reply's outer card (an image
// shown, a video to play). The phone gets them as one "sentFiles" item with
// the paths only; it fetches a picture itself and a video only when tapped.
const TOOL = 'SendUserFile';
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|svg)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i;
const MAX_FILES = 20;

function fileKind(file, mimeType = '') {
  if (/^image\//i.test(mimeType) || IMAGE.test(file)) return 'image';
  if (/^video\//i.test(mimeType) || VIDEO.test(file)) return 'video';
  return 'file';
}

function sentFile(entry) {
  const file = typeof entry === 'string' ? entry : entry?.path;
  if (typeof file !== 'string' || !file.trim()) return null;
  const mimeType = typeof entry?.media_type === 'string' ? entry.media_type : '';
  return {
    path: file, name: path.win32.basename(file) || file, kind: fileKind(file, mimeType),
    ...(Number.isFinite(entry?.size) ? { size: entry.size } : {}), ...(mimeType ? { mimeType } : {}),
  };
}

function sentFilesItem(block, base) {
  if (block?.name !== TOOL) return null;
  const input = block.input || {};
  const files = (Array.isArray(input.files) ? input.files : []).slice(0, MAX_FILES).map(sentFile).filter(Boolean);
  if (!files.length) return null;
  const caption = typeof input.caption === 'string' ? input.caption.trim().slice(0, 2000) : '';
  return { ...base, type: 'sentFiles', tool: TOOL, status: 'inProgress', text: caption, files };
}

// The tool result names what was delivered, with sizes and types.
function deliveredFiles(card, result, isError) {
  const delivered = (Array.isArray(result?.attachments) ? result.attachments : []).slice(0, MAX_FILES).map(sentFile).filter(Boolean);
  const caption = typeof result?.caption === 'string' && result.caption.trim() ? result.caption.trim().slice(0, 2000) : card.text;
  return { ...card, text: caption, files: delivered.length ? delivered : card.files, status: isError ? 'failed' : 'completed' };
}

module.exports = { TOOL, sentFilesItem, deliveredFiles, fileKind };
