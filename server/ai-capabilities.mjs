const clauses = text => text.split(/[。！？!?，,；;\n]|但是|不过|然而|但|却|仍然|还是/);
const unavailableAction = part => /(?:无法|不能|没法|不支持|不可以|不会|不方便|暂不).{0,10}(?:发|传|提供|上传|下载|打开|查看|打|拨|接|看|听)|(?:发|传|提供|下载|打开|查看|打|拨|接|看|听)不(?:了|出|到|成)/.test(part);
export const promisesMedia = text => clauses(text).some(part => !unavailableAction(part) && !/(?:不|没|未|无需|不用|不要).{0,6}(?:发|传|看)/.test(part) && /(?:我|已经|马上|稍后|等会|这就).{0,10}(?:发|传).{0,10}(?:照片|图片|截图|视频)|(?:照片|图片|截图|视频).{0,8}(?:已发|发好了|发给你了)/.test(part));
// Conservative backstop for explicit requests; the model also receives a text-only contract.
export function unsupportedTextAction(text) {
  if (typeof text !== 'string') return null;
  // A truthful limitation is not a promise to perform the unavailable action.
  // Split contrasting clauses first so a denial cannot hide a later promise.
  text = clauses(text).filter(part => !unavailableAction(part) && !/(?:如何|怎么|怎样|教程|步骤|不需要|不用|不要|无需|别).{0,10}(?:发|传|提供|上传|下载|打开|查看|打|拨|接|看|听)/.test(part)).join('\n');
  if (/(?:发|传|提供|上传|下载|打开|查看).{0,12}(?:文件|附件|文档|表格|PDF|压缩包)|(?:文件|附件|文档|表格|PDF|压缩包).{0,12}(?:发给|传给|发来|看一下)|\[文件\]/i.test(text)) return 'file';
  if (/(?:打|拨|接|回).{0,5}(?:电话|通话)|(?:语音|视频)通话|(?:给我|给你|帮我|马上|现在).{0,5}(?:打来|打过去)|call me/i.test(text)) return 'call';
  if (/\[(?:语音|视频|动画表情)\]|(?:听|发).{0,8}(?:语音消息|视频文件)/.test(text)) return 'media';
  return null;
}
