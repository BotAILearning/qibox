import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './files.mjs';
import { MessageLedger } from './ai-ledger.mjs';

const key = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const labelValue = value => typeof value === 'string' && value.trim() && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);
const unsupported = value => value?.available === false && value.error === 'unsupported';
const unreadable = () => new AppError('暂时无法读取当前会话，请重新检测', 409);
const contactsUnreadable = () => new AppError('暂时无法获取联系人，请确认微信已登录后重试', 409, 'ai_contacts_unavailable');

// Native text goes only through private process pipes, never argv, files or logs.
export class NativeChatBridge {
  constructor(runtime, { invoke, spawnProcess = spawn } = {}) {
    this.runtime = runtime; this.tail = Promise.resolve(); this.pid = null; this.process = null;
    this.ledger = new MessageLedger(); this.bindings = new Map(); this.snapshots = new Map(); this.account = null;
    this._manualInputBlocked = false;
    this.spawnProcess = spawnProcess;
    this.invoke = invoke || ((action, args, context) => this.invokeProcess(action, args, context));
  }
  clearContext() { this.ledger.clear(); this.snapshots.clear(); }
  clear() { this.clearContext(); this.bindings.clear(); this.account = null; }
  call(action, args = {}) {
    const operation = this.tail.then(() => this.execute(action, args)); this.tail = operation.catch(() => {}); return operation;
  }
  get manualInputBlocked() { return this._manualInputBlocked; }
  releaseManualBlock() { this._manualInputBlocked = false; this.pendingDraft = null; }
  async waitForIdle(event) {
    await this.tail;
    // Navigation, editing and key releases remain available. Only a gesture
    // that could submit an unverified AI draft needs a fresh backend check.
    if (!this.manualInputBlocked || event?.type === 'disconnect' || event?.type === 'clipboard' ||
        event?.type === 'key' && (event.down === false || event.submitKey === false) ||
        event?.type === 'pointer' && !event.buttons) return;
    const process = this.runtime.processes.find(x => x.name === 'wechat')?.process;
    if (this.process !== process || this.pid !== process?.pid) { this.releaseManualBlock(); return; }
    const context = { process, pid: process.pid };
    try {
      const result = await this.invoke('input-status', { draft: this.pendingDraft, event }, context);
      this.check(context);
      if (result?.safe === true) {
        if (result.resolved === true) this.releaseManualBlock();
        return;
      }
    } catch {}
    throw new AppError('输入状态正在自动核验', 409, 'ai_input_pending');
  }
  noteDraftResult(value, context) {
    context.draftSafe = ['cleared', 'not-needed'].includes(value?.draftCleanup);
    if (!context.draftSafe) { this._manualInputBlocked = true; this.pendingDraft = context.draft || this.pendingDraft; }
  }
  check(context) {
    context.signal?.throwIfAborted();
    const runtime = this.runtime;
    const process = runtime.processes.find(x => x.name === 'wechat')?.process;
    if (runtime.status !== 'running' || !runtime.desktopEnv || process !== context.process || process?.pid !== context.pid) {
      this.clear(); this.pid = null; this.process = null; throw new AppError('微信连接已断开');
    }
  }
  async handover(context) {
    this.check(context);
    // Cancel login inspection before navigating, then recheck the process and cancellation.
    await this.runtime.foregroundRequested?.(); this.check(context);
    // The private NAS desktop may have no browser viewer and its WeChat window
    // may be hidden. Restore this owned instance before checking native identity.
    await this.runtime.showWindow?.(); this.check(context);
  }
  async execute(action, { signal, ...args }) {
    const runtime = this.runtime;
    signal?.throwIfAborted();
    if (runtime.dev || runtime.status !== 'running' || !runtime.desktopEnv) {
      this.clear(); this.pid = null; this.process = null;
      if (action === 'scan') return { available: false };
      throw new AppError('请先打开微信并登录');
    }
    const process = runtime.processes.find(x => x.name === 'wechat')?.process, pid = process?.pid;
    if (!pid) { this.clear(); this.pid = null; this.process = null; throw new AppError('微信连接已断开'); }
    if (this.pid !== pid || this.process !== process) { this.clear(); this.releaseManualBlock(); }
    this.pid = pid; this.process = process;
    const context = { pid, process, signal };
    // Each native send verifies the current editor is empty. An old cleanup
    // result must not lock manual input or unrelated conversations indefinitely.
    await this.handover(context);
    if (action === 'scan') return this.scanNative(context, args.onProgress);
    if (action === 'read' || action === 'open-chat') return this.readNative(args, context);
    if (['send', 'send-guard'].includes(action)) return this.sendNative(args, context);
    throw unreadable();
  }
  async request(action, args, context) {
    await this.handover(context);
    if (['send', 'send-guard'].includes(action)) context.draft = { text: args.text, label: args.label };
    let result;
    try { result = await this.invoke(action, args, context); }
    catch (error) { if (['send', 'send-guard'].includes(action) && !context.draftSafe) this.noteDraftResult(undefined, context); throw error; }
    if (['send', 'send-guard'].includes(action)) this.noteDraftResult(result, context);
    this.check(context);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw unreadable();
    if (result.error === 'account-changed' || result.error === 'account_changed' || args.account && result.account !== undefined && result.account !== args.account) {
      this.clear(); throw new AppError('微信账号已变化，请重新检测', 409, 'ai_account_changed');
    }
    if (result.error === 'cancelled') throw new DOMException('操作已取消', 'AbortError');
    if (result.error === 'contacts-unavailable') throw contactsUnreadable();
    if (result.error && !unsupported(result)) throw unreadable();
    return result;
  }
  async scanNative(context, onProgress) {
    this.clear();
    const list = await this.request('list', {}, context);
    if (unsupported(list) || list.available === false && !list.error) return { available: false };
    if (list.source !== undefined && list.source !== 'contacts') throw contactsUnreadable();
    if (list.batchResolve !== undefined && (list.batchResolve !== true || list.source !== 'contacts')) throw contactsUnreadable();
    if (list.available !== true || !key(list.account) || !Array.isArray(list.candidates) || list.candidates.length > (list.source === 'contacts' ? 1000 : 50) || list.candidates.some(label => !labelValue(label))) throw contactsUnreadable();
    const original = list.current;
    if (original !== null && (!original || !key(original.id) || !labelValue(original.label) || original.kind !== 'person')) throw unreadable();
    const bindings = new Map();
    const candidates = [...new Set(list.candidates)], route = list.source ? { source: list.source } : {};
    let completed = 0, unreadableCount = 0;
    const occurrences = new Map();
    for (const label of list.candidates) occurrences.set(label, (occurrences.get(label) || 0) + 1);
    const progress = async () => {
      this.check(context);
      if (typeof onProgress === 'function') await onProgress({ completed, total: candidates.length,
        contacts: [...bindings.values()].map(({ id, label, kind }) => ({ id, label, kind })) });
      this.check(context);
    };
    await progress();
    let batchResults = [];
    for (const label of candidates) {
      if (list.source === 'contacts' && occurrences.get(label) > 1) {
        completed += 1; unreadableCount += occurrences.get(label); await progress(); continue;
      }
      if (list.batchResolve === true && !batchResults.length) {
        const labels = candidates.slice(completed).filter(value => occurrences.get(value) === 1).slice(0, 10);
        const batch = await this.request('resolve-batch', { account: list.account, labels }, context);
        if (batch.account !== list.account || !Array.isArray(batch.results) || batch.results.length !== labels.length) throw contactsUnreadable();
        batchResults = batch.results;
      }
      const result = list.batchResolve === true ? batchResults.shift() : await this.request('resolve', { account: list.account, label, ...route }, context);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw contactsUnreadable();
      completed += 1;
      if (unsupported(result)) { unreadableCount += occurrences.get(label); await progress(); continue; }
      if (result.account !== list.account || !result.contact || !key(result.contact.id) || !labelValue(result.contact.label)) throw unreadable();
      if (result.contact.kind === 'group') { await progress(); continue; }
      if (result.contact.kind !== 'person' || result.contact.label !== label) throw unreadable();
      const previous = bindings.get(result.contact.id);
      if (previous && previous.label !== label) throw new AppError('会话对象不明确，请重新检测', 409);
      bindings.set(result.contact.id, { id: result.contact.id, account: list.account, label, kind: 'person', ...route });
      await progress();
    }
    if (original) {
      const restored = await this.request('resolve', { account: list.account, label: original.label }, context);
      if (restored.account !== list.account || restored.contact?.id !== original.id || restored.contact?.label !== original.label || restored.contact?.kind !== 'person') throw unreadable();
    }
    if (list.source === 'contacts' && candidates.length && !bindings.size) throw contactsUnreadable();
    this.check(context); this.account = list.account; this.bindings = bindings;
    return { available: true, account: list.account, contacts: [...bindings.values()].map(({ id, label, kind }) => ({ id, label, kind })),
      ...(list.source === 'contacts' && unreadableCount ? { unreadableCount } : {}) };
  }
  binding(args) {
    const binding = this.bindings.get(args.contact);
    if (!key(args.account) || args.account !== this.account || !binding || binding.account !== args.account) throw new AppError('请先检测对应的微信对象', 409);
    return binding;
  }
  snapshot(value, binding) {
    if (value.account !== binding.account) { this.clear(); throw new AppError('微信账号已变化，请重新检测', 409, 'ai_account_changed'); }
    if (value.contact !== binding.id || !key(value.revision) || !Array.isArray(value.messages)) throw unreadable();
    const scope = `${binding.account}\0${binding.id}`;
    const messages = this.ledger.reconcile(scope, value.messages);
    return { account: binding.account, contact: binding.id, revision: value.revision, messages };
  }
  remember(snapshot) { this.snapshots.set(snapshot.contact, { revision: snapshot.revision, ids: new Set(snapshot.messages.map(message => message.id)) }); }
  async readNative(args, context) {
    const binding = this.binding(args);
    const result = await this.request('read', { account: binding.account, contact: binding.id, label: binding.label, ...(binding.source ? { source: binding.source } : {}) }, context);
    if (unsupported(result) || result.available === false) throw unreadable();
    const snapshot = this.snapshot(result, binding); this.remember(snapshot); return snapshot;
  }
  async sendNative(args, context) {
    const binding = this.binding(args), before = this.snapshots.get(binding.id);
    if (!key(args.revision) || !before || before.revision !== args.revision) return { status: 'stale' };
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 3000 || args.text.includes('\0')) throw new AppError('请检查待发送内容');
    try {
      const result = await this.request('send', { account: binding.account, contact: binding.id, label: binding.label, revision: args.revision, text: args.text, ...(binding.source ? { source: binding.source } : {}) }, context);
      if (result.status === 'stale') return { status: 'stale' };
      if (result.status !== 'sent' || !result.snapshot) return { status: 'uncertain' };
      const last = result.snapshot.messages?.at(-1);
      if (result.snapshot.revision === before.revision || last?.direction !== 'self' || last.text !== args.text) return { status: 'uncertain' };
      const after = this.snapshot(result.snapshot, binding), message = after.messages.at(-1);
      if (before.ids.has(message.id)) return { status: 'uncertain' };
      this.remember(after);
      return { status: 'sent', messageId: message.id, revision: after.revision };
    } catch { return { status: 'uncertain' }; }
  }
  invokeProcess(action, args, context) {
    const { pid, signal } = context;
    const runtime = this.runtime;
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(path.join(runtime.runtimeRoot, 'usr/bin/python3.11'), [path.join(runtime.appRoot, 'server/ai-native.py'), String(pid)], {
        env: { ...runtime.desktopEnv, PYTHONHOME: path.join(runtime.runtimeRoot, 'usr'), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore', ...(Number.isInteger(context.memoryFd) ? [context.memoryFd] : [])],
      });
      let output = '', killed = false, overflow = false, killTimer;
      const abort = () => { killed = true; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2500); };
      const timeoutMs = ['send', 'send-guard'].includes(action) ? 32000 : 95000;
      const timer = setTimeout(abort, timeoutMs); signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
      child.stdin.on('error', () => {});
      if (signal?.aborted) abort(); else child.stdin.end(JSON.stringify({ action, ...args }));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => { if (overflow) return; output += data; if (Buffer.byteLength(output) > 400000) { overflow = true; output = ''; abort(); } });
      child.once('error', () => { cleanup(); reject(new AppError('当前微信暂不支持聊天检测')); });
      child.once('close', code => {
        cleanup();
        let result;
        try { if (!overflow && code === 0) result = JSON.parse(output); } catch {}
        // Even an aborted child must report whether it cleared its owned draft
        // before the pending manual key/click may be forwarded.
        if (['send', 'send-guard'].includes(action)) this.noteDraftResult(result, context);
        if (signal?.aborted) return reject(signal.reason);
        if (killed || code !== 0) return reject(new AppError('微信操作中断，请重新检测'));
        if (result) resolve(result); else reject(unreadable());
      });
    });
  }
  scan(args) { return this.call('scan', args); }
  openChat(args) { return this.call('open-chat', args); }
  read(args) { return this.call('read', args); }
  send(args) { return this.call('send', args); }
}
