import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {unsupportedProcessState} from '../server/ai-process-facts.mjs';

const now=Date.parse('2026-10-22T18:00:00+08:00'),ts=Math.floor(now/1000),key=x=>createHash('sha256').update(x).digest('hex');
const A={role:'group_member',id:'member:'+key('A'),identified:true},B={role:'group_member',id:'member:'+key('B'),identified:true};
const incoming='东西已经退了，钱还没到账，客服说需要三天。我不急，只是怕你把“退款到账”和“申请成功”当成一回事。';
const actual117='明白，退款申请成功不等于钱已经到账。现在就是还在等银行处理，不是已经退到你账上了，对吧？';
const other=(text,extra={})=>({id:key(text+JSON.stringify(extra)),direction:'other',text,timestamp:ts-60,...extra});
const human=(text,extra={})=>({id:key(text+JSON.stringify(extra)),direction:'self',authorship:'human',aiGenerated:false,text,timestamp:ts-60,...extra});
const context=(extra={})=>{const row=other(incoming);return{now,kind:'person',messages:[row],pendingMessages:[row],facts:'',...extra};};
const check=(text,c={})=>unsupportedProcessState([text],context(c));

test('actual019 request117 cannot invent a bank handling stage before a confirmation tag',()=>{
  assert.equal(check(actual117),'process-fact');
  for(const text of ['现在就是还在等银行处理，对吧？','现在就是还在等银行处理对吧？','目前是平台正在审核退款。','你的退款还在银行处理中。','你的退款还在银行处理中对吗？','现在还在审核中。','嗯，还在等支付平台清算，之后怎么办？'])assert.equal(check(text),'process-fact',text);
});

test('ordinary work and material processing is outside this finite business-stage check',()=>{
  for(const text of ['这段代码还在处理中。','我现在在处理工作。','我现在在处理材料。','文件现在还在处理中。']) {
    assert.equal(check(text),'',text);
    assert.equal(check(text,{messages:[],pendingMessages:[]}), '',text);
  }
  assert.equal(check('现在还在审核中。'),'process-fact');
  assert.equal(check('现在银行正在处理。',{messages:[],pendingMessages:[]}),'process-fact');
});

test('institutionless processing requires a real business-topic context rather than an ordinary-word allowlist',()=>{
  for(const text of ['我在处理家里的事。','照片还在处理中。','事情还在处理中。','现在还在处理中。','现在还在审核中。']) {
    assert.equal(check(text,{messages:[],pendingMessages:[]}), '',text);
    const ordinary=other('家里有点事，我先处理一下。');
    assert.equal(check(text,{messages:[ordinary],pendingMessages:[ordinary]}), '',text);
  }
  assert.equal(check('现在还在处理中。'),'process-fact');
  assert.equal(check('现在还在审核中。'),'process-fact');
  assert.equal(check('现在银行正在处理。',{messages:[],pendingMessages:[]}),'process-fact');
});

test('the existing viewer timezone controls the same-day source boundary',()=>{
  const row=other('我的退款现在还在等银行处理。',{timestamp:Date.parse('2026-10-22T06:00:00+08:00')/1000});
  assert.equal(check('你的退款现在还在等银行处理。',{messages:[row],pendingMessages:[row]}),'');
  assert.equal(check('你的退款现在还在等银行处理。',{messages:[row],pendingMessages:[row],timezone:'America/Los_Angeles'}),'process-fact');
});

test('genuine questions, conditions, denials, quotations and ordinary process knowledge stay usable',()=>{
  for(const text of ['是在等银行处理吗？','银行正在处理退款？','是不是还在等银行处理？','是在等银行处理还是平台审核？','如果是在等银行处理，就再确认一下。','还在等银行处理的话，可以先问客服。','不是在等银行处理。','并非平台正在审核退款。','不能说现在是在等银行处理。','不知道是否还在等银行处理。','你说“还在等银行处理”，这个说法需要确认。','“银行正在处理退款”只是举例。','退款有时需要银行处理。','一般银行处理退款需要几天。','银行处理退款通常需要时间。','可以等银行处理后再确认。','申请成功不等于退款到账。','目前只知道款项还没到账，处理机构和阶段都没确认。'])assert.equal(check(text),'',text);
  assert.equal(check('如果资料齐了就可以问客服；现在就是还在等银行处理，对吧？'),'process-fact');
});

test('an explicit fresh same-actor same-topic source supports its literal institution and phase',()=>{
  const row=other('我的退款现在还在等银行处理。');
  assert.equal(check('你的退款现在还在等银行处理。',{messages:[row],pendingMessages:[row]}),'');
  assert.equal(check('现在还在处理中。',{messages:[other('我的退款现在银行正在处理。')],pendingMessages:[other('我的退款现在银行正在处理。')]}),'');
  assert.equal(check('现在就是还在等银行处理，对吧？',{facts:'对方这笔退款现在还在等银行处理。'}),'');
  assert.equal(check('我的退款现在还在等银行处理。',{messages:[human('我的退款现在还在等银行处理。')],facts:''}),'');
  assert.equal(check('你的退款现在还在等银行处理。',{messages:[human('你的退款现在还在等银行处理。')],pendingMessages:[]}),'');
});

test('old, future, generated, unresolved, negated, questioned or generic source cannot ground a current phase',()=>{
  for(const row of [other('我的退款现在还在等银行处理。',{timestamp:ts-172800}),other('我的退款现在还在等银行处理。',{timestamp:ts+60}),other('我的退款现在还在等银行处理。',{aiGenerated:true}),other('我的退款现在还在等银行处理。',{unresolved:true}),other('我的退款不是在等银行处理。'),other('我的退款是在等银行处理吗？'),other('银行一般会处理退款。'),other('我的退款提到了银行，但没说处理阶段。'),other('“我的退款还在等银行处理”是举例。'),other('明天我的退款会由银行处理。')])assert.equal(check(actual117,{messages:[row],pendingMessages:[row]}),'process-fact',JSON.stringify(row));
  const yesterday=Date.parse('2026-10-21T23:00:00+08:00')/1000;
  assert.equal(check(actual117,{messages:[other('我今天的退款还在等银行处理。',{timestamp:yesterday})],pendingMessages:[]}),'process-fact');
});

test('fresh corrections override an earlier current phase and a supplied phase fact',()=>{
  const old=other('我的退款现在还在等银行处理。',{timestamp:ts-120}),updated=other('我的退款不是银行处理了，现在已经到账。');
  assert.equal(check(actual117,{messages:[old,updated],pendingMessages:[updated]}),'process-fact');
  assert.equal(check(actual117,{messages:[updated],pendingMessages:[updated],facts:'对方的退款现在还在等银行处理。'}),'process-fact');
  assert.equal(check('现在平台正在审核退款。',{messages:[other('我的退款尚未进入平台审核。')],pendingMessages:[other('我的退款尚未进入平台审核。')]}),'process-fact');
});

test('a missing institution or a different business item does not authorize adding a bank stage',()=>{
  for(const row of [other('我的退款现在还在处理中。'),other('我的贷款现在还在等银行处理。'),other('银行名称已经确认，我的退款还没到账。'),other('我现在还在等平台审核退款。'),human('我的退款现在还在等银行处理。')])assert.equal(check(actual117,{messages:[row]}),'process-fact',row.text);
  assert.equal(check(actual117,{facts:'我的退款现在还在等银行处理。'}),'process-fact');
  assert.equal(check(actual117,{facts:'对方贷款现在还在等银行处理。'}),'process-fact');
});

test('group stages keep actor identity and do not borrow a different member source',()=>{
  const ask=other('我的退款还没到账。',{speaker:A,senderName:'甲'}),wrong=other('我的退款现在还在等银行处理。',{speaker:B,senderName:'乙'}),right=other('我的退款现在还在等银行处理。',{speaker:A,senderName:'甲'});
  assert.equal(check('你的退款现在还在等银行处理。',{kind:'group',messages:[wrong,ask],pendingMessages:[ask]}),'process-fact');
  assert.equal(check('你的退款现在还在等银行处理。',{kind:'group',messages:[right],pendingMessages:[right]}),'');
  assert.equal(check('甲的退款现在还在等银行处理。',{kind:'group',messages:[right,wrong],pendingMessages:[right,wrong]}),'');
  assert.equal(check('甲的退款现在还在等银行处理。',{kind:'group',messages:[wrong,ask],pendingMessages:[ask]}),'process-fact');
});

test('an ambiguous group display name cannot fall back to the pending member identity',()=>{
  const a=other('我的退款现在平台正在审核。',{speaker:A,senderName:'甲'}), b=other('我的退款现在还在等银行处理。',{speaker:B,senderName:'甲'});
  assert.equal(check('甲的退款现在还在等银行处理。',{kind:'group',messages:[a,b],pendingMessages:[b]}),'process-fact');
});
test('a different business-item completion does not terminate the supported refund stage',()=>{
  const row=other('我的退款现在还在等银行处理，我的贷款已经到账。');
  assert.equal(check('你的退款现在还在等银行处理。',{messages:[row],pendingMessages:[row]}),'');
});
test('an unrelated upload completion does not terminate the supported refund stage',()=>{
  const row=other('我的退款现在还在等银行处理，我已完成资料上传。');
  assert.equal(check('你的退款现在还在等银行处理。',{messages:[row],pendingMessages:[row]}),'');
});
test('a human source keeps each clause actor instead of borrowing the first clause owner',()=>{
  const row=human('我的退款已经到账，你的退款现在还在等银行处理。');
  assert.equal(check('你的退款现在还在等银行处理。',{messages:[row]}),'');
});
test('a same-actor same-item continuation can still terminate or replace its earlier stage',()=>{
  const done=other('我的退款现在还在等银行处理，现在已经到账。');
  assert.equal(check('你的退款现在还在等银行处理。',{messages:[done],pendingMessages:[done],facts:'对方的退款现在还在等银行处理。'}),'process-fact');
  const changed=other('我的退款现在还在等银行处理，我的退款现在平台正在审核。');
  assert.equal(check('你的退款现在还在等银行处理。',{messages:[changed],pendingMessages:[changed],facts:'对方的退款现在还在等银行处理。'}),'process-fact');
});
test('a genuine question keeps its scope when followed by a separate acknowledgement',()=>{
  const row=other('我的退款还没到账。');
  const ctx=context({messages:[row],pendingMessages:[row]});
  assert.equal(unsupportedProcessState(['是在等银行处理吗？明白。'],ctx),'');
  assert.equal(unsupportedProcessState(['是在等银行处理吗？','明白。'],ctx),'');
});
test('a conditional question cannot exempt a later independent current-stage assertion',()=>{
  const row=other('我的退款还没到账。');
  const ctx=context({messages:[row],pendingMessages:[row]});
  assert.equal(unsupportedProcessState(['如果是银行在处理呢？目前就是银行正在处理。'],ctx),'process-fact');
  assert.equal(unsupportedProcessState(['如果是银行在处理呢？','目前就是银行正在处理。'],ctx),'process-fact');
});
test('an explicitly named unresolved business owner cannot borrow the pending member source',()=>{
  const a=other('我的退款现在还在等银行处理。',{speaker:A,senderName:'甲'}), b=other('我的退款还没到账。',{speaker:B,senderName:'乙'});
  const ctx=context({kind:'group',messages:[a,b],pendingMessages:[a]});
  assert.equal(unsupportedProcessState(['丙的退款现在还在等银行处理。'],ctx),'process-fact');
  for(const text of ['甲的退款现在还在等银行处理。','你的退款现在还在等银行处理。','现在还在等银行处理。','目前还在等银行处理。'])assert.equal(unsupportedProcessState([text],ctx),'',text);
  const own=human('我的退款现在还在等银行处理。');
  assert.equal(check('我的退款现在还在等银行处理。',{messages:[own],pendingMessages:[]}), '');
  assert.equal(check('本人的退款现在还在等银行处理。',{messages:[own],pendingMessages:[]}), '');
});
test('display-name lookup uses complete business owners instead of prefix lookalikes',()=>{
  const a=other('我的退款现在还在等银行处理。',{speaker:A,senderName:'甲'});
  const ctx=context({kind:'group',messages:[a],pendingMessages:[a]});
  for(const text of ['甲丙的退款现在还在等银行处理。','甲乙的退款现在还在等银行处理。','甲丙退款现在还在等银行处理。','这个尚未建立身份映射的二十一字以上未知测试成员的退款现在还在等银行处理。'])assert.equal(unsupportedProcessState([text],ctx),'process-fact',text);
  for(const text of ['甲的退款现在还在等银行处理。','甲退款现在还在等银行处理。','现在甲的退款还在等银行处理。'])assert.equal(unsupportedProcessState([text],ctx),'',text);
  const short=other('我的退款现在平台正在审核。',{speaker:A,senderName:'张三'}),long=other('我的退款现在还在等银行处理。',{speaker:B,senderName:'张三丰'});
  const both=context({kind:'group',messages:[short,long],pendingMessages:[short,long]});
  assert.equal(unsupportedProcessState(['张三丰的退款现在还在等银行处理。'],both),'');
  assert.equal(unsupportedProcessState(['张三的退款现在还在等银行处理。'],both),'process-fact');
  assert.equal(unsupportedProcessState(['张三的退款现在平台正在审核。'],both),'');
});
