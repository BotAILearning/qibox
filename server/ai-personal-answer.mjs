import { annotateChatTimes } from './ai-time-context.mjs';
// A local final check: it never invokes a provider or asks for another draft.
const clean = value => String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff*_`]/g, '');
const parts = value => clean(value).split(/[。！？!?，,；;\n]/).map(x => x.trim()).filter(Boolean);
const attributed = value => /^(?:你|您|他|她|别人|对方|那个人|例如|比如|如果|假如|假设)|(?:说|写|问|原话|引用)[：:]?[“"「]|[“"「].*[”"」]/.test(value);
const livePlace = /^(?:嗯|哈哈|好|对|是的)?\s*我(?:现在|这会儿|目前|这边)?(?:就|还|正)?在(家|公司|办公室|单位|学校|医院|外地|路上)(?:呢|里|这边|休息|上班|忙|[\s。！？!?，,；;]|$)/;
const employmentDenial = /^我(?:现在|目前|今天)?(?:没有|没|不)(?:有)?(?:在)?(?:哪家|任何|什么|一家)?(?:公司|单位)(?:里)?(?:上班|工作)/;
const futureNotice = /等我(?:确认|确定|定下来|有消息|有结果)(?:一下|下|时间)?(?:了|后|以后|之后)?[^。！？!?，,；;\n]{0,16}(?:再|就|会)?(?:告诉|通知|联系|回复|(?:跟|和)(?:你|您)(?:说|定(?:时间|下来|好)?)|给(?:你|您)发(?:消息|信息))(?:你|您)?(?:一声|一下)?$/;
const confirmThenNotice = /我(?:先|再)?(?:确认|确定)(?:一下|下)?[^。！？!?，,；;\n]{0,16}(?:再|就|后|然后)(?:回|回复|告诉|通知|联系)(?:你|您)|我(?:先|再)?(?:确认|确定)(?:一下|下)?[^。！？!?，,；;\n]{0,16}(?:再|就|后|然后)(?:跟|和)(?:你|您)(?:说|定(?:时间|下来|好)?)/;
const futureCheck = /我(?:先|再|回头|稍后|到时候|到时|待会儿?)?(?:确认|确定)(?:一下|下)(?:具体)?(?:时间|几点|安排)?(?:再说)?$/;
const deferredNotice = /^(?:那|好[的吧]?|嗯)?(?:我)?(?:回头|稍后|到时候|到时|待会儿?)(?:再|就|会)?(?:告诉|通知|联系|回复|(?:跟|和)(?:你|您)说|给(?:你|您)发(?:消息|信息))(?:你|您)?(?:一声|一下)?$/;
const deferredPlanning = /^(?:(?:具体)?(?:几点|时间))?(?:到时候|到时|回头|以后|稍后)(?:再|就|会)?(?:定|确定|确认|商量|约|对|核对)(?:下|一下|具体时间|时间|好)?$/;
const eventThenNotice = /^等(?:到)?[^。！？!?；;\n]{1,32}(?:了|后|以后|之后)[，,]?\s*(?:我)?(?:再|就|会)(?:告诉(?:你|您)|通知(?:你|您)|联系(?:你|您)|回复(?:你|您)|(?:跟|和)(?:你|您)说|给(?:你|您)发(?:消息|信息))(?:一声|一下)?$/;
const unknownSelf = /^(?:这个|这边|这事)?我(?:这边|自己|现在|暂时|还真|目前)?(?:的)?(?:具体情况|情况|位置|工作)?(?:还|也|真|暂时)?(?:说不(?:太)?上来|说不太上|说不上来|不知道|不清楚|不太清楚)/;
const privacyReason = /^(?:我(?:这边|现在|目前)?(?:的)?(?:位置|地点)?|这个|这边|位置)[^。！？!?，,；;\n]{0,8}不(?:太)?方便(?:说|透露)/;
const plannedDelivery = /^(?:那|好[的吧]?|嗯)?(?:我)?(下次|回头|明天|周[一二三四五六日天])(?:再|就|会)?(?:给|帮|替)(?:你|您)(带|拿|送|取)(?:点|些|一点|一些)?(.{1,24})$/;
const plannedInvitation = /^(?:那|好[的吧]?|嗯)?(?:我)?(下次|回头|明天|周[一二三四五六日天])(.{0,24}?)(叫上|喊上|约|带上)(?:你|您)(.{0,12})$/;

export function unsupportedPersonalAnswer(texts, { messages = [], pendingMessages = [], facts = '', boundaries = '', now = Date.now(), identityAsked = false } = {}) {
  if (unsupportedRecipientHelp(texts, { messages, facts })) return 'recipient-fact';
  // A counterpart's future result does not create a callback or let the
  // sender observe it. Keep the comma so split conditional clauses are
  // checked together, while ordinary recipient instructions stay intact.
  for (const text of [...texts, texts.join('')]) for (const sentence of clean(text).split(/[。！？!?；;\n]/).map(x => x.trim())) {
    if (!attributed(sentence) && !/^(?:不用|不必|别|不要)|不(?:会|承诺|保证)/.test(sentence) && eventThenNotice.test(sentence)) return 'future-notice';
  }
  const human = messages.filter(m => m.direction === 'self' && m.authorship === 'human' && !m.aiGenerated
    && Number.isSafeInteger(m.timestamp) && m.timestamp * 1000 <= now && now - m.timestamp * 1000 <= 86400000).map(m => clean(m.text));
  // Strategy facts are user supplied. Require a first-person statement; facts
  // about a recipient, a quote or a home address do not prove live presence.
  const supplied = parts(facts).filter(p => !attributed(p) && /^我(?:本人)?/.test(p)).map(p => p.replace(/^我本人/, '我'));
  const evidence = [...human.flatMap(parts).filter(p => !attributed(p)), ...supplied];
  const pending = pendingMessages.filter(m => m.direction === 'other');
  const singleAIQuestion = identityAsked && pending.length === 1 && /AI|人工智能|机器人|自动回复|代回复|\bbot\b/i.test(clean(pending[0].text));
  const locationQuestion = pending.some(m => /(?:你|您).{0,6}(?:在哪|在哪里|在什么|位置|地点)/.test(clean(m.text)));
  const employmentQuestion = pending.some(m => /(?:你|您).{0,6}(?:哪家|哪个|什么)(?:公司|单位).{0,3}(?:上班|工作)/.test(clean(m.text)));
  const privacyAllowed = /不(?:说|透露|分享)(?:我)?(?:位置|地点|行踪)|(?:位置|地点|行踪).{0,6}(?:保密|不说|不透露)/.test(clean(boundaries)) || evidence.some(p => privacyReason.test(p));
  const planNotDelegated = pending.some(m => /(?:不用|不必|别|不要|先别)(?:再)?(?:替|帮)(?:我|我们)(?:确定|决定|定|约|安排)/.test(clean(m.text)));
  for (const text of [...texts, texts.join('')]) for (const part of parts(text)) {
    if (attributed(part) || /(?:不是说|别说|不能说|没有说|不代表|未确认|说不准|不确定)/.test(part)) continue;
    if ((locationQuestion || employmentQuestion) && unknownSelf.test(part)) return 'unknown-self';
    const place = livePlace.exec(part);
    if (place && !evidence.some(p => livePlace.exec(p)?.[1] === place[1])) return 'personal-fact';
    if (employmentDenial.test(part) && !evidence.some(p => employmentDenial.test(p))) return 'personal-fact';
    if (locationQuestion && privacyReason.test(part) && !privacyAllowed) return 'personal-fact';
    // A contextual bare denial must not become a false guarantee about who
    // typed the message. This check runs only at the final local boundary.
    if (singleAIQuestion && /^(?:不是|并不是|没有)(?:的|啊|呀|啦|呢|哦)?$|^(?:我|这|现在的回复)(?:真的)?不是(?:AI|人工智能|机器人|自动回复)/i.test(part)) return 'identity-rule';
    const delivery = plannedDelivery.exec(part);
    if (delivery && !evidence.some(p => { const known = plannedDelivery.exec(p); return known && known.slice(1).join('\0') === delivery.slice(1).join('\0'); })) return 'future-notice';
    const invitation = plannedInvitation.exec(part);
    if (invitation && !evidence.some(p => { const known = plannedInvitation.exec(p); return known && known.slice(1).join('\0') === invitation.slice(1).join('\0'); })) return 'future-notice';
    if (planNotDelegated && /^(?:那|就|我们|咱们|我|先){0,3}(?:定|约|安排|确定)(?:好|下|了|在|为|成)?(?:下周|这周|周[一二三四五六日天]|明天|后天|计划|安排)/.test(part)) return 'future-notice';
    if ((futureNotice.test(part) || confirmThenNotice.test(part) || futureCheck.test(part) || deferredNotice.test(part) || deferredPlanning.test(part)) && !/^(?:不用|不必|别|不要)|不(?:会|承诺|保证)/.test(part)) return 'future-notice';
  }
  return '';
}

// Thanking somebody for helping asserts that they participated. A relative's
// activity does not establish that participation, and generated/quoted or
// merely planned help cannot establish it either.
function unsupportedRecipientHelp(texts, { messages, facts }) {
  const evidence = messages.filter(m => !m.aiGenerated && (m.direction === 'other' || m.direction === 'self' && m.authorship === 'human'))
    .flatMap(m => parts(m.text).map(text => ({ text, subject: m.direction === 'other' ? '我' : '你' })));
  for (const text of [...texts, texts.join('')]) for (const part of parts(text)) {
    if (attributed(part) || /不是|别说|不代表/.test(part)) continue;
    const claim = /^(?:辛苦|谢谢|多谢)(?:你|您)([^。！？!?，,；;]{0,20}?)(整理|搬东西|搬家|收拾|打包)(?:了|啦|呀|啊|哦|呢)?$/.exec(part);
    if (!claim || !/(?:帮|替)/.test(claim[1])) continue;
    const action = claim[2];
    const supported = evidence.some(({text, subject}) => new RegExp(`^${subject}(?:已经|刚刚|刚|正在|正|在)?(?:帮|替)[^。！？!?，,；;]{0,20}${action}`).test(text)
      && !/[“”"「」]|(?:没|不)(?:有|再)?(?:帮|替)|(?:准备|打算|计划|明天|以后|如果|假如|可能|要是)/.test(text))
      || parts(facts).some(text => new RegExp(`^对方(?:已经|刚刚|刚|正在|正|在)?(?:帮|替)[^。！？!?，,；;]{0,20}${action}`).test(text)
        && !/[“”"「」]|(?:没|不)(?:有|再)?(?:帮|替)|(?:准备|打算|计划|明天|以后|如果|假如|可能|要是)/.test(text));
    if (!supported) return true;
  }
  return false;
}

export function personalQuestionClarification(pendingMessages = []) {
  const pending = pendingMessages.filter(m => m.direction === 'other');
  return pending.length === 1 && /^(?:你|您)(?:今天|现在|这会儿|目前)?(?:具体)?(?:在哪(?:个)?(?:地方)?|在哪里|在哪(?:家|个)(?:公司|单位)(?:上班|工作)?)[？?。！!]?$/u.test(clean(pending[0].text).trim())
    ? '怎么了，找我有事吗？' : '';
}

export function knownDateCorrection({pendingMessages = [], messages = [], now = Date.now()} = {}) {
  const pending = pendingMessages.filter(m => m.direction === 'other');
  if (pending.length !== 1) return '';
  const correction = /^改(?:成|到)(周[一二三四五六日天])(?:吧)?(?:[，,]周[一二三四五六日天]我(?:不行|没空))?[。！？!?]?$/.exec(clean(pending[0].text).trim());
  const agreed = messages.some(m => m.direction === 'self' && m.authorship === 'human' && !m.aiGenerated
    && Number.isSafeInteger(m.timestamp) && m.timestamp * 1000 <= now && now - m.timestamp * 1000 <= 86400000
    && !attributed(clean(m.text)) && /^(?:(?:先)?按周[一二三四五六日天]记(?:着|下)|(?:我们|我)?周[一二三四五六日天].{0,8}(?:见|碰面))/.test(clean(m.text)));
  return correction && agreed ? `行，改成${correction[1]}。` : '';
}

// Check only explicit added precision and claims about when the counterpart
// spoke. A message's send time does not prove an event happened that evening.
export function unsupportedChatTime(texts, { messages = [], facts = '', now = Date.now(), timezone = 'Asia/Shanghai' } = {}) {
  const evidence = [...messages.filter(m => !m.aiGenerated && m.direction !== 'system').map(m => clean(m.text)), clean(facts)].join('\n');
  const nightWords = /昨晚|昨天晚上|昨日晚上/;
  const heardYesterday = annotateChatTimes(messages, now, timezone).some(m => m.direction === 'other' && !m.aiGenerated && m.temporal.relation === 'yesterday');
  for (const text of texts) for (const part of parts(text)) {
    if (attributed(part) || /不是|不确定|说不准|不能确定/.test(part)) continue;
    if (nightWords.test(part) && !nightWords.test(evidence)) return 'time-fact';
    if (/一年前/.test(part) && /去年/.test(evidence) && !/一年前/.test(evidence)) return 'time-fact';
    if (/(?:昨天|昨日)(?:刚)?(?:听|看|见)(?:到)?你(?:说|提|发)|(?:昨天|昨日)你(?:说|提|发)/.test(part) && !heardYesterday) return 'time-fact';
  }
  const visitingDuration = /^(?:你|您)?(?:今天)?见(?:了)?(一整天|整整一天|一天)朋友/;
  const durationEvidence = messages.filter(m => m.direction === 'other' && !m.aiGenerated).flatMap(m => parts(m.text))
    .filter(p => !/[“”"「」]|(?:没|不)(?:有)?见|准备|打算|计划|如果|假如|明天/.test(p))
    .map(p => p.replace(/^我/, ''));
  durationEvidence.push(...parts(facts).filter(p => /^对方/.test(p) && !/[“”"「」]|(?:没|不)(?:有)?见|准备|打算|计划|如果|假如|明天/.test(p)).map(p => p.replace(/^对方/, '')));
  for (const text of [...texts, texts.join('')]) for (const part of parts(text)) {
    if (/(?:说|引用)[：:]?[“"「]|[“"「].*[”"」]|^(?:如果|假如|不是|不用|别)/.test(part)) continue;
    if (visitingDuration.test(part) && !durationEvidence.some(p => visitingDuration.test(p))) return 'time-fact';
  }
  return '';
}
