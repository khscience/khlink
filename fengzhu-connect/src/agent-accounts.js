'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { accountIdentity } = require('./account-identity');
const { Operations, MESSAGES, fault, blockers, read, alive, ROOT } = require('./account-operations');
function publicName(value, index) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s && s.length <= 32 && !/[\x00-\x1f\x7f@\\/]|[a-z]:|\b(?:org|organization)[-_]|[a-f0-9]{8}-[a-f0-9-]{27,}/i.test(s) ? s : `账号 ${index + 1}`;
}
function windowQuota(value, now, active) {
  if (!value || !Number.isFinite(value.remaining) || value.remaining < 0 || value.remaining > 100) return null;
  const at = Number(value.observedAt) || 0, reset = Number(value.resetsAt) || null;
  const expired = reset !== null && reset <= now && reset > at;
  return { remaining: !active && expired ? 100 : value.remaining, observedAt: at, resetsAt: reset,
    historical: now - at > 30 * 60000 || expired, estimated: !active && expired };
}
function publicOperation(value, idFor) {
  if (!value || !value.requestId) return value?.busy ? { busy: true, phase: 'failed', code: 'interrupted', message: MESSAGES.interrupted, recovery: [] } : null;
  const phase = ['checking', 'closing', 'syncing', 'opening', 'done', 'failed'].includes(value.phase) ? value.phase : 'failed';
  return { requestId: value.requestId, phase, busy: value.busy === true, at: Number(value.at) || 0,
    from: idFor(value.from), to: idFor(value.to), origin: value.origin === 'phone' ? 'phone' : 'desktop',
    code: MESSAGES[value.code] ? value.code : null, message: MESSAGES[value.code] || MESSAGES[phase === 'done' && value.action === 'reopen' ? 'reopened' : phase],
    blockers: (value.blockers || []).filter(k => MESSAGES[k]).map(code => ({ code, message: MESSAGES[code] })),
    recovery: (value.recovery || []).filter(k => ['reopen', 'switch_back', 'repair'].includes(k)) };
}
function publicState(backend, state, operation, { now = Date.now(), identity = accountIdentity, usageFingerprint } = {}) {
  const idFor = alias => alias ? identity(`accounts-${backend}`, alias) : null;
  // Enrollment is local-only until the offline Code-index adoption commits.
  const profiles = (state.profiles || []).filter(p => !p.pending && !p.directoryMissing).map((profile, index) => {
    const active = backend === 'codex' ? profile.id === 'default' : profile.id === state.active;
    const usage = profile.usage || profile.record?.usage;
    return { id: idFor(profile.id), name: publicName(profile.name, index), active, running: profile.running === true,
      quota: { fiveHour: windowQuota(usage?.fiveHour, now, active), week: windowQuota(usage?.sevenDay, now, active), observedAt: Number(usage?.observedAt) || 0 } };
  });
  const lastSwitch = publicOperation(operation, idFor);
  return { backend, snapshotAt: now, configured: state.configured !== false, readonly: backend === 'codex', active: profiles.find(p => p.active)?.id || null,
    switching: lastSwitch?.busy === true || state.awaitingLogin === true, lastSwitch, profiles,
    ...(backend === 'claude' && /^[a-f0-9]{32}$/.test(usageFingerprint || '') && !lastSwitch?.busy ? { usageFingerprint } : {}) };
}
function component() {
  const base = process.env.LOCALAPPDATA;
  const candidates = base ? ['khLink', 'KH Link'].map(name => path.join(base, name)) : [];
  return candidates.find(dir => fs.existsSync(path.join(dir, 'kh-link-desktop.exe')) && fs.existsSync(path.join(dir, 'claude-switch/account-operations.js'))) || null;
}
function command(exe, args, timeout = 12000) {
  return new Promise((resolve, reject) => execFile(exe, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } }, (e, stdout) => {
    if (e) return reject(fault('component_failed')); try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch { reject(fault('component_failed')); }
  }));
}
function registryStamp(backend) {
  const files = backend === 'claude' ? ['config.json', 'labels.json', 'onboarding.json'].map(name => path.join(ROOT, name)) : ['G:\\Apps\\CodexSwitch\\accounts.json'];
  return files.map(file => {
    try { const st = fs.statSync(file, { bigint: true }); return [st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs].map(String).join(':'); }
    catch { return 'unavailable'; }
  }).join('|');
}
class AgentAccounts {
  constructor(connector, options = {}) { this.connector = connector; this.component = options.component || component; this.run = options.command || command; this.spawn = options.spawn || spawn; this.cache = new Map(); this.op = options.operations || new Operations(); this.dispatches = new Map(); this.registryStamp = options.registryStamp || registryStamp; this.registrySeen = new Map(); }
  async raw(backend) {
    if (!['claude', 'codex'].includes(backend)) throw fault('invalid_request');
    const dir = this.component(); if (!dir) return { configured: false, profiles: [] };
    const node = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs/node.exe');
    const state = await this.run(node, [path.join(dir, `${backend}-switch/console.cjs`), 'state']);
    let installed = this.cache.get(backend);
    if (!installed || Date.now() - installed.at > 10000) {
      let data = null; try { data = await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(dir, `${backend}-switch/desktop-info.ps1`)]); } catch {}
      installed = { at: Date.now(), data }; this.cache.set(backend, installed);
    }
    for (const row of state.profiles || []) {
      if (backend === 'claude') row.running = row.active && installed.data?.desktopPids?.length > 0;
      else row.running = installed.data?.processes?.some(p => row.primary ? !p.userData : typeof p.userData === 'string' && p.userData.toLowerCase() === row.userData?.toLowerCase()) || false;
    }
    return state;
  }
  async state(backend) {
    const at = Date.now(); // A slower, older read must not overwrite a newer one on the phone.
    const revision = this.registryStamp(backend);
    const state = await this.raw(backend);
    if (state.configured !== false) {
      this.registrySeen.set(backend, revision);
      if (backend === 'claude') this.active = state.active;
      this.watch(backend);
    }
    const official = backend === 'claude' ? this.connector.claudeDesktop?.latestOfficialUsage?.() : null;
    // Both DTOs may share only this opaque identity, never an alias/org/path.
    // Bind it only when the source was resolved to the same active profile.
    const ready = !state.awaitingLogin && state.profiles?.some(p => p.id === state.active && !p.pending && !p.directoryMissing);
    const usageFingerprint = ready && official?.accountState === 'ready' && official.profileAlias === state.active ? official.accountFingerprint : null;
    return publicState(backend, state, backend === 'claude' && state.configured !== false ? this.op.state(state.active) : null, { now: at, usageFingerprint });
  }
  watch(backend = 'claude') {
    if (!this.registrySeen.has(backend)) this.registrySeen.set(backend, this.registryStamp(backend));
    if (this.timer) return;
    this.timer = setInterval(() => this.progress().catch(() => {}), 2000); this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  async progress() {
    if (this.polling) return;
    this.polling = true;
    try {
      const op = this.op.state(this.active);
      const key = JSON.stringify([op.requestId, op.phase, op.code, op.busy, op.helperPid, alive(op.helperPid)]);
      const changed = [...this.registrySeen.keys()].filter(backend => this.registryStamp(backend) !== this.registrySeen.get(backend));
      if (this.registrySeen.has('claude') && key !== this.progressKey && !changed.includes('claude')) changed.push('claude');
      if (!changed.length) return;
      for (const backend of changed) {
        const state = await this.state(backend);
        if (backend === 'claude' && state.lastSwitch?.busy) this.connector.emit('accounts.progress', null, { ...state.lastSwitch, state });
        this.connector.emit('accounts.state', null, state);
      }
      this.progressKey = key;
    } finally { this.polling = false; }
  }
  async switch(args) {
    if (args.backend !== 'claude') throw fault('readonly');
    const action = ['reopen', 'repair'].includes(args.operation) ? args.operation : 'switch';
    const file = this.op.requestFile(args.requestId);
    const state = await this.raw('claude');
    if (state.awaitingLogin) throw fault('busy');
    const target = (state.profiles || []).find(p => !p.pending && !p.directoryMissing && accountIdentity('accounts-claude', p.id) === args.to);
    if (!target || !state.active && action !== 'repair') throw fault('invalid_request');
    const previous = read(file);
    if (previous) { if (previous.to !== target.id || previous.action !== action) throw fault('request_conflict'); return { accepted: true, replay: true, operation: publicOperation(previous, id => accountIdentity('accounts-claude', id)) }; }
    if (this.dispatches.has(args.requestId)) return { accepted: true, requestId: args.requestId };
    const operation = this.op.state(state.active);
    if (action === 'repair' && (!operation.recovery?.includes('repair') || target.id !== operation.from)) throw fault('link_unknown');
    if (operation.busy && action !== 'repair') throw fault('busy');
    // Refresh the independent activity evidence before claiming the cross-app
    // lock; Rust checks it again after claiming, together with the UI state.
    if (action !== 'repair') { this.connector._claudeLive = null; await this.connector.syncClaudeDesktopSessions(); }
    const rejected = action === 'repair' ? [] : blockers(read(path.join(ROOT, 'activity.json')), { active: state.active });
    if (rejected.length) return { accepted: false, blockers: rejected.map(code => ({ code, message: MESSAGES[code] })) };
    const dir = this.component(); if (!dir) throw fault('component_failed');
    const child = this.spawn(path.join(dir, 'kh-link-desktop.exe'), ['--claude-account-switch', target.id, args.requestId, action], { detached: true, windowsHide: true, stdio: 'ignore' });
    this.dispatches.set(args.requestId, child);
    child.once('error', () => this.dispatches.delete(args.requestId));
    child.once('exit', () => { this.dispatches.delete(args.requestId); this.state('claude').then(s => this.connector.emit('accounts.state', null, s)).catch(() => {}); });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(fault('component_failed'))); });
    child.unref();
    // Do not acknowledge an operation that failed before it reached the
    // journal (e.g. another desktop owns the native mutex). A durable claim
    // also closes the phone's accepted-but-still-idle button gap.
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const record = read(file);
      if (record) { this.watch(); return { accepted: true, requestId: args.requestId, operation: publicOperation(record, id => accountIdentity('accounts-claude', id)) }; }
      if (child.exitCode !== null && child.exitCode !== undefined) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw fault(this.op.state(state.active).busy ? 'busy' : 'component_failed');
  }
}
module.exports = { AgentAccounts, publicName, windowQuota, publicState, publicOperation, component, registryStamp };
