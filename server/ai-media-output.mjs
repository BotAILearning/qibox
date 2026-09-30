import { randomUUID } from 'node:crypto';
import { AppError } from './files.mjs';

export function mediaCapability(config) {
  const host = new URL(config.baseUrl).hostname;
  return /^(?:api\.minimaxi\.com|api\.minimax\.cn|api\.minimax\.io)$/.test(host) ? 'minimax' : host === 'api.openai.com' ? 'openai' : null;
}
export const mediaOutputPrompt = ` capabilities.sendImages/sendAudio 表示用户已勾选允许对应输出，且模型服务和微信发送通道支持；sendMedia 为两者的汇总能力，files=false仅表示不能读取或发送任意已有文件，不妨碍生成媒体。默认仍用文字；对方明确请求生成图片或朗读音频、对应能力为true且内容适合时，必须实际附带 media:[{type:"image",prompt:"完整画面描述"}] 或 [{type:"audio",text:"需要朗读的完整回复"}]，最多1项，不要只用文字描述图像或声称做不到；确需澄清或无法安全生成时正常文字说明。未勾选或能力为false时不得返回media。图片是新生成的图，不能冒充真实照片、已有文件或已完成的操作；音频使用普通合成声音，以音频文件发送，不假装用户本人录音。text必须提供独立可用的文字回复，不能宣称媒体已生成或已发送；生成失败会仅发送这个文字回复。不得输出视频、网址、文件路径、Base64、下载要求或编造媒体内容。`;

export async function generateMediaOutput(config, item, signal, fetcher = fetch) {
  const provider = mediaCapability(config);
  if (!provider || !['image','audio'].includes(item?.type)) throw new AppError('当前模型服务尚不支持所选多模态输出');
  const content = item.type === 'image' ? item.prompt : item.text;
  if (typeof content !== 'string' || !content.trim() || content.length > (item.type === 'image' ? 1500 : 3000)) throw new AppError('媒体生成内容无效，已保留文字回复');
  const base = new URL(config.baseUrl).origin;
  const endpoint = provider === 'minimax' ? item.type === 'image' ? '/v1/image_generation' : '/v1/t2a_v2' : item.type === 'image' ? '/v1/images/generations' : '/v1/audio/speech';
  const body = provider === 'minimax' ? item.type === 'image' ? { model: 'image-01', prompt: content, n: 1, aspect_ratio: '1:1', response_format: 'base64' }
    : { model: 'speech-2.8-turbo', text: content, stream: false, voice_setting: { voice_id: 'male-qn-qingse', speed: 1, vol: 1, pitch: 0 }, audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 } }
    : item.type === 'image' ? { model: 'gpt-image-1', prompt: content, n: 1, size: '1024x1024' } : { model: 'gpt-4o-mini-tts', input: content, voice: 'alloy', response_format: 'mp3' };
  const response = await fetcher(base + endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
  if (!response.ok) throw new AppError([401,403].includes(response.status) ? '媒体服务密钥或权限不足，已保留文字回复' : response.status === 429 ? '媒体服务额度不足或繁忙，已保留文字回复' : '媒体服务不支持此输出或生成失败，已保留文字回复');
  const reader = response.body.getReader(), parts = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 14 * 1024 * 1024) throw new AppError('媒体内容过大，已保留文字回复'); parts.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  let bytes;
  if (provider === 'openai' && item.type === 'audio') bytes = Buffer.concat(parts);
  else {
    let result; try { result = JSON.parse(Buffer.concat(parts).toString()); } catch { throw new AppError('媒体服务返回格式无效，已保留文字回复'); }
    if (result.base_resp?.status_code && result.base_resp.status_code !== 0) throw new AppError('媒体生成未成功，请检查模型服务的媒体权限或额度；本轮保留文字回复');
    const data = provider === 'openai' ? result.data?.[0]?.b64_json : item.type === 'image' ? result.data?.image_base64?.[0] : result.data?.audio;
    if (typeof data !== 'string' || !(item.type === 'audio' ? /^(?:[a-fA-F0-9]{2})+$/ : /^[A-Za-z0-9+/]+={0,2}$/).test(data)) throw new AppError('媒体服务未返回有效内容，已保留文字回复');
    bytes = Buffer.from(data, item.type === 'audio' ? 'hex' : 'base64');
  }
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new AppError('媒体大小不符合发送要求，已保留文字回复');
  const image = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg' : null;
  const audio = bytes.subarray(0,3).toString() === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224;
  if (item.type === 'image' && !image || item.type === 'audio' && !audio) throw new AppError('媒体内容校验失败，已保留文字回复');
  // Linux WeChat can silently ignore a portal-selected MP3 with a Chinese
  // basename. Keep the explicit synthetic label with a portable filename.
  return { name: `${item.type === 'audio' ? 'AI-generated' : 'AI合成'}-${randomUUID()}.${item.type === 'audio' ? 'mp3' : image}`, type: item.type === 'audio' ? 'audio/mpeg' : image === 'png' ? 'image/png' : 'image/jpeg', data: bytes.toString('base64'), description: content, mediaType: item.type };
}
