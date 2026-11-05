const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {loginLabel}=require('../src/codex-profiles');
const tick=()=>new Promise(r=>setImmediate(r));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};}
const snapshot=(profiles=[{id:'default',name:'默认账号',primary:true,running:true,record:null}])=>({profiles,selected:'default',available:true,isolatedSupported:true,root:'G:\\Fixture',desktopVersion:'fixture'});
function page(handlers={},initial='remote',features) {
  class Element {
    constructor(id){this.id=id;this.children=[];this.attrs={};this.dataset={};this.style={};this.events={};this.classes=new Set();this.value='';this.textContent='';
      this.classList={add:n=>this.classes.add(n),remove:n=>this.classes.delete(n),contains:n=>this.classes.has(n),toggle:(n,on)=>{on=on??!this.classes.has(n);on?this.classes.add(n):this.classes.delete(n);return on;}};}
    set className(v){this.classes=new Set(v.split(' '));}get className(){return[...this.classes].join(' ');}
    setAttribute(k,v){this.attrs[k]=v;}append(...c){this.children.push(...c);}replaceChildren(...c){this.children=c;}focus(){context.document.activeElement=this;}
    addEventListener(k,f){this.events[k]=f;}
  }
  const elements=new Map(),events={},calls=[],intervals=[];
  const html=fs.readFileSync(path.join(__dirname,'../src/index.html'),'utf8');
  for(const m of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){const el=new Element(m[1]);el.className=m[0].match(/class="([^"]*)"/)?.[1]||'';elements.set(m[1],el);}
  function all(root){return[root,...root.children.flatMap(all)];}
  const context=vm.createContext({console,Date,Promise,localStorage:{getItem:()=>initial,setItem:(k,v)=>{initial=v;}},setInterval:f=>intervals.push(f),
    document:{body:{dataset:{}},hidden:false,getElementById:id=>{assert.ok(elements.has(id),'missing HTML '+id);return elements.get(id);},createElement:()=>new Element(''),addEventListener:(name,f)=>(events[name]??=[]).push(f),querySelectorAll:query=>query.split(',').flatMap(q=>{const id=/^#([\w-]+)/.exec(q.trim())?.[1];return elements.has(id)?all(elements.get(id)).filter(x=>x.events.click):[];})},
    __TAURI__:{core:{invoke:async(name,args)=>{calls.push({name,args});if(handlers[name])return handlers[name](args);if(name==='claude_profiles')return{configured:false,profiles:[]};if(name==='codex_profiles')return snapshot();return{};}}}});
  context.window=context;
  if(features)context.KH_FEATURES=features;
  for(const file of ['profile-management.js','profiles.js','codex-profiles.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),context,{filename:file});
  for(const f of events.DOMContentLoaded||[])f();
  return{elements,calls,context,intervals,click:async id=>elements.get(id).events.click(),key:key=>{for(const f of events.keydown||[])f({key,preventDefault(){}});},submit:()=>elements.get('codex-name-form').events.submit({preventDefault(){}}),all:id=>all(elements.get(id)),text:id=>all(elements.get(id)).map(x=>x.textContent).join(' ')};
}

const claudeAccounts=()=>({configured:true,active:'primary',pinnedCount:12,profiles:[{id:'primary',name:'主账号',sessions:16,active:true},{id:'secondary',name:'研究账号',sessions:16,active:false}]});
const pendingClaude=(active=false)=>({configured:true,active:active?'account-fixture':'primary',awaitingLogin:active,profiles:[...claudeAccounts().profiles,{id:'account-fixture',name:'新工作账号',pending:true,active,phase:active?'login':'created'}]});
test('Claude add dialog cancellation never creates or starts an official account',async()=>{
 const a=page({claude_profiles:claudeAccounts},'claude');await tick();await a.click('claude-add');
 assert.equal(a.elements.get('claude-add-dialog').classList.contains('hidden'),false);assert.match(fs.readFileSync(path.join(__dirname,'../src/index.html'),'utf8'),/密码、验证码都只在官方窗口输入/);
 await a.click('claude-add-cancel');await a.click('claude-add');a.key('Escape');
 assert.equal(a.elements.get('claude-add-dialog').classList.contains('hidden'),true);assert.ok(!a.calls.some(c=>/create|onboard/.test(c.name)));
});
test('Claude add creates once, suspends polling and retains a pending card without opening auth UI',async()=>{
 const creating=deferred();const a=page({claude_profiles:claudeAccounts,claude_profile_create:()=>creating.promise},'claude');await tick();await a.click('claude-add');
 a.elements.get('claude-add-input').value='新工作账号';const submit=()=>a.elements.get('claude-add-form').events.submit({preventDefault(){}});
 const first=submit();await tick();await submit();a.key('Escape');for(const poll of a.intervals)poll();await tick();
 assert.equal(a.calls.filter(c=>c.name==='claude_profile_create').length,1);assert.equal(a.calls.filter(c=>c.name==='claude_profiles').length,1);
 assert.equal(a.elements.get('claude-add-dialog').classList.contains('hidden'),false);
 creating.resolve({id:'account-fixture',state:pendingClaude()});await first;
 assert.match(a.text('claude-accounts'),/待登录.*打开登录窗口/);assert.ok(!a.calls.some(c=>c.name==='claude_profile_onboard'));
});
test('Claude enrollment explains a still-running official app and allows retry without duplicating profiles',async()=>{
 let tries=0;const a=page({claude_profiles:()=>pendingClaude(),claude_profile_onboard:()=>{tries++;throw 'onboarding_exit_required';}},'claude');await tick();
 const open=a.all('claude-accounts').find(c=>c.textContent==='打开登录窗口');await open.events.click();
 assert.match(a.elements.get('claude-operation-text').textContent,/正常退出 Claude/);assert.equal(open.disabled,false);
 await open.events.click();assert.equal(tries,2);assert.ok(!a.calls.some(c=>c.name==='claude_profile_create'));
});
test('Claude active enrollment exposes completion and return but protects ready accounts from switching',async()=>{
 const a=page({claude_profiles:()=>pendingClaude(true),claude_profile_onboard:({action})=>action==='complete'?claudeAccounts():pendingClaude()},'claude');await tick();
 assert.equal(a.elements.get('claude-add').disabled,true);const switchers=a.all('claude-accounts').filter(c=>c.classList.contains('profile-switch'));assert.ok(switchers.every(c=>c.disabled));
 assert.match(a.text('claude-accounts'),/完成添加.*返回添加前/);
 await a.all('claude-accounts').find(c=>c.textContent==='完成添加').events.click();
 assert.ok(!a.text('claude-accounts').includes('待登录'));assert.match(a.elements.get('claude-operation-text').textContent,/账号已添加/);
 assert.equal(a.elements.get('claude-add').disabled,false);
});
test('missing official Claude displays a useful reason and a pending account remains resumable',async()=>{
 const a=page({claude_profiles:()=>pendingClaude(),claude_profile_onboard:()=>{throw 'claude_not_installed';}},'claude');await tick();
 await a.all('claude-accounts').find(c=>c.textContent==='打开登录窗口').events.click();
 assert.match(a.elements.get('claude-operation-text').textContent,/未检测到官方 Claude/);assert.match(a.text('claude-accounts'),/待登录/);
 for(const poll of a.intervals)poll();await tick();assert.match(a.elements.get('claude-operation-text').textContent,/未检测到官方 Claude/);
});
test('missing Claude data is clearly labeled and cannot be switched or silently restored',async()=>{
 const a=page({claude_profiles:()=>({configured:true,active:'primary',profiles:[{id:'primary',name:'原账号',active:true,directoryMissing:true,sessions:0}]})},'claude');await tick();
 assert.match(a.text('claude-accounts'),/目录缺失/);assert.ok(a.all('claude-accounts').find(c=>c.classList.contains('profile-switch')).disabled);
 assert.match(a.elements.get('claude-sharing-status').textContent,/尚无可用的已登录账号/);
 assert.equal(a.elements.get('claude-add').disabled,false);assert.ok(!a.calls.some(c=>/switch|create|onboard/.test(c.name)));
});
test('protected current Claude and default Codex removal controls explain why they are unavailable',async()=>{
  const a=page({claude_profiles:claudeAccounts},'claude');await tick();const buttons=a.all('claude-accounts').filter(e=>e.classList.contains('profile-remove'));
  assert.equal(buttons[0].disabled,true);assert.match(buttons[0].title,/当前/);assert.equal(buttons[1].disabled,false);
  const b=page({},'codex');await tick();const remove=b.all('codex-accounts').find(e=>e.classList.contains('profile-remove'));assert.equal(remove.disabled,true);assert.match(remove.title,/手机连接/);
});
test('removal confirmation names its target; cancel and Escape never invoke management',async()=>{
  const a=page({claude_profiles:claudeAccounts},'claude');await tick();
  const remove=a.all('claude-accounts').filter(e=>e.classList.contains('profile-remove'))[1];
  let run=remove.events.click();await tick();assert.match(a.elements.get('profile-action-target').textContent,/Claude.*研究账号/);assert.match(a.elements.get('profile-action-hint').textContent,/数据.*保留/);
  assert.equal(a.context.document.activeElement,a.elements.get('profile-action-cancel'));
  for(const poll of a.intervals)poll();await tick();assert.equal(a.calls.filter(c=>c.name==='claude_profiles').length,1);
  await a.click('profile-action-cancel');await run;
  run=remove.events.click();await tick();a.key('Escape');await run;
  assert.ok(!a.calls.some(c=>c.name==='claude_profile_manage'));assert.equal(a.elements.get('profile-action-dialog').classList.contains('hidden'),true);
});
test('Claude removal and restore each execute once and never switch or start an account',async()=>{
  const initial=claudeAccounts(),removed={...initial,profiles:initial.profiles.slice(0,1),removedProfiles:[{id:'secondary',name:'研究账号',removedAt:1}]};let writes=0;
  const a=page({claude_profiles:()=>initial,claude_profile_manage:({action})=>{writes++;return action==='remove'?removed:initial;}},'claude');await tick();
  const remove=a.all('claude-accounts').filter(e=>e.classList.contains('profile-remove'))[1];const run=remove.events.click();await tick();
  await a.click('profile-action-confirm');await run;assert.equal(writes,1);assert.equal(a.elements.get('claude-count').textContent,'1');assert.match(a.text('claude-removed-list'),/研究账号.*恢复/);
  const restore=a.all('claude-removed-list').find(e=>e.classList.contains('profile-restore'));assert.equal(restore.disabled,false);
  const undo=restore.events.click();await tick();await a.click('profile-action-confirm');await undo;
  assert.equal(writes,2);assert.equal(a.elements.get('claude-count').textContent,'2');assert.equal(a.elements.get('claude-removed').classList.contains('hidden'),true);
  assert.ok(!a.calls.some(c=>/switch|open|create/.test(c.name)));
});
test('a delayed Claude poll cannot put a successfully removed account back on screen',async()=>{
  const stale=deferred(),initial=claudeAccounts();let reads=0;
  const a=page({claude_profiles:()=>++reads===1?initial:stale.promise,claude_profile_manage:()=>({...initial,profiles:initial.profiles.slice(0,1),removedProfiles:[{id:'secondary',name:'研究账号'}]})},'claude');await tick();
  const reading=a.click('claude-refresh');await tick();
  const run=a.all('claude-accounts').filter(e=>e.classList.contains('profile-remove'))[1].events.click();await tick();await a.click('profile-action-confirm');await run;
  stale.resolve(initial);await reading;assert.equal(a.elements.get('claude-count').textContent,'1');assert.ok(!a.text('claude-accounts').includes('研究账号'));
});
test('Codex list management retains default and re-enables restored controls after asynchronous completion',async()=>{
  const profile={id:'account-fixture',name:'中文测试账号'},initial=snapshot([snapshot().profiles[0],profile]),removed={...snapshot(),removedProfiles:[profile]};
  const a=page({codex_profiles:()=>initial,codex_profile_manage:({action})=>action==='remove'?removed:initial},'codex');await tick();
  const run=a.all('codex-accounts').filter(e=>e.classList.contains('profile-remove'))[1].events.click();await tick();await a.click('profile-action-confirm');await run;
  assert.equal(a.elements.get('codex-count').textContent,'1');const restore=a.all('codex-removed-list').find(e=>e.classList.contains('profile-restore'));assert.equal(restore.disabled,false);
  const undo=restore.events.click();await tick();await a.click('profile-action-confirm');await undo;assert.equal(a.elements.get('codex-count').textContent,'2');
  assert.ok(!a.calls.some(c=>/open|create/.test(c.name)));
});
test('a failed account removal shows the specific reason and retains the current list',async()=>{
  const a=page({claude_profiles:claudeAccounts,claude_profile_manage:()=>{throw 'registry_busy';}},'claude');await tick();
  const run=a.all('claude-accounts').filter(e=>e.classList.contains('profile-remove'))[1].events.click();await tick();await a.click('profile-action-confirm');await run;
  assert.match(a.elements.get('claude-operation-text').textContent,/正在切换或恢复/);assert.equal(a.elements.get('claude-count').textContent,'2');
});
test('grouped navigation exposes Claude and Codex separately and keeps remote available',async()=>{
  const a=page();await tick();await a.click('nav-claude');await tick();assert.equal(a.elements.get('page-title').textContent,'Claude 切换');assert.equal(a.elements.get('page-group').textContent,'账号切换');
  await a.click('nav-codex');await tick();assert.equal(a.elements.get('codex-view').classList.contains('hidden'),false);assert.equal(a.elements.get('claude-view').classList.contains('hidden'),true);
  await a.click('nav-accounts');assert.equal(a.elements.get('account-navigation').classList.contains('hidden'),true);
  await a.click('nav-remote');assert.equal(a.elements.get('remote-view').classList.contains('hidden'),false);assert.equal(a.elements.get('page-group').textContent,'工作区');
});
test('production gate hides Claude account switching and keeps the caches untouched',async()=>{
  const features=fs.readFileSync(path.join(__dirname,'../src/features.js'),'utf8');
  assert.match(features,/claudeAccountSwitch:\s*false/);
  const a=page({claude_profiles:claudeAccounts},'claude',{claudeAccountSwitch:false});await tick();
  assert.equal(a.elements.get('claude-view').classList.contains('hidden'),true);
  assert.equal(a.elements.get('nav-claude').classList.contains('hidden'),true);
  assert.equal(a.elements.get('sheet-claude').classList.contains('hidden'),true);
  assert.equal(a.elements.get('page-title').textContent,'手机远程控制');
  assert.equal(a.elements.get('page-group').textContent,'工作区');
  assert.ok(!a.calls.some(c=>c.name==='claude_profiles'));
  assert.ok(!a.calls.some(c=>/claude_profile|claude_switch/.test(c.name)));
});
test('production hides the unfinished account switch navigation completely',async()=>{
  const a=page({},'remote',{claudeAccountSwitch:false,accountSwitch:false});await tick();
  assert.equal(a.elements.get('nav-accounts').classList.contains('hidden'),true);
  assert.equal(a.elements.get('account-navigation').classList.contains('hidden'),true);
  assert.equal(a.elements.get('nav-accounts').attrs['aria-hidden'],'true');
  assert.equal(a.elements.get('nav-accounts').classes.has('nav-soon'),false);
  assert.equal(a.elements.get('page-title').textContent,'手机远程控制');
});
test('desktop account cards show official identity separately from editable remarks',async()=>{
  const a=page({claude_profiles:()=>({configured:true,active:'primary',profiles:[{id:'primary',name:'工作账号',sessions:16,active:true,identity:{status:'matched',accountId:'11111111-2222-4333-8444-555555555555',shortId:'11111111…5555'}}]})},'claude');await tick();
  assert.match(a.text('claude-accounts'),/工作账号.*账号 ID：11111111…5555.*16 个 Code 会话/);
  const row=a.all('claude-accounts').find(el=>el.classList.contains('profile-account'));
  assert.match(row.title,/11111111-2222-4333-8444-555555555555/);
  const b=page({codex_profiles:()=>snapshot([{id:'default',name:'研究账号',record:{loggedIn:true,kind:'chatgpt',plan:'pro',identity:{email:'owner@example.invalid'}}}])},'codex');await tick();
  assert.match(b.text('codex-accounts'),/研究账号.*owner@example.invalid.*ChatGPT · Pro/);
});
test('a changed Claude account is called out instead of showing a previous identity',async()=>{
  const a=page({claude_profiles:()=>({configured:true,profiles:[{id:'primary',name:'备注',sessions:16,identity:{status:'changed'}}]})},'claude');await tick();
  assert.match(a.text('claude-accounts'),/账号已变化，请核对本地登记/);
  assert.ok(!a.text('claude-accounts').includes('undefined'));
});
test('remembered Codex page reads once without switching any real account',async()=>{
  const a=page({},'codex');await tick();assert.equal(a.calls.filter(x=>x.name==='codex_profiles').length,1);assert.ok(!a.calls.some(x=>/open|switch|create/.test(x.name)));
  assert.match(a.text('codex-accounts'),/暂无记录/);assert.ok(!a.text('codex-accounts').includes('100%'));
});
test('official two-window usage renders with observation and unavailable login is distinct',async()=>{
  const at=Date.now(),usage={observedAt:at,fiveHour:{remaining:63,observedAt:at,resetsAt:at+3600000},sevenDay:{remaining:25,observedAt:at,resetsAt:at+86400000}};
  const a=page({codex_profiles:()=>snapshot([{id:'default',name:'测试账号',primary:true,running:true,record:{loggedIn:true,kind:'chatgpt',plan:'pro',usage}}])},'codex');await tick();
  const text=a.text('codex-accounts');assert.match(text,/63%/);assert.match(text,/25%/);assert.match(text,/手机使用/);assert.match(text,/后重置/);assert.match(text,/读取/);
  assert.equal(loginLabel({loggedIn:false}),'等待在官方窗口登录');assert.equal(loginLabel({loggedIn:null}),'等待读取登录状态');
});
test('adding an account opens only its own returned id; a second submit is blocked',async()=>{
  const pending=deferred();const a=page({codex_profile_create:()=>pending.promise,codex_profile_open:()=>snapshot()},'codex');await tick();await a.click('codex-add');a.elements.get('codex-name-input').value='工作账号';
  const run=a.submit();await tick();await a.submit();assert.equal(a.calls.filter(x=>x.name==='codex_profile_create').length,1);
  pending.resolve({id:'new-id',state:snapshot()});await run;assert.deepEqual(JSON.parse(JSON.stringify(a.calls.find(x=>x.name==='codex_profile_open').args)),{profile:'new-id'});
});
test('opening failure keeps created profile visible and does not repeat creation',async()=>{
  const next=snapshot([{id:'default',name:'默认',primary:true},{id:'new-id',name:'工作账号',primary:false}]);
  const a=page({codex_profile_create:()=>({id:'new-id',state:next}),codex_profile_open:()=>{throw Error('打开失败');}},'codex');await tick();await a.click('codex-add');a.elements.get('codex-name-input').value='工作账号';await a.submit();
  assert.match(a.text('codex-accounts'),/工作账号/);assert.match(a.elements.get('codex-operation-text').textContent,/打开失败/);assert.equal(a.elements.get('codex-operation').classList.contains('working'),false);
});

test('an open account dialog suspends polling so submitting is never silently ignored',async()=>{
  const a=page({codex_profile_create:()=>({id:'new-id',state:snapshot()}),codex_profile_open:()=>snapshot()},'codex');await tick();
  await a.click('codex-add');const before=a.calls.filter(x=>x.name==='codex_profiles').length;
  for(const poll of a.intervals)poll();await tick();
  assert.equal(a.calls.filter(x=>x.name==='codex_profiles').length,before);
  a.elements.get('codex-name-input').value='备用';await a.submit();
  assert.equal(a.calls.filter(x=>x.name==='codex_profile_create').length,1);
});
test('manual refresh requests a new observation and unavailable app disables launch/add',async()=>{
  const a=page({},'codex');await tick();await a.click('codex-refresh');assert.equal(a.calls.at(-1).args.force,true);
  const b=page({codex_profiles:()=>({...snapshot(),available:false,message:'未安装'})},'codex');await tick();assert.equal(b.elements.get('codex-add').disabled,true);assert.match(b.elements.get('codex-operation-text').textContent,/未安装/);
});
test('a weekly-only official plan hides the absent short window',async()=>{
  const at=Date.now(),usage={observedAt:at,fiveHour:null,sevenDay:{remaining:2,observedAt:at,resetsAt:at+86400000}};
  const a=page({codex_profiles:()=>snapshot([{id:'default',name:'默认账号',record:{loggedIn:true,kind:'chatgpt',plan:'prolite',usage}}])},'codex');await tick();
  const text=a.text('codex-accounts');assert.ok(!text.includes('5 小时额度'));assert.ok(!text.includes('官方未提供此窗口'));assert.match(text,/2%/);assert.ok(!text.includes('100%'));
  assert.equal(a.all('codex-accounts').filter(x=>x.classList.contains('quota-window')).length,1);
  assert.equal(a.all('codex-accounts').filter(x=>x.classList.contains('single-window')).length,1);
});

test('a zero remaining short window is still shown; absent is not zero',async()=>{
  const at=Date.now(),usage={observedAt:at,fiveHour:{remaining:0,observedAt:at,resetsAt:at+3600000},sevenDay:{remaining:55,observedAt:at,resetsAt:at+86400000}};
  const a=page({codex_profiles:()=>snapshot([{id:'default',name:'测试账号',record:{loggedIn:true,kind:'chatgpt',plan:'plus',usage}}])},'codex');await tick();
  const text=a.text('codex-accounts');assert.match(text,/5 小时额度/);assert.match(text,/0%/);assert.match(text,/55%/);
  assert.equal(a.all('codex-accounts').filter(x=>x.classList.contains('quota-window')).length,2);
});

test('an old or offline connector blocks isolated launch while the default window remains usable',async()=>{
  const a=page({codex_profiles:()=>({...snapshot([{id:'default',name:'默认',primary:true},{id:'other',name:'备用',primary:false}]),remoteIsolationReady:false})},'codex');await tick();
  assert.equal(a.elements.get('codex-add').disabled,true);
  const open=a.all('codex-accounts').filter(x=>x.classList.contains('codex-open'));
  assert.equal(open[0].disabled,false);assert.equal(open[1].disabled,true);
  assert.match(a.elements.get('codex-operation-text').textContent,/手机只控制默认账号/);
});
test('closed account switching only says it is not open yet and never shows its pages',async()=>{
  const features=fs.readFileSync(path.join(__dirname,'../src/features.js'),'utf8');
  assert.match(features,/accountSwitch:\s*false/);
  const toasts=[];const a=page({},'codex',{claudeAccountSwitch:false,accountSwitch:false});a.context.toast=m=>toasts.push(m);await tick();
  assert.equal(a.elements.get('page-title').textContent,'手机远程控制');
  for(const id of ['account-navigation','codex-view','claude-view','sheet-codex','sheet-claude'])assert.equal(a.elements.get(id).classList.contains('hidden'),true,id);
  await a.click('nav-accounts');
  assert.deepEqual(toasts,['账号切换功能开发完善中，暂未开放']);
  assert.equal(a.elements.get('account-navigation').classList.contains('hidden'),true);
  assert.equal(a.elements.get('remote-view').classList.contains('hidden'),false);
});
