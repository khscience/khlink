// Coordinates normal Desktop profile changes with phone UI operations.
// The two-phase lease closes the check/start race without credentials or IPC.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Operations } = require('../account-operations');
const ROOT = 'G:\\Apps\\ClaudeSwitch\\shared';
// 2026-10-18: Claude Desktop account switching is closed in the product. Keep
// the registry and the scripts, but do not touch the G: registry from the
// connector's hot paths; a slow G: read (25 s observed 2026-11-04) stalled the
// whole event loop. Only tests or a deliberate restore set the env to 1.
function accountSwitchEnabled() { return process.env.KH_LINK_CLAUDE_ACCOUNT_SWITCH === '1'; }
function managed(root = ROOT) { return accountSwitchEnabled() && fs.existsSync(path.join(root, 'config.json')); }
function pendingActive(config, root) {
  const file = path.join(root, 'onboarding.json');
  if (!fs.existsSync(file)) return false;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 65536) return true;
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (store.version !== 1 || !store.profiles) return true;
    // Finished/removed enrollments are historical records, not a switch in
    // progress. They must not keep blocking when the official app is gone.
    const entries = Object.entries(store.profiles);
    if (!entries.length || entries.every(([, p]) => !p || p.phase === 'removed' || p.removedAt)) return false;
    if (!config.activeLink) return true;
    const target = fs.readlinkSync(config.activeLink).toLowerCase();
    return Object.keys(store.profiles).some(alias => /^[a-z][a-z0-9-]{0,31}$/.test(alias) && path.resolve(config.root, 'profiles', alias).toLowerCase() === target);
  } catch { return true; } // Never fall through to another account on corrupt metadata.
}
function readConfig(root) { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); }
// The official folder is still the app's own real directory (for example after
// a reinstall): no profile is linked in, so nothing can be switching it, and a
// pending "add account" waits in its own G: profile. Such an installation is
// handled as unmanaged. A switch lock or an unfinished link transaction keeps
// the strict handling.
function unmanagedInstall(config, root) {
  try {
    if (config?.version !== 1 || !config.activeLink || path.resolve(config.root) !== path.resolve(root, '..')) return false;
    const st = fs.lstatSync(config.activeLink);
    if (!st.isDirectory() || st.isSymbolicLink()) return false; // junctions report as symbolic links
    if (['desktop-switch.lock', 'switch.lock'].some(name => fs.existsSync(path.join(root, name)))) return false;
    const transaction = path.join(root, 'link-transaction.json');
    if (!fs.existsSync(transaction)) return true;
    const { phase } = JSON.parse(fs.readFileSync(transaction, 'utf8').replace(/^\uFEFF/, ''));
    return phase === 'done' || phase === 'rolled_back';
  } catch { return false; }
}
function registeredProfile(appRoot, root = ROOT) {
  if (!accountSwitchEnabled()) return undefined;
  if (!managed(root)) return undefined;
  try {
    const config = readConfig(root);
    if (config.version !== 1 || path.resolve(config.root) !== path.resolve(root, '..')) return null;
    // Only the official linked profile uses this registry. Other stores (e.g.
    // test fixtures or a separate installation) keep their own behavior.
    if (path.resolve(appRoot).toLowerCase() !== path.resolve(config.activeLink).toLowerCase()) return undefined;
    if (unmanagedInstall(config, root)) return undefined;
    if (pendingActive(config, root)) return null;
    const active = fs.realpathSync(config.activeLink).toLowerCase();
    for (const [alias, relative] of Object.entries(config.profiles || {})) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(alias) || !/^claude-code-sessions[\\/][a-zA-Z0-9_-]+[\\/][a-zA-Z0-9_-]+$/.test(relative)) continue;
      const profile = path.resolve(config.root, 'profiles', alias);
      if (profile.toLowerCase() === active) return { alias, root: config.root, profile, accountDir: path.join(appRoot, relative), org: relative.split(/[\\/]/).at(-1) };
    }
  } catch { /* During an interrupted switch never guess another organization. */ }
  return null;
}
function registeredAccountDir(appRoot, root = ROOT) {
  const profile = registeredProfile(appRoot, root);
  return profile ? profile.accountDir : profile;
}
function switching(root = ROOT) {
  if (!accountSwitchEnabled()) return false;
  let config = null;
  try { config = readConfig(root); } catch { /* unmanaged, or handled below */ }
  if (config && unmanagedInstall(config, root)) return false;
  if (fs.existsSync(path.join(root, 'onboarding.json'))) {
    try {
      const config = readConfig(root);
      if (pendingActive(config, root)) return true;
    } catch { return true; }
  }
  if (!fs.existsSync(path.join(root, 'desktop-switch.lock'))) return false;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const profile = registeredProfile(config.activeLink, root);
    return new Operations(root).state(profile?.alias).busy === true;
  } catch { return true; }
}
function blocked() { return Object.assign(new Error('电脑正在切换 Claude 账号，请切换完成后再发送。消息尚未发送。'), { code: 'claude_profile_switching', delivery: 'not_sent' }); }
async function withLease(action, root = ROOT) {
  if (!accountSwitchEnabled()) return action();
  if (!fs.existsSync(path.join(root, 'config.json'))) return action();
  if (switching(root)) throw blocked();
  const lease = path.join(root, `desktop-operation-${process.pid}-${crypto.randomUUID()}.lock`);
  const fd = fs.openSync(lease, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    if (switching(root)) throw blocked();
    return await action();
  } finally { fs.closeSync(fd); fs.unlinkSync(lease); }
}
module.exports = { switching, withLease, managed, registeredAccountDir, registeredProfile };
