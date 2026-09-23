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
// Report models often put natural line breaks directly inside the JSON string
// instead of escaping them. JSON forbids raw control characters in strings,
// so quote and encode those characters before the normal parser tries repairs.
function escapeJsonStringControls(text) {
  let out = '', quoted = false, escaped = false;
  for (const char of text) {
    if (!quoted) { out += char; if (char === '"') quoted = true; continue; }
    if (escaped) { out += char; escaped = false; continue; }
    if (char === '\\') { out += char; escaped = true; continue; }
    if (char === '"') { out += char; quoted = false; continue; }
    if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char.charCodeAt(0) < 0x20) out += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return out;
}
function validForFormat(value, format) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (format === 'report' && !normalizeReport(value)) return false;
  return true;
}
const REPORT_TEXT_KEYS = ['report', 'content', 'text', 'markdown', 'output_text', 'body', 'result', 'output'];
function styleInputSelfCounts(input) {
  const materials = Array.isArray(input?.conversations) ? input.conversations.map(item => item.material) : [input?.material];
  return materials.filter(Array.isArray).map(rows => rows.filter(row => row?.direction === 'self').length);
}
function reportText(value, depth = 0) {
  if (typeof value === 'string') return value.trim() || '';
  if (!value || typeof value !== 'object' || depth > 2) return '';
  if (Array.isArray(value)) return value.length === 1 ? reportText(value[0], depth + 1) : '';
  for (const key of REPORT_TEXT_KEYS) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object') {
      const nested = reportText(candidate, depth + 1);
      if (nested) return nested;
    }
  }
  if (Array.isArray(value.reports) && value.reports.length === 1) return reportText(value.reports[0], depth + 1);
  return '';
}
function normalizeReport(value) {
  const report = reportText(value);
  if (!report) return null;
  return { report };
}
function parseLoose(text, format) {
  const quoted = escapeStrayQuotes(text);
  const controls = escapeJsonStringControls(text);
  const quotedControls = escapeJsonStringControls(quoted);
  for (const candidate of [text, quoted, controls, quotedControls, repairJson(text), repairJson(quoted), repairJson(controls), repairJson(quotedControls)]) {
    try {
      const value = JSON.parse(candidate);
      if (validForFormat(value, format)) return format === 'report' ? normalizeReport(value) : value;
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
    if (format === 'report') {
      const normalized = normalizeReport(value);
      if (!normalized) continue;
      return normalized;
    }
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
    if (format === 'report') {
      if (typeof result === 'string' && result.trim()) return { report: result.trim() };
      if (Array.isArray(result) && result.length !== 1) throw new AppError('模型返回了多个报告对象，无法确认目标报告', 502, 'ai_model_format');
      const normalized = normalizeReport(result);
      if (normalized) return normalized;
      throw new AppError('模型没有返回有效报告正文，请重试', 502, 'ai_model_format');
    }
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if (validForFormat(result, format)) return result;
      throw new AppError('模型返回的批量报告格式无效，请重试', 502, 'ai_model_format');
    }
  } else {
    if (format === 'report' && objects.length > 1) throw new AppError('模型返回了多个报告对象，无法确认目标报告', 502, 'ai_model_format');
    for (const scope of objects.length === 1 ? [objects[0], text] : [text]) {
      const value = parseLoose(scope, format);
      if (value) return value;
    }
    const salvaged = salvageJson(text, format);
    if (salvaged) return format === 'report' ? normalizeReport(salvaged) : salvaged;
    if (format === 'report' && !objects.length && start < 0 && !/^[\[{]/.test(text)) return { report: text };
  }
  throw new AppError('模型返回的内容格式无效，请重试或更换模型', 502, 'ai_model_format');
}
const SAFE_FINISH_REASONS = new Set(['stop', 'end_turn', 'stop_sequence', 'length', 'max_tokens', 'content_filter', 'tool_calls', 'unknown']);
function analysisReportFormatDiagnostic(content, data, responseBytes) {
  const text = typeof content === 'string' ? content : '';
  let parsed = null;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')); } catch {}
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  const known = ['report', 'content', 'text', 'markdown', 'output_text', 'body', 'result', 'output'];
  const fieldShape = Object.fromEntries(known.map(key => {
    const value = root?.[key];
    return [key, typeof value === 'string' ? { type: 'string', chars: value.length, nonEmpty: !!value.trim() }
      : value == null ? { type: value === null ? 'null' : 'missing' }
        : { type: Array.isArray(value) ? 'array' : typeof value }];
  }));
  const rawReason = data?.stop_reason ?? data?.choices?.[0]?.finish_reason;
  const finishReason = typeof rawReason === 'string' && SAFE_FINISH_REASONS.has(rawReason) ? rawReason : rawReason ? 'other' : 'missing';
  return {
    contentChars: text.length,
    contentBytes: Buffer.byteLength(text),
    responseBytes,
    hasThink: /<think\b/i.test(text),
    hasFence: /```/.test(text),
    jsonShape: root ? 'object' : Array.isArray(parsed) ? `array-${parsed.length}` : parsed === null ? 'unparsed-or-null' : typeof parsed,
    topLevelKeyCount: root ? Object.keys(root).length : 0,
    fields: fieldShape,
    finishReason,
  };
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
  async complete(config, system, input, signal, { format = 'json', budget: requestedBudget, retry = true, validate } = {}) {
    const anthropic = config.protocol === 'anthropic', endpoint = providerEndpoints(config).complete;
    const {images = [], ...textInput} = input;
    const validImages = images.filter(x => x && ['image/png','image/jpeg','image/gif','image/webp'].includes(x.mime) && typeof x.data === 'string' && x.data.length <= 5600000).slice(0,3);
    const text = JSON.stringify(textInput);
    const requestContent = validImages.length ? [{type:'text',text}, ...validImages.flatMap(x => [{type:'text',text:'图片对应消息 '+x.messageId}, anthropic ? {type:'image',source:{type:'base64',media_type:x.mime,data:x.data}} : {type:'image_url',image_url:{url:'data:'+x.mime+';base64,'+x.data}}])] : text;
    // Only Anthropic used to receive an output budget; elsewhere the server's
    // own default applied, and several hosts default to something small enough
    // to cut a real answer off mid-JSON. Ask for room explicitly instead.
    let budget = requestedBudget ?? outputBudget(textInput);
    let response, droppedBudget = false, currentSystem = system;
    for (let attempt = 0; ; attempt++) {
      try {
        const requestBody = { model: config.model, stream: false, ...(budget ? { max_tokens: budget } : {}),
          ...(anthropic ? { system: currentSystem, messages: [{ role: 'user', content: requestContent }] }
            : { messages: [{ role: 'system', content: currentSystem }, { role: 'user', content: requestContent }] }) };
        response = await this.fetcher(endpoint, { method: 'POST', redirect: 'error', headers: this.headers(config), signal: AbortSignal.any([AbortSignal.timeout(config.timeout * 1000), ...(signal ? [signal] : [])]), body: JSON.stringify(requestBody) });
        if (!response.ok) {
          let modelError = '', modelErrorCode = '', modelErrorType = '';
          if (response.status === 400 || response.status === 413 || response.status === 422) {
            try {
              const raw = await response.text();
              const data = JSON.parse(raw.slice(0, 8192));
              modelError = String(data?.error?.message || data?.message || '');
              modelErrorCode = String(data?.error?.code || data?.code || '').slice(0, 80);
              modelErrorType = String(data?.error?.type || data?.type || '').slice(0, 80);
            } catch {}
          } else await response.body?.cancel();
          const contextTooLarge = /context.{0,30}(?:length|limit|window|exceed|too long)|(?:input|prompt|request).{0,30}(?:too long|too large|exceed)|(?:token|字符|上下文).{0,30}(?:limit|exceed|too many|超|过长)/i.test(modelError);
          if (response.status === 400 || response.status === 413 || response.status === 422)
            console.warn('[ai-model-rejected]', JSON.stringify({ status: response.status, contextTooLarge,
              code: modelErrorCode, type: modelErrorType, messagePresent: !!modelError }));
          if (validImages.length && [400,415,422].includes(response.status)) return textInput.onlyImages ? {action:'skip',mediaSkipped:true} : this.complete(config, currentSystem + ' 本次接口无法接受图片，图片已跳过；仅依据文字，不猜测图片内容。', {...textInput,capabilities:{...textInput.capabilities,receiveImages:false}},signal, { format, budget, retry, validate });
          // A host that rejects the budget parameter (or the value we asked for)
          // must not fail the call: retry once the way it used to be sent.
          if (budget && response.status === 400 && !droppedBudget && retry) { budget = 0; droppedBudget = true; continue; }
          throw new AppError(contextTooLarge ? '模型上下文容量不足，无法一次处理当前聊天范围；请缩小范围或更换长上下文模型'
            : [401, 403].includes(response.status) ? '模型认证失败，请检查 API Key'
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
        if (data.choices?.[0]?.finish_reason === 'length' || data.stop_reason === 'max_tokens') {
          if (input?.defaultStyle || Array.isArray(input?.profiles)) console.warn('[ai-style-shape]', JSON.stringify({
            stage: input.defaultStyle ? 'person' : 'summary', responseKeys: Object.keys(data),
            finishReason: data.choices?.[0]?.finish_reason ?? data.stop_reason ?? null, truncated: true, responseBytes: size,
            selfMessageCounts: styleInputSelfCounts(input),
          }));
          throw new AppError('模型返回不完整，请重试', 502, 'ai_model_incomplete');
        }
        const content = anthropic ? data.content?.filter(x => x.type === 'text').map(x => x.text).join('') : data.choices?.[0]?.message?.content;
        try {
          const result = modelResult(content, format);
          if (format === 'report' && !result?.report?.trim()) console.warn('[ai-analysis-report-shape]', JSON.stringify(analysisReportFormatDiagnostic(content, data, size)));
          if (typeof validate !== 'function') return result;
          try { return validate(result); }
          catch (error) {
            if ((input?.defaultStyle || Array.isArray(input?.profiles)) && error?.code === 'ai_model_schema') {
              const style = result?.style && typeof result.style === 'object' && !Array.isArray(result.style) ? result.style : null;
              const required = ['language', 'rhythm', 'interaction', 'emotion', 'role'];
              console.warn('[ai-style-shape]', JSON.stringify({
                stage: input.defaultStyle ? 'person' : 'summary', responseKeys: Object.keys(result),
                styleType: style ? 'object' : typeof result?.style, styleKeys: style ? Object.keys(style) : [],
                missingStyleKeys: style ? required.filter(key => typeof style[key] !== 'string' || !style[key].trim()) : required,
                finishReason: data.choices?.[0]?.finish_reason ?? data.stop_reason ?? null,
                truncated: false, responseBytes: size,
                selfMessageCounts: styleInputSelfCounts(input),
              }));
            }
            throw error;
          }
        } catch (error) {
          if (format === 'report' && error?.code === 'ai_model_format') {
            console.warn('[ai-analysis-report-shape]', JSON.stringify(analysisReportFormatDiagnostic(content, data, size)));
          }
          throw error;
        }
      } catch (error) {
        if (signal?.aborted) throw new AppError('操作已取消', 409);
        const retryableCode = ['ai_model_retry', 'ai_model_response', 'ai_model_format', 'ai_model_schema', 'ai_model_incomplete'];
        const retryable = error instanceof AppError ? retryableCode.includes(error.code) : true;
        if (retryable && retry && attempt < MODEL_RETRY_LIMIT) {
          await this.backoff(attempt, signal);
          if (error instanceof AppError && error.code !== 'ai_model_retry') currentSystem = `${system}\n上一次返回未通过格式或业务结构校验。请基于同一份输入修正后重新回答，只返回符合原要求的完整 JSON 对象，不要解释。`;
          continue;
        }
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
