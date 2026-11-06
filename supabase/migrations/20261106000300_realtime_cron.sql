-- Supabase platform integration; the game SQL is independently testable in PostgreSQL.
do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='wodi_room_events') then
    alter publication supabase_realtime add table public.wodi_room_events;
  end if;
end $$;
create extension if not exists pg_cron;
select cron.schedule('wodi-advance', '5 seconds', 'select wodi_private.tick()');
