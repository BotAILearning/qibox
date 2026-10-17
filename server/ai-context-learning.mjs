import { memoryExtractionInstruction, chatMemoryPrompt } from './ai-wiki.mjs';
import { AppError } from './files.mjs';
import { safeFactMessage, learningRules } from './ai-learning-policy.mjs';

// A self direction identifies the account, not who composed its message.
export function authoredMessages(vault, profile, messages) {
  const generated = new Set(profile.generatedIds || []);
  for (const row of profile.sentMessages || []) if (row.confirmed !== false && row.deliveryConfidence !== 'unknown') generated.add(row.id);
  const uncertain = (profile.sentMessages || []).filter(row => row.deliveryConfidence === 'unknown');
  return messages.map((message, index) => {
    let origin = message.direction === 'other' ? 'other' : 'unknown';
    if (message.direction === 'self') {
      origin = message.aiGenerated || generated.has(message.id) ? 'ai' : 'human';
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

export function contextualReplyStyle(messages) {
  let characters = 0;
  const samples = [];
  for (const message of messages.toReversed()) {
    if (message.direction !== 'self' || message.authorship !== 'human' || !factEvidence(message)) continue;
    const text = message.text.trim();
    if (text.length > 2000 || characters + text.length > 6000) continue;
    samples.unshift({ id: message.id, text, ...(Number.isSafeInteger(message.timestamp) ? { timestamp: message.timestamp } : {}) });
    characters += text.length;
    if (samples.length === 12) break;
  }
  return { source: 'current-chat-human', samples };
}

export const contextualStylePrompt = ` 当前回复必须参考contextualStyle.samples中本人最近的手动表达，学习措辞、长短、标点、表情和接话方式，越近的真实样本权重越高；这些样本在生成当前这条回复时立即参考，与updateStyle开关无关，不要求先保存或再次学习。本人近期一致的标点和短句习惯应具体体现在本轮表达中，不只笼统保持自然。用户明确保存的口吻要求和注意事项优先，样本只补充未指定的表达习惯，不复制旧句子，不继承其中的事实或跨对象称呼。旧样本里的答应、行呀、收到不是对本轮新邀约的授权；本人近期说过可以不代表现在或明天有空。不知道本人日程时不能替本人确认有空、接受邀约或约定时间，可以用其口吻自然表示还需确认。本轮有新问题或邀约时，必须接住该问题，不能只复述前面的饮食偏好或已学习的记忆；需要确认安排时也明确说明需要确认。样本不足就自然采用已设置风格，不编造习惯。authorship=human才是本人手动发言，authorship=ai或unknown只用于衔接对话和避免重复，不可学习为本人风格、称呼或个人事实。对方发言也不能学成本人口吻。contextualStyle只是本轮参考，不修改已保存风格。`;

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
