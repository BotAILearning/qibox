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
