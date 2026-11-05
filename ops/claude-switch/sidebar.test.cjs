'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const {ClassicLevel}=require('classic-level');
// Fixtures go to KHLINK_TEST_DIR or the system temp folder, by its long name:
// the code under test resolves 8.3 short names.
const FIXTURES = fs.realpathSync.native(process.env.KHLINK_TEST_DIR || require('node:os').tmpdir());
const {KEYS,keyBytes,encode,decode,extract,merge,synchronize}=require('./sidebar.cjs');
const ids=new Set(['code:local_11111111-1111-4111-8111-111111111111','code:local_22222222-2222-4222-8222-222222222222']);
const order=[...ids].reverse();
function values(scope='account/org',pinned=order) { const section={id:'pinned',kind:'pinned',v:2,name:'',order:0,sortBy:'alpha',ascending:true,show:{metadata:false},collapsed:false,shown:true}; const layout={sections:[section,{id:'routines',kind:'routines',shown:false}]};
 return [{version:1,state:{pinnedOrder:pinned,codeSidebarByScope:{[scope]:layout},sidebarWidth:312,homeProjectsPinnedOrder:['project'],other:'preserve'}},{value:{pinnedOrder:pinned,homeProjectsPinnedOrder:['project']},timestamp:1,tabId:'old'},{value:{[scope]:layout},timestamp:1,tabId:'old'},{value:pinned.map(id=>id.replace(/^code:/,'')),timestamp:1,tabId:'old'}]; }
test('pinned items and manual sequence come only from registered shared Code IDs',()=>{
 const v=values('account/org',['chat:unrelated',order[0],order[1],order[0],'code:local_old']);
 assert.deepEqual(extract(v,'account/org',ids).pinned,order);
});
test('sort direction, section visibility and order follow source without sharing account scope',()=>{
 const target=values('different/target',['chat:private',order[1]]);target[0].state.sidebarWidth=444;
 const result=merge(target,'different/target',extract(values(),'account/org',ids),ids,123);
 assert.deepEqual(result[1].value.pinnedOrder,[...order,'chat:private']);
 assert.equal(result[0].state.sidebarWidth,444);assert.equal(result[2].value['account/org'],undefined);
 assert.equal(result[2].value['different/target'].sections[0].sortBy,'alpha');assert.equal(result[2].value['different/target'].sections[0].ascending,true);
 assert.equal(result[2].value['different/target'].sections[1].shown,false);assert.deepEqual(result[1].value.homeProjectsPinnedOrder,['project']);
});
test('unpin all does not resurrect pins or remove unrelated Chat pins',()=>{
 const source=extract(values('account/org',[]),'account/org',ids);
 const next=merge(values('account/org',[...order,'chat:private']),'account/org',source,ids);
 assert.deepEqual(next[0].state.pinnedOrder,['chat:private']);assert.deepEqual(next[1].value.pinnedOrder,['chat:private']);
});
test('unknown layouts and invalid storage encodings fail closed',()=>{
 const v=values();v[0].version=99;assert.throws(()=>extract(v,'account/org',ids));
 assert.throws(()=>merge([{},null,null],'account/org',{},ids));assert.throws(()=>decode(Buffer.from([3,1,2])));
});
test('Chromium Latin-1 and UTF-16 values round trip without losing Chinese',()=>{
 assert.deepEqual(decode(encode({name:'中文置顶'})),{name:'中文置顶'});
 assert.deepEqual(decode(Buffer.from('\x01{"n":1}','latin1')),{n:1});
});
test('native database sync preserves unrelated values, verifies both mirrors, detects inactive changes',async()=>{
 const root=fs.mkdtempSync(path.join(FIXTURES, 'pins-'));const config={root,profiles:{primary:'claude-code-sessions/account/org',secondary:'claude-code-sessions/different/target'}};
 fs.mkdirSync(path.join(root,'shared/code-indexes'),{recursive:true});
 for(const id of ids)fs.writeFileSync(path.join(root,'shared/code-indexes',id.slice(5)+'.json'),'{}');
 const dir=a=>path.join(root,'profiles',a,'Local Storage/leveldb');
 for(const [a,scope]of [['primary','account/org'],['secondary','different/target']]){
  const db=new ClassicLevel(dir(a),{keyEncoding:'buffer',valueEncoding:'buffer'});await db.open();
  const v=values(scope,a==='primary'?order:[]);
  fs.writeFileSync(path.join(root,'profiles',a,'claude_desktop_config.json'),JSON.stringify({preferences:{epitaxyPrefs:Object.fromEntries(require('./native-prefs.cjs').NAMES.map((name,i)=>[name,v[i+1].value]))}}));
  const idb=path.join(root,'profiles',a,'IndexedDB/https_claude.ai_0.indexeddb.leveldb');fs.mkdirSync(idb,{recursive:true});fs.writeFileSync(path.join(idb,'CURRENT'),'MANIFEST-000001\n');fs.writeFileSync(path.join(idb,'MANIFEST-000001'),require('./pin-idb.cjs').fragment(Buffer.from([2,3]),0));fs.writeFileSync(path.join(idb,'000003.log'),'');
  await db.batch(KEYS.map((k,i)=>({type:'put',key:keyBytes(k),value:encode(v[i])})));await db.put(Buffer.from('unrelated-test'),Buffer.from('untouched'));await db.close();
 }
 const result=await synchronize(config,'primary',()=>{});assert.equal(result.pinned,2);
 const target=new ClassicLevel(dir('secondary'),{keyEncoding:'buffer',valueEncoding:'buffer'});await target.open();
 assert.equal((await target.get(Buffer.from('unrelated-test'))).toString(),'untouched');
 assert.deepEqual(decode(await target.get(keyBytes(KEYS[1]))).value.pinnedOrder,order);
 const changed=decode(await target.get(keyBytes(KEYS[1])));changed.value.pinnedOrder=[...order].reverse();await target.put(keyBytes(KEYS[1]),encode(changed));await target.close();
 await assert.rejects(synchronize(config,'primary',()=>{}),/Inactive sidebar|mirrors disagree/);
});
test('database lock and live-process guard refuse concurrent writes',async()=>{
 const root=fs.mkdtempSync(path.join(FIXTURES, 'pin-lock-'));
 await assert.rejects(synchronize({root,profiles:{}},'primary',()=>{throw Error('still running')}),/still running/);
 const db=new ClassicLevel(path.join(root,'db'));await db.open();const second=new ClassicLevel(path.join(root,'db'));await assert.rejects(second.open());await second.close();await db.close();
});


test('interrupted sidebar batch is rolled back from known images before retry',async()=>{
 const root=fs.mkdtempSync(path.join(FIXTURES, 'pin-recover-'));
 const before=values('a/b',[]),after=values('a/b',order);
 const db=new ClassicLevel(path.join(root,'db'),{keyEncoding:'buffer',valueEncoding:'buffer'});await db.open();
 await db.batch(KEYS.map((k,i)=>({type:'put',key:keyBytes(k),value:encode(after[i])})));
 const journal={version:2,phase:'prepared',before:{primary:before},after:{primary:after},previousState:{at:123}};
 const stateFile=path.join(root,'state.json'),journalFile=path.join(root,'journal.json');
 await require('./sidebar.cjs').recoverPrepared(new Map([['primary',db]]),journal,journalFile,stateFile);
 assert.deepEqual(decode(await db.get(keyBytes(KEYS[1]))).value.pinnedOrder,[]);
 assert.equal(JSON.parse(fs.readFileSync(journalFile)).phase,'rolled-back');
 assert.equal(JSON.parse(fs.readFileSync(stateFile)).at,123);await db.close();
});

test('recovery refuses later sidebar changes without overwriting them',async()=>{
 const root=fs.mkdtempSync(path.join(FIXTURES, 'pin-recover-conflict-'));
 const db=new ClassicLevel(path.join(root,'db'),{keyEncoding:'buffer',valueEncoding:'buffer'});await db.open();
 const later=values('a/b',['chat:later']);await db.batch(KEYS.map((k,i)=>({type:'put',key:keyBytes(k),value:encode(later[i])})));
 const journal={version:2,phase:'prepared',before:{primary:values('a/b',[])},after:{primary:values('a/b',order)}};
 await assert.rejects(require('./sidebar.cjs').recoverPrepared(new Map([['primary',db]]),journal,path.join(root,'journal.json'),path.join(root,'state.json')),/New sidebar data/);
 assert.deepEqual(decode(await db.get(keyBytes(KEYS[1]))).value.pinnedOrder,['chat:later']);await db.close();
});


test('membership is separate from display order and is updated with both mirrors',()=>{
 const source=values();source[3].value=[order[0].slice(5)];
 const extracted=extract(source,'account/org',ids);assert.deepEqual(extracted.pinned,[order[0]]);
 const target=values('different/target');target[3].value.push('local_unrelated');
 const result=merge(target,'different/target',extracted,ids,456);
 assert.deepEqual(result[3].value,[order[0].slice(5),'local_unrelated']);assert.equal(result[3].timestamp,456);
 assert.deepEqual(extract(result,'different/target',ids).pinned,[order[0]]);
 const allUnpinned=values();allUnpinned[3].value=[];assert.deepEqual(extract(allUnpinned,'account/org',ids).pinned,[]);
});
