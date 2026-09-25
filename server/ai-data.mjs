import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from './files.mjs';
import { NativeChatBridge } from './ai-native.mjs';
import { DataWorker } from './ai-data-worker.mjs';
import { preparedSend } from './ai-prepared-send.mjs';

const key = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const label = value => typeof value === 'string' && !!value.trim() && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);
// The WeChat nickname is optional display decoration: empty and missing are
// both fine, anything longer than the cap carries no usable identity.
const nicknameValue = value => value === undefined || value === null || (typeof value === 'string' && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value));
const unavailable = () => new AppError('暂时无法读取微信数据，请检查当前微信会话后重试；此错误不代表微信一定未登录', 409, 'ai_data_unavailable');
const loggedOut = () => new AppError('微信当前未登录，请在应用里登录后重试', 409, 'ai_wechat_logged_out');
const nativeOpenPhases = new Set(['native-start', 'native-session', 'native-navigation', 'native-prepare', 'native-chat-opened']);
const nativeOpenCodes = new Set(['timeout', 'cancelled', 'controls-unavailable']);
const nativeRequestCodes = new Set(['ai_account_changed', 'ai_chat_state_unverified', 'ai_data_unavailable', 'ai_wechat_logged_out']);
function safeNativeOpenDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { phase, code } = value;
  if (!nativeOpenPhases.has(phase) || !nativeOpenCodes.has(code)) return null;
  return { phase, code };
}
const readFailure = stage => {
  // Every stage the private reader can report is named here. An unmapped stage
  // used to fall through to the generic "暂时无法读取微信数据" message, which
  // told the user nothing and looked like a lost WeChat session even when the
  // real cause was a database key WeChat had not loaded yet.
  const messages = {
    'message-too-long': '聊天中存在超长消息，当前读取范围无法完整处理',
    'message-type': '聊天中存在暂不支持解析的消息类型',
    'message-latest': '对方最新一条消息暂不支持解析，暂不自动回复',
    'message-format': '聊天中存在无法解析的消息格式',
    'message-sender': '无法确认部分消息的发送人',
    'message-database': '聊天记录数据库暂不可用，请在微信中打开任意聊天窗口后重试',
    'message-unloaded': '该对象的聊天记录尚未加载，请在微信中打开与该对象的聊天窗口后重试',
    'key-unavailable': '聊天数据库密钥暂不可用，请在微信中打开任意聊天窗口后重试',
    'contact-unavailable': '该对象已不在当前微信通讯录中，请重新检测联系人',
    'contact-uid-unavailable': '该联系人缺少微信内部身份，当前只能按微信号区分，暂无法读取聊天记录',
    'account-unavailable': '当前微信账号数据暂不可用，请确认微信已登录后重试',
    'database-changed': '微信聊天数据库正在写入，请稍后重试',
    schema: '当前微信版本的聊天数据库结构暂不支持读取',
    'schema-ordering': '当前微信版本的聊天排序结构暂不支持读取',
    identity: '聊天记录中存在无法确认归属的消息，已停止读取',
    limit: '微信进程内存过大，密钥扫描超出预算，请稍后重试',
    encryption: '微信数据库加密方式暂不支持',
    request: '读取请求无效',
    timeout: '读取聊天记录超时，请稍后重试',
    'analysis-range': '分析时间范围或分页位置无效',
  };
  return messages[stage] ? new AppError(messages[stage], 409, 'ai_data_' + stage.replaceAll('-', '_')) : unavailable();
};
// Matches wechat-data.py json.dumps(sort_keys=True, ensure_ascii=False,
// separators=(',', ':')) for the validated public message schema.
const messageRevision = messages => createHash('sha256').update(JSON.stringify(messages.map(
  ({ direction, id, text, timestamp, sender, mentions, type }) => ({ direction, id, ...(sender ? { mentions: { all: mentions.all, others: mentions.others, self: mentions.self, verified: mentions.verified }, sender } : {}), text, timestamp, ...(['voice','image'].includes(type) ? { type } : {}) })))).digest('hex');
function privateSessionHint(value, pid) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || value.pid !== pid ||
      typeof value.processStart !== 'string' || !/^\d{1,24}$/.test(value.processStart) ||
      typeof value.buildId !== 'string' || !/^[a-f0-9]{40}$/.test(value.buildId) ||
      !key(value.rootKey) || !key(value.executableKey) ||
      typeof value.manager !== 'string' || !/^0x[a-f0-9]{1,16}$/.test(value.manager) ||
      !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0) return null;
  return { version: 1, pid, processStart: value.processStart, buildId: value.buildId,
    rootKey: value.rootKey, executableKey: value.executableKey, manager: value.manager, issuedAt: value.issuedAt };
}

// Contacts/history use the private data API exclusively. Native desktop access
// is retained only for the existing text-send/owned-draft delivery safeguards.
export class DataChatBridge extends NativeChatBridge {
  constructor(runtime, { invokeData, invokePrepared, openMemory = open, resolveAccountRoot, ...options } = {}) {
    super(runtime, options);
    this.stableMessageIds = true;
    this.dataTail = Promise.resolve(); this.dataQueue = []; this.dataBusy = false;
    this.voiceTexts = new Map();
    this.openMemory = openMemory;
    this.resolveAccountRoot = resolveAccountRoot;
    this.invokeData = invokeData || ((action, args, context) => this.invokeDataProcess(action, args, context));
    this.invokePrepared = invokePrepared || (options.invoke ? null : ((route, text, context, verify) => preparedSend(this, route, text, context, verify)));
  }
  clearContext() {
    super.clearContext();
    this.voiceTexts?.clear();
    for (const binding of this.bindings.values()) delete binding.sessionHint;
    void this.dataWorker?.stop(); this.dataWorker = null;
  }
  async close() { const worker = this.dataWorker; this.clear(); await worker?.closed.promise; }
  read(args = {}) { return this.execute('read', args); }
  readImage(args = {}) { return this.execute('read-image', args); }
  readDates(args = {}) { return this.execute('read-dates', args); }
  readRange(args = {}) { return this.execute('read-range', args); }
  // New-message index: WeChat's own chat list, one row per conversation.
  sessions(args = {}) { return this.execute('sessions', args); }
  transcribe(args) { return this.call('transcribe', args); }
  async invokeProcess(action, args, context) {
    if (!args.background) return super.invokeProcess(action, args, context);
    // Navigation and voice conversion use the same independently authenticated
    // current session as prepared sends, through a read-only inherited FD.
    const memory = await this.openMemory(`/proc/${context.pid}/mem`, 'r');
    try { this.check(context); return await super.invokeProcess(action, args, { ...context, memoryFd: memory.fd }); }
    finally { await memory.close(); }
  }
  async waitForIdle(event) { await super.waitForIdle(event); await this.dataTail; }
  check(context) {
    super.check(context);
    // An inconclusive login observation must not stop a data read. The private
    // read independently validates the live process, the active account and every
    // database page, so a signed-in WeChat stays readable while the UI
    // inspection is still unknown. Only an explicit logout observation blocks
    // here, and it must not discard bindings or the warm worker: tearing those
    // down makes the next attempt pay a cold key/session scan, which is what
    // turned one failed observation into minutes of unreadable chats.
    if (this.runtime.loginState?.loggedOut?.(true) === true) throw loggedOut();
  }
  async execute(action, args) {
    const delivery = { started: false };
    try { return await this.executeData(action, args, delivery); }
    catch (error) {
      if (action !== 'send' || delivery.started || error.code === 'ai_account_changed') throw error;
      // Login/data/navigation checks have not dispatched a send or edited any
      // draft. A temporary failure here must not require receipt reconciliation.
      // A known AppError carries its own user-facing text; pass it through so
      // the caller can show the real cause (e.g. WeChat logged out) instead of
      // a generic "消息未提交".
      return { status: args.signal?.aborted ? 'stale' : 'not-sent', ...(error instanceof AppError ? { reason: error.message } : {}) };
    }
  }
  // Background warm-up for the private data worker: create the data pipe and
  // run the cold-start key discovery/database open while the process idles, so
  // the user's first "核对" click reads from a live worker instead of paying a
  // whole-process memory scan at click time. Identity reads only contact.db,
  // never navigate, and hit the snapshot cache afterwards. Failures are silent;
  // the caller retries on its own schedule.
  async warmup() {
    const runtime = this.runtime, process = runtime.processes.find(x => x.name === 'wechat')?.process;
    if (runtime.dev || runtime.status !== 'running' || !runtime.desktopEnv || !process?.pid) return;
    if (this.pid !== process.pid || this.process !== process) { this.clear(); this.releaseManualBlock(); }
    this.pid = process.pid; this.process = process;
    const context = { pid: process.pid, process, signal: AbortSignal.timeout(25000) };
    try {
      const login = runtime.loginState;
      // Keep the observation current without making a data read wait on the
      // native UI inspection: awaiting it used to add the inspection timeout to
      // every read, and an inconclusive result no longer blocks anything.
      void login?.refresh?.().catch(() => {});
      this.check(context);
      // 'keys' authenticates the same databases a read needs and persists what
      // it finds, so the next poll reads from cache instead of walking the whole
      // WeChat address space while the user waits.
      await this.data('keys', {}, context);
    } catch { /* silent: retried by the next warm-up tick */ }
  }
  async executeData(action, { signal, ...args }, delivery) {
    signal?.throwIfAborted();
    const runtime = this.runtime, process = runtime.processes.find(x => x.name === 'wechat')?.process;
    if (runtime.dev || runtime.status !== 'running' || !runtime.desktopEnv || !process?.pid) {
      this.clear(); this.pid = null; this.process = null;
      if (action === 'scan') return { available: false };
      throw unavailable();
    }
    if (this.pid !== process.pid || this.process !== process) { this.clear(); this.releaseManualBlock(); }
    this.pid = process.pid; this.process = process;
    const context = { pid: process.pid, process, signal, delivery };
    // An inconclusive/aged UI observation must not stop the background reader.
    // Previously observed login permits only an independently validated data
    // read; explicit logout still invalidates it, including during the request.
    const login = runtime.loginState;
    // Same background refresh as warm-up: the login observation never delays or
    // blocks a read, it only supplies a verdict for an explicit logout.
    void login?.refresh?.().catch(() => {});
    this.check(context);
    if (action === 'scan') return this.scanData(context, args.onProgress);
    if (action === 'read') return this.readData(args, context);
    if (action === 'sessions') {
      // The chat-list index is a change signal, so a malformed or oversized
      // answer must never be trusted: ids are bound to the objects the app
      // already knows and every number is range-checked before it is used to
      // decide whether a conversation is worth reading.
      const result = await this.data('sessions', { account: args.account }, context);
      if (result.available !== true || !Array.isArray(result.sessions) || result.sessions.length > 20000) throw unavailable();
      const sessions = [];
      for (const row of result.sessions) {
        if (this.bindings.get(row?.id)?.account !== result.account) throw unavailable();
        if (!Number.isSafeInteger(row.at) || row.at < 0 || row.at > 9999999999 ||
            !Number.isSafeInteger(row.unread) || row.unread < 0 || row.unread > 1000000 ||
            !Number.isSafeInteger(row.last) || row.last < 0 || ![0, 1].includes(row.hidden)) throw unavailable();
        sessions.push({ id: row.id, at: row.at, unread: row.unread, last: row.last, hidden: row.hidden });
      }
      return { account: result.account, sessions };
    }
    if (action === 'read-image') {
      const binding = this.binding(args);
      if (!key(args.messageId)) throw unavailable();
      const result = await this.data('read-image', {account:binding.account,contact:binding.id,messageId:args.messageId},context);
      if (this.bindings.get(binding.id) !== binding || result.contact !== binding.id || result.messageId !== args.messageId) throw unavailable();
      const image=result.image;
      if (!image) return null;
      if (!['image/jpeg','image/png','image/gif','image/webp'].includes(image.mime) || typeof image.data !== 'string' || image.data.length > 5600000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw unavailable();
      return {messageId:args.messageId,mime:image.mime,data:image.data};
    }
    if (action === 'read-dates') {
      const binding = this.binding(args), result = await this.data('read-dates', { account: binding.account, contact: binding.id }, context);
      if (this.bindings.get(binding.id) !== binding || result.contact !== binding.id || !Array.isArray(result.days) || result.days.length > 100000 || result.days.some(d => !Number.isSafeInteger(d) || d < 0 || d > 120000)) throw unavailable();
      return { account: binding.account, contact: binding.id, dates: result.days.map(d => new Date(d * 86400000).toISOString().slice(0,10)) };
    }
    if (action === 'read-range') return this.readData(args, context, true);
    if (action === 'transcribe') return this.transcribeData(args, context);
    if (action === 'open-chat') {
      const binding = this.binding(args);
      // Authenticate the current account and target without requiring message
      // shards or chat-body decoding to succeed just to navigate.
      const current = await this.data('identity', { account: binding.account }, context);
      const target = current.contacts?.find(c => c.id === binding.id && c.kind === binding.kind);
      if (!target || !key(target.native?.account) || !key(target.native?.contact) || !label(target.label)) {
        console.error('[ai-open-chat-identity]', JSON.stringify({
          accountMatch: current.account === binding.account,
          contactCount: Array.isArray(current.contacts) ? current.contacts.length : -1,
          targetMatch: !!target,
          accountKeyValid: key(target?.native?.account),
          contactKeyValid: key(target?.native?.contact),
          labelValid: label(target?.label),
          kind: binding.kind,
        }));
        throw unavailable();
      }
      const route = { ...target.native, label: target.label, kind: binding.kind, source: 'contacts',
        background: { account: binding.account, contact: binding.id }, ...(binding.sessionHint ? { sessionHint: binding.sessionHint } : {}) };
      let result;
      try { result = await this.request('open-chat', route, context); }
      catch (error) {
        console.error('[ai-open-chat-native-failure]', JSON.stringify({ phase: 'native-request', code: nativeRequestCodes.has(error?.code) ? error.code : 'request-failed' }));
        throw error;
      }
      const accountMatch = result.account === route.account;
      const contactMatch = result.contact === route.contact;
      const opened = result.opened === true;
      const diagnostic = safeNativeOpenDiagnostic(result.diagnostic);
      if (!accountMatch || !contactMatch || !opened) {
        const phase = diagnostic?.phase || 'native-contract', code = diagnostic?.code || 'result-mismatch';
        console.error('[ai-open-chat-native-result]', JSON.stringify({ phase, code }));
        throw unavailable();
      }
      return { opened: true };
    }
    if (action === 'send') return this.sendData(args, context);
    throw unavailable();
  }
  data(action, args, context, options = {}) {
    this.check(context);
    // Reads do not wait for native navigation. Only the private data pipe is
    // serialized, including the final revision check of a prepared send. An
    // interactive read ("核对") runs right after whatever is in flight instead of
    // joining the end of the queue: a background run of activity-history reads
    // would otherwise keep the popup waiting for seconds per contact.
    return this.scheduleData(() => { this.check(context); return this.invokeData(action, args, context); },
      { priority: options.priority === true }).then(async result => {
      this.check(context);
      if (result?.error === 'account-changed' || args.account && result?.account && result.account !== args.account) {
        this.clear(); throw new AppError('微信账号已变化，请重新获取联系人', 409, 'ai_account_changed');
      }
      if (!result || result.error || !key(result.account)) throw readFailure(result?.stage);
      return result;
    });
  }
  // One operation at a time, in submission order, except that a priority entry
  // runs before anything already waiting behind the current one.
  scheduleData(job, { priority = false } = {}) {
    const entry = Promise.withResolvers(), queued = { job, entry };
    this.dataQueue.splice(priority ? Math.min(1, this.dataQueue.length) : this.dataQueue.length, 0, queued);
    // Tail marker for callers waiting on everything submitted so far.
    this.dataTail = entry.promise.then(() => {}, () => {});
    if (!this.dataBusy) void this.runDataQueue();
    return entry.promise;
  }
  async runDataQueue() {
    if (this.dataBusy) return;
    this.dataBusy = true;
    try {
      while (this.dataQueue.length) {
        const queued = this.dataQueue[0];
        try { queued.entry.resolve(await queued.job()); }
        catch (error) { queued.entry.reject(error); }
        this.dataQueue.shift();
      }
    } finally { this.dataBusy = false; }
  }
  async scanData(context, onProgress) {
    // Refresh bindings while retaining the process-scoped reader. The worker
    // independently checks the active account and database versions every time.
    const result = await this.data('contacts', {}, context);
    if (result.available !== true || !Array.isArray(result.contacts) || result.contacts.length > 20000) throw unavailable();
    const unreadableCount = result.unreadableCount === undefined ? 0 : result.unreadableCount;
    if (!Number.isSafeInteger(unreadableCount) || unreadableCount < 0 || unreadableCount > 20000) throw unavailable();
    const bindings = new Map();
    for (const contact of result.contacts) {
      if (!key(contact.id) || !label(contact.label) || !nicknameValue(contact.nickname) || !['person', 'group'].includes(contact.kind) || bindings.has(contact.id) ||
          !key(contact.native?.account) || !key(contact.native?.contact)) throw unavailable();
      bindings.set(contact.id, { ...contact, account: result.account });
    }
    const contacts = [...bindings.values()].map(({ id, label, nickname, kind, lastChatAt, contactOrder }) => ({ id, label, kind,
      ...(typeof nickname === 'string' && nickname.trim() ? { nickname: nickname.trim() } : {}),
      ...(Number.isSafeInteger(lastChatAt) && lastChatAt > 0 ? { lastChatAt } : {}),
      ...(Number.isSafeInteger(contactOrder) && contactOrder >= 0 ? { contactOrder } : {}) }));
    await onProgress?.({ completed: contacts.length, total: contacts.length });
    this.check(context); super.clearContext(); this.account = result.account; this.bindings = bindings;
    return { available: true, account: result.account, contacts,
      ...(unreadableCount ? { unreadableCount } : {}),
      identities: [...bindings.values()].map(binding => ({ id: binding.id, previous: binding.native })) };
  }
  async readData(args, context, range = false) {
    const binding = this.binding(args);
    // Set by the bridge caller: an interactive read skipping the queue.
    const priority = args.priority === true;
    const result = await this.data(range ? 'read-range' : 'read', { account: binding.account, contact: binding.id, ...(range ? { from: args.from, to: args.to, skipUnparsed: true } : {}) }, context, { priority });
    if (this.bindings.get(binding.id) !== binding) throw unavailable();
    const maxMessages = range ? 150000 : 300;
    if (result.contact !== binding.id || !key(result.revision) || !Array.isArray(result.messages) || result.messages.length > maxMessages ||
        !label(result.label) || !key(result.native?.account) || !key(result.native?.contact)) throw unavailable();
    const ids = new Set();
    // 超限不再报错：单条过长就地截断、整包过大丢弃最早的消息，两种情况都记成截断，
    // 让调用方拿到可用的一批而不是整次读取失败。id / 方向 / 时间戳仍是可信边界。
    let clipped = result.truncated === true;
    const truncatedReasons = new Set(Array.isArray(result.truncatedReasons) ? result.truncatedReasons.filter(value => typeof value === 'string').slice(0, 4) : []);
    const messages = result.messages.map(message => {
      if (!key(message.id) || ids.has(message.id) || !['self', 'other', 'system'].includes(message.direction) ||
          typeof message.text !== 'string' || !Number.isSafeInteger(message.timestamp) || message.timestamp < 0) throw unavailable();
      ids.add(message.id);
      if (message.type !== undefined && !['voice','image'].includes(message.type)) throw unavailable();
      if (binding.kind === 'group' && (!key(message.sender) || !message.mentions || ['verified', 'self', 'all', 'others'].some(k => typeof message.mentions[k] !== 'boolean'))) throw unavailable();
      let text = message.text;
      const textChars = Array.from(text);
      if (textChars.length > 150000) { text = textChars.slice(0, 150000).join(''); clipped = true; truncatedReasons.add('message_length'); }
      return { id: message.id, direction: message.direction, text, timestamp: message.timestamp, ...(['voice','image'].includes(message.type) ? { type: message.type } : {}),
        ...(binding.kind === 'group' ? { sender: message.sender, mentions: Object.fromEntries(['verified', 'self', 'all', 'others'].map(k => [k, message.mentions[k]])) } : {}) };
    });
    // A range read is the complete bounded material for one contact. Its
    // transport is bounded by the private worker's line limit, while the
    // normal recent read keeps its existing 90KB safety envelope.
    if (!range) while (messages.length > 1 && JSON.stringify(messages).length > 90000) { messages.shift(); clipped = true; }
    // Remarks and WeChat aliases can change without a new message. Refresh the
    // routing hints from this same authenticated read, retaining the binding
    // object so in-flight reads still detect an actual rescan/account change.
    binding.label = result.label;
    binding.native = { account: result.native.account, contact: result.native.contact };
    binding.sessionHint = privateSessionHint(result.sessionHint, context.pid);
    const snapshot = { account: binding.account, contact: binding.id, revision: result.revision, messages, ...(clipped ? { truncated: true, truncatedReasons: [...truncatedReasons] } : {}) };
    if (range) {
      if (result.from !== args.from || result.to !== args.to || !key(result.rangeRevision) ||
          Object.prototype.hasOwnProperty.call(result, 'nextCursor') ||
          messages.some(m => m.timestamp < args.from || m.timestamp >= args.to) ||
          (result.truncated !== undefined && typeof result.truncated !== 'boolean') || (result.truncatedReasons !== undefined && (!Array.isArray(result.truncatedReasons) || result.truncatedReasons.some(value => typeof value !== 'string')))) throw unavailable();
      return { ...snapshot, rangeRevision: result.rangeRevision };
    }
    this.remember(snapshot);
    return snapshot;
  }
  async transcribeData(args, context) {
    const binding = this.binding(args), before = await this.readData(args, context);
    if (before.revision !== args.revision) return { status: 'stale' };
    const message = before.messages.find(m => m.id === args.messageId && m.direction === 'other' && m.type === 'voice');
    if (!message) throw unavailable();
    const cacheKey = `${binding.account}:${binding.id}:${message.id}:${message.timestamp}`;
    if (this.voiceTexts.has(cacheKey)) return { text: this.voiceTexts.get(cacheKey), source: 'wechat' };
    const messages = before.messages.slice(-60);
    if (JSON.stringify(messages).length > 80000) throw unavailable();
    const route = { ...binding.native, label: binding.label, kind: binding.kind, source: 'contacts',
      background: { account: binding.account, contact: binding.id }, ...(binding.sessionHint ? { sessionHint: binding.sessionHint } : {}),
      messageId: message.id, messages };
    const result = await this.request('transcribe', route, context);
    if (result.account !== route.account || result.contact !== route.contact || result.messageId !== message.id ||
        typeof result.text !== 'string' || !result.text.trim() || result.text.length > 20000 || result.text.includes('\0')) throw unavailable();
    const after = await this.readData(args, context);
    if (after.revision !== before.revision) return { status: 'stale' };
    this.voiceTexts.set(cacheKey, result.text.trim());
    while (this.voiceTexts.size > 100) this.voiceTexts.delete(this.voiceTexts.keys().next().value);
    return { text: result.text.trim(), source: 'wechat' };
  }
  async sendData(args, context) {
    const binding = this.binding(args), before = this.snapshots.get(binding.id);
    if (!key(args.revision) || before?.revision !== args.revision) return { status: 'stale' };
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 3000 || args.text.includes('\0')) throw unavailable();
    // The current session is independently checked through the inherited
    // read-only memory descriptor. Names are navigation hints, never identity.
    // Its native snapshot revision is not a database revision.
    let route, native, delivered, baseline;
    try {
      baseline = await this.readData(args, context);
      if (baseline.revision !== args.revision) return { status: 'stale' };
      route = { ...binding.native, label: binding.label, kind: binding.kind, source: 'contacts',
        ...(this.invokePrepared ? { background: { account: binding.account, contact: binding.id },
          ...(binding.sessionHint ? { sessionHint: binding.sessionHint } : {}) } : {}) };
      if (this.invokePrepared) {
        delivered = await this.invokePrepared(route, args.text, context, async prepared => {
          if (prepared.account !== route.account) throw new AppError('微信账号已变化', 409, 'ai_account_changed');
          if (prepared.contact !== route.contact || !key(prepared.revision)) throw unavailable();
          return (await this.readData(args, context)).revision === args.revision;
        });
      } else {
        native = await this.request('read-guard', route, context);
        if (native.account !== route.account || native.contact !== route.contact || !key(native.revision)) throw unavailable();
        if ((await this.readData(args, context)).revision !== args.revision) return { status: 'stale' };
      }
    } catch (error) {
      // Configuration/manual-input cancellation during these read-only checks
      // cannot have sent anything. Keep the incoming message pending instead
      // of incorrectly requiring the user to reconcile an uncertain send.
      if (!context.delivery.started) {
        if (context.signal?.aborted) return { status: 'stale' };
        throw error;
      }
      if (error.code === 'ai_account_changed') throw error;
      delivered = { status: 'uncertain' };
    }
    if (!this.invokePrepared) {
      context.delivery.started = true;
      try { delivered = await this.request('send-guard', { ...route, revision: native.revision, text: args.text }, context); }
      catch (error) {
        if (error.code === 'ai_account_changed') throw error;
        delivered = { status: 'uncertain' };
      }
    }
    if (['stale', 'not-sent'].includes(delivered?.status)) return { status: delivered.status, ...(delivered.diagnostic ? {diagnostic:delivered.diagnostic} : {}) };
    if (!context.delivery.started || !['submitted', 'uncertain'].includes(delivered?.status)) return { status: 'uncertain' };
    // The native post-click observation can fail after the message was sent.
    // Reconcile that committed attempt through read-only DB reads, never another
    // dispatch. Receipt reads have a cancellation deadline; an earlier queued
    // data operation may still need to finish its cleanup before this returns.
    const receiptContext = { ...context, signal: AbortSignal.any([
      ...(context.signal ? [context.signal] : []), AbortSignal.timeout(6000)]) };
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        this.check(receiptContext);
        if (this.bindings.get(binding.id) !== binding) return { status: 'uncertain' };
        const after = await this.readData(args, receiptContext);
        if (this.bindings.get(binding.id) !== binding) return { status: 'uncertain' };
        const anchor = baseline.messages.at(-1)?.id;
        const boundary = anchor ? after.messages.findIndex(message => message.id === anchor) : -1;
        if (anchor && boundary < 0) return { status: 'uncertain' };
        const candidates = after.messages.map((message, index) => ({ message, index })).filter(({ message, index }) =>
          index > boundary && message.direction === 'self' && message.text === args.text && !before.ids.has(message.id));
        if (candidates.length > 1) return { status: 'uncertain' };
        if (after.revision !== args.revision && candidates.length === 1) {
          const { message, index } = candidates[0];
          // Only acknowledge the history through our receipt. This prefix hash
          // is a processing cursor, not a claim that this DB version was read.
          // Later incoming/manual messages keep a different full revision, so
          // the next observation handles them and stops older queued segments.
          const revision = index === after.messages.length - 1 ? after.revision : messageRevision(after.messages.slice(0, index + 1));
          return { status: 'sent', messageId: message.id, revision };
        }
      } catch (error) {
        if (error.code === 'ai_account_changed') throw error;
        if (receiptContext.signal.aborted || error.code !== 'ai_data_unavailable') return { status: 'uncertain' };
        try { this.check(receiptContext); } catch { return { status: 'uncertain' }; }
        if (this.bindings.get(binding.id) !== binding) return { status: 'uncertain' };
      }
      if (attempt < 4) {
        try { await delay(250, undefined, { signal: receiptContext.signal }); }
        catch { return { status: 'uncertain' }; }
      }
    }
    return { status: 'uncertain' };
  }
  async invokeDataProcess(action, args, context) {
    this.check(context);
    if (!this.dataWorker || this.dataWorker.stopping) {
      this.dataWorker = new DataWorker(this.runtime, context, { spawnProcess: this.spawnProcess, openMemory: this.openMemory,
        resolveAccountRoot: this.resolveAccountRoot });
    }
    const worker = this.dataWorker;
    try { return await worker.request({ action, ...args }, context.signal); }
    finally { if (worker.stopping && this.dataWorker === worker) this.dataWorker = null; }
  }
}
