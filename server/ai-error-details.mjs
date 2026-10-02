// Error records are evidence snapshots, not reconstructed chat history. Only
// this allowlist may leave the service; provider bodies and arbitrary metadata
// must never be serialized into an error record.
export const errorStages = { read: '读取聊天记录', media: '处理消息内容', model: '生成回复', 'role-check': '发送前角色核验', send: '提交微信发送', confirm: '确认发送结果', learning: '学习风格与记忆', 'default-style': '汇总默认风格', unknown: '历史记录未保存阶段' };
const sources = { reply: '自动回复', proactive: '主动聊天', atMe: '群聊 @我', atAll: '群聊 @所有人', realtime: '群聊实时回复', learning: '学习风格与记忆', 'default-style': '汇总默认风格' };
const ids = value => typeof value === 'string' && value.length <= 180 && !/[\s<>"']/u.test(value) ? value : null;
export function safeErrorText(value, secrets = [], limit = 2000) {
  let text = typeof value === 'string' && value.trim() ? value.trim() : 'AI 操作暂未完成，稍后重试';
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[已隐藏凭据]');
  return text.replace(/\b(?:Bearer|Basic)\s+[\w.+/=-]+/gi, '[已隐藏凭据]')
    .replace(/\b(?:sk|sess)-[\w-]{8,}/gi, '[已隐藏凭据]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"';&}]+/gi, '$1[已隐藏凭据]')
    .replace(/https?:\/\/[^\s/:]+:[^\s/@]+@/gi, 'https://[已隐藏凭据]@')
    .replace(/data:[^\s,]*;base64,[\w+/=]+/gi, '[已隐藏媒体数据]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit);
}
export function errorClassification(code, message, stage = 'unknown') {
  const safeCode = typeof code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? code : null;
  const role = safeCode === 'ai_role_blocked' || /发言归属核对结果无效|发言归属仍有冲突|回复角色与当前微信账号不一致/.test(message);
  const actualStage = role ? 'role-check' : stage === 'unknown' && /模型响应超时|模型连接失败/.test(message) ? 'model' : Object.hasOwn(errorStages, stage) ? stage : 'unknown';
  const type = role ? '角色核验未通过' : safeCode === 'ai_model_schema' ? '模型结果无效' : safeCode === 'ai_model_no_text' ? '模型未生成文字回复'
    : safeCode === 'ai_context_limit' ? '模型上下文超限' : safeCode === 'ai_model_vision_unsupported' ? '模型不支持图片'
      : /超时/.test(message) ? '操作超时' : /限流|频率|429/.test(message) ? '请求受限'
        : /连接失败|连接中断|网络/.test(message) ? '连接失败' : actualStage === 'send' ? '发送未提交'
          : code === 'truncated' ? '聊天内容截断' : '操作未完成';
  return { stage: actualStage, stageLabel: errorStages[actualStage], type, ...(safeCode ? { errorCode: safeCode } : {}) };
}
export function captureErrorContext(ai, target, metadata = {}, message = '') {
  const profile = ai.data.profiles[target];
  const verified = profile?.account === ai.data.account ? profile : null;
  const requestedContact = metadata.contact || verified?.contact;
  const contact = ai.contacts.get(requestedContact);
  const task = ai.data.proactiveTasks?.find(row => row.id === metadata.taskId && row.account === ai.data.account);
  const secrets = ai.errorSecrets();
  const label = value => safeErrorText(value, secrets, 120);
  const classification = errorClassification(metadata.errorCode, message, metadata.stage);
  const context = { version: 1, ...classification,
    ...(Object.hasOwn(sources, metadata.source) ? { source: metadata.source, sourceLabel: sources[metadata.source] } : {}),
    ...(verified ? { profileId: verified.id } : {}),
    ...(verified || contact ? { contact: verified?.contact || contact.id, label: label(contact?.label || verified.label), kind: contact?.kind || verified.kind,
      ...((contact?.nickname || verified?.nickname) ? { nickname: label(contact?.nickname || verified.nickname) } : {}) } : {}),
    ...(task ? { taskId: task.id, taskName: label(task.name) } : {}),
    ...(ids(metadata.operationId) ? { operationId: metadata.operationId } : {}),
    ...(ids(metadata.relatedSkipEventId) ? { relatedSkipEventId: metadata.relatedSkipEventId } : {}),
    ...(ids(metadata.proactiveRecordId) ? { proactiveRecordId: metadata.proactiveRecordId } : {}) };
  const rows = (verified || contact ? Array.isArray(metadata.incomingMessages) ? metadata.incomingMessages : [] : []).filter(row => row && row.direction === 'other' && ids(row.id));
  context.incomingIds = [...new Set(rows.map(row => row.id))].slice(-24);
  // Keep a small encrypted diagnostic excerpt. The full chat is neither copied
  // into the error text nor read later to fill holes in a historical record.
  const messages = rows.slice(-3).map(row => ({ id: row.id, direction: 'other',
    text: typeof row.text === 'string' && row.text ? safeErrorText(row.text, secrets, 350) : '',
    ...(typeof row.senderName === 'string' ? { senderName: label(row.senderName) } : {}),
    ...(/^[a-f0-9]{64}$/.test(row.sender || row.senderId || '') ? { senderId: row.sender || row.senderId } : {}),
    ...(typeof row.type === 'string' && /^[a-z-]{1,24}$/.test(row.type) ? { type: row.type } : {}),
    ...(Number.isSafeInteger(row.timestamp) && row.timestamp > 0 ? { timestamp: row.timestamp } : {}),
    ...(typeof row.text === 'string' && row.text.length > 350 ? { truncated: true } : {}) }));
  if (messages.length) {
    context.evidenceScope = metadata.evidenceScope === 'chat-context' ? 'chat-context' : 'pending-incoming';
    context.evidenceSnapshot = ai.vault.seal({ messages, total: rows.length, truncated: rows.length > 3 || messages.some(row => row.truncated) });
  }
  return context;
}
export function relatedErrorRecord(ai, record) {
  const context = record.context || {};
  if (record.account !== ai.data.account) return null;
  if (context.proactiveRecordId) {
    const row = ai.data.proactiveRecords?.find(row => row.id === context.proactiveRecordId && row.account === record.account && (!context.taskId || row.taskId === context.taskId));
    if (row && row.profileId === record.target && context.profileId === row.profileId && context.contact === row.contact && !(ai.data.deletedActivityRecords || []).some(item => item.account === record.account && item.source === 'proactive' && item.id === row.id)) return { source: 'proactive', id: row.id, taskId: row.taskId };
  }
  if (context.relatedSkipEventId) {
    const row = ai.data.skipLog?.find(row => row.id === context.relatedSkipEventId && row.account === record.account && row.target === record.target);
    if (row && !(ai.data.deletedActivityRecords || []).some(item => item.account === record.account && item.source === 'skip' && item.id === row.id)) return { source: 'skip', id: row.id };
  }
  return null;
}
export function publicErrorRecord(ai, record) {
  const secrets = ai.errorSecrets(), message = safeErrorText(record.message, secrets);
  const saved = record.account === ai.data.account && record.context?.version === 1 ? record.context : null;
  const profile = ai.data.profiles[saved?.profileId || record.target];
  const verified = profile?.account === ai.data.account && (!saved?.contact || profile.contact === saved.contact) ? profile : null;
  const contact = verified && ai.contacts.get(verified.contact);
  const context = { ...errorClassification(saved?.errorCode || record.code, message, saved?.stage),
    stageBasis: saved?.stage && saved.stage !== 'unknown' ? 'occurrence' : 'saved-reason',
    ...(Object.hasOwn(sources, saved?.source) ? { sourceLabel: sources[saved.source] } : {}),
    ...(saved?.label ? { label: safeErrorText(saved.label, secrets, 120), labelBasis: 'occurrence' } : verified ? { label: safeErrorText(contact?.label || verified.label, secrets, 120), labelBasis: contact ? 'current' : 'saved-profile' } : {}),
    ...(['person', 'group'].includes(saved?.kind || verified?.kind) ? { kind: saved?.kind || verified.kind } : {}),
    ...(typeof saved?.taskName === 'string' && saved.taskName.trim() ? { taskName: safeErrorText(saved.taskName, secrets, 120) } : {}),
    ...(ids(saved?.operationId || record.operationId) ? { operationId: saved?.operationId || record.operationId } : {}),
    incomingIds: (Array.isArray(saved?.incomingIds) ? saved.incomingIds : []).filter(ids).slice(-24),
    ...(['chat-context', 'pending-incoming'].includes(saved?.evidenceScope) ? { evidenceScope: saved.evidenceScope } : {}),
    messages: [], evidenceNote: '这条历史异常未保存当时消息，无法确认是哪条来信。' };
  if (saved) context.evidenceNote = '当时未保存消息证据，无法确认具体来信；不会用当前聊天补齐。';
  if (saved?.evidenceSnapshot) {
    try {
      const snapshot = ai.vault.open(saved.evidenceSnapshot);
      context.evidenceScope = saved.evidenceScope === 'chat-context' ? 'chat-context' : 'pending-incoming';
      context.messages = (snapshot.messages || []).slice(-3).filter(row => ids(row.id)).map(row => ({ id: row.id, text: typeof row.text === 'string' ? safeErrorText(row.text, secrets, 350) : '',
        ...(row.senderName ? { senderName: safeErrorText(row.senderName, secrets, 120) } : {}), ...(typeof row.type === 'string' && /^[a-z-]{1,24}$/.test(row.type) ? { type: row.type } : {}),
        ...(/^[a-f0-9]{64}$/.test(row.senderId || '') ? { senderId: row.senderId } : {}),
        ...(Number.isSafeInteger(row.timestamp) && row.timestamp > 0 ? { timestamp: row.timestamp } : {}), ...(row.truncated ? { truncated: true } : {}) }));
      context.evidenceNote = saved.evidenceScope === 'chat-context' ? '以下是本次任务读取的聊天片段，用于核对上下文；不代表这些消息触发了主动任务。' : '以下是发生异常时待处理的来信摘要。';
      if (snapshot.truncated) context.evidenceNote += ' 消息较多或较长，仅保留有限摘要。';
    } catch { context.evidenceNote = '当时保存的消息摘要暂时无法读取，未使用当前聊天补齐。'; }
  }
  const related = relatedErrorRecord(ai, record);
  return { id: record.id, at: record.at, message, context,
    ...(verified && contact ? { objectTarget: contact.id } : saved?.contact && ai.contacts.has(saved.contact) ? { objectTarget: saved.contact } : {}), ...(related ? { relatedRecord: related } : {}),
    ...(record.resolution === 'sent' && Number.isFinite(record.resolvedAt) ? { resolution: 'sent', resolvedAt: record.resolvedAt } : {}) };
}
