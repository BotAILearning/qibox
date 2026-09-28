// Keep the displayed per-contact switch state consistent across AI pages.
export function personReplyEnabled(state, profile, profileId = profile?.id) {
  return !!(profile?.replyOptions?.enabled ?? (state.settings?.replyScope === 'all' || (state.replyTargets || []).includes(profileId)));
}
