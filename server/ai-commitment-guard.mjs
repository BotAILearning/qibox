const financialRequest = /转账|打款|垫付|付款|付钱|支付|红包|借.{0,8}(?:钱|元|块|[零一二三四五六七八九十百千万两0-9])|帮我.{0,4}(?:付|垫)/u;
const affirmative = /^(?:好(?:的|啊|呀)?|可以(?:啊|呀|的)?|行(?:啊|呀)?|没问题|当然|我来|我帮你|我会)(?:\s|[，,。！？!?]|$)/u;
const actionPromise = /(?:我|明天|到时候).{0,8}(?:转账|打款|垫付|付款|付钱|支付|借你|给你钱)/u;
const explicitConsent = /(?:已(?:经)?同意|明确允许|已经答应|我愿意).{0,12}(?:转账|打款|垫付|付款|付钱|借钱)/u;

export function guardFinancialCommitment(incoming, result, strategy = {}) {
  if (!financialRequest.test(String(incoming || '')) || result?.action !== 'send') return result;
  if (explicitConsent.test(String(strategy.facts || ''))) return result;
  const text = Array.isArray(result.segments) ? result.segments.join(' ') : String(result.text || '');
  if (!affirmative.test(text.trim()) && !actionPromise.test(text)) return result;
  return { action: 'send', text: '这事我得先确认一下，暂时不能答应你', followUp: false };
}
