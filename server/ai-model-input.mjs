// Compact only the wire representation. Local attribution and delivery checks
// continue to receive the complete original context, without changed facts.
export const modelInputReferencePrompt = ' 输入使用原文引用结构：messages保留原顺序、作者和已有截断、未知标记；本轮完整来信放在末尾conversation.pendingIncomingMessages，前面同一消息不再重复正文。textRef和作者索引messageIds按ID查找messages或pendingIncomingMessages中带text的原文，不是另作摘要，不补全被截断或未读内容。addressing.currentStyleRef=style仅复用相同的风格原文，styleScope继续限定其用途，称呼和分享范围不扩大。索引只定位来源，不推断事情主体；先读本轮来信与相关前文，不能只看最后一位发言者或关键词补人名。核实引用的作者仍以quote为准，发图者不等于图片中事项的当事人。AI历史只作衔接与避免重复，真人风格样例只借用表达，不搬用事实。没有引用索引的资料仍按原字段读取；原有事实、权限、身份、风格优先级和返回协议继续生效。';

// Report tables repeat field names and author labels, not factual content.
// Pack only this exact known DTO; future quote/identity metadata stays inline.
export function compactReportInput(input) {
  const columns = ['sequence', 'speaker', 'beijingTime', 'text', 'secondsSincePrevious'];
  const authors = new Set(['本人', '对方', '未知']);
  if (!input || Object.hasOwn(input, 'participants') || Object.hasOwn(input, 'messageColumns') ||
      Object.hasOwn(input, 'writeReport') ||
      !Array.isArray(input.messages) || !input.messages.length || !input.messages.every((row, index) =>
        row && Object.keys(row).length === columns.length && columns.every(key => Object.hasOwn(row, key)) &&
        Number.isSafeInteger(row.sequence) && row.sequence === index + 1 && authors.has(row.speaker) &&
        typeof row.beijingTime === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.beijingTime) &&
        typeof row.text === 'string' && (index === 0 ? row.secondsSincePrevious === null :
          Number.isFinite(row.secondsSincePrevious) && row.secondsSincePrevious >= 0))) return input;
  const { messages, ...metadata } = input;
  const result = { ...metadata,
    messageColumns: columns,
    messages: messages.map(row => columns.map(key => row[key])),
    writeReport: '现在按userRequest及系统给定的篇幅、格式完成报告。表格按用户指定列，不展示未要求的内部字段名。要求逐条、保留原文或其他篇幅时完整遵守；概括只选主要进展和最后的新变化，不逐人罗列或重复状态。每个写入的判断沿其原句核对：谁在说、向谁说、谁实际做了什么；建议、转述与本人决定分开，不能把向对方的建议写成本人的计划。物主、亲属、动作对象、否定范围及通知/申请等证据范围保留原短句，不能拼成新事实或用含混的“自己”换人；难以简写的枝节可略去。按时间组织时，每个小节只纳入该段原消息中的事实，不把后文同主题细节提前；章节时间沿所涵盖的来源时间，不按主题猜时刻。只返回report JSON。' };
  if (typeof input.userRequest === 'string' && input.request === input.userRequest) delete result.request;
  return result;
}

export function compactModelInput(input, { system = '' } = {}) {
  if (!['reply', 'proactive'].includes(input?.mode)) return input;
  const result = { ...input };
  const entries = input.memory?.entries;
  if (entries?.length && input.memory.summary === entries.map(entry => entry.text).join('\n')) {
    const { summary, ...memory } = input.memory;
    result.memory = memory;
  }
  const messages = new Map();
  for (const message of input.messages || []) {
    if (messages.has(message.id)) messages.set(message.id, null);
    else messages.set(message.id, message);
  }
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Reuse text, never its authority. In particular a default/borrowed style
  // stays reference-scoped even when its complete object equals style.
  if (['current-chat', 'reference'].includes(input.addressing?.styleScope) && !Object.hasOwn(input.addressing, 'currentStyleRef') &&
      input.style && typeof input.style === 'object' && !Array.isArray(input.style) &&
      input.addressing.currentStyle && equal(input.addressing.currentStyle, input.style)) {
    const { currentStyle, ...addressing } = input.addressing;
    result.addressing = { ...addressing, currentStyleRef: 'style' };
  }
  // Only exact, unique originals can replace a duplicate. An excerpt, a
  // conflicting author/date or any additional unmatched metadata stays inline.
  const available = row => {
    if (!row || row.id == null) return null;
    const message = messages.get(row.id);
    return message && typeof row.text === 'string' && row.text === message.text &&
      Object.entries(row).every(([key, value]) => ['id', 'text', 'excerpt'].includes(key) || equal(value, message[key])) ? message : null;
  };
  const quoteReference = quote => {
    const source = messages.get(quote?.messageId);
    if (!source || quote.verified !== true || quote.excerpt || typeof quote.text !== 'string' || quote.text !== source.text ||
        ['direction', 'speaker', 'timestamp', 'type', 'authorship', 'aiGenerated'].some(key => Object.hasOwn(quote, key) && !equal(quote[key], source[key]))) return quote;
    const { text, ...metadata } = quote;
    return { ...metadata, textRef: source.id };
  };
  const reference = row => {
    const source = available(row);
    if (!source) return row;
    const { text, ...metadata } = row;
    return { ...metadata, excerpt: true, textRef: source.id,
      ...(row.quote ? { quote: quoteReference(row.quote) } : {}) };
  };
  if (Array.isArray(input.messages)) result.messages = input.messages.map(row => row.quote ? { ...row, quote: quoteReference(row.quote) } : row);
  if (input.conversation) result.conversation = { ...input.conversation,
    pendingIncomingMessages: input.conversation.pendingIncomingMessages?.map(reference),
    latestIncoming: reference(input.conversation.latestIncoming),
    ...(Array.isArray(input.conversation.recentSelfMessages) ? { recentSelfMessages: input.conversation.recentSelfMessages.map(reference) } : {}) };
  // Keep at most two small, already-selected human interaction examples
  // readable together. Resolving both halves through a distant ID index hid
  // the conversational move; all other duplicated bodies remain references.
  // This never converts WeChat history into provider assistant completions.
  const inlinePairs = new Set(); let inlineChars = 0;
  if (input.mode === 'reply' && input.contextualStyle?.source === 'current-chat-human' && Array.isArray(input.contextualStyle.pairedExamples)) {
    for (const pair of input.contextualStyle.pairedExamples.toReversed()) {
      const incoming = available(pair?.incoming), reply = available(pair?.reply);
      if (!incoming || incoming.direction !== 'other' || !reply || reply.direction !== 'self' ||
          [incoming, reply, pair.incoming, pair.reply].some(row => row.excerpt || row.truncated || row.textTruncated) ||
          reply.authorship !== 'human' || reply.aiGenerated === true || reply.unresolved || reply.assumedPresent ||
          reply.deliveryConfidence === 'unknown' || !['adjacent-context', 'verified-quote'].includes(pair.relation)) continue;
      const chars = incoming.text.length + reply.text.length;
      if (inlineChars + chars > 900) continue;
      inlineChars += chars; inlinePairs.add(pair);
      if (inlinePairs.size === 2) break;
    }
  }
  if (input.contextualStyle) result.contextualStyle = { ...input.contextualStyle,
    ...(Array.isArray(input.contextualStyle.samples) ? { samples: input.contextualStyle.samples.map(reference) } : {}),
    ...(Array.isArray(input.contextualStyle.pairedExamples) ? { pairedExamples: input.contextualStyle.pairedExamples.map(pair => inlinePairs.has(pair) ? pair : ({ ...pair, incoming: reference(pair.incoming), reply: reference(pair.reply) })) } : {}) };
  if (Array.isArray(input.confirmedSpeakerHistory)) result.confirmedSpeakerHistory = input.confirmedSpeakerHistory.map(group => {
    if (!Array.isArray(group.messages) || Object.hasOwn(group, 'messageIds') ||
        !group.messages.every(row => { const source = available(row); return source && equal(group.speaker, source.speaker); })) return group;
    const { messages: originals, ...metadata } = group;
    return { ...metadata, messageIds: originals.map(row => row.id) };
  });
  if (Array.isArray(input.replyRelations)) result.replyRelations = input.replyRelations.map(relation => {
    const source = messages.get(relation.messageId);
    const linked = source && source.text === relation.text && equal(source.speaker, relation.speaker);
    const { text, ...metadata } = relation;
    return { ...(linked ? { ...metadata, textRef: source.id } : relation),
      ...(relation.quotedMessage ? { quotedMessage: quoteReference(relation.quotedMessage) } : {}) };
  });
  if (typeof input.attributionContext?.rules === 'string' && input.attributionContext.rules && system.includes(input.attributionContext.rules)) {
    const { rules, ...evidence } = input.attributionContext;
    result.attributionContext = evidence;
  }
  if (input.mode === 'reply' && input.contextualStyle?.source === 'current-chat-human') {
    // Make the actual turn readable at the end, rather than ending with IDs
    // pointing back into long background. Move only exact unique originals;
    // retain the chronological source metadata and never duplicate the body.
    const pending = input.conversation?.pendingIncomingMessages;
    if (Array.isArray(pending) && Array.isArray(result.messages)) {
      const counts = new Map();for (const row of pending) counts.set(row?.id,(counts.get(row?.id)||0)+1);
      const canonical = new Map(pending.flatMap(row => {
        const source=available(row);
        return source?.direction==='other' && counts.get(row.id)===1
          ? [[row.id,result.messages.find(message=>message.id===row.id)]] : [];
      }));
      result.conversation.pendingIncomingMessages = pending.map((row,index)=>canonical.get(row.id)||result.conversation.pendingIncomingMessages[index]);
      result.messages = result.messages.map(row=>{
        if (!canonical.has(row.id)) return row;
        const {text,...metadata}=row;return {...metadata,textRef:row.id};
      });
    }
    // Read the labelled sources, then expression examples, then the current
    // turn. Actor indexes are still complete; their incidental property order
    // must not become the last task the model sees.
    const { messages: transcript, contextualStyle, conversation, ...metadata } = result;
    return { ...metadata, ...(transcript ? { messages: transcript } : {}), contextualStyle,
      ...(conversation ? { conversation } : {}) };
  }
  return result;
}

// Native routing identifiers are opaque, high-entropy hashes. Repeat a short,
// request-local reference instead; restore model-returned evidence IDs before
// validation. Message bodies, facts, quotes and actor roles are never shortened.
export function encodeModelRequest(system, input) {
  if (!['reply', 'proactive', 'memory-monitor'].includes(input?.mode)) return { system, input, decode: value => value, id: value => value };
  const source = JSON.stringify(input) + system;
  let prefix = 'qref'; while (source.includes(prefix)) prefix += 'x';
  const identities = new Map(), originals = new Map();
  const keys = new Set(['id', 'account', 'contact', 'subjectId', 'messageId', 'textRef', 'sender', 'senderId', 'latestIncomingId', 'lastSelfId']);
  const arrays = new Set(['messageIds', 'newMessageIds', 'styleLearningMessageIds', 'pendingIncomingIds', 'incomingSinceLastSelf', 'requiredReplyIds', 'ids', 'evidence']);
  const opaque = /^(?:(?:account|contact|member|chat|unknown-member|message):)?[a-f0-9]{64}$/;
  const reference = value => {
    if (!opaque.test(value)) return value;
    if (!identities.has(value)) { const ref = prefix + (identities.size + 1); identities.set(value, ref); originals.set(ref, value); }
    return identities.get(value);
  };
  const encode = (value, key = '') => {
    if (typeof value === 'string') return keys.has(key) || arrays.has(key) ? reference(value) : value;
    if (Array.isArray(value)) return value.map(item => encode(item, key));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [opaque.test(name) ? reference(name) : name, encode(item, name)]));
  };
  const wire = encode(input);
  // Explicit recipient/message references in system rules must use the same
  // local identity as the labelled transcript. Ordinary factual text stays in
  // the input and is not rewritten.
  for (const [original, ref] of [...identities].sort((a,b)=>b[0].length-a[0].length)) system = system.replaceAll(original, ref);
  const decode = value => {
    if (typeof value === 'string') return originals.get(value) || value;
    if (Array.isArray(value)) return value.map(decode);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[originals.get(key)||key,decode(item)]));
  };
  return { system, input: wire, decode, id: value => identities.get(value) || value };
}
