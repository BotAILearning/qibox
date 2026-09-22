import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { AppError, atomicJson, jsonFile, within } from './files.mjs';
import { applicationDefinition, APP_CATALOG } from './catalog.mjs';
import { createAdapterRuntime, inertAI, manualSchedule } from './app-adapters.mjs';
import { validUserKey } from './platform.mjs';

const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
export function instanceName(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 30 || /[\x00-\x1f\x7f]/.test(value)) throw new AppError('请输入 1–30 个字的名称');
  return value.trim();
}
export class Instances {
  constructor(options) { Object.assign(this, options); this.spaces = new Map(); this.pending = new Map(); this.starts = Promise.resolve(); this.closing = false; }
  async init() {
    this.userFile = path.join(this.dataRoot, 'users.json');
    this.uids = await jsonFile(this.userFile, []); this.userWrites = Promise.resolve();
    this.assets = { status: 'stopped' }; this.preparing = Promise.resolve();
    for (const uid of this.uids) await this.get(uid);
  }
  async ensureAssets() {
    if (this.runtimeFactory) return;
    this.assetsTask ??= (async () => {
      const { Runtime } = await import('./runtime.mjs');
      this.assets = new Runtime({ appRoot: this.appRoot, dataRoot: this.dataRoot, dev: this.dev });
      this.preparing = this.assets.prepare(); await this.preparing;
    })();
    await this.assetsTask;
  }
  async get(uid) {
    if (!validUserKey(uid, this)) throw new AppError(this.host === 'ugos' ? '请重新登录绿联后打开栖盒' : '请重新登录飞牛', 401);
    if (this.closing) throw new AppError('栖盒正在退出', 503);
    if (this.spaces.has(uid)) return this.spaces.get(uid);
    if (this.pending.has(uid)) return this.pending.get(uid);
    const operation = (async () => {
      const space = new UserInstances({ ...this, uid, root: path.join(this.dataRoot, 'users', uid), owner: this });
      await space.init();
      const save = this.userWrites.then(async () => { if (!this.uids.includes(uid)) { const next = [...this.uids, uid]; await atomicJson(this.userFile, next); this.uids = next; } });
      this.userWrites = save.catch(() => {}); await save;
      this.spaces.set(uid, space); return space;
    })();
    this.pending.set(uid, operation);
    try { return await operation; } finally { this.pending.delete(uid); }
  }
  start(runtime) {
    const task = this.starts.then(() => {
      if (this.closing) throw new AppError('栖盒正在退出', 503);
      if ((!runtime.definition || runtime.definition.id === 'wechat') && (!this.library.installed() || this.library.uninstalling)) throw new AppError('请先完成微信安装', 409);
      return runtime.start();
    });
    this.starts = task.catch(() => {}); return task;
  }
  async suspendForUninstall() {
    await Promise.all(this.pending.values());
    for (const space of this.spaces.values()) await space.mutate(async () => {
      for (const item of space.instances.values()) if (item.meta.appId === 'wechat') await space.stop(item.meta.id);
    });
  }
  async close({ deadline = Infinity } = {}) {
    this.closing = true; await Promise.allSettled(this.pending.values());
    await Promise.all([...this.spaces.values()].map(x => x.close(deadline))); await this.preparing;
  }
}

class UserInstances {
  constructor(options) { Object.assign(this, options); this.instances = new Map(); this.queue = Promise.resolve(); }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.file = path.join(this.root, 'instances.json');
    this.catalog = (await jsonFile(this.file, [])).map(meta => ({ ...meta, appId: meta.appId ?? 'wechat' }));
    this.consent = await jsonFile(path.join(this.root, 'consent.json'), { accepted: false });
    for (const meta of this.catalog) {
      if (!validId(meta.id)) throw new Error('Invalid instance ID');
      // Retired providers retain their metadata/data on disk, but cannot load
      // a runtime, appear in the user's catalog or block the WeChat instances.
      try { applicationDefinition(meta.appId, this.appCatalog); } catch { continue; }
      if (!meta.removedAt) await this.load(meta);
    }
  }
  requireConsent() { if (!this.consent.accepted) throw new AppError('请先阅读并同意栖盒用户协议和隐私政策', 403); }
  requireInstalled(appId = 'wechat') { applicationDefinition(appId, this.appCatalog); if (appId === 'wechat' && (!this.library.installed() || this.library.uninstalling)) throw new AppError('请先安装微信，再打开或恢复数据', 409); }
  mutate(action) { const task = this.queue.then(action); this.queue = task.catch(() => {}); return task; }
  async setConsent(accepted) {
    if (typeof accepted !== 'boolean') throw new AppError('请选择是否同意');
    return this.mutate(async () => {
      await atomicJson(path.join(this.root, 'consent.json'), { accepted, at: new Date().toISOString(), version: 1 });
      this.consent.accepted = accepted;
      if (!accepted) for (const instance of this.instances.values()) { await instance.ai.suspend(); await instance.scheduler.pause(); await instance.exclusive(() => instance.runtime.stop()); }
      return { accepted };
    });
  }
  async load(meta) {
    const definition = applicationDefinition(meta.appId, this.appCatalog);
    const dataRoot = within(this.root, path.join(this.root, 'instances', meta.id)), home = path.join(dataRoot, 'home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    const options = { appRoot: this.appRoot, dataRoot, runtimeRoot: path.join(this.dataRoot, 'runtime'), dev: this.dev,
      application: () => this.library.installed(), store: { active: async () => ({ home }) },
      definition,
      sharedReady: async () => { await this.owner.ensureAssets(); if (this.owner.assets.status === 'error') throw new AppError('运行环境准备失败，请重新打开栖盒'); } };
    const runtime = this.runtimeFactory ? this.runtimeFactory(meta.id, options, this.uid) : await createAdapterRuntime(definition, options);
    runtime.definition = definition;
    const instance = { meta, runtime, home, dataRoot, tail: Promise.resolve(), busy: 0 };
    instance.exclusive = action => {
      instance.busy++;
      const task = instance.tail.then(action).finally(() => instance.busy--);
      instance.tail = task.catch(() => {}); return task;
    };
    instance.preparing = runtime.prepare();
    if (definition.id !== 'wechat') {
      instance.scheduler = manualSchedule(); instance.ai = inertAI();
      this.instances.set(meta.id, instance); return instance;
    }
    const [{ WechatScheduler, scheduleWindow }, { AIAssistant }, { DataChatBridge }] = await Promise.all([import('./scheduler.mjs'), import('./ai-service.mjs'), import('./ai-data.mjs')]);
    const scheduler = new WechatScheduler({ dataRoot, runtime,
      ready: () => !this.owner.closing && !meta.removedAt && !instance.busy && this.consent.accepted && !!this.library.installed() && !this.library.uninstalling,
      start: () => instance.exclusive(async () => { await instance.preparing; await this.owner.start(runtime); }),
      stop: () => instance.exclusive(() => runtime.stop()) });
    await scheduler.init(); instance.scheduler = scheduler;
    instance.ai = new AIAssistant({ dataRoot, bridge: runtime.aiBridge || new DataChatBridge(runtime), provider: this.aiProvider,
      ready: () => !this.owner.closing && !meta.removedAt && this.consent.accepted && runtime.status === 'running' });
    runtime.manualInput = event => instance.ai.manualInput(event);
    await instance.ai.init(); instance.ai.begin();
    this.instances.set(meta.id, instance);
    if (this.host !== 'ugos') {
      const resumeFile = path.join(dataRoot, 'session-resume.json'), saved = await jsonFile(resumeFile, {});
      // Consume before starting: a failed recovery must never loop or override a
      // later explicit stop. The stable instance home is used unchanged.
      if (saved.resume) await atomicJson(resumeFile, { resume: false });
      const windowAllowed = scheduler.settings.mode !== 'idle' || !scheduler.state.ownsProcess || scheduleWindow(scheduler.settings, new Date()).active;
      if (saved.resume && this.consent.accepted && !meta.removedAt && this.library.installed() && !this.library.uninstalling && !scheduler.isPaused() && windowAllowed) {
        try {
          await instance.preparing; await this.owner.start(runtime);
          if (saved.loggedIn) await scheduler.restoreLogin();
        } catch { runtime.message = '更新前的会话暂未恢复，请打开微信检查'; }
      }
    }
    scheduler.begin(); return instance;
  }
  get(id) {
    if (!validId(id) || !this.instances.has(id) || this.instances.get(id).meta.removedAt) throw new AppError('应用不存在', 404);
    return this.instances.get(id);
  }
  list() {
    return { instances: [...this.instances.values()].filter(x => !x.meta.removedAt).map(x => ({ ...x.meta, runtime: { ...x.runtime.publicState(), manualRecovery: false }, schedule: x.scheduler.publicState(), busy: !!x.busy })),
      retained: this.catalog.filter(x => x.removedAt && (this.appCatalog || APP_CATALOG).some(app => app.id === x.appId)).map(x => ({ id: x.id, appId: x.appId, name: x.name, removedAt: x.removedAt })) };
  }
  requireUniqueName(name, exceptId) {
    // Retained data reserves its name too. Call inside mutate so concurrent
    // creates, renames and restores share the same up-to-date catalog check.
    if (this.catalog.some(x => x.id !== exceptId && x.name.trim() === name)) throw new AppError('名称已存在，请修改名称', 409, 'NAME_CONFLICT');
  }
  async add(name, appId = 'wechat') {
    const definition = applicationDefinition(appId, this.appCatalog);
    name ??= definition.name;
    this.requireConsent();
    this.requireInstalled(appId);
    name = instanceName(name);
    return this.mutate(async () => {
      this.requireInstalled(appId);
      this.requireUniqueName(name);
      const meta = { id: randomUUID(), appId, name, createdAt: new Date().toISOString() };
      const instance = await this.load(meta);
      try { const next = [...this.catalog, meta]; await atomicJson(this.file, next); this.catalog = next; }
      catch (e) { await instance.ai.close(); await instance.scheduler.close(); this.instances.delete(meta.id); throw e; }
      return meta;
    });
  }
  async rename(id, name) {
    name = instanceName(name);
    return this.mutate(async () => { const item = this.get(id); this.requireUniqueName(name, id); const next = this.catalog.map(x => x.id === id ? { ...x, name } : x); await atomicJson(this.file, next); item.meta.name = name; this.catalog = next; return { id, name }; });
  }
  async start(id) {
    this.requireConsent();
    const item = this.get(id);
    this.requireInstalled(item.meta.appId);
    await item.scheduler.interact();
    return item.exclusive(async () => { this.get(id); this.requireConsent(); await item.preparing; await this.owner.start(item.runtime); return item.runtime.publicState(); });
  }
  async stop(id) { const item = this.get(id); await item.ai.suspend(); await item.scheduler.pause(); return item.exclusive(async () => { await item.runtime.stop(); return item.runtime.publicState(); }); }
  async schedule(id, value) {
    this.requireConsent(); this.requireInstalled();
    return this.mutate(async () => {
      this.requireInstalled(); const scheduler = this.get(id).scheduler;
      await scheduler.save(value); await scheduler.tick(); return scheduler.publicState();
    });
  }
  async remove(id, { deleteData = false, confirmName } = {}) {
    if (typeof deleteData !== 'boolean') throw new AppError('请选择是否保留数据');
    return this.mutate(async () => {
      const meta = this.catalog.find(x => x.id === id); if (!meta || !validId(id)) throw new AppError('应用不存在', 404);
      if (deleteData && confirmName !== `确认删除${meta.name}`) throw new AppError(`请输入：确认删除${meta.name}`);
      if (!meta.removedAt) {
        const item = this.get(id); await this.stop(id); await item.ai.close(); await item.scheduler.close(); await item.tail;
        await item.runtime.remove?.();
      }
      const next = this.catalog.map(x => x.id === id ? { ...x, removedAt: new Date().toISOString() } : x);
      await atomicJson(this.file, next); this.catalog = next;
      if (this.instances.has(id)) { this.instances.get(id).meta.removedAt = next.find(x => x.id === id).removedAt; this.instances.delete(id); }
      if (deleteData) {
        await rm(within(this.root, path.join(this.root, 'instances', id)), { recursive: true, force: true });
        const remaining = this.catalog.filter(x => x.id !== id); await atomicJson(this.file, remaining); this.catalog = remaining;
      }
      return { removed: true, retained: !deleteData };
    });
  }
  async restore(id, name) {
    this.requireConsent();
    return this.mutate(async () => {
      const old = this.catalog.find(x => x.id === id && x.removedAt); if (!old) throw new AppError('未找到保留的数据', 404);
      this.requireInstalled(old.appId);
      name = instanceName(name === undefined ? old.name : name);
      this.requireUniqueName(name, id);
      const { removedAt, ...meta } = old;
      meta.name = name;
      const item = await this.load(meta);
      try {
        await item.scheduler.save({ mode: 'manual', startTime: '02:00', endTime: '02:30' });
        const next = this.catalog.map(x => x.id === id ? meta : x); await atomicJson(this.file, next); this.catalog = next;
      } catch (error) { await item.ai.close(); await item.scheduler.close(); this.instances.delete(id); throw error; }
      return meta;
    });
  }
  async clearData() {
    return this.mutate(async () => {
      for (const item of this.instances.values()) if (item.meta.appId === 'wechat') {
        await this.stop(item.meta.id); await item.ai.close(); await item.scheduler.close(); await item.tail;
      }
      // An uninstall may remove shared executables, but this data operation is
      // restricted to the requesting user's own homes, including retained ones.
      for (const meta of this.catalog.filter(x => x.appId === 'wechat')) {
        await rm(within(this.root, path.join(this.root, 'instances', meta.id)), { recursive: true, force: true });
        this.instances.delete(meta.id);
      }
      this.catalog = this.catalog.filter(x => x.appId !== 'wechat'); await atomicJson(this.file, this.catalog);
      return { cleared: true };
    });
  }
  async close(deadline = Infinity) {
    await this.queue;
    await Promise.all([...this.instances.values()].map(async item => {
      await item.ai.close(); await item.scheduler.close(); await item.tail; await item.preparing;
      const retain = this.host !== 'ugos' && item.meta.appId === 'wechat';
      const resume = retain && this.consent.accepted && !item.meta.removedAt && item.runtime.status === 'running';
      const loggedIn = resume && item.runtime.publicState().loginStatus === 'logged-in';
      const file = path.join(item.dataRoot, 'session-resume.json');
      if (retain) await atomicJson(file, { resume: false });
      const clean = await item.runtime.stop({ force: Number.isFinite(deadline), deadline, shutdown: true });
      if (resume && clean !== false && !Number.isFinite(deadline)) await atomicJson(file, { resume: true, loggedIn });
    }));
  }
}
