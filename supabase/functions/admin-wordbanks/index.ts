import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { parse } from 'npm:csv-parse@7.0.3/sync';
import { validateBank, validateFilename } from '../_shared/validate.js';

const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info, x-admin-password, x-filename', 'Access-Control-Allow-Methods':'POST, OPTIONS' };
const reply = (status:number, data:unknown) => Response.json(data,{status,headers:{...cors,'Cache-Control':'no-store'}});
const digest = async (s:string) => new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
Deno.serve(async request => {
  if (request.method==='OPTIONS') return new Response(null,{headers:cors});
  if (request.method!=='POST') return reply(405,{error:'仅支持 POST 上传'});
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
    const authorization=request.headers.get('Authorization')||'';
    const {data:user,error:authError}=await admin.auth.getUser(authorization.replace(/^Bearer\s+/i,''));
    if(authError||!user.user) return reply(401,{error:'请刷新页面后重新登录'});
    const password=Deno.env.get('ADMIN_PASSWORD')||'';
    if(password.length<12) return reply(503,{error:'管理功能尚未启用，请在服务端设置至少 12 个字符的 ADMIN_PASSWORD'});
    const ip=request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';
    const fingerprint=Array.from(await digest(ip)).map(x=>x.toString(16).padStart(2,'0')).join('');
    const {data:allowed,error:gateError}=await admin.rpc('wodi_admin_gate',{p_fingerprint:fingerprint});
    if(gateError) throw Error('管理员频率校验失败');
    if(!allowed) return reply(429,{error:'管理操作过于频繁，请 15 分钟后再试'});
    const supplied=request.headers.get('x-admin-password')||'';
    const a=await digest(supplied),b=await digest(password);let diff=0;
    for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
    if(diff!==0) return reply(403,{error:'管理员密码不正确'});
    let filename:string;
    try{filename=decodeURIComponent(request.headers.get('x-filename')||'');}catch{return reply(400,{error:'文件名编码不正确'});}
    const format=validateFilename(filename);
    const max=256*1024;
    if(Number(request.headers.get('content-length')||0)>max)return reply(413,{error:'文件不能超过 256 KB'});
    const reader=request.body?.getReader();if(!reader) return reply(400,{error:'请选择文件'});
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();return reply(413,{error:'文件不能超过 256 KB'});}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');
    let data;
    if(format==='json'){try{data=JSON.parse(text);}catch{return reply(400,{error:'JSON 格式错误，请检查引号、逗号及 UTF-8 编码'});}}
    else{
      let rows:string[][];
      try{rows=parse(text,{skip_empty_lines:true,trim:true,max_record_size:4096});}catch{return reply(400,{error:'CSV 格式错误，请检查列数、引号及 UTF-8 编码'});}
      if(rows.length<3||rows.some(r=>r.length!==2)||!['civilian,undercover','平民词,卧底词'].includes(rows[0].join(',')))return reply(400,{error:'CSV 需要两列，首行 civilian,undercover 或 平民词,卧底词，并至少包含两组词'});
      data={name:filename.replace(/\.csv$/i,''),pairs:rows.slice(1).map(r=>({civilian:r[0],undercover:r[1]}))};
    }
    const bank=validateBank(data);
    const {data:id,error}=await admin.rpc('wodi_import',{p_name:bank.name,p_pairs:bank.pairs});
    if(error) return reply(400,{error:`导入失败：${error.message}`});
    return reply(200,{id,name:bank.name,count:bank.pairs.length});
  }catch(error){return reply(400,{error:error instanceof Error?error.message:'上传失败，请检查文件格式'});}
});
