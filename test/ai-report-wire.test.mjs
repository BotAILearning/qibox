import test from 'node:test';
import assert from 'node:assert/strict';
import { compactReportInput } from '../server/ai-model-input.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { analysisPrompt } from '../server/ai-analysis.mjs';
import { analysisSourcePrompt } from '../server/ai-analysis-source.mjs';
import { modelConfig } from './ai-fixtures.mjs';

const source = () => ({
  userRequest: '按时间顺序概括，保留否定、更正和引用', request: '按时间顺序概括，保留否定、更正和引用',
  contact: '测试联系人', timezone: 'Asia/Shanghai', from: '2026-10-25', to: '2026-10-25',
  analyzedCount: 3, coverage: { truncated: false, analyzedChars: 70 }, metrics: { self: 1, other: 1, unknown: 1 },
  messages: [
    { sequence: 1, speaker: '本人', beijingTime: '2026-10-25 00:00:00', text: '昨天交了申请，还没查账。原话🙂\n我姐说的不是她自己的款。', secondsSincePrevious: null },
    { sequence: 2, speaker: '对方', beijingTime: '2026-10-25 00:00:00', text: '那是小陈妈妈的，不是我的；“我付了”是引用。', secondsSincePrevious: 0 },
    { sequence: 3, speaker: '未知', beijingTime: '2026-10-25 00:01:36', text: '字面保留 self、other、s：及 qref1，不冒充已知作者。', secondsSincePrevious: 96 },
  ],
});

test('row provenance never invents a human source or reinterprets malformed/future metadata', () => {
  const input=source();
  for(const sourceIndex of [{},{generated:[0]},{unknown:[4]},{generated:'1'},{quotes:[{sequence:2,verified:true,sourceSequence:9}]},
    {quotes:[{sequence:2,verified:false},{sequence:2,verified:true}]},{quotes:[{sequence:2,verified:true,sourceReadable:true}]},
    {quotes:[{sequence:2,verified:true,futureScope:'do-not-ignore'}]},{futureOrigin:['keep']}]) {
    const before=structuredClone({...input,sourceIndex}),wire=compactReportInput(before);
    assert(!wire.messageColumns.includes('origin'));assert.deepEqual(restore(wire),input.messages);
    assert.deepEqual(wire.sourceIndex,sourceIndex);assert.deepEqual(before,{...input,sourceIndex});
  }
  const wire=compactReportInput({...input,sourceIndex:{generated:[1],unknown:[1],quotes:[{sequence:2,verified:false}]}});
  assert.deepEqual(wire.messages.map(row=>row[2]),[{authorship:'来源未核实'},{quote:{verified:false}},null]);
});

for(const protocol of ['anthropic','openai']) test(`${protocol}: known provenance travels beside its own original text in one report call`,async()=>{
  const input={...source(),sourceIndex:{generated:[1],unknown:[3],quotes:[{sequence:2,verified:true,speaker:'本人',sourceSequence:1}]}},before=structuredClone(input),requests=[];
  const provider=new AIProvider({fetcher:async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);assert.equal(body.max_tokens,4096);
    const wire=JSON.parse(body.messages.find(m=>m.role==='user').content),rows=restore(wire);
    assert.deepEqual(rows.map(({origin,...row})=>row),input.messages);
    assert.deepEqual(rows.map(row=>row.origin),[{authorship:'已知AI代发'},{quote:{verified:true,speaker:'本人',sourceSequence:1}},{authorship:'来源未核实'}]);
    assert.deepEqual(wire.sourceIndex,input.sourceIndex);assert.match(protocol==='anthropic'?body.system:body.messages.find(m=>m.role==='system').content,/origin与同一行speaker和text直接绑定/);
    const text=JSON.stringify({report:'账号侧记录不提升为本人确认经历。'});
    return Response.json(protocol==='anthropic'?{content:[{type:'text',text}]}:{choices:[{message:{content:text}}]});
  }});
  await provider.complete({...modelConfig,protocol},analysisPrompt(input.userRequest)+analysisSourcePrompt,input,undefined,{format:'report',budget:4096});
  assert.equal(requests.length,1);assert.deepEqual(input,before);
});
const restore = input => {
  return input.messages.map(row => Object.fromEntries(input.messageColumns.map((name, i) => [name, row[i]])));
};

test('report wire is lossless across author, equal timestamps, relative dates, quotes and original text', () => {
  const input = source(), before = structuredClone(input), wire = compactReportInput(input);
  assert.deepEqual(wire.messageColumns, ['sequence', 'speaker', 'beijingTime', 'text', 'secondsSincePrevious']);
  assert.deepEqual(restore(wire), input.messages); assert.deepEqual(input, before);
  assert.deepEqual(wire.messages.map(row => row[1]), ['本人', '对方', '未知']);
  assert.equal(Object.hasOwn(wire, 'participants'), false);
  assert.deepEqual(Object.keys(wire).slice(-2), ['messages', 'writeReport']);
  assert.match(wire.writeReport, /要求逐条、保留原文或其他篇幅时完整遵守/);
  assert.deepEqual(wire.coverage, input.coverage); assert.deepEqual(wire.metrics, input.metrics);
  assert.equal(wire.userRequest, input.userRequest); assert.equal(Object.hasOwn(wire, 'request'), false);
  const distinct = { ...input, request: '保留一份不同的兼容请求' };
  assert.equal(compactReportInput(distinct).request, distinct.request);
});

test('unrecognized report metadata or author shape stays inline without losing facts or reassigning identity', () => {
  const original = source();
  for (const changed of [
    { ...original, participants: [{ id: 'custom', reportName: '已有角色定义' }] },
    { ...original, messageColumns: ['已有协议'] },
    { ...original, writeReport: '已有调用方的任务元数据' },
    { ...original, messages: original.messages.map((m, i) => i ? m : { ...m, quote: { text: '有独立引用身份' } }) },
    { ...original, messages: original.messages.map((m, i) => i ? m : { ...m, speaker: { role: 'self', id: 'private-author' } }) },
    { ...original, messages: original.messages.map((m, i) => i ? m : { ...m, speaker: '未登记来源' }) },
    { ...original, messages: original.messages.map((m, i) => i ? m : { ...m, secondsSincePrevious: undefined }) },
    { ...original, messages: [] },
  ]) {
    const before = structuredClone(changed); assert.deepEqual(compactReportInput(changed), before); assert.deepEqual(changed, before);
  }
});

for (const protocol of ['anthropic', 'openai']) test(`${protocol}: production report call sends one compact lossless transcript and keeps its original budget`, async () => {
  const input = source(), before = structuredClone(input), requests = [];
  const provider = new AIProvider({ fetcher: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    assert.equal(body.max_tokens, 4096); assert.equal(body.thinking, undefined);
    const wire = JSON.parse(body.messages.find(m => m.role === 'user').content);
    assert.deepEqual(restore(wire), before.messages); assert.equal(wire.analyzedCount, 3);
    const text = JSON.stringify({ report: '保留各自原话，实际退款结果未核实。' });
    return Response.json(protocol === 'anthropic' ? { content: [{ type: 'text', text }] } : { choices: [{ message: { content: text } }] });
  } });
  const result = await provider.complete({ ...modelConfig, baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3', protocol }, analysisPrompt(input.userRequest), input, undefined, { format: 'report', budget: 4096 });
  assert.equal(result.report, '保留各自原话，实际退款结果未核实。'); assert.equal(requests.length, 1); assert.deepEqual(input, before);
});
