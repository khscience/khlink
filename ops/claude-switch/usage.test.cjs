'use strict';
// Reset times are formatted in local time; the expectations are China time.
process.env.TZ = 'Asia/Shanghai';
const test=require('node:test'),assert=require('node:assert/strict');
const {fromHistory,fromStatusline,MAX_AGE}=require('./usage.cjs');
const {quotaView}=require('../../kh-link-desktop/src/profiles.js');
const now=1792000000000;
test('official history is matched to the registered organization, not newest sample',()=>{
 const d={version:2,samples:[{org:'a',t:now-2000,u:{fh:73,sd:97}},{org:'b',t:now-1000,u:{fh:1,sd:4}}]};
 const r=fromHistory(d,'a',now);assert.equal(r.fiveHour.remaining,27);assert.equal(r.sevenDay.remaining,3);assert.equal(r.fiveHour.resetsAt,null);
});
test('old history is visibly stale and a reset never manufactures renewed quota',()=>{
 const r=fromHistory({version:2,samples:[{org:'a',t:now-MAX_AGE-1,u:{fh:99,sd:100}}]},'a',now);
 assert.equal(r.fiveHour.stale,true);assert.equal(quotaView(r.fiveHour,now).label,'历史剩余');
 const v=quotaView({remaining:1,observedAt:now-5000,resetsAt:now-1},now);assert.equal(v.text,'1%');assert.equal(v.resetText,'已到重置时间，等待新记录');
});
test('missing percentage stays unknown, not 100 percent; malformed and future samples rejected',()=>{
 assert.equal(quotaView(null,now).text,'—');
 assert.equal(fromHistory({version:2,samples:[{org:'a',t:now+999999,u:{fh:0}}]},'a',now),null);
 const r=fromHistory({version:2,samples:[{org:'a',t:now,u:{sd:4}}]},'a',now);assert.equal(r.fiveHour.remaining,null);
});
test('official statusLine reset times support seconds and ISO strings',()=>{
 const r=fromStatusline({source:'official-statusline',profile:'a',observedAt:now,rate_limits:{five_hour:{used_percentage:42,resets_at:(now+3600000)/1000},seven_day:{used_percentage:75,resets_at:new Date(now+86400000).toISOString()}}},'a',now);
 assert.equal(r.fiveHour.remaining,58);assert.equal(r.sevenDay.remaining,25);assert.equal(r.fiveHour.resetsAt,now+3600000);assert.match(quotaView(r.sevenDay,now).resetText,/1天/);
});
test('wrong profile, synthetic input and untrusted sources cannot populate real quota',()=>{
 const v={source:'official-statusline',profile:'a',observedAt:now,rate_limits:{five_hour:{used_percentage:1}}};
 assert.equal(fromStatusline(v,'b',now),null);assert.equal(fromStatusline({...v,synthetic:true},'a',now),null);assert.equal(fromStatusline({...v,source:'mock'},'a',now),null);
});
test('lack of reset timestamp is explicitly displayed, never inferred from sample cadence',()=>{
 const r=fromHistory({version:2,samples:[{org:'a',t:now,u:{fh:0,sd:2}}]},'a',now);
 assert.equal(quotaView(r.fiveHour,now).resetText,'重置时间：官方记录未提供');
});

test('server jitter on either side of a minute preserves the displayed reset minute',()=>{const {quotaView}=require('../../kh-link-desktop/src/profiles.js');const at=new Date('2026-10-15T04:00:00+08:00').getTime();for(const jitter of [-1,0,322]){const r=quotaView({remaining:32,observedAt:at,resetsAt:at+3600000+jitter},at);assert.ok(r.resetText.includes('05:00'));}assert.equal(quotaView({remaining:100,observedAt:at,notStarted:true},at).resetText,'尚未开始本轮计时');});

test('inactive quota estimates a full window exactly at reset without changing its official observation',()=>{
 const record=Object.freeze({remaining:7,observedAt:now-3600000,resetsAt:now});
 const before=quotaView(record,now-1,{active:false});assert.equal(before.remaining,7);assert.equal(before.estimated,false);
 const after=quotaView(record,now,{active:false});assert.equal(after.remaining,100);assert.equal(after.text,'100%');assert.equal(after.label,'预计剩余');assert.equal(after.estimated,true);assert.equal(after.stale,true);assert.equal(after.resetText,'预计已重置 · 待官方确认');
 assert.deepEqual(record,{remaining:7,observedAt:now-3600000,resetsAt:now});
});

test('active or unspecified accounts keep actual last usage after reset',()=>{
 const record={remaining:7,observedAt:now-3600000,resetsAt:now-1};
 for(const options of [undefined,{active:true},{active:undefined},{active:null}]){
  const view=quotaView(record,now,options);assert.equal(view.estimated,false);assert.equal(view.remaining,7);assert.equal(view.label,'历史剩余');
 }
});

test('inactive accounts cannot estimate without a valid percentage, observation and reset',()=>{
 const base={remaining:7,observedAt:now-3600000,resetsAt:now-1};
 for(const record of [null,{...base,remaining:null},{...base,remaining:NaN},{...base,remaining:-1},{...base,remaining:101},
  {...base,observedAt:null},{...base,observedAt:0},{...base,observedAt:NaN},{...base,observedAt:now+1},
  {...base,resetsAt:null},{...base,resetsAt:0},{...base,resetsAt:NaN},{...base,resetsAt:'yesterday'},
  {...base,resetsAt:Infinity},{...base,resetsAt:now+1}]) assert.equal(quotaView(record,now,{active:false}).estimated,false);
});

test('five-hour and weekly quota reset estimates stay independent',()=>{
 const five={remaining:3,observedAt:now-10000,resetsAt:now};
 const week={remaining:22,observedAt:now-10000,resetsAt:now+86400000};
 assert.equal(quotaView(five,now,{active:false}).remaining,100);
 const weekly=quotaView(week,now,{active:false});assert.equal(weekly.remaining,22);assert.equal(weekly.estimated,false);
 assert.equal(quotaView(week,now+86400000,{active:false}).estimated,true);
});

test('switching back or a newer official observation replaces the estimate',()=>{
 const old={remaining:7,observedAt:now-3600000,resetsAt:now-1000};
 assert.equal(quotaView(old,now,{active:false}).estimated,true);
 assert.equal(quotaView(old,now,{active:true}).remaining,7);
 for(const observedAt of [old.resetsAt,now]){
  const fresh={remaining:63,observedAt,resetsAt:old.resetsAt};
  const actual=quotaView(fresh,now,{active:false});assert.equal(actual.estimated,false);assert.equal(actual.remaining,63);
 }
 const next=quotaView({remaining:82,observedAt:now,resetsAt:now+3600000},now,{active:false});
 assert.equal(next.estimated,false);assert.equal(next.remaining,82);assert.equal(next.label,'剩余');
});

test('elapsed inactive windows never fabricate the next reset schedule',()=>{
 const record=Object.freeze({remaining:7,observedAt:now-3600000,resetsAt:now});
 for(const time of [now,now+3600000,now+14*86400000]){
  const view=quotaView(record,time,{active:false});assert.equal(view.remaining,100);assert.equal(view.resetText,'预计已重置 · 待官方确认');assert.equal(record.resetsAt,now);
 }
});
