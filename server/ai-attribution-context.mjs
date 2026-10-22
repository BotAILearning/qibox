// Small provenance index for reply generation. Message text and image bytes
// stay in their existing input fields; this module does not infer ownership.
export const attributionContextPrompt = `理解每件事属于谁时，区分本条消息作者、引用原话作者和事情主体：作者不自动等于事情主体。结合完整原话、明确的我/你指代、上下文和引用关系理解归属；一条消息可以评论某人的事情，同时讲作者自己的事。verified quote只确认引用作者及原文，不替代原话中的指代。图片按其已绑定的messageId理解，发图者不必然是图片中事情的主体。图片中的比例、余额或消耗量本身不证明经过时长、统计周期进度或消耗速度；只有存在来源明确的起止时间或比较基准时才能作相应解释，不补造月初、月末等时间背景。memory的subjectId、scope、evidence和时间状态若存在就按其来源使用；旧记忆缺少这些字段时仍可结合原始聊天理解，不因字段缺失作废。只有语义确实无法判定时才保留不确定，不要猜测，也不要因归属不确定而改写或阻止正常回应；不要追加模型请求或向聊天对象输出归属分析。`;

const actor = value => value && typeof value === 'object'
  ? { role: value.role || 'unknown', ...(value.id ? { id: value.id } : {}) }
  : { role: 'unknown' };

/**
 * Build a compact source index to append to the existing model input.
 * @param {{messages?: object[], images?: object[], memory?: object, replyPerspective?: object}} input
 * @returns {{quoteEvidence: object[], imageEvidence: object[], memoryEvidence: object[]}}
 */
export function buildAttributionContext(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const byId = new Map(messages.filter(message => message?.id != null).map(message => [message.id, message]));
  const quoteEvidence = messages.flatMap(message => message?.quote?.verified === true && message.quote.messageId != null
    ? [{ messageId: message.id, speaker: actor(message.speaker), quote: {
      messageId: message.quote.messageId,
      speaker: actor(message.quote.speaker),
      ...(message.quote.direction ? { direction: message.quote.direction } : {}),
    } }]
    : []);
  const imageEvidence = (Array.isArray(input.images) ? input.images : [])
    .filter(image => image && image.messageId != null)
    .map(image => ({ messageId: image.messageId, speaker: actor(byId.get(image.messageId)?.speaker) }));
  const memoryEvidence = (Array.isArray(input.memory?.entries) ? input.memory.entries : []).map(entry => ({
    ...(entry.field ? { field: entry.field } : {}),
    ...(entry.scope ? { scope: entry.scope } : {}),
    ...(entry.subjectId ? { subjectId: entry.subjectId } : {}),
    ...(entry.contextRole ? { contextRole: entry.contextRole } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    ...(Array.isArray(entry.evidence) ? { evidence: entry.evidence } : {}),
  }));
  return { rules: attributionContextPrompt, quoteEvidence, imageEvidence, memoryEvidence };
}
