import test from 'node:test';
import assert from 'node:assert/strict';
import { personalityPresets, personalityStyle } from '../server/ai-personality.mjs';
import { styleValue } from '../server/ai-schema.mjs';
import { saveObjectStyle } from '../server/ai-account-configuration.mjs';
import { activePersonality, newStyleDraftId } from '../web/ai-style-selector.mjs';
import { selectedStyleId } from '../server/ai-style.mjs';

test('the approved ten personalities expose74 adjective choices and preserve an explicit empty selection through validation and reload',()=>{
  assert.equal(personalityPresets.length,10);assert.equal(personalityPresets.reduce((n,p)=>n+p.traits.length,0),74);
  for(const preset of personalityPresets){assert(preset.traits.length>=7&&preset.traits.length<=8);
    const all=personalityStyle(preset.id),none=personalityStyle(preset.id,[]);assert.deepEqual(all.traits,preset.traits);assert.deepEqual(none.traits,[]);assert(none.summary.includes(preset.base));
    const profile={customStyles:[]},saved=saveObjectStyle(profile,none,'personality:'+preset.id);assert.equal(saved.styleId,'personality:'+preset.id);assert.deepEqual(styleValue(saved.style).traits,[]);assert.equal(profile.customStyles.length,0);
    assert.deepEqual(activePersonality(saved,{styleId:saved.styleId}).traits,[]);
    assert.equal(selectedStyleId(saved,saved.style,saved.styleId),saved.styleId,'resume/edit retaining the same style must retain its personality source');
  }
});
test('personality choices reject unknown/duplicate traits and mismatched descriptions without modifying existing custom styles',()=>{
  const profile={customStyles:[{id:'custom:a',style:{summary:'手动原文'}}]},before=structuredClone(profile);
  for(const value of[{personalityId:'unknown',traits:[]},{personalityId:'gentle',traits:['未知']},{personalityId:'gentle',traits:['亲切','亲切']},{...personalityStyle('gentle',[]),summary:'被改过的说明'}])assert.throws(()=>saveObjectStyle(profile,value,'personality:gentle'));
  assert.deepEqual(profile,before);
});
test('default learned and custom sources retain their independent text and traits never leak into another source',()=>{
  const profile={learnedStyle:{summary:'学到的本人表达'},customStyles:[]},defaults={summary:'默认原文'};
  assert.equal(saveObjectStyle(profile,defaults,'',defaults).styleId,'');assert.equal(saveObjectStyle(profile,profile.learnedStyle,'learned',defaults).styleId,'learned');
  assert.equal(activePersonality({style:personalityStyle('gentle',[])},{styleId:'learned'}),null);
  const saved=saveObjectStyle(profile,{summary:'自定义原文'},'new-custom',defaults);assert(saved.styleId.startsWith('custom:'));assert.equal(saved.style.summary,'自定义原文');assert(!Object.hasOwn(saved.style,'personalityId'));
});
test('retrying one unsaved custom draft reuses its stable identity rather than creating duplicate catalog entries',()=>{
  const profile={customStyles:[]},draft='draft:44444444-4444-4444-8444-444444444444';
  const first=saveObjectStyle(profile,{summary:'用户的自定义原文'},draft);const second=saveObjectStyle(profile,{summary:'用户的自定义原文'},draft);
  assert.equal(first.styleId,second.styleId);assert.equal(profile.customStyles.length,1);assert.equal(selectedStyleId(profile,second.style,second.styleId),second.styleId);
});
test('custom draft identity works with LAN HTTP crypto that has getRandomValues but no randomUUID',()=>{
 const id=newStyleDraftId({getRandomValues:bytes=>{bytes.fill(5);return bytes;}});
 assert.match(id,/^draft:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 assert.equal(saveObjectStyle({customStyles:[]},{summary:'普通自定义'},id).styleId,'custom:'+id.slice(6));
});
