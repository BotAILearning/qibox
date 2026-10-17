import { AppError } from './files.mjs';
import { timingDefaults } from './ai-timing-fields.mjs';
export { timingDefaults, timingLabels } from './ai-timing-fields.mjs';
export function timingValue(value, base = timingDefaults) {
  const next = { ...base };
  for (const key of Object.keys(timingDefaults)) if (value[key] !== undefined) {
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 86400) throw new AppError('等待时间应为0–86400秒的整数');
    next[key] = value[key];
  }
  if (next.replyMaxWait < next.replyDelay || next.segmentDelayMax < next.segmentDelayMin || next.followUpDelayMax < next.followUpDelayMin) throw new AppError('最长等待不能小于最短等待');
  return next;
}
export function effectiveTiming(settings, profile) { return { ...timingDefaults, ...Object.fromEntries(Object.keys(timingDefaults).map(key => [key, profile?.timing?.[key] ?? settings[key] ?? timingDefaults[key]])) }; }
export const mergeDueAt = (cursor, timing) => Math.min(cursor.changedAt + timing.replyDelay * 1000, (cursor.pendingSince ?? cursor.changedAt) + timing.replyMaxWait * 1000);
