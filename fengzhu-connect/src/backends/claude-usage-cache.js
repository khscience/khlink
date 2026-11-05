'use strict';
// Passive local cache reader. No network or credential API. Only the exact
// registered organization's usage response body is read. Metadata reads stop
// BEFORE HttpResponseHeaders: only version/flags and binary timestamps.
// Format references: Chromium net/disk_cache/blockfile/disk_format.h and
// net/http/http_response_info.cc (HttpResponseInfo::InitFromPickle).
const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib');
const epoch=11644473600000;
function check(ok){if(!ok)throw Error('Unsupported official usage cache.');}
function metadata(read,addr){
  const first=read(addr,8);check(first.length===8);const flags=first.readUInt32LE(4);check((flags&255)===3&&!(flags&(1<<12)));
  let offset=8,extra=0;if(flags>>>31){extra=read(addr,12).readUInt32LE(8);offset+=4;}
  // Never round up this read: the next bytes can contain HTTP headers.
  const length=offset+16+((extra&4)?8:0),b=read(addr,length);
  const response=Number(b.readBigInt64LE(offset+8)/1000n)-epoch;
  const original=(extra&4)?Number(b.readBigInt64LE(offset+16)/1000n)-epoch:response;
  return original>0?Math.min(original,response):response;
}
function fields(data,at){
  if(!data||typeof data!=='object')return null;
  const window=v=>v&&typeof v.utilization==='number'&&Number.isFinite(v.utilization)&&v.utilization>=0&&v.utilization<=100?{used_percentage:v.utilization,resets_at:typeof v.resets_at==='string'&&Number.isFinite(Date.parse(v.resets_at))?v.resets_at:null}:null;
  const five_hour=window(data.five_hour),seven_day=window(data.seven_day);
  return five_hour||seven_day?{observedAt:at,rate_limits:{five_hour,seven_day}}:null;
}
function readUsage(dir,org,hintFile,now=Date.now()){
  const opened=new Map();
  const fileFd=name=>{if(!opened.has(name)){const file=path.join(dir,name),st=fs.lstatSync(file);check(st.isFile()&&!st.isSymbolicLink());opened.set(name,fs.openSync(file,'r'));}return opened.get(name);};
  function read(addr,size){
    check(addr>>>31&&Number.isInteger(size)&&size>=0&&size<=262144);const type=(addr>>>28)&7,sizes=[0,36,256,1024,4096,8,104,48];check(type<=4);
    const name=type?`data_${(addr>>>16)&255}`:`f_${(addr&0xfffffff).toString(16).padStart(6,'0')}`;
    const offset=type?8192+(addr&65535)*sizes[type]:0,b=Buffer.alloc(size);check(fs.readSync(fileFd(name),b,0,size,offset)===size);return b;
  }
  try{
    check(/^[a-zA-Z0-9_-]+$/.test(org));const target='https://claude.ai/api/organizations/'+org+'/usage';
    function entry(addr){const b=read(addr,256);if(b.readUInt32LE(20)!==0)return null;const len=b.readUInt32LE(32),long=b.readUInt32LE(36);check(len>0&&len<=4096);const key=(long?read(long,len):read(addr,96+len).subarray(96)).toString('utf8');return key.endsWith(target)?b:null;}
    function result(addr){const e=entry(addr);if(!e)return null;const ranking=read(e.readUInt32LE(8),36);if(ranking.readUInt32LE(28)!==0)return null;const at=metadata(read,e.readUInt32LE(56));if(at<=0||at>now+60000)return null;
      const raw=read(e.readUInt32LE(60),e.readUInt32LE(44));let out=null;
      for(const fn of [b=>b,z.zstdDecompressSync,z.gunzipSync,z.brotliDecompressSync,z.inflateSync].filter(Boolean)){try{out=fields(JSON.parse(fn(raw,{maxOutputLength:262144}).toString('utf8')),at);if(out)break;}catch{}}
      // Recheck pointers and timestamps against concurrent writes by Desktop.
      if(!out||!e.equals(read(addr,256))||metadata(read,e.readUInt32LE(56))!==at)return null;
      return out;
    }
    let hint=null;try{hint=JSON.parse(fs.readFileSync(hintFile,'utf8'));}catch{}
    if(Number.isInteger(hint?.address)){try{const v=result(hint.address);if(v)return v;}catch{}}
    const index=fs.readFileSync(path.join(dir,'index'));check(index.length>=368&&index.length<=4*1024*1024&&index.readUInt32LE(0)===0xc103cac3&&[0x20000,0x20001,0x30000].includes(index.readUInt32LE(4)));
    const seen=new Set();let best=null,address=null;
    for(let i=368;i+4<=index.length;i+=4){let addr=index.readUInt32LE(i);while(addr&&!seen.has(addr)){seen.add(addr);check(seen.size<100000);let e;try{e=read(addr,256);if(entry(addr)){const v=result(addr);if(v&&(!best||v.observedAt>best.observedAt)){best=v;address=addr;}}}catch{}addr=e?.readUInt32LE(4)||0;}}
    if(best&&hintFile){try{fs.mkdirSync(path.dirname(hintFile),{recursive:true});const tmp=hintFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify({version:1,address}),{mode:0o600});fs.renameSync(tmp,hintFile);}catch{}}
    return best;
  }catch{return null;}finally{for(const fd of opened.values())fs.closeSync(fd);}
}
module.exports={readUsage,metadata,fields};
