// 联系人/群聊列表排序规则（联系人与群聊同一规则）：
// 1. 已设置自动回复的排在前面，未设置自动回复的排在后面；
// 2. 已设置：按设置自动回复的时间先后排序（先设置的在前），设置时间取
//    「学习完成时间 learnedAt」与「手动配置时间 replyConfiguredAt」中最早的一次；
// 3. 未设置：按最新消息时间 lastChatAt 倒序（最新消息的在前），无消息时保持目录顺序。
export function hasReplyStyle(profile) {
  return profile?.replyStyleSet ?? !!(profile?.learnedAt || profile?.replyConfiguredAt && profile?.style?.summary);
}
function replySetAt(profile) {
  if (!hasReplyStyle(profile)) return Number.MAX_SAFE_INTEGER;
  const at = Math.min(profile?.learnedAt || Infinity, profile?.replyConfiguredAt || Infinity);
  return Number.isFinite(at) && at > 0 ? at : Number.MAX_SAFE_INTEGER;
}
export function orderedContacts(contacts, profiles) {
  const byContact = new Map(profiles.map(p => [p.contact, p]));
  return [...contacts].sort((a, b) => {
    const ha = hasReplyStyle(byContact.get(a.id)), hb = hasReplyStyle(byContact.get(b.id));
    if (ha !== hb) return Number(hb) - Number(ha);
    if (ha) return replySetAt(byContact.get(a.id)) - replySetAt(byContact.get(b.id)) ||
      (a.contactOrder ?? Number.MAX_SAFE_INTEGER) - (b.contactOrder ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id);
    return (b.lastChatAt || 0) - (a.lastChatAt || 0) ||
      (a.contactOrder ?? Number.MAX_SAFE_INTEGER) - (b.contactOrder ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id);
  });
}
