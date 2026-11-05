'use strict';
// Only khLink-owned directory registration and labels. Never opens profile data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const share = require('./session-share.cjs');
const catalog = require('./catalog.cjs');
const ALIAS = /^[a-z][a-z0-9-]{0,31}$/;
const DIRECTORY = /^claude-code-sessions[\\/][a-zA-Z0-9_-]+[\\/][a-zA-Z0-9_-]+$/;
const ROOT = 'G:\\Apps\\ClaudeSwitch';
const MESSAGES = {
  registry_current: '当前 Claude 账号不能移除，请先切换到其他账号。',
  registry_busy: '正在切换或恢复账号，请稍后重试。',
  registry_writing: '正在修改账号列表，请稍后重试。',
  registry_missing: '该账号未登记或已移除。',
  registry_restore_missing: '该账号不在已移除列表中。',
  registry_directory: '账号数据目录不可用，请检查后再恢复。',
  registry_invalid: '账号登记暂时无法确认，尚未修改，请检查本机数据目录。',
};
function validateRemoved(config) {
  const rows = config.removedProfiles ?? {};
  if (!rows || typeof rows !== 'object' || Array.isArray(rows) || Object.keys(rows).length > 100) throw new Error('已移除账号记录无效。');
  for (const [id, row] of Object.entries(rows)) {
    if (!ALIAS.test(id) || Object.hasOwn(config.profiles, id) || !DIRECTORY.test(row?.directory || '') || !Number.isFinite(row.removedAt) || row.removedAt <= 0) throw new Error('已移除账号记录无效。');
  }
  return rows;
}
function nameFor(id, names, index = 0) { return names && Object.hasOwn(names, id) && typeof names[id] === 'string' && names[id].trim() ? names[id] : (id === 'primary' ? '主账号' : id === 'secondary' ? '备用账号' : `账号 ${index + 1}`); }
function removedRows(config, names = {}) {
  return Object.entries(validateRemoved(config)).map(([id, row], index) => ({ id, name: nameFor(id, names, index), removedAt: row.removedAt }));
}
function atomic(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
class Registry {
  constructor({ root = ROOT, current, now = Date.now } = {}) { this.root = root; this.current = current || (config => catalog.current(config,catalog.pending(this.root))); this.now = now; }
  file(name) { return share.safePath(this.root, 'shared/' + name); }
  config(options = { allowMissing:true, allowEmpty:true }) {
    const file = this.file('config.json'), st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1 || st.size > 32768) throw new Error('本地账号登记无效。');
    const config = catalog.config(this.root, options);
    if (path.resolve(config.root) !== path.resolve(this.root)) throw new Error('账号管理目录不一致。');
    validateRemoved(config); return config;
  }
  locked(action, options = { allowMissing:true, allowEmpty:true }) {
    const switchLock = this.file('desktop-switch.lock');
    if (fs.existsSync(switchLock)) throw new Error('正在切换或恢复账号，请稍后重试。');
    const lock = this.file('profile-registry.lock'); let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch { throw new Error('正在修改账号列表，请稍后重试。'); }
    const lease = this.file(`desktop-operation-${process.pid}-${crypto.randomUUID()}.lock`); let leaseFd;
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: this.now() }));
      // Switch claims its own lock before checking these leases. The second
      // check closes the race whichever operation acquired its file first.
      leaseFd = fs.openSync(lease, 'wx', 0o600);
      fs.writeFileSync(leaseFd, JSON.stringify({ pid: process.pid, startedAt: this.now() }));
      if (fs.existsSync(switchLock)) throw new Error('正在切换或恢复账号，请稍后重试。');
      return action(this.config(options));
    } finally {
      if (leaseFd !== undefined) { fs.closeSync(leaseFd); fs.unlinkSync(lease); }
      fs.closeSync(fd); fs.unlinkSync(lock);
    }
  }
  remove(id) {
    return this.locked(config => {
      if (!ALIAS.test(id) || (!Object.hasOwn(config.profiles, id) && !Object.hasOwn(config.unavailableProfiles || {},id))) throw new Error('该账号未登记或已移除。');
      const active = this.current(config);
      if (!active) throw new Error('当前账号无法确认，已停止移除。');
      if (id === active) throw new Error('当前 Claude 账号不能移除，请先切换到其他账号。');
      if (Object.keys(config.profiles).length + Object.keys(config.unavailableProfiles || {}).length <= 1) throw new Error('至少需要保留一个 Claude 账号。');
      const removed = validateRemoved(config);
      if (Object.keys(removed).length >= 100) throw new Error('已移除记录已满，请先恢复需要保留的账号。');
      config.removedProfiles = { ...removed, [id]: { directory: config.profiles[id] || config.unavailableProfiles[id].directory, removedAt: this.now() } };
      delete config.profiles[id]; if(config.unavailableProfiles)delete config.unavailableProfiles[id]; atomic(this.file('config.json'), config);
    });
  }
  restore(id) {
    return this.locked(config => {
      const removed = validateRemoved(config);
      if (!ALIAS.test(id) || !Object.hasOwn(removed, id)) throw new Error('该账号不在已移除列表中。');
      if (!this.current(config)) throw new Error('当前账号无法确认，已停止恢复。');
      config.profiles[id] = removed[id].directory;
      delete removed[id]; config.removedProfiles = removed;
      try { share.validateConfig(config); } catch { throw new Error(MESSAGES.registry_directory); }
      atomic(this.file('config.json'), config);
    });
  }
  rename(id, name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 32 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('名称需为 1–32 个可见字符。');
    return this.locked(config => {
      if (!Object.hasOwn(config.profiles, id) && !Object.hasOwn(config.unavailableProfiles || {},id)) throw new Error('该账号未登记或已移除。');
      const file = this.file('labels.json'); let names = {};
      if (fs.existsSync(file)) { const st = fs.lstatSync(file); if (!st.isFile() || st.nlink !== 1 || st.size > 32768) throw new Error('本地备注记录无效。'); names = JSON.parse(fs.readFileSync(file, 'utf8')); }
      atomic(file, { ...names, [id]: name.trim() });
    });
  }
}
module.exports = { Registry, removedRows, validateRemoved, nameFor, MESSAGES };
