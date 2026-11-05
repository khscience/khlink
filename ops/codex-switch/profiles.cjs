'use strict';
// Local directory registry only. Authentication files are owned exclusively by
// the official app; this module never opens, copies or exports them.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = 'G:\\Apps\\CodexSwitch';
const ID = /^account-[a-f0-9]{16}$/;
function visibleName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 32 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('名称需为 1–32 个可见字符。');
  return value.trim();
}
function plainPath(file) {
  const resolved = path.resolve(file), parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { const st = fs.lstatSync(cursor); if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) throw new Error('管理目录包含链接，已停止操作。'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return resolved;
}
function readJson(file, fallback) {
  plainPath(file);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 262144) throw new Error('本地账号记录无效。');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('本地账号记录损坏，请保留目录并检查。'); }
}
function atomic(file, value) {
  plainPath(file);
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
function protectRoot(root) {
  if (process.platform !== 'win32') return;
  const who = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' });
  const sid = who.match(/S-1-5-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error('无法确认本地目录权限，尚未创建账号。');
  execFileSync('icacls.exe', [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' });
}
class Profiles {
  constructor({ root = ROOT, defaultHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), protect = protectRoot } = {}) {
    this.root = plainPath(root); this.defaultHome = path.resolve(defaultHome); this.protect = protect;
  }
  file(name) { if (!/^[a-z0-9.-]+$/i.test(name)) throw new Error('无效的记录名。'); return plainPath(path.join(this.root, name)); }
  init() {
    plainPath(this.root);
    if (!fs.existsSync(this.file('accounts.json'))) {
      if (fs.existsSync(this.root) && fs.readdirSync(this.root).some(x => !['profiles'].includes(x))) throw new Error('账号目录已有未知内容，未接管或覆盖。');
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }); this.protect(this.root);
      fs.writeFileSync(this.file('accounts.json'), JSON.stringify({ version: 1, defaultName: '默认账号', selected: 'default', profiles: [] }), { flag: 'wx', mode: 0o600 });
    }
    return this.config();
  }
  config() {
    const c = readJson(this.file('accounts.json'), { version: 1, defaultName: '默认账号', selected: 'default', profiles: [] });
    const removed = c.removedProfiles ?? [];
    if (c.version !== 1 || !Array.isArray(c.profiles) || !Array.isArray(removed) || c.profiles.length > 30 || removed.length > 100 || new Set([...c.profiles, ...removed].map(p => p.id)).size !== c.profiles.length + removed.length) throw new Error('账号登记格式无效。');
    visibleName(c.defaultName);
    for (const p of c.profiles) if (!ID.test(p.id) || visibleName(p.name) !== p.name || !Number.isFinite(p.createdAt)) throw new Error('账号登记无效。');
    for (const p of removed) if (!ID.test(p.id) || visibleName(p.name) !== p.name || !Number.isFinite(p.createdAt) || !Number.isFinite(p.removedAt) || p.removedAt <= 0) throw new Error('已移除账号登记无效。');
    if (c.selected !== 'default' && !c.profiles.some(p => p.id === c.selected)) throw new Error('选中的账号未登记。');
    return c;
  }
  profile(id, c = this.config()) {
    if (id === 'default') return { id, name: c.defaultName, home: this.defaultHome, userData: null, primary: true };
    if (!ID.test(id) || !c.profiles.some(p => p.id === id)) throw new Error('该账号未登记。');
    const base = plainPath(path.join(this.root, 'profiles', id));
    const home = plainPath(path.join(base, 'codex-home')), userData = plainPath(path.join(base, 'desktop'));
    if (!fs.statSync(home).isDirectory() || !fs.statSync(userData).isDirectory()) throw new Error('账号目录缺失，未启动官方程序。');
    return { ...c.profiles.find(p => p.id === id), home, userData, primary: false };
  }
  locked(action) {
    this.init(); const lock = this.file('operation.lock'); let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch { throw new Error('已有账号操作正在执行，请稍后重试。'); }
    try { return action(this.config()); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  create(name) {
    name = visibleName(name);
    return this.locked(c => {
      if (c.profiles.length >= 30) throw new Error('最多管理 30 个备用账号。');
      const id = 'account-' + crypto.randomBytes(8).toString('hex');
      const base = plainPath(path.join(this.root, 'profiles', id));
      fs.mkdirSync(path.join(base, 'codex-home'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(base, 'desktop'), { mode: 0o700 });
      // Official login writes into this new, isolated home. No auth material is
      // imported from the original account or placed in KH Link metadata.
      fs.writeFileSync(path.join(base, 'codex-home', 'config.toml'), 'cli_auth_credentials_store = "file"\n', { flag: 'wx', mode: 0o600 });
      c.profiles.push({ id, name, createdAt: Date.now() }); atomic(this.file('accounts.json'), c);
      return this.profile(id, c);
    });
  }
  rename(id, name) { name = visibleName(name); return this.locked(c => { this.profile(id, c); if (id === 'default') c.defaultName = name; else c.profiles.find(p => p.id === id).name = name; atomic(this.file('accounts.json'), c); }); }
  remove(id) { return this.locked(c => {
    if (id === 'default') throw new Error('默认 Codex 账号用于手机连接，不能从列表移除。');
    const item = c.profiles.find(p => p.id === id);
    if (!ID.test(id) || !item) throw new Error('该账号未登记或已移除。');
    if ((c.removedProfiles || []).length >= 100) throw new Error('已移除记录已满，请先恢复需要保留的账号。');
    c.removedProfiles = [...(c.removedProfiles || []), { ...item, removedAt: Date.now() }];
    c.profiles = c.profiles.filter(p => p.id !== id);
    if (c.selected === id) c.selected = 'default';
    atomic(this.file('accounts.json'), c);
  }); }
  restore(id) { return this.locked(c => {
    const item = (c.removedProfiles || []).find(p => p.id === id);
    if (!ID.test(id) || !item) throw new Error('该账号不在已移除列表中。');
    if (c.profiles.length >= 30) throw new Error('最多管理 30 个备用账号，请先移除不需要的账号。');
    const { removedAt, ...profile } = item;
    const next = { ...c, profiles: [...c.profiles, profile], removedProfiles: c.removedProfiles.filter(p => p.id !== id) };
    this.profile(id, next); // Validate retained directories without opening their contents.
    atomic(this.file('accounts.json'), next);
  }); }
  select(id) { return this.locked(c => { this.profile(id, c); c.selected = id; atomic(this.file('accounts.json'), c); }); }
  records() { return readJson(this.file('usage.json'), {}); }
  saveRecord(id, record) { return this.locked(c => { this.profile(id, c); const records = this.records(); records[id] = record; atomic(this.file('usage.json'), records); }); }
  state() {
    const c = this.config(), records = this.records();
    return { root: this.root, selected: c.selected,
      removedProfiles: (c.removedProfiles || []).map(({id,name,removedAt})=>({id,name,removedAt})),
      profiles: ['default', ...c.profiles.map(p => p.id)].map(id => {
        try { return { ...this.profile(id, c), record: records[id] || null }; }
        catch { return { id, name: c.profiles.find(p=>p.id===id)?.name || c.defaultName, primary: id === 'default', directoryMissing: true, record: null }; }
      }) };
  }
}
module.exports = { Profiles, ROOT, visibleName, plainPath, atomic };
