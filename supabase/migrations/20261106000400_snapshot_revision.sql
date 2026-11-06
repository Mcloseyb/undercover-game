-- Prevent delayed network responses from replacing a newer room view.
create or replace function wodi_private.snapshot(s jsonb, uid uuid) returns jsonb
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
  result:=jsonb_build_object('revision',(select revision from public.wodi_room_events where room_id=(s->>'id')::uuid),'id',s->>'id','code',s->>'code','hostId',s->>'hostId','config',s->'config',
    'phase',s->>'phase','round',s->'round','gameId',s->>'gameId','speakerId',s->>'speakerId',
    'deadline',case when s->>'deadline' is null then null else extract(epoch from (s->>'deadline')::timestamptz)*1000 end,
    'serverTime',extract(epoch from clock_timestamp())*1000,'players',players,'messages',s->'messages',
    'aliveCount',alive,'voteCount',voted,'self',jsonb_build_object('id',uid,'hasVoted',coalesce(s->'votes','{}') ? uid::text,
      'word',case when s->>'phase'<>'waiting' then s->'pair'->>(me->>'role') else null end),
    'result',case when s->>'phase' in ('results','finished') then s->'result' else null end);
  if ended then result:=result||jsonb_build_object('pair',s->'pair','winner',s->>'winner'); end if;
  return result;
end; $$;

