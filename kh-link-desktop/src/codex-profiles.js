(function(root) {
  'use strict';
  function loginLabel(record) {
    if (!record || record.loggedIn === null) return '等待读取登录状态';
    if (!record.loggedIn) return '等待在官方窗口登录';
    const kind = record.kind === 'chatgpt' ? 'ChatGPT' : record.kind === 'apiKey' ? 'API 账号' : '已登录';
    const plan = ({ free:'Free', plus:'Plus', pro:'Pro', prolite:'Pro', team:'Team', business:'Business', enterprise:'Enterprise', edu:'Edu' })[record.plan];
    return [kind, plan].filter(Boolean).join(' · ') + (record.error ? ' · 更新失败' : '');
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports={loginLabel}; return; }
  const $ = id => document.getElementById(id), invoke = (...args) => root.__TAURI__.core.invoke(...args);
  let state = null, busy = false, refreshing = false, epoch = 0, renameId = null;
  const el = (...args) => root.KhProfiles.element(...args);
  function controls() {
    $('codex-operation').classList.toggle('working',busy || refreshing);
    $('codex-add').disabled = busy || refreshing || state?.isolatedSupported === false || state?.available === false || state?.remoteIsolationReady === false;
    $('codex-refresh').disabled = busy || refreshing || state?.available === false;
    $('codex-name-save').disabled = busy || refreshing;
    document.querySelectorAll('#codex-accounts button').forEach(b => { b.disabled = busy || refreshing || b.dataset.unavailable === 'true'; });
    document.querySelectorAll('#codex-removed-list button').forEach(b => { b.disabled = busy || refreshing; });
  }
  function notice(message, failed = false) {
    $('codex-operation').classList.toggle('hidden', !message);
    $('codex-operation').classList.toggle('failed', failed);
    $('codex-operation').classList.toggle('working', busy || refreshing);
    $('codex-operation-text').textContent = message || '';
  }
  function render(value) {
    state = value;
    $('codex-count').textContent = String(value.profiles?.length || 0);
    $('codex-data-location').textContent = `新增账号位置：${value.root || 'G:\\Apps\\CodexSwitch'}`;
    $('codex-app-version').textContent = value.desktopVersion ? `Codex Desktop ${value.desktopVersion}` : '';
    const list = $('codex-accounts'); list.replaceChildren();
    if (!value.profiles?.length) list.append(el('div','empty-state',value.message || '还没有账号记录。'));
    for (const profile of value.profiles || []) {
      const card = el('article', 'profile-card' + (profile.id === value.selected ? ' is-active' : ''));
      const heading = el('div','profile-heading'), identity = el('div','profile-identity'), names = el('div','profile-name');
      const title = el('h3','',profile.name); title.title = profile.name;
      const meta = el('p','profile-meta',profile.directoryMissing ? '数据目录暂不可用' : loginLabel(profile.record)); meta.title = meta.textContent;
      const account = el('p','profile-account',root.KhProfiles.accountDescription('codex',profile.record));
      account.title = account.textContent;
      names.append(title,account,meta); identity.append(el('span','claude-monogram codex-monogram',profile.name.slice(0,1)),names); heading.append(identity);
      const badges = el('div','profile-tags');
      if (profile.primary) badges.append(el('span','profile-tag','手机使用'));
      if (profile.running) badges.append(el('span','profile-tag is-running','已打开'));
      heading.append(badges);
      const at = profile.record?.usage?.observedAt;
      const time = el('span','profile-observed', at ? `读取 ${new Date(at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}` : '暂无用量记录'); heading.append(time);
      const limits = el('div','quota-windows');
      for (const [key,label] of [['fiveHour','5 小时额度'],['sevenDay','本周额度']]) {
        const quota = profile.record?.usage?.[key];
        if (key === 'fiveHour' && !quota) continue;
        const model = quota ? {...quota, stale: !!profile.record.error} : profile.record?.usage && !profile.record.error ? { unavailable:true } : null;
        limits.append(root.KhProfiles.quota(model,label,true));
      }
      if (limits.children.length === 1) limits.classList.add('single-window');
      const footer = el('div','profile-footer'), open = el('button','primary profile-switch codex-open',profile.running ? '切到窗口' : '打开账号');
      open.dataset.unavailable = String(profile.directoryMissing === true || value.available === false || (!profile.primary && (value.isolatedSupported === false || value.remoteIsolationReady === false)));
      open.addEventListener('click',()=>openProfile(profile.id));
      const rename = el('button','profile-rename','改名'); rename.setAttribute('aria-label',`修改 ${profile.name} 的备注名称`); rename.addEventListener('click',()=>dialog(profile));
      const remove = el('button','profile-rename profile-remove','移除'); remove.type='button';
      remove.dataset.unavailable=String(profile.primary === true || profile.id === 'default');
      remove.title=profile.primary || profile.id==='default' ? '默认账号用于手机连接，保留此入口。' : '从 khLink 移除，保留本机数据和官方窗口';
      remove.setAttribute('aria-label',`从 khLink 移除 ${profile.name}`);
      remove.addEventListener('click',()=>manageProfile('remove',profile));
      const secondary=el('div','profile-secondary-actions'); secondary.append(rename,remove);
      footer.append(open,secondary); card.append(heading,limits,footer); list.append(card);
    }
    if (value.available === false) notice(value.message,true);
    else if (value.isolatedSupported === false) notice('Codex 已升级，暂缓打开独立账号；现有窗口和默认账号保持可用。',true);
    else if (value.remoteIsolationReady === false) notice('等待更新后的连接器就绪，备用账号暂不能打开，以确保手机只控制默认账号。',true);
    root.KhAccountManagement?.renderRemoved('codex', value.removedProfiles, profile=>manageProfile('restore',profile), busy || refreshing);
    controls();
  }
  async function refresh(force = false) {
    // Editing an account must not race the background refresh and silently
    // drop a form submission while the official usage call is in flight.
    if (busy || refreshing || root.KhAccountManagement?.isOpen() || !$('codex-name-dialog').classList.contains('hidden')) return;
    refreshing = true; const request = ++epoch; controls();
    if (!state) notice('正在读取官方账号与用量记录…');
    try {
      const next = await invoke('codex_profiles',{refresh:true,force:!!force});
      if (request !== epoch) return;
      notice(''); render(next);
      const record=next.profiles?.find(p=>p.id===next.selected)?.record;
      if (record?.error) notice(record.error,true);
    } catch(e) { if (request === epoch) notice(String(e),true); }
    finally { if (request === epoch) { refreshing=false; controls(); } }
  }
  async function openProfile(id) {
    if (busy || refreshing) return;
    busy=true; epoch++; controls(); notice('正在打开对应的官方窗口…');
    try { render(await invoke('codex_profile_open',{profile:id})); notice('已打开账号窗口。首次使用请在官方窗口完成登录。'); }
    catch(e) { notice(String(e),true); }
    finally { busy=false; controls(); }
  }
  async function manageProfile(action, profile) {
    if (busy || refreshing || (action==='remove' && (profile.primary || profile.id==='default'))) return;
    if (!await root.KhAccountManagement.confirm(action,profile.name,'codex')) return;
    busy=true; epoch++; controls(); notice(action==='remove'?'正在移除账号…':'正在恢复账号…');
    try {
      render(await invoke('codex_profile_manage',{profile:profile.id,action}));
      notice(action==='remove'?'已从列表移除，本机数据和官方窗口已保留。':'账号已恢复到列表。');
    } catch(error) { notice(root.KhAccountManagement.errorText(error),true); }
    finally {busy=false;controls();}
  }
  function dialog(profile = null) {
    if (busy || refreshing) return;
    renameId=profile?.id || null;
    $('codex-name-title').textContent=profile ? '修改备注' : '添加账号';
    $('codex-name-hint').textContent=profile ? '只修改 khLink 中的备注名称。' : '填写方便辨认的备注，稍后在官方窗口中登录。';
    $('codex-name-save').textContent=profile ? '保存' : '添加并打开';
    $('codex-name-input').value=profile?.name || '';
    $('codex-name-error').textContent='';
    $('codex-name-dialog').classList.remove('hidden'); $('codex-name-input').focus();
  }
  function closeDialog() { if (!busy) $('codex-name-dialog').classList.add('hidden'); }
  root.KhCodexProfiles={refresh};
  document.addEventListener('DOMContentLoaded',()=>{
    $('codex-refresh').addEventListener('click',()=>refresh(true)); $('codex-add').addEventListener('click',()=>dialog());
    $('codex-name-close').addEventListener('click',closeDialog); $('codex-name-cancel').addEventListener('click',closeDialog);
    $('sheet-codex').addEventListener('click',()=>{ $('account-sheet').classList.add('hidden'); root.KhProfiles.navigate('codex'); });
    $('codex-name-form').addEventListener('submit',async event=>{
      event.preventDefault(); if (busy || refreshing) return; busy=true; epoch++; controls();
      let created = null;
      try {
        const name=$('codex-name-input').value;
        if (renameId) render(await invoke('codex_profile_rename',{profile:renameId,name}));
        else { const result=await invoke('codex_profile_create',{name}); render(result.state); created=result.id; }
        $('codex-name-dialog').classList.add('hidden');
      } catch(e) { $('codex-name-error').textContent=String(e); }
      finally { busy=false; controls(); }
      if (created) await openProfile(created);
    });
    document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDialog();});
    setInterval(()=>{if(!document.hidden && document.body.dataset.page==='codex')refresh();},15000);
  });
})(typeof window === 'undefined' ? globalThis : window);
