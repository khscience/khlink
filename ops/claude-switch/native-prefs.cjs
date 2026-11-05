'use strict';
// The official desktop config may contain unrelated MCP settings. Inspect only
// JSON structure and the three UI values below; preserve all other bytes.
const fs = require('node:fs');
const crypto = require('node:crypto');
const NAMES = ['dframe-local-slice', 'dframe-code-sections', 'starred-local-code-sessions'];
function locate(buf, wanted) {
  let p = 0;
  const ws = () => { while ([9, 10, 13, 32].includes(buf[p])) p++; };
  function string() { const start=p++; if(buf[start]!==34)throw Error('Invalid native preference JSON.'); for(;p<buf.length;p++){if(buf[p]===92){p++;continue;}if(buf[p]===34){p++;return [start,p];}}throw Error('Unterminated JSON string.'); }
  const found = new Map();
  function value(route) {
    ws(); const start=p;
    if(buf[p]===123) { p++;ws();const keys=new Set();while(buf[p]!==125){const [a,b]=string();const key=JSON.parse(buf.subarray(a,b).toString('utf8'));if(keys.has(key))throw Error('Duplicate native preference key.');keys.add(key);ws();if(buf[p++]!==58)throw Error('Invalid JSON object.');value([...route,key]);ws();if(buf[p]===125)break;if(buf[p++]!==44)throw Error('Invalid JSON object.');ws();}p++; }
    else if(buf[p]===91){p++;ws();while(buf[p]!==93){value([...route,'[]']);ws();if(buf[p]===93)break;if(buf[p++]!==44)throw Error('Invalid JSON array.');ws();}p++;}
    else if(buf[p]===34)string();
    else { while(p<buf.length&&![9,10,13,32,44,93,125].includes(buf[p]))p++;if(p===start)throw Error('Invalid JSON value.'); }
    const key=route.join('.');if(wanted.has(key))found.set(key,[start,p]);
  }
  value([]);ws();if(p!==buf.length)throw Error('Trailing native preference data.');return found;
}
const paths=NAMES.map(n=>'preferences.epitaxyPrefs.'+n);
function inspect(buf) {
  const spans=locate(buf,new Set(paths));
  if(paths.some(p=>!spans.has(p)))throw Error('Claude native sidebar preferences are not initialized.');
  const values=paths.map(p=>{const [a,b]=spans.get(p);return JSON.parse(buf.subarray(a,b).toString('utf8'));});
  return {spans,values};
}
function patch(buf, values) {
  const {spans}=inspect(buf);const pieces=[];let pos=0;
  for(const [key,[a,b]]of [...spans.entries()].sort((x,y)=>x[1][0]-y[1][0])){pieces.push(buf.subarray(pos,a),Buffer.from(JSON.stringify(values[paths.indexOf(key)])));pos=b;}
  pieces.push(buf.subarray(pos));return Buffer.concat(pieces);
}
function read(file) { const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>4*1024*1024)throw Error('Invalid native preferences path.');const b=fs.readFileSync(file);return {bytes:b,values:inspect(b).values,hash:crypto.createHash('sha256').update(b).digest('hex')}; }
function write(file, expectedValues, values) {
  const current=read(file);if(JSON.stringify(current.values)!==JSON.stringify(expectedValues))throw Error('Native sidebar preferences changed concurrently.');
  const next=patch(current.bytes,values),tmp=file+'.khlink-'+crypto.randomUUID();
  fs.writeFileSync(tmp,next,{flag:'wx',mode:0o600});const fd=fs.openSync(tmp,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  // Only UI fields have changed; the temporary file is removed by atomic rename.
  if(read(file).hash!==current.hash){fs.unlinkSync(tmp);throw Error('Native settings changed concurrently.');}fs.renameSync(tmp,file);
}
module.exports={NAMES,inspect,patch,read,write,locate};
