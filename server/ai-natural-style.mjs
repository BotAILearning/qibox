import { sensitiveMemory } from './ai-learning-policy.mjs';

const visibleText = value => typeof value === 'string' ? value.trim() : '';

function usableSelfText(message, { pairedReply = false } = {}) {
  if (!message || message.direction !== 'self' || message.authorship !== 'human' || message.aiGenerated === true
    || message.unresolved || message.assumedPresent || message.deliveryConfidence === 'unknown'
    || message.forwarded || message.isForward || message.quoted || message.reference
    || !message.id || !['text', undefined].includes(message.type)) return '';
  if (message.quote && !(pairedReply && message.quote.verified === true)) return '';
  const text = visibleText(message.text);
  return text && text.length <= 2000 && !sensitiveMemory(text) ? text : '';
}

/**
 * Recent human-written self messages can inform expression immediately. A
 * Examples distinguish verified quote replies from literal, short-gap private
 * chat adjacency. Adjacency is only expression context, not a fact relation.
 */
export function naturalStyleEvidence(messages, {
  maxSamples = 12, maxChars = 6000, maxPairs = 3, maxPairChars = 1200, kind = 'person',
} = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const idCounts = new Map();
  for (const row of rows) if (row?.id != null) idCounts.set(row.id, (idCounts.get(row.id) || 0) + 1);
  const uniqueIds = new Set([...idCounts].filter(([, count]) => count === 1).map(([id]) => id));
  const byId = new Map(rows.filter(row => row?.id != null && uniqueIds.has(row.id)).map(row => [row.id, row]));

  const samples = [];
  let chars = 0;
  for (const message of rows.toReversed()) {
    const text = usableSelfText(message, { pairedReply: message?.quote?.verified === true });
    if (!text || !uniqueIds.has(message.id) || chars + text.length > maxChars) continue;
    samples.unshift({ id: message.id, text, ...(Number.isSafeInteger(message.timestamp) ? { timestamp: message.timestamp } : {}) });
    chars += text.length;
    if (samples.length >= maxSamples) break;
  }

  const pairedExamples = [];
  if (maxPairs <= 0) return { samples, pairedExamples };
  let pairChars = 0;
  const seenReplies = new Set();
  for (const reply of rows.toReversed()) {
    const quote = reply?.quote;
    if (quote?.verified !== true || quote.direction !== 'other' || !uniqueIds.has(reply?.id) || seenReplies.has(reply.id)) continue;
    const incoming = byId.get(quote.messageId);
    const incomingText = visibleText(incoming?.text);
    const replyText = usableSelfText(reply, { pairedReply: true });
    if (!incoming || incoming.direction !== 'other' || incoming.authorship !== 'other' || incoming.aiGenerated === true
      || incoming.unresolved || incoming.assumedPresent || incoming.deliveryConfidence === 'unknown'
      || incoming.forwarded || incoming.isForward || incoming.quoted || incoming.reference
      || !['text', undefined].includes(incoming.type) || !incoming.id || !incomingText || incomingText.length > 2000
      || !replyText || quote.messageId !== incoming.id) continue;
    const cost = incomingText.length + replyText.length;
    if (pairChars + cost > maxPairChars) continue;
    pairedExamples.unshift({
      relation: 'verified-quote',
      incoming: { id: incoming.id, text: incomingText },
      reply: { id: reply.id, text: replyText, ...(Number.isSafeInteger(reply.timestamp) ? { timestamp: reply.timestamp } : {}) },
    });
    pairChars += cost;
    seenReplies.add(reply.id);
    if (pairedExamples.length >= maxPairs) break;
  }

  // In a private person chat, a literal adjacent incoming/self turn can be a
  // small interaction sample. It is explicitly labeled as context, never as
  // a native reply relation or proof of who a quoted claim concerns.
  if (kind === 'person' && pairedExamples.length < maxPairs) {
    for (let index = rows.length - 2; index >= 0; index--) {
      const incoming = rows[index], reply = rows[index + 1];
      if (pairedExamples.some(pair => pair.reply.id === reply?.id)) continue;
      if (!incoming || incoming.direction !== 'other' || incoming.authorship !== 'other' || incoming.aiGenerated === true
        || incoming.unresolved || incoming.assumedPresent || incoming.deliveryConfidence === 'unknown'
        || incoming.forwarded || incoming.isForward || incoming.quoted || incoming.reference
        || !['text', undefined].includes(incoming.type) || !incoming.id || !uniqueIds.has(incoming.id)
        || !uniqueIds.has(reply?.id)) continue;
      const incomingText = visibleText(incoming.text);
      const replyText = usableSelfText(reply);
      const incomingTime = incoming.timestamp, replyTime = reply?.timestamp;
      if (!incomingText || incomingText.length > 2000 || !replyText || !Number.isSafeInteger(incomingTime)
        || !Number.isSafeInteger(replyTime) || replyTime < incomingTime || replyTime - incomingTime > 300
        || Math.floor(incomingTime / 86400) !== Math.floor(replyTime / 86400)) continue;
      const cost = incomingText.length + replyText.length;
      if (pairChars + cost > maxPairChars) continue;
      pairedExamples.push({
        relation: 'adjacent-context',
        incoming: { id: incoming.id, text: incomingText },
        reply: { id: reply.id, text: replyText, timestamp: replyTime },
      });
      pairChars += cost;
      if (pairedExamples.length >= maxPairs) break;
    }
    pairedExamples.reverse();
  }
  return { samples, pairedExamples };
}
