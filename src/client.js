import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from './config';
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
});
export async function authenticate() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (data.session) return data.session;
  const result = await supabase.auth.signInAnonymously();
  if (result.error) throw new Error(result.error.message.includes('disabled') ? '服务器尚未开启匿名登录，请联系房主完成 Supabase 配置' : result.error.message);
  return result.data.session;
}
export async function action(name, payload = {}) {
  const { data, error } = await supabase.rpc('wodi_action', { p_action: name, p_payload: payload });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return data?.room === null ? null : data;
}
export async function getBanks() {
  const { data, error } = await supabase.from('wodi_wordbanks').select('id,name,pair_count').order('name');
  if (error) throw error;
  return data.map(b => ({...b,count:b.pair_count}));
}
