import { AppError } from './files.mjs';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const replySchema = allowSkip => object({ result: { anyOf: [
  object({ action: { type: 'string', enum: ['send'] }, text: { type: 'string' }, followUp: { type: 'boolean', enum: [false] } }),
  object({ stop: { type: 'boolean', enum: [true] } }),
  ...(allowSkip ? [object({ action: { type: 'string', enum: ['skip'] } })] : []),
] } });
const wrapper = '\n仅本次接口的传输外层使用JSON对象{"result":原协议最终业务对象}。result内部仍完整遵守原有身份、事实、授权、停止联系、action/text/followUp协议；stop只用{"stop":true}分支，不能为了填写正文改为send。原业务对象不增加schema解释、自检过程或其他内容。此封装不改变是否发送的决定。';

// Official Flash's json_object chat route can return whitespace only. Use its
// documented structured response route only for the already verified subset.
// Everything else keeps the existing protocol, including custom gateways,
// groups, images, automatic learning and multi-part/continuation replies.
export function structuredDeepSeekReply(config, input, { completePolicy, format, imageCount }) {
  return completePolicy && format === 'json' && config.protocol === 'openai'
    && ['https://api.deepseek.com/v1', 'https://api.deepseek.com'].includes(config.baseUrl.replace(/\/+$/, ''))
    && config.model === 'deepseek-flash' && input.currentTurnOnly === true
    && input.roleAnchor?.source === 'account-bound-settings'
    && input.mode === 'reply' && input.kind === 'person'
    && input.allowSegments === false && input.multiTurn === false
    && input.followUpAllowed === false && input.followUp === false && input.updateStyle === false
    && !Object.hasOwn(input, 'styleLearningMessageIds') && imageCount === 0
    && input.capabilities?.sendMedia === false && input.capabilities?.sendImages === false && input.capabilities?.sendAudio === false;
}

export function structuredReplyBody(body, { allowSkip = true } = {}) {
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)
    throw new AppError('结构化回复缺少有效输出上限，本次未请求模型', 400);
  if (body.messages?.length !== 2 || body.messages[0]?.role !== 'system' || body.messages[1]?.role !== 'user'
    || typeof body.messages[0].content !== 'string' || typeof body.messages[1].content !== 'string'
    || Object.keys(body).some(key => !['model', 'stream', 'max_tokens', 'response_format', 'thinking', 'reasoning_effort', 'messages'].includes(key)))
    throw new AppError('当前请求不符合已验证的结构化回复接口，本次未请求模型', 400);
  return { model: body.model, stream: false, max_output_tokens: body.max_tokens,
    reasoning: { effort: body.reasoning_effort }, instructions: body.messages[0].content + wrapper,
    input: [{ role: 'user', content: body.messages[1].content }],
    text: { format: { type: 'json_schema', name: 'qibox_reply_transport', strict: true, schema: replySchema(allowSkip) } }, store: false };
}

export function structuredReplyResult(data) {
  if (data?.status !== 'completed' && !(data?.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens'))
    throw new AppError('模型未确认生成完成，结果未知；已停止自动重试，上游仍可能计费。请先核对服务侧结果', 502, 'ai_model_result_unknown');
  const messages = (Array.isArray(data.output) ? data.output : []).filter(item => item?.type === 'message');
  let content = '';
  if (data.status === 'completed') {
    if (messages.length !== 1 || messages[0].role !== 'assistant' || !Array.isArray(messages[0].content)
      || messages[0].content.some(part => part.type !== 'output_text' || typeof part.text !== 'string'))
      throw new AppError('模型未返回有效的结构化回复，本次未发送', 502, 'ai_model_format');
    const visible = messages[0].content.map(part => part.text).join('');
    let envelope;
    try { envelope = JSON.parse(visible); } catch { throw new AppError('模型未返回有效的结构化回复，本次未发送', 502, 'ai_model_format'); }
    if (!envelope || Array.isArray(envelope) || Object.keys(envelope).length !== 1 || !envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result))
      throw new AppError('模型未返回有效的结构化回复，本次未发送', 502, 'ai_model_format');
    // Unwrap the transport only. Original decoding, business/role/time guards
    // still receive the unchanged model-authored business object.
    content = JSON.stringify(envelope.result);
  }
  return { choices: [{ message: { content }, finish_reason: data.status === 'incomplete' ? 'length' : 'stop' }],
    usage: { prompt_tokens: data.usage?.input_tokens, completion_tokens: data.usage?.output_tokens,
      prompt_tokens_details: { cached_tokens: data.usage?.input_tokens_details?.cached_tokens },
      completion_tokens_details: { reasoning_tokens: data.usage?.output_tokens_details?.reasoning_tokens } } };
}
