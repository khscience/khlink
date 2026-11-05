'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Profiles, visibleName } = require('./profiles.cjs');
const { main } = require('./console.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'kh-codex-switch-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const defaultHome=path.join(root,'original'); fs.mkdirSync(defaultHome); fs.writeFileSync(path.join(defaultHome,'auth.json'),'SYNTHETIC-DO-NOT-READ');
  return { root, defaultHome, store:new Profiles({root:path.join(root,'managed'),defaultHome,protect:()=>{}}) };
}
test('default account uses its original directory without touching any content',t=>{
  const {store,defaultHome}=fixture(t); const before=fs.readdirSync(defaultHome);
  const s=store.state(); assert.equal(s.profiles[0].home,defaultHome); assert.equal(s.profiles[0].record,null);
  assert.deepEqual(fs.readdirSync(defaultHome),before); assert.equal(fs.existsSync(store.root),false);
});
test('new accounts have independent empty homes, keep default account and never copy login files',t=>{
  const {store,defaultHome}=fixture(t); const a=store.create('工作账号'),b=store.create('备用账号');
  assert.notEqual(a.home,b.home); assert.notEqual(a.userData,b.userData);
  assert.deepEqual(fs.readdirSync(a.home),['config.toml']); assert.deepEqual(fs.readdirSync(b.userData),[]);
  assert.deepEqual(fs.readdirSync(defaultHome),['auth.json']); assert.equal(store.state().profiles.length,3);
  assert.match(fs.readFileSync(path.join(a.home,'config.toml'),'utf8'),/cli_auth_credentials_store = "file"/);
});
test('rename and select preserve directory and all previous usage records',t=>{
  const {store}=fixture(t),a=store.create('备用'); store.saveRecord('default',{usage:{observedAt:123}}); store.rename(a.id,'开发账号');store.select(a.id);
  const s=store.state(); assert.equal(s.selected,a.id); assert.equal(s.profiles[1].home,a.home); assert.equal(s.profiles[1].name,'开发账号'); assert.equal(s.profiles[0].record.usage.observedAt,123);
});
test('invalid names, missing ids, traversal and corrupted config fail closed',t=>{
  const {store}=fixture(t); for(const n of ['', ' '.repeat(2),'x'.repeat(33),'a\nb'])assert.throws(()=>visibleName(n));
  store.init(); assert.throws(()=>store.profile('../default'));assert.throws(()=>store.rename('account-0000000000000000','x'));
  fs.writeFileSync(store.file('accounts.json'),'{not-json');assert.throws(()=>store.state(),/损坏/);
});
test('directory links cannot redirect created accounts or registry writes',t=>{
  const {store,root}=fixture(t);store.init();const other=path.join(root,'outside');fs.mkdirSync(other);
  fs.symlinkSync(other,path.join(store.root,'profiles'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>store.create('不可创建'),/链接/);assert.deepEqual(fs.readdirSync(other),[]);
});
test('simultaneous operations stop at the lock and do not overwrite the registry',t=>{
  const {store}=fixture(t);store.init();fs.writeFileSync(store.file('operation.lock'),'occupied');
  assert.throws(()=>store.create('不能重复'),/正在执行/);assert.equal(store.state().profiles.length,1);
});
test('read-only polling reuses fresh cache and force refresh calls only the selected profile',async t=>{
  const {store}=fixture(t),a=store.create('工作');store.select(a.id);let calls=0;
  const reader=async(bin,p,options)=>{calls++;assert.equal(p.id,a.id);assert.deepEqual(options,{includeIdentity:true});return{checkedAt:Date.now(),loggedIn:false,usage:null};};
  await main(['refresh',a.id,'official'],store,reader);await main(['refresh',a.id,'official'],store,reader);assert.equal(calls,1);
  await main(['refresh',a.id,'official','force'],store,reader);assert.equal(calls,2);assert.equal(store.state().profiles[0].record,null);
});
test('failed usage update retains original observation only for the same official account',async t=>{
  const {store}=fixture(t);store.saveRecord('default',{fingerprint:'account-a',loggedIn:true,checkedAt:1,usage:{observedAt:7}});
  await main(['refresh','default','official','force'],store,async()=>({fingerprint:'account-a',loggedIn:true,checkedAt:10,usage:null,error:'unavailable'}));
  assert.equal(store.records().default.usage.observedAt,7);
  await main(['refresh','default','official','force'],store,async()=>({fingerprint:'account-b',loggedIn:true,checkedAt:20,usage:null,error:'unavailable'}));
  assert.equal(store.records().default.usage,null);
});
test('logout clears cached quota and transport failure does not pretend login is current',async t=>{
  const {store}=fixture(t);store.saveRecord('default',{loggedIn:true,checkedAt:1,usage:{observedAt:7}});
  await main(['refresh','default','official','force'],store,async()=>{throw Error('PRIVATE-SYNTHETIC-ERROR');});
  let r=store.records().default;assert.equal(r.loggedIn,null);assert.equal(r.usage.observedAt,7);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
  await main(['refresh','default','official','force'],store,async()=>({checkedAt:Date.now(),loggedIn:false,usage:null}));assert.equal(store.records().default.usage,null);
});

test('Codex removal and restore preserve directories, login files, usage and ids without opening official software',async t=>{
  const {store}=fixture(t),a=store.create('研究账号');store.select(a.id);store.saveRecord(a.id,{usage:{observedAt:7}});
  const sentinel=path.join(a.home,'auth.json');fs.writeFileSync(sentinel,'SYNTHETIC-NOT-A-CREDENTIAL');
  let called=false;const reader=()=>{called=true;throw Error('must not request account data');};
  const removed=await main(['remove',a.id],store,reader);
  assert.equal(removed.selected,'default');assert.equal(removed.profiles.length,1);assert.equal(removed.removedProfiles[0].name,'研究账号');
  assert.equal(fs.readFileSync(sentinel,'utf8'),'SYNTHETIC-NOT-A-CREDENTIAL');assert.equal(store.records()[a.id].usage.observedAt,7);
  for(const action of ['profile','select','refresh'])await assert.rejects(main([action,a.id,'official'],store,reader));
  const restored=await main(['restore',a.id],store,reader);assert.equal(restored.profiles[1].id,a.id);assert.equal(restored.profiles[1].home,a.home);assert.equal(restored.profiles[1].record.usage.observedAt,7);assert.equal(called,false);
});
test('Codex default, invalid and repeated removals cannot change the registry',t=>{
  const {store}=fixture(t);store.init();const before=fs.readFileSync(store.file('accounts.json'),'utf8');
  for(const id of ['default','../default','account-0000000000000000'])assert.throws(()=>store.remove(id));
  assert.equal(fs.readFileSync(store.file('accounts.json'),'utf8'),before);
  const a=store.create('备用');store.remove(a.id);assert.throws(()=>store.remove(a.id));assert.throws(()=>store.restore('default'));
});
test('missing Codex data stays removable but cannot be restored until the retained directory exists',t=>{
  const {store}=fixture(t),a=store.create('失效目录');fs.renameSync(a.home,a.home+'-retained');
  assert.equal(store.state().profiles[1].directoryMissing,true);store.remove(a.id);
  const before=fs.readFileSync(store.file('accounts.json'),'utf8');assert.throws(()=>store.restore(a.id));assert.equal(fs.readFileSync(store.file('accounts.json'),'utf8'),before);
});
test('a late Codex usage read cannot resurrect a removed account',async t=>{
  const {store}=fixture(t),a=store.create('备用');let resolve;
  const refresh=main(['refresh',a.id,'official','force'],store,()=>new Promise(r=>{resolve=r;}));
  store.remove(a.id);resolve({loggedIn:true,checkedAt:Date.now(),usage:null});await assert.rejects(refresh);
  assert.equal(store.state().profiles.length,1);assert.equal(store.state().removedProfiles.length,1);
});
