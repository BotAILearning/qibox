import { styleChoice } from './ai-style-view.mjs';

// Merge only fields untouched since learning began. An old blank memory field
// is not a new edit, while typing during a pending model request must survive.
export function learnedObjectDraft(current, before, previous, learned) {
  const next = { ...current };
  const style = styleChoice(learned.pendingStyle ? {...learned,style:learned.pendingStyle,styleId:'learned',replyStyleSet:true} : learned);
  for (const key of ['summary', 'styleId']) if ((current?.[key] ?? '') === (before?.[key] ?? '')) next[key] = style[key];
  if ((current?.memorySummary ?? '') === (before?.memorySummary ?? '') &&
      (before?.memorySummary ?? previous?.memory?.summary ?? '') === (previous?.memory?.summary ?? '') && !learned.memory?.unavailable) {
    next.memorySummary = learned.memory?.summary || '';
  }
  return next;
}

