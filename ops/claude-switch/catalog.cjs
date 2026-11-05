'use strict';
// khLink registration and Code directory metadata only; never reads login data.
const fs = require('node:fs');
const path = require('node:path');
const share = require('./session-share.cjs');
const ALIAS = /^[a-z][a-z0-9-]{0,31}$/;
const DIRECTORY = /^claude-code-sessions[\\/][a-zA-Z0-9_-]+[\\/][a-zA-Z0-9_-]+$/;
function json(root, relative, fallback = null) {
  const bytes = share.read(root, relative);
  if (bytes === null) return fallback;
  if (bytes.length > 65536) throw new Error('账号登记记录过大，已停止操作。');
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('账号登记记录无效，已停止操作。'); }
}
function config(root, options = {}) {
  const value = json(root, 'shared/config.json');
  if (!value || path.resolve(value.root || '') !== path.resolve(root)) throw new Error('账号管理目录不一致。');
  share.validateConfig(value, options);
  const unavailable = value.unavailableProfiles ?? {};
  if (!unavailable || typeof unavailable !== 'object' || Array.isArray(unavailable) || Object.keys(unavailable).length > 100) throw new Error('不可用账号登记无效。');
  for (const [id, row] of Object.entries(unavailable)) {
    if (!ALIAS.test(id) || Object.hasOwn(value.profiles, id) || Object.hasOwn(value.removedProfiles || {}, id) || !DIRECTORY.test(row?.directory || '')) throw new Error('不可用账号登记无效。');
  }
  return value;
}
function pending(root) {
  const value = json(root, 'shared/onboarding.json', { version: 1, profiles: {} });
  if (value?.version !== 1 || !value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles) || Object.keys(value.profiles).length > 100) throw new Error('待登录账号登记无效。');
  for (const [id, row] of Object.entries(value.profiles)) {
    if (!ALIAS.test(id) || row?.id !== id || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 32 || /[\x00-\x1f\x7f]/.test(row.name) || !Number.isFinite(row.createdAt) ||
        !['created', 'login', 'adopted', 'removed'].includes(row.phase) || (row.from != null && !ALIAS.test(row.from))) throw new Error('待登录账号登记无效。');
  }
  return value;
}
function current(config, additions = { profiles: {} }) {
  try {
    const st = fs.lstatSync(config.activeLink);
    if (!st.isSymbolicLink()) return null;
    // readlink also recognises a preserved, dangling link. It never resolves or
    // opens a missing account directory, and accepts only registered targets.
    const target = path.resolve(fs.readlinkSync(config.activeLink)).toLowerCase();
    const aliases = new Set([...Object.keys(config.profiles), ...Object.keys(config.unavailableProfiles || {}), ...Object.keys(additions.profiles)]);
    return [...aliases].find(id => path.resolve(config.root, 'profiles', id).toLowerCase() === target) || null;
  } catch { return null; }
}
function directoryExists(root, alias, relative) {
  const directory = share.safePath(root, path.join('profiles', alias, relative));
  try { return fs.statSync(directory).isDirectory(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
module.exports = { ALIAS, DIRECTORY, json, config, pending, current, directoryExists };
