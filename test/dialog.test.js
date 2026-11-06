import { test } from 'node:test';
import assert from 'node:assert/strict';
import { page } from './helpers/page.js';

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
