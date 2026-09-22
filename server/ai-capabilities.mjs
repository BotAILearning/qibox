export const handoffLabels = { file: '需要你发送或查看文件', call: '需要你处理电话或通话', voice: '微信语音转文字暂未成功，需要你查看语音', media: '需要你查看图片、语音或视频', other: '需要你手动处理' };
export const promisesMedia = text => text.split(/[。！？!?\n]/).some(part => !/(?:不|没|未|无法|不能|无需|不用|不要).{0,6}(?:发|传|看)/.test(part) && /(?:我|已经|马上|稍后|等会|这就).{0,10}(?:发|传).{0,10}(?:照片|图片|截图|视频)|(?:照片|图片|截图|视频).{0,8}(?:已发|发好了|发给你了)/.test(part));
// Conservative backstop for explicit requests; the model also receives a text-only contract.
export function textOnlyHandoff(text) {
  if (typeof text !== 'string') return null;
  text = text.split(/[。！？!?\n]/).filter(part => !/(?:如何|怎么|怎样|教程|步骤|不需要|不用|不要|无需|别).{0,10}(?:发|传|打|拨|接|看|听)/.test(part)).join('\n');
  if (/(?:发|传|提供|上传|下载|打开|查看).{0,12}(?:文件|附件|文档|表格|PDF|压缩包)|(?:文件|附件|文档|表格|PDF|压缩包).{0,12}(?:发给|传给|发来|看一下)|\[文件\]/i.test(text)) return 'file';
  if (/(?:打|拨|接|回).{0,5}(?:电话|通话)|(?:语音|视频)通话|(?:给我|给你|帮我|马上|现在).{0,5}(?:打来|打过去)|call me/i.test(text)) return 'call';
  if (/\[(?:语音|视频|动画表情)\]|(?:听|发).{0,8}(?:语音消息|视频文件)/.test(text)) return 'media';
  return null;
}
