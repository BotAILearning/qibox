// Explicit, machine-verifiable claims only; no provider call or retry.
const outsideQuotes = text => String(text || '').normalize('NFKC').replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"/gu, '〈引用〉');
export function analysisOrderMode(request = '') {
  const clauses = outsideQuotes(request).split(/[，,。！？!?；;\n]/u).map(s => s.trim().replace(/^(?:(?:请|麻烦|烦请|劳驾)\s*)+/u, '')).filter(s => !/^(?:不要|不必|不用|无需|不需要|不要求|别|勿|不按)/u.test(s));
  if (clauses.some(s => /(?:按|以|用)?(?:时间)?(?:倒序|逆序|倒叙)/u.test(s))) return 'reverse';
  if (clauses.some(s => /(?:按|按照|依照)(?:主题|话题|事项)(?:分类|分组|整理|组织|展开|排序)?/u.test(s))) return 'thematic';
  return clauses.some(s => /(?:按|按照)(?:时间|原始|原文|消息|发送)?顺序|(?:按|按照|以)时间线|(?:保留|保持)(?:原始|原文|消息|时间)顺序/u.test(s)) ? 'chronological' : '';
}
function timelineViolation(text, request) {
  if (analysisOrderMode(request) !== 'chronological') return false;
  let last = ''; const seen = new Set();
  for (const line of text.split('\n')) {
    const match = /^\s*(?:[-*]\s+|\d+[.)、]\s*)?(\d{4}-\d{2}-\d{2} [0-2]\d:[0-5]\d:[0-5]\d)(?=[，,:：\s]|$)/u.exec(line);
    if (!match || seen.has(match[1])) continue;
    const time = match[1]; seen.add(time);
    if (last && time < last) return true;
    last = time;
  }
  return false;
}
const opposite = actor => actor === '本人' ? '对方' : actor === '对方' ? '本人' : null;
const paying = '(?:代付|付款|付钱|支付|付(?=[^，,。！？!?；;\\n]{1,16}(?:费|款)))';
function matter(text) {
  const terms = new Set();
  for (const match of text.matchAll(/([^\s，,。！？!?；;：:〈〉]{1,24}(?:费用|货款|房租|费|款))/gu)) {
    const value = match[1].split(/代付|付款|付钱|支付|关于|对于|至于|替我付/u).at(-1).replace(/^(?:本次|这笔|那笔|该笔|我的|你的|对方的|本人的)/u, '');
    if (value && !['款','付款','付费'].includes(value)) terms.add(value);
  }
  return terms.size > 1 ? '?' : [...terms][0] || null;
}
function scoped(sentence, match) {
  const prefix = sentence.slice(0, match.index).split('〈引用〉').at(-1), local = prefix.split(/[，,]/u).at(-1), clause = sentence.slice(match.index).split(/[，,]/u)[0];
  return /如果|假如|假设|要是|即使/u.test(prefix)
    || /(?:^|[，,])(?:我|你|您|他|她|对方|本人)(?:刚才|之前)?(?:说|表示|提到|声称|写|问)[，,：:\s][^。！？!?]{0,24}$/u.test(prefix)
    || /(?:不能|不应|不代表|不意味着|不等于|并非|不是|不能理解为|不能推断)[^。！？!?]{0,24}$/u.test(local)
    || /[？?]$/u.test(clause);
}
function paymentEventViolation(text, messages) {
  const authorizations = [], denials = [];
  for (const message of messages) {
    if (!['本人','对方'].includes(message.speaker)) continue;
    for (const sentence of outsideQuotes(message.text).match(/[^。！？!?；;\n]+[。！？!?；;\n]?/gu) || []) {
      for (const match of sentence.matchAll(new RegExp('我(?:并)?(?:没有|没|未)(?:同意|授权|允许|许可)(?:过)?(任何人|别人|你|您|他|她)(?:替|帮)我'+paying,'gu'))) {
        if (!scoped(sentence, match)) authorizations.push({beneficiary:message.speaker, actor:['任何人','别人'].includes(match[1])?'any':['你','您'].includes(match[1])?opposite(message.speaker):null, matter:matter(sentence.split(/[，,]/u).find(s=>s.includes(match[0])) || sentence)});
      }
      for (const match of sentence.matchAll(new RegExp('(我)(?:并)?(?:没有|没|未)(?:实际)?('+paying+')','gu'))) {
        if (!scoped(sentence, match)) denials.push({actor:message.speaker,beneficiary:opposite(message.speaker),matter:matter(sentence),predicate:match[2]==='代付'?'agency':'payment'});
      }
      for (const match of sentence.matchAll(new RegExp('(?:没有人|无人)(?:实际)?(?:(?:替|帮)我)?('+paying+')','gu'))) {
        if (!scoped(sentence, match)) denials.push({actor:'any',beneficiary:message.speaker,matter:matter(sentence),predicate:match[1]==='代付'||/(?:替|帮)我/u.test(match[0])?'agency':'payment'});
      }
    }
  }
  if (!authorizations.length) return false;
  for (const sentence of outsideQuotes(text).match(/[^。！？!?；;\n]+[。！？!?；;\n]?/gu) || []) {
    const expressions = [new RegExp('(?:这(?:既|也)?否定(?:了)?)(本人|你|对方)('+paying+')','gu'),new RegExp('(本人|你|对方)(?:并)?(?:没有|没|未)(?:实际)?('+paying+')','gu')];
    for (const expression of expressions) for (const match of sentence.matchAll(expression)) {
      if (scoped(sentence, match)) continue;
      // Rejecting a proposal/authorization is not a denial that a payment occurred.
      if (/^(?:的)?(?:提议|授权|意向|请求|建议|许可)/u.test(sentence.slice(match.index + match[0].length))) continue;
      const actor = match[1] === '你' ? '本人' : match[1], topic = matter(sentence), predicate = match[2] === '代付' ? 'agency' : 'payment';
      for (const authorization of authorizations) {
        if (!authorization.actor || authorization.beneficiary === actor || authorization.actor !== 'any' && authorization.actor !== actor || topic && topic !== authorization.matter) continue;
        const relevantMatter = topic || authorization.matter;
        if (!denials.some(known => (known.actor === actor || known.actor === 'any' && known.beneficiary === authorization.beneficiary)
            && known.beneficiary === authorization.beneficiary && known.matter !== '?' && known.matter === relevantMatter && known.predicate === predicate)) return true;
      }
    }
  }
  return false;
}
export function analysisEvidenceViolation(report, messages, {request = ''} = {}) {
  const text=String(report||'').normalize('NFKC');
  if (paymentEventViolation(text, messages)) return 'payment-event';
  if (timelineViolation(text, request)) return 'timeline-order';
  for(const line of text.split('\n')) {
    const sequence=/^\s*(?:[-*]\s*)?sequence\s+(\d+)[,，]\s*(本人|你|对方|未知)[,，]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/iu.exec(line);
    if(sequence) {
      const source=messages.find(m=>m.sequence===Number(sequence[1]));
      if(!source||source.speaker!==(sequence[2]==='你'?'本人':sequence[2])||source.beijingTime!==sequence[3])return 'sequence';
    }
    for(const sentence of line.split(/[。！？!?]/u)) {
      if(/[“”"「」]|^(?:如果|假如|例如|比如)/u.test(sentence.trim()))continue;
      const owner=/([A-Za-z][A-Za-z0-9_-]{3,})\s*(?:标识|消息|发言)[^,，;；]{0,12}(?:均|都|全部)(?:落在|来自|由|是)?\s*(本人|你|对方)/u.exec(sentence);
      if(owner){
        const sources=messages.filter(m=>m.text.includes(owner[1]));
        if(!sources.length||sources.some(m=>m.speaker!==(owner[2]==='你'?'本人':owner[2])))return 'marker-owner';
      }
      const all=/共\s*(\d+)\s*条(?:可读)?消息[^。！？!?\n]{0,80}(?:均|都|全部)带(?:有)?\s*([A-Za-z][A-Za-z0-9_-]{3,})/u.exec(sentence);
      if(all&&Number(all[1])===messages.length&&messages.some(m=>!m.text.includes(all[2])))return 'marker-coverage';
    }
  }
  return '';
}
