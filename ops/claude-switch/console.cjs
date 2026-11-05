'use strict';

const fs = require('node:fs');
const path = require('node:path');
const share = require('./session-share.cjs');
const { usageFor } = require('./usage.cjs');
const { identityFor } = require('./identity.cjs');
const { Registry, removedRows, nameFor, MESSAGES: registryMessages } = require('./registry.cjs');
const catalog = require('./catalog.cjs');
const { Onboarding, MESSAGES: onboardingMessages } = require('./onboarding.cjs');
const { execFileSync } = require('node:child_process');
const ROOT = 'G:\\Apps\\ClaudeSwitch';
const CONFIG = path.join(ROOT, 'shared', 'config.json');
const operations = require(fs.existsSync(path.join(__dirname, 'account-operations.js')) ? './account-operations.js' : '../../fengzhu-connect/src/account-operations.js');
function configuration({ metadataOnly = false } = {}) {
  const st = fs.lstatSync(CONFIG);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 32768) throw new Error('本地切换配置无效。');
  const c = catalog.config(ROOT, metadataOnly ? { allowMissing: true, allowEmpty: true } : {});
  if (path.resolve(c.root) !== ROOT) throw new Error('账号数据目录与已登记位置不一致。');
  return c;
}
function labels(config) {
  try { const file = share.safePath(config.root, 'shared/labels.json'); return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function current(config) {
  const alias = catalog.current(config, catalog.pending(config.root));
  if (!alias) throw new Error('当前账号目录不在管理列表中。');
  return alias;
}
function state() {
  if (!fs.existsSync(CONFIG)) return { configured: false, profiles: [], message: '尚未接管 Claude 数据目录。请先按本地接管指南完成备份和账号登录。' };
  const config = configuration({ metadataOnly: true }); let active = null; try { active = current(config); } catch { /* show the interrupted operation without guessing a profile */ } const names = labels(config);
  const additions = catalog.pending(ROOT), enrollment = new Onboarding();
  const pendingRows = Object.values(additions.profiles).filter(row => row.phase !== 'removed').map(row => {
    let canComplete = false; try { canComplete = enrollment.candidates(row.id).length === 1; } catch {}
    return { id: row.id, name: row.name, active: row.id === active, pending: true, phase: row.phase, sessions: 0, canComplete };
  });
  let sidebar = null;
  try { sidebar = JSON.parse(fs.readFileSync(share.safePath(config.root, 'shared/sidebar-state.json'), 'utf8')); } catch {}
  return { configured: true, active, root: config.root, desktopVersion: config.desktopVersion,
    pinnedCount: sidebar?.pinned ?? null, lastSyncAt: sidebar?.at ?? null, awaitingLogin: pendingRows.some(row => row.active),
    removedProfiles: [...removedRows(config, names), ...Object.values(additions.profiles).filter(row => row.phase === 'removed').map(row => ({ id: row.id, name: row.name, removedAt: row.removedAt, pending: true }))],
    profiles: [...Object.entries({ ...config.profiles, ...Object.fromEntries(Object.entries(config.unavailableProfiles || {}).map(([id,row])=>[id,row.directory])) })
      .filter(([id])=>!Object.hasOwn(additions.profiles,id)).map(([id, relative], index) => {
        const available = catalog.directoryExists(ROOT,id,relative);
        return { id, name: nameFor(id, names, index), active: id === active, directoryMissing: !available,
          sessions: available ? fs.readdirSync(share.safePath(config.root,path.join('profiles',id,relative))).filter(x=>/^local_[a-f0-9-]{36}\.json$/i.test(x)).length : 0,
          identity: available && config.profiles[id] ? identityFor(config,id) : null, usage: available && config.profiles[id] ? usageFor(config,id) : null };
      }), ...pendingRows] };
}
function enrollment() { return new Onboarding({ guard: () => {
  try { execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'assert-enroll-offline.ps1')],{windowsHide:true,stdio:'ignore',timeout:20000}); }
  catch { throw Object.assign(new Error(onboardingMessages.onboarding_exit_required),{code:'onboarding_exit_required'}); }
} }); }
async function main(args) {
  if (args[0] === 'onboard') {
    const [action,id,pid]=args.slice(1), service=enrollment();
    if(action==='create') return { ...service.create(id), state:state() };
    if(action==='prepare') return service.prepare(id,Number(pid));
    if(action==='complete') return service.complete(id,Number(pid));
    if(action==='commit') return service.commit(id,Number(pid));
    if(action==='returned') return service.returned(id,Number(pid));
    if(action==='recover') return service.recover(id);
    throw operations.fault('invalid_request');
  }
  if (args[0] === 'operation') {
    const op = new operations.Operations();
    const c = configuration({ metadataOnly:true }); let active = null; try { active = current(c); } catch {}
    const [action, id, pid, value, extra] = args.slice(1);
    if (action === 'state') {
      const lock=operations.read(path.join(ROOT,'shared/desktop-switch.lock'));
      if(lock?.kind==='onboarding') {
        const busy=operations.alive(lock.pid)||operations.alive(lock.helperPid);
        return {busy,phase:busy?'syncing':'failed',message:busy?'正在准备 Claude 账号，请稍候…':'添加账号曾中断，请从待登录卡片继续或返回添加前。',recovery:[]};
      }
      const usable=active && !Object.hasOwn(catalog.pending(ROOT).profiles,active) && c.profiles[active] && catalog.directoryExists(ROOT,active,c.profiles[active]);
      return !usable && !lock ? {busy:false} : op.state(active);
    }
    if (catalog.pending(ROOT).profiles[active]?.phase && catalog.pending(ROOT).profiles[active].phase !== 'removed') throw Object.assign(new Error(onboardingMessages.onboarding_pending),{code:'onboarding_pending'});
    configuration();
    if (action === 'begin') return op.begin({ requestId: id, pid: Number(pid), from: active, to: value, origin: extra, action: args[6] || 'switch' }, active, operations.read(path.join(ROOT, 'shared/activity.json')));
    if (action === 'repair') return op.repair({ requestId: id, pid: Number(pid), origin: value }, active);
    if (action === 'update') return op.update(id, Number(pid), value, Number(extra) || null);
    if (action === 'finish') return op.finish(id, Number(pid), value === 'ok' ? null : value);
    throw operations.fault('invalid_request');
  }
  if (args[0] === 'state') return state();
  if (['remove', 'restore', 'rename'].includes(args[0])) {
    if (['remove','restore'].includes(args[0]) && Object.hasOwn(catalog.pending(ROOT).profiles,args[1])) { enrollment().manage(args[0],args[1]); return state(); }
    try { const registry = new Registry(); registry[args[0]](args[1], args[2]); return state(); }
    catch (error) { error.code = Object.keys(registryMessages).find(key => registryMessages[key] === error.message) || 'registry_invalid'; throw error; }
  }
  const config = configuration();
  if (args[0] === 'sidebar-sync') {
    const from = args[1];
    if (current(config) !== from) throw new Error('当前账号已变化，取消同步。');
    const guard = share.liveGuard(config, from, true);
    return await require('./sidebar.cjs').synchronize(config, from, guard);
  }
  throw new Error('Unsupported local action.');
}
module.exports = { state, current, configuration, main };
if (require.main === module) main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(JSON.stringify({ code: e.code && (operations.MESSAGES[e.code] || registryMessages[e.code] || onboardingMessages[e.code]) ? e.code : 'component_failed', blockers: e.blockers || [] })); process.exitCode = 1; });
