const clauses = text => text.split(/[。！？!?，,；;\n]|但是|不过|然而|但|却|仍然|还是/);
const unavailableAction = part => /(?:无法|不能|没法|不支持|不可以|不会|不方便|暂不).{0,10}(?:发|传|提供|上传|下载|打开|查看|打|拨|接|看|听)|(?:发|传|提供|下载|打开|查看|打|拨|接|看|听)不(?:了|出|到|成)/.test(part);
// Keep comma-linked actor context before checking individual actions. A plain
// report that somebody else already sent a file is not a capability request.
// These narrow grammatical cues do not infer or persist any factual owner.
const sentences = text => text.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [];
function thirdPartyPastNarration(text) {
  const value = text.trim();
  if (/^(?:老子|老娘|老夫|老身)/.test(value) || !/^(?:他(?:们)?|她(?:们)?|对方|店员|客服|老师|同事|负责人|工作人员|(?:小|老|阿)[\p{Script=Han}]{1,3})(?=只负责|负责|说|提到|表示|告诉|昨|前天|上周|刚|已|曾|早|晚|今|把|将|发|传|打|拨|回)/u.test(value)) return false;
  if (!/(?:已经|已把|已将|曾经|昨天|昨晚|前天|上周|刚刚|刚才|了)/.test(value)) return false;
  if (/(?:明天|后天|下次|稍后|一会|待会|等会|马上|这就|将要|准备|打算|计划|愿意|可以|能不能|会(?:再|给|把|将|发|传|打|拨|接|回)|如果|假如|要是|万一|可能|也许|估计|应该|是否|是不是|吗|\?|？|的话)/.test(value)) return false;
  // A different clause may switch back to self, instruct the recipient, or
  // request delivery to this chat. It must still receive the original checks.
  if (/(?:我|我们|咱|你|您)[^，,。；;!?！？\n]*(?:发|传|提供|上传|下载|打开|查看|打|拨|接|回|看|听)/.test(value)
    || /(?:发来|传来|给我|发给你|传给你|给你发|给你传)/.test(value)
    || /(?:^|[，,])\s*(?:请|麻烦|帮我|劳驾|记得|务必|能否|要不要|最好)/.test(value)) return false;
  return true;
}
function recipientLocalFileInstruction(text) {
  return /^(?:请)?(?:你|您)/.test(text.trim()) && /(?:打开|下载|查看)/.test(text)
    && !/(?:我|咱|发|传|提供|寄|提交|分享|转交)/.test(text);
}
export const promisesMedia = text => typeof text === 'string' && sentences(text).filter(part => !thirdPartyPastNarration(part)).flatMap(clauses).some(part => !unavailableAction(part) && !/(?:不|没|未|无需|不用|不要).{0,6}(?:发|传|看)/.test(part) && /(?:我|已经|马上|稍后|等会|这就).{0,10}(?:发|传).{0,10}(?:照片|图片|截图|视频)|(?:照片|图片|截图|视频).{0,8}(?:已发|发好了|发给你了)/.test(part));
// Conservative backstop for explicit requests; the model also receives a text-only contract.
export function unsupportedTextAction(text) {
  if (typeof text !== 'string') return null;
  // A truthful limitation is not a promise to perform the unavailable action.
  // Split contrasting clauses first so a denial cannot hide a later promise.
  const parts = sentences(text).filter(part => !thirdPartyPastNarration(part));
  const actionable = values => values.flatMap(clauses).filter(part => !unavailableAction(part) && !/(?:如何|怎么|怎样|教程|步骤|不需要|不用|不要|无需|别).{0,10}(?:发|传|提供|上传|下载|打开|查看|打|拨|接|看|听)/.test(part)).join('\n');
  const fileText = actionable(parts.filter(part => !recipientLocalFileInstruction(part)));
  text = actionable(parts);
  if (/(?:发|传|提供|上传|下载|打开|查看).{0,12}(?:文件|附件|文档|表格|PDF|压缩包)|(?:文件|附件|文档|表格|PDF|压缩包).{0,12}(?:发给|传给|发来|看一下)|\[文件\]/i.test(fileText)) return 'file';
  if (/(?:打|拨|接|回).{0,5}(?:电话|通话)|(?:语音|视频)通话|(?:给我|给你|帮我|马上|现在).{0,5}(?:打来|打过去)|call me/i.test(text)) return 'call';
  if (/\[(?:语音|视频|动画表情)\]|(?:听|发).{0,8}(?:语音消息|视频文件)/.test(text)) return 'media';
  return null;
}
