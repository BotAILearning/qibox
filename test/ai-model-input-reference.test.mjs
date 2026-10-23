import test from'node:test';import assert from'node:assert/strict';
import{compactModelInput,encodeModelRequest}from'../server/ai-model-input.mjs';
const actor={id:'account:'+'a'.repeat(64),role:'self'},peer={id:'contact:'+'b'.repeat(64),role:'other'};
const source={id:'c'.repeat(64),direction:'self',speaker:actor,text:'我整理的是相册，不是字幕。'.repeat(100)+'那一单是阿晟的，我没参与。',authorship:'human',aiGenerated:false,timestamp:1792776000};
test('long original survives once while source indexes, human samples and verified quote resolve to its full original',()=>{
 const quoted={verified:true,messageId:source.id,direction:'self',speaker:actor,text:source.text,timestamp:source.timestamp,authorship:'human',aiGenerated:false};
 const incoming={id:'d'.repeat(64),direction:'other',speaker:peer,text:'这么折腾还真够烧额度的。',quote:quoted};
 const history={speaker:actor,referenceInReply:'本人',messages:[{id:source.id,text:source.text,authorship:'human',timestamp:source.timestamp,aiGenerated:false}]};
 const rules='同一份来源说明';const input={mode:'reply',messages:[source,incoming],confirmedSpeakerHistory:[history],replyRelations:[{messageId:incoming.id,speaker:peer,text:incoming.text,quotedMessage:quoted}],contextualStyle:{samples:[{id:source.id,text:source.text,timestamp:source.timestamp}],pairedExamples:[{relation:'verified-quote',incoming:{id:incoming.id,text:incoming.text},reply:{id:source.id,text:source.text}}]},attributionContext:{rules,memoryEvidence:[{contextRole:'historical'}]},memory:{entries:[{text:'旧记忆，归属未知'}]}};
 const original=structuredClone(input),compact=compactModelInput(input,{system:'已有规则：'+rules}),wire=encodeModelRequest('数据',compact),m=wire.input.messages[0];
 assert.deepEqual(input,original);assert.equal(JSON.stringify(compact).split(source.text).length-1,1);assert.equal(m.text,source.text);
 assert.deepEqual(wire.input.confirmedSpeakerHistory[0].messageIds,[m.id]);assert.equal(wire.input.messages[1].quote.textRef,m.id);assert.equal(wire.input.messages[1].quote.speaker.role,'self');
 assert.equal(wire.input.replyRelations[0].quotedMessage.textRef,m.id);assert.equal(wire.input.contextualStyle.samples[0].textRef,m.id);assert.equal(wire.input.contextualStyle.pairedExamples[0].reply.textRef,m.id);
 assert.deepEqual(wire.decode(wire.input),compact);assert(!Object.hasOwn(compact.attributionContext,'rules'));assert.deepEqual(compact.attributionContext.memoryEvidence,input.attributionContext.memoryEvidence);assert(!Object.hasOwn(compact.memory.entries[0],'subjectId'));
 assert.equal(compactModelInput(input,{system:'不同的说明'}).attributionContext.rules,rules);
});
test('duplicate/missing IDs, contradictory metadata, excerpts and unmatched group metadata remain inline',()=>{
 const different={...source,timestamp:source.timestamp-86400};
 const variants=[{messages:[source,source],sample:source},{messages:[source],sample:different},{messages:[source],sample:{text:source.text}},{messages:[source],sample:{...source,text:source.text.slice(0,20)}},{messages:[source],sample:{...source,speaker:peer}},{messages:[source],sample:{...source,extraFact:'另有说明'}}];
 for(const v of variants){const input={mode:'reply',messages:v.messages,contextualStyle:{samples:[v.sample]}};assert.deepEqual(compactModelInput(input).contextualStyle.samples[0],v.sample);}
 for(const q of [{verified:false,messageId:source.id,text:source.text},{verified:true,messageId:source.id,text:source.text,excerpt:true},{verified:true,messageId:source.id,text:source.text,direction:'other'},{verified:true,messageId:'e'.repeat(64),text:source.text}]){
  const row={id:'f'.repeat(64),direction:'other',text:'评论',quote:q},input={mode:'reply',messages:[source,row]};assert.deepEqual(compactModelInput(input).messages[1].quote,q);
 }
 const group={speaker:actor,messages:[{id:source.id,text:source.text,unknownMetadata:'未在原文中'}]};assert.deepEqual(compactModelInput({mode:'reply',messages:[source],confirmedSpeakerHistory:[group]}).confirmedSpeakerHistory[0],group);
});
test('non-chat inputs stay unchanged and source-less chat input never loses its free text',()=>{
 for(const mode of['learning','analysis','memory-monitor']){const input={mode,messages:[source],contextualStyle:{samples:[source]}};assert.equal(compactModelInput(input),input);}
 const input={mode:'reply',contextualStyle:{samples:[{text:'无ID样例'}]}};assert.deepEqual(compactModelInput(input),input);
});
