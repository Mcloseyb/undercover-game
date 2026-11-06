import { authenticate, getBanks, supabase } from './client';
import { SUPABASE_URL, SUPABASE_KEY } from './config';
import { initMobile } from './mobile';
import './style.css';
initMobile();
const status=document.querySelector('#status');
function message(text,error=false){status.textContent=text;status.classList.toggle('error',error);}
async function list(){
  const banks=await getBanks();const ul=document.querySelector('#banks');ul.replaceChildren();
  for(const b of banks){const li=document.createElement('li'),name=document.createElement('span'),count=document.createElement('span');name.textContent=b.name;count.textContent=`${b.count} 组词`;count.className='muted';li.append(name,count);ul.append(li);}
}
authenticate().then(list).catch(e=>message(e.message,true));
document.querySelector('#upload-form').addEventListener('submit',async e=>{
  e.preventDefault();const button=document.querySelector('#upload');if(button.disabled)return;
  const file=document.querySelector('#file').files[0];if(!file)return;
  if(!/\.(json|csv)$/i.test(file.name)||file.size>256*1024)return message('请选择小于 256 KB 的 JSON 或 CSV 文件',true);
  button.disabled=true;message('正在校验并导入…');
  try{
    await authenticate();const {data:{session}}=await supabase.auth.getSession();
    const response=await fetch(`${SUPABASE_URL}/functions/v1/admin-wordbanks`,{method:'POST',headers:{'Content-Type':'application/octet-stream',apikey:SUPABASE_KEY,Authorization:`Bearer ${session.access_token}`,'x-admin-password':document.querySelector('#password').value,'x-filename':encodeURIComponent(file.name)},body:file});
    const result=await response.json();if(!response.ok)throw Error(result.error||'导入失败');
    message(`已导入「${result.name}」，共 ${result.count} 组词。房主现在就能选择。`);document.querySelector('#password').value='';document.querySelector('#file').value='';await list();
  }catch(error){message(error.message,true);}finally{button.disabled=false;}
});
