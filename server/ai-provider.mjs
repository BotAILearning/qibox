import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { AppError } from './files.mjs';
import { textField } from './ai-schema.mjs';

export function providerValue(value, previous = {}, { discovery = false } = {}) {
  let url;
  try { url = new URL(value.baseUrl); } catch { throw new AppError('请输入有效的模型服务地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.hostname === '169.254.169.254') throw new AppError('请检查模型服务地址');
  const privateHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || isIP(url.hostname) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || /^\[f[cd][a-f0-9]{2}:/i.test(url.hostname);
  if (url.protocol === 'http:' && !privateHost) throw new AppError('公网模型服务请使用 HTTPS 地址');
  const result = { baseUrl: url.href.replace(/\/+$/, ''), model: textField(value.model || '', 160, !discovery), timeout: Number(value.timeout ?? 60), consent: value.consent === true, protocol: value.protocol || 'openai' };
  if (!['openai', 'anthropic'].includes(result.protocol)) throw new AppError('请选择支持的接口类型');
  if (!Number.isInteger(result.timeout) || result.timeout < 10 || result.timeout > 120) throw new AppError('超时应为 10–120 秒');
  if (typeof value.apiKey !== 'string' && value.apiKey !== undefined) throw new AppError('请检查 API Key');
  // 未提交新密钥（如编辑已有模型且未改动 API Key 字段）时沿用已保存密钥；
  // 服务地址或接口类型变化不影响密钥保留；显式传 clearKey 才清除。
  result.apiKey = value.clearKey === true ? '' : value.apiKey === undefined ? (previous.apiKey || '') : value.apiKey.trim();
  if (/^[*•●]+$/.test(result.apiKey)) throw new AppError('请输入完整的 API Key');
  if (result.apiKey.length > 2048 || /[\r\n\0]/.test(result.apiKey)) throw new AppError('请检查 API Key');
  if (!discovery && !result.consent) throw new AppError('请确认将选定聊天发送至此模型服务');
  return result;
}
export const providerFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Retries only cover failures that are worth another attempt: a timeout, a rate
// limit or a server-side error. Wrong keys, unknown models and malformed
// answers fail immediately so the user sees the real cause.
export const MODEL_RETRY_LIMIT = 2;
const DEFAULT_OUTPUT_BUDGET = 8192, BULK_OUTPUT_BUDGET = 16384;
// Learning over a whole history and merging two memory sets return many entries
// at once; a reply only needs a short answer. Only Anthropic used to receive a
// budget, so every other protocol inherited the server's (often small) default.
export function outputBudget(input) {
  const bulk = Array.isArray(input?.conversations) && input.conversations.length > 5 || Boolean(input?.previousMemory && input?.material);
  return bulk ? BULK_OUTPUT_BUDGET : DEFAULT_OUTPUT_BUDGET;
}
// A compatible model may emit a value with a repeated segment, e.g. copying the
// layer name out of the prompt template before the real content
// ("language":"语言层":"样本不足"), or leave a trailing comma before a brace.
// Collapse such slips and retry once instead of failing the whole request.
function repairJson(text) {
  return text.replace(/,(\s*[}\]])/g, '$1').replace(/("(?:[^"\\]|\\.)*")\s*:\s*(?:"(?:[^"\\]|\\.)*"\s*:\s*)*("(?:[^"\\]|\\.)*")/g, '$1:$2');
}
// 真机实测形态（2026-09-22，MiniMax-M3）：分段发送时模型把每条都写成一个对象，
// 且都不闭合，例如 {"action":"send","segments":["嗯 真的"],{"action":"send",...}。
// 严格解析拿不到任何完整对象。这里只在这种"输出被截断的多个对象"形态下，
// 按顶层边界切开并把未闭合的括号补齐，取回第一个带业务字段的对象。
// 真机实测形态（2026-09-22，MiniMax-M3）：模型在字符串值内部直接写了未转义的引号，
// 例如 "偶尔用"嗯呢""好哦"这类词"。只有后面紧跟结构字符（, } ] : 或结尾）的引号
// 才是字符串真正的结束，其余一律按内容里的引号转义回来。
function escapeStrayQuotes(text) {
  let out = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!quoted) { out += char; if (char === '"') quoted = true; continue; }
    if (escaped) { out += char; escaped = false; continue; }
    if (char === '\\') { out += char; escaped = true; continue; }
    if (char === '"') {
      const next = text.slice(i + 1).match(/^\s*(.)/)?.[1] ?? '';
      if (next === '' || ',}]:'.includes(next)) { out += char; quoted = false; continue; }
      out += '\\"'; continue;
    }
    out += char;
  }
  return out;
}
function parseLoose(text) {
  for (const candidate of [text, escapeStrayQuotes(text), repairJson(text), repairJson(escapeStrayQuotes(text))]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {}
  }
  return null;
}
const CLOSERS = { '{': '}', '[': ']' };
const RESULT_KEYS = ['action', 'report', 'style', 'memory', 'profiles', 'entries', 'ok'];
function balancedClose(text) {
  const stack = []; let quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') { const open = stack.pop(); if (!open || CLOSERS[open] !== char) return null; }
  }
  return quoted ? null : text + stack.reverse().map(char => CLOSERS[char]).join('');
}
function looseStarts(text) {
  const starts = []; let depth = 0, quoted = false, escaped = false, comma = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; comma = false; continue; }
    if (char === '{' || char === '[') {
      // 顶层新对象，或上一层对象尚未闭合就开始了下一个对象。
      if (char === '{' && (depth === 0 || depth === 1 && comma)) starts.push(i);
      depth++; comma = false; continue;
    }
    if (char === '}' || char === ']') { if (depth) depth--; comma = false; continue; }
    if (char === ',') { comma = depth === 1; continue; }
    if (char === ':') { comma = false; continue; }
    if (!/\s/.test(char)) comma = false;
  }
  return starts;
}
function salvageJson(text, format) {
  const starts = looseStarts(text);
  for (let index = 0; index < starts.length; index++) {
    const end = index + 1 < starts.length ? starts[index + 1] : text.length;
    const fragment = text.slice(starts[index], end).replace(/[,:\s]+$/, '');
    const closed = balancedClose(fragment);
    if (!closed) continue;
    let value;
    try { value = JSON.parse(closed); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (format === 'report' && typeof value.report !== 'string') continue;
    if (!Object.keys(value).some(key => RESULT_KEYS.includes(key))) continue;
    return value;
  }
  return null;
}
export function modelResult(content, format = 'json') {
  if (Array.isArray(content)) content = content.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n');
  if (typeof content !== 'string') throw new AppError('模型没有返回可读取的正文，请重试');
  const text = content.trim().replace(/^(?:<think>[\s\S]*?<\/think>\s*)+/i, '').replace(/^```(?:json|markdown|text)?\s*\n?/i, '').replace(/\s*```$/, '').trim();
  if (!text || /^<think>/i.test(text)) throw new AppError('模型尚未返回完整正文，请重试');
  // Locate one balanced JSON object even if a compatible provider adds a short
  // introduction. Strings/escapes are tracked, so braces inside reports survive.
  const objects = []; let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (start < 0) { if (char === '{') { start = i; depth = 1; } continue; }
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { objects.push(text.slice(start, i + 1)); start = -1; }
  }
  let result, parsed = false;
  try { result = JSON.parse(text); parsed = true; } catch {}
  if (parsed) {
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
    if (format === 'report' && typeof result === 'string' && result.trim()) return { report: result };
  } else {
    for (const scope of objects.length === 1 ? [objects[0], text] : [text]) {
      const value = parseLoose(scope);
      if (value) return value;
    }
    const salvaged = salvageJson(text, format);
    if (salvaged) return salvaged;
    if (format === 'report' && !objects.length && start < 0 && !/^[\[{]/.test(text)) return { report: text };
  }
  throw new AppError('模型返回的内容格式无效，请重试或更换模型', 502, 'ai_model_format');
}
function providerEndpoints(config) {
  const base = config.baseUrl.replace(/\/+$/, '');
  if (config.protocol === 'anthropic') {
    // Anthropic SDK base URLs omit /v1; also accept versioned bases and explicit message endpoints.
    const complete = base.endsWith('/messages') ? base : `${base}${base.endsWith('/v1') ? '' : '/v1'}/messages`;
    return { complete, models: complete.replace(/\/messages$/, '/models') };
  }
  return { complete: base.endsWith('/chat/completions') ? base : `${base}/chat/completions`, models: `${base.replace(/\/(chat\/completions|messages)$/, '')}/models` };
}
export class SecretStore {
  constructor(root) { this.file = path.join(root, 'ai-secret.key'); }
  async init() {
    try { this.key = await readFile(this.file); }
    catch (e) { if (e.code !== 'ENOENT') throw e; const key = randomBytes(32); try { await writeFile(this.file, key, { mode: 0o600, flag: 'wx' }); this.key = key; } catch (error) { if (error.code !== 'EEXIST') throw error; this.key = await readFile(this.file); } }
    if (this.key.length !== 32) throw new AppError('模型配置无法读取，请重新配置');
  }
  seal(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }; }
  open(value) { const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64')); cipher.setAuthTag(Buffer.from(value.tag, 'base64')); return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString()); }
}
export class AIProvider {
  constructor({ fetcher = fetch } = {}) { this.fetcher = fetcher; }
  headers(config) { return { 'Content-Type': 'application/json', ...(config.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01', ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}) } : config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }; }
  async models(config, signal) {
    const endpoint = providerEndpoints(config).models;
    const requestSignal = AbortSignal.any([AbortSignal.timeout(config.timeout * 1000), ...(signal ? [signal] : [])]);
    try {
      const ids = new Set(); let after = '';
      for (let page = 0; page < 20; page++) {
        const url = config.protocol === 'anthropic' ? `${endpoint}?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}` : endpoint;
        const response = await this.fetcher(url, { redirect: 'error', headers: this.headers(config), signal: requestSignal });
        if (!response.ok) { await response.body?.cancel(); throw new AppError([401, 403].includes(response.status) ? '模型认证失败，请检查 API Key' : '无法拉取模型，请手动填写对话模型并测试连接'); }
        const reader = response.body.getReader(), parts = []; let size = 0;
        try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) throw new AppError('模型列表过大，请手动填写对话模型'); parts.push(Buffer.from(value)); } }
        finally { await reader.cancel().catch(() => {}); }
        const data = JSON.parse(Buffer.concat(parts).toString());
        if (!Array.isArray(data.data)) throw new Error();
        for (const entry of data.data) {
          if (typeof entry?.id !== 'string' || !entry.id.trim() || entry.id.length > 160 || /[\x00-\x1f\x7f]/.test(entry.id)) continue;
          // Some providers list embeddings, speech and image-only models alongside chat models.
          if (/embed|rerank|whisper|\btts\b|dall-e|stable-diffusion|flux|image-generation|moderation/i.test(entry.id)) continue;
          ids.add(entry.id);
          if (ids.size > 2000) throw new AppError('模型列表过大，请手动填写对话模型');
        }
        if (config.protocol !== 'anthropic' || !data.has_more) break;
        if (typeof data.last_id !== 'string' || data.last_id === after || page === 19) throw new Error();
        after = data.last_id;
      }
      if (!ids.size) throw new AppError('未找到对话模型，请手动填写并测试连接');
      return [...ids].sort();
    } catch (error) {
      if (signal?.aborted) throw new AppError('操作已取消', 409);
      if (error instanceof AppError) throw error;
      throw new AppError('无法拉取模型，请检查配置或手动填写对话模型');
    }
  }
  async complete(config, system, input, signal, { format = 'json', budget: requestedBudget } = {}) {
    const anthropic = config.protocol === 'anthropic', endpoint = providerEndpoints(config).complete;
    const {images = [], ...textInput} = input;
    const validImages = images.filter(x => x && ['image/png','image/jpeg','image/gif','image/webp'].includes(x.mime) && typeof x.data === 'string' && x.data.length <= 5600000).slice(0,3);
    const text = JSON.stringify(textInput);
    const requestContent = validImages.length ? [{type:'text',text}, ...validImages.flatMap(x => [{type:'text',text:'图片对应消息 '+x.messageId}, anthropic ? {type:'image',source:{type:'base64',media_type:x.mime,data:x.data}} : {type:'image_url',image_url:{url:'data:'+x.mime+';base64,'+x.data}}])] : text;
    // Only Anthropic used to receive an output budget; elsewhere the server's
    // own default applied, and several hosts default to something small enough
    // to cut a real answer off mid-JSON. Ask for room explicitly instead.
    let budget = requestedBudget ?? outputBudget(textInput);
    let response, droppedBudget = false;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.fetcher(endpoint, { method: 'POST', redirect: 'error', headers: this.headers(config), signal: AbortSignal.any([AbortSignal.timeout(config.timeout * 1000), ...(signal ? [signal] : [])]),
          body: JSON.stringify({ model: config.model, stream: false, ...(budget ? { max_tokens: budget } : {}), ...(anthropic ? { system, messages: [{ role: 'user', content: requestContent }] } : { messages: [{ role: 'system', content: system }, { role: 'user', content: requestContent }] }) }) });
        if (!response.ok) {
          await response.body?.cancel();
          if (validImages.length && [400,415,422].includes(response.status)) return textInput.onlyImages ? {action:'skip',mediaSkipped:true} : this.complete(config, system + ' 本次接口无法接受图片，图片已跳过；仅依据文字，不猜测图片内容。', {...textInput,capabilities:{...textInput.capabilities,receiveImages:false}},signal, { format });
          // A host that rejects the budget parameter (or the value we asked for)
          // must not fail the call: retry once the way it used to be sent.
          if (budget && response.status === 400 && !droppedBudget) { budget = 0; droppedBudget = true; continue; }
          throw new AppError([401, 403].includes(response.status) ? '模型认证失败，请检查 API Key'
            : response.status === 429 ? '模型服务繁忙或额度不足，请稍后重试'
            : response.status === 404 ? '未找到模型接口或模型，请检查服务地址、接口类型和模型名称'
            : response.status === 405 ? '模型接口不支持此请求，请检查服务地址和接口类型'
            : response.status >= 500 ? '模型服务暂时不可用，请稍后重试'
            : '模型请求失败，请检查接口类型和模型名称', response.status === 429 || response.status >= 500 ? 502 : 400,
            response.status === 429 || response.status >= 500 ? 'ai_model_retry' : undefined);
        }
        const reader = response.body.getReader(); let size = 0; const parts = [];
        try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 128 * 1024) throw new AppError('模型返回内容过长'); parts.push(Buffer.from(value)); } }
        finally { await reader.cancel().catch(() => {}); }
        let data;
        try { data = JSON.parse(Buffer.concat(parts).toString()); }
        catch { throw new AppError('模型接口未返回有效数据，请检查服务地址和接口类型', 502, 'ai_model_response'); }
        if (data.choices?.[0]?.finish_reason === 'length' || data.stop_reason === 'max_tokens') throw new AppError('模型返回不完整，请重试');
        const content = anthropic ? data.content?.filter(x => x.type === 'text').map(x => x.text).join('') : data.choices?.[0]?.message?.content;
        return modelResult(content, format);
      } catch (error) {
        if (signal?.aborted) throw new AppError('操作已取消', 409);
        const retryable = error instanceof AppError ? error.code === 'ai_model_retry' : true;
        if (retryable && attempt < MODEL_RETRY_LIMIT) { await this.backoff(attempt, signal); continue; }
        if (error instanceof AppError) throw error;
        throw new AppError(error.name === 'TimeoutError' ? '模型响应超时，请稍后重试' : '无法连接模型服务，请检查网络和服务地址', 502, 'ai_model_connection');
      }
    }
  }
  async backoff(attempt, signal) {
    const wait = 500 * 2 ** attempt;
    await new Promise(resolve => { const timer = setTimeout(resolve, wait); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
  }
  async test(config, signal) { const result = await this.complete(config, '连接测试。只返回 JSON 对象 {"ok":true}。', { test: true }, signal); if (result.ok !== true) throw new AppError('模型未通过格式测试，请检查模型名称'); }
}
