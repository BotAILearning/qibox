import path from 'node:path';
import { AppError, atomicJson, jsonFile } from './files.mjs';

export function validateSchedule(value) {
  if (!value || typeof value !== 'object') throw new AppError('请选择微信运行方式');
  if (!['manual', 'continuous', 'idle'].includes(value.mode)) throw new AppError('请选择微信运行方式');
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(value.startTime) || !time.test(value.endTime) || value.startTime === value.endTime) throw new AppError('请设置不同的开始和结束时间');
  // Ignore legacy eligibility fields; only the requested schedule is stored.
  return { mode: value.mode, startTime: value.startTime, endTime: value.endTime, timezone: 'Asia/Shanghai' };
}
export function scheduleWindow(settings, now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`, time = `${parts.hour}:${parts.minute}`;
  if (settings.mode === 'manual') return { active: false, key: null };
  if (settings.mode === 'continuous') return { active: true, key: `continuous:${date}` };
  const crossesMidnight = settings.startTime > settings.endTime;
  const active = crossesMidnight ? time >= settings.startTime || time < settings.endTime : time >= settings.startTime && time < settings.endTime;
  let startDate = date;
  if (crossesMidnight && time < settings.endTime) startDate = new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return { active, key: active ? `${startDate}:${settings.startTime}` : null };
}

export class WechatScheduler {
  constructor({ dataRoot, ready, runtime, start, stop, now = () => new Date() }) {
    this.file = path.join(dataRoot, 'schedule.json'); this.stateFile = path.join(dataRoot, 'schedule-state.json');
    this.ready = ready; this.runtime = runtime; this.start = start; this.stop = stop; this.now = now; this.working = null;
  }
  async init() {
    const saved = await jsonFile(this.file, { mode: 'manual', startTime: '02:00', endTime: '02:30' });
    this.settings = validateSchedule(saved);
    if ('autoLoginReady' in saved) await atomicJson(this.file, this.settings);
    this.state = await jsonFile(this.stateFile, { paused: null, ownsProcess: false, lastEvent: null, failures: 0, lastAttempt: null });
  }
  begin() { this.timer = setInterval(() => this.tick(), 30000); this.timer.unref(); }
  async close() { clearInterval(this.timer); await this.working; }
  exclusive(action) {
    const previous = this.working;
    const pending = Promise.resolve(previous).catch(() => {}).then(action);
    const tracked = pending.finally(() => { if (this.working === tracked) this.working = null; });
    this.working = tracked;
    return tracked;
  }
  // Kept for older clients; idle schedules no longer require qualification.
  publicState() { return { ...this.settings, idleAvailable: true, paused: this.isPaused(), lastEvent: this.state.lastEvent }; }
  isPaused() {
    const window = scheduleWindow(this.settings, this.now());
    return this.state.paused === 'continuous' || (window.active && this.state.paused === window.key);
  }
  async save(value) {
    const settings = validateSchedule(value);
    return this.exclusive(async () => {
    await atomicJson(this.file, settings); this.settings = settings;
    this.state = { paused: null, ownsProcess: settings.mode === 'idle' && this.runtime.status === 'running', failures: 0, lastAttempt: null, lastEvent: null };
    await atomicJson(this.stateFile, this.state);
    return this.publicState();
    });
  }
  async interact() {
    return this.exclusive(async () => {
    // A user opening the desktop takes over that session, so scheduled closing
    // cannot interrupt a phone migration they initiate in the visible window.
    this.state.resumeLoginAt = null; this.state.pendingLoginAt = null; this.state.ownsProcess = false; this.state.paused = null; this.state.failures = 0;
    await atomicJson(this.stateFile, this.state);
    });
  }
  async pause() {
    return this.exclusive(async () => {
    const window = scheduleWindow(this.settings, this.now());
    this.state.paused = this.settings.mode === 'continuous' ? 'continuous' : window.key;
    this.state.resumeLoginAt = null; this.state.pendingLoginAt = null; this.state.ownsProcess = false;
    await atomicJson(this.stateFile, this.state);
    });
  }
  tick() {
    if (this.working || !this.ready()) return this.working || Promise.resolve();
    return this.exclusive(async () => { if (this.ready()) await this.perform(); }).catch(error => {
      this.state.lastEvent = { at: this.now().toISOString(), message: error instanceof AppError ? error.message : '计划未执行，请手动打开微信' };
    });
  }
  async perform() {
    const now = this.now(), window = scheduleWindow(this.settings, now);
    await this.resumeLogin();
    if (this.settings.mode === 'manual' || this.isPaused()) return;
    if (window.active && this.runtime.status !== 'running') {
      if (!['stopped', 'error'].includes(this.runtime.status)) return;
      if (this.state.lastAttempt?.key !== window.key) this.state.failures = 0;
      if (this.state.failures >= 3 || (this.state.lastAttempt && now - Date.parse(this.state.lastAttempt.at) < 60000)) return;
      this.state.lastAttempt = { key: window.key, at: now.toISOString() };
      try {
        await this.start(); this.state.ownsProcess = true; this.state.failures = 0;
        this.state.pendingLoginAt = this.settings.mode === 'idle' ? this.now().toISOString() : null;
        this.state.lastEvent = { at: now.toISOString(), message: '已按计划打开微信，请按需要确认登录' };
      } catch {
        this.state.failures++; this.state.lastEvent = { at: now.toISOString(), message: '微信未能启动，请手动打开重试' };
      }
      await atomicJson(this.stateFile, this.state);
    } else if (!window.active && this.state.ownsProcess && this.runtime.status === 'running') {
      try {
        await this.stop(); this.state.pendingLoginAt = null; this.state.ownsProcess = false;
        this.state.lastEvent = { at: now.toISOString(), message: '闲时时段已结束，微信已退出' };
      } catch { this.state.lastEvent = { at: now.toISOString(), message: '微信尚未退出，请稍后检查' }; }
      await atomicJson(this.stateFile, this.state);
    }
    if (this.settings.mode === 'idle' && window.active && this.state.ownsProcess && this.runtime.status === 'running' && this.state.pendingLoginAt) {
      const age = this.now() - Date.parse(this.state.pendingLoginAt);
      if (age >= 0 && age < 120000) {
        try {
          const result = await this.runtime.confirmScheduledLogin?.();
          if (result?.clicked || ['logged-in', 'relogin-required'].includes(result?.status)) this.state.pendingLoginAt = null;
        } catch { /* Keep the running client available for manual login. */ }
      } else this.state.pendingLoginAt = null;
      await atomicJson(this.stateFile, this.state);
    }
  }
  async restoreLogin() {
    this.state.resumeLoginAt = this.now().toISOString();
    await atomicJson(this.stateFile, this.state); await this.resumeLogin();
  }
  async resumeLogin() {
    if (!this.state.resumeLoginAt) return;
    const age = this.now() - Date.parse(this.state.resumeLoginAt);
    if (age < 0 || age >= 120000 || this.runtime.status !== 'running' || this.isPaused()) this.state.resumeLoginAt = null;
    else {
      try {
        const result = await this.runtime.confirmScheduledLogin?.();
        if (result?.clicked || ['logged-in', 'relogin-required'].includes(result?.status)) this.state.resumeLoginAt = null;
      } catch { /* Keep the existing profile and let the user confirm if required. */ }
    }
    await atomicJson(this.stateFile, this.state);
  }
}
