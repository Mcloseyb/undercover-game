-- Only new wodi_* objects are created. Secret state never enters an exposed table.
create schema if not exists wodi_private;
revoke all on schema wodi_private from public, anon, authenticated;

create table public.wodi_wordbanks (
  id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 24),
  pair_count integer not null check(pair_count between 2 and 2000)
);
create table wodi_private.pairs (
  id uuid primary key default gen_random_uuid(), bank_id uuid not null references public.wodi_wordbanks(id) on delete cascade,
  civilian text not null check(length(civilian) between 1 and 24),
  undercover text not null check(length(undercover) between 1 and 24), check(civilian <> undercover)
);
create table wodi_private.rooms (
  id uuid primary key, code text unique not null, state jsonb not null,
  updated_at timestamptz not null default clock_timestamp()
);
create table wodi_private.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  room_id uuid not null references wodi_private.rooms(id) on delete cascade,
  last_seen timestamptz not null default clock_timestamp()
);
create index on wodi_private.members(room_id);
create table wodi_private.limits (
  key text primary key, hits integer not null, until_at timestamptz not null
);
create table public.wodi_room_events (
  room_id uuid primary key references wodi_private.rooms(id) on delete cascade,
  revision bigint not null default 1, changed_at timestamptz not null default clock_timestamp()
);
alter table public.wodi_wordbanks enable row level security;
alter table public.wodi_room_events enable row level security;
alter table wodi_private.pairs enable row level security;
alter table wodi_private.rooms enable row level security;
alter table wodi_private.members enable row level security;
alter table wodi_private.limits enable row level security;
revoke all on public.wodi_wordbanks, public.wodi_room_events from public, anon, authenticated;
revoke all on all tables in schema wodi_private from public, anon, authenticated;
grant select on public.wodi_wordbanks to anon, authenticated;
grant select on public.wodi_room_events to authenticated;
create policy wodi_bank_metadata on public.wodi_wordbanks for select to anon, authenticated using (true);

create function wodi_private.is_member(rid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from wodi_private.members where room_id = rid and user_id = (select auth.uid()));
$$;
grant usage on schema wodi_private to authenticated;
grant execute on function wodi_private.is_member(uuid) to authenticated;
create policy wodi_member_events on public.wodi_room_events for select to authenticated
using (wodi_private.is_member(room_id));

create function wodi_private.limited(k text, maximum integer, seconds integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into wodi_private.limits as l values(k,1,clock_timestamp()+make_interval(secs=>seconds))
  on conflict(key) do update set
    hits=case when l.until_at < clock_timestamp() then 1 else l.hits+1 end,
    until_at=case when l.until_at < clock_timestamp() then excluded.until_at else l.until_at end
  returning hits into n;
  return n <= maximum;
end; $$;

create function wodi_private.message(s jsonb, txt text, who jsonb default null) returns jsonb
language plpgsql set search_path = '' as $$
declare msgs jsonb; seq integer := coalesce((s->>'seq')::integer,0)+1;
begin
  msgs := coalesce(s->'messages','[]') || jsonb_build_array(jsonb_build_object(
    'id',seq,'type',case when who is null then 'system' else 'player' end,
    'text',txt,'playerId',who->>'id','nickname',who->>'nickname',
    'time',extract(epoch from clock_timestamp())*1000));
  if jsonb_array_length(msgs)>300 then
    select jsonb_agg(value order by ordinality) into msgs from jsonb_array_elements(msgs) with ordinality where ordinality>jsonb_array_length(msgs)-300;
  end if;
  return s || jsonb_build_object('messages',msgs,'seq',seq);
end; $$;

create function wodi_private.winner(s jsonb, round_limit boolean default false) returns text
language plpgsql set search_path = '' as $$
declare u integer; c integer;
begin
  select count(*) filter(where p->>'role'='undercover'),count(*) filter(where p->>'role'='civilian')
    into u,c from jsonb_array_elements(s->'players') p where (p->>'alive')::boolean;
  if u=0 then return 'civilian'; end if;
  if u>=c or (round_limit and (s->>'round')::integer >= (s#>>'{config,maxRounds}')::integer) then return 'undercover'; end if;
  return null;
end; $$;

create function wodi_private.finish(s jsonb, camp text) returns jsonb
language sql set search_path = '' as $$
  select wodi_private.message(s || jsonb_build_object('phase','finished','winner',camp,'deadline',null,'speakerId',null),
    case when camp='civilian' then '平民获胜，本局结束' else '卧底获胜，本局结束' end);
$$;

create function wodi_private.next_speaker(s jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare i integer := (s->>'speakerIndex')::integer; uid text; p jsonb;
begin
  loop
    i:=i+1;
    if i>=jsonb_array_length(s->'order') then
      return wodi_private.message(s || jsonb_build_object('phase','voting','speakerId',null,'votes','{}'::jsonb,
        'deadline',clock_timestamp()+make_interval(secs=>(s#>>'{config,voteSeconds}')::integer)), '进入投票阶段，请选择其他玩家或弃票');
    end if;
    uid:=s->'order'->>i;
    select value into p from jsonb_array_elements(s->'players') where value->>'id'=uid;
    exit when (p->>'alive')::boolean;
  end loop;
  return wodi_private.message(s || jsonb_build_object('phase','speaking','speakerIndex',i,'speakerId',uid,
    'deadline',clock_timestamp()+make_interval(secs=>(s#>>'{config,speakSeconds}')::integer)),(p->>'nickname')||' 开始发言');
end; $$;

create function wodi_private.begin_round(s jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare ids jsonb;
begin
  select jsonb_agg(p->>'id' order by ord) into ids
    from jsonb_array_elements(s->'players') with ordinality as a(p,ord) where (p->>'alive')::boolean;
  return wodi_private.next_speaker(s || jsonb_build_object('order',ids,'speakerIndex',-1,'result',null));
end; $$;

create function wodi_private.settle(s jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare counts jsonb:='{}'; abstentions integer:=0; p jsonb; target text; top_id text;
  highest integer:=0; ties integer:=0; n integer; eliminated jsonb; camp text;
begin
  for p in select value from jsonb_array_elements(s->'players') where (value->>'alive')::boolean loop
    counts:=counts || jsonb_build_object(p->>'id',0);
  end loop;
  for p in select value from jsonb_array_elements(s->'players') where (value->>'alive')::boolean loop
    target:=s->'votes'->>(p->>'id');
    if target is not null and counts ? target then counts:=jsonb_set(counts,array[target],to_jsonb((counts->>target)::integer+1));
    else abstentions:=abstentions+1; end if;
  end loop;
  for top_id,n in select key,value::integer from jsonb_each_text(counts) loop
    if n>highest then highest:=n; ties:=1; target:=top_id;
    elsif n=highest then ties:=ties+1; end if;
  end loop;
  if highest>0 and ties=1 then
    select value into eliminated from jsonb_array_elements(s->'players') where value->>'id'=target;
    select jsonb_agg(case when p2->>'id'=target then p2||'{"alive":false,"revealed":true}'::jsonb else p2 end order by ord)
      into p from jsonb_array_elements(s->'players') with ordinality as a(p2,ord);
    s:=jsonb_set(s,'{players}',p);
    s:=wodi_private.message(s,(eliminated->>'nickname')||' 被淘汰，身份是'||case when eliminated->>'role'='undercover' then '卧底' else '平民' end);
  else
    s:=wodi_private.message(s,case when highest=0 then '本轮全部弃票，无人淘汰' else '最高票平票，本轮无人淘汰' end);
  end if;
  s:=s||jsonb_build_object('result',jsonb_build_object('round',s->'round','counts',counts,'abstentions',abstentions,
    'eliminatedId',eliminated->>'id','tied',highest>0 and ties>1));
  camp:=wodi_private.winner(s,true);
  if camp is not null then return wodi_private.finish(s,camp); end if;
  return s||jsonb_build_object('phase','results','deadline',clock_timestamp()+interval '7 seconds');
end; $$;

create function wodi_private.advance(s jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare p jsonb;
begin
  if s->>'deadline' is null or (s->>'deadline')::timestamptz>clock_timestamp() then return s; end if;
  case s->>'phase'
  when 'reveal' then return wodi_private.begin_round(s);
  when 'speaking' then
    select value into p from jsonb_array_elements(s->'players') where value->>'id'=s->>'speakerId';
    return wodi_private.next_speaker(wodi_private.message(s,(p->>'nickname')||' 发言超时，已自动跳过'));
  when 'voting' then return wodi_private.settle(s);
  when 'results' then return wodi_private.begin_round(s||jsonb_build_object('round',(s->>'round')::integer+1));
  else return s;
  end case;
end; $$;

create function wodi_private.presence(s jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p jsonb; players jsonb:='[]'; online boolean; host_seen timestamptz; next_host jsonb;
begin
  for p in select value from jsonb_array_elements(s->'players') loop
    select last_seen>clock_timestamp()-interval '45 seconds' into online from wodi_private.members where user_id=(p->>'id')::uuid and room_id=(s->>'id')::uuid;
    players:=players||jsonb_build_array(p||jsonb_build_object('connected',coalesce(online,false)));
  end loop;
  s:=s||jsonb_build_object('players',players);
  select last_seen into host_seen from wodi_private.members where user_id=(s->>'hostId')::uuid and room_id=(s->>'id')::uuid;
  if host_seen is null or host_seen<clock_timestamp()-interval '60 seconds' then
    select value into next_host from jsonb_array_elements(players) where (value->>'connected')::boolean limit 1;
    if next_host is not null and next_host->>'id'<>s->>'hostId' then
      s:=wodi_private.message(s||jsonb_build_object('hostId',next_host->>'id'),(next_host->>'nickname')||' 成为新房主');
    end if;
  end if;
  return s;
end; $$;

create function wodi_private.snapshot(s jsonb, uid uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare p jsonb; me jsonb; players jsonb:='[]'; alive integer:=0; voted integer:=0; ended boolean:=s->>'phase'='finished'; result jsonb;
begin
  for p in select value from jsonb_array_elements(s->'players') loop
    if p->>'id'=uid::text then me:=p; end if;
    if (p->>'alive')::boolean then
      alive:=alive+1;
      if coalesce(s->'votes','{}') ? (p->>'id') then voted:=voted+1; end if;
    end if;
    players:=players||jsonb_build_array(jsonb_build_object('id',p->>'id','nickname',p->>'nickname','alive',p->'alive','connected',p->'connected')
      ||case when ended or coalesce((p->>'revealed')::boolean,false) then jsonb_build_object('role',p->>'role') else '{}'::jsonb end);
  end loop;
  result:=jsonb_build_object('id',s->>'id','code',s->>'code','hostId',s->>'hostId','config',s->'config',
    'phase',s->>'phase','round',s->'round','gameId',s->>'gameId','speakerId',s->>'speakerId',
    'deadline',case when s->>'deadline' is null then null else extract(epoch from (s->>'deadline')::timestamptz)*1000 end,
    'serverTime',extract(epoch from clock_timestamp())*1000,'players',players,'messages',s->'messages',
    'aliveCount',alive,'voteCount',voted,'self',jsonb_build_object('id',uid,'hasVoted',coalesce(s->'votes','{}') ? uid::text,
      'word',case when s->>'phase'<>'waiting' then s->'pair'->>(me->>'role') else null end),
    'result',case when s->>'phase' in ('results','finished') then s->'result' else null end);
  if ended then result:=result||jsonb_build_object('pair',s->'pair','winner',s->>'winner'); end if;
  return result;
end; $$;

create function wodi_private.config(c jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare k text; v integer; clean jsonb:='{}';
begin
  foreach k in array array['capacity','maxRounds','speakSeconds','voteSeconds'] loop
    if jsonb_typeof(c->k)<>'number' or (c->>k)!~'^\d+$' then raise exception '房间设置必须是整数'; end if;
    v:=(c->>k)::integer;
    if v is null or (k='capacity' and v not between 4 and 8) or (k='maxRounds' and v not between 1 and 30)
      or (k in ('speakSeconds','voteSeconds') and v not between 15 and 120) then raise exception '房间设置超出允许范围'; end if;
    clean:=clean||jsonb_build_object(k,v);
  end loop;
  if not exists(select 1 from public.wodi_wordbanks where id=(c->>'wordbankId')::uuid) then raise exception '请选择有效词库'; end if;
  return clean||jsonb_build_object('wordbankId',c->>'wordbankId');
end; $$;

create function wodi_private.save(rid uuid, s jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update wodi_private.rooms set state=s,updated_at=clock_timestamp() where id=rid;
  update public.wodi_room_events set revision=revision+1,changed_at=clock_timestamp() where room_id=rid;
end; $$;

create function public.wodi_action(p_action text, p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=auth.uid(); rid uuid; s jsonb; original jsonb; p jsonb; players jsonb; config jsonb;
  nick text; room_code text; pair wodi_private.pairs%rowtype; total integer; n integer; target text; camp text;
begin
  if uid is null then return jsonb_build_object('error','请先匿名登录'); end if;
  if octet_length(p_payload::text)>4096 then return jsonb_build_object('error','请求过大'); end if;
  if not wodi_private.limited('user:'||uid::text,240,60) then return jsonb_build_object('error','操作太频繁，请稍后再试'); end if;
  if p_action in ('create','join') and not wodi_private.limited('entry:'||uid::text,12,600) then return jsonb_build_object('error','创建或加入过于频繁，请 10 分钟后再试'); end if;
  -- Errors inside this block roll back game mutations, but preserve the rate counter above.
  begin
    perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
    select room_id into rid from wodi_private.members where user_id=uid;
    if p_action in ('create','join') then
      if rid is not null then raise exception '请先退出当前房间'; end if;
      nick:=btrim(p_payload->>'nickname');
      if nick is null or length(nick) not between 1 and 12 or nick~'[[:cntrl:]]' then raise exception '昵称需要 1～12 个字，不能含控制字符'; end if;
      p:=jsonb_build_object('id',uid,'nickname',nick,'alive',true,'connected',true);
      if p_action='create' then
        config:=wodi_private.config(p_payload->'config');
        rid:=gen_random_uuid();
        perform pg_advisory_xact_lock(601106);
        loop
          room_code:=lpad((floor(random()*900000)+100000)::text,6,'0');
          exit when not exists(select 1 from wodi_private.rooms r where r.code=room_code);
        end loop;
        s:=wodi_private.message(jsonb_build_object('id',rid,'code',room_code,'hostId',uid,'config',config,'phase','waiting','round',0,
          'players',jsonb_build_array(p),'messages','[]'::jsonb,'votes','{}'::jsonb),'房间已创建，叫上朋友，一起找出卧底。');
        insert into wodi_private.rooms(id,code,state) values(rid,room_code,s);
        insert into public.wodi_room_events(room_id) values(rid);
      else
        room_code:=p_payload->>'code';
        if room_code is null or room_code!~'^\d{6}$' then raise exception '请输入 6 位房间号'; end if;
        select r.id,r.state into rid,s from wodi_private.rooms r where r.code=room_code for update;
        if rid is null then raise exception '房间不存在或已失效'; end if;
        if s->>'phase'<>'waiting' then raise exception '游戏已开始，请等待房主返回大厅'; end if;
        if jsonb_array_length(s->'players') >= (s#>>'{config,capacity}')::integer then raise exception '房间已满'; end if;
        if exists(select 1 from jsonb_array_elements(s->'players') x where x->>'nickname'=nick) then raise exception '该昵称已被使用'; end if;
        s:=wodi_private.message(s||jsonb_build_object('players',(s->'players')||jsonb_build_array(p)),nick||' 加入了房间');
        perform wodi_private.save(rid,s);
      end if;
      insert into wodi_private.members(user_id,room_id) values(uid,rid);
      return wodi_private.snapshot(s,uid);
    end if;
    if rid is null then return jsonb_build_object('room',null); end if;
    select state into s from wodi_private.rooms where id=rid for update;
    original:=s;
    update wodi_private.members set last_seen=clock_timestamp() where user_id=uid;
    s:=wodi_private.presence(wodi_private.advance(s));
    select value into p from jsonb_array_elements(s->'players') where value->>'id'=uid::text;
    if p_action in ('sync','heartbeat') then null;
    elsif p_action='configure' then
      if s->>'hostId'<>uid::text or s->>'phase'<>'waiting' then raise exception '只有房主能在等待大厅修改设置'; end if;
      config:=wodi_private.config(p_payload);
      if (config->>'capacity')::integer<jsonb_array_length(s->'players') then raise exception '人数不能少于当前玩家数'; end if;
      s:=s||jsonb_build_object('config',config);
    elsif p_action='start' then
      if s->>'hostId'<>uid::text or s->>'phase' not in ('waiting','finished') then raise exception '只有房主可以开始新一局'; end if;
      total:=jsonb_array_length(s->'players');
      if total<>(s#>>'{config,capacity}')::integer then raise exception '人数达到设置值才能开始'; end if;
      if exists(select 1 from jsonb_array_elements(s->'players') x where not (x->>'connected')::boolean) then raise exception '请等待所有玩家重新连接，或返回大厅调整玩家'; end if;
      select * into pair from wodi_private.pairs where bank_id=(s#>>'{config,wordbankId}')::uuid and id::text is distinct from s->>'lastPairId' order by random() limit 1;
      if pair.id is null then raise exception '词库不可用，请更换词库'; end if;
      select jsonb_agg((x - 'revealed' - 'departed')||jsonb_build_object('alive',true,'role',case when rank<=case when total>=7 then 2 else 1 end then 'undercover' else 'civilian' end) order by ord)
        into players from (select x,ord,row_number() over(order by random()) as rank from jsonb_array_elements(s->'players') with ordinality as a(x,ord)) q;
      s:=wodi_private.message(s||jsonb_build_object('players',players,'gameId',gen_random_uuid(),'round',1,'phase','reveal',
        'pair',jsonb_build_object('civilian',pair.civilian,'undercover',pair.undercover),'lastPairId',pair.id,
        'messages','[]'::jsonb,'votes','{}'::jsonb,'result',null,'winner',null,'speakerId',null,
        'deadline',clock_timestamp()+interval '7 seconds'),'词语已发放。只看自己的词，描述时不要直接说出词语。');
    elsif p_action='describe' then
      if s->>'phase'<>'speaking' or s->>'speakerId'<>uid::text or not (p->>'alive')::boolean then raise exception '当前没有轮到你发言'; end if;
      target:=btrim(p_payload->>'text');
      if target is null or length(target) not between 1 and 160 or target~'[[:cntrl:]]' then raise exception '描述需要 1～160 个字，不能包含换行或控制字符'; end if;
      if position(s->'pair'->>(p->>'role') in target)>0 then raise exception '描述不能直接包含你的词语，请换个说法'; end if;
      s:=wodi_private.next_speaker(wodi_private.message(s,target,p));
    elsif p_action='vote' then
      if s->>'phase'<>'voting' or not (p->>'alive')::boolean then raise exception '当前不能投票'; end if;
      if (s->'votes') ? uid::text then raise exception '本轮已经投过票'; end if;
      if not (p_payload ? 'targetId') then raise exception '请选择其他玩家或弃票'; end if;
      target:=p_payload->>'targetId';
      if target is not null and (target=uid::text or not exists(select 1 from jsonb_array_elements(s->'players') x where x->>'id'=target and (x->>'alive')::boolean)) then raise exception '不能投自己或无效玩家'; end if;
      s:=jsonb_set(s,array['votes',uid::text],coalesce(to_jsonb(target),'null'::jsonb));
      if not exists(select 1 from jsonb_array_elements(s->'players') x where (x->>'alive')::boolean and not ((s->'votes') ? (x->>'id'))) then s:=wodi_private.settle(s); end if;
    elsif p_action='lobby' then
      if s->>'hostId'<>uid::text or s->>'phase'<>'finished' then raise exception '只有房主可以在结束后返回大厅'; end if;
      select coalesce(jsonb_agg(x-'role'-'revealed'-'departed' order by ord),'[]') into players
        from jsonb_array_elements(s->'players') with ordinality as a(x,ord) where exists(select 1 from wodi_private.members m where m.user_id=(x->>'id')::uuid and m.room_id=rid);
      s:=s||jsonb_build_object('players',players,'phase','waiting','round',0,'result',null,'winner',null,'deadline',null,'votes','{}'::jsonb);
    elsif p_action in ('leave','kick') then
      target:=case when p_action='leave' then uid::text else p_payload->>'playerId' end;
      if p_action='kick' and (s->>'hostId'<>uid::text or s->>'phase'<>'waiting' or target=uid::text
        or not exists(select 1 from jsonb_array_elements(s->'players') x where x->>'id'=target and not (x->>'connected')::boolean)) then raise exception '房主只能在大厅移除离线玩家'; end if;
      if s->>'phase' in ('waiting','finished') then
        select coalesce(jsonb_agg(x order by ord),'[]') into players from jsonb_array_elements(s->'players') with ordinality as a(x,ord) where x->>'id'<>target;
      else
        select jsonb_agg(case when x->>'id'=target then x||'{"alive":false,"revealed":true,"departed":true,"connected":false}'::jsonb else x end order by ord)
          into players from jsonb_array_elements(s->'players') with ordinality as a(x,ord);
      end if;
      s:=wodi_private.message(s||jsonb_build_object('players',players),'有玩家离开了房间');
      delete from wodi_private.members where user_id=target::uuid and room_id=rid;
      s:=wodi_private.presence(s);
      if s->>'phase' not in ('waiting','finished') then
        camp:=wodi_private.winner(s);
        if camp is not null then s:=wodi_private.finish(s,camp);
        elsif s->>'phase'='speaking' and s->>'speakerId'=target then s:=wodi_private.next_speaker(s);
        elsif s->>'phase'='voting' and not exists(select 1 from jsonb_array_elements(players) x where (x->>'alive')::boolean and not ((s->'votes') ? (x->>'id'))) then s:=wodi_private.settle(s); end if;
      end if;
      perform wodi_private.save(rid,s);
      if p_action='leave' then return jsonb_build_object('room',null); end if;
    else raise exception '未知操作';
    end if;
    if s is distinct from original then perform wodi_private.save(rid,s); end if;
    return wodi_private.snapshot(s,uid);
  exception when others then return jsonb_build_object('error',sqlerrm);
  end;
end; $$;

create function public.wodi_admin_gate(p_fingerprint text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare a boolean; b boolean;
begin
  a:=wodi_private.limited('admin:global',100,900);
  b:=wodi_private.limited('admin:'||left(p_fingerprint,128),12,900);
  return a and b;
end; $$;

create function public.wodi_import(p_name text, p_pairs jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare bank uuid; p jsonb; a text; b text; seen text[]:='{}'; k text;
begin
  if length(btrim(p_name)) not between 1 and 24 or jsonb_typeof(p_pairs)<>'array' or jsonb_array_length(p_pairs) not between 2 and 2000 then raise exception '词库名称或配对数量无效'; end if;
  insert into public.wodi_wordbanks(name,pair_count) values(btrim(p_name),jsonb_array_length(p_pairs)) returning id into bank;
  for p in select value from jsonb_array_elements(p_pairs) loop
    a:=btrim(p->>'civilian'); b:=btrim(p->>'undercover');
    if a is null or b is null or length(a) not between 1 and 24 or length(b) not between 1 and 24 or a=b or (a||b)~'[[:cntrl:]]' then raise exception '词语格式不合法'; end if;
    k:=least(a,b)||chr(1)||greatest(a,b);
    if k=any(seen) then raise exception '存在重复配对'; end if;
    seen:=array_append(seen,k);
    insert into wodi_private.pairs(bank_id,civilian,undercover) values(bank,a,b);
  end loop;
  return bank;
end; $$;

create function wodi_private.tick() returns void
language plpgsql security definer set search_path = '' as $$
declare r record; s jsonb;
begin
  for r in select * from wodi_private.rooms where updated_at>clock_timestamp()-interval '24 hours' for update skip locked loop
    s:=wodi_private.presence(wodi_private.advance(r.state));
    if s is distinct from r.state then perform wodi_private.save(r.id,s); end if;
  end loop;
end; $$;

revoke execute on all functions in schema wodi_private from public,anon,authenticated;
grant execute on function wodi_private.is_member(uuid) to authenticated;
revoke execute on function public.wodi_action(text,jsonb) from public,anon;
grant execute on function public.wodi_action(text,jsonb) to authenticated;
revoke execute on function public.wodi_admin_gate(text), public.wodi_import(text,jsonb) from public,anon,authenticated;
grant execute on function public.wodi_admin_gate(text), public.wodi_import(text,jsonb) to service_role;
