export const styleSummary = style => style?.summary || ['formality', 'warmth', 'length', 'directness', 'emoji', 'humor', 'customTone'].map(key => style?.[key]).filter(Boolean).join('，');
export function styleChoice(profile) {
  if (!profile || profile.replyStyleSet === false || (profile.source === 'default' && !profile.replyConfiguredAt && !profile.learnedAt)) return { styleId: '', summary: '' };
  return { styleId: profile.styleId ?? 'custom', summary: styleSummary(profile.style) };
}
