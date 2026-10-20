import path from 'node:path';
import { lstat, readFile, rm } from 'node:fs/promises';
import { AppError, atomicJson, jsonFile } from './files.mjs';
import { randomUUID } from 'node:crypto';

const modes = ['ask', 'background', 'quit'];
const xml = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
// Openbox parses command arguments itself; there is deliberately no shell.
const argument = s => '"' + String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
export function desktopWindowConfig(defaults, command) {
  if (!defaults.includes('<mouse>') || !defaults.includes('<keyboard>')) throw new Error('Desktop bindings unavailable');
  const intercept = `<action name="If"><query target="default"><class type="exact">wechat</class><title type="exact">微信</title><type>normal</type></query><then><action name="Execute"><command>${xml(command)}</command></action></then><else><action name="Close"/></else></action>`;
  const configured = defaults.replace(/<action\s+name="Close"\s*\/>/g, intercept);
  if (configured === defaults) throw new Error('Desktop close bindings unavailable');
  return configured.replace('<applications>', '<applications><application type="normal"><maximized>yes</maximized></application>');
}
export function closeRequestCommand(python, helper, signalFile) { return ['/usr/bin/env', `PYTHONHOME=${path.dirname(path.dirname(python))}`, 'PYTHONNOUSERSITE=1', 'PYTHONDONTWRITEBYTECODE=1', python, helper, signalFile].map(argument).join(' '); }

export class WindowClose {
  constructor({ dataRoot, perform }) { this.file = path.join(dataRoot, 'window-behavior.json'); this.perform = perform; this.mode = 'ask'; this.generation = 0; }
  async init() { const saved = await jsonFile(this.file, null); this.mode = modes.includes(saved?.mode) ? saved.mode : 'ask'; }
  state() { return { windowCloseBehavior: this.mode, windowCloseRequest: this.pending ? { ...this.pending } : null }; }
  async preference(mode) {
    if (!modes.includes(mode)) throw new AppError('关闭窗口行为无效');
    await atomicJson(this.file, { mode }); this.mode = mode; return this.state();
  }
  async start(signalFile) {
    this.dispose(); this.signalFile = signalFile; await rm(signalFile, { force: true });
    this.timer = setInterval(() => { void this.poll().catch(() => {}); }, 300); this.timer.unref?.();
  }
  async poll() {
    if (this.polling || this.busy || !this.signalFile) return;
    this.polling = true; const generation = this.generation, signalFile = this.signalFile;
    try {
      const info = await lstat(signalFile).catch(() => null);
      if (!info?.isFile() || info.size > 100) return;
      const id = (await readFile(signalFile, 'utf8')).trim();
      if (!/^[a-f0-9-]{36}$/.test(id)) return;
      if (generation !== this.generation) return;
      await rm(signalFile, { force: true });
      if (generation !== this.generation || this.pending) return;
      await this.request(id);
    } finally { this.polling = false; }
  }
  async request(id = randomUUID()) {
    if (this.pending || this.busy) return;
    this.pending = { id };
    if (this.mode !== 'ask') { this.pending.automatic = true; await this.resolve(id, this.mode, false); }
  }
  async resolve(id, choice, remember = false) {
    if (!this.pending || id !== this.pending.id || this.busy) throw new AppError('关闭操作已结束，请重新操作', 409);
    if (!['cancel', 'background', 'quit'].includes(choice) || typeof remember !== 'boolean') throw new AppError('请选择有效的关闭操作');
    if (choice === 'cancel') { this.pending = null; return this.state(); }
    this.busy = true; const request = this.pending, generation = this.generation;
    try {
      // Persist before acting: a failed write must never unexpectedly quit.
      if (remember) await this.preference(choice);
      if (generation !== this.generation || request !== this.pending) throw new AppError('关闭操作已结束，请重新操作', 409);
      await this.perform(choice);
      if (generation === this.generation) this.pending = null;
      return this.state();
    } catch (error) {
      if (generation === this.generation) this.pending = { ...request, automatic: false, error: '操作未完成，请重试或取消' };
      throw error;
    } finally { this.busy = false; }
  }
  dispose() { clearInterval(this.timer); this.generation++; this.pending = null; this.signalFile = null; }
}

export class WindowCloseInput {
  constructor({ probe, request, generation }) { this.probe = probe; this.request = request; this.generation = generation; this.sources = new Map(); }
  reset() { this.sources.clear(); }
  async before(event) {
    if (event.type === 'disconnect') { this.sources.delete(event.source); return; }
    if (event.type !== 'pointer') return;
    const previous = this.sources.get(event.source) || { buttons: 0 };
    this.sources.set(event.source, { ...previous, buttons: event.buttons });
    const within = rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite) && rect[2] > 0 && rect[3] > 0 && event.x >= rect[0] && event.y >= rect[1] && event.x < rect[0]+rect[2] && event.y < rect[1]+rect[3];
    if (previous.close) {
      if (!event.buttons) { this.sources.delete(event.source); if (within(previous.close)) void this.request().catch(() => {}); }
      throw new AppError('请选择关闭微信后的行为', 409, 'desktop_window_close');
    }
    if (previous.buttons || event.buttons !== 1) return;
    const generation = this.generation();
    const result = await this.probe().catch(() => null);
    if (generation !== this.generation() || !within(result?.close)) return;
    this.sources.set(event.source, { buttons: event.buttons, close: result.close });
    throw new AppError('请选择关闭微信后的行为', 409, 'desktop_window_close');
  }
}
