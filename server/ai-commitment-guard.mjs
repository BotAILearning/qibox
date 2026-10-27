// A loan needs money wording or an amount ending as money, not just any
// number near 借: 借出去一趟 / 借我一台 / 借我一块橡皮 are object loans.
const amount = String.raw`[零一二三四五六七八九十百千万两0-9]+(?:\.\d+)?`;
const moneyEnding = String.raw`(?=[？?吗呢吧啊呀，,。.!！；;\s]|$|用|去|付|交|买|还|应急|救急|周转|明天还|下周还|到时还)`;
const borrowingMoney = String.raw`借(?:给我|我)?(?:(?:一点|一些|点|些|个|一笔|一下)?钱|${amount}(?:人民币|元(?!件)|块钱|块${moneyEnding}|${moneyEnding}))`;
// A payment screenshot/record is a conversational subject, not an instruction
// to pay. Likewise, a 你 in one clause must not borrow a payment verb from the
// next clause ("你那个小方块很小，付款时就不小了"). Keep real monetary
// requests in other clauses visible; never exempt the whole incoming message.
const clause = String.raw`[^，,。.!！?？；;：:\r\n]`;
const paymentVerb = String.raw`(?:转账|打款|垫付|付款|付钱|支付)`;
const paymentAction = String.raw`${paymentVerb}(?!(?:成功|失败)?的?(?:截图|凭证|记录|金额))`;
const financialRequest = new RegExp(String.raw`(?:你${clause}{0,12}|能不能|可不可以|能|帮我|替我|借我)${clause}{0,12}(?:${paymentAction}|${borrowingMoney}|给我钱)`, 'u');
// An explicit request may introduce its requested action after a comma/colon.
// Do not let the clause boundary exempt "帮我个忙：付款...".
const continuedRequest = new RegExp(String.raw`(?:帮我|替我|麻烦你|麻烦您|请你|请您)[^。.!！?？；;\r\n]{0,12}(?:${paymentAction}|${borrowingMoney}|给我钱)`, 'u');
const directPaymentRequest = new RegExp(String.raw`(?:帮我|替我)\s*${paymentVerb}`, 'u');
const explicitConsent = /(?:已(?:经)?同意|明确允许|已经答应|我愿意).{0,12}(?:转账|打款|垫付|付款|付钱|借钱)/u;
const pastStatusQuestion = /^(?:你|您)(?:(?:是不是|是否|有没有)(?:已(?:经)?)?|已(?:经)?)(?:帮我|替我)?(?:付钱|付款|支付|转账|打款)(?:了(?:吗)?|成功了吗|完成了吗)[？?]?$/u;

export function guardFinancialCommitment(incoming, result, strategy = {}) {
  const text = String(incoming || '');
  if ((!financialRequest.test(text) && !continuedRequest.test(text) && !directPaymentRequest.test(text)) || result?.action !== 'send') return result;
  // There is no verified payment receipt here. A status question must get an
  // unknown-status answer, rather than a refusal of a new request to pay.
  if (pastStatusQuestion.test(String(incoming || '').trim())) return { action: 'send', text: '这边还没有付款的确认，先别当作已经付了', followUp: false };
  if (explicitConsent.test(String(strategy.facts || ''))) return result;
  return { action: 'send', text: '这事我现在答应不了，抱歉', followUp: false };
}
