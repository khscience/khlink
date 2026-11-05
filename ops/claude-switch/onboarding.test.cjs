const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Onboarding, atomic } = require('./onboarding.cjs');
const catalog = require('./catalog.cjs'), share = require('./session-share.cjs');
const idName = 'local_11111111-2222-4333-8444-555555555555.json';
const record = text => Buffer.from(JSON.stringify({ sessionId: idName.slice(0,-5), cliSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cwd: 'I:\\tmp\\khlink-test', title: text })+'\n');
function fixture(t, { missing = false } = {}) {
  const base = fs.realpathSync.native(os.tmpdir()), root = fs.mkdtempSync(path.join(base,'kh-enrollment-'));
  t.after(()=>{assert.equal(path.dirname(root),base);assert.ok(path.basename(root).startsWith('kh-enrollment-'));fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(path.join(root,'shared'));
  const config={version:1,root,activeLink:path.join(root,'official'),desktopVersion:'synthetic',profiles:{primary:'claude-code-sessions/a/b'}};
  fs.mkdirSync(path.join(root,'profiles/primary',config.profiles.primary),{recursive:true});
  fs.symlinkSync(path.join(root,'profiles/primary'),config.activeLink,process.platform==='win32'?'junction':'dir');
  if(missing)fs.rmSync(path.join(root,'profiles/primary'),{recursive:true});
  atomic(root,'shared/config.json',config);
  let guards=0,sidebars=0;
  const onboarding=new Onboarding({root,globalProjects:path.join(root,'global/projects'),protectDirectory:()=>{},now:()=>100000,guard:()=>{guards++;},synchronizeSidebar:async(c,from,guard)=>{guard();sidebars++;assert.ok(c.profiles[from]);}});
  return {root,config,onboarding,counts:()=>({guards,sidebars}),claim:id=>atomic(root,'shared/desktop-switch.lock',{kind:'onboarding',to:id,pid:process.pid})};
}
test('create makes an isolated empty pending profile without reading existing login files',t=>{
  const f=fixture(t),secret=path.join(f.root,'profiles/primary/Cookies');fs.writeFileSync(secret,'SYNTHETIC');
  const read=fs.readFileSync;fs.readFileSync=function(file,...args){assert.notEqual(String(file),secret);return read.call(this,file,...args);};
  let id;try{id=f.onboarding.create('  工作账号  ').id;}finally{fs.readFileSync=read;}
  assert.match(id,/^account-[a-f0-9]{16}$/);assert.equal(f.onboarding.profile(id).name,'工作账号');
  assert.deepEqual(fs.readdirSync(path.join(f.root,'profiles',id)),['khlink-profile.json']);
  assert.deepEqual(f.onboarding.config().profiles,f.config.profiles);assert.equal(catalog.current(f.config,f.onboarding.store()),'primary');
  assert.equal(fs.readFileSync(secret,'utf8'),'SYNTHETIC');assert.equal(f.counts().sidebars,0);
});
test('missing registrations remain visible metadata and are never recreated while adding',t=>{
  const f=fixture(t,{missing:true}),id=f.onboarding.create('新账号').id,c=f.onboarding.config();
  assert.deepEqual(c.profiles,{});assert.deepEqual(c.unavailableProfiles,{primary:{directory:f.config.profiles.primary}});
  assert.equal(fs.existsSync(path.join(f.root,'profiles/primary')),false);assert.ok(f.onboarding.profile(id));
  assert.throws(()=>share.validateConfig(c),/At least one/);
});
test('invalid names and competing switch locks fail before account creation',t=>{
  const f=fixture(t),before=fs.readFileSync(path.join(f.root,'shared/config.json'));
  for(const name of ['', 'x'.repeat(33),'a\nb'])assert.throws(()=>f.onboarding.create(name));
  f.claim('primary');assert.throws(()=>f.onboarding.create('不会创建'),/正在切换/);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'shared/config.json')),before);assert.equal(fs.existsSync(path.join(f.root,'shared/onboarding.json')),false);
});
test('only a dead enrollment owner can be recovered, never a live helper or an ordinary switch',t=>{
 const f=fixture(t),id=f.onboarding.create('测试账号').id;
 f.claim(id);assert.throws(()=>f.onboarding.recover(id),e=>e.code==='onboarding_busy');
 atomic(f.root,'shared/desktop-switch.lock',{kind:'onboarding',to:id,pid:2147483646,helperPid:process.pid});assert.throws(()=>f.onboarding.recover(id));
 atomic(f.root,'shared/desktop-switch.lock',{kind:'ordinary',to:id,pid:2147483646});assert.throws(()=>f.onboarding.recover(id));
 atomic(f.root,'shared/desktop-switch.lock',{kind:'onboarding',to:id,pid:2147483646});assert.deepEqual(f.onboarding.recover(id),{recovered:true});
 assert.equal(fs.existsSync(path.join(f.root,'shared/desktop-switch.lock')),false);assert.ok(f.counts().guards>0);
});
test('pending removal and restoration only change metadata; current pending profile is protected',t=>{
  const f=fixture(t),id=f.onboarding.create('测试账号').id,file=path.join(f.root,'profiles',id,'Cookies');fs.writeFileSync(file,'SYNTHETIC');
  f.onboarding.manage('remove',id);assert.equal(f.onboarding.store().profiles[id].phase,'removed');
  assert.throws(()=>f.onboarding.profile(id));assert.equal(fs.readFileSync(file,'utf8'),'SYNTHETIC');
  f.onboarding.manage('restore',id);assert.equal(f.onboarding.profile(id).phase,'created');
  fs.unlinkSync(f.config.activeLink);fs.symlinkSync(path.join(f.root,'profiles',id),f.config.activeLink,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>f.onboarding.manage('remove',id),e=>e.code==='onboarding_pending');
});
test('official Code folder discovery is exact and refuses ambiguous choices',t=>{
  const f=fixture(t),id=f.onboarding.create('账号').id;
  assert.deepEqual(f.onboarding.candidates(id),[]);
  fs.mkdirSync(path.join(f.root,'profiles',id,'claude-code-sessions/account/org'),{recursive:true});
  assert.equal(f.onboarding.candidates(id).length,1);
  fs.mkdirSync(path.join(f.root,'profiles',id,'claude-code-sessions/account/other'),{recursive:true});
  assert.equal(f.onboarding.candidates(id).length,2);
});
test('an empty first Code account creates the shared inventory before sidebar adoption',async t=>{
 const f=fixture(t,{missing:true}),id=f.onboarding.create('首个账号').id;
 fs.unlinkSync(f.config.activeLink);fs.symlinkSync(path.join(f.root,'profiles',id),f.config.activeLink,'junction');
 fs.mkdirSync(path.join(f.root,'profiles',id,'claude-code-sessions/a/b'),{recursive:true});f.claim(id);
 await f.onboarding.complete(id,process.pid);
 assert.deepEqual(fs.readdirSync(path.join(f.root,'shared/code-indexes')),[]);
 assert.equal(f.onboarding.profile(id).phase,'adopted');
});
test('returning after index adoption removes the pending alias from ordinary switch scope',async t=>{
 const f=fixture(t);atomic(f.root,'shared/state.json',{version:1,generation:1,records:{}});
 const id=f.onboarding.create('新增账号').id;
 fs.mkdirSync(path.join(f.root,'profiles',id,'claude-code-sessions/a/b'),{recursive:true});
 fs.unlinkSync(f.config.activeLink);fs.symlinkSync(path.join(f.root,'profiles',id),f.config.activeLink,'junction');f.claim(id);
 await f.onboarding.complete(id,process.pid);assert.ok(f.onboarding.config().profiles[id]);
 fs.unlinkSync(f.config.activeLink);fs.symlinkSync(path.join(f.root,'profiles/primary'),f.config.activeLink,'junction');
 f.onboarding.returned(id,process.pid);
 const c=f.onboarding.config();assert.deepEqual(Object.keys(c.profiles),['primary']);assert.equal(f.onboarding.profile(id).phase,'created');
 assert.ok(share.plan(c,{from:'primary'}));assert.ok(fs.existsSync(path.join(f.root,'profiles',id,'claude-code-sessions/a/b')));
});
test('body location is a verified link; an existing real directory is never overwritten',t=>{
  const f=fixture(t);f.onboarding.ensureBodyLink();assert.equal(fs.realpathSync(f.onboarding.globalProjects),path.join(f.root,'shared/code-projects'));
  fs.unlinkSync(f.onboarding.globalProjects);fs.mkdirSync(f.onboarding.globalProjects);fs.writeFileSync(path.join(f.onboarding.globalProjects,'preserve'),'yes');
  assert.throws(()=>f.onboarding.ensureBodyLink(),e=>e.code==='onboarding_directory');assert.equal(fs.readFileSync(path.join(f.onboarding.globalProjects,'preserve'),'utf8'),'yes');
});
test('offline enrollment bootstraps from new Code metadata and becomes ready only after commit',async t=>{
  const f=fixture(t,{missing:true}),id=f.onboarding.create('新账号').id;f.claim(id);
  await f.onboarding.prepare(id,process.pid);assert.equal(f.onboarding.profile(id).phase,'login');
  fs.unlinkSync(f.config.activeLink);fs.symlinkSync(path.join(f.root,'profiles',id),f.config.activeLink,process.platform==='win32'?'junction':'dir');
  const code=path.join(f.root,'profiles',id,'claude-code-sessions/account/org');fs.mkdirSync(code,{recursive:true});fs.writeFileSync(path.join(code,idName),record('中文新会话'));
  await f.onboarding.complete(id,process.pid);assert.equal(f.onboarding.profile(id).phase,'adopted');
  assert.ok(f.onboarding.config().profiles[id]);assert.deepEqual(fs.readFileSync(path.join(f.root,'shared/code-indexes',idName)),record('中文新会话'));
  f.onboarding.commit(id,process.pid);assert.ok(!f.onboarding.store().profiles[id]);assert.equal(f.counts().sidebars,1);assert.ok(f.counts().guards>3);
});
test('unknown owner and missing Code login cannot publish a ready account',async t=>{
  const f=fixture(t,{missing:true}),id=f.onboarding.create('未登录').id;
  await assert.rejects(()=>f.onboarding.prepare(id,process.pid),e=>e.code==='onboarding_busy');f.claim(id);
  fs.unlinkSync(f.config.activeLink);fs.symlinkSync(path.join(f.root,'profiles',id),f.config.activeLink,process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>f.onboarding.complete(id,process.pid),e=>e.code==='onboarding_no_code');
  assert.ok(!f.onboarding.config().profiles[id]);assert.equal(fs.existsSync(path.join(f.root,'shared/code-indexes')),false);
});
test('enroll index conflicts stop before changing old shared records',t=>{
  const f=fixture(t),config=f.onboarding.config(),old=record('原会话');
  fs.mkdirSync(path.join(f.root,'shared/code-indexes'));fs.writeFileSync(path.join(f.root,'shared/code-indexes',idName),old);fs.writeFileSync(path.join(f.root,'profiles/primary',config.profiles.primary,idName),old);
  atomic(f.root,'shared/state.json',{version:1,records:share.inventory(share.scan(config,'shared/code-indexes'))});
  const alias='new-account',relative='claude-code-sessions/new/org';fs.mkdirSync(path.join(f.root,'profiles',alias,relative),{recursive:true});fs.writeFileSync(path.join(f.root,'profiles',alias,relative,idName),record('冲突内容'));
  assert.throws(()=>share.enrollPlan(config,alias,relative),/Conflicting/);assert.deepEqual(fs.readFileSync(path.join(f.root,'shared/code-indexes',idName)),old);
});
