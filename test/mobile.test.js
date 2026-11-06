import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { page, state } from './helpers/page.js';

const submit = ui => ui.find('#describe-form').dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));
const input = (ui,text) => { const el=ui.find('#description');el.value=text;el.dispatchEvent(new ui.window.Event('input',{bubbles:true}));return el; };

test('game and admin pages request fixed touch scale',async()=>{
  for(const name of ['index.html','admin.html']){
    const dom=new JSDOM(await fs.readFile(new URL(`../${name}`,import.meta.url),'utf8'));
    const viewport=dom.window.document.querySelector('meta[name="viewport"]').content;
    for(const setting of ['initial-scale=1','minimum-scale=1','maximum-scale=1','user-scalable=no'])assert(viewport.includes(setting),`${name}: ${setting}`);
    dom.window.close();
  }
});

test('pinch gestures are blocked while one-finger scrolling stays available',async t=>{
  const ui=await page(t);
  for(const [fingers,expected] of [[1,false],[2,true]]){
    const event=new ui.window.Event('touchmove',{bubbles:true,cancelable:true});
    Object.defineProperty(event,'touches',{value:Array(fingers).fill({})});
    ui.window.document.dispatchEvent(event);assert.equal(event.defaultPrevented,expected);
  }
  const gesture=new ui.window.Event('gesturestart',{cancelable:true});
  ui.window.document.dispatchEvent(gesture);assert.equal(gesture.defaultPrevented,true);
});

test('keyboard height is tracked even when the layout viewport also shrinks',async t=>{
  let viewport;
  const ui=await page(t,{initialState:state('speaking'),beforeLoad(window){
    Object.defineProperty(window,'innerHeight',{value:844,writable:true});
    Object.defineProperty(window,'innerWidth',{value:390,writable:true});
    viewport=new window.EventTarget();viewport.height=844;
    Object.defineProperty(window,'visualViewport',{value:viewport});
  }});
  ui.find('#description').focus();
  viewport.height=410;ui.window.innerHeight=410;viewport.dispatchEvent(new ui.window.Event('resize'));
  assert.equal(ui.window.document.documentElement.style.getPropertyValue('--viewport-height'),'410px');
  assert(ui.window.document.body.classList.contains('keyboard-open'));
  viewport.height=844;ui.window.innerHeight=844;viewport.dispatchEvent(new ui.window.Event('resize'));
  assert(!ui.window.document.body.classList.contains('keyboard-open'));
});

test('live updates preserve the input node, keyboard focus, selection and draft',async t=>{
  const ui=await page(t,{initialState:state('speaking')});
  const el=input(ui,'还没写完的描述');el.focus();el.setSelectionRange(2,4);
  const scroller=ui.find('#game-scroll');
  await ui.receive('speaking',{messages:[{id:1,type:'system',text:'一位朋友重新连接'}]});
  assert.equal(ui.find('#description'),el);assert.equal(ui.find('#game-scroll'),scroller);
  assert.equal(ui.window.document.activeElement,el);assert.equal(el.value,'还没写完的描述');
  assert.equal(el.selectionStart,2);assert.equal(el.selectionEnd,4);
  assert.equal(ui.find('#draft-count').textContent,'7/160');
});

test('drafts survive reopening the page and are cleared for the next round',async t=>{
  const first=await page(t,{initialState:state('speaking')});input(first,'刷新后仍保留');
  const storage=Object.fromEntries(Object.entries(first.window.localStorage));
  const reopened=await page(t,{initialState:state('speaking'),storage});
  assert.equal(reopened.find('#description').value,'刷新后仍保留');
  await reopened.receive('speaking',{round:2});
  assert.equal(reopened.find('#description').value,'');
  assert.equal(reopened.window.localStorage.getItem('wodi-draft:room-one:game-one:1:me'),null);
});

test('IME text is not reset or sent early; double submit sends once and failures restore the draft',async t=>{
  const ui=await page(t,{initialState:state('speaking')});
  const el=ui.find('#description');el.focus();
  el.dispatchEvent(new ui.window.CompositionEvent('compositionstart',{bubbles:true}));el.value='zhong';
  await ui.receive('speaking',{messages:[{id:1,type:'system',text:'连接恢复'}]});
  assert.equal(el.value,'zhong');submit(ui);await ui.flush();
  assert.equal(ui.calls.filter(c=>c.name==='describe').length,0);
  el.value='中文描述';el.dispatchEvent(new ui.window.CompositionEvent('compositionend',{bubbles:true}));
  const pending=ui.deferAction('describe');submit(ui);submit(ui);await ui.flush();
  assert.equal(ui.calls.filter(c=>c.name==='describe').length,1);
  pending.reject(Error('网络暂时中断'));await ui.flush();
  assert.equal(ui.find('#description').value,'中文描述');
  assert.equal(ui.window.localStorage.getItem('wodi-draft:room-one:game-one:1:me'),'中文描述');
});

test('reading history keeps the scroll position and exposes a return-to-latest action',async t=>{
  const ui=await page(t,{initialState:state('speaking')});
  const scroller=ui.find('#game-scroll');
  Object.defineProperties(scroller,{scrollHeight:{get:()=>1000},clientHeight:{get:()=>300}});
  scroller.scrollTop=100;
  await ui.receive('speaking',{messages:[{id:1,type:'player',playerId:'friend-one',nickname:'朋友',text:'一条新描述'}]});
  assert.equal(ui.find('#game-scroll'),scroller);assert.equal(scroller.scrollTop,100);
  assert.equal(ui.find('#latest-messages').hidden,false);
  ui.find('#latest-messages').click();assert(scroller.scrollTop>=700);
  assert.equal(ui.find('#latest-messages').hidden,true);
});

test('vote selection names the target, clears an eliminated choice and submits abstention once',async t=>{
  const ui=await page(t,{initialState:state('voting')});
  assert.equal(ui.find('[data-action="select-vote"][data-id="me"]'),null);
  ui.find('[data-action="select-vote"][data-id="friend-one"]').click();
  assert.equal(ui.find('[data-action="vote"]').textContent,'确认投给 friend-one');
  assert.equal(ui.calls.filter(c=>c.name==='vote').length,0);
  const players=ui.current.players.map(p=>p.id==='friend-one'?{...p,alive:false}:p);
  await ui.receive('voting',{players,aliveCount:3});
  assert.equal(ui.find('[data-action="vote"]').disabled,true);
  ui.find('[data-action="select-abstain"]').click();
  assert.equal(ui.find('[data-action="vote"]').textContent,'确认弃票');
  const pending=ui.deferAction('vote');ui.find('[data-action="vote"]').click();ui.find('[data-action="vote"]').click();
  assert.equal(ui.calls.filter(c=>c.name==='vote').length,1);
  assert.equal(ui.calls.find(c=>c.name==='vote').payload.targetId,null);
  pending.resolve({...ui.current,self:{...ui.current.self,hasVoted:true},revision:10});await ui.flush();
  assert(ui.find('.vote-panel').textContent.includes('投票已提交'));
});

test('switching away hides and clears a word without leaving the room',async t=>{
  const ui=await page(t,{initialState:state('speaking')});
  ui.find('[data-action="show-word"]').click();assert.equal(ui.find('#word-dialog').open,true);
  Object.defineProperty(ui.window.document,'visibilityState',{value:'hidden',configurable:true});
  ui.window.document.dispatchEvent(new ui.window.Event('visibilitychange'));
  assert.equal(ui.find('#word-dialog').open,false);assert.equal(ui.find('#secret-word').textContent,'');
  assert.equal(ui.calls.filter(c=>c.name==='leave').length,0);
});

test('a tap on the brand asks before leaving an active room',async t=>{
  const ui=await page(t,{initialState:state('speaking')});
  ui.find('a.brand').click();assert.equal(ui.find('#form-dialog').open,true);
  assert.equal(ui.calls.filter(c=>c.name==='leave').length,0);
  ui.find('[data-action="close-form"]').click();assert.equal(ui.find('#form-dialog').open,false);
  assert(ui.find('#description'));
});

test('joining opens immediately without fetching the bank list again',async t=>{
  let requests=0;
  const ui=await page(t,{getBanks:async()=>{requests++;return [{id:'daily',name:'日常生活',count:15}];}});
  assert.equal(requests,1);ui.find('[data-action="join"]').click();await ui.flush();
  assert.equal(ui.find('#form-dialog').open,true);assert.equal(requests,1);
  const field=ui.find('#roomCode');field.value='12 34 56';field.dispatchEvent(new ui.window.Event('input',{bubbles:true}));
  assert.equal(field.value,'123456');
});
