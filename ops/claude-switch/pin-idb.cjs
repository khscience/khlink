'use strict';
// Offline, exact-key UI cache invalidation. Chromium's custom comparator must
// never be replaced by BytewiseComparator. Append standard LevelDB WAL deletes;
// Chromium itself replays them with its own comparator on the next launch.
// Only the Code pin-state data/exists keys are touched. No credentials or other
// IndexedDB values are decoded, saved or copied. Unknown layouts fail closed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const NAME='store:pin-state:dframe-starred-code';
function check(b,m='Unsupported Claude pin database layout.'){if(!b)throw Error(m);}
function vi(b,c){let n=0,m=1;for(let i=0;i<9;i++){check(c.p<b.length);const v=b[c.p++];n+=(v&127)*m;if(v<128){check(Number.isSafeInteger(n));return n;}m*=128;}throw Error('Invalid varint.');}
function vint(n){const a=[];do{a.push((n%128)|(n>=128?128:0));n=Math.floor(n/128);}while(n);return Buffer.from(a);}
const crcTable=Uint32Array.from({length:256},(_,i)=>{for(let j=0;j<8;j++)i=(i&1)?(i>>>1)^0x82f63b78:i>>>1;return i>>>0;});
function crc(b){let n=0xffffffff;for(const x of b)n=crcTable[(n^x)&255]^(n>>>8);return (~n)>>>0;}
function masked(b){const n=crc(b);return (((n>>>15)|(n<<17))+0xa282ead8)>>>0;}
function records(b){const result=[];let chunks=[];for(let p=0;p<b.length;){const left=32768-(p%32768);if(left<7){check(b.subarray(p,p+left).every(x=>x===0));p+=left;continue;}check(p+7<=b.length,'Incomplete LevelDB log; switch stopped.');const size=b.readUInt16LE(p+4),type=b[p+6];if(type===0&&size===0){check(b.subarray(p,Math.min(b.length,p+left)).every(x=>x===0));p+=left;continue;}check(size<=left-7&&p+7+size<=b.length);const payload=b.subarray(p+7,p+7+size);check(masked(Buffer.concat([Buffer.from([type]),payload]))===b.readUInt32LE(p),'LevelDB log checksum failed.');if(type===1){check(!chunks.length);result.push(payload);}else if(type===2){check(!chunks.length);chunks=[payload];}else if(type===3){check(chunks.length);chunks.push(payload);}else if(type===4){check(chunks.length);chunks.push(payload);result.push(Buffer.concat(chunks));chunks=[];}else throw Error('Unknown LevelDB log record.');p+=7+size;}check(!chunks.length,'Incomplete LevelDB log; switch stopped.');return result;}
function keyMatch(key){
  const h=key[0],a=(h>>5)+1,b=((h>>2)&7)+1,d=(h&3)+1,c={p:1+a+b+d};
  if(c.p>=key.length)return false;const idx=key.readUIntLE(1+a+b,d);
  if(![1,2].includes(idx)||key[c.p++]!==1)return false;
  const len=vi(key,c);if(len!==NAME.length||c.p+2*len!==key.length)return false;
  return key.subarray(c.p).equals(Buffer.from(NAME,'utf16le').swap16());
}
function wal(b, map){let max=0;for(const r of records(b)){check(r.length>=12);const seq=Number(r.readBigUInt64LE()),count=r.readUInt32LE(8);check(Number.isSafeInteger(seq)&&count<1000000);max=Math.max(max,seq+count-1);const c={p:12};for(let i=0;i<count;i++){const type=r[c.p++];check(type===0||type===1);const kl=vi(r,c),key=r.subarray(c.p,c.p+kl);c.p+=kl;let value=null;if(type===1){const vl=vi(r,c);value=r.subarray(c.p,c.p+vl);c.p+=vl;}check(c.p<=r.length);if(keyMatch(key)){const hex=key.toString('hex');if(!map.has(hex)||map.get(hex).seq<seq+i)map.set(hex,{seq:seq+i,key,value});}}check(c.p===r.length);}return max;}
function manifest(b){let log=0,last=0;const files=new Set();for(const r of records(b)){const c={p:0};while(c.p<r.length){const tag=vi(r,c);if(tag===1){const n=vi(r,c);const name=r.subarray(c.p,c.p+n).toString();c.p+=n;check(name==='idb_cmp1');}else if(tag===2)log=vi(r,c);else if(tag===3||tag===9)vi(r,c);else if(tag===4)last=vi(r,c);else if(tag===5){vi(r,c);{const n=vi(r,c);c.p+=n;}}else if(tag===6){vi(r,c);files.delete(vi(r,c));}else if(tag===7){vi(r,c);files.add(vi(r,c));vi(r,c);{const n=vi(r,c);c.p+=n;}{const n=vi(r,c);c.p+=n;}}else throw Error('Unknown LevelDB manifest record.');}}return {log,last,files};}
function snapshot(dir){
  const st=fs.lstatSync(dir);check(st.isDirectory()&&!st.isSymbolicLink());
  const current=fs.readFileSync(path.join(dir,'CURRENT'),'utf8').trim();check(/^MANIFEST-\d+$/.test(current));
  const meta=manifest(fs.readFileSync(path.join(dir,current)));
  // Both verified profiles currently use a WAL-only keyval database. Refuse a
  // future compacted layout instead of interpreting SSTs with a wrong comparator.
  check(meta.files.size===0,'Claude pin storage has compacted; this layout needs review before switching.');
  const logs=fs.readdirSync(dir).filter(n=>/^\d+\.log$/.test(n)&&Number(n.slice(0,-4))>=meta.log).sort();check(logs.length===1,'Multiple pending pin logs; review required.');const file=path.join(dir,logs[0]);const b=fs.readFileSync(file),entries=new Map();const max=Math.max(meta.last,wal(b,entries));
  return {file,size:b.length,hash:crypto.createHash('sha256').update(b).digest('hex'),max,entries:[...entries.values()].filter(e=>e.value!==null).map(e=>({key:e.key.toString('hex'),value:e.value.toString('base64')}))};
}
function fragment(payload,offset){const out=[];let p=0;do{let left=32768-(offset%32768);if(left<7){out.push(Buffer.alloc(left));offset+=left;left=32768;}const n=Math.min(left-7,payload.length-p),first=p===0,last=p+n===payload.length,type=first?(last?1:2):(last?4:3),body=payload.subarray(p,p+n),h=Buffer.alloc(7);h.writeUInt32LE(masked(Buffer.concat([Buffer.from([type]),body])),0);h.writeUInt16LE(n,4);h[6]=type;out.push(h,body);p+=n;offset+=7+n;}while(p<payload.length);return Buffer.concat(out);}
function append(dir, expected, values){
  const now=snapshot(dir);check(now.hash===expected.hash&&now.size===expected.size&&now.file===expected.file,'Pin database changed concurrently.');
  if(!values.length)return snapshot(dir);const head=Buffer.alloc(12);head.writeBigUInt64LE(BigInt(now.max+1));head.writeUInt32LE(values.length,8);const chunks=[head];
  for(const e of values){const key=Buffer.from(e.key,'hex');check(keyMatch(key));chunks.push(Buffer.from([e.value===null?0:1]),vint(key.length),key);if(e.value!==null){const value=Buffer.from(e.value,'base64');chunks.push(vint(value.length),value);}}
  const data=fragment(Buffer.concat(chunks),now.size),fd=fs.openSync(now.file,'a');try{fs.writeSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return snapshot(dir);
}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function deletionPlan(dir) {
  const s=snapshot(dir);if(!s.entries.length)return null;
  const head=Buffer.alloc(12);head.writeBigUInt64LE(BigInt(s.max+1));head.writeUInt32LE(s.entries.length,8);
  const payload=Buffer.concat([head,...s.entries.flatMap(e=>{const k=Buffer.from(e.key,'hex');check(keyMatch(k));return [Buffer.from([0]),vint(k.length),k];})]);
  const data=fragment(payload,s.size),original=fs.readFileSync(s.file);check(hash(original)===s.hash);
  return {name:path.basename(s.file),size:s.size,beforeHash:s.hash,afterHash:hash(Buffer.concat([original,data])),data:data.toString('base64')};
}
function planFile(dir,p){check(/^\d+\.log$/.test(p.name)&&Number.isSafeInteger(p.size)&&p.size>=0);const f=path.join(dir,p.name),st=fs.lstatSync(f);check(st.isFile()&&!st.isSymbolicLink());return f;}
function applyPlan(dir,p){if(!p)return;const f=planFile(dir,p),current=fs.readFileSync(f);check(current.length===p.size&&hash(current)===p.beforeHash,'Pin cache changed before writing.');const fd=fs.openSync(f,'a');try{fs.writeFileSync(fd,Buffer.from(p.data,'base64'));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}check(hash(fs.readFileSync(f))===p.afterHash,'Pin cache verification failed.');}
function canRestore(dir,p){if(!p)return;const f=planFile(dir,p),b=fs.readFileSync(f),data=Buffer.from(p.data,'base64');check(b.length>=p.size&&b.length<=p.size+data.length&&hash(b.subarray(0,p.size))===p.beforeHash&&b.subarray(p.size).equals(data.subarray(0,b.length-p.size)),'Pin database changed after transaction; preserve newer data.');}
function restorePlan(dir,p){if(!p)return;canRestore(dir,p);const fd=fs.openSync(planFile(dir,p),'r+');try{fs.ftruncateSync(fd,p.size);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
module.exports={snapshot,append,records,wal,manifest,keyMatch,vint,fragment,NAME,deletionPlan,applyPlan,canRestore,restorePlan};
