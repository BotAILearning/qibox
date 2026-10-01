import { groupTrigger } from './ai-group.mjs';

// Incoming obligations belong to messages, never to the latest chat revision.
// Encrypt bodies with the same account vault as long-term chat memory.
export function readGroupInbox(vault, profile) {
  return profile.groupInbox ? vault.open(profile.groupInbox) : { pending: [], settled: [], seen: null, seenAt: null };
}

export function observeGroupInbox(vault, profile, snapshot, cursor, now) {
  const inbox = readGroupInbox(vault, profile);
  inbox.pending = inbox.pending.filter(message => profile.groupOptions?.[message.trigger] === true);
  const last = snapshot.messages.at(-1);
  if (!last || inbox.seen === last.id) { profile.groupInbox = vault.seal(inbox); return inbox; }
  let boundary = snapshot.messages.findIndex(message => message.id === inbox.seen);
  if (!inbox.seen) {
    boundary = snapshot.messages.findIndex(message => message.id === (cursor?.pending ? cursor.pendingAfter : cursor?.last));
    if (boundary < 0) {
      const since = profile.replyWatchSince || profile.replyConfiguredAt;
      boundary = since ? snapshot.messages.findLastIndex(message => Number.isFinite(message.timestamp) && message.timestamp * 1000 < since) : snapshot.messages.length - 1;
    }
  }
  const ignored = [];
  const known = new Set([...inbox.pending.map(message => message.id), ...inbox.settled]);
  for (const message of snapshot.messages.slice(boundary + 1)) {
    if (known.has(message.id) || boundary < 0 && inbox.seenAt && message.timestamp * 1000 < inbox.seenAt) continue;
    const trigger = groupTrigger(message, profile.groupOptions || {});
    if (!trigger) { if (message.direction === 'other') ignored.push(message); continue; }
    const baseline = profile.groupBaselines?.[trigger];
    if (baseline && snapshot.messages.findIndex(row => row.id === baseline) >= snapshot.messages.findIndex(row => row.id === message.id)) continue;
    inbox.pending.push({ ...message, trigger, queuedAt: now });
    known.add(message.id);
  }
  inbox.seen = last.id;
  inbox.seenAt = Number.isFinite(last.timestamp) ? last.timestamp * 1000 : inbox.seenAt;
  profile.groupInbox = vault.seal(inbox);
  return { ...inbox, ignored };
}

export function nextGroupBatch(inbox, limit = 60) {
  const trigger = ['atMe', 'atAll', 'realtime'].find(key => inbox.pending.some(message => message.trigger === key));
  if (!trigger) return null;
  // Freeze the complete waiting window into one generation. The five-message
  // output limit applies to the whole group round, including every sender.
  const messages = inbox.pending.slice(0, limit);
  const sender = messages[0]?.sender;
  return { trigger, sender: sender && messages.every(message => message.sender === sender) ? sender : null,
    ids: messages.map(message => message.id), messages };
}

export function settleGroupBatch(vault, profile, batch) {
  const inbox = readGroupInbox(vault, profile), ids = new Set(batch.ids);
  inbox.pending = inbox.pending.filter(message => !ids.has(message.id));
  // The high-water mark prevents historical messages from being rediscovered.
  // Keep a recent identity window for messages sharing a timestamp.
  inbox.settled = [...new Set([...inbox.settled, ...batch.ids])].slice(-4000);
  profile.groupInbox = vault.seal(inbox);
  return inbox;
}

export function groupContextCanAdvance(before, after, generatedIds = []) {
  const originalSelf = before.messages.findLast(message => message.direction === 'self')?.id;
  const boundary = originalSelf ? after.messages.findIndex(message => message.id === originalSelf) : -1;
  if (originalSelf && boundary < 0) return false;
  return after.messages.slice(boundary + 1).filter(message => message.direction === 'self').every(message => generatedIds.includes(message.id));
}
