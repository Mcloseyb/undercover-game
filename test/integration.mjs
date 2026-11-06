// These tests use real, independent Anonymous Auth identities, HTTPS RPC and Realtime.
// No mock server, service key, database time travel or test-only game APIs.
import {createClient} from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const url=process.env.TEST_SUPABASE_URL||'https://cypbwptcuvvaejruiqgb.supabase.co';
const key=process.env.TEST_SUPABASE_PUBLISHABLE_KEY||'sb_publishable_ExWfYTSndr_zm7xYKBFBuw_mWbZW5rL';
const make=()=>createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const clients=Array.from({length:5},make),ids=[],results=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const log=(name)=>{results.push(name);console.log(`PASS ${results.length}: ${name}`);};
let s,channel,outsiderChannel,realtimeEvents=0,outsiderEvents=0,heartbeat;
fs.mkdirSync('.tools',{recursive:true});fs.mkdirSync('test-output',{recursive:true});
let saved=[];try{saved=JSON.parse(fs.readFileSync('.tools/test-sessions.secret','utf8'));}catch{}
async function persist(){const sessions=await Promise.all(clients.map(async c=>(await c.auth.getSession()).data.session));fs.writeFileSync('.tools/test-sessions.secret',JSON.stringify(sessions),{mode:0o600});}
async function rpc(i,name,payload={}){
  const {data,error}=await clients[i].rpc('wodi_action',{p_action:name,p_payload:payload});
  if(error)throw error;if(data.error)throw Error(data.error);return data;
}
async function syncAll(){return Promise.all(clients.slice(0,4).map((_,i)=>rpc(i,'sync')));}
async function until(predicate,label,timeout=40000){
  const start=performance.now();
  do{s=await rpc(0,'sync');if(predicate(s))return s;await wait(900);}while(performance.now()-start<timeout);
  throw Error(`等待超时：${label}，当前阶段 ${s.phase}`);
}
async function speaking(){
  await until(r=>r.phase==='speaking'||r.phase==='voting','进入发言阶段');
  while(s.phase==='speaking')s=await rpc(ids.indexOf(s.speakerId),'describe',{text:'这个东西在生活里能遇到，大家应该都认识'});
  assert.equal(s.phase,'voting');
}
async function roles(){
  const views=await syncAll();const words=views.map(v=>v.self.word);
  const u=words.find(w=>words.filter(x=>x===w).length===1);
  assert(u);return {u:ids[words.indexOf(u)],c:ids.slice(0,4).filter((_,i)=>words[i]!==u),words};
}
async function subscribe(client,callback){
  const ch=client.channel(`test-${Math.random()}`).on('postgres_changes',{event:'UPDATE',schema:'public',table:'wodi_room_events',filter:`room_id=eq.${s.id}`},callback);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Realtime 订阅超时')),15000);ch.subscribe(state=>{if(state==='SUBSCRIBED'){clearTimeout(timer);resolve();}if(state==='CHANNEL_ERROR'){clearTimeout(timer);reject(Error('Realtime 订阅失败'));}});});return ch;
}
try{
  for(let i=0;i<clients.length;i++){
    let response=saved[i]?await clients[i].auth.setSession(saved[i]):{error:1};
    if(response.error)response=await clients[i].auth.signInAnonymously();
    if(response.error)throw response.error;ids.push(response.data.user.id);
  }
  await persist();
  for(let i=0;i<5;i++)await rpc(i,'leave');
  const {data:banks,error}=await clients[0].from('wodi_wordbanks').select('*');if(error)throw error;
  assert(banks.length>=3);assert(banks.reduce((n,b)=>n+b.pair_count,0)>=30);
  const config={capacity:4,maxRounds:5,speakSeconds:15,voteSeconds:15,wordbankId:banks[0].id};
  s=await rpc(0,'create',{nickname:'云测房主',config});assert.match(s.code,/^\d{6}$/);log('创建真实云端房间，词库已初始化');
  channel=await subscribe(clients[0],()=>realtimeEvents++);
  outsiderChannel=await subscribe(clients[4],()=>outsiderEvents++);
  for(let i=1;i<4;i++)s=await rpc(i,'join',{nickname:`云测玩家${i+1}`,code:s.code});
  await assert.rejects(()=>rpc(4,'join',{nickname:'多余玩家',code:s.code}),/满/);
  await wait(1200);assert(realtimeEvents>0);assert.equal(outsiderEvents,0);log('四位独立玩家加入、满员拒绝、成员收到真实 Realtime，外人收不到');
  heartbeat=setInterval(()=>{syncAll().catch(()=>{});},15000);
  await assert.rejects(()=>rpc(1,'start'),/房主/);
  s=await rpc(0,'start');const initial=await roles();assert.equal(new Set(initial.words).size,2);
  const views=await syncAll();assert(views.every(v=>!v.players.some(p=>'role'in p)&&!('pair'in v)&&!('votes'in v)));
  log('服务器随机分配 1 卧底 3 平民，每人只收到自己的词语');
  const direct=await clients[1].schema('wodi_private').from('rooms').select('*');assert(direct.error);
  assert((await clients[1].rpc('wodi_import',{p_name:'非法',p_pairs:[]})).error);
  const outsiderRead=await clients[4].from('wodi_room_events').select('*').eq('room_id',s.id);assert.equal(outsiderRead.data.length,0);
  assert((await clients[1].from('wodi_room_events').update({revision:99}).eq('room_id',s.id)).error);
  log('真实 Data API 拒绝读取私有状态/词库、管理员 RPC 和客户端写入');
  await until(r=>r.phase==='speaking','准备阶段结束');const first=s.speakerId;
  const wrong=ids.findIndex((id,i)=>i<4&&id!==first);
  await assert.rejects(()=>rpc(wrong,'describe',{text:'抢话'}),/轮到/);
  const own=await rpc(ids.indexOf(first),'sync');await assert.rejects(()=>rpc(ids.indexOf(first),'describe',{text:own.self.word}),/词语/);
  await until(r=>r.phase==='speaking'&&r.speakerId!==first,'真实 15 秒发言超时',22000);
  assert(s.messages.some(m=>m.text.includes('发言超时')));log('真实服务器发言超时自动跳过，抢话和直接说词被拒绝');
  while(s.phase==='speaking')s=await rpc(ids.indexOf(s.speakerId),'describe',{text:'我的这个东西有自己的特点，也很常见'});
  assert.equal(s.phase,'voting');log('其余玩家按固定顺序发言，自动进入投票');
  await assert.rejects(()=>rpc(0,'vote',{targetId:ids[0]}),/自己/);
  await assert.rejects(()=>rpc(0,'vote',{targetId:ids[4]}),/无效/);
  s=await rpc(0,'vote',{targetId:ids[1]});assert.equal(s.result,null);assert(!('votes'in s));
  await assert.rejects(()=>rpc(0,'vote',{targetId:ids[2]}),/已经/);
  await Promise.all([1,2,3].map(i=>rpc(i,'vote',{targetId:ids[(i+1)%4]})));
  s=await rpc(0,'sync');assert.equal(s.phase,'results');assert.equal(s.result.tied,true);assert.equal(s.result.eliminatedId,null);
  assert.equal(s.messages.filter(m=>m.text.includes('最高票平票')).length,1);
  log('正常投票、票数隐藏、非法/重复投票拒绝、并发提交只结算一次、平票无人淘汰');
  await speaking();s=await rpc(0,'vote',{targetId:null});
  await until(r=>r.phase==='results','真实投票超时，未投票视为弃票',22000);assert.equal(s.result.abstentions,4);log('主动弃票 + 真实 15 秒超时弃票');
  await speaking();
  await Promise.all([0,1,2,3].map(i=>rpc(i,'vote',{targetId:ids[i]===initial.u?null:initial.u})));
  s=await rpc(0,'sync');assert.equal(s.phase,'finished');assert.equal(s.winner,'civilian');assert.equal(s.result.eliminatedId,initial.u);
  assert(s.players.every(p=>p.role));assert(s.pair.civilian&&s.pair.undercover);log('卧底淘汰，平民获胜，结算才公开全部身份和双方词语');
  await syncAll();s=await rpc(0,'start');const next=await roles();assert.notDeepEqual(new Set(next.words),new Set(initial.words));log('原房间再来一局、保留玩家配置、词对不连续重复');
  const stored=(await clients[1].auth.getSession()).data.session;const word=(await rpc(1,'sync')).self.word;
  await clients[1].removeAllChannels();clients[1]=make();const restored=await clients[1].auth.setSession(stored);assert(!restored.error);
  assert.equal((await rpc(1,'sync')).self.word,word);assert.equal((await rpc(1,'sync')).self.id,ids[1]);
  const reconnectChannel=await subscribe(clients[1],()=>{});await clients[1].removeChannel(reconnectChannel);log('断开 Realtime 后以同一 Auth 会话恢复身份、词语及订阅');
  await speaking();const roundRoles=await roles();
  await Promise.all([0,1,2,3].map(i=>rpc(i,'vote',{targetId:ids[i]===roundRoles.u?null:roundRoles.u})));
  s=await rpc(0,'sync');assert.equal(s.phase,'finished');
  s=await rpc(0,'lobby');s=await rpc(0,'configure',{...config,maxRounds:1});await syncAll();s=await rpc(0,'start');
  await speaking();await Promise.all([0,1,2,3].map(i=>rpc(i,'vote',{targetId:null})));
  s=await rpc(0,'sync');assert.equal(s.winner,'undercover');assert.equal(s.round,1);log('达到最大轮次仍有卧底，卧底获胜');
  s=await rpc(0,'lobby');s=await rpc(0,'configure',config);await syncAll();s=await rpc(0,'start');const parity=await roles();
  for(const target of parity.c.slice(0,2)){
    await speaking();await Promise.all(s.players.filter(p=>p.alive).map(p=>rpc(ids.indexOf(p.id),'vote',{targetId:p.id===target?null:target})));
    s=await rpc(0,'sync');assert.equal(s.result.eliminatedId,target);
    await assert.rejects(()=>rpc(ids.indexOf(target),'describe',{text:'淘汰后发言'}),/轮到/);
  }
  assert.equal(s.winner,'undercover');assert.equal(s.aliveCount,2);log('卧底人数达到平民人数，卧底获胜；淘汰玩家只能旁观');
  const adminFile='.tools/admin-password.secret';
  if(fs.existsSync(adminFile)){
    const jwt=(await clients[0].auth.getSession()).data.session.access_token;
    const password=fs.readFileSync(adminFile,'utf8').trim();
    async function upload(filename,body,pw=password,auth=true){const response=await fetch(`${url}/functions/v1/admin-wordbanks`,{method:'POST',headers:{apikey:key,...(auth?{Authorization:`Bearer ${jwt}`}:{ }), 'Content-Type':'application/octet-stream','x-filename':encodeURIComponent(filename),'x-admin-password':pw},body});return {status:response.status,data:await response.json()};}
    assert.equal((await upload('x.json','{}',password,false)).status,401);
    assert.equal((await upload('x.json','{}','wrong-password')).status,403);
    assert.equal((await upload('../x.json','{}')).status,400);
    assert.equal((await upload('x.json','{')).status,400);
    assert.equal((await upload('x.json',' '.repeat(256*1024+1))).status,413);
    const json=await upload('旅行主题.json',JSON.stringify({name:'旅行主题',pairs:[{civilian:'高铁',undercover:'动车'},{civilian:'酒店',undercover:'民宿'}]}));assert.equal(json.status,200,JSON.stringify(json));
    const csv=await upload('山川地理.csv','civilian,undercover\n沙漠,戈壁\n小溪,河流');assert.equal(csv.status,200,JSON.stringify(csv));
    log('真实 Edge 管理员密码/JWT/路径/格式/大小校验，JSON 和 CSV 成功入库');
  }
  console.log(`\n真实云端测试通过：${results.length} 组场景，Realtime 成员事件 ${realtimeEvents} 次，越权事件 ${outsiderEvents} 次。`);
  fs.writeFileSync('test-output/integration.json',JSON.stringify({completedAt:new Date().toISOString(),project:'cypbwptcuvvaejruiqgb',results,realtimeEvents,outsiderEvents},null,2));
}catch(error){console.error('FAIL',error.message);process.exitCode=1;}
finally{
  clearInterval(heartbeat);
  await persist();
  for(let i=0;i<clients.length;i++){try{await rpc(i,'leave');}catch{}await clients[i].removeAllChannels();}
}
