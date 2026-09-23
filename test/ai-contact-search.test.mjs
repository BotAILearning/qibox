import test from 'node:test';
import assert from 'node:assert/strict';
import {contactSearch} from '../web/ai-contact-name.mjs';
test('contact search uses visible names and nicknames, never opaque storage identifiers',()=>{
 assert.equal(contactSearch({label:'李四',nickname:'小李',id:'abc33def'}).includes('33'),false);
 assert.equal(contactSearch({label:'33',nickname:'黄三岁'}).includes('33'),true);
 assert.equal(contactSearch({label:'ＦＯＯ'},{nickname:'BAR'}).includes('foo'),true);
 assert.equal(contactSearch({},{label:'33',nickname:'BAR'}).includes('33'),true);
});
