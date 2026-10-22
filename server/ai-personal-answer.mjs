import { annotateChatTimes } from './ai-time-context.mjs';
import { createHash } from 'node:crypto';
// A local final check: it never invokes a provider or asks for another draft.
const clean = value => String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff*_`]/g, '');
const parts = value => clean(value).split(/[。！？!?，,；;\n]/).map(x => x.trim()).filter(Boolean);
const attributed = value => /^(?:你|您|他|她|别人|对方|那个人|例如|比如|如果|假如|假设)|(?:说|写|问|原话|引用)[：:]?[“"「]|[“"「].*[”"」]/.test(value);
const livePlace = /^(?:嗯|哈哈|好|对|是的)?\s*我(?:现在|这会儿|目前|这边)?(?:就|还|正)?在(家|公司|办公室|单位|学校|医院|外地|路上)(?:呢|里|这边|休息|上班|忙|[\s。！？!?，,；;]|$)/;
const employmentDenial = /^我(?:现在|目前|今天)?(?:没有|没|不)(?:有)?(?:在)?(?:哪家|任何|什么|一家)?(?:公司|单位)(?:里)?(?:上班|工作)/;
const liveActivity = /^(?:我)?(?:现在|这会儿|目前)?(?:刚刚?|正在|正|准备|马上|打算)(?:准备)?(出门|回家|去公司|上班|下班|开车|开会|吃饭|睡觉|洗澡|工作)/;
const datedCheck = /^(?:那|好|行)?(?:周[一二三四五六日天]|明天|后天|下周)(?:我|我们|咱们)?(?:再|到时再)?(?:定|确定|确认|核对)(?:一下|下)?(?:具体)?(?:时间|几点)/;
const futureMonitoring = /^我(?:再|会|先|回头|稍后)?(?:留意|留心|盯着|跟进|注意一下|关注一下)/;
// Catch a prospective/reduplicated offer embedded after the topic, such as
// "书店那边我也留意留意". Keep this narrow: past observations such as
// "我也留意到新活动了" are not monitoring commitments.
const repeatedFutureMonitoring = /我(?:也|还)?(留意|留心|盯着|跟进|注意|关注)\1/;
const datedNotice = /^(?:那|好|行)?(?:我)?(?:明天|后天|[一二三四五六七八九十\d]+天后|周[一二三四五六日天])[^。！？!?，,；;]{0,12}(?:再|就|会)?(?:找|联系|通知|回复)(?:你|您)/;
const availabilityClaim = /^(?:我(?:现在|今天|这会儿|目前)?|(?:现在|今天|这会儿|目前))(?:这边)?(?:肯定|一定|确实)?(?:有空|没空|不忙|很忙|没(?:有)?(?:什么)?安排|没(?:有)?(?:什么)?事)/;
const deferredArrangement = /(?:等我|我|得|先).{0,10}(?:看|查|确认|核对).{0,8}(?:安排|时间|日程).{0,10}(?:再|后|就).{0,6}(?:告诉|通知|联系|跟你确认|跟你说|和你确认)/;
const futureNotice = /等我(?:确认|确定|定下来|有消息|有结果)(?:一下|下|时间)?(?:了|后|以后|之后)?[^。！？!?，,；;\n]{0,16}(?:再|就|会)?(?:告诉|通知|联系|回复|(?:跟|和)(?:你|您)(?:说|定(?:时间|下来|好)?)|给(?:你|您)发(?:消息|信息))(?:你|您)?(?:一声|一下)?$/;
const confirmThenNotice = /我(?:先|再)?(?:确认|确定)(?:一下|下)?[^。！？!?，,；;\n]{0,16}(?:再|就|后|然后)(?:回|回复|告诉|通知|联系)(?:你|您)|我(?:先|再)?(?:确认|确定)(?:一下|下)?[^。！？!?，,；;\n]{0,16}(?:再|就|后|然后)(?:跟|和)(?:你|您)(?:说|定(?:时间|下来|好)?)/;
const futureCheck = /我(?:先|再|回头|稍后|到时候|到时|待会儿?)?(?:确认|确定)(?:一下|下)(?:具体)?(?:时间|几点|安排)?(?:再说)?$/;
const deferredNotice = /^(?:那|好[的吧]?|嗯)?(?:我)?(?:回头|稍后|到时候|到时|待会儿?)(?:再|就|会)?(?:告诉|通知|联系|回复|(?:跟|和)(?:你|您)说|给(?:你|您)发(?:消息|信息))(?:你|您)?(?:一声|一下)?$/;
const deferredPlanning = /^(?:(?:具体)?(?:几点|时间))?(?:到时候|到时|回头|以后|稍后)(?:再|就|会)?(?:定|确定|确认|商量|约|对|核对)(?:下|一下|具体时间|时间|好)?$/;
const eventThenNotice = /^等(?:到)?[^。！？!?；;\n]{1,32}(?:了|后|以后|之后)[，,]?\s*(?:我)?(?:再|就|会)(?:告诉(?:你|您)|通知(?:你|您)|联系(?:你|您)|回复(?:你|您)|(?:跟|和)(?:你|您)说|给(?:你|您)发(?:消息|信息))(?:一声|一下)?$/;
const unknownSelf = /^(?:这个|这边|这事)?我(?:这边|自己|现在|暂时|还真|目前)?(?:的)?(?:具体情况|情况|位置|工作)?(?:还|也|真|暂时)?(?:说不(?:太)?上来|说不太上|说不上来|不知道|不清楚|不太清楚)/;
const ownerConfirmation = /^(?:这个|这事|具体(?:位置|工作情况))?(?:要|需要|得)(?:由)?本人(?:来)?确认(?:一下|下)?$/;
const privacyReason = /^(?:我(?:这边|现在|目前)?(?:的)?(?:位置|地点)?|这个|这边|位置)[^。！？!?，,；;\n]{0,8}不(?:太)?方便(?:说|透露)/;
const plannedDelivery = /^(?:那|好[的吧]?|嗯)?(?:我)?(下次|回头|明天|周[一二三四五六日天])(?:再|就|会)?(?:给|帮|替)(?:你|您)(带|拿|送|取)(?:点|些|一点|一些)?(.{1,24})$/;
const plannedInvitation = /^(?:那|好[的吧]?|嗯)?(?:我)?(下次|回头|明天|周[一二三四五六日天])(.{0,24}?)(叫上|喊上|约|带上)(?:你|您)(.{0,12})$/;

// Keep quotation and conditional scope until after attribution. A counterpart's
// correction alone is not evidence that the account owner previously made a
// mistake, had a thought or said something. These final checks never regenerate.
const outsideQuotes = value => clean(value).replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g, quote => `〈引用${createHash('sha256').update(quote).digest('hex')}〉`);
const sentences = value => (outsideQuotes(value).match(/[^。！？!?；;\n]+[。！？!?；;\n]?/g) || []).map(text => text.trim()).filter(Boolean);
const hypothetical = text => /(?:如果|假如|假设|要是|倘若|万一|即使|即便)/.test(text);
const reported = prefix => /(?:你|您|他|她|别人|对方)(?:们)?[^。！？!?；;]{0,12}(?:说|写|认为|以为|觉得|问)[，,:：\s]*$/.test(prefix)
  || /^(?![^，,]*我)[\u4e00-\u9fffA-Za-z·]{1,12}(?:说|表示|认为|提到|写道|问)[，,:：\s]*$/.test(prefix.trim());
function claimScope(sentence, match) {
  const start = match.index + (/^[，,]\s*/.exec(match[0])?.[0].length || 0);
  const prefix = sentence.slice(0, start), localPrefix = prefix.split(/但是|不过|然而|但/).at(-1);
  const clause = sentence.slice(start).split(/[，,]/)[0];
  return {prefix, clause, attributed: hypothetical(localPrefix) || reported(prefix) || /[？?]$/.test(clause)};
}
const normalizedClaim = value => clean(value).replace(/[\p{P}\p{S}\s]/gu, '').replace(/(?:了|过|呢|呀|啊|啦|哦|吧|哈)+$/u, '');
const historicalFault = '(?:认错|记错|说错|听错|看错|想错|理解错|理解反|搞错|弄错|搞混|记混|弄混|(?:记|搞|弄|听|说|看|理解)岔|混淆|误解|误会|没(?:有|能)?(?:分清|区分清楚|理解清楚)|(?:表达|说)(?:得)?(?:不清楚|不严谨|不准确))';
function historicalClaims(value) {
  const result = [];
  for (const sentence of sentences(value)) {
    const expressions = [
      new RegExp('我(?:自己|本人)?(?:刚才|刚刚|之前|原先|先前|刚|以前|曾经|当时|本来|原本)?(?:还|也|竟然|差点儿?|真|一直|确实|居然|都|就|一度){0,6}(?:把[^，,。！？!?；;\\n]{1,32}?)?(' + historicalFault + '|以为|误以为|误认为|遇到过|碰到过|经历过)([^，,。！？!?；;\\n]*)', 'g'),
      /我(?:自己|本人)?(?:刚才|刚刚|之前|原先|先前|以前|曾经|当时)(?:还|也|确实|就)?(说|讲|表示|答应|承诺|觉得|认为|想|纳闷|琢磨)(?:过|了)?([^，,。！？!?；;\n]*)/g,
      new RegExp('(?:^|[，,])\\s*(?:刚才|刚刚|之前|先前|原先|以前|当时)(?:还|也|确实)?(' + historicalFault + ')([^，,。！？!?；;\\n]*)', 'g'),
      new RegExp('(?:^|[，,])\\s*(?:抱歉|不好意思|对不起)[，,]?\\s*(?:刚才|刚刚|之前)?(?:还|也|确实)?(' + historicalFault + ')([^，,。！？!?；;\\n]*)(?=[，,。！!；;\\n]|$)', 'g'),
    ];
    for (const expression of expressions) for (const match of sentence.matchAll(expression)) {
      const {prefix, attributed: scopedAttribution} = claimScope(sentence, match);
      if (scopedAttribution || /(?:不是说|并非|不是|没有说|没说|不代表)[^，,。]{0,16}$/.test(prefix)) continue;
      result.push({verb: match[1], detail: normalizedClaim(match[2]), recent: /刚才|刚刚/.test(match[0])});
    }
  }
  return result;
}
function unsupportedHistoricalSelf(texts, {messages, facts, now}) {
  const human = messages.filter(message => message.direction === 'self' && message.authorship === 'human' && !message.aiGenerated
    && Number.isSafeInteger(message.timestamp) && message.timestamp * 1000 <= now);
  const supplied = parts(facts).filter(text => /^我(?:本人)?/.test(text));
  for (const claim of historicalClaims(texts.join(''))) {
    const sources = [...human.filter(message => !claim.recent || now - message.timestamp * 1000 <= 86400000).map(message => message.text), ...supplied];
    const supported = sources.some(source => historicalClaims(source).some(known => known.verb === claim.verb && known.detail === claim.detail)
      || ['说', '讲', '表示'].includes(claim.verb) && claim.detail && !hypothetical(source) && !/[“”"「」]|[？?]/.test(source)
        && parts(source).some(part => normalizedClaim(part) === claim.detail));
    if (!supported) return true;
  }
  return false;
}
function* declarativeClauses(value) {
  for (const sentence of sentences(value)) {
    if (hypothetical(sentence) || /[？?]$/.test(sentence)) continue;
    for (const match of sentence.matchAll(/(?:^|[，,])\s*([^，,。！？!?；;\n]+)/g)) {
      if (!reported(sentence.slice(0, match.index))) yield match[1].trim();
    }
  }
}
function proposition(value, subject, required = false) {
  let text = normalizedClaim(value).replace(/^(?:其实|确实|真的)/u, '');
  if (subject.test(text)) text = text.replace(subject, ''); else if (required) return null;
  text = text.replace(/^(?:其实|确实|真的)/u, '');
  const negative = /^(?:并不是|不是|并非|没有|不|没)/.exec(text);
  if (negative) text = text.slice(negative[0].length);
  // "每天都" and "每天" express the same frequency; keep every other
  // frequency, actor and predicate literal. This is not semantic inference.
  const core = text.replace(/^(每(?:天|周|月|年))都/u, '$1');
  return core ? { core, negative: !!negative } : null;
}
function unsupportedUnstatedRecipient(texts, { messages, pendingMessages, facts, now }) {
  const pending = pendingMessages.filter(message => message.direction === 'other' && !message.aiGenerated);
  if (pending.length !== 1) return false;
  const unstated = [...declarativeClauses(pending[0].text)].flatMap(clause => {
    const match = /^(?:我)?(?:也|并|还)?(?:没(?:有)?说|没(?:有)?提(?:过)?|未说|未提|没(?:有)?确认|未确认)(?:过)?(.{1,48})$/u.exec(clause);
    const claim = match && proposition(match[1], /^我(?:本人|自己)?/u);
    return claim ? [claim] : [];
  });
  if (!unstated.length) return false;
  const target = pending[0].speaker?.id, evidence = [];
  for (const message of messages) {
    if (message.aiGenerated || !Number.isSafeInteger(message.timestamp) || message.timestamp * 1000 > now) continue;
    const recipient = message.direction === 'other' && (target ? message.speaker?.id === target : !message.speaker);
    if (!recipient && !(message.direction === 'self' && message.authorship === 'human')) continue;
    for (const clause of declarativeClauses(message.text)) {
      const claim = proposition(clause, recipient ? /^我(?:本人|自己)?/u : /^(?:你|您)/u, true);
      if (claim) evidence.push(claim);
    }
  }
  for (const clause of declarativeClauses(facts)) {
    const claim = proposition(clause.replace(/^联系人事实[：:]/u, ''), /^对方/u, true);
    if (claim) evidence.push(claim);
  }
  for (const clause of declarativeClauses(texts.join(''))) {
    const claim = proposition(clause, /^(?:你|您)/u);
    if (claim && unstated.some(unknown => unknown.core === claim.core)
        && !evidence.some(known => known.core === claim.core && known.negative === claim.negative)) return true;
  }
  return false;
}
// This is a narrow name check, not a classifier for every "you are" predicate.
const nameToken = value => clean(value).trim().replace(/[呢呀啊哦啦吧]$/u, '');
function personName(value) {
  return /^(?:[阿小老][\p{Script=Han}]{1,3}|[张王李赵陈刘杨黄周吴徐孙马朱胡郭何林高罗郑][\p{Script=Han}]{1,2}|[A-Z][a-z]{1,20})$/u.test(value)
    && !/[的地得不没未]/u.test(value)
    && !/^(?:老师|老板|老人|老实人|老好人|老员工|老同事|老朋友|小学生|小孩子|小朋友|小心|阿姨|阿婆|阿公|阿爸|阿妈|Doctor|Driver|Teacher|Engineer|Student)$/u.test(value);
}
function declaredNames(value) {
  const names = [];
  for (const clause of declarativeClauses(value)) {
    const explicit = /^(?:我(?:本人|自己)?(?:名叫|叫|的名字是|的姓名是|名字叫|姓名叫)|(?:以后)?叫我)([\p{L}\p{N}· -]{1,32})$/u.exec(clause);
    if (explicit) names.push(nameToken(explicit[1]));
    const familiar = /^我(?:本人|自己)?是(.{1,12})$/u.exec(clause);
    if (familiar && personName(nameToken(familiar[1]))) names.push(nameToken(familiar[1]));
  }
  return names;
}
function unsupportedRecipientName(texts, {messages, pendingMessages, facts, now, kind}) {
  const pending = pendingMessages.filter(message => message.direction === 'other' && !message.aiGenerated);
  if (pending.length !== 1) return false;
  const denied = new Set();
  for (const clause of declarativeClauses(pending[0].text)) {
    const explicit = /^我(?:本人|自己)?(?:不叫|不是叫|名字不是|姓名不是)([\p{L}\p{N}· -]{1,32})$/u.exec(clause);
    const familiar = /^我(?:本人|自己)?(?:不是|并非)(.{1,12})$/u.exec(clause);
    if (explicit) denied.add(nameToken(explicit[1]));
    if (familiar && personName(nameToken(familiar[1]))) denied.add(nameToken(familiar[1]));
  }
  const claims = [];
  for (const clause of declarativeClauses(texts.join(''))) {
    const explicit = /^(?:你|您)(?:的(?:名字|姓名|称呼)(?:是|叫|为)|名叫)([\p{L}\p{N}· -]{1,32})$/u.exec(clause);
    if (explicit) claims.push(nameToken(explicit[1]));
    const familiar = /^(?:你|您)(是|叫)(.{1,12})$/u.exec(clause);
    if (familiar && personName(nameToken(familiar[2])) && (familiar[1] === '叫' || denied.size)) claims.push(nameToken(familiar[2]));
  }
  if (!claims.length) return false;
  const target = pending[0].speaker?.id, known = new Set();
  const sameActor = message => message.direction === 'other' && (target ? message.speaker?.id === target : !message.speaker);
  const sourceAllowed = message => !message.aiGenerated && !message.unresolved && Number.isSafeInteger(message.timestamp) && message.timestamp * 1000 <= now;
  if (kind !== 'group' || target && pending[0].speaker?.identified !== false) {
    for (const message of [...messages.filter(sameActor), ...pending]) {
      if (!sourceAllowed(message)) continue;
      if (message !== pending[0] && !sameActor(message)) continue;
      for (const name of declaredNames(message.text)) known.add(name);
    }
  }
  if (kind === 'person') for (const clause of declarativeClauses(facts)) {
    const match = /^(?:联系人事实[：:])?对方(?:的(?:名字|姓名)|名字|姓名)?(?:是|叫|名叫)([\p{L}\p{N}· -]{1,32})$/u.exec(clause);
    if (match) known.add(nameToken(match[1]));
  }
  // The current writer's explicit denial outranks older declarations/facts.
  return claims.some(name => denied.has(name) || !known.has(name));
}
function unsupportedRecipientArrival(texts, {messages, pendingMessages, facts, now}) {
  const targetIds = new Set(pendingMessages.filter(message => message.direction === 'other' && message.speaker?.id).map(message => message.speaker.id));
  const arrival = /(?:^|[，,])\s*(?:原来|看来|结果|那)?(?:你(?:人)?|您(?:人)?|人)(?:已经|都|早就|刚刚?|先)?(?:到(?:现场|那里|这儿|地方|场)?了|都?到现场了|白跑了?一趟)/;
  const evidence = [
    ...messages.filter(message => !message.aiGenerated && Number.isSafeInteger(message.timestamp) && message.timestamp * 1000 <= now && now - message.timestamp * 1000 <= 86400000
      && (message.direction === 'other' && (targetIds.size === 0 || targetIds.size === 1 && targetIds.has(message.speaker?.id)) || message.direction === 'self' && message.authorship === 'human'))
      .flatMap(message => sentences(message.text).filter(text => !hypothetical(text) && !/[？?]/.test(clean(message.text))).flatMap(text => text.split(/[，,]/)).filter(text =>
        new RegExp('^(?:' + (message.direction === 'other' ? '我(?:人)?' : '你(?:人)?|您(?:人)?') + ')(?:已经|都|早就|刚刚?)?(?:到(?:现场|那里|这儿|地方|场)?了|白跑了?一趟)').test(text))),
    ...parts(facts).filter(text => /^对方(?:已经|都|早就|刚刚?)?(?:到(?:现场|那里|这儿|地方|场)?了|白跑了?一趟)/.test(text)),
  ];
  for (const sentence of sentences(texts.join(''))) {
    for (const claim of sentence.matchAll(new RegExp(arrival.source, 'g'))) {
      const scope = claimScope(sentence, claim);
      if (scope.attributed || /(?:到了|到场了)(?:就|再|才|也)/.test(scope.clause)) continue;
      if (!evidence.some(source => /白跑/.test(claim[0]) ? /白跑/.test(source) : !/白跑/.test(source))) return true;
    }
  }
  return false;
}

export function unsupportedPersonalAnswer(texts, { messages = [], pendingMessages = [], facts = '', boundaries = '', now = Date.now(), identityAsked = false, kind } = {}) {
  const context = {messages, pendingMessages, facts, now, kind};
  if (unsupportedRecipientHelp(texts, { messages, facts })) return 'recipient-fact';
  const moved = /^(?:哦|哦哦|原来|嗯)?\s*(?:你|您)?(?:已经|刚刚?|现在)?搬(?:家)?(?:到|去|来)([^。！？!?，,；;\s]{1,24})/;
  const relocationEvidence=[...messages.filter(m=>m.direction==='other'&&!m.aiGenerated).flatMap(m=>parts(m.text)).filter(p=>!/[“”"「」]|没|不|准备|打算|如果|假如|明天/.test(p)&&/^我(?:已经|刚刚?|现在)?搬(?:家)?(?:到|去|来)/.test(p)),...parts(facts).filter(p=>/^对方(?:已经|刚刚?|现在)?搬(?:家)?(?:到|去|来)/.test(p))];
  const destination=value=>value.replace(/(?:啦|呀|呢|啊|了|吧|～|~)+$/u,'');
  for(const text of texts)for(const part of parts(text)){
    const claim=moved.exec(part);
    if(claim&&!/[“”"「」]|如果|假如/.test(part)&&!relocationEvidence.some(p=>{
      const source=/搬(?:家)?(?:到|去|来)([^。！？!?，,；;\s]{1,24})/.exec(p);return source&&destination(source[1])===destination(claim[1]);
    }))return 'recipient-fact';
  }
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
  const directPersonalQuestion = !!personalQuestionClarification(pending);
  const sameAssertion = value => clean(value).replace(/^我(?:本人)?/, '').replace(/^(?:现在|目前|这会儿)/, '').replace(/(?:呢|呀|啊|啦|哦|哈|～|~)+$/, '').trim();
  const privacyAllowed = /不(?:说|透露|分享)(?:我)?(?:位置|地点|行踪)|(?:位置|地点|行踪).{0,6}(?:保密|不说|不透露)/.test(clean(boundaries)) || evidence.some(p => privacyReason.test(p));
  const planNotDelegated = pending.some(m => /(?:不用|不必|别|不要|先别)(?:再)?(?:替|帮)(?:我|我们)(?:确定|决定|定|约|安排)/.test(clean(m.text)));
  for (const text of [...texts, texts.join('')]) for (const part of parts(text)) {
    if (attributed(part) || /(?:不是说|别说|不能说|没有说|不代表|未确认|说不准|不确定)/.test(part)) continue;
    if ((locationQuestion || employmentQuestion) && unknownSelf.test(part)) return 'unknown-self';
    // A direct question about an unknown personal fact must not be answered
    // with a new euphemism for that fact. Preserve supported assertions and
    // neutral clarifications; everything else remains visibly unsent.
    if (directPersonalQuestion && !(privacyAllowed && privacyReason.test(part)) && !ownerConfirmation.test(part) && !/^(?:嗯+|哦+|哈哈(?:好)?|好(?:的)?|怎么(?:了|啦|突然(?:问|这么问))|咋(?:了|啦)|(?:有|是)?什么事|有什么事(?:吗|呀)?|找我有事(?:吗|呀)?|你找我(?:有什么|啥)事(?:吗|呀)?)$/.test(part)
        && !evidence.some(p=>sameAssertion(p)===sameAssertion(part))) return 'personal-fact';
    const place = livePlace.exec(part);
    if (place && !evidence.some(p => livePlace.exec(p)?.[1] === place[1])) return 'personal-fact';
    const implicitPlace = locationQuestion && livePlace.exec('我' + part.replace(/^(?:嗯|哈哈|好|对|是的)\s*/, ''));
    if (implicitPlace && !evidence.some(p => livePlace.exec(p)?.[1] === implicitPlace[1])) return 'personal-fact';
    if (employmentQuestion && /^(?:我)?(?:目前|现在|暂时)?(?:还)?(?:没定|没有定|没工作|没上班|在找工作|在看机会)/.test(part)
        && !evidence.some(p => p.replace(/^我/, '') === part.replace(/^我/, ''))) return 'personal-fact';
    if (locationQuestion && liveActivity.test(part) && !evidence.some(p => liveActivity.exec(p)?.[1] === liveActivity.exec(part)?.[1])) return 'personal-fact';
    if (employmentDenial.test(part) && !evidence.some(p => employmentDenial.test(p))) return 'personal-fact';
    if (availabilityClaim.test(part) && !evidence.some(p => availabilityClaim.test(p))) return 'personal-fact';
    if (deferredArrangement.test(part) && !evidence.some(p => deferredArrangement.test(p))) return 'future-notice';
    if (datedCheck.test(part) && !evidence.some(p => p.replace(/^我/, '') === part.replace(/^我/, ''))) return 'future-notice';
    if ((futureMonitoring.test(part) || repeatedFutureMonitoring.test(part) || datedNotice.test(part)) && !evidence.some(p=>p===part)) return 'future-notice';
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
  // Preserve existing, more specific execution/identity reasons when a draft
  // contains several violations; these additional fact checks remain final.
  if (unsupportedHistoricalSelf(texts, context)) return 'personal-fact';
  if (unsupportedUnstatedRecipient(texts, context)) return 'recipient-fact';
  if (unsupportedRecipientName(texts, context)) return 'recipient-fact';
  if (unsupportedRecipientArrival(texts, context)) return 'recipient-fact';
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

// Keep an already generated, neutral owner-confirmation clause only. The
// discarded clause must contain nothing except uncertainty about the one
// unknown field just asked; all ordinary final guards still check the result.
export function ownerConfirmationRepair(texts, {pendingMessages = [], messages = [], facts = ''} = {}) {
  if (texts.length !== 1 || !personalQuestionClarification(pendingMessages)) return '';
  const question = clean(pendingMessages.find(message => message.direction === 'other').text);
  const employment = /公司|单位/.test(question);
  // Be conservative when supplied facts or possible owner field records exist.
  const field = employment ? /公司|单位|上班|下班|工作|职业|任职|入职/ : /位置|地点|地址|行踪|在家|办公室|学校|医院|外地|路上|我.{0,8}(?:在|到|去|回)/;
  if (clean(facts).trim() || messages.some(message => message.direction === 'self' && field.test(clean(message.text)))) return '';
  const reply = String(texts[0] || '').trim();
  if (/[“”"'「」『』()（）\[\]{}<>？?；;\n]/u.test(reply) || hypothetical(reply)) return '';
  const clauses = /^([^，,。！？!?；;\n]+)[，,。]([^，,。！？!?；;\n]+)[。]?$/u.exec(reply);
  if (!clauses) return '';
  const first = clauses[1].trim(), confirmation = clean(first), tail = clean(clauses[2]).trim();
  if (!ownerConfirmation.test(confirmation) || (employment ? /位置/.test(confirmation) : /工作/.test(confirmation))) return '';
  const uncertainty = /^我(?:这边)?(?:现在|目前|今天|暂时)?(?:也)?(?:还)?(?:不知道|没法确定|不能确定|没确认|拿不准|不清楚|不太清楚|不确定|说不准)(.*)$/u.exec(tail);
  if (!uncertainty) return '';
  const sameField = employment
    ? /^(?:(?:今天|现在|目前)?(?:具体)?(?:在哪(?:家|个)(?:公司|单位)(?:上班|工作)?|(?:哪家|哪个)(?:公司|单位)(?:上班|工作)?|(?:工作|上班)(?:的)?(?:公司|单位)|工作情况))?$/u
    : /^(?:(?:今天|现在|目前|这会儿)?(?:具体)?(?:在哪(?:个)?(?:地方)?|在哪里|位置|地点))?$/u;
  return sameField.test(uncertainty[1]) ? first : '';
}

// Narrow repairs for explicit conversational corrections. They do not infer
// personal facts, override multi-message requests, or issue another model call.
export function explicitTurnRepair(texts, { pendingMessages = [], messages = [], now = Date.now(), timezone = 'Asia/Shanghai' } = {}) {
  const pending = pendingMessages.filter(m => m.direction === 'other');
  if (pending.length !== 1) return '';
  const incoming = clean(pending[0].text).trim(), reply = texts.join('');
  if (/[“”"「」]/.test(incoming)) return '';
  if (/^我说我[^。！？!?]{1,60}[，,]没说你(?:也|还|要|会)[^。！？!?]{1,60}[。！!]?$/u.test(incoming)) return '明白，你说的是你自己的情况。';
  if (/我(?:还)?(?:没|未)(?:有)?(?:定|确定)/.test(incoming) && /(?:别|不要|不用)(?:替|帮)我(?:约|定|安排)/.test(incoming)
      && /我自己(?:来)?定|我的安排/.test(reply)) return '好，你自己决定就行。';
  if (/^(?:晚上好|晚安)[，,。！!\s]/.test(incoming) && /^(?:早|早呀|早啊|早上好|早安)[，,。！!\s]/.test(reply))
    return reply.replace(/^(?:早上好|早安|早呀|早啊|早)/, '嗯');
  const preferenceOnly = /^(?:不用|不要|别)(?:每句话|每句|每轮|总是|总|老是)(?:都)?(?:问(?:我)?(?:问题)?|反问(?:我)?|提问)(?:[，,](?:随便|正常|自然)(?:聊(?:两句|几句)?|聊天)?(?:就行|即可|就好)?)?[。！!]?$/u.test(incoming);
  if (preferenceOnly && /[？?]|(?:最近|近来)(?:怎么样|咋样|如何)/.test(reply)) return '好，随便聊聊就行。';
  // Only a complete actor-only correction can make the unchanged last human
  // question redundant. Remove that whole question, never a quoted/conditional
  // clause or part of a compound question, and keep a nonempty existing reply.
  const actorCorrection = /^(?:你(?:记错|搞错|弄错|理解错|记混)了[，,])?([^，,。！？!?；;\n]{1,24})的是我(?:自己)?[，,]不是你(?:自己)?[。！!]?$/u.exec(incoming);
  if (actorCorrection
      && !/说|问|转述|引用|并非|不代表|[“”"'「」『』]/.test(incoming) && !hypothetical(incoming)) {
    const last = messages.findLast(message => message.direction === 'self' && message.authorship === 'human' && !message.aiGenerated
      && Number.isSafeInteger(message.timestamp) && message.timestamp * 1000 <= now);
    const question = clean(last?.text).trim();
    const questionKey = value => normalizedClaim(value).replace(/^(?:那么|那)/u, '');
    if (/^[^。！？!?；;\n]+[？?]$/u.test(question) && !/[“”"'「」『』]/.test(question) && !hypothetical(question)) {
      const today = annotateChatTimes([last], now, timezone)[0].temporal.relation === 'today';
      const humanKey = questionKey(question);
      // Calendar words in old questions refer to their original viewer date.
      // Only a small current-state core can treat today's "today/now" as tone;
      // activity, scheduling and negated/compound questions stay literal.
      const stateQuestion = /^(?:今天|现在)((?:好点|好些|舒服点)(?:没|了吗)|感觉怎么样|还(?:疼|难受|累)吗)$/u;
      const sameQuestion = value => {
        const key = questionKey(value);
        if (/^(?:今天|现在)/u.test(humanKey) && !today) return false;
        if (key === humanKey) return true;
        const humanState = today && stateQuestion.exec(humanKey), currentState = today && stateQuestion.exec(key);
        return !!humanState && !!currentState && humanState[1] === currentState[1];
      };
      const repeated = [...reply.matchAll(/[^。！？!?；;\n]+[？?]/gu)].filter(match => !/[“”"'「」『』]/.test(match[0]) && !hypothetical(match[0]) && sameQuestion(match[0]));
      let repaired = reply;
      for (const match of repeated.reverse()) repaired = repaired.slice(0, match.index) + repaired.slice(match.index + match[0].length);
      repaired = repaired.trim();
      if (/[\p{L}\p{N}]/u.test(repaired) && repaired !== reply) return repaired;
      // A comma can attach a complete repeated tail question to a short
      // acknowledgement. Keep only a literal actor confirmation or a bare
      // acknowledgement; never cut a compound question or new information.
      if (!/[，,]/.test(question) && /^[^。！？!?；;\n]+[？?]$/u.test(reply)
          && !/[“”"'「」『』]/.test(incoming + reply) && !hypothetical(reply)) {
        const comma = Math.max(reply.lastIndexOf('，'), reply.lastIndexOf(','));
        const prefix = reply.slice(0, comma).trim(), tail = reply.slice(comma + 1).trim();
        if (comma > 0 && sameQuestion(tail)) {
          const key = normalizedClaim(prefix);
          // A pure current apology can precede that same literal actor
          // confirmation, but cannot replace it or absorb a past-fault claim.
          const apology = /^(?:哈哈)?(?:不好意思|抱歉|对不起)/u.exec(key);
          const acknowledgement = apology || /^(?:(?:哦|啊|嗯)?对+|明白(?:了)?|知道(?:了)?|好(?:的)?|收到|嗯|哦|啊)/u.exec(key);
          const rest = acknowledgement ? key.slice(acknowledgement[0].length) : key;
          const actor = normalizedClaim(actorCorrection[1]);
          if ((!apology && acknowledgement && !rest) || rest === `是你${actor}` || rest === `是你自己${actor}` || rest === `${actor}是你` || rest === `${actor}的是你`) return prefix;
        }
      }
    }
  }
  return '';
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
export function unsupportedChatTime(texts, { messages = [], pendingMessages = [], facts = '', now = Date.now(), timezone = 'Asia/Shanghai' } = {}) {
  const evidence = [...messages.filter(m => !m.aiGenerated && m.direction !== 'system').map(m => clean(m.text)), clean(facts)].join('\n');
  const nightWords = /昨晚|昨天晚上|昨日晚上/;
  const heardYesterday = annotateChatTimes(messages, now, timezone).some(m => m.direction === 'other' && !m.aiGenerated && m.temporal.relation === 'yesterday');
  const dateCorrection=pendingMessages.length===1&&/^改(?:成|到)(周[一二三四五六日天])/.exec(clean(pendingMessages[0].text));
  for (const text of texts) for (const part of parts(text)) {
    if(dateCorrection&&!/[“”"「」]|如果|假如/.test(part)){
      const precise=new RegExp(dateCorrection[1]+'(?:的)?(早上|上午|中午|下午|傍晚|晚上|凌晨|夜里)').exec(part);
      if(precise&&![...pendingMessages,...messages.filter(m=>m.direction==='self'&&m.authorship==='human'&&!m.aiGenerated)].some(m=>clean(m.text).includes(precise[0])))return 'time-fact';
    }
    const beverageTime = /^(?:你|您)?(早上|上午|中午|下午|傍晚|晚上|凌晨|夜里)(?:就|先|刚刚?|已经|又)?(?:喝|来|冲|泡)(?:了|一|杯|点|些)/.exec(part);
    if (beverageTime && !/[“”"「」]|(?:说|引用)|(?:如果|假如)/.test(part) && !/[？?]/.test(text) && /咖啡|喝茶|一杯/.test(evidence)
        && ![...messages.filter(m=>m.direction==='other'&&!m.aiGenerated).flatMap(m=>parts(m.text)),...parts(facts).filter(p=>/^对方/.test(p)).map(p=>p.replace(/^对方/,''))]
          .some(p=>!attributed(p.replace(/^我/,''))&&new RegExp(beverageTime[1]+'.{0,12}(?:咖啡|茶|一杯)').test(p))) return 'time-fact';
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
