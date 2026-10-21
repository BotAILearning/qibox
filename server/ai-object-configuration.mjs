import { isDeepStrictEqual } from 'node:util';
import { AppError } from './files.mjs';
import { withConfigurationCommit, configurationSnapshotPatch } from './ai-configuration-commit.mjs';
import { readGroupInbox, settleGroupBatch } from './ai-group-inbox.mjs';

const copy = value => value === undefined ? undefined : structuredClone(value);
function changedFields(before, after, omitted = []) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter(key => !omitted.includes(key) && (Object.hasOwn(before || {}, key) !== Object.hasOwn(after || {}, key) || !isDeepStrictEqual(before?.[key], after?.[key])))
    .map(key => [key, { present: Object.hasOwn(after || {}, key), value: copy(after?.[key]) }]);
}
function applyFields(target, fields) {
  for (const [key, field] of fields) {
    if (field.present) target[key] = copy(field.value); else delete target[key];
  }
}
function membership(before, after) {
  const removed = new Set(before.filter(value => !after.includes(value))), added = after.filter(value => !before.includes(value));
  return current => [...current.filter(value => !removed.has(value)), ...added.filter(value => !current.includes(value))];
}
function mapChanges(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(key => before.has(key) !== after.has(key) || !isDeepStrictEqual(before.get(key), after.get(key)))
    .map(key => [key, { before: { present: before.has(key), value: copy(before.get(key)) }, present: after.has(key), value: copy(after.get(key)) }]);
}
function mapValue(target, key, field) {
  return field && target.has(key) === field.before.present && isDeepStrictEqual(target.get(key), field.before.value)
    ? field : { present: target.has(key), value: target.get(key) };
}
function applyMap(target, changes) {
  for (const [key, change] of changes) {
    const field = mapValue(target, key, change);
    if (field.present) { if (field === change) target.set(key, copy(field.value)); } else target.delete(key);
  }
}
function cursorValue(cursor) {
  return { revision: cursor.revision, last: cursor.last, own: cursor.own, sent: cursor.sent, changedAt: cursor.changedAt,
    pending: !!cursor.pending, pendingSince: cursor.pendingSince, pendingAfter: cursor.pendingAfter, sender: cursor.sender };
}

// All preparation is synchronous and runs in a small shadow of the affected
// containers. Live configuration is restored before the first persistence await.
// Publish only changed fields, never a whole old data/profile snapshot: receipts
// and history that arrive independently while storage is busy must survive.
export async function commitObjectConfiguration(a, id, change, { invalidate = false } = {}) {
  const account = a.data.account, finished = Promise.withResolvers(), pending = { id, account, finished };
  a.pendingObjectConfiguration = pending;
  try {
    return await withConfigurationCommit(a, async persist => {
      if (account !== a.data.account) throw new AppError('微信账号已变化，请重新保存对象设置', 409, 'AI_SCOPE_CHANGED');
      const live = a.data, maps = { cursors: a.cursors, followUps: a.followUps, skipReplyWaits: a.skipReplyWaits };
      const staged = { ...live, profiles: Object.fromEntries(Object.entries(live.profiles).map(([key, profile]) => [key, key === id ? copy(profile) : { ...profile }])),
        settings: { ...live.settings }, replyTargets: [...live.replyTargets], proactiveTargets: [...live.proactiveTargets], targets: [...live.targets],
        queue: { ...live.queue, items: copy(live.queue.items) }, events: [...live.events] };
      const cursors = new Map([...maps.cursors].map(([key, value]) => [key, copy(value)]));
      let cursorChanges, followUpChanges, skipped, result;
      const wasSkipped = maps.skipReplyWaits.has(id);
      const wasStaging = a.objectConfigurationStaging;
      a.data = staged; a.cursors = cursors; a.followUps = new Map(maps.followUps); a.skipReplyWaits = new Set(maps.skipReplyWaits); a.objectConfigurationStaging = true;
      try {
        result = change(staged.profiles[id]);
        if (result?.then) throw new Error('Object configuration preparation must be synchronous');
        cursorChanges = mapChanges(maps.cursors, a.cursors); followUpChanges = mapChanges(maps.followUps, a.followUps);
        skipped = a.skipReplyWaits.has(id);
      } finally { a.data = live; a.cursors = maps.cursors; a.followUps = maps.followUps; a.skipReplyWaits = maps.skipReplyWaits; a.objectConfigurationStaging = wasStaging; }
      const profileChanges = [...new Set([...Object.keys(live.profiles), ...Object.keys(staged.profiles)])].map(key => {
        const before = live.profiles[key], after = staged.profiles[key];
        let settled = [];
        if (before?.groupInbox !== after?.groupInbox && after?.groupInbox) {
          const oldInbox = readGroupInbox(a.vault, before || {}), newInbox = readGroupInbox(a.vault, after);
          settled = [...new Set([...oldInbox.pending.filter(message => !newInbox.pending.some(row => row.id === message.id)).map(message => message.id),
            ...newInbox.settled.filter(messageId => !oldInbox.settled.includes(messageId))])];
        }
        return { key, removed: !Object.hasOwn(staged.profiles, key), settled,
          fields: changedFields(before, after, ['groupInbox', 'replyCursor']) };
      }).filter(row => row.removed || row.fields.length || row.settled.length);
      const settings = changedFields(live.settings, staged.settings), queue = changedFields(live.queue, staged.queue, ['items']);
      const lists = ['replyTargets', 'proactiveTargets', 'targets'].map(key => [key, membership(live[key], staged[key])]);
      const stagedQueue = new Map(staged.queue.items.map(row => [row.id, row])), oldQueue = new Map(live.queue.items.map(row => [row.id, row]));
      const removedQueue = new Set(live.queue.items.filter(row => !stagedQueue.has(row.id)).map(row => row.id));
      const addedQueue = staged.queue.items.filter(row => !oldQueue.has(row.id));
      const queueRows = staged.queue.items.filter(row => oldQueue.has(row.id)).map(row => [row.id, changedFields(oldQueue.get(row.id), row)]);
      const oldEvents = new Set(live.events.map(row => row.id)), addedEvents = staged.events.filter(row => !oldEvents.has(row.id));
      const patch = target => {
        for (const row of profileChanges) {
          if (row.removed) delete target.profiles[row.key];
          else {
            target.profiles[row.key] ||= {}; applyFields(target.profiles[row.key], row.fields);
            // Closing a round settles only its observed obligations. New group
            // traffic collected while persistence is pending belongs to a later round.
            if (row.settled.length) settleGroupBatch(a.vault, target.profiles[row.key], { ids: row.settled });
          }
        }
        applyFields(target.settings, settings); applyFields(target.queue, queue);
        for (const [key, update] of lists) target[key] = update(target[key]);
        target.queue.items = target.queue.items.filter(row => !removedQueue.has(row.id));
        for (const [key, fields] of queueRows) { const row = target.queue.items.find(item => item.id === key); if (row) applyFields(row, fields); }
        for (const row of addedQueue) if (!target.queue.items.some(item => item.id === row.id)) target.queue.items.push(copy(row));
        if (addedEvents.length) target.events = [...copy(addedEvents), ...target.events].slice(0, 2000);
        if (a.bridge.stableMessageIds && target.profiles[id]) {
          const cursor = mapValue(maps.cursors, id, cursorChanges.find(([key]) => key === id)?.[1]).value;
          if (cursor) target.profiles[id].replyCursor = cursorValue(cursor); else delete target.profiles[id].replyCursor;
        }
      };
      // These callers previously cancelled learning before their save. Preserve
      // that boundary after validation, without dropping unrelated prepared replies.
      if (invalidate) a.invalidate({ preservePreparedReplies: true });
      await persist({ [configurationSnapshotPatch]: patch });
      if (a.data !== live || a.data.account !== account) throw new AppError('微信账号已变化，请重新读取对象设置', 409, 'AI_SCOPE_CHANGED');
      patch(live); applyMap(maps.cursors, cursorChanges); applyMap(maps.followUps, followUpChanges);
      if (skipped !== wasSkipped && maps.skipReplyWaits.has(id) === wasSkipped) {
        if (skipped) maps.skipReplyWaits.add(id); else maps.skipReplyWaits.delete(id);
      }
      return a.publicState();
    });
  } finally {
    if (a.pendingObjectConfiguration === pending) a.pendingObjectConfiguration = null;
    finished.resolve();
  }
}
