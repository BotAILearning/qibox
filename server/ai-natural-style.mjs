import { sensitiveMemory } from './ai-learning-policy.mjs';

const visibleText = value => typeof value === 'string' ? value.trim() : '';

// Retrieval cues choose expression examples, never establish a fact, reply
// relation, personality or the subject of an experience. No model call/store.
function expressionCues(text) {
  const words = visibleText(text).normalize('NFKC').toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]{2,}/gu) || [];
  return new Set(words.flatMap(word => /^[a-z0-9]+$/.test(word) ? [word]
    : Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))));
}

function relatedExamples(pairs, query, maxPairs, maxChars) {
  const cues = expressionCues(query);
  const ranked = pairs.map((pair, index) => {
    // Match the incoming side. A historical self answer must not select itself
    // merely because it contains the facts the current model could echo.
    const incoming = expressionCues(pair.incoming.text);
    const overlap = [...incoming].filter(cue => cues.has(cue)).length;
    return { pair, index, score: overlap / Math.max(1, Math.sqrt(incoming.size * cues.size)) };
  }).sort((a, b) => b.score - a.score || b.index - a.index);
  const selected = []; let chars = 0;
  for (const candidate of ranked) {
    const cost = candidate.pair.incoming.text.length + candidate.pair.reply.text.length;
    if (chars + cost > maxChars) continue;
    chars += cost; selected.push(candidate);
    if (selected.length >= maxPairs) break;
  }
  // Keep the original conversational chronology, not a relevance ranking that
  // could be mistaken for a factual sequence by the generator.
  return selected.sort((a, b) => a.index - b.index).map(row => row.pair);
}

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
  maxSamples = 12, maxChars = 6000, maxPairs = 3, maxPairChars = 1200, kind = 'person', query = '',
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
  const related = typeof query === 'string' && query.trim().length > 0;
  const candidateLimit = related ? Math.max(maxPairs, 24) : maxPairs;
  const candidateChars = related ? Math.max(maxPairChars, 12000) : maxPairChars;
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
    if (pairChars + cost > candidateChars) continue;
    pairedExamples.unshift({
      relation: 'verified-quote',
      incoming: { id: incoming.id, text: incomingText },
      reply: { id: reply.id, text: replyText, ...(Number.isSafeInteger(reply.timestamp) ? { timestamp: reply.timestamp } : {}) },
    });
    pairChars += cost;
    seenReplies.add(reply.id);
    if (pairedExamples.length >= candidateLimit) break;
  }

  // In a private person chat, a literal adjacent incoming/self turn can be a
  // small interaction sample. It is explicitly labeled as context, never as
  // a native reply relation or proof of who a quoted claim concerns.
  if (kind === 'person' && pairedExamples.length < candidateLimit) {
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
      if (pairChars + cost > candidateChars) continue;
      pairedExamples.push({
        relation: 'adjacent-context',
        incoming: { id: incoming.id, text: incomingText },
        reply: { id: reply.id, text: replyText, timestamp: replyTime },
      });
      pairChars += cost;
      if (pairedExamples.length >= candidateLimit) break;
    }
    pairedExamples.reverse();
  }
  const chronological = related ? pairedExamples.toSorted((a, b) => rows.indexOf(byId.get(a.reply.id)) - rows.indexOf(byId.get(b.reply.id))) : pairedExamples;
  return { samples, pairedExamples: related ? relatedExamples(chronological, query, maxPairs, maxPairChars) : pairedExamples };
}
