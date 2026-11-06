import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

test('real PostgreSQL game RPC, permissions and four-player flow', async t => {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;`);
  await db.exec(await fs.readFile(new URL('../supabase/migrations/20261106000100_game.sql',import.meta.url),'utf8'));
  await db.exec(await fs.readFile(new URL('../supabase/migrations/20261106000200_words.sql',import.meta.url),'utf8'));
  await db.exec(await fs.readFile(new URL('../supabase/migrations/20261106000400_snapshot_revision.sql',import.meta.url),'utf8'));
  const ids = Array.from({length:9},()=>randomUUID());
  for (const id of ids) await db.query('insert into auth.users values($1)',[id]);
  const bank = (await db.query('select id from public.wodi_wordbanks limit 1')).rows[0].id;
  const config = {capacity:4,maxRounds:5,speakSeconds:15,voteSeconds:15,wordbankId:bank};
  async function rpc(i, action, payload={}) {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[i]]);
    await db.exec('set role authenticated');
    try { return (await db.query('select public.wodi_action($1,$2::jsonb) as data',[action,JSON.stringify(payload)])).rows[0].data; }
    finally { await db.exec('reset role'); }
  }
  const ok = r => { assert.equal(r.error,undefined,JSON.stringify(r)); return r; };
  let s;
  async function expire() {
    await db.query("update wodi_private.rooms set state=jsonb_set(state,'{deadline}',to_jsonb((clock_timestamp()-interval '1 second')::text)) where id=$1",[s.id]);
    s=ok(await rpc(0,'sync')); return s;
  }
  async function speakRound() {
    if (s.phase==='reveal'||s.phase==='results') await expire();
    while(s.phase==='speaking') s=ok(await rpc(ids.indexOf(s.speakerId),'describe',{text:'这是一个生活中会遇到的东西'}));
    assert.equal(s.phase,'voting');
  }
  async function roleIds() {
    const state=(await db.query('select state from wodi_private.rooms where id=$1',[s.id])).rows[0].state;
    return {u:state.players.filter(p=>p.role==='undercover').map(p=>p.id),c:state.players.filter(p=>p.role==='civilian').map(p=>p.id),pair:state.lastPairId};
  }
  await t.test('create, join four players, reject duplicates/full/non-host start',async()=>{
    s=ok(await rpc(0,'create',{nickname:'玩家一',config}));
    assert.match(s.code,/^\d{6}$/);
    assert.match((await rpc(0,'start')).error,/人数/);
    for(let i=1;i<4;i++) s=ok(await rpc(i,'join',{code:s.code,nickname:`玩家${i+1}`}));
    assert.match((await rpc(4,'join',{code:s.code,nickname:'多余玩家'})).error,/满/);
    assert.match((await rpc(1,'start')).error,/房主/);
    s=ok(await rpc(0,'start'));
    assert.equal(s.phase,'reveal');
    assert.equal((await rpc(4,'sync')).room,null);
  });
  await t.test('one undercover, private words, direct table/RPC write denied',async()=>{
    const r=await roleIds(); assert.equal(r.u.length,1); assert.equal(r.c.length,3);
    const words=[];
    for(let i=0;i<4;i++){
      const view=ok(await rpc(i,'sync')); words.push(view.self.word);
      assert(!view.players.some(p=>'role' in p)); assert(!('pair' in view)); assert(!('votes' in view));
    }
    assert.equal(new Set(words).size,2);
    await db.exec('set role authenticated');
    for(const sql of ['select * from wodi_private.rooms','select * from wodi_private.pairs','select * from wodi_private.members',"select public.wodi_import('x','[]')","select wodi_private.tick()","update public.wodi_room_events set revision=100"]){
      await assert.rejects(()=>db.exec(sql),/permission denied/);
    }
    await db.exec('reset role');
  });
  await t.test('timeout, turn validation, exact-word rejection and ordered speaking',async()=>{
    await expire(); const first=s.speakerId;
    const bad=ids.findIndex((id,i)=>i<4&&id!==first);
    assert.match((await rpc(bad,'describe',{text:'抢话'})).error,/轮到/);
    const view=ok(await rpc(ids.indexOf(first),'sync'));
    assert.match((await rpc(ids.indexOf(first),'describe',{text:view.self.word})).error,/词语/);
    await expire(); assert.notEqual(s.speakerId,first);
    assert(s.messages.some(m=>m.text.includes('发言超时')));
    await speakRound();
  });
  await t.test('illegal/duplicate voting rejected, choices hidden, four-way tie',async()=>{
    assert.match((await rpc(0,'vote',{targetId:ids[0]})).error,/自己/);
    assert.match((await rpc(0,'vote',{targetId:ids[8]})).error,/无效/);
    s=ok(await rpc(0,'vote',{targetId:ids[1]}));
    assert.equal(s.result,null); assert.equal(s.voteCount,1); assert(!('votes' in s));
    assert.match((await rpc(0,'vote',{targetId:ids[2]})).error,/已经/);
    for(let i=1;i<4;i++) s=ok(await rpc(i,'vote',{targetId:ids[(i+1)%4]}));
    assert.equal(s.phase,'results'); assert.equal(s.result.tied,true); assert.equal(s.result.eliminatedId,null);
  });
  await t.test('explicit abstain and timeout abstain',async()=>{
    await speakRound(); s=ok(await rpc(0,'vote',{targetId:null}));
    await expire(); assert.equal(s.result.abstentions,4); assert.equal(s.result.eliminatedId,null);
  });
  await t.test('undercover eliminated, civilian victory and full reveal',async()=>{
    await speakRound(); const {u}=await roleIds();
    for(let i=0;i<4;i++) s=ok(await rpc(i,'vote',{targetId:ids[i]===u[0]?null:u[0]}));
    assert.equal(s.phase,'finished'); assert.equal(s.winner,'civilian'); assert.equal(s.result.eliminatedId,u[0]);
    assert(s.players.every(p=>p.role)); assert(s.pair.civilian&&s.pair.undercover);
  });
  await t.test('refresh/rejoin identity, restart no repeat, max rounds gives undercover win',async()=>{
    const old=await roleIds();
    s=ok(await rpc(0,'lobby')); s=ok(await rpc(0,'configure',{...config,maxRounds:1}));
    s=ok(await rpc(0,'start')); const next=await roleIds(); assert.notEqual(old.pair,next.pair);
    const view=ok(await rpc(1,'sync')); assert.equal(view.self.id,ids[1]); assert(view.self.word);
    assert.equal(ok(await rpc(1,'sync')).self.word,view.self.word);
    await speakRound(); for(let i=0;i<4;i++) s=ok(await rpc(i,'vote',{targetId:null}));
    assert.equal(s.winner,'undercover'); assert.equal(s.round,1);
  });
  await t.test('parity victory and eliminated players cannot participate',async()=>{
    s=ok(await rpc(0,'lobby')); s=ok(await rpc(0,'configure',config)); s=ok(await rpc(0,'start'));
    const {c}=await roleIds();
    for(const target of c.slice(0,2)){
      await speakRound();
      for(const p of s.players.filter(p=>p.alive)) s=ok(await rpc(ids.indexOf(p.id),'vote',{targetId:p.id===target?null:target}));
      assert.equal(s.result.eliminatedId,target);
      assert((await rpc(ids.indexOf(target),'describe',{text:'不能发言'})).error);
    }
    assert.equal(s.winner,'undercover'); assert.equal(s.aliveCount,2);
  });
  await t.test('membership RLS, host timeout transfer, offline kick',async()=>{
    const outsider=await rpc(4,'sync'); assert.equal(outsider.room,null);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[4]]);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select * from public.wodi_room_events')).rows.length,0);
    await db.exec('reset role');
    await db.query("update wodi_private.members set last_seen=clock_timestamp()-interval '70 seconds' where user_id=$1",[ids[0]]);
    s=ok(await rpc(1,'sync')); assert.equal(s.hostId,ids[1]);
    s=ok(await rpc(1,'lobby')); s=ok(await rpc(1,'kick',{playerId:ids[0]})); assert.equal(s.players.length,3);
    assert.equal((await rpc(0,'sync')).room,null);
  });
  await t.test('7 players have 2 undercovers, reject client identity injection',async()=>{
    for(let i=1;i<4;i++) ok(await rpc(i,'leave'));
    s=ok(await rpc(0,'create',{nickname:'七人房主',config:{...config,capacity:7}}));
    for(let i=1;i<7;i++) s=ok(await rpc(i,'join',{nickname:`朋友${i}`,code:s.code,role:'undercover'}));
    s=ok(await rpc(0,'start',{role:'civilian'})); const r=await roleIds(); assert.equal(r.u.length,2);
  });
  await db.close();
});
