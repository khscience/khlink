'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {isolatedEnv,normalize,readAccount}=require('./rpc.cjs');
const limits={rateLimits:{primary:{usedPercent:27,windowDurationMins:300,resetsAt:1792036800},secondary:{usedPercent:80,windowDurationMins:10080,resetsAt:1792616400}}};
test('child environments isolate all account overrides without changing the parent',()=>{
  const parent={PATH:'original',CODEX_HOME:'old',CODEX_THREAD_ID:'other',OPENAI_API_KEY:'SYNTHETIC',CLAUDE_CODE_OAUTH_TOKEN:'SYNTHETIC',NODE_OPTIONS:'inject',ELECTRON_RUN_AS_NODE:'1'};
  const env=isolatedEnv('G:/new','G:/ui',parent);assert.deepEqual(env,{PATH:'original',CODEX_HOME:'G:/new',CODEX_ELECTRON_USER_DATA_PATH:'G:/ui'});assert.equal(parent.CODEX_HOME,'old');
});
test('official fields are whitelisted; percentages and reset seconds map correctly',()=>{
  const r=normalize({account:{type:'chatgpt',email:'fixture@example.invalid',planType:'pro',token:'SYNTHETIC_SECRET'}},limits,123);
  assert.equal(r.usage.fiveHour.remaining,73);assert.equal(r.usage.sevenDay.remaining,20);assert.equal(r.usage.fiveHour.resetsAt,1792036800000);assert.equal(r.usage.observedAt,123);
  assert.match(r.fingerprint,/^[a-f0-9]{32}$/);assert.ok(!JSON.stringify(r).includes('fixture@'));assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('only the desktop opt-in exposes the official email; mobile quota remains anonymous',()=>{
  const {usagePayload}=require('./rpc.cjs');
  const account={account:{type:'chatgpt',email:'owner@example.invalid',planType:'pro',chatgptAccountId:'private-workspace',token:'SYNTHETIC_SECRET'}};
  const desktop=normalize(account,limits,123,{includeIdentity:true});
  assert.deepEqual(desktop.identity,{email:'owner@example.invalid'});
  assert.doesNotMatch(JSON.stringify(desktop),/private-workspace|SYNTHETIC/);
  assert.doesNotMatch(JSON.stringify(normalize(account,limits)),/owner@|identity"/);
  assert.doesNotMatch(JSON.stringify(usagePayload(desktop,124)),/owner@|private-workspace|SYNTHETIC/);
  for(const email of ['not-an-email','x@example.invalid\nextra','x@example.invalid\u202e','x@example.invalid\u0000'])assert.equal(normalize({account:{email}},null,1,{includeIdentity:true}).identity,undefined);
});
test('missing and invalid windows never appear as a full quota',()=>{
  assert.equal(normalize({account:null},limits).usage,null);
  for(const usedPercent of [null,undefined,-1,101,'4',NaN]){const r=normalize({account:{type:'chatgpt'}},{rateLimits:{primary:{usedPercent,windowDurationMins:300}}});assert.equal(r.usage?.fiveHour??null,null);}
  const r=normalize({account:{type:'chatgpt'}},{rateLimits:{secondary:limits.rateLimits.secondary}});assert.equal(r.usage.fiveHour,null);assert.equal(r.usage.sevenDay.remaining,20);
});
test('different official account identities produce different cached identities',()=>{
  const a=normalize({account:{type:'chatgpt',email:'a@example.invalid'}},limits,1),b=normalize({account:{type:'chatgpt',email:'b@example.invalid'}},limits,1);
  assert.notEqual(a.fingerprint,b.fingerprint);
});
function fakeServer({loggedIn=true,hang=false,failUsage=false}={}) {
  const child=new EventEmitter(),methods=[];child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.killed=0;
  child.stdin={write(data){const x=JSON.parse(data);methods.push(x.method);if(!x.id||hang)return;queueMicrotask(()=>{
    let result=x.method==='account/read'?{account:loggedIn?{type:'chatgpt',planType:'pro'}:null}:x.method==='account/rateLimits/read'?limits:{};
    const value=failUsage&&x.method==='account/rateLimits/read'?{id:x.id,error:{message:'SYNTHETIC_SECRET'}}:{id:x.id,result};
    const line=JSON.stringify(value)+'\n';child.stdout.emit('data',line.slice(0,8));child.stdout.emit('data',line.slice(8));
  });},end(){queueMicrotask(()=>child.emit('close',0));}};
  child.kill=()=>{child.killed++;child.emit('close',0);};return{child,methods};
}
test('RPC uses only init, public account and quota reads; it never starts a turn or exports tokens',async()=>{
  const {child,methods}=fakeServer();let options;const r=await readAccount('official',{home:'isolated'},{spawnFn:(exe,args,opts)=>{options=opts;return child;},now:()=>42});
  assert.deepEqual(methods,['initialize','initialized','account/read','account/rateLimits/read']);assert.equal(options.env.CODEX_HOME,'isolated');assert.equal(r.usage.observedAt,42);assert.equal(child.killed,0);
});
test('not signed in does not query quota or start an authentication ceremony',async()=>{
  const {child,methods}=fakeServer({loggedIn:false});const r=await readAccount('official',{home:'isolated'},{spawnFn:()=>child});assert.equal(r.loggedIn,false);assert.ok(!methods.includes('account/rateLimits/read'));
});
test('quota failure is sanitized and login state is preserved',async()=>{
  const {child}=fakeServer({failUsage:true});const r=await readAccount('official',{home:'isolated'},{spawnFn:()=>child});assert.equal(r.loggedIn,true);assert.equal(r.usage,null);assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('unresponsive RPC times out and terminates only its own disposable child',async()=>{
  const {child}=fakeServer({hang:true});await assert.rejects(readAccount('official',{home:'isolated'},{spawnFn:()=>child,timeoutMs:20}),/接口/);assert.equal(child.killed,1);
});
