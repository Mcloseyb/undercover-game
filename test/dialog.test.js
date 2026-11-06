import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// Exercise the real page/event handlers with isolated RPC responses. Server and
// Realtime permissions are covered separately by the cloud integration suite.
async function page(t) {
  const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
  const source = await fs.readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.test/undercover-game/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.setInterval = () => 0;
  let change, current = null, pendingStart;
  const client = {
    on() { return this; },
    subscribe() { return this; }
  };
  window.supabase = {
    auth: { onAuthStateChange() {} },
    removeChannel() {},
    channel() {
      client.on = (_event, _filter, callback) => { change = callback; return client; };
      return client;
    }
  };
  window.authenticate = async () => ({});
  window.getBanks = async () => [{ id: 'daily', name: '日常生活', count: 15 }];
  window.action = async name => {
    if (name === 'create' || name === 'join') current = state('waiting');
    if (name === 'start') {
      current = state('reveal');
      if (pendingStart) return pendingStart.promise;
    }
    return current;
  };
  vm.runInContext(source.replace(/^import .*;\r?\n/, ''), dom.getInternalVMContext());
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  const find = selector => window.document.querySelector(selector);
  return {
    window, find, flush,
    async enter(kind) {
      find(`[data-action="${kind}"]`).click();
      await flush();
      find('#nickname').value = '测试玩家';
      if (kind === 'join') find('#roomCode').value = '123456';
      find('#room-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    },
    async receive(phase) { current = state(phase); await change(); await flush(); },
    delayStart() {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      pendingStart = { promise };
      return () => resolve(current);
    }
  };
}

function state(phase) {
  return {
    id: 'room-one', code: '123456', hostId: 'me', revision: phase === 'waiting' ? 1 : phase === 'reveal' ? 2 : 3,
    gameId: 'game-one', phase, round: 1, serverTime: Date.now(), deadline: Date.now() + 30000,
    config: { capacity: 4, maxRounds: 5, speakSeconds: 30, voteSeconds: 30, wordbankId: 'daily' },
    self: { id: 'me', word: phase === 'waiting' ? null : '测试词语', hasVoted: false },
    players: ['me', 'friend-one', 'friend-two', 'friend-three'].map(id => ({ id, nickname: id, connected: true, alive: true })),
    messages: [], speakerId: phase === 'speaking' ? 'me' : null, aliveCount: 4, voteCount: 0, result: null
  };
}

test('joining friends can dismiss their word and continue without reloading', async t => {
  const ui = await page(t);
  await ui.enter('join');
  await ui.receive('reveal');
  assert.equal(ui.find('#word-dialog').open, true);
  assert.equal(ui.find('#secret-word').textContent, '测试词语');
  const remember = ui.find('[data-action="hide-word"]');
  assert.equal(remember.disabled, false, 'the persistent dialog must not inherit a request lock');
  remember.click();
  assert.equal(ui.find('#word-dialog').open, false);
  assert.equal(ui.find('#secret-word').textContent, '');
  await ui.receive('speaking');
  assert.equal(ui.find('#description').disabled, false);
  ui.find('[data-action="show-word"]').click();
  assert.equal(ui.find('#word-dialog').open, true);
  remember.click();
  assert.equal(ui.find('#word-dialog').open, false);
});

test('the remember button remains usable while the start response is pending', async t => {
  const ui = await page(t);
  await ui.enter('create');
  const finishStart = ui.delayStart();
  ui.find('[data-action="start"]').click();
  await ui.receive('reveal');
  assert.equal(ui.find('#word-dialog').open, true);
  const remember = ui.find('[data-action="hide-word"]');
  assert.equal(remember.disabled, false, 'closing a word needs no server response');
  remember.click();
  assert.equal(ui.find('#word-dialog').open, false);
  finishStart();
  await ui.flush();
  assert.equal(ui.find('#word-dialog').open, false, 'a repeated snapshot must not reopen the dismissed word');
});
