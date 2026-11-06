import fs from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// Execute the real HTML and frontend handlers, with isolated RPC responses.
// Real multiplayer/permissions are tested separately against Supabase.
export async function page(t, options = {}) {
  const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.test/undercover-game/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () {
    if (this.open) { this.open = false; this.dispatchEvent(new window.Event('close')); }
  };
  window.setInterval = () => 0;
  for (const [key,value] of Object.entries(options.storage || {})) window.localStorage.setItem(key, value);
  options.beforeLoad?.(window);
  let change, current = options.initialState || null, revision = current?.revision || 0;
  const pending = new Map(), calls = [];
  const client = { on() { return this; }, subscribe() { return this; } };
  window.supabase = {
    auth: { onAuthStateChange() {} }, removeChannel() {},
    channel() { client.on = (_event,_filter,callback) => { change=callback; return client; }; return client; }
  };
  window.authenticate = async () => ({});
  window.getBanks = options.getBanks || (async () => [{ id: 'daily', name: '日常生活', count: 15 }]);
  window.action = async (name, payload) => {
    calls.push({name,payload});
    if (name==='create' || name==='join') current=state('waiting',{revision:++revision});
    if (name==='start') current=state('reveal',{revision:++revision});
    if (pending.has(name)) return pending.get(name).promise;
    if (name==='describe') current={...current,speakerId:'friend-one',revision:++revision};
    if (name==='vote') current={...current,self:{...current.self,hasVoted:true},revision:++revision};
    if (name==='leave') current=null;
    return current;
  };
  for (const file of ['mobile.js','view.js','app.js']) {
    const source=await fs.readFile(new URL(`../../src/${file}`,import.meta.url),'utf8');
    vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,''),dom.getInternalVMContext());
  }
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  const find = selector => window.document.querySelector(selector);
  function deferAction(name) {
    let resolve, reject;
    const promise = new Promise((done, fail) => {resolve=done;reject=fail;});
    pending.set(name,{promise});
    return {
      resolve(value=current) { pending.delete(name); resolve(value); },
      reject(error) { pending.delete(name); reject(error); }
    };
  }
  return {
    window,find,flush,calls,deferAction,
    get current(){return current;},
    async enter(kind) {
      find(`[data-action="${kind}"]`).click(); await flush();
      find('#nickname').value='测试玩家';
      if(kind==='join')find('#roomCode').value='123456';
      find('#room-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await flush();
    },
    async receive(phase, overrides={}) {
      current=state(phase,{revision:++revision,...overrides});await change();await flush();
    },
    delayStart() { const deferred=deferAction('start'); return () => deferred.resolve(); }
  };
}

export function state(phase, overrides={}) {
  return {
    id:'room-one',code:'123456',hostId:'me',revision:1,gameId:'game-one',phase,round:1,
    serverTime:Date.now(),deadline:Date.now()+30000,
    config:{capacity:4,maxRounds:5,speakSeconds:30,voteSeconds:30,wordbankId:'daily'},
    self:{id:'me',word:phase==='waiting'?null:'测试词语',hasVoted:false},
    players:['me','friend-one','friend-two','friend-three'].map(id=>({id,nickname:id,connected:true,alive:true})),
    messages:[],speakerId:phase==='speaking'?'me':null,aliveCount:4,voteCount:0,result:null,
    ...overrides
  };
}
