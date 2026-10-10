import { annotateChatTimes } from './ai-time-context.mjs';
// A local final check: it never invokes a provider or asks for another draft.
const clean = value => String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff*_`]/g, '');
const parts = value => clean(value).split(/[。！？!?，,；;\n]/).map(x => x.trim()).filter(Boolean);
const attributed = value => /^(?:你|您|他|她|别人|对方|那个人|例如|比如|如果|假如|假设)|(?:说|写|问|原话|引用)[：:]?[“"「]|[“"「].*[”"」]/.test(value);
const livePlace = /^(?:嗯|哈哈|好|对|是的)?\s*我(?:现在|这会儿|目前|这边)?(?:就|还|正)?在(家|公司|办公室|单位|学校|医院|外地|路上)(?:呢|里|这边|休息|上班|忙|[\s。！？!?，,；;]|$)/;
const employmentDenial = /^我(?:现在|目前|今天)?(?:没有|没|不)(?:有)?(?:在)?(?:哪家|任何|什么|一家)?(?:公司|单位)(?:里)?(?:上班|工作)/;
const futureNotice = /等我(?:确认|确定|定下来|有消息|有结果)(?:一下|下|时间)?(?:了|后|以后|之后)?[^。！？!?，,；;\n]{0,16}(?:再|就|会)?(?:告诉|通知|联系|回复|跟(?:你|您)说|给(?:你|您)发(?:消息|信息))(?:你|您)?(?:一声|一下)?$/;
const confirmThenNotice = /我(?:先|再)?(?:确认|确定)(?:一下|下)?[^。！？!?，,；;\n]{0,16}(?:再|就|后|然后)(?:回|回复|告诉|通知|联系)(?:你|您)|我(?:先|再)?(?:确认|确定)(?:一下|下)?[^。！？!?，,；;\n]{0,16}(?:再|就|后|然后)跟(?:你|您)说/;

export function unsupportedPersonalAnswer(texts, { messages = [], facts = '', now = Date.now() } = {}) {
  const human = messages.filter(m => m.direction === 'self' && m.authorship === 'human' && !m.aiGenerated
    && Number.isSafeInteger(m.timestamp) && m.timestamp * 1000 <= now && now - m.timestamp * 1000 <= 86400000).map(m => clean(m.text));
  // Strategy facts are user supplied. Require a first-person statement; facts
  // about a recipient, a quote or a home address do not prove live presence.
  const supplied = parts(facts).filter(p => !attributed(p) && /^我(?:本人)?/.test(p)).map(p => p.replace(/^我本人/, '我'));
  const evidence = [...human.flatMap(parts).filter(p => !attributed(p)), ...supplied];
  for (const text of [...texts, texts.join('')]) for (const part of parts(text)) {
    if (attributed(part) || /(?:不是说|别说|不能说|没有说|不代表|未确认|说不准|不确定)/.test(part)) continue;
    const place = livePlace.exec(part);
    if (place && !evidence.some(p => livePlace.exec(p)?.[1] === place[1])) return 'personal-fact';
    if (employmentDenial.test(part) && !evidence.some(p => employmentDenial.test(p))) return 'personal-fact';
    if ((futureNotice.test(part) || confirmThenNotice.test(part)) && !/^(?:不用|不必|别|不要)|不(?:会|承诺|保证)/.test(part)) return 'future-notice';
  }
  return '';
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
    if (/(?:昨天|昨日)(?:刚)?(?:听|看|见)(?:到)?你(?:说|提|发)|(?:昨天|昨日)你(?:说|提|发)/.test(part) && !heardYesterday) return 'time-fact';
  }
  return '';
}
