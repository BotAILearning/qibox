import path from 'node:path';
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod, access, rename, rm, readdir, stat, symlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { AppError, atomicJson, jsonFile, hashFile } from './files.mjs';
import { restoreWechatWindow, wechatWindowVisible, DesktopWindowState } from './desktop.mjs';
import { fontConfiguration } from './fonts.mjs';
import { AutoLoginVerifier, readNativeLogin } from './auto-login.mjs';
import { LoginState } from './login-state.mjs';

import { architecture, runtimeLibraries, runtimePayload, runtimeArchive } from './platform.mjs';
import { ownClipboard } from './clipboard.mjs';
import { startAudio, ensureAudio } from './audio.mjs';
import { startFileChooser } from './file-chooser.mjs';
import { prepareXvfb, displayReady } from './x11.mjs';
import { nativeIdentity } from './native-identity.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exists(file) { try { await access(file); return true; } catch { return false; } }
function command(bin, args, env, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { error += x; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`${path.basename(bin)} failed (${code}): ${error.slice(-2400)}`)); });
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitPort(port, child) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error('VNC service exited');
    const ok = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false)); socket.setTimeout(200, () => { socket.destroy(); resolve(false); });
    });
    if (ok) return;
    await delay(100);
  }
  throw new Error('VNC startup timed out');
}

export class Runtime {
  constructor({ appRoot, dataRoot, store, dev = false, runtimeRoot, sharedReady, application, definition = { id: 'wechat', name: '微信' } }) {
    this.definition = definition; this.isWechat = definition.id === 'wechat';
    this.application = application; this.appRoot = appRoot; this.dataRoot = dataRoot; this.store = store; this.dev = dev;
    this.status = 'preparing'; this.message = ''; this.processes = []; this.port = null; this.password = null;
    this.runtimeRoot = runtimeRoot || path.join(dataRoot, 'runtime'); this.sharedReady = sharedReady; this.logPath = path.join(dataRoot, 'logs');
    this.tag = createHash('sha256').update(path.resolve(dataRoot)).digest('hex');
    this.desktopViewers = 0; this.foregroundUntil = 0;
    this.windowState = new DesktopWindowState({ probe: () => wechatWindowVisible({ root: this.runtimeRoot, env: this.desktopEnv,
      command, pid: this.processes.find(x => x.name === 'wechat')?.process.pid }) });
    this.loginState = new LoginState({ probe: () => readNativeLogin({ appRoot, runtimeRoot: this.runtimeRoot,
      env: this.desktopEnv, pid: this.processes.find(x => x.name === 'wechat')?.process.pid, session: true }) });
    this.loginVerifier = this.isWechat ? new AutoLoginVerifier({ dataRoot, home: async () => (await this.store.active()).home, application,
      probe: options => readNativeLogin({ appRoot, runtimeRoot: this.runtimeRoot, env: this.desktopEnv,
        pid: this.processes.find(x => x.name === 'wechat')?.process.pid, ...options }) }) : { async started() {}, async stopped() {}, async clear() {} };
  }
  async foregroundRequested() {
    this.foregroundUntil = Date.now() + 60000;
    this.loginInspectionController?.abort();
    await this.loginInspection?.catch(() => {});
  }
  desktopConnected() {
    this.desktopViewers++;
    return () => { this.desktopViewers = Math.max(0, this.desktopViewers - 1); this.foregroundUntil = Date.now() + 60000; };
  }
  async inspectAutoLogin({ signal, requested = false } = {}) {
    if (this.dev) return Promise.resolve({ status: 'unknown' });
    if (this.loginInspection) {
      if (!requested) return this.loginInspection;
      await this.loginInspection.catch(() => {});
    }
    const controller = new AbortController(); this.loginInspectionController = controller;
    const operation = this.loginVerifier.inspect({ running: this.status === 'running', stopped: this.status === 'stopped',
      navigate: this.desktopViewers === 0 && (requested || Date.now() >= this.foregroundUntil), requested,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
    const tracked = operation.finally(() => { if (this.loginInspection === tracked) { this.loginInspection = null; this.loginInspectionController = null; } });
    this.loginInspection = tracked; return tracked;
  }
  publicState() {
    if (!this.isWechat) return { status: this.status, message: this.message, version: this.application?.()?.version || null, mode: this.dev ? 'development' : 'native', canConnect: this.status === 'running', windowVisible: this.status === 'running' };
    if (this.status === 'running' && !this.dev) { void this.loginState.refresh(); void this.windowState.refresh(); }
    return { status: this.status, loginStatus: this.loginState.state(this.status === 'running'), aiEntryAvailable: this.loginState.entryAvailable(this.status === 'running'), windowVisible: this.windowState.state(this.status === 'running'), message: this.message,
      ...this.loginState.details(this.status === 'running'), audioAvailable: !!this.audioSocket, version: this.application?.()?.version || null, mode: this.dev ? 'development' : 'native', canConnect: this.status === 'running' };
  }
  async prepare() {
    await mkdir(this.logPath, { recursive: true, mode: 0o700 });
    if (this.dev) { this.status = 'unavailable'; this.message = '请将安装包安装到 NAS 后使用应用'; return; }
    try {
      if (process.platform !== 'linux') throw new AppError('请在 NAS 上运行');
      architecture();
      const payloadRoot = await runtimePayload(this.appRoot);
      await this.stopTagged(false);
      if (this.sharedReady) {
        await this.sharedReady();
        this.lock = await jsonFile(path.join(payloadRoot, 'runtime-lock.json'));
        if (this.lock.platform !== `linux-${process.arch}`) throw new AppError('栖盒安装包与设备架构不符，请重新安装');
        const ready = await jsonFile(path.join(this.runtimeRoot, 'ready.json'), null);
        if (ready?.fingerprint !== createHash('sha256').update(JSON.stringify(this.lock)).digest('hex')) throw new Error('Shared runtime is not prepared');
        this.xvfb = await prepareXvfb(this.appRoot, this.runtimeRoot);
        this.status = 'stopped'; this.message = ''; return;
      }
      this.lock = await jsonFile(path.join(payloadRoot, 'runtime-lock.json'));
      if (this.lock.platform !== `linux-${process.arch}`) throw new AppError('栖盒安装包与设备架构不符，请重新安装');
      const glibc = process.report?.getReport().header.glibcVersionRuntime;
      if (!glibc || Number(glibc.split('.')[0]) < 2 || (Number(glibc.split('.')[0]) === 2 && Number(glibc.split('.')[1]) < 36)) throw new AppError('系统运行库版本较低，请更新 NAS 系统');
      const fingerprint = createHash('sha256').update(JSON.stringify(this.lock)).digest('hex');
      const ready = await jsonFile(path.join(this.runtimeRoot, 'ready.json'), null);
      if (ready?.fingerprint !== fingerprint) {
        const staging = `${this.runtimeRoot}.preparing`;
        // Only remove our own disposable extraction directory, never user profiles.
        if (!staging.startsWith(path.resolve(this.dataRoot) + path.sep)) throw new Error('Runtime path escaped data root');
        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { recursive: true, mode: 0o700 });
        const archives = this.lock.packages;
        for (let i = 0; i < archives.length; i++) {
          this.message = `正在准备应用 ${Math.round(i / archives.length * 100)}%`;
          const archive = archives[i];
          const { filename, sha256 } = runtimeArchive(this.appRoot, payloadRoot, archive);
          if (await hashFile(filename) !== sha256) throw new AppError('安装包校验失败，请重新安装');
          const entries = await command('/bin/tar', ['-tf', filename], process.env);
          if (entries.split('\n').some(p => p.startsWith('/') || p.split('/').includes('..'))) throw new Error('Unsafe runtime archive');
          await command('/bin/tar', ['-xf', filename, '-C', staging, '--no-same-owner', '--no-same-permissions'], process.env, 180000);
        }
        const old = `${this.runtimeRoot}.previous`;
        if (await exists(this.runtimeRoot)) {
          await rm(old, { recursive: true, force: true });
          await rename(this.runtimeRoot, old);
        }
        await rename(staging, this.runtimeRoot);
        await atomicJson(path.join(this.runtimeRoot, 'ready.json'), { fingerprint });
      }
      this.xvfb = await prepareXvfb(this.appRoot, this.runtimeRoot);
      this.status = 'stopped'; this.message = '';
    } catch (error) {
      this.status = 'error'; this.message = error instanceof AppError ? error.message : '准备失败，请重新打开栖盒';
      this.lastError = String(error.stack || error);
      await writeFile(path.join(this.logPath, 'prepare.log'), this.lastError, { mode: 0o600 });
    }
  }
  child(bin, args, env, name, cwd = env.HOME, displayPipe = false) {
    const stream = createWriteStream(path.join(this.logPath, `${name}.log`), { flags: 'w', mode: 0o600 });
    const process = spawn(bin, args, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...(displayPipe ? ['pipe'] : [])] });
    process.stdout.pipe(stream, { end: false }); process.stderr.pipe(stream, { end: false });
    process.on('error', error => { stream.write(String(error)); this.lastError = `${name}: ${error.message}`; });
    process.on('close', () => stream.end());
    this.processes.push({ process, name });
    return process;
  }
  async start() {
    if (this.status === 'running') return;
    if (this.dev) throw new AppError('请在 NAS 中打开应用');
    // A failed start can leave children that ignore SIGTERM (a stuck x11vnc, a
    // WeChat that never reached its window). Without clearing them here every
    // later start replays the same "应用仍在退出" refusal and the desktop can
    // never come back on its own, so the retry cleans up forcefully first.
    if (this.status === 'error') await this.stop({ force: true, deadline: Date.now() + 5000 });
    if (this.status !== 'stopped') throw new AppError('应用尚未准备好，请稍后重试', 409);
    this.status = 'starting'; this.message = '正在打开应用';
    this.loginState.reset();
    this.windowState.reset();
    try {
      await this.loginVerifier.started();
      const profile = await this.store.active();
      const root = this.runtimeRoot, triple = architecture().triple;
      const installed = this.application?.();
      if (!installed) throw new AppError('请先安装微信', 409);
      const applicationRoot = installed.directory;
      // Keep Unix socket paths below Linux's 108-byte limit, including UGOS's
      // longer package prefix and opaque account IDs. Each instance stays private.
      const session = path.join(path.dirname(this.runtimeRoot), 'sessions', this.tag.slice(0, 32));
      await mkdir(session, { recursive: true, mode: 0o700 }); await chmod(session, 0o700);
      await rm(path.join(session, 'clipboard-files'), { recursive: true, force: true });
      await rm(path.join(session, 'xkbcomp'), { force: true });
      await symlink(path.join(root, 'usr/bin/xkbcomp'), path.join(session, 'xkbcomp'));
      const xauthority = path.join(session, 'Xauthority');
      await writeFile(xauthority, '', { mode: 0o600 });
      const env = { QIBOX_RUNTIME_TAG: this.tag,
        HOME: profile.home, USER: process.env.TRIM_USERNAME || process.env.USER,
        DISPLAY: ':0', XAUTHORITY: xauthority, TMPDIR: session,
        XDG_RUNTIME_DIR: session, XDG_CONFIG_HOME: path.join(profile.home, '.config'), XDG_DATA_HOME: path.join(profile.home, '.local/share'), XDG_CACHE_HOME: path.join(profile.home, '.cache'),
        XDG_DATA_DIRS: `${root}/usr/share:/usr/local/share:/usr/share`, XDG_CONFIG_DIRS: `${root}/etc/xdg`,
        XKB_CONFIG_ROOT: `${root}/usr/share/X11/xkb`,
        PATH: `${root}/usr/bin:${root}/bin:/usr/local/bin:/usr/bin:/bin`,
        LD_LIBRARY_PATH: runtimeLibraries(root),
        GCONV_PATH: `/lib/${triple}/gconv`, LOCPATH: '/lib/locale',
        LANG: 'zh_CN.UTF-8', QT_QPA_PLATFORM: 'xcb', QT_QPA_PLATFORMTHEME: 'xdgdesktopportal', QT_AUTO_SCREEN_SCALE_FACTOR: '0', QT_SCALE_FACTOR: '1',
        IMLIB2_LOADER_PATH: `${root}/usr/lib/${triple}/imlib2/loaders`,
        FONTCONFIG_FILE: path.join(session, 'fonts.conf'),
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${encodeURIComponent(path.join(session, 'bus'))}`,
        AT_SPI_BUS_ADDRESS: `unix:path=${encodeURIComponent(path.join(session, 'bus'))}`,
      };
      Object.assign(env, await nativeIdentity({ session, home: profile.home, runtimeRoot: root }));
      for (const dir of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME]) await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(env.FONTCONFIG_FILE, fontConfiguration(root, path.join(env.XDG_CACHE_HOME, 'fontconfig'), path.join(this.appRoot, 'fonts')), { mode: 0o600 });
      const cookie = randomBytes(16).toString('hex');
      // The server reads the cookie before exposing its listener; after it picks
      // a free display, add the matching client-side authority record.
      await command(`${root}/usr/bin/xauth`, ['-f', xauthority, 'add', env.DISPLAY, '.', cookie], env);
      this.desktopEnv = env;
      const xserver = this.child(this.xvfb, ['-displayfd', '3', '-screen', '0', '1280x800x24', '-s', '0', '-nolisten', 'tcp', '-nolisten', 'unix', '-auth', xauthority, '-fp', 'built-ins', '-xkbdir', `${root}/usr/share/X11/xkb`], env, 'display', session, true);
      env.DISPLAY = await displayReady(xserver);
      await command(`${root}/usr/bin/xauth`, ['-f', xauthority, 'add', env.DISPLAY, '.', cookie], env);
      await rm(path.join(session, 'bus'), { force: true });
      const dbusConfig = path.join(session, 'dbus.conf');
      await writeFile(dbusConfig, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd"><busconfig><type>session</type><listen>${env.DBUS_SESSION_BUS_ADDRESS}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>`);
      const dbus = this.child(`${root}/usr/bin/dbus-daemon`, ['--nofork', `--config-file=${dbusConfig}`], env, 'dbus');
      for (let i = 0; i < 50 && !await exists(path.join(session, 'bus')); i++) {
        if (dbus.exitCode !== null) throw new Error('Desktop message bus failed to start');
        await delay(100);
      }
      if (!await exists(path.join(session, 'bus'))) throw new Error('Desktop message bus timed out');
      if (this.isWechat) {
      const portal = await startFileChooser({ appRoot: this.appRoot, runtimeRoot: root, dataRoot: this.dataRoot, env });
      this.fileChooser = portal.chooser;
      this.processes.push({ process: portal.process, name: 'file-chooser' });
      portal.process.once('close', () => { if (this.fileChooser === portal.chooser) this.fileChooser = null; });
      }
      // Use the instance's private bus and bundled registry; no host service or
      // shared desktop is queried. Failure keeps eligibility closed.
      this.child(`${root}/usr/libexec/at-spi2-registryd`, [], env, 'accessibility');
      this.child(`${root}/usr/bin/python3.11`, [path.join(this.appRoot, 'server/accessibility-bus.py')],
        { ...env, PYTHONHOME: `${root}/usr`, PYTHONNOUSERSITE: '1' }, 'accessibility-bus');
      const wmConfig = path.join(session, 'openbox.xml');
      await writeFile(wmConfig, '<openbox_config xmlns="http://openbox.org/3.4/rc"><focus><focusNew>yes</focusNew></focus><applications><application type="normal"><maximized>yes</maximized></application></applications></openbox_config>');
      this.child(`${root}/usr/bin/openbox`, ['--sm-disable', '--config-file', wmConfig], env, 'windows');
      await this.applyBackground();
      this.password = randomBytes(6).toString('base64').slice(0, 8);
      const passwordFile = path.join(session, 'vnc.passwd');
      await command(`${root}/usr/bin/x11vnc`, ['-storepasswd', this.password, passwordFile], env);
      await chmod(passwordFile, 0o600);
      this.port = await freePort();
      // The browser owns the pointer. Sending a second cursor creates duplicates
      // on touch-capable browsers where noVNC uses a floating cursor canvas.
      const vnc = this.child(`${root}/usr/bin/x11vnc`, ['-display', env.DISPLAY, '-auth', xauthority, '-rfbauth', passwordFile, '-listen', '127.0.0.1', '-rfbport', String(this.port), '-forever', '-shared', '-noxdamage', '-noxrecord', '-nocursor', '-quiet'], env, 'desktop');
      await waitPort(this.port, vnc);
      const candidates = this.isWechat ? [`${applicationRoot}/opt/wechat/wechat`, `${applicationRoot}/opt/wechat/WeChat`] : [installed.executable];
      let binary;
      for (const candidate of candidates) if (await exists(candidate)) { binary = candidate; break; }
      if (!binary) throw new Error('Application executable not found');
      if (this.isWechat) try { await startAudio(this, env); } catch (error) { this.audioError = error.message; this.audioSocket = null; }
      if (this.isWechat) { clearInterval(this.audioRecovery); this.audioRecovery = setInterval(() => { if (this.status === 'running') void ensureAudio(this).catch(error => { this.audioError = error.message; }); }, 5000); this.audioRecovery.unref(); }
      // Both official executables have private libraries. UGOS exposes the
      // system libraries under /lib, including PulseAudio's private directory.
      const wechat = this.child(binary, [], this.isWechat ? { ...env, LD_LIBRARY_PATH: `${path.join(applicationRoot, 'opt/wechat')}:${path.join(applicationRoot, 'opt/wechat/RadiumWMPF/runtime')}:${env.LD_LIBRARY_PATH}:/lib/${triple}/pulseaudio` } : env, this.isWechat ? 'wechat' : 'application');
      await delay(2500);
      if (wechat.exitCode !== null || wechat.signalCode !== null) throw new Error(`WeChat exited with ${wechat.signalCode || wechat.exitCode}`);
      this.status = 'running'; this.message = '';
      if (this.isWechat) void this.loginState.refresh();
      wechat.on('close', () => { if (this.status === 'running') { this.status = 'error'; this.message = '应用已退出，请重新打开'; this.port = null; this.password = null; } });
    } catch (error) {
      this.lastError = String(error.stack || error);
      await writeFile(path.join(this.logPath, 'start.log'), this.lastError, { mode: 0o600 }).catch(() => {});
      await this.stop({ force: true });
      this.status = 'error'; this.message = '应用启动失败，请稍后重新打开';
      throw new AppError(this.message, 500);
    }
  }
  async showWindow() {
    if (!this.isWechat) return this.status === 'running';
    if (this.status !== 'running' || !this.desktopEnv) return false;
    if (this.showingWindow) return this.showingWindow;
    const operation = restoreWechatWindow({ root: this.runtimeRoot, env: this.desktopEnv, command,
      pid: this.processes.find(x => x.name === 'wechat')?.process.pid });
    this.showingWindow = operation;
    try { return await operation; } finally { this.showingWindow = null; await this.windowState.refresh(true); }
  }
  async showLogin() {
    if (this.status !== 'running') throw new AppError('请先连接应用', 409);
    await this.foregroundRequested();
    await this.showWindow();
    await readNativeLogin({ appRoot: this.appRoot, runtimeRoot: this.runtimeRoot, env: this.desktopEnv,
      pid: this.processes.find(x => x.name === 'wechat')?.process.pid, session: true, loginPage: true });
    await this.loginState.refresh(true);
    return this.publicState();
  }
  async confirmScheduledLogin() {
    if (this.dev || this.status !== 'running' || this.desktopViewers > 0 || Date.now() < this.foregroundUntil) return { status: 'unknown' };
    if (this.loginInspection) return { status: 'unknown' };
    const controller = new AbortController(); this.loginInspectionController = controller;
    const operation = readNativeLogin({ appRoot: this.appRoot, runtimeRoot: this.runtimeRoot, env: this.desktopEnv,
      pid: this.processes.find(x => x.name === 'wechat')?.process.pid, session: true, scheduledLogin: true, signal: controller.signal });
    const tracked = operation.finally(() => {
      if (this.loginInspection === tracked) { this.loginInspection = null; this.loginInspectionController = null; }
    });
    this.loginInspection = tracked;
    return tracked;
  }
  async applyBackground() {
    if (!this.desktopEnv) return;
    const setter = `${this.runtimeRoot}/usr/bin/hsetroot`;
    const wallpaper = path.join(this.appRoot, 'public/backgrounds/mist.jpg');
    await command(setter, ['-fill', wallpaper], this.desktopEnv)
      .catch(() => command(setter, ['-solid', '#eaf0ec'], this.desktopEnv).catch(() => {}));
  }
  async setClipboard(text) {
    if (this.status !== 'running' || !this.desktopEnv) throw new AppError('请先打开应用', 409);
    if (this.clipboardSetting) throw new AppError('正在粘贴，请稍候', 409);
    this.clipboardSetting = ownClipboard({ ...(typeof text === 'object' ? { files: text.files } : { text }), env: this.desktopEnv, appRoot: this.appRoot, runtimeRoot: this.runtimeRoot, previous: this.clipboardProcess });
    let process;
    try { process = await this.clipboardSetting; } finally { this.clipboardSetting = null; }
    this.clipboardProcess = process;
    const entry = { process, name: 'clipboard' }; this.processes.push(entry);
    process.once('close', () => { this.processes = this.processes.filter(item => item !== entry); if (this.clipboardProcess === process) this.clipboardProcess = null; });
    return { ready: true };
  }
  async stop({ force = false, deadline = Infinity } = {}) {
    this.status = 'stopping';
    clearInterval(this.audioRecovery);
    await this.audioStarting?.catch(() => {});
    this.loginState.reset();
    this.windowState.reset();
    await this.foregroundRequested();
    await this.fileChooser?.close(); this.fileChooser = null;
    for (const listener of this.audioListeners || []) listener.destroy();
    this.audioListeners?.clear(); this.audioSocket = null;
    await this.clipboardSetting?.catch(() => {});
    await this.showingWindow?.catch(() => {});
    const hadProcesses = this.processes.length > 0;
    if (hadProcesses) this.status = 'stopping';
    let clean = true;
    for (const entry of [...this.processes].reverse()) {
      const pid = entry.process.pid;
      if (!pid) continue;
      const alive = () => { try { process.kill(-pid, 0); return true; } catch { return false; } };
      try { process.kill(-pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 80 && alive() && Date.now() < deadline; i++) await delay(100);
      if (alive()) {
        clean = false;
        if (!force) { this.status = 'error'; this.message = '应用仍在退出，请稍后重试'; throw new AppError(this.message, 409); }
        try { process.kill(-pid, 'SIGKILL'); } catch {}
      }
    }
    if (!this.dev) await this.stopTagged(force, deadline);
    if (this.desktopEnv?.TMPDIR) await rm(path.join(this.desktopEnv.TMPDIR, 'clipboard-files'), { recursive: true, force: true });
    this.processes = []; this.port = null; this.password = null; this.desktopEnv = null;
    if (clean && !force) await this.loginVerifier.stopped();
    else await this.loginVerifier.clear();
    if (!this.dev && this.status !== 'preparing') { this.status = 'stopped'; this.message = ''; }
    return clean;
  }
  async taggedProcesses() {
    if (process.platform !== 'linux') return [];
    const result = [];
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if ((await stat(`/proc/${name}`)).uid !== process.getuid()) continue;
        const env = await readFile(`/proc/${name}/environ`);
        if (env.toString().split('\0').includes(`QIBOX_RUNTIME_TAG=${this.tag}`)) result.push(Number(name));
      } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    }
    return result;
  }
  async stopTagged(force, deadline = Infinity) {
    let children = await this.taggedProcesses();
    if (!children.length) return;
    for (const pid of children) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    for (let i = 0; i < 80 && Date.now() < deadline; i++) {
      await delay(100); children = await this.taggedProcesses(); if (!children.length) return;
    }
    if (!force) throw new AppError('应用仍在退出，请稍后重试', 409);
    for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}
