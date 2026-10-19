import { timingDefaults } from './ai-timing-fields.mjs';

// Read-through migration: never rewrite legacy mixed overrides just by opening
// settings or saving another field. Old multiTurn controls follow-up requests;
// ordinary replies already allowed segments independently of that switch.
export function replyRhythm(settings = {}, profile) {
  const global = {
    timing: Object.fromEntries(Object.keys(timingDefaults).map(key => [key, settings[key] ?? timingDefaults[key]])),
    takeover: settings.takeover || { enabled: true, minutes: 5 },
    segmentReplies: settings.segmentReplies ?? true,
    followUpEnabled: settings.followUpEnabled ?? settings.multiTurn ?? false,
  };
  if (!profile) return global;
  if (profile.rhythm) return profile.rhythm.inherit ? global : profile.rhythm.personal;
  return {
    timing: { ...global.timing, ...profile.timing },
    takeover: profile.takeover || global.takeover,
    segmentReplies: global.segmentReplies,
    followUpEnabled: profile.replyOptions?.multiTurn ?? global.followUpEnabled,
  };
}

export function inheritsReplyRhythm(profile) {
  return profile?.rhythm ? profile.rhythm.inherit : !profile?.timing && !profile?.takeover && typeof profile?.replyOptions?.multiTurn !== 'boolean';
}
