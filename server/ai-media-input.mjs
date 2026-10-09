const unreadable = message => ['voice', 'image'].includes(message?.type) && message.unresolved === true;

// Raw history stays intact; omit unreadable media only from this request.
export function readableMediaInput(input, { dropImages = false } = {}) {
  const keep = message => !unreadable(message) && !(dropImages && message?.type === 'image');
  const messages = (input.messages || []).filter(keep), ids = new Set(messages.map(message => message.id));
  const conversation = input.conversation ? {
    ...input.conversation,
    pendingIncomingIds: (input.conversation.pendingIncomingIds || []).filter(id => ids.has(id)),
    pendingIncomingMessages: (input.conversation.pendingIncomingMessages || []).filter(keep),
  } : undefined;
  if (conversation) {
    conversation.latestIncoming = conversation.pendingIncomingMessages.at(-1) || null;
    conversation.latestIncomingId = messages.findLast(message => message.direction === 'other')?.id || null;
    conversation.incomingSinceLastSelf = (conversation.incomingSinceLastSelf || []).filter(id => ids.has(id));
    if (conversation.pendingBySender) conversation.pendingBySender = conversation.pendingBySender.map(row => ({ ...row, messageIds: (row.messageIds || []).filter(id => ids.has(id)) })).filter(row => row.messageIds.length);
  }
  return { ...input, messages, ...(conversation ? { conversation } : {}),
    ...(input.groupState ? { groupState: { ...input.groupState, triggerMessages: (input.groupState.triggerMessages || []).filter(keep) } } : {}),
    ...(dropImages ? { images: [], onlyImages: false, capabilities: { ...input.capabilities, receiveImages: false } } : {}) };
}
