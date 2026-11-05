'use strict';
// Shared by the connector and the desktop headless entry. This journal contains
// only local aliases and fixed reason codes, never account credentials/content.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = 'G:\\Apps\\ClaudeSwitch\\shared';
const PHASES = ['checking', 'closing', 'syncing', 'opening', 'done', 'failed'];
const MESSAGES = Object.freeze({
  checking: '正在检查账号与任务状态', closing: '正在正常退出 Claude', syncing: '正在同步会话与置顶', opening: '正在打开 Claude', done: '账号已切换',
  reopened: 'Claude 已重新打开',
  failed: '切换未完成', busy: '另一端正在切换账号', tasks_running: 'Claude 仍有运行中的任务', approval_pending: 'Claude 有等待确认的请求',
  messages_queued: '还有未发送的排队消息', settings_pending: '有尚未生效的设置', operation_active: '手机操作正在执行',
  status_unknown: '暂时无法确认所有 Claude 任务已空闲', schedule_pending: '存在已启用的定时任务，请先在 Claude 中暂停',
  locked: '电脑锁屏或没有可操作的桌面，无法切换', modal: '请先处理电脑上 Claude 的确认窗口',
  browser_extension_active: '浏览器的 Claude 扩展仍占用账号，请保存工作并正常退出相关浏览器后重试',
  exit_pending: 'Claude 辅助进程尚未正常退出，未切换账号，可重新打开 Claude',
  menu_unknown: '无法唯一识别 Claude 的正常退出菜单', version_changed: 'Claude 版本已变化，需要先验证兼容性',
  interrupted: '上次切换被中断，已停止后续操作', helper_timeout: '本地组件超时，正在等待组件退出后核对账号',
  link_unknown: '账号链接不一致，请在电脑上检查', launch_failed: '账号已切换，但 Claude 尚未打开', component_failed: '本地账号组件执行失败',
  request_conflict: '此请求编号已用于另一次操作', invalid_request: '账号请求无效', readonly: 'Codex 账号本期只读',
  repairing: '正在恢复上次切换前的账号链接',
});
function fault(code, blockers = []) { return Object.assign(new Error(MESSAGES[code] || MESSAGES.component_failed), { code, blockers }); }
function alive(pid) { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
function read(file) { try { const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || s.size > 65536) return null; return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
function atomic(file, value) { const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); try { fs.renameSync(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } }
function leases(root = ROOT, { now = Date.now(), isAlive = alive } = {}) {
  if (!fs.existsSync(root)) return [];
  const active = [];
  for (const name of fs.readdirSync(root).filter(n => /^desktop-operation-\d+-[a-f0-9-]+\.lock$/.test(n))) {
    const file = path.join(root, name), row = read(file), pid = row?.pid || Number(name.split('-')[2]);
    const at = row?.startedAt || Number(fs.readFileSync(file, 'utf8'));
    if (!isAlive(pid) && at > 0 && now - at > 30000) { try { fs.unlinkSync(file); } catch { active.push(name); } }
    else active.push(name);
  }
  return active;
}
function blockers(snapshot, { now = Date.now(), active, isAlive = alive } = {}) {
  if (!snapshot || snapshot.active !== active || !isAlive(snapshot.pid) || now - snapshot.at > 15000 || snapshot.at > now + 1000 || snapshot.known !== true) return ['status_unknown'];
  return ['tasks_running', 'approval_pending', 'messages_queued', 'settings_pending', 'schedule_pending'].filter(k => Number(snapshot[k]) > 0);
}
class Operations {
  constructor(root = ROOT, options = {}) { this.root = root; this.now = options.now || Date.now; this.alive = options.isAlive || alive; this.lock = path.join(root, 'desktop-switch.lock'); }
  requestFile(id) { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw fault('invalid_request'); return path.join(this.root, 'operations', id + '.json'); }
  state(active, { recover = false } = {}) {
    const lock = read(this.lock), last = read(path.join(this.root, 'last-operation.json'));
    if (!fs.existsSync(this.lock)) return last || { busy: false };
    if (!lock || !lock.requestId) return { busy: true, phase: 'failed', code: 'interrupted', message: MESSAGES.interrupted, recovery: [] };
    const record = read(this.requestFile(lock.requestId)) || lock;
    if ((this.alive(lock.pid) && record.code !== 'helper_timeout' && !record.released) || this.alive(record.helperPid) || this.now() - lock.startedAt < 30000) return { ...record, busy: true };
    // An unresolved filesystem transaction is not a stale, safely removable lock.
    const transaction = read(path.join(this.root, 'link-transaction.json')), scriptFile = path.join(this.root, 'switch.lock'), script = read(scriptFile);
    const scriptBusy = fs.existsSync(scriptFile) && (!script || this.alive(script.pid) || this.alive(script.childPid));
    if (![lock.from, lock.to].includes(active) || (transaction && transaction.phase !== 'done' && transaction.phase !== 'rolled_back') || scriptBusy) {
      return { ...record, busy: true, phase: 'failed', code: 'link_unknown', message: MESSAGES.link_unknown,
        recovery: !scriptBusy && transaction && transaction.from === lock.from && transaction.to === (lock.transactionTo || lock.to) ? ['repair'] : [] };
    }
    const failed = { ...record, phase: 'failed', busy: false, code: 'interrupted', message: MESSAGES.interrupted, at: this.now(), recovery: ['reopen', 'switch_back'] };
    if (!recover) return failed; // Readers never race one another to remove locks.
    return this.recoveryGuard(() => {
      if (read(this.lock)?.requestId !== lock.requestId) return { busy: true, code: 'busy', message: MESSAGES.busy };
      if (script && fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile);
      this.save(failed); fs.unlinkSync(this.lock); return failed;
    });
  }
  recoveryGuard(action) {
    const file = path.join(this.root, 'recovery.lock'); let fd;
    const stale = read(file);
    if (stale && !this.alive(stale.pid) && this.now() - stale.startedAt > 30000) { try { fs.unlinkSync(file); } catch {} }
    try { fd = fs.openSync(file, 'wx', 0o600); } catch { return { busy: true, code: 'busy', message: MESSAGES.busy }; }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: this.now() }));
    try { return action(); } finally { fs.closeSync(fd); fs.unlinkSync(file); }
  }
  repair({ requestId, pid, origin }, active) {
    // Called only after Rust independently proves every official app/profile
    // helper has exited. No close operation is performed by repair.
    this.requestFile(requestId);
    if (!this.alive(pid) || !['phone', 'desktop'].includes(origin)) throw fault('invalid_request');
    return this.recoveryGuard(() => {
      const previous = read(this.requestFile(requestId)); if (previous) return { ...previous, replay: true };
      const lock = read(this.lock), transaction = read(path.join(this.root, 'link-transaction.json'));
      const operation = lock && read(this.requestFile(lock.requestId));
      const scriptFile = path.join(this.root, 'switch.lock'), script = read(scriptFile);
      if (!lock || !transaction || (this.alive(lock.pid) && operation?.code !== 'helper_timeout' && !operation?.released) || this.alive(operation?.helperPid) || this.now() - lock.startedAt < 30000 ||
          (fs.existsSync(scriptFile) && (!script || this.alive(script.pid) || this.alive(script.childPid))) ||
          transaction.from !== lock.from || transaction.to !== (lock.transactionTo || lock.to) || (active && ![lock.from, lock.transactionTo || lock.to].includes(active))) throw fault('link_unknown');
      if (script && fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile);
      // Replace the stale owner while holding the exclusive recovery guard;
      // regular begins still see the existing main lock throughout.
      const next = { requestId, pid, origin, action: 'repair', from: lock.from, to: lock.from, transactionTo: transaction.to, phase: 'checking', busy: true, startedAt: this.now(), at: this.now(), message: MESSAGES.repairing };
      atomic(this.lock, next); return this.save(next);
    });
  }
  save(record) { atomic(this.requestFile(record.requestId), record); atomic(path.join(this.root, 'last-operation.json'), record); return record; }
  begin({ requestId, from, to, origin, pid, action = 'switch' }, active, snapshot) {
    const file = this.requestFile(requestId);
    if (![from, to].every(s => /^[a-z][a-z0-9-]{0,31}$/.test(s || '')) || !['phone', 'desktop'].includes(origin) || !['switch', 'reopen'].includes(action) || !this.alive(pid)) throw fault('invalid_request');
    const previous = read(file);
    if (previous) { if (previous.to !== to || previous.action !== action) throw fault('request_conflict'); return { ...previous, replay: true }; }
    const prior = this.state(active, { recover: true }); if (prior.busy) throw fault('busy');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record = { requestId, from, to, origin, pid, action, startedAt: this.now(), at: this.now(), phase: 'checking', message: MESSAGES.checking, busy: true };
    let fd; try { fd = fs.openSync(this.lock, 'wx', 0o600); } catch { throw fault('busy'); }
    try { fs.writeFileSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
    this.save(record);
    const rejected = [...blockers(snapshot, { now: this.now(), active, isAlive: this.alive }), ...(leases(this.root, { now: this.now(), isAlive: this.alive }).length ? ['operation_active'] : [])];
    if (rejected.length) { this.finish(requestId, pid, rejected[0], rejected); throw fault(rejected[0], rejected); }
    return record;
  }
  update(id, pid, phase, helperPid = null) {
    const record = read(this.requestFile(id)), lock = read(this.lock);
    if (!record || !lock || lock.requestId !== id || lock.pid !== pid || !PHASES.includes(phase)) throw fault('invalid_request');
    if (PHASES.indexOf(phase) < PHASES.indexOf(record.phase)) throw fault('invalid_request');
    return this.save({ ...record, phase, at: this.now(), helperPid, message: MESSAGES[phase] });
  }
  finish(id, pid, code = null, rejected = []) {
    const record = read(this.requestFile(id)), lock = read(this.lock);
    if (!record || !lock || lock.requestId !== id || lock.pid !== pid) throw fault('invalid_request');
    if (record.helperPid && this.alive(record.helperPid)) return this.save({ ...record, code: 'helper_timeout', message: MESSAGES.helper_timeout, busy: true, at: this.now() });
    const script = read(path.join(this.root, 'switch.lock'));
    if (script && (this.alive(script.pid) || this.alive(script.childPid))) return this.save({ ...record, helperPid: this.alive(script.pid) ? script.pid : script.childPid, code: 'helper_timeout', message: MESSAGES.helper_timeout, busy: true, at: this.now() });
    const transaction = read(path.join(this.root, 'link-transaction.json'));
    if (transaction && !['done', 'rolled_back'].includes(transaction.phase)) return this.save({ ...record, phase: 'failed', code: 'link_unknown', released: true, message: MESSAGES.link_unknown, busy: true, recovery: ['repair'], at: this.now() });
    const recovery = code && ['closing', 'syncing', 'opening'].includes(record.phase) ? ['reopen', 'switch_back'] : [];
    const out = { ...record, busy: false, phase: code ? 'failed' : 'done', code, blockers: rejected.filter(k => MESSAGES[k]), message: MESSAGES[code || (record.action === 'reopen' ? 'reopened' : 'done')] || MESSAGES.failed, at: this.now(), recovery };
    this.save(out); fs.unlinkSync(this.lock);
    fs.appendFileSync(path.join(this.root, 'operations-audit.jsonl'), JSON.stringify({ at: out.at, requestId: id, origin: record.origin, from: record.from, to: record.to, result: out.phase, code }) + '\n', { mode: 0o600 });
    return out;
  }
}
module.exports = { ROOT, Operations, PHASES, MESSAGES, fault, read, atomic, alive, blockers, leases };
