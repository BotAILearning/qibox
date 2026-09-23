import test from 'node:test';
import assert from 'node:assert/strict';
import {liveActivityBox} from '../web/ai-activity-view.mjs';
test('manual wait without a deadline does not claim a scheduled send or show NaN',()=>{
 for(const dueAt of [undefined,null,Infinity]){
  const html=liveActivityBox({live:[{id:'test',label:'测试',phase:'waiting',reason:'手动回复后不再自动接续',dueAt}]});
  assert.ok(html.includes('手动回复后不再自动接续'));assert.doesNotMatch(html,/NaN|秒后发送/);
 }
 const html=liveActivityBox({live:[{id:'test',label:'测试',phase:'waiting',dueAt:Date.now()+60000}]});
 assert.match(html,/秒后发送/);
});
