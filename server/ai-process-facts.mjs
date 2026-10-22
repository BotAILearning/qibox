import { annotateChatTimes } from './ai-time-context.mjs';

// A deliberately finite local check for an asserted current handling stage.
// It neither establishes an upstream status nor asks for another model draft.
const clean = value => String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff*_`]/g, '');
const unquoted = value => clean(value).replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"/gu, '〈引用〉');
// Preserve sentence terminators so a question is scoped to that sentence,
// while its trailing confirmation tag remains visible to the assertion check.
const clauses = value => (unquoted(value).match(/[^。！？!?；;\n]+[。！？!?；;\n]?/gu) || [])
  .flatMap(sentence => sentence.split(/[，,]/u)).map(x => x.trim()).filter(Boolean);
const institution = '(?:支付平台|支付机构|支付渠道|银行|平台|客服|商家|财务)';
const action = '(?:处理|审核|审批|复核|清算|结算)';
const forms = [
  ['waiting', new RegExp('(?:还|仍然?|正)?在等(?:待|着)?(' + institution + ')(?:那边|这边)?(' + action + ')', 'gu')],
  ['waiting', new RegExp('(?:目前|现在|当前)?(?:还|仍然?)?(?:等待|等着)(' + institution + ')(?:那边|这边)?(' + action + ')', 'gu')],
  ['active', new RegExp('(' + institution + ')(?:那边|这边)?(?:目前|现在|当前)?(?:仍然?|还|正)?在(' + action + ')', 'gu')],
  ['active', new RegExp('(?:目前|现在|当前)(?:就|也|还|仍)?(?:是|由)?(' + institution + ')(?:那边|这边)?(?:负责|在)?(' + action + ')', 'gu')],
  ['active', new RegExp('(' + institution + ')(?:那边|这边)?(' + action + ')中', 'gu')],
  ['active', new RegExp('(?:目前|现在|当前)?(?:还|仍然?|正)?(?:在|处于|进入|卡在)(' + institution + ')?(' + action + ')(?:中|阶段|环节)?', 'gu')],
];
const topicKinds = [
  ['refund', /退款|退货|退钱|退费/u], ['loan', /贷款|放款/u],
  ['payment', /付款|支付|缴费/u], ['transfer', /转账|汇款/u],
];
function topicOf(value) {
  const found = topicKinds.filter(([, pattern]) => pattern.test(value));
  if (found.length === 1) return found[0][0];
  if (found.length > 1) return null;
  return /申请|办理(?:手续|材料|业务)/u.test(value) ? 'application' : null;
}
const qualifiedQuestion = text => /[？?]$/u.test(text)
  && !/(?:对吧|是吧|没错吧|对吗|是吗)[？?]$/u.test(text);
const conditional = text => /^(?:如果|假如|假设|要是|若是|倘若|一旦|只要)/u.test(text)
  || /的话[。！？!?；;]?$/u.test(text) || /(?:的话|时|之后|以后)(?:就|再|才|可以|能|会)/u.test(text);
const generalKnowledge = text => /一般|通常|有时|往往|比如|例如|常见流程|理论上/u.test(text)
  || /(?:处理|审核|审批|清算|结算)\S{0,8}(?:需要|要)\S{0,8}(?:天|日|时间)/u.test(text) && !/现在|目前|当前|这笔|你的|我的/u.test(text);
const negated = (clause, index) => /(?:不是|并非|不代表|不能说|无法确认|不知道是否|尚未|还未|没(?:有)?|不再)[^，,。！？!?]{0,12}$/u.test(clause.slice(0, index));
function relevantPart(text) { return text.split(/但是|不过|然而|而是|但/u).at(-1).trim(); }
function excluded(clause, index, source) {
  const local = relevantPart(clause), offset = clause.length - local.length;
  if (index < offset) return true;
  const prefix = local.slice(0, index - offset);
  return qualifiedQuestion(local) || conditional(local) || generalKnowledge(local) || negated(local, index - offset)
    || /^(?:请|建议|可以|先|再|需要)(?:你|您)?(?:耐心)?$/u.test(prefix)
    || /(?:你|您|他|她|别人|对方)(?:们)?(?:刚才|之前)?(?:说|写|问)[：:]?$/u.test(prefix)
    || source && (/昨天|前天|上周|上月|去年|当时/u.test(local) && !/现在|目前|当前|仍然/u.test(prefix)
      || /可能|也许|大概|估计|似乎|好像|不一定|明天|后天|下周|将会|将要/u.test(local));
}
function stages(text, resolveActor, fallbackTopic, source = false) {
  const result = [];
  for (const clause of clauses(text)) for (const [state, pattern] of forms) {
    for (const match of clause.matchAll(pattern)) {
      if (excluded(clause, match.index, source)) continue;
      // Ordinary work/material processing is outside this finite business guard.
      if (!match[1] && !topicOf(clause) && /代码|工作|文件|文档|素材|材料/u.test(clause)) continue;
      const suffix = clause.slice(match.index + match[0].length);
      // An already finished phase is not evidence that it is still pending.
      if (/^(?:完|结束|完成|通过)/u.test(suffix)) continue;
      const topic = topicOf(clause) || fallbackTopic;
      // Institutionless processing needs an explicit business topic in this
      // clause or the current conversation; ordinary handling is out of scope.
      if (!match[1] && !topic) continue;
      result.push({ institution: match[1] || null, action: match[2], state,
        actor: resolveActor(clause.slice(0, match.index)), topic });
    }
  }
  return result;
}
function aliasesFrom(messages) {
  const aliases = new Map();
  for (const m of messages) if (m.direction === 'other' && m.speaker?.id && m.speaker.identified !== false && typeof m.senderName === 'string' && m.senderName.trim()) {
    const name = m.senderName.trim(); const ids = aliases.get(name) || new Set(); ids.add(m.speaker.id); aliases.set(name, ids);
  }
  // Keep an ambiguous display name as an explicit unresolved identity. Dropping
  // it would let the implicit pending recipient accidentally stand in for it.
  return [...aliases].map(([name, ids]) => [name, ids.size === 1 ? [...ids][0] : null]).sort((a,b) => b[0].length-a[0].length);
}
function actorResolver({ row, target, aliases, facts = false, implicitActor }) {
  const author = row?.direction === 'self' ? 'self' : row?.speaker?.id || (row?.direction === 'other' ? target : null);
  return prefix => {
    const text = prefix.replace(/^联系人事实[：:]/u, '');
    const namedOwner = text.match(/^(?:(?:现在|目前|当前)(?:就是|是)?)?([^。！？!?；;，,\n]+?)的(?:这笔|那笔)?(?:退款|退货|退钱|退费|贷款|放款|付款|支付|缴费|转账|汇款|申请|手续|材料)/u)?.[1];
    if (namedOwner && !/^(?:我|你|您|本人|对方|现在|目前|当前|这笔|那笔)(?:这笔|那笔)?$/u.test(namedOwner)) return aliases.find(([name])=>name===namedOwner)?.[1] || null;
    const subject = text.replace(/^(?:现在|目前|当前)(?:就是|是)?/u,'');
    for (const [name,id] of aliases) if (subject.startsWith(name)) {
      const tail = subject.slice(name.length);
      return /^(?:$|的|现在|目前|当前|还|仍|正|在|这笔|那笔|退款|退货|退钱|退费|贷款|放款|付款|支付|缴费|转账|汇款|申请|手续|材料)/u.test(tail) ? id : null;
    }
    if (/我|本人/u.test(text)) return facts || !row ? 'self' : author;
    if (/你|您|对方/u.test(text)) return row?.direction === 'other' ? 'self' : target;
    if (/他|她|别人|朋友|同事/u.test(text)) return null;
    return facts ? null : row ? implicitActor === undefined ? author : implicitActor : target;
  };
}
function sourceFrames(rows, target, aliases, fallbackTopic) {
  const result = [], lastTopics = new Map();
  for (const row of [...rows].sort((a,b)=>a.timestamp-b.timestamp)) {
    let previousActor;
    for (const text of clauses(row.text)) {
      const actor = actorResolver({row,target,aliases,implicitActor:previousActor})(text);
      const ownTopic = topicOf(text);
      const stageRelated = /处理|审核|审批|复核|清算|结算|到账|撤回|撤销/u.test(text);
      const topic = ownTopic || (stageRelated ? lastTopics.get(actor) || fallbackTopic : null);
      if (ownTopic && actor) lastTopics.set(actor,ownTopic);
      previousActor = actor;
      // Completion of another task (e.g. uploading documents) cannot retire a
      // refund phase merely because it happens to be in the same message.
      if (actor && topic && (ownTopic || stageRelated)) result.push({...row,text,actor,topic});
    }
  }
  return result;
}
function latestDenies(row, claim) {
  if (!row) return false;
  for (const part of clauses(row.text)) {
    if (conditional(part) || qualifiedQuestion(part) || generalKnowledge(part)) continue;
    if (!negated(part, part.search(/已经|已|到账|完成|取消|撤回/u)) && /(?:已经|已)(?:成功)?(?:到账|完成|结束|取消|撤回|撤销)|(?:到账|处理完|审核通过)了/u.test(part)) return true;
    const at = claim.institution ? part.indexOf(claim.institution) : part.indexOf(claim.action);
    if (at >= 0 && part.includes(claim.action)) {
      const prefix = part.slice(0, at), between = part.slice(at, part.indexOf(claim.action,at));
      if (/(?:不是|并非|尚未|还未|没(?:有)?|不再|未进入)[^，,。！？!?]{0,12}$/u.test(prefix)
        || /不是|并非|没(?:有)?|不在|尚未|不再/u.test(between)) return true;
    }
  }
  return false;
}

export function unsupportedProcessState(texts, { messages = [], pendingMessages = [], facts = '', now = Date.now(), kind = 'person', timezone = 'Asia/Shanghai' } = {}) {
  const pending = pendingMessages.filter(m => m.direction === 'other' && !m.aiGenerated);
  const ids = new Set(pending.filter(m => kind !== 'group' || m.speaker?.identified !== false).map(m => m.speaker?.id || (kind === 'person' ? 'recipient' : null)).filter(Boolean));
  const target = ids.size === 1 ? [...ids][0] : kind === 'person' && ids.size === 0 ? 'recipient' : null;
  const all = [...messages, ...pendingMessages].filter((m,i,list) => list.findIndex(other => m.id ? other.id === m.id : other === m) === i);
  const aliases = aliasesFrom(all), recent = annotateChatTimes(all,now,timezone).filter(m => !m.aiGenerated && !m.unresolved && m.temporal.relation === 'today' && m.temporal.usableAsCurrentState !== false
    && (m.direction === 'other' && (kind !== 'group' || !!m.speaker?.id && m.speaker.identified !== false) || m.direction === 'self' && m.authorship === 'human'));
  const fallbackTopic = topicOf(pending.map(m=>unquoted(m.text)).join(' ')) || topicOf(recent.filter(m=>m.direction==='other' && (m.speaker?.id || 'recipient')===target).at(-1)?.text || '');
  const claims = stages((Array.isArray(texts) ? texts : [texts]).filter(x=>typeof x==='string').join(' '), actorResolver({target,aliases}), fallbackTopic);
  const supplied = stages(facts,actorResolver({target,aliases,facts:true}),null,true);
  const frames = sourceFrames(recent,target,aliases,fallbackTopic);
  for (const claim of claims) {
    if (!claim.actor || !claim.topic) return 'process-fact';
    const updates = frames.filter(frame => frame.actor === claim.actor && frame.topic === claim.topic)
      .map(frame=>({frame,source:stages(frame.text,()=>frame.actor,frame.topic,true)}))
      .filter(update=>update.source.length || latestDenies(update.frame,claim));
    const latest = updates.at(-1);
    if (latestDenies(latest?.frame,claim)) return 'process-fact';
    const source = latest?.source || [];
    const matches = known => known.actor === claim.actor && known.topic === claim.topic && known.action === claim.action && known.state === claim.state && (!claim.institution || claim.institution === known.institution);
    if (!source.some(matches) && (source.length || !supplied.some(matches))) return 'process-fact';
  }
  return '';
}
