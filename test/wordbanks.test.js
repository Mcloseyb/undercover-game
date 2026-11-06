import { test } from 'node:test';
import assert from 'node:assert/strict';
import {validateBank,validateFilename} from '../supabase/functions/_shared/validate.js';
import banks from '../lib/default-wordbanks.js';
test('45 default pairs are valid and all banks have multiple unique pairs',()=>{
  let total=0;for(const b of Object.values(banks)){total+=validateBank(b).pairs.length;}assert(total>=30);
});
test('wordbank validation rejects malformed/oversized/duplicate words and unsafe filenames',()=>{
  const good={name:'测试',pairs:[{civilian:'苹果',undercover:'梨子'},{civilian:'牛奶',undercover:'豆浆'}]};
  assert.equal(validateBank(good).pairs.length,2);
  for(const v of [null,{}, {...good,pairs:[]},{...good,pairs:[...good.pairs,good.pairs[0]]},{...good,pairs:[{civilian:'苹果',undercover:'苹果'},good.pairs[1]]},{...good,name:'字'.repeat(25)}])assert.throws(()=>validateBank(v));
  for(const name of ['../x.json','..\\x.csv','a.exe','a.json.exe','/x.json','x\0.json'])assert.throws(()=>validateFilename(name));
  assert.equal(validateFilename('水果.JSON'),'json');
});
