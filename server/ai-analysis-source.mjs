import { authoredMessages } from './ai-context-learning.mjs';

// Report rows keep their original text and five-column encoding. Supplement
// only known provenance by sequence; do not duplicate quote bodies, expand the
// selected range, infer the subject of an experience or modify stored data.
export function analysisSourceIndex(messages, vault, profile = {}) {
  const rows=authoredMessages(vault,profile,messages),positions=new Map();
  const generatedIds=new Set(profile.generatedIds||[]),ambiguousIds=new Set();
  for(const sent of profile.sentMessages||[]){
    if(sent.confirmed===false||sent.deliveryConfidence==='unknown')ambiguousIds.add(sent.id);
    else generatedIds.add(sent.id);
  }
  rows.forEach((row,index)=>positions.set(row.id,positions.has(row.id)?null:index));
  const generated=[],unknown=[],quotes=[];
  for(const [index,row]of rows.entries()){
    const sequence=index+1;
    if(row.authorship==='ai'||row.aiGenerated===true)generated.push(sequence);
    else if(row.direction==='self'&&row.authorship==='unknown')unknown.push(sequence);
    if(!row.quote)continue;
    const q=row.quote,position=positions.get(q.messageId),source=Number.isInteger(position)?rows[position]:null;
    const verified=q.verified===true&&/^[a-f0-9]{64}$/.test(q.messageId||'')&&['self','other'].includes(q.direction);
    const matches=source&&source.direction===q.direction&&source.text===q.text&&
      (q.timestamp==null||q.timestamp===source.timestamp);
    if(!verified||source&&source.direction!==q.direction){quotes.push({sequence,verified:false});continue;}
    const unknownQuote=q.authorship==='unknown'||q.deliveryConfidence==='unknown'||ambiguousIds.has(q.messageId);
    const generatedQuote=!unknownQuote&&(q.aiGenerated===true||q.authorship==='ai'||generatedIds.has(q.messageId));
    quotes.push({sequence,verified:true,speaker:q.direction==='self'?'本人':'对方',
      ...(matches?{sourceSequence:position+1}:{sourceReadable:false}),
      ...(generatedQuote&&(!matches||!(source.authorship==='ai'||source.aiGenerated===true))?{generated:true}:{}),
      ...(unknownQuote&&(!matches||source.authorship!=='unknown')?{authorship:'unknown'}:{})});
  }
  return generated.length||unknown.length||quotes.length?{
    ...(generated.length?{generated}:{}),...(unknown.length?{unknown}:{}),...(quotes.length?{quotes}:{})}:undefined;
}

export const analysisSourcePrompt=' 输入sourceIndex以sequence标明来源，不改变原文、消息条数或分析范围。generated是已知代发，unknown是来源无法核实的本人侧文本；这些可以按原记录的发言方转述，不证明本人亲历、他人亲历、身份或决定，也不作为真人表达依据；来源未知不证明事情的反面。不把账号侧的文字写成真人确认。quotes中verified只确认引用作者，不证明内容真实；sourceSequence按原消息读取，sourceReadable=false时引用原文未完整纳入本次材料，不补全或代为确认。未标明来源的旧原话仍按其陈述范围分析，不额外推断事实。 messageColumns中的origin与同一行speaker和text直接绑定：已知AI代发或来源未核实的行只证明账号侧记录，不是本人确认经历、结果或决定；origin为null只是未标明来源，不把其他明确原话一起作废。origin.quote只表示该行引用了谁的原话，不改变本行发言者或事情主体。';
