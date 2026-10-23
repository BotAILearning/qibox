// Compact only the wire representation. Local attribution and delivery checks
// continue to receive the complete original context, without changed facts.
export const modelInputReferencePrompt = ' 输入使用原文引用结构：messages按原顺序保存本次可读原文及已有截断、未知标记。textRef是同一次请求中该messageId对应的原文，不是另作摘要，不补全被截断或未读内容；作者索引的messageIds、风格样例及配对也按ID查阅messages。索引只定位来源，不推断事情主体；先读本轮来信与相关前文，不能只看最后一位发言者或关键词补人名。核实引用的作者仍以quote为准，发图者不等于图片中事项的当事人。AI历史只作衔接与避免重复，真人风格样例只借用表达，不搬用事实。没有引用索引的资料仍按原字段读取；原有事实、权限、身份、风格优先级和返回协议继续生效。';

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
  if (input.contextualStyle) result.contextualStyle = { ...input.contextualStyle,
    ...(Array.isArray(input.contextualStyle.samples) ? { samples: input.contextualStyle.samples.map(reference) } : {}),
    ...(Array.isArray(input.contextualStyle.pairedExamples) ? { pairedExamples: input.contextualStyle.pairedExamples.map(pair => ({ ...pair, incoming: reference(pair.incoming), reply: reference(pair.reply) })) } : {}) };
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
