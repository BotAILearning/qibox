const financialRequest = /(?:你.{0,12}|能不能|可不可以|能|帮我|替我|借我).{0,12}(?:转账|打款|垫付|付款|付钱|支付|借.{0,8}(?:钱|元|块|[零一二三四五六七八九十百千万两0-9])|给我钱)/u;
const explicitConsent = /(?:已(?:经)?同意|明确允许|已经答应|我愿意).{0,12}(?:转账|打款|垫付|付款|付钱|借钱)/u;

export function guardFinancialCommitment(incoming, result, strategy = {}) {
  if (!financialRequest.test(String(incoming || '')) || result?.action !== 'send') return result;
  if (explicitConsent.test(String(strategy.facts || ''))) return result;
  return { action: 'send', text: '这事我现在答应不了，抱歉', followUp: false };
}
