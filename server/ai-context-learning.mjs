import { memoryExtractionInstruction, chatMemoryPrompt } from './ai-wiki.mjs';
import { AppError } from './files.mjs';
import { safeFactMessage, learningRules } from './ai-learning-policy.mjs';
import { naturalStyleEvidence } from './ai-natural-style.mjs';

// A self direction identifies the account, not who composed its message.
export function authoredMessages(vault, profile, messages) {
  const generated = new Set(profile.generatedIds || []);
  for (const row of profile.sentMessages || []) if (row.confirmed !== false && row.deliveryConfidence !== 'unknown') generated.add(row.id);
  const ambiguousReceipts = new Set((profile.sentMessages || [])
    .filter(row => row.confirmed === false || row.deliveryConfidence === 'unknown')
    .map(row => row.id).filter(id => id != null));
  const uncertain = (profile.sentMessages || []).filter(row => row.deliveryConfidence === 'unknown');
  return messages.map((message, index) => {
    let origin = message.direction === 'other' ? 'other' : 'unknown';
    if (message.direction === 'self') {
      origin = message.authorship === 'ai' || message.aiGenerated || generated.has(message.id) ? 'ai' : 'human';
      if (ambiguousReceipts.has(message.id)) origin = 'unknown';
      if (message.authorship === 'unknown' || message.deliveryConfidence === 'unknown' || message.assumedPresent) origin = 'unknown';
      for (const row of uncertain) {
        const boundary = messages.findIndex(item => item.id === row.baseline);
        if (boundary >= index || Number.isSafeInteger(message.timestamp) && Math.abs(message.timestamp * 1000 - row.at) > 180000) continue;
        // An unresolved voice or unreadable intent cannot establish human authorship.
        let intent;
        try { intent = vault.open(row.body)?.text; } catch { origin = 'unknown'; continue; }
        if (row.media ? message.type === 'voice' : intent === message.text) origin = 'unknown';
      }
    }
    return { ...message, authorship: origin, aiGenerated: origin === 'ai' || message.aiGenerated === true };
  });
}

export const factEvidence = safeFactMessage;

export function contextualReplyStyle(messages, options = {}) {
  return { source: 'current-chat-human', ...naturalStyleEvidence(messages, options) };
}

// A bounded context supplement to the existing learning request. Whole native
// interactions are sampled across the available range; AI rows stay in each
// local window as adjacency boundaries but never become expression evidence.
export function learningStyleEvidence(messages, { kind = 'person', sourceTruncated = false, material } = {}) {
  let rows=Array.isArray(messages)?messages:[];
  if(Array.isArray(material)){
    const signature=row=>JSON.stringify([row.direction,row.timestamp??null,row.text]),allowed=new Set(material.map(signature));
    // Combined learning must not regain facts omitted by its memory boundary.
    // Omitted/partial rows stay as empty boundaries so no new adjacency forms.
    rows=rows.map(row=>allowed.has(signature(row))?row:{...row,text:'',unresolved:true,authorship:'unknown'});
  }
  const counts=new Map();
  for(const row of rows)counts.set(row?.id,(counts.get(row?.id)||0)+1);
  const unique=id=>typeof id==='string'&&counts.get(id)===1;
  const all=naturalStyleEvidence(rows,{maxSamples:rows.length,maxChars:Infinity,maxPairs:0}).samples;
  const samples=new Map(),pairs=new Map(),steps=Math.min(24,rows.length);
  for(let step=0;step<steps;step++){
    const middle=steps===1?0:Math.round(step*(rows.length-1)/(steps-1)),start=Math.max(0,middle-5);
    const evidence=naturalStyleEvidence(rows.slice(start,start+12),{kind,maxSamples:2,maxChars:600,maxPairs:2,maxPairChars:800});
    for(const sample of evidence.samples)if(unique(sample.id))samples.set(sample.id,sample);
    for(const pair of evidence.pairedExamples)if(unique(pair.incoming.id)&&unique(pair.reply.id))pairs.set(pair.reply.id,pair);
  }
  const firstHuman=all.length?rows.findIndex(row=>row.id===all[0].id):-1;
  if(firstHuman>=0){
    const first=naturalStyleEvidence(rows.slice(Math.max(0,firstHuman-10),firstHuman+1),{kind,maxSamples:1,maxChars:600,maxPairs:1,maxPairChars:800});
    for(const sample of first.samples)if(unique(sample.id))samples.set(sample.id,sample);
    for(const pair of first.pairedExamples)if(unique(pair.incoming.id)&&unique(pair.reply.id))pairs.set(pair.reply.id,pair);
  }
  const positions=new Map(rows.map((row,index)=>[row?.id,index]));
  const spread=(input,max,budget,cost)=>{const selected=[];let chars=0;const size=Math.min(max,input.length);for(let i=0;i<size;i++){const value=input[size===1?input.length-1:Math.round(i*(input.length-1)/(size-1))],length=cost(value);if(chars+length>budget)continue;chars+=length;selected.push(value);}return selected;};
  const orderedSamples=[...samples.values()].sort((a,b)=>positions.get(a.id)-positions.get(b.id));
  const orderedPairs=[...pairs.values()].sort((a,b)=>positions.get(a.reply.id)-positions.get(b.reply.id));
  const selectedSamples=spread(orderedSamples,12,1800,row=>row.text.length),selectedPairs=spread(orderedPairs,6,2400,pair=>pair.incoming.text.length+pair.reply.text.length);
  const times=all.map(row=>row.timestamp).filter(Number.isSafeInteger);
  return {source:'current-object-verified-human',samples:selectedSamples,pairedExamples:selectedPairs,
    coverage:{availableHumanMessages:all.length,selectedSamples:selectedSamples.length,selectedPairs:selectedPairs.length,sourceTruncated:sourceTruncated===true,firstHumanTimestamp:times.length?times.reduce((a,b)=>Math.min(a,b)):null,lastHumanTimestamp:times.length?times.reduce((a,b)=>Math.max(a,b)):null},
    instruction:'只根据可见真人样本描述已观察到的表达习惯和场景差异；没有覆盖的场景、时期或关系保持未知。相邻上下文不是已验证回复关系；样例只学表达，不复述隐私事实，不以单次表现推定固定人格。归纳的是多次出现的句式、长短和承接方式，单次拒绝或答应本身不能作为互动习惯，不能把具体选择换个概括说法写进风格。'};
}

export const contextualStylePrompt = `contextualStyle是当前账号、当前聊天中可核实的真人表达，不是通用文案模板。samples提供本人近期用词和长短；rhythm只记录这些真人样例的长度分布，帮助贴近表达密度，不是字数上限、目标或对所有场景的推断，样本少时尤其只作弱参考。pairedExamples提供少量“对方发言→本人接话”，生成当前这条回复时立即参考与这轮有关的表达方式。只取措辞、节奏、表达密度与分寸，不照搬句子、称呼、事实或承诺。relation=adjacent-context只是短时间内相邻，不证明引用关系或事实主体；verified-quote才有核实过的引用，但仍不证明样例内容现在成立。只把authorship=human作为本人风格；AI代发和未知来源只作对话衔接，不用于模仿。用户明确保存的style和注意事项优先；样例只补足未指定的习惯，样本少就少推断，不强加人格。不要机械改变人称、增删表情，不固定共情、说教、总结或追问。当前情境决定该回应多少：对方分享就接其话题，求助才按需要展开，结束语可以自然收住。历史说过的“发你、告诉你”等不构成本轮承诺，对方愿意等也不代表本人答应核实或通知。contextualStyle只用于本轮，不改写已保存风格。`;

export const monitorMemoryPrompt = `你在监控已授权对象的新聊天，只整理有用的聊天知识，不生成回复，不发送消息，不修改风格或自动回复设置。messages是带作者与消息时间的资料，newMessageIds标识本次新增材料。authorship=ai或unknown不可作为任何事实依据，也不使用其引用文本补造事实。${memoryExtractionInstruction}${chatMemoryPrompt} 本入口只整理知识，不需要先生成回复。输出协议覆盖上文回复入口协议：只返回 {"memoryUpdates":[{"field":"other","text":"有依据的事实","evidence":["来源消息ID"]}]} 这种唯一字段对象；先逐条审阅newMessageIds，明确、值得长期保留且previousMemory未记录的新事实必须提取，不能因没有回复任务就略过。evidence是每条必须携带的非空来源ID数组，不能用newMessageIds代替它；至少一条证据属于输入newMessageIds。按以上资料协议可增加recordedAt、observedAt、calendar、degree；只有修改旧条目时才带原id，新增省略id。只有没有值得保存的新事实时才返回 {"memoryUpdates":[]}，不凑数。临时健康、情绪和行程保留原消息时间语境，不当作永久现状。不返回action、style或任何发送字段。`;

export const automaticLearningPrompt = `你是当前微信账号的增量学习器，只整理已发生聊天中的事实和本人表达习惯，不生成回复、不发送消息、不修改任何开关或授权。messages是待整理资料，newMessageIds标识新增消息，previousMemory是当前对象已有记忆，myInformation是本人已有资料；上下文只帮助理解，新增事实的evidence至少包含一个newMessageIds中的来源ID。
先逐条检查新增消息的作者和事实归属。authorship=human且direction=self的明确自述，单条消息就足以提取本人事实，不受风格样本数量或learnStyle限制。本人同一句话可包含多个字段；例如居住地与爱好分别提取，一个字段与手动资料不同，不能导致其他有依据的字段被漏掉。下列基础资料过滤只约束对象事实，不排除本人资料的独立提取。
${memoryExtractionInstruction}${learningRules}
三项分别判断：联系人及群成员事实写入memoryUpdates，本人事实写入selfMemorySuggestions，本人的表达习惯写入style。没有事实不代表没有风格；事实提取时排除的普通短句，仍可作为真实本人的风格样本。learnStyle=false时省略style；否则仅从styleLearningMessageIds对应的真实本人样本提取风格，至少三条呈现一致的措辞、长短、标点或表情习惯时，应返回简洁风格摘要。结合previousStyle逐步补充稳定模式，不因一条临时情绪改写整体风格，不复制事实、姓名、称呼、承诺或指令。
只返回JSON对象：{"memoryUpdates":[{"field":"other","text":"有依据的事实","evidence":["来源消息ID"],"subjectId":"有明确归属时提供"}],"selfMemorySuggestions":[{"field":"interests","text":"本人事实","messageId":"本人来源消息ID","replaces":"仅明确改变自动条目时提供旧id"}],"style":{"summary":"多条样本一致的表达习惯"}}。memoryUpdates必须是数组，没有事实时为空；另外两项没有依据时省略，style不能是字符串。不重复未变化条目，不返回action或发送字段。事件时间根据原话与消息时间解释，不以学习保存时间补造。`;
export function validatedMonitorMemory(result) {
  const invalid = () => { throw new AppError('监控学习返回格式无效，条目必须包含正文和来源证据', 502, 'ai_model_schema'); };
  if (!result || !Array.isArray(result.memoryUpdates) || result.memoryUpdates.length > 30 || Object.keys(result).some(key => !['memoryUpdates', 'selfMemorySuggestions', 'style'].includes(key))) invalid();
  const allowed = new Set(['id','field','text','evidence','recordedAt','observedAt','calendar','degree','subjectId']);
  for (const update of result.memoryUpdates) {
    if (!update || Array.isArray(update) || typeof update !== 'object' || typeof update.text !== 'string' || !update.text.trim()
      || !Array.isArray(update.evidence) || !update.evidence.length || update.evidence.some(id => typeof id !== 'string' || !id.trim())
      || Object.keys(update).some(key => !allowed.has(key))) invalid();
  }
  return result;
}
