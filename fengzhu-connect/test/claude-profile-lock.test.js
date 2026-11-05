const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
process.env.KH_LINK_CLAUDE_ACCOUNT_SWITCH='1';
const {withLease,switching}=require('../src/backends/claude-profile-lock');
// Fixtures go to KHLINK_TEST_DIR or the system temp folder.
const FIXTURES = process.env.KHLINK_TEST_DIR || require('node:os').tmpdir();
function root(){const r=fs.mkdtempSync(path.join(FIXTURES, 'kh-profile-lock-'));fs.writeFileSync(path.join(r,'config.json'),'{}');return r;}
test('switching refuses a phone send as definitely not sent',async()=>{const r=root();fs.writeFileSync(path.join(r,'desktop-switch.lock'),'1');let sent=false;assert.equal(switching(r),true);await assert.rejects(withLease(()=>{sent=true},r),e=>e.delivery==='not_sent'&&e.code==='claude_profile_switching');assert.equal(sent,false);});
test('in-flight desktop operation keeps a lease until completion and cleans failures',async()=>{const r=root();let finish;const pending=withLease(()=>new Promise(resolve=>{finish=resolve}),r);assert.equal(fs.readdirSync(r).filter(x=>x.startsWith('desktop-operation-')).length,1);finish('ok');assert.equal(await pending,'ok');assert.equal(fs.readdirSync(r).length,1);await assert.rejects(withLease(()=>{throw Error('test')},r));assert.equal(fs.readdirSync(r).length,1);});
test('unmanaged installations retain their existing behavior',async()=>{const r=fs.mkdtempSync(path.join(FIXTURES, 'kh-unmanaged-'));assert.equal(await withLease(()=>42,r),42);assert.deepEqual(fs.readdirSync(r),[]);});
test('pending login refuses phone sends and quota identity even after its mutation lock was released',async()=>{
 const base=fs.mkdtempSync(path.join(FIXTURES, 'pending-login-')),shared=path.join(base,'shared'),profile=path.join(base,'profiles','pending'),link=path.join(base,'official');
 fs.mkdirSync(shared,{recursive:true});fs.mkdirSync(profile,{recursive:true});fs.symlinkSync(profile,link,'junction');
 fs.writeFileSync(path.join(shared,'config.json'),JSON.stringify({version:1,root:base,activeLink:link,profiles:{pending:'claude-code-sessions/a/b'}}));
 fs.writeFileSync(path.join(shared,'onboarding.json'),JSON.stringify({version:1,profiles:{pending:{phase:'adopted'}}}));
 assert.equal(switching(shared),true);assert.equal(require('../src/backends/claude-profile-lock').registeredProfile(link,shared),null);
 let sends=0;await assert.rejects(withLease(()=>sends++,shared),e=>e.delivery==='not_sent');assert.equal(sends,0);
 fs.writeFileSync(path.join(shared,'onboarding.json'),JSON.stringify({version:1,profiles:{}}));
 assert.equal(switching(shared),false);assert.equal(require('../src/backends/claude-profile-lock').registeredProfile(link,shared).alias,'pending');
});
test('phone account DTO excludes enrollment and missing registrations without exposing their identity',()=>{
 const {publicState}=require('../src/agent-accounts');
 const dto=publicState('claude',{active:'new-account',awaitingLogin:true,profiles:[{id:'ready',name:'工作账号'},{id:'new-account',name:'pending@example.invalid',pending:true,accountId:'SENSITIVE'},{id:'gone',directoryMissing:true,root:'G:\\private'}]},null,{identity:(_scope,alias)=>'opaque-'+alias});
 assert.equal(dto.profiles.length,1);assert.equal(dto.profiles[0].name,'工作账号');assert.equal(dto.active,null);assert.equal(dto.switching,true);
 assert.doesNotMatch(JSON.stringify(dto),/private|SENSITIVE|@|new-account|gone/);
});
test('a forged phone target cannot start enrollment or switch into a pending account',async()=>{
 const {AgentAccounts}=require('../src/agent-accounts'),{accountIdentity}=require('../src/account-identity');let started=0;
 const accounts=new AgentAccounts({syncClaudeDesktopSessions:()=>{started++;}},{operations:{requestFile:()=> 'unused'},spawn:()=>{started++;throw Error('must not spawn');}});
 accounts.raw=async()=>({active:'primary',awaitingLogin:true,profiles:[{id:'pending',pending:true}]});
 const request={backend:'claude',to:accountIdentity('accounts-claude','pending'),requestId:'fixture-req'};
 await assert.rejects(accounts.switch(request),e=>e.code==='busy');
 accounts.raw=async()=>({active:'primary',profiles:[{id:'pending',pending:true},{id:'gone',directoryMissing:true}]});
 await assert.rejects(accounts.switch(request),e=>e.code==='invalid_request');assert.equal(started,0);
});


test('registered account mapping wins over unrelated newer organization folders',()=>{
 const base=fs.mkdtempSync(path.join(FIXTURES, 'profile-registry-')),shared=path.join(base,'shared');fs.mkdirSync(shared);
 const profile=path.join(base,'profiles','primary');fs.mkdirSync(path.join(profile,'claude-code-sessions','account','org'),{recursive:true});
 const link=path.join(base,'official');fs.symlinkSync(profile,link,'junction');
 fs.writeFileSync(path.join(shared,'config.json'),JSON.stringify({version:1,root:base,activeLink:link,profiles:{primary:'claude-code-sessions/account/org'}}));
 const {registeredAccountDir}=require('../src/backends/claude-profile-lock');
 assert.equal(registeredAccountDir(link,shared),path.join(link,'claude-code-sessions/account/org'));
 assert.equal(registeredAccountDir(path.join(base,'unmanaged'),shared),undefined);
 fs.writeFileSync(path.join(shared,'config.json'),JSON.stringify({version:1,root:base,activeLink:link,profiles:{primary:'../../outside'}}));
 assert.equal(registeredAccountDir(link,shared),null);
});

test('managed quota reads never query CLI auth or send a model prompt',async()=>{
 const {methods}=require('../src/backends/claude-desktop-sync');let published=0;
 const owner={claudeProfileLock:{managed:()=>true,withLease:action=>action()},currentClaudeBin(){throw Error('CLI must not run')},publishClaudeUsage(){published++;return {source:'local'}}};
 assert.equal(await methods.refreshClaudeCliOrg.call(owner),null);
 assert.equal(await methods.maybeRefreshFiveHourReset.call(owner),false);
 assert.deepEqual(await methods.refreshClaudeUsage.call(owner),{source:'local'});
 assert.equal(published,1);assert.equal(owner._claudeUsageRefreshUnavailableReason,'desktop_refresh_required');
});

test('desktop import holds its lease until the asynchronous import settles',async()=>{
 const {methods}=require('../src/backends/claude-desktop-sync');const r=root();let finish;
 const owner={claudeThreads:new Map([['t',{sessionId:'s'}]]),claudeProfileLock:{switching:()=>false,withLease:action=>withLease(action,r)},claudeDesktop:{available:()=>true,importSession:()=>new Promise(resolve=>{finish=resolve})},setClaudeThreadFields(){},saveClaudeThreads(){},log(e){throw e}};
 const pending=methods.registerClaudeThreadOnDesktop.call(owner,'t');
 assert.equal(fs.readdirSync(r).filter(x=>x.startsWith('desktop-operation-')).length,1);finish(false);await pending;assert.equal(fs.readdirSync(r).filter(x=>x.startsWith('desktop-operation-')).length,0);
});

test('managed profile cannot fall back to another org while its link is unavailable',()=>{
 const {ClaudeDesktopStore}=require('../src/backends/claude-desktop');const r=fs.mkdtempSync(path.join(FIXTURES, 'usage-isolation-'));
 fs.writeFileSync(path.join(r,'plan-usage-history.json'),JSON.stringify({version:2,samples:[{org:'other',t:Date.now(),u:{fh:99,sd:99}},{t:Date.now(),u:{fh:0,sd:0}}]}));
 const store=Object.create(ClaudeDesktopStore.prototype);store.root=r;store.usageSampleCache={org:'old',fiveHour:1};store.accountDir=function(){this.managedProfile=true;return null};
 assert.equal(store.latestUsageSample(),null);assert.equal(store.usageSampleCache,null);
 store.accountDir=function(){this.managedProfile=true;return path.join(r,'registered')};assert.equal(store.latestUsageSample(),null);
});

test('a reinstalled official folder that is a plain directory is unmanaged even with a pending login',()=>{
 const lock=require('../src/backends/claude-profile-lock');
 const fixture=()=>{const base=fs.mkdtempSync(path.join(FIXTURES, 'reinstalled-')),shared=path.join(base,'shared'),link=path.join(base,'official');
  fs.mkdirSync(shared);fs.mkdirSync(path.join(base,'profiles','account-pending'),{recursive:true});fs.mkdirSync(path.join(link,'claude-code-sessions'),{recursive:true});
  fs.writeFileSync(path.join(shared,'config.json'),JSON.stringify({version:1,root:base,activeLink:link,profiles:{},unavailableProfiles:{primary:{directory:'claude-code-sessions/a/b'}}}));
  fs.writeFileSync(path.join(shared,'onboarding.json'),JSON.stringify({version:1,profiles:{'account-pending':{phase:'created'}}}));
  return {shared,link};};
 let f=fixture();
 assert.equal(lock.switching(f.shared),false);assert.equal(lock.registeredProfile(f.link,f.shared),undefined);assert.equal(lock.registeredAccountDir(f.link,f.shared),undefined);
 fs.writeFileSync(path.join(f.shared,'link-transaction.json'),JSON.stringify({phase:'done',from:'secondary',to:'primary'}));
 assert.equal(lock.switching(f.shared),false);assert.equal(lock.registeredProfile(f.link,f.shared),undefined);
 fs.writeFileSync(path.join(f.shared,'link-transaction.json'),JSON.stringify({phase:'rolled_back'}));
 assert.equal(lock.switching(f.shared),false);
 // An unfinished link transaction keeps the strict handling.
 fs.writeFileSync(path.join(f.shared,'link-transaction.json'),JSON.stringify({phase:'original_preserved'}));
 assert.equal(lock.switching(f.shared),true);assert.equal(lock.registeredProfile(f.link,f.shared),null);
 fs.writeFileSync(path.join(f.shared,'link-transaction.json'),'{broken');
 assert.equal(lock.switching(f.shared),true);assert.equal(lock.registeredProfile(f.link,f.shared),null);
 // So does a switch lock or a running switch script.
 for(const name of ['desktop-switch.lock','switch.lock']){f=fixture();fs.writeFileSync(path.join(f.shared,name),'1');
  assert.equal(lock.registeredProfile(f.link,f.shared),null,name);assert.equal(lock.switching(f.shared),true,name);}
});

test('a linked official folder with a pending login stays strict',()=>{
 const lock=require('../src/backends/claude-profile-lock');
 const base=fs.mkdtempSync(path.join(FIXTURES, 'linked-pending-')),shared=path.join(base,'shared'),profile=path.join(base,'profiles','account-pending'),link=path.join(base,'official');
 fs.mkdirSync(shared);fs.mkdirSync(profile,{recursive:true});fs.symlinkSync(profile,link,'junction');
 fs.writeFileSync(path.join(shared,'config.json'),JSON.stringify({version:1,root:base,activeLink:link,profiles:{}}));
 fs.writeFileSync(path.join(shared,'onboarding.json'),JSON.stringify({version:1,profiles:{'account-pending':{phase:'created'}}}));
 assert.equal(lock.switching(shared),true);assert.equal(lock.registeredProfile(link,shared),null);
 fs.mkdirSync(path.join(base,'missing-target'));const other=path.join(base,'other');fs.symlinkSync(path.join(base,'missing-target'),other,'junction');
 fs.writeFileSync(path.join(shared,'config.json'),JSON.stringify({version:1,root:base,activeLink:other,profiles:{}}));
 assert.equal(lock.registeredProfile(other,shared),null);
});

test('finished onboarding entries no longer block switching when the official link is gone',()=>{
 const lock=require('../src/backends/claude-profile-lock');
 const base=fs.mkdtempSync(path.join(FIXTURES, 'finished-onboarding-')),shared=path.join(base,'shared'),profile=path.join(base,'profiles','account-fixture'),link=path.join(base,'official');
 fs.mkdirSync(shared);fs.mkdirSync(profile,{recursive:true});fs.symlinkSync(profile,link,'junction');
 fs.writeFileSync(path.join(shared,'config.json'),JSON.stringify({version:1,root:base,activeLink:link,profiles:{}}));
 fs.writeFileSync(path.join(shared,'onboarding.json'),JSON.stringify({version:1,profiles:{'account-fixture':{phase:'created'}}}));
 assert.equal(lock.switching(shared),true);
 fs.writeFileSync(path.join(shared,'onboarding.json'),JSON.stringify({version:1,profiles:{'account-fixture':{phase:'removed',previousPhase:'created',removedAt:1}}}));
 assert.equal(lock.switching(shared),false);
 fs.writeFileSync(path.join(shared,'onboarding.json'),JSON.stringify({version:1,profiles:{}}));
 assert.equal(lock.switching(shared),false);
 fs.unlinkSync(link);
 fs.writeFileSync(path.join(shared,'onboarding.json'),JSON.stringify({version:1,profiles:{'account-fixture':{phase:'removed',previousPhase:'created',removedAt:1}}}));
 assert.equal(lock.switching(shared),false);
});

test('closed account switching never reads the G: registry',()=>{
 const lock=require('../src/backends/claude-profile-lock');
 const base=fs.mkdtempSync(path.join(FIXTURES,'kh-disabled-switch-')),shared=path.join(base,'shared'),profile=path.join(base,'profiles','account'),link=path.join(base,'official');
 fs.mkdirSync(shared);fs.mkdirSync(profile,{recursive:true});fs.symlinkSync(profile,link,'junction');
 fs.writeFileSync(path.join(shared,'config.json'),JSON.stringify({version:1,root:base,activeLink:link,profiles:{account:'claude-code-sessions/a/b'}}));
 fs.writeFileSync(path.join(shared,'onboarding.json'),JSON.stringify({version:1,profiles:{account:{phase:'created'}}}));
 const previous=process.env.KH_LINK_CLAUDE_ACCOUNT_SWITCH;delete process.env.KH_LINK_CLAUDE_ACCOUNT_SWITCH;
 try{
  assert.equal(lock.managed(shared),false);
  assert.equal(lock.switching(shared),false);
  assert.equal(lock.registeredProfile(link,shared),undefined);
  assert.equal(lock.registeredAccountDir(link,shared),undefined);
 }finally{if(previous===undefined)delete process.env.KH_LINK_CLAUDE_ACCOUNT_SWITCH;else process.env.KH_LINK_CLAUDE_ACCOUNT_SWITCH=previous;}
});
