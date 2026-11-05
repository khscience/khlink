(function (root) {
  'use strict';
  const MAX_AGE = 30 * 60 * 1000;
  function quotaView(value, now = Date.now(), { active = true } = {}) {
    const known = value && typeof value.remaining === 'number' && Number.isFinite(value.remaining);
    const stale = known && (value.stale || !value.observedAt || now - value.observedAt > MAX_AGE || (value.resetsAt && value.resetsAt <= now));
    const reset = typeof value?.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt : null;
    // This is a display estimate, never a new official observation. A newer
    // observation (or activating the account) must immediately take precedence.
    const estimated = !!known && value.remaining >= 0 && value.remaining <= 100 && active === false && reset !== null && reset <= now &&
      Number.isFinite(value.observedAt) && value.observedAt > 0 && value.observedAt < reset;
    let resetText = value?.unavailable ? '官方未提供此窗口' : value?.notStarted ? '尚未开始本轮计时' : '重置时间：官方记录未提供';
    if (reset) {
      if (reset <= now) resetText = '已到重置时间，等待新记录';
      else {
        const mins = Math.ceil((reset - now) / 60000), days = Math.floor(mins / 1440), hours = Math.floor(mins % 1440 / 60), minutes = mins % 60;
        const countdown = days ? `${days}天 ${hours}小时` : hours ? `${hours}小时 ${minutes}分` : `${minutes}分钟`;
        // Official timestamps can fall milliseconds either side of a minute boundary.
        // Round the displayed clock only; expiration still uses the exact timestamp.
        resetText = `${countdown}后重置 · ${new Date(Math.round(reset / 60000) * 60000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}`;
      }
    }
    if (estimated) resetText = '预计已重置 · 待官方确认';
    const remaining = estimated ? 100 : known ? Math.max(0, Math.min(100, value.remaining)) : null;
    return { known: !!known, stale: !!stale, estimated, remaining,
      text: known ? `${remaining}%` : '—', label: !known ? (value?.unavailable ? '未提供' : '暂无记录') : estimated ? '预计剩余' : stale ? '历史剩余' : '剩余', resetText };
  }
  function accountDescription(backend, value) {
    if (backend === 'codex') return value?.loggedIn === false ? '尚未登录' : value?.identity?.email || '暂未取得账号邮箱';
    if (value?.status === 'matched' && value.shortId) return '账号 ID：' + value.shortId;
    return value?.status === 'changed' ? '账号已变化，请核对本地登记' : '暂未取得账号信息';
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { quotaView, accountDescription }; return; }
  const $ = id => document.getElementById(id);
  const invoke = (...args) => root.__TAURI__.core.invoke(...args);
  let snapshot = null, busy = false, refreshing = false, managing = false, creating = false, renameId = null, page = 'remote', requestVersion = 0;
  const errorText = error => root.KhAccountManagement?.errorText(error) || String(error);
  // Temporarily closed on 2026-10-18; see features.js. Tests run without the
  // gate file and keep exercising the page code.
  const claudeAccountSwitchEnabled = () => root.KH_FEATURES?.claudeAccountSwitch !== false;
  // The whole account switching entry, closed on 2026-10-31; see features.js.
  const accountSwitchEnabled = () => root.KH_FEATURES?.accountSwitch !== false;
  let feedback = null;
  function element(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; }
  function navigate(next) {
    page = ['claude', 'codex'].includes(next) && accountSwitchEnabled() && (next !== 'claude' || claudeAccountSwitchEnabled()) ? next : 'remote';
    for (const name of ['remote', 'claude', 'codex']) {
      $(name + '-view').classList.toggle('hidden', name !== page);
      $('nav-' + name).setAttribute('aria-current', name === page ? 'page' : 'false');
    }
    document.body.dataset.page = page;
    $('page-title').textContent = ({claude:'Claude 切换',codex:'Codex 切换',remote:'手机远程控制'})[page];
    $('page-group').textContent = page === 'remote' ? '工作区' : '账号切换';
    $('nav-accounts').classList.toggle('group-selected', page !== 'remote');
    if (page !== 'remote') { $('account-navigation').classList.remove('hidden'); $('nav-accounts').setAttribute('aria-expanded','true'); }
    try { localStorage.setItem('khlink.workspace', page); } catch {}
    if (page === 'claude') refresh();
    if (page === 'codex') root.KhCodexProfiles?.refresh();
  }
  function operation(value) {
    if (!value) return;
    if (value.busy) feedback = null;
    else if (value.message) feedback = value;
    const banner = $('claude-operation');
    busy = !!value.busy;
    banner.classList.toggle('hidden', !value.message);
    banner.classList.toggle('failed', value.phase === 'error' || value.phase === 'failed');
    banner.classList.toggle('working', busy);
    $('claude-operation-text').textContent = (busy && value.origin === 'phone' ? '手机正在操作：' : '') + (value.message || '');
    const recovery = $('claude-recovery'); recovery?.replaceChildren();
    if (recovery) for (const action of value.recovery || []) {
      const label = { repair: '恢复原账号链接', reopen: '重新打开 Claude', switch_back: '切回原账号' }[action];
      if (!label) continue;
      const button = element('button', 'profile-rename', label);
      button.type = 'button'; button.disabled = busy && action !== 'repair';
      button.addEventListener('click', async () => {
        if (!root.confirm(action === 'repair' ? '恢复上次切换前的账号链接并打开 Claude。所有 Claude 进程需先退出；不会强制结束进程。' : label + '？')) return;
        button.disabled = true;
        try { render(await invoke('claude_switch', { profile: action === 'reopen' ? snapshot.active : value.from, action: action === 'switch_back' ? 'switch' : action })); }
        catch { /* The persisted, sanitized outcome is read below. */ }
        await refresh();
      });
      recovery.append(button);
    }
    $('claude-refresh').disabled = busy || refreshing;
    $('claude-add').disabled = busy || managing || creating || !snapshot?.configured || snapshot?.profiles?.some(p => p.pending && p.phase !== 'created');
    document.querySelectorAll('#claude-accounts button, #claude-removed-list button').forEach(button => { button.disabled = busy || managing || button.dataset.active === 'true' || button.dataset.protected === 'true'; });
  }
  function quota(value, title, active) {
    const model = quotaView(value, Date.now(), { active });
    const box = element('div', 'quota-window' + (model.stale ? ' stale' : '') + (model.estimated ? ' estimated' : ''));
    if (model.estimated) box.title = `上次官方记录剩余 ${value.remaining}%。已到该记录的重置时间，预计恢复；若在其他设备使用，实际额度可能更少。切回账号后以新的官方记录为准。`;
    const heading = element('div', 'quota-heading');
    const label = element('div', 'quota-label'); label.append(element('span', 'quota-title', title), element('span', 'quota-kind', model.label));
    const metric = element('strong', 'quota-metric', model.text); heading.append(label, metric); box.append(heading);
    const bar = element('div', 'quota-bar');
    bar.setAttribute('role', 'meter'); bar.setAttribute('aria-label', `${title} ${model.label}`); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
    if (model.known) bar.setAttribute('aria-valuenow', String(model.remaining));
    else bar.setAttribute('aria-valuetext', '暂无记录');
    if (model.estimated) bar.setAttribute('aria-valuetext', '预计剩余 100%，待官方确认');
    const fill = element('i'); fill.style.width = (model.remaining ?? 0) + '%'; bar.append(fill);
    if (model.known && model.remaining <= 10) bar.classList.add('low');
    const reset = element('p', 'quota-reset');
    for (const part of model.resetText.split(' · ')) reset.append(element('span', '', part));
    box.append(bar, reset); return box;
  }
  function render(state) {
    snapshot = state;
    $('claude-count').textContent = String(state.profiles?.length || 0);
    $('claude-app-version').textContent = state.desktopVersion ? `Claude Desktop ${state.desktopVersion}` : '';
    $('claude-data-location').textContent = state.root ? `数据位置：${state.root}` : '本地管理 · 不上传账号数据';
    const list = $('claude-accounts'); list.replaceChildren();
    root.KhAccountManagement?.renderRemoved('claude', state.removedProfiles, profile => manageProfile('restore', profile), busy || managing);
    if (!state.configured) { list.append(element('div', 'empty-state', state.message || '还没有管理的账号。')); return; }
    for (const profile of state.profiles) {
      if (profile.pending) { list.append(pendingCard(profile, state)); continue; }
      const card = element('article', 'profile-card' + (profile.active ? ' is-active' : ''));
      const heading = element('div', 'profile-heading'), identity = element('div', 'profile-identity');
      const avatar = element('span', 'claude-monogram', profile.name.slice(0, 1)); avatar.setAttribute('aria-hidden', 'true');
      const names = element('div', 'profile-name'); const name = element('h3', '', profile.name); name.title = profile.name;
      const account = element('p', 'profile-account', profile.directoryMissing ? '目录缺失 · 请检查本机数据' : accountDescription('claude', profile.identity));
      account.title = profile.identity?.accountId ? `Claude 账号 ID：${profile.identity.accountId}（官方最后使用的账号，与本地登记一致）` : account.textContent;
      names.append(name, account, element('p', 'profile-meta', `${profile.sessions} 个 Code 会话`));
      identity.append(avatar, names); heading.append(identity);
      const rename = element('button', 'profile-rename', '改名'); rename.type = 'button'; rename.setAttribute('aria-label', `修改 ${profile.name} 的备注名称`); rename.disabled = busy;
      rename.addEventListener('click', () => { renameId = profile.id; $('claude-name-input').value = profile.name; $('claude-name-dialog').classList.remove('hidden'); $('claude-name-input').focus(); });
      card.append(heading);
      const limits = element('div', 'quota-windows'); limits.append(quota(profile.usage?.fiveHour, '5 小时额度', profile.active !== false), quota(profile.usage?.sevenDay, '本周额度', profile.active !== false)); card.append(limits);
      const footer = element('div', 'profile-footer'); const at = profile.usage?.observedAt;
      const old = at && Date.now() - at > MAX_AGE;
      const time = element('span', 'profile-observed' + (old ? ' is-stale' : ''), at ? `${old ? '历史' : '更新'} ${new Date(at).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}` : '等待官方用量记录');
      time.title = at ? `官方用量记录时间：${new Date(at).toLocaleString('zh-CN', {hour12:false})}` : '尚未取得官方用量记录';
      heading.append(time);
      const button = element('button', 'profile-switch ' + (profile.active ? 'current-profile' : 'primary'), profile.active ? '✓ 当前账号' : '切换到此账号');
      button.type = 'button'; button.dataset.active = String(profile.active); button.disabled = busy || profile.active;
      button.dataset.protected = String(!!profile.directoryMissing || !!state.awaitingLogin);
      button.disabled ||= button.dataset.protected === 'true';
      if (profile.directoryMissing) { button.textContent = '目录缺失'; button.title = '登记还在，原目录已不存在。添加账号会创建全新目录，不会自动恢复备份。'; }
      const remove = element('button', 'profile-rename profile-remove', '移除'); remove.type = 'button';
      const protectedAccount = profile.active || profile.id === state.active || state.profiles.filter(p=>!p.pending).length <= 1;
      remove.dataset.protected = String(!!protectedAccount); remove.disabled = busy || managing || !!protectedAccount;
      remove.title = protectedAccount ? '当前账号需要保留；请先切换到其他账号。' : '从 khLink 移除，保留本机数据和对话';
      remove.setAttribute('aria-label', `从 khLink 移除 ${profile.name}`);
      remove.addEventListener('click', () => manageProfile('remove', profile));
      const secondary = element('div', 'profile-secondary-actions'); secondary.append(rename, remove);
      button.addEventListener('click', () => switchProfile(profile.id)); footer.append(button, secondary); card.append(footer); list.append(card);
    }
    const count = state.profiles.find(p=>!p.pending && !p.directoryMissing)?.sessions ?? 0;
    $('claude-sharing-status').textContent = state.profiles.some(p=>!p.pending && !p.directoryMissing) ? `${count} 个会话共用${state.pinnedCount === null ? ' · 下次切换同步置顶' : ` · ${state.pinnedCount} 个置顶已同步`}。` : '尚无可用的已登录账号，完成添加后同步会话与置顶。';
  }
  async function refresh() {
    if (!claudeAccountSwitchEnabled() || refreshing || managing || creating || root.KhAccountManagement?.isOpen() || !$('claude-name-dialog').classList.contains('hidden') || !$('claude-add-dialog').classList.contains('hidden')) return;
    refreshing = true; $('claude-refresh').disabled = true;
    const version = ++requestVersion;
    try { const state = await invoke('claude_profiles'); if (version !== requestVersion) return; render(state); operation(state.operation?.busy ? state.operation : feedback || state.operation || {busy:false}); }
    catch (error) { operation({ phase: 'error', message: `无法读取本地账号：${error}`, busy: false }); }
    finally { refreshing = false; $('claude-refresh').disabled = busy; }
  }
  async function switchProfile(id) {
    if (busy || snapshot?.active === id || snapshot?.awaitingLogin || snapshot?.profiles?.find(p=>p.id===id)?.directoryMissing) return;
    requestVersion++; operation({ busy: true, phase: 'checking', message: '正在准备切换，请稍候…' });
    try { const state = await invoke('claude_switch', { profile: id }); render(state); operation({ busy: false, phase: 'done', message: '已切换账号，会话与置顶顺序已同步。' }); }
    catch (error) { operation({ busy: false, phase: 'error', message: errorText(error) }); }
  }
  function pendingCard(profile, state) {
    const card = element('article', 'profile-card enrollment-card' + (profile.active ? ' is-active' : ''));
    const heading = element('div', 'profile-heading');
    heading.append(element('h3', '', profile.name), element('p', 'enrollment-badge', '待登录 · 仅电脑可见'));
    const copy = element('div', 'enrollment-copy');
    copy.append(element('strong', '', profile.active ? '登录后，打开 Code 页' : '准备添加新账号'));
    copy.append(element('p', '', profile.active ? '在官方窗口完成登录，打开 Code 页，然后从托盘正常退出 Claude，点击右侧“完成添加”。' : '保存当前工作，从托盘正常退出 Claude，再打开登录窗口。已有会话会在完成添加时同步。'));
    const actions = element('div', 'profile-footer enrollment-actions');
    for (const [action, label] of [['open', profile.active ? '重新打开登录窗口' : '打开登录窗口'], ['complete', '完成添加'], ['return', '返回添加前']]) {
      if (action !== 'open' && profile.phase === 'created') continue;
      const button = element('button', action === 'complete' || action === 'open' && !profile.active ? 'primary' : 'secondary', label);
      button.type = 'button'; button.dataset.protected = String(!!state.awaitingLogin && !profile.active);
      button.disabled = busy || managing || button.dataset.protected === 'true';
      button.addEventListener('click', () => onboard(profile.id, action)); actions.append(button);
    }
    if (profile.phase === 'created' && !profile.active) {
      const remove = element('button', 'profile-rename profile-remove', '移除'); remove.type = 'button';
      remove.disabled = busy || managing; remove.addEventListener('click', () => manageProfile('remove', profile)); actions.append(remove);
    }
    card.append(heading, copy, actions); return card;
  }
  async function onboard(id, action) {
    if (busy || managing || creating) return;
    managing = true; requestVersion++;
    operation({ busy: true, message: '正在准备账号目录，请稍候…' });
    let outcome;
    try {
      render(await invoke('claude_profile_onboard', { profile: id, action }));
      outcome = { phase: 'done', message: ({open:'已打开官方 Claude，请你本人登录并打开 Code 页。', complete:'账号已添加，会话与置顶已同步，Claude 已重新打开。', return:'已返回添加前的状态，新账号目录保留，可稍后继续。'})[action] };
    } catch(error) { outcome = { phase: 'error', message: errorText(error) }; }
    finally { managing = false; operation({ ...outcome, busy: false }); }
  }
  async function manageProfile(action, profile) {
    if (busy || managing || (action === 'remove' && (profile.id === snapshot?.active || !profile.pending && snapshot?.profiles?.filter(p=>!p.pending).length <= 1))) return;
    if (!await root.KhAccountManagement.confirm(action, profile.name, 'claude')) return;
    managing = true; requestVersion++;
    operation({ busy: true, message: action === 'remove' ? '正在移除账号…' : '正在恢复账号…' });
    let outcome;
    try {
      render(await invoke('claude_profile_manage', { profile: profile.id, action }));
      outcome = { phase: 'done', message: action === 'remove' ? '已从列表移除，本机数据已保留。' : '账号已恢复到列表。' };
    } catch(error) { outcome = { phase: 'error', message: root.KhAccountManagement.errorText(error) }; root.toast?.(outcome.message); }
    finally { managing = false; operation({ ...outcome, busy: false }); }
  }
  root.KhProfiles = { navigate, quotaView, quota, element, refresh, accountDescription };
  document.addEventListener('DOMContentLoaded', () => {
    $('nav-remote').addEventListener('click', () => navigate('remote'));
    $('nav-claude').addEventListener('click', () => { if (claudeAccountSwitchEnabled()) navigate('claude'); });
    $('nav-codex').addEventListener('click', () => navigate('codex'));
    $('nav-accounts').addEventListener('click', () => {
      if (!accountSwitchEnabled()) { root.toast?.('账号切换功能开发完善中，暂未开放'); return; }
      const collapsed = $('account-navigation').classList.toggle('hidden'); $('nav-accounts').setAttribute('aria-expanded', String(!collapsed)); });
    $('claude-refresh').addEventListener('click', () => { feedback=null; return refresh(); });
    const closeAdd = () => { if (!creating && !$('claude-add-dialog').classList.contains('hidden')) { $('claude-add-dialog').classList.add('hidden'); $('claude-add').focus(); } };
    $('claude-add').addEventListener('click', () => {
      if (busy || managing || creating || !snapshot?.configured) return;
      $('claude-add-error').textContent = ''; $('claude-add-input').value = '';
      $('claude-add-dialog').classList.remove('hidden'); $('claude-add-input').focus();
    });
    $('claude-add-cancel').addEventListener('click', closeAdd);
    $('claude-add-close').addEventListener('click', closeAdd);
    $('claude-add-form').addEventListener('submit', async event => {
      event.preventDefault(); if (busy || managing || creating) return;
      const name = $('claude-add-input').value.trim();
      if (!name || name.length > 32 || /[\x00-\x1f\x7f]/.test(name)) { $('claude-add-error').textContent = '请填写 1–32 个可见字符。'; return; }
      creating = true; requestVersion++; $('claude-add-save').disabled = true;
      try {
        const result = await invoke('claude_profile_create', {name}); render(result.state);
        $('claude-add-dialog').classList.add('hidden'); operation({busy:false,phase:'done',message:'空账号已创建。请保存工作并正常退出 Claude，再打开登录窗口。'});
      } catch(error) { $('claude-add-error').textContent = errorText(error); }
      finally { creating=false; $('claude-add-save').disabled=false; $('claude-add').disabled=busy || snapshot?.profiles?.some(p=>p.pending && p.phase!=='created'); }
    });
    $('sheet-claude').addEventListener('click', () => { $('account-sheet').classList.add('hidden'); if (claudeAccountSwitchEnabled()) navigate('claude'); });
    $('claude-name-form').addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !renameId) return; const button=$('claude-name-save');button.disabled=true;
      try { render(await invoke('claude_rename', { profile: renameId, name: $('claude-name-input').value })); $('claude-name-dialog').classList.add('hidden'); }
      catch (e) { root.toast?.(String(e)); }
      finally {button.disabled=false;}
    });
    if (root.__TAURI__.event?.listen) root.__TAURI__.event.listen('claude-profile-progress', event => operation(event.payload)).catch(() => {});
    if (!claudeAccountSwitchEnabled()) for (const id of ['nav-claude', 'claude-view', 'sheet-claude']) $(id).classList.add('hidden');
    if (!accountSwitchEnabled()) {
      for (const id of ['nav-accounts', 'account-navigation', 'codex-view', 'sheet-codex', 'sheet-claude']) $(id).classList.add('hidden');
      $('nav-accounts').setAttribute('aria-expanded', 'false');
      $('nav-accounts').setAttribute('aria-hidden', 'true');
    }
    try { page=localStorage.getItem('khlink.workspace') || 'remote'; } catch {page='remote';}
    if (page === 'claude' && !claudeAccountSwitchEnabled()) page = 'remote';
    navigate(page);
    setInterval(() => { if (claudeAccountSwitchEnabled() && !document.hidden && page === 'claude') refresh(); }, 2_000);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { $('claude-name-dialog').classList.add('hidden'); closeAdd(); }
      if (e.key === 'Tab' && !$('claude-add-dialog').classList.contains('hidden')) {
        const controls = ['claude-add-close','claude-add-input','claude-add-cancel','claude-add-save'].map($).filter(x=>!x.disabled);
        const index = controls.indexOf(document.activeElement); e.preventDefault?.();
        controls[(index + (e.shiftKey ? controls.length-1 : 1)) % controls.length].focus();
      }
    });
  });
})(typeof window === 'undefined' ? globalThis : window);
