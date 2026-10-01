// Compact only the wire representation. Local attribution and delivery checks
// continue to receive the complete original context, without changed facts.
export function compactModelInput(input) {
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
  const reference = row => {
    if (!row || row.id == null) return row;
    const message = messages.get(row?.id);
    if (!message || row.text !== message.text || row.direction !== message.direction ||
        JSON.stringify(row.speaker) !== JSON.stringify(message.speaker) ||
        JSON.stringify(row.quote) !== JSON.stringify(message.quote)) return row;
    const { text, ...metadata } = row;
    return { ...metadata, excerpt: true };
  };
  if (input.conversation) result.conversation = { ...input.conversation,
    pendingIncomingMessages: input.conversation.pendingIncomingMessages?.map(reference),
    latestIncoming: reference(input.conversation.latestIncoming) };
  return result;
}

// Native routing identifiers are opaque, high-entropy hashes. Repeat a short,
// request-local reference instead; restore model-returned evidence IDs before
// validation. Message bodies, facts, quotes and actor roles are never shortened.
export function encodeModelRequest(system, input) {
  if (!['reply', 'proactive'].includes(input?.mode)) return { system, input, decode: value => value, id: value => value };
  const source = JSON.stringify(input) + system;
  let prefix = 'qref'; while (source.includes(prefix)) prefix += 'x';
  const identities = new Map(), originals = new Map();
  const keys = new Set(['id', 'account', 'contact', 'messageId', 'sender', 'senderId', 'latestIncomingId', 'lastSelfId']);
  const arrays = new Set(['messageIds', 'pendingIncomingIds', 'incomingSinceLastSelf', 'requiredReplyIds', 'ids', 'evidence']);
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
