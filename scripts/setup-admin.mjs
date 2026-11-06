import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
fs.mkdirSync('.tools',{recursive:true});
const file='.tools/admin-password.secret';
const password=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim():crypto.randomBytes(21).toString('base64url');
if(!fs.existsSync(file))fs.writeFileSync(file,password+'\n',{flag:'wx',mode:0o600});
const temporary='.tools/admin-env.secret';
try{
  fs.writeFileSync(temporary,`ADMIN_PASSWORD=${password}\n`,{mode:0o600});
  const result=spawnSync('.tools/supabase.exe',['secrets','set','--env-file',temporary,'--yes','--agent','no','--output-format','text'],{stdio:'inherit'});
  process.exitCode=result.status??1;
  if(result.status===0)console.log('管理员密码已保存在忽略提交的 .tools/admin-password.secret，并写入 Supabase 服务端 Secrets。');
}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
