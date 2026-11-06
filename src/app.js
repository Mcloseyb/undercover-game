import { supabase, authenticate, action, getBanks } from './client';
import { initMobile } from './mobile';
import { updateView } from './view';
import './style.css';

initMobile();

const $ = s => document.querySelector(s);
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const app = $('#app');
let room = null, banks = [], channel = null, subscribedRoom = null, epoch = 0;
let connected = false, busy = false, syncing = false, queuedSync = false;
let draft = '', draftKey = '', selectedVote, voteKey, revealSeen, lastPhase, notice = '';
let composing = false, openingForm = false, renderedStep = '', activeRequest = '';
let serverAnchor = { time: Date.now(), monotonic: performance.now() };
let toastTimer, lastPoll = 0;
const read = (key,fallback='') => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const write = (key,value) => { try { localStorage.setItem(key,value); } catch {} };
const forget = key => { try { localStorage.removeItem(key); } catch {} };
function stats() { try { return JSON.parse(read('wodi-stats','{"total":0,"wins":0,"seen":[]}')); } catch { return {total:0,wins:0,seen:[]}; } }
function toast(text,error=false) {
  const el=$('#toast'); el.textContent=text; el.className=`toast visible${error?' error':''}`;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('visible'),3800);
}
function status(ok,label) {
  connected=ok; const el=$('#connection'); el.className=`connection ${ok?'online':'offline'}`; el.textContent=label;
}
function avatar(p,cls='') {
  const n=room?.players.findIndex(x=>x.id===p.id) ?? 0;
  return `<div class="avatar c${Math.max(0,n)%5} ${cls}">${escape([...p.nickname][0])}</div>`;
}
function accept(next) {
  if(next && room?.id===next.id && Number(next.revision)<Number(room.revision)) return;
  const oldId=room?.id;
  const previousSpeaker=room?.speakerId;
  const unchanged=room && next && room.id===next.id && room.revision===next.revision;
  room=next;
  const nextDraftKey=room?.gameId ? `wodi-draft:${room.id}:${room.gameId}:${room.round}:${room.self.id}` : '';
  if(nextDraftKey!==draftKey){
    if(draftKey)forget(draftKey);
    draftKey=nextDraftKey;draft=draftKey?read(draftKey):'';
  }
  if(room){
    serverAnchor={time:Number(room.serverTime),monotonic:performance.now()};
    write('wodi-room',room.code);
    if(room.phase==='finished'){
      const st=stats();
      if(!st.seen.includes(room.gameId)){
        st.total++; if(room.players.find(p=>p.id===room.self.id)?.role===room.winner) st.wins++;
        st.seen=[...st.seen.slice(-49),room.gameId]; write('wodi-stats',JSON.stringify(st));
      }
    }
  } else {
    if(read('wodi-room')) notice='之前的房间已结束、已过期或你已被移出，请重新创建或加入。';
    write('wodi-room',''); hideWord();
  }
  if($('#room-form')?.dataset.kind==='configure' && room?.phase!=='waiting')$('#form-dialog').close();
  if(!unchanged)render();
  if(room?.phase==='speaking'&&room.speakerId===room.self.id&&previousSpeaker!==room.speakerId)toast('轮到你发言了，写一句描述吧');
  if(oldId!==room?.id) subscribe();
}
async function refresh() {
  if(syncing){queuedSync=true;return;}
  syncing=true;
  const requestEpoch=epoch;
  try { const next=await action('sync'); if(requestEpoch===epoch)accept(next); if(!channel) status(true,'已连接'); }
  catch(error){status(false,'连接中断 · 正在重试'); if(!room&&app.querySelector('.loading')) errorPage(error.message);}
  finally { syncing=false; if(queuedSync){queuedSync=false;setTimeout(refresh,150);} }
}
function subscribe() {
  if(channel) supabase.removeChannel(channel);
  channel=null; subscribedRoom=room?.id;
  if(!subscribedRoom) return;
  channel=supabase.channel(`room-${subscribedRoom}`)
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'wodi_room_events',filter:`room_id=eq.${subscribedRoom}`},refresh)
    .subscribe(state=>{
      if(state==='SUBSCRIBED'){status(true,'实时联机中');refresh();}
      else if(['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(state)) status(false,'正在恢复实时连接');
    });
}
async function run(name,payload={}) {
  if(busy) return false;
  busy=true;activeRequest=name;
  epoch++;
  // Dialog controls are local actions and must remain usable during RPC requests.
  render();
  try { const next=await action(name,payload); accept(next); if(name==='vote')toast('投票已提交'); return true; }
  catch(error){toast(error.message,true);return false;}
  finally {busy=false;activeRequest='';render();}
}
function home() {
  const st=stats();
  return `<section class="home"><span class="eyebrow">LESS TALK. MORE MYSTERY.</span><h1>谁是卧底<span class="muted">.</span></h1><p class="intro">熟悉的朋友，陌生的身份。你能藏到最后吗？</p>
    <div class="hero-art" aria-hidden="true"><div class="hero-grid"></div><span class="art-star">✦</span><span class="art-dot"></span><div class="hero-card"><b>?</b><span>相信直觉</span></div><div class="hero-card front"><b>?</b><span>藏好身份</span></div><div class="hero-caption">一句描述 · 一场推理 · 一群朋友</div></div>
    ${notice?`<p class="notice">${escape(notice)}</p>`:''}
    <div class="home-actions"><button class="primary" data-action="create">＋ 创建房间 <span class="arrow">↗</span></button><button class="secondary" data-action="join">⌁ 加入房间 <span class="arrow">→</span></button></div>
    <div class="stats"><div class="stat"><b>${st.total}</b><span>总局数</span></div><div class="stat"><b>${st.wins}</b><span>胜场</span></div></div>
    <div class="rules-title"><h3>游戏怎么玩</h3><span>HOW TO PLAY</span></div><div class="rules">
      <div class="rule"><span class="rule-no">01</span><div><strong>领取词语，藏住身份</strong><p>4～8 人参与，卧底会拿到与大家相近的词。</p></div></div>
      <div class="rule"><span class="rule-no">02</span><div><strong>轮流描述，寻找破绽</strong><p>每人一句话，不能直接说出自己的词语。</p></div></div>
      <div class="rule"><span class="rule-no">03</span><div><strong>投出怀疑，揭晓真相</strong><p>淘汰全部卧底即获胜。平票无人出局。</p></div></div></div>
    <footer class="home-footer">无需注册 · 和朋友即开即玩 <a href="./admin.html">词库管理 ↗</a></footer></section>`;
}
function lobby() {
  const host=room.hostId===room.self.id;
  const ready=room.players.length===room.config.capacity && room.players.every(p=>p.connected);
  const bank=banks.find(b=>b.id===room.config.wordbankId);
  return `<section><div class="room-title"><div><p>THE WAITING ROOM</p><h1>朋友到齐，就开局</h1></div><button class="ghost" data-action="leave">退出房间</button></div>
    <div class="panel"><div class="row between"><span class="muted small">房间号</span><span class="tag">等待加入</span></div><div class="room-code">${room.code}</div><div class="share-buttons"><button class="secondary" data-action="copy-code">复制房间号</button><button class="secondary" data-action="copy-link">复制邀请链接 ↗</button></div></div>
    <div class="section-head"><h3>房间里的朋友</h3><span>${room.players.length} / ${room.config.capacity} 人</span></div>
    <div class="players-list">${room.players.map(p=>`<div class="player-row">${avatar(p)}<div class="player-info"><div class="player-name">${escape(p.nickname)} ${p.id===room.self.id?'<span class="muted small">（你）</span>':''}</div><div class="small muted">${p.connected?'已就位':'连接中，等待重连…'}</div></div>${p.id===room.hostId?'<span class="tag gold">房主</span>':''}${!p.connected&&host&&p.id!==room.self.id?`<button class="ghost danger" data-action="kick" data-id="${p.id}">移除</button>`:''}</div>`).join('')}
    ${Array.from({length:Math.max(0,room.config.capacity-room.players.length)},()=>'<div class="player-row empty-slot"><div class="avatar">＋</div><span>等一位朋友加入…</span></div>').join('')}</div>
    <div class="section-head"><h3>本局设置</h3>${host?'<button class="ghost" data-action="configure">修改设置 ↗</button>':'<span>由房主设置</span>'}</div>
    <div class="panel"><div class="config-summary"><div><dt>主题词库</dt><dd>${escape(bank?.name||'当前词库')}</dd></div><div><dt>阵营分配</dt><dd>${room.config.capacity-(room.config.capacity>=7?2:1)} 平民 · ${room.config.capacity>=7?2:1} 卧底</dd></div><div><dt>轮数上限</dt><dd>${room.config.maxRounds} 轮</dd></div><div><dt>发言 / 投票时间</dt><dd>${room.config.speakSeconds}s / ${room.config.voteSeconds}s</dd></div></div></div>
    <div class="lobby-bottom">${host?`<button class="primary full" data-action="start" ${!ready?'disabled':''}>${activeRequest==='start'?'正在发放词语…':ready?'人齐了，开始游戏 →':room.players.length===room.config.capacity?'有朋友离线，等待重连…':`等待朋友就位 · ${room.players.length}/${room.config.capacity}`}</button>`:'<button class="secondary full" disabled>等待房主开始游戏…</button>'}<p>短暂断网保留位置 · 房主离线 60 秒后自动移交</p></div></section>`;
}
function chat() {
  return `<div class="chat">${room.messages.map(m=>{
    if(m.type==='system') return `<p class="system-message">${escape(m.text)}</p>`;
    const p=room.players.find(p=>p.id===m.playerId)||{id:m.playerId,nickname:m.nickname||'玩家'};
    return `<div class="chat-message ${m.playerId===room.self.id?'mine':''}">${avatar(p)}<div class="chat-content"><div class="chat-name">${escape(m.nickname)}</div><div class="chat-bubble">${escape(m.text)}</div></div></div>`;
  }).join('')}</div>`;
}
function result() {
  const r=room.result;
  if(!r)return '';
  const eliminated=room.players.find(p=>p.id===r.eliminatedId);
  return `<div class="result-panel"><h3>第 ${r.round} 轮 · 投票结果</h3><p class="small muted">${eliminated?`${escape(eliminated.nickname)} 被淘汰 · ${eliminated.role==='undercover'?'卧底':'平民'}`:r.tied?'最高票平票，本轮无人淘汰':'本轮全部弃票，无人淘汰'}</p>${Object.entries(r.counts).map(([id,n])=>`<div class="result-row"><span>${escape(room.players.find(p=>p.id===id)?.nickname||'已离开玩家')}</span><strong>${n} 票</strong></div>`).join('')}<div class="result-row"><span class="muted">弃票（含超时）</span><span>${r.abstentions} 人</span></div>${room.phase==='results'?'<p class="hint">稍后自动进入下一轮。</p>':''}</div>`;
}
function voting() {
  if(room.phase!=='voting')return '';
  const me=room.players.find(p=>p.id===room.self.id);
  if(!me.alive) return '<div class="vote-panel"><h3>朋友们正在投票</h3><p class="muted small">你已淘汰，可以继续旁观。</p></div>';
  if(room.self.hasVoted)return `<div class="vote-panel"><h3>✓ 投票已提交</h3><p class="muted small">等待其他朋友投票 · ${room.voteCount} / ${room.aliveCount}</p></div>`;
  const target=room.players.find(p=>p.id===selectedVote);
  const confirmation=selectedVote===null?'确认弃票':target?`确认投给 ${escape(target.nickname)}`:'请选择玩家或弃票';
  return `<div class="vote-panel"><h3>谁的描述最可疑？</h3><p class="muted small">已投票 ${room.voteCount} / ${room.aliveCount} · 提交后不可更改</p><div class="vote-grid">${room.players.filter(p=>p.alive&&p.id!==room.self.id).map(p=>`<button class="vote-option ${selectedVote===p.id?'selected':''}" data-action="select-vote" data-id="${p.id}" aria-pressed="${selectedVote===p.id}">${avatar(p)}<span>${escape(p.nickname)}</span><span class="vote-mark" aria-hidden="true">${selectedVote===p.id?'✓':''}</span></button>`).join('')}<button class="vote-option abstain ${selectedVote===null?'selected':''}" data-action="select-abstain" aria-pressed="${selectedVote===null}">${selectedVote===null?'✓':'○'} 本轮弃票</button></div><button class="primary full" data-action="vote" ${selectedVote===undefined?'disabled':''}>${activeRequest==='vote'?'正在提交…':confirmation}</button></div>`;
}
function finished() {
  const host=room.hostId===room.self.id;
  return `<div class="end-title"><div class="trophy">✦</div><span class="eyebrow">CASE CLOSED</span><h2>${room.winner==='civilian'?'平民获胜':'卧底获胜'}</h2><p class="muted small">${room.winner==='civilian'?'每一个线索，都没有白费。':'藏得漂亮，下局还能识破你吗？'}</p></div><div class="word-pair"><div><span>平民词</span><b>${escape(room.pair.civilian)}</b></div><div><span>卧底词</span><b>${escape(room.pair.undercover)}</b></div></div><div class="panel">${room.players.map(p=>`<div class="result-row"><span>${escape(p.nickname)} ${p.id===room.self.id?'（你）':''}<span class="muted small"> · ${p.alive?'存活':'淘汰'}</span></span><span class="tag ${p.role==='undercover'?'gold':''}">${p.role==='undercover'?'卧底':'平民'}</span></div>`).join('')}</div>${result()}<div class="end-actions">${host?'<button class="primary full" data-action="start">再来一局 →</button><button class="secondary full" data-action="back-lobby">返回大厅 · 调整设置</button>':'<p class="muted small">等待房主开启下一局，或返回大厅。</p>'}<button class="ghost" data-action="leave">退出房间</button></div>`;
}
function game() {
  const me=room.players.find(p=>p.id===room.self.id);
  const speaker=room.players.find(p=>p.id===room.speakerId);
  const mine=room.phase==='speaking'&&room.speakerId===me.id&&me.alive;
  const phase={reveal:'词语已发放 · 准备开始',speaking:mine?'轮到你描述了':`${speaker?.nickname||'玩家'} 正在发言`,voting:'投票时间 · 选出可疑的人',results:'本轮投票结果',finished:'游戏结束'}[room.phase];
  return `<section class="game-layout ${room.phase==='speaking'?'has-composer':''}"><div class="game-header"><div class="game-meta"><div><strong>房间 ${room.code}</strong><span class="muted small"> · ${room.round}/${room.config.maxRounds} 轮</span></div><button class="ghost" data-action="leave">退出</button></div><div class="phase-bar"><span class="phase-label">${escape(phase)}</span>${room.phase!=='finished'?'<span class="timer" id="timer">--</span>':'<span class="tag">已结算</span>'}</div><div class="row between alive-info"><span>${room.aliveCount} 人存活 · ${me.alive?'你仍在游戏中':'你已淘汰，正在旁观'}</span>${room.phase!=='finished'?'<button class="ghost" data-action="show-word">查看我的词 ↗</button>':''}</div><div class="player-strip">${room.players.map(p=>`<div class="mini-player ${p.id===room.speakerId&&room.phase==='speaking'?'active':''} ${!p.alive?'dead':''}" title="${escape(p.nickname)}${!p.connected?' · 离线':''}">${avatar(p)}<span>${escape(p.nickname)}${p.id===me.id?'·你':''}</span>${p.role?`<span>${p.role==='undercover'?'卧底':'平民'}</span>`:!p.connected?'<span>离线</span>':''}</div>`).join('')}</div></div>
    <div class="game-scroll" id="game-scroll">${room.phase==='finished'?finished():chat()+ (room.phase==='reveal'?'<div class="reveal-panel"><h3>嘘，先记住你的词</h3><p class="muted small">收好词语，稍后按头像顺序轮流描述。</p><button class="primary full" data-action="show-word">查看我的词语</button></div>':'')+voting()+(room.phase==='results'?result():'')}</div>
    <button id="latest-messages" class="latest-button" data-action="latest" hidden>↓ 回到最新消息</button>
    ${room.phase==='speaking'?`<div id="composer-area"><form id="describe-form" class="composer"><input id="description" name="description" aria-label="你的描述" maxlength="160" autocomplete="off" autocapitalize="off" enterkeyhint="send" placeholder="${mine?'描述你的词，别太明显…':me.alive?'等待轮到你发言…':'你已淘汰，继续观察吧'}" value="${escape(draft)}" ${!mine?'disabled':''}><button class="primary" type="submit" ${!mine||busy?'disabled':''}>${activeRequest==='describe'?'发送中…':'发送 ↑'}</button></form><div class="composer-help"><span>${mine?'每轮一句 · 发送后自动轮到下一位':'可以上滑查看朋友们的描述'}</span><span id="draft-count">${draft.length}/160</span></div></div>`:room.phase!=='finished'?'<p id="phase-footer" class="composer-caption">服务器统一计时 · 页面刷新可恢复本局</p>':''}</section>`;
}
function render() {
  const previousScroll=$('#game-scroll');
  const top=previousScroll?.scrollTop||0;
  const following=!previousScroll || previousScroll.scrollHeight-previousScroll.clientHeight-top<64;
  const step=room?`${room.gameId}:${room.round}:${room.phase}`:'';
  const changedStep=step!==renderedStep;
  const key=room?`${room.gameId}:${room.round}`:null;
  if(key!==voteKey){selectedVote=undefined;voteKey=key;}
  if(selectedVote!==undefined&&selectedVote!==null&&!room?.players.some(p=>p.id===selectedVote&&p.alive))selectedVote=undefined;
  document.body.classList.toggle('game-mode',!!room&&room.phase!=='waiting');
  updateView(app,room?(room.phase==='waiting'?lobby():game()):home());
  const scroll=$('#game-scroll');
  if(scroll){
    scroll.scrollTop=changedStep?(room.phase==='finished'?0:scroll.scrollHeight):following?scroll.scrollHeight:top;
    const latest=$('#latest-messages');
    latest.hidden=following||changedStep;
    scroll.onscroll=()=>{if(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<64)latest.hidden=true;};
  }
  renderedStep=step;
  if(room?.phase==='finished'&&lastPhase!=='finished')hideWord();
  if(room?.phase==='reveal'&&revealSeen!==room.gameId){revealSeen=room.gameId;showWord();}
  lastPhase=room?.phase;
  if(busy)app.querySelectorAll('[data-action="start"],[data-action="vote"],[data-action="select-vote"],[data-action="select-abstain"],[data-action="back-lobby"],[data-action="kick"],button[type="submit"]').forEach(b=>b.disabled=true);
  updateTimer();
}
function updateTimer() {
  const el=$('#timer'); if(!el||!room?.deadline)return;
  const now=serverAnchor.time+performance.now()-serverAnchor.monotonic;
  const seconds=Math.max(0,Math.ceil((room.deadline-now)/1000));
  el.textContent=`${seconds}s`;el.classList.toggle('urgent',seconds<=5);
  if(seconds===0&&performance.now()-lastPoll>2500){lastPoll=performance.now();refresh();}
}
function showWord() { if(room?.self.word){$('#secret-word').textContent=room.self.word;if(!$('#word-dialog').open)$('#word-dialog').showModal();} }
function hideWord() { $('#word-dialog').close();$('#secret-word').textContent=''; }
function configFields(config={capacity:4,maxRounds:5,speakSeconds:30,voteSeconds:30}) {
  return `<div class="field-grid"><div class="field"><label for="capacity">房间人数</label><select id="capacity" name="capacity">${[4,5,6,7,8].map(n=>`<option value="${n}" ${n===config.capacity?'selected':''}>${n} 人 · ${n>=7?2:1} 名卧底</option>`).join('')}</select></div><div class="field"><label for="maxRounds">最大轮次</label><input id="maxRounds" name="maxRounds" type="number" min="1" max="30" step="1" value="${config.maxRounds}" required></div></div><div class="field"><label for="wordbankId">主题词库</label><select id="wordbankId" name="wordbankId" required>${banks.map(b=>`<option value="${b.id}" ${b.id===config.wordbankId?'selected':''}>${escape(b.name)} · ${b.count} 组词</option>`).join('')}</select></div><div class="field-grid"><div class="field"><label for="speakSeconds">每人发言（秒）</label><input id="speakSeconds" name="speakSeconds" type="number" min="15" max="120" value="${config.speakSeconds}" required></div><div class="field"><label for="voteSeconds">每轮投票（秒）</label><input id="voteSeconds" name="voteSeconds" type="number" min="15" max="120" value="${config.voteSeconds}" required></div></div>`;
}
async function openForm(kind) {
  if(openingForm||$('#form-dialog').open||busy)return;
  openingForm=true;
  try{if(kind!=='join')banks=await getBanks();}catch(error){toast(error.message,true);return;}finally{openingForm=false;}
  if(kind==='configure'&&room?.phase!=='waiting')return toast('游戏已经开始，结束后再调整设置');
  const titles={create:'创建一个朋友局',join:'加入朋友的房间',configure:'本局怎么玩，你来定'};
  $('#form-content').innerHTML=`<div class="dialog-body"><div class="dialog-head"><h2>${titles[kind]}</h2><button class="close" data-action="close-form" aria-label="关闭">×</button></div><form class="stack" id="room-form" data-kind="${kind}">${kind!=='configure'?`<div class="field"><label for="nickname">你的昵称</label><input id="nickname" name="nickname" placeholder="朋友们怎么称呼你" maxlength="12" value="${escape(read('wodi-name'))}" required autocomplete="nickname"></div>`:''}${kind==='join'?`<div class="field"><label for="roomCode">6 位房间号</label><input id="roomCode" name="code" class="code-input" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" value="${escape(new URLSearchParams(location.search).get('room')?.match(/^\d{6}$/)?.[0]||'')}" placeholder="000000" required autocomplete="off"></div>`:configFields(kind==='configure'?room.config:undefined)}<p class="hint">${kind==='join'?'相同浏览器刷新可恢复身份，请不要清除浏览器数据。':'人数到齐即可开始。4～6 人 1 名卧底，7～8 人 2 名卧底。'}</p><p class="form-error" id="form-error" role="status"></p><button class="primary full" type="submit">${kind==='configure'?'保存设置':kind==='join'?'进入房间 →':'创建房间 →'}</button></form></div>`;
  $('#form-dialog').showModal();
}
async function copy(text) {
  try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);}else{const t=document.createElement('textarea');t.value=text;t.style.position='fixed';t.style.opacity='0';document.body.append(t);t.select();const success=document.execCommand('copy');t.remove();if(!success)throw Error();}toast('已复制，可以发给朋友了');}
  catch{ $('#form-content').innerHTML=`<div class="dialog-body stack"><h2>长按复制</h2><textarea readonly aria-label="需要复制的内容">${escape(text)}</textarea><button data-action="close-form">关闭</button></div>`;$('#form-dialog').showModal(); }
}
document.addEventListener('click',async event=>{
  if(event.target.closest('a.brand')&&room){event.preventDefault();showLeave();return;}
  const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
  const name=button.dataset.action;
  if(['create','join','configure'].includes(name))return openForm(name);
  if(name==='close-form')return $('#form-dialog').close();
  if(name==='hide-word')return hideWord();
  if(name==='show-word')return showWord();
  if(name==='latest'){const scroll=$('#game-scroll');scroll.scrollTop=scroll.scrollHeight;button.hidden=true;return;}
  if(name==='copy-code')return copy(room.code);
  if(name==='copy-link'){const url=new URL(location.href);url.search=`?room=${room.code}`;url.hash='';return copy(url.href);}
  if(name==='start')return run('start');
  if(name==='back-lobby')return run('lobby');
  if(name==='select-vote'){selectedVote=button.dataset.id;return render();}
  if(name==='select-abstain'){selectedVote=null;return render();}
  if(name==='vote'&&selectedVote!==undefined)return run('vote',{targetId:selectedVote});
  if(name==='kick')return run('kick',{playerId:button.dataset.id});
  if(name==='leave')return showLeave();
  if(name==='confirm-leave'){
    if(busy)return;
    button.disabled=true;button.textContent='正在退出…';
    if(await run('leave')){notice='';forget('wodi-room');$('#form-dialog').close();history.replaceState(null,'',location.pathname);render();}
    else{button.disabled=false;button.textContent='确认退出';}
  }
  if(name==='retry')location.reload();
});
function showLeave(){
  if($('#form-dialog').open||busy)return;
  $('#form-content').innerHTML=`<div class="dialog-body stack"><h2>离开${room.phase==='waiting'?'房间':'这局游戏'}？</h2><p class="muted">${room.phase==='waiting'?'退出后位置将留给其他朋友。':'游戏中退出会直接淘汰。短暂切换应用无需退出，重新打开即可继续。'}</p><button class="primary" data-action="confirm-leave">确认退出</button><button class="secondary" data-action="close-form">${room.phase==='waiting'?'留在房间':'继续游戏'}</button></div>`;
  $('#form-dialog').showModal();
}
document.addEventListener('input',event=>{
  if(event.target.id==='description'){
    draft=event.target.value;if(draftKey)write(draftKey,draft);
    const count=$('#draft-count');if(count)count.textContent=`${draft.length}/160`;
  }
  if(event.target.id==='roomCode')event.target.value=event.target.value.replace(/\D/g,'').slice(0,6);
});
document.addEventListener('compositionstart',event=>{if(event.target.id==='description'){composing=true;event.target.dataset.composing='true';}});
document.addEventListener('compositionend',event=>{
  if(event.target.id==='description'){
    composing=false;delete event.target.dataset.composing;
    draft=event.target.value;if(draftKey)write(draftKey,draft);
    const count=$('#draft-count');if(count)count.textContent=`${draft.length}/160`;
  }
});
document.addEventListener('submit',async event=>{
  event.preventDefault();
  if(event.target.id==='describe-form'){
    if(busy||composing)return;
    if(room?.phase!=='speaking'||room.speakerId!==room.self.id)return toast('还没有轮到你发言',true);
    const text=draft.trim();if(!text)return toast('先写一句描述吧',true);
    const old=draft, submittedKey=draftKey;draft='';
    if(await run('describe',{text})){if(submittedKey)forget(submittedKey);}
    else if(draftKey===submittedKey){draft=old;if(draftKey)write(draftKey,draft);render();}
    return;
  }
  if(event.target.id!=='room-form'||busy)return;
  const form=event.target, data=Object.fromEntries(new FormData(form)),kind=form.dataset.kind;
  const payload=kind==='join'?{nickname:data.nickname.trim(),code:data.code.trim()}:Object.fromEntries(['capacity','maxRounds','speakSeconds','voteSeconds','wordbankId'].map(k=>[k,k==='wordbankId'?data[k]:Number(data[k])]));
  if(kind!=='configure')write('wodi-name',data.nickname.trim());
  busy=true;epoch++;const submit=form.querySelector('[type="submit"]'),label=submit.textContent;submit.disabled=true;submit.textContent='正在处理…';
  try{accept(await action(kind==='configure'?'configure':kind,kind==='create'?{nickname:data.nickname.trim(),config:payload}:payload));$('#form-dialog').close();notice='';}
  catch(error){$('#form-error').textContent=error.message;}
  finally{busy=false;submit.disabled=false;submit.textContent=label;render();}
});
function errorPage(message) {app.innerHTML=`<section class="home stack"><h2>暂时连接不上朋友局</h2><p class="muted">${escape(message)}</p><button class="primary" data-action="retry">重新连接</button><p class="hint">请检查网络，或联系房主确认后端部署状态。</p></section>`;}
async function init(){
  try{await authenticate();banks=await getBanks();status(true,'已连接');accept(await action('sync'));
    if(!room&&/^\d{6}$/.test(new URLSearchParams(location.search).get('room')||''))await openForm('join');
  }catch(error){status(false,'连接失败');errorPage(error.message);}
}
setInterval(updateTimer,250);
setInterval(()=>{if(room&&document.visibilityState==='visible')refresh();},12000);
window.addEventListener('online',()=>{status(false,'正在重连');refresh();});
window.addEventListener('offline',()=>status(false,'已离线 · 保留身份'));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refresh();else hideWord();});
window.addEventListener('pagehide',hideWord);
$('#word-dialog').addEventListener('close',()=>{$('#secret-word').textContent='';});
supabase.auth.onAuthStateChange((event)=>{if(event==='TOKEN_REFRESHED'&&room)refresh();});
init();
