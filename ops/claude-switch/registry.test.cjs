'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Registry, removedRows } = require('./registry.cjs');
const { Operations } = require('../../fengzhu-connect/src/account-operations');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'kh-claude-registry-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'shared'));
  const config = {version:1,root,desktopVersion:'synthetic',activeLink:'synthetic',profiles:{primary:'claude-code-sessions/a/b',secondary:'claude-code-sessions/c/d'}};
  for(const [alias,dir] of Object.entries(config.profiles))fs.mkdirSync(path.join(root,'profiles',alias,dir),{recursive:true});
  const file=path.join(root,'shared/config.json');fs.writeFileSync(file,JSON.stringify(config));
  fs.writeFileSync(path.join(root,'shared/labels.json'),JSON.stringify({secondary:'研究账号'}));
  return {root,file,config,registry:new Registry({root,current:()=> 'primary',now:()=>100000})};
}
test('Claude removal retains all profile contents, labels and shared indexes and permits a single remaining account',t=>{
  const f=fixture(t), data=path.join(f.root,'profiles/secondary/Cookies'), indexes=path.join(f.root,'shared/code-indexes');
  fs.writeFileSync(data,'SYNTHETIC-SENTINEL');fs.mkdirSync(indexes);fs.writeFileSync(path.join(indexes,'index.json'),'synthetic');
  const read=fs.readFileSync;fs.readFileSync=function(file,...args){assert.notEqual(String(file),data,'registry must not read credential-shaped files');return read.call(this,file,...args);};
  try{f.registry.remove('secondary');}finally{fs.readFileSync=read;}
  const c=f.registry.config();assert.deepEqual(Object.keys(c.profiles),['primary']);
  assert.deepEqual(removedRows(c,{secondary:'研究账号'}),[{id:'secondary',name:'研究账号',removedAt:100000}]);
  assert.equal(fs.readFileSync(data,'utf8'),'SYNTHETIC-SENTINEL');assert.equal(fs.readFileSync(path.join(indexes,'index.json'),'utf8'),'synthetic');
  f.registry.restore('secondary');assert.deepEqual(f.registry.config().profiles,f.config.profiles);
  assert.deepEqual(removedRows(f.registry.config()),[]);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'shared/labels.json'))).secondary,'研究账号');
});
test('current, unknown, malformed and already removed Claude targets fail without rewriting registration',t=>{
  const f=fixture(t),before=fs.readFileSync(f.file,'utf8');
  for(const id of ['primary','../secondary','constructor','missing'])assert.throws(()=>f.registry.remove(id));
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
  f.registry.current=()=>undefined;assert.throws(()=>f.registry.remove('secondary'),/无法确认/);
  f.registry.current=()=> 'primary';f.registry.remove('secondary');assert.throws(()=>f.registry.remove('secondary'),/已移除/);
  assert.throws(()=>f.registry.remove('primary'),/当前/);assert.throws(()=>f.registry.restore('missing'),/不在/);
});
test('a switching or registry write lock rejects metadata changes',t=>{
  const f=fixture(t),before=fs.readFileSync(f.file,'utf8');
  for(const name of ['desktop-switch.lock','profile-registry.lock']){
    const lock=path.join(f.root,'shared',name);fs.writeFileSync(lock,'synthetic');
    assert.throws(()=>f.registry.remove('secondary'),/正在/);fs.unlinkSync(lock);
  }
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
});
test('registry mutation holds a switch-blocking lease and releases it after any outcome',t=>{
  const f=fixture(t),root=path.join(f.root,'shared');
  f.registry.locked(()=>{
    assert.ok(fs.readdirSync(root).some(n=>n.startsWith('desktop-operation-')));
    const op=new Operations(root,{now:()=>100000,isAlive:()=>true});
    assert.throws(()=>op.begin({requestId:'registry-race-test',pid:process.pid,from:'primary',to:'secondary',origin:'phone'},'primary',{pid:process.pid,active:'primary',at:100000,known:true}),e=>e.blockers.includes('operation_active'));
  });
  assert.ok(!fs.readdirSync(root).some(n=>n.endsWith('.lock')));
  assert.throws(()=>f.registry.locked(()=>{throw Error('synthetic failure');}));
  assert.ok(!fs.readdirSync(root).some(n=>n.endsWith('.lock')));
});
test('switch claiming the lock during registry lease creation wins before any mutation',t=>{
  const f=fixture(t),before=fs.readFileSync(f.file,'utf8'),open=fs.openSync;
  fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(String(file).includes('desktop-operation-'))fs.writeFileSync(path.join(f.root,'shared/desktop-switch.lock'),'synthetic');return fd;};
  try{assert.throws(()=>f.registry.remove('secondary'),/正在切换/);}finally{fs.openSync=open;}
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
  assert.ok(!fs.readdirSync(path.join(f.root,'shared')).some(n=>n.startsWith('desktop-operation-')));
});
test('restoring a missing or linked retained profile does not change active registration',t=>{
  const f=fixture(t);f.registry.remove('secondary');const before=fs.readFileSync(f.file,'utf8');
  const dir=path.join(f.root,'profiles/secondary',f.config.profiles.secondary), moved=path.join(f.root,'retained-index');
  fs.renameSync(dir,moved);assert.throws(()=>f.registry.restore('secondary'),/目录不可用/);
  fs.symlinkSync(moved,dir,process.platform==='win32'?'junction':'dir');assert.throws(()=>f.registry.restore('secondary'),/目录不可用/);
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
});
