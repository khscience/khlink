'use strict';
// Empty-profile enrollment. Only khLink metadata and exact Code-index paths.
// Official Desktop performs login; no credential files or network requests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const catalog = require('./catalog.cjs');
const share = require('./session-share.cjs');
const { Registry } = require('./registry.cjs');
const MESSAGES = {
  onboarding_exit_required: '请保存工作并正常退出 Claude，再继续添加账号。不会强制退出。',
  onboarding_pending: '请先在电脑 khLink 完成新账号登录，或返回添加前的状态。',
  onboarding_no_code: '请先在官方 Claude 登录并打开 Code 页，然后正常退出 Claude，再点击完成添加。',
  onboarding_ambiguous: '发现多个 Code 账号目录，暂时无法确认本次登录，请在电脑检查。',
  onboarding_directory: '账号或共享目录不可用，尚未覆盖原目录。',
  onboarding_busy: '正在处理另一个账号，请稍后重试。',
  onboarding_missing: '待登录账号未登记或已移除。',
  onboarding_shared_conflict: '共享会话或置顶同步未完成，数据已保留，请检查后重试。',
};
function fault(code) { return Object.assign(new Error(MESSAGES[code]), { code }); }
function atomic(root, relative, value) {
  const file = share.safePath(root, relative), temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
function protect(directory) {
  if (process.platform !== 'win32') return;
  const who = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' });
  const sid = who.match(/S-1-5-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw fault('onboarding_directory');
  execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' });
}
class Onboarding {
  constructor({ root = 'G:\\Apps\\ClaudeSwitch', protectDirectory = protect, now = Date.now, guard, synchronizeSidebar, globalProjects = path.join(process.env.USERPROFILE || '', '.claude', 'projects') } = {}) {
    this.root = root; this.protect = protectDirectory; this.now = now; this.guard = guard || (() => { throw fault('onboarding_exit_required'); }); this.globalProjects = globalProjects;
    this.sidebar = synchronizeSidebar || ((config, from, guard) => require('./sidebar.cjs').synchronize(config, from, guard));
  }
  config() { return catalog.config(this.root, { allowMissing: true, allowEmpty: true }); }
  store() { return catalog.pending(this.root); }
  save(store) { atomic(this.root, 'shared/onboarding.json', store); }
  profile(id) {
    if (!catalog.ALIAS.test(id)) throw fault('onboarding_missing');
    const row = this.store().profiles[id];
    if (!row || row.phase === 'removed') throw fault('onboarding_missing');
    return row;
  }
  candidates(id) {
    this.profile(id);
    const relative = path.join('profiles', id, 'claude-code-sessions'), directory = share.safePath(this.root, relative);
    if (!fs.existsSync(directory)) return [];
    const result = [], accounts = fs.readdirSync(directory, { withFileTypes: true });
    if (accounts.length > 64) throw fault('onboarding_ambiguous');
    for (const account of accounts) {
      if (!account.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(account.name)) continue;
      const accountDirectory = share.safePath(this.root, path.join(relative, account.name));
      const organizations = fs.readdirSync(accountDirectory, { withFileTypes: true });
      if (organizations.length > 64) throw fault('onboarding_ambiguous');
      for (const organization of organizations) {
        if (!organization.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(organization.name)) continue;
        const code = path.join('claude-code-sessions', account.name, organization.name);
        const candidate = share.safePath(this.root, path.join('profiles', id, code));
        if (!fs.lstatSync(candidate).isDirectory()) throw fault('onboarding_directory');
        result.push(code);
        if (result.length > 1) return result;
      }
    }
    return result;
  }
  create(name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 32 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('名称需为 1–32 个可见字符。');
    const registry = new Registry({ root: this.root });
    return registry.locked(config => {
      const store = this.store();
      if (Object.keys(config.profiles).length + Object.keys(config.unavailableProfiles || {}).length + Object.values(store.profiles).filter(row => row.phase !== 'removed').length >= 30) throw new Error('最多管理 30 个 Claude 账号。');
      if (Object.values(store.profiles).some(row => row.phase === 'login' || row.phase === 'adopted')) throw fault('onboarding_pending');
      const next = { ...config, profiles: { ...config.profiles }, unavailableProfiles: { ...config.unavailableProfiles } };
      for (const [id, directory] of Object.entries(next.profiles)) {
        if (!catalog.directoryExists(this.root, id, directory)) { next.unavailableProfiles[id] = { directory }; delete next.profiles[id]; }
      }
      const id = 'account-' + crypto.randomBytes(8).toString('hex'), directory = share.safePath(this.root, path.join('profiles', id));
      fs.mkdirSync(share.safePath(this.root, 'profiles'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
      this.protect(directory);
      const row = { id, name: name.trim(), createdAt: this.now(), phase: 'created', from: null };
      atomic(this.root, path.join('profiles', id, 'khlink-profile.json'), { version: 1, id, createdAt: row.createdAt });
      store.profiles[id] = row;
      // Retain unavailable registrations; do not recreate their data folders.
      if (JSON.stringify(next) !== JSON.stringify(config)) atomic(this.root, 'shared/config.json', next);
      this.save(store); return { id };
    }, { allowMissing: true, allowEmpty: true });
  }
  owner(pid, id) {
    const lock = catalog.json(this.root, 'shared/desktop-switch.lock');
    const { alive, leases } = require(fs.existsSync(path.join(__dirname, 'account-operations.js')) ? './account-operations.js' : '../../fengzhu-connect/src/account-operations');
    if (!Number.isSafeInteger(pid) || lock?.pid !== pid || lock.kind !== 'onboarding' || lock.to !== id || !alive(pid) || leases(path.join(this.root, 'shared')).length) throw fault('onboarding_busy');
    this.guard();
  }
  ensureBodyLink() {
    const target = share.safePath(this.root, 'shared/code-projects'), link = this.globalProjects;
    const parent = path.dirname(link);
    if (fs.existsSync(parent) && (!fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink())) throw fault('onboarding_directory');
    let existing; try { existing = fs.lstatSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && (!existing.isSymbolicLink() || path.resolve(fs.readlinkSync(link)).toLowerCase() !== path.resolve(target).toLowerCase())) throw fault('onboarding_directory');
    this.guard(); fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    if (!existing) { fs.mkdirSync(parent, { recursive: true }); this.guard(); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    return target;
  }
  async prepare(id, pid) {
    this.owner(pid, id);
    const config = this.config(), store = this.store(), row = this.profile(id), active = catalog.current(config, store);
    const marker = catalog.json(this.root, path.join('profiles', id, 'khlink-profile.json'));
    if (marker?.id !== id || marker.createdAt !== row.createdAt) throw fault('onboarding_directory');
    if (active && active !== id && !Object.hasOwn(config.profiles, active) && !Object.hasOwn(config.unavailableProfiles || {}, active)) throw fault('onboarding_directory');
    if (row.phase === 'created') {
      if (active && config.profiles[active]) {
        share.execute(share.plan(config, { from: active }), { guard: this.guard });
        await this.sidebar(config, active, this.guard);
      }
      row.from = active;
    }
    this.ensureBodyLink(); this.guard();
    row.phase = 'login'; store.profiles[id] = row; this.save(store);
    return { from: row.from, target: id };
  }
  async complete(id, pid) {
    this.owner(pid, id);
    let config = this.config(); const store = this.store(), row = this.profile(id);
    if (catalog.current(config, store) !== id) throw fault('onboarding_directory');
    const candidates = this.candidates(id);
    if (candidates.length !== 1) throw fault(candidates.length ? 'onboarding_ambiguous' : 'onboarding_no_code');
    this.ensureBodyLink(); this.guard();
    try {
      // An account can open Code without creating its first conversation. Keep
      // the empty shared inventory usable by the sidebar transaction as well.
      fs.mkdirSync(share.safePath(this.root, 'shared/code-indexes'), {recursive:true,mode:0o700});
      const plan = share.enrollPlan(config, id, candidates[0]);
      share.execute(plan, { guard: this.guard }); config = plan.config;
      row.phase = 'adopted'; store.profiles[id] = row; this.save(store);
      await this.sidebar(config, row.from && config.profiles[row.from] ? row.from : id, this.guard);
    } catch (error) { if (error.code) throw error; throw fault('onboarding_shared_conflict'); }
    this.guard();
    const names = catalog.json(this.root, 'shared/labels.json', {});
    atomic(this.root, 'shared/labels.json', { ...names, [id]: row.name });
    store.profiles[id] = row; this.save(store);
    return { id, completed: true };
  }
  commit(id, pid) {
    this.owner(pid, id);
    const store = this.store(), row = this.profile(id), config = this.config();
    if (row.phase !== 'adopted' || !config.profiles[id] || catalog.current(config, store) !== id) throw fault('onboarding_pending');
    delete store.profiles[id]; this.guard(); this.save(store); return { id, completed: true };
  }
  returned(id, pid) {
    this.owner(pid, id); const store = this.store(), row = this.profile(id);
    // Index adoption may have committed before sidebar validation failed. A
    // returned, still-pending account must never poison ordinary switches by
    // remaining in their strict ready-profile set. Its files stay untouched.
    const config = this.config();
    if (config.profiles[id]) { delete config.profiles[id]; this.guard(); atomic(this.root, 'shared/config.json', config); }
    row.phase = 'created'; row.from = null; store.profiles[id] = row; this.save(store); return { id };
  }
  recover(id) {
    this.profile(id);
    const file = share.safePath(this.root, 'shared/desktop-switch.lock');
    if (!fs.existsSync(file)) return { recovered: false };
    const bytes = share.read(this.root, 'shared/desktop-switch.lock'), lock = catalog.json(this.root, 'shared/desktop-switch.lock');
    const { alive, leases } = require(fs.existsSync(path.join(__dirname, 'account-operations.js')) ? './account-operations.js' : '../../fengzhu-connect/src/account-operations');
    if (lock?.kind !== 'onboarding' || lock.to !== id || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || alive(lock.pid) || alive(lock.helperPid) || leases(path.join(this.root, 'shared')).length) throw fault('onboarding_busy');
    this.guard();
    if (!bytes.equals(share.read(this.root, 'shared/desktop-switch.lock'))) throw fault('onboarding_busy');
    fs.unlinkSync(file); return { recovered: true };
  }
  manage(action, id) {
    return new Registry({ root: this.root }).locked(config => {
      const store = this.store(), row = store.profiles[id];
      if (!row || !catalog.ALIAS.test(id)) throw fault('onboarding_missing');
      if (catalog.current(config, store) === id) throw fault('onboarding_pending');
      if (action === 'remove' && ['login','adopted'].includes(row.phase)) throw fault('onboarding_pending');
      if (action === 'remove' && row.phase !== 'removed') { row.previousPhase = row.phase; row.phase = 'removed'; row.removedAt = this.now(); }
      else if (action === 'restore' && row.phase === 'removed') { share.safePath(this.root, path.join('profiles', id)); if (!fs.statSync(share.safePath(this.root, path.join('profiles', id))).isDirectory()) throw fault('onboarding_directory'); row.phase = row.previousPhase === 'adopted' ? 'adopted' : 'created'; delete row.removedAt; delete row.previousPhase; }
      else throw fault('onboarding_missing');
      if (action === 'remove' && config.profiles[id]) { delete config.profiles[id]; atomic(this.root, 'shared/config.json', config); }
      this.save(store);
    }, { allowMissing: true, allowEmpty: true });
  }
}
module.exports = { Onboarding, MESSAGES, fault, atomic };
