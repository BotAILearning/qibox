import http from 'node:http';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, chmod, rm, lstat } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { AppError, jsonFile } from './files.mjs';
import { PackageLibrary } from './packages.mjs';
import { Instances } from './instances.mjs';
import { desktopSocket } from './desktop-socket.mjs';
import { NasFiles } from './nas-files.mjs';
import { validateClipboard, validateClipboardFiles } from './clipboard.mjs';
import { applicationDefinition, marketState } from './catalog.mjs';
import { gatewayIdentity, platformConfig } from './platform.mjs';
import { DesktopStreams } from './desktop-stream.mjs';
import { RfbInputGate } from './rfb-input.mjs';
import { streamAudio } from './audio.mjs';
import { proxyWebApp } from './web-app.mjs';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req, limit = 360064) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('请求格式错误', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new AppError('请求过大', 413); chunks.push(chunk); }
  try { const data = JSON.parse(Buffer.concat(chunks).toString()); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; }
  catch { throw new AppError('请求格式错误'); }
}
export async function createApplication({ appRoot = moduleRoot, dataRoot = path.join(appRoot, '.dev-data'), dev = false, runtimeFactory, fetcher, extract, aiProvider, trustedHashes, nasFiles = new NasFiles(), host = 'fnos', arch = process.arch } = {}) {
  dataRoot = path.resolve(dataRoot); await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const product = await jsonFile(path.join(appRoot, 'config/product.json')), prefix = host === 'ugos' ? '/api/qibox' : product.gatewayPrefix;
  const streams = new DesktopStreams();
  const secret = randomBytes(32), devKey = randomBytes(24).toString('hex');
  const token = uid => createHmac('sha256', secret).update(uid).digest('hex');
  const tickets = new Map();
  const ticketTimer = setInterval(() => { for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key); }, 30000); ticketTimer.unref();
  function identity(req) {
    if (dev) {
      const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('qibox_dev='))?.slice(10);
      if (!equal(cookie, devKey)) throw new AppError('请从预览链接打开栖盒', 401);
      return { uid: 'development', username: '本地预览', isAdmin: true };
    }
    return gatewayIdentity(req, host);
  }
  function check(req, user) { if (req.headers['sec-fetch-site'] === 'cross-site' || !equal(req.headers['x-csrf-token'], token(user.uid))) throw new AppError('页面已过期，请刷新后重试', 403); }
  const library = new PackageLibrary({ appRoot, dataRoot, dev, fetcher, extract, arch, ...(trustedHashes ? { trustedHashes } : {}) }); await library.init();
  const users = new Instances({ appRoot, dataRoot, dev, host, library, runtimeFactory, aiProvider }); await users.init();
  library.beforeInstall = async () => { await users.ensureAssets(); if (users.assets.status === 'error') throw new AppError('准备失败，请重新打开栖盒'); };
  library.beforeUninstall = () => users.suspendForUninstall();
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === prefix) { res.writeHead(302, { Location: `${prefix}/${url.search}` }); res.end(); return; }
      if (!url.pathname.startsWith(`${prefix}/`)) throw new AppError('页面不存在', 404);
      if (dev && equal(url.searchParams.get('dev'), devKey)) {
        res.writeHead(303, { Location: `${prefix}/`, 'Set-Cookie': `qibox_dev=${devKey}; HttpOnly; SameSite=Strict; Path=${prefix}/`, 'Cache-Control': 'no-store' }); res.end(); return;
      }
      const route = url.pathname.slice(prefix.length);
      const user = identity(req);
      const webApp = /^\/applications\/([a-f0-9-]{36})(\/.*)$/.exec(route);
      if (webApp) { const space = await users.get(user.uid); space.requireConsent(); return await proxyWebApp(space.get(webApp[1]).runtime, req, res, webApp[2] + url.search); }
      if (host === 'ugos' && route === '/desktop/stream' && req.method === 'GET') {
        const key = url.searchParams.get('ticket'), ticket = tickets.get(key);
        if (!ticket || ticket.uid !== user.uid || ticket.expires < Date.now()) throw new AppError('请重新打开桌面', 403);
        tickets.delete(key);
        const space = await users.get(user.uid); space.requireConsent(); const item = space.get(ticket.id);
        if (item.runtime.status !== 'running' || !item.runtime.port) throw new AppError('请先打开应用', 409);
        await streams.open(key, user.uid, item.runtime, req, res); return;
      }
      if (host === 'ugos' && route === '/desktop/input' && req.method === 'POST') {
        check(req, user); const space = await users.get(user.uid); space.requireConsent();
        await streams.input(url.searchParams.get('ticket'), user.uid, req); res.writeHead(204); res.end(); return;
      }
      if (route.startsWith('/api/')) {
        const space = await users.get(user.uid);
        if (req.method === 'GET' && route === '/api/session') return send(res, 200, { user, product, dev, host, capabilities: { nasPicker: host === 'fnos' }, csrf: token(user.uid), consent: space.consent });
        if (req.method === 'GET' && route === '/api/state') return send(res, 200, { catalog: marketState({ wechat: library }), library: library.publicState(), ...space.list() });
        const aiMatch = /^\/api\/instances\/([a-f0-9-]{36})\/ai$/.exec(route);
        const aiReportMatch = /^\/api\/instances\/([a-f0-9-]{36})\/ai\/reports\/([a-f0-9-]{36})$/.exec(route);
        if (req.method === 'GET' && (aiMatch || aiReportMatch)) {
          space.requireConsent(); const item = space.get((aiMatch || aiReportMatch)[1]); if (item.meta.appId !== 'wechat') throw new AppError('此应用不支持 AI', 409);
          return send(res, 200, aiReportMatch ? item.ai.analysisReport(aiReportMatch[2]) : item.ai.publicState());
        }
        if (req.method !== 'POST') throw new AppError('请求方式不支持', 405);
        check(req, user);
        const installMatch = /^\/api\/apps\/([^/]+)\/install\/(upload|uninstall|download|nas)$/.exec(route);
        if (installMatch) { applicationDefinition(installMatch[1]); if (installMatch[1] !== 'wechat') throw new AppError('此应用无需导入安装包', 409); }
        // Keep the original URLs for older open pages during an upgrade.
        const installRoute = installMatch ? `/api/install/${installMatch[2]}` : route;
        if (installRoute === '/api/install/upload') {
          space.requireConsent();
          if (req.headers['content-type'] !== 'application/octet-stream') throw new AppError('请选择微信 deb 安装包', 415);
          return send(res, 200, await library.upload(req, Number(req.headers['content-length'])));
        }
        const fileUpload = /^\/api\/instances\/([a-f0-9-]{36})\/file-upload\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/.exec(route);
        if (fileUpload) {
          space.requireConsent();
          const item = space.get(fileUpload[1]);
          if (item.runtime.status !== 'running' || !item.runtime.fileChooser) throw new AppError('请先打开微信', 409);
          if (req.headers['content-type'] !== 'application/octet-stream' || !/^\d+$/.test(req.headers['content-length'] || '')) throw new AppError('无法读取文件，请重新选择', 415);
          return send(res, 200, await item.runtime.fileChooser.upload(fileUpload[2], req.headers['x-file-client'], fileUpload[3], req, Number(req.headers['content-length'])));
        }
        const data = await body(req, /^\/api\/instances\/[a-f0-9-]{36}\/clipboard$/.test(route) ? 29 * 1024 * 1024 : 360064);
        if (route === '/api/consent') return send(res, 200, await space.setConsent(data.accepted));
        space.requireConsent();
        const audioMatch = /^\/api\/instances\/([a-f0-9-]{36})\/audio$/.exec(route);
        if (audioMatch) return await streamAudio(space.get(audioMatch[1]).runtime, req, res);
        if (aiMatch) {
          if (space.get(aiMatch[1]).meta.appId !== 'wechat') throw new AppError('此应用不支持 AI', 409);
          const ai = space.get(aiMatch[1]).ai;
          const handlers = { configure: () => ai.configure(data.value, data.scope), test: () => ai.testProvider(data.scope), models: () => ai.discoverModels(data.value, data.scope), 'model-test': () => ai.testModel(data.value), 'models-save': () => ai.saveModels(data.value), scan: () => ai.scan(),
            'verify-provider': () => ai.verifyProvider(data.value, data.scope), 'reply-options': () => ai.setReplyOptions(data.value || {}),
            'analysis-use-chat': () => ai.useSharedAnalysis(), 'analysis-report-delete': () => ai.deleteAnalysisReport(data.id || data.value?.id), 'contact-remark': () => ai.setContactRemark(data.id, data.value || {}),
            'group-options': () => ai.setGroupOptions(data.value || {}),
            calendar: () => ai.calendar(data.value || {}), learn: () => ai.learn(data.value || {}), analyze: () => ai.analyze(data.value || {}), cancel: () => ai.cancel(), settings: () => ai.settings(data.value || {}),
            strategy: () => ai.saveStrategy(data.value, data.id, data.mode), 'apply-reply-limit': () => ai.applyReplyLimitToKind(data.value?.kind, data.value?.maxRounds), profile: () => ai.editProfile(data.id, data.value || {}),
            'reply-profile': () => ai.saveReplyProfile(data.value || {}),
            'save-default-style': () => ai.saveDefaultStyle(data.value || {}), 'clear-default-style': () => ai.clearDefaultStyle(), 'apply-default-style': () => ai.applyDefaultStyle(),
            'cancel-default-style': () => ai.cancelDefaultStyle(), 'commit-default-style': () => ai.commitDefaultStyle(data.value || {}),
            schedule: () => ai.scheduleAction(data.value || {}), review: () => ai.review(data.id, data.value || {}),
            targets: () => ai.targets(data.ids, data.mode), 'prepare-targets': () => ai.prepareTargets(data.value || {}), queue: () => ai.queueAction(data.command), activity: () => ai.userActivity(),
            'activity-records': () => ai.activityRecords(data.ids || [], data.filters || {}), 'delete-activity-record': () => ai.deleteActivityRecord(data.value || {}), 'mark-reply-needed': () => ai.markReplyNeeded(data.value || {}), 'activity-summary': () => ai.summarizeActivity(data.id, data.value?.range),
            'clear-activity-errors': () => ai.clearActivityErrors(), 'error-records': () => ai.errorRecords(data.value || {}),
            'proactive-task': () => ai.proactiveTaskAction(data.value || {}),
            'proactive-records': () => ai.proactiveRecords(data.value || {}),
            'open-conversation': () => data.value?.fast === true ? ai.openConversationFast(data.id) : ai.openConversation(data.id, data.value || {}),
            'locate-conversation': () => ai.openConversation(data.id, data.value || {}),
            memory: () => ai.editMemory(data.id, data.value),
            'contact-memory': () => ai.editContactMemory(data.value?.contact, data.value),
            'memory-apply': () => ai.applyPendingMemory(data.id), 'memory-merge': () => ai.mergePendingMemory(data.id), 'memory-discard': () => ai.discardPendingMemory(data.id),
            // Only this explicit, owner-scoped POST may reveal a saved key.
            // Ordinary settings responses and polling never contain it.
            'reveal-key': () => {
              const config = data.modelId ? (ai.models.find(m => m.id === data.modelId) || null) : ai.providerConfig(data.scope);
              if (!config?.apiKey) throw new AppError('请先填写 API Key');
              return { apiKey: config.apiKey, baseUrl: config.baseUrl, protocol: config.protocol || 'openai', modelId: data.modelId || null };
            } };
          if (!Object.hasOwn(handlers, data.action)) throw new AppError('AI 操作无效');
          return send(res, 200, await handlers[data.action]());
        }
        if (installRoute === '/api/install/uninstall') {
          if (!user.isAdmin) throw new AppError('请由 NAS 管理员卸载微信', 403);
          if (typeof data.deleteData !== 'boolean') throw new AppError('请选择是否保留数据');
          if (data.deleteData && data.confirmName !== '确认删除微信') throw new AppError('请输入：确认删除微信');
          return send(res, 200, await library.uninstall({ clearData: data.deleteData ? () => space.clearData() : undefined }));
        }
        if (installRoute === '/api/install/download') return send(res, 202, await library.download({ allowUnverified: data.allowUnverified === true }));
        if (installRoute === '/api/install/nas') { if (host !== 'fnos') throw new AppError('请从本机上传安装包', 409); return send(res, 202, library.importNas(nasFiles, user.uid, data.path)); }
        if (route === '/api/instances') return send(res, 201, await space.add(data.name, data.appId));
        const match = /^\/api\/instances\/([a-f0-9-]{36})\/(start|stop|rename|settings|delete|restore|desktop|show|login|recheck|clipboard|files)$/.exec(route);
        if (!match) throw new AppError('页面不存在', 404);
        const [, id, action] = match;
        if (action === 'restore') return send(res, 200, await space.restore(id, data.name));
        if (action === 'delete') return send(res, 200, await space.remove(id, data));
        const item = space.get(id);
        if (action === 'files') {
          const chooser = item.runtime.fileChooser;
          if (data.action === 'state') return send(res, 200, { available: !!chooser && item.runtime.status === 'running', ...(chooser?.state(data.client) || { request: null }) });
          if (!chooser || item.runtime.status !== 'running') throw new AppError('请先打开微信', 409);
          if (data.action === 'claim') return send(res, 200, chooser.claim(data.id, data.client));
          if (data.action === 'export-start') return send(res, 200, await chooser.exports.start(data.id, data.client, data.name));
          if (data.action === 'export-folder') return send(res, 200, await chooser.exports.folder(data.id, data.client));
          if (data.action === 'export-finish') return send(res, 200, await chooser.exports.finish(data.id, data.client));
          if (data.action === 'export-nas') {
            if (host !== 'fnos') throw new AppError('此设备暂不支持 NAS 文件夹授权选择', 409);
            return send(res, 200, await chooser.exports.copyNas(data.id, data.client, data.path, nasFiles, user.uid, data.name));
          }
          if (data.action === 'export-download') {
            const file = await chooser.exports.download(data.id, data.client, data.index);
            try {
              res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
              await pipeline(file.handle.createReadStream({ autoClose: false }), res, { signal: file.signal });
            } catch (error) { res.destroy(); }
            finally { await file.handle.close(); }
            return;
          }
          if (data.action === 'plan') return send(res, 200, await chooser.plan(data.id, data.client, data.files));
          if (data.action === 'nas') {
            if (host !== 'fnos') throw new AppError('此设备暂不支持 NAS 文件授权选择，请选择本地文件', 409);
            return send(res, 200, await chooser.prepareNas(data.id, data.client, data.paths, nasFiles, user.uid));
          }
          if (data.action === 'complete') return send(res, 200, await chooser.complete(data.id, data.client));
          if (data.action === 'cancel') return send(res, 200, await chooser.cancel(data.id, data.client));
          throw new AppError('文件操作无效');
        }
        if (action === 'start') return send(res, 200, await space.start(id));
        if (action === 'stop') return send(res, 200, await space.stop(id));
        if (action === 'login') return send(res, 200, await item.exclusive(() => item.runtime.showLogin()));
        if (action === 'recheck') { await item.runtime.loginState?.refresh(true); return send(res, 200, item.runtime.publicState()); }
        if (action === 'show') return send(res, 200, await item.exclusive(async () => {
          if (item.runtime.status !== 'running') throw new AppError('请先连接微信', 409);
          await item.runtime.foregroundRequested?.(); await item.runtime.showWindow?.();
          return item.runtime.publicState();
        }));
        if (action === 'rename') return send(res, 200, await space.rename(id, data.name));
        if (action === 'settings') return send(res, 200, await space.schedule(id, data));
        if (action === 'clipboard') {
          if (data.files) validateClipboardFiles(data.files); else validateClipboard(data.text);
          await item.runtime.manualInput?.({ source: 'clipboard-api', type: 'clipboard', held: false });
          return send(res, 200, await item.exclusive(() => item.runtime.setClipboard(data.files ? { files: data.files } : data.text)));
        }
        if (action === 'desktop') {
          return await item.exclusive(async () => {
            if (item.runtime.status !== 'running') throw new AppError('请先打开微信', 409);
            await item.runtime.foregroundRequested?.();
            await item.runtime.showWindow?.(); await item.runtime.setInputMethod?.(false);
            const key = randomBytes(24).toString('hex'); tickets.set(key, { uid: user.uid, id, expires: Date.now() + 60000 });
            if (host === 'ugos') return send(res, 200, { password: item.runtime.password, transport: 'http', path: `${prefix}/desktop/stream?ticket=${key}`, input: `${prefix}/desktop/input?ticket=${key}` });
            return send(res, 200, { password: item.runtime.password, path: `${prefix}/desktop?ticket=${key}` });
          });
        }
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError('请求方式不支持', 405);
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/icon.png': ['icon.png', 'image/png'], '/backgrounds/mist.jpg': ['backgrounds/mist.jpg', 'image/jpeg'], '/auth-callback.html': ['auth-callback.html', 'text/html'], '/auth-callback.js': ['auth-callback.js', 'text/javascript'], '/privacy.html': ['privacy.html', 'text/html'], '/terms.html': ['terms.html', 'text/html'] };
      files['/ai-workspace.css'] = ['ai-workspace.css', 'text/css'];
      if (!files[route]) throw new AppError('页面不存在', 404);
      const [file, type] = files[route]; const bytes = await readFile(path.join(appRoot, 'public', file));
      res.writeHead(200, { 'Content-Type': type.startsWith('text/') ? `${type}; charset=utf-8` : type, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (!(error instanceof AppError)) console.error('Request failed:', error.message);
      send(res, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : '操作未完成，请稍后重试', code: error instanceof AppError ? error.code : undefined });
    }
  });
  server.requestTimeout = 20 * 60 * 1000; server.headersTimeout = 30000;
  const sockets = new Set(); server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 ** 2, perMessageDeflate: false });
  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== `${prefix}/desktop` || req.headers['sec-fetch-site'] === 'cross-site') throw new Error();
      const user = identity(req), key = url.searchParams.get('ticket'), ticket = tickets.get(key);
      if (!ticket || ticket.uid !== user.uid || ticket.expires < Date.now()) throw new Error();
      tickets.delete(key);
      const space = await users.get(user.uid); space.requireConsent();
      const item = space.get(ticket.id); if (item.runtime.status !== 'running' || !item.runtime.port) throw new Error();
      await item.runtime.foregroundRequested?.();
      wss.handleUpgrade(req, socket, head, ws => {
        const disconnected = item.runtime.desktopConnected?.();
        ws.once('close', () => disconnected?.());
        const upstream = net.connect(item.runtime.port, '127.0.0.1');
        const gate = new RfbInputGate({ beforeInput: event => item.runtime.manualInput?.(event),
          write: bytes => new Promise((resolve, reject) => upstream.write(bytes, error => error ? reject(error) : resolve())) });
        ws.on('message', (data, binary) => {
          if (!binary || upstream.writableLength > 2 * 1024 ** 2) { void gate.close().catch(() => {}); upstream.destroy(); return ws.close(1009); }
          void gate.feed(data).catch(() => { upstream.destroy(); ws.close(1002); });
        });
        desktopSocket(ws, upstream);
        upstream.on('error', () => ws.close()); upstream.on('close', () => ws.close());
        ws.on('error', () => { void gate.close().catch(() => {}); upstream.destroy(); });
        ws.on('close', () => { void gate.close().catch(() => {}); upstream.destroy(); });
      });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  return { server, users, library, prefix, devKey,
    async close() { clearInterval(ticketTimer); streams.close(); for (const ws of wss.clients) ws.terminate(); await library.close(); await users.close({ deadline: host === 'ugos' ? Date.now() + 6500 : Infinity }); for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); wss.close(); } };
}

// One main process per installation owns the desktop session (Xvfb, WeChat and
// its database handles). A second one used to unlink app.sock and then bring up
// its own WeChat on the same instance directory, so both kept tearing down each
// other's WeChat and every chat read failed for minutes afterwards with "暂时
// 无法读取微信数据". Ask the socket first: whoever answers is the owner, and a
// duplicate exits instead of stealing the session. A dead or silent owner does
// not answer, so an ordinary restart - which kills the old process first - still
// takes over exactly as before.
const SINGLE_INSTANCE_PROBE_MS = 5000;
async function socketHasOwner(socketPath) {
  try { const file = await lstat(socketPath); if (!file.isSocket()) return false; }
  catch { return false; }
  return new Promise(resolve => {
    const request = http.request({ socketPath, path: '/', method: 'GET', timeout: SINGLE_INSTANCE_PROBE_MS }, response => {
      response.resume();
      resolve(true);
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
    request.end();
  });
}

if (process.env.UGAPP_INSTALL_DIR && process.argv.includes('--ugos-entry') || process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dev = process.argv.includes('--dev');
  const platform = platformConfig(), appRoot = dev ? moduleRoot : platform.appRoot || moduleRoot;
  if (!dev && !platform.dataRoot) throw new Error('Application data directory is required');
  if (!dev && platform.host !== 'ugos' && await socketHasOwner(path.join(appRoot, 'app.sock'))) {
    console.log('栖盒已在运行（app.sock 有实例应答）；本次启动直接退出，避免两个主进程争抢同一套微信会话');
    process.exit(0);
  }
  const devDataRoot = process.env.QIBOX_DEV_DATA_DIR ? path.resolve(process.env.QIBOX_DEV_DATA_DIR) : path.join(tmpdir(), `qibox-dev-${process.pid}`);
  const app = await createApplication({ appRoot, dataRoot: dev ? devDataRoot : platform.dataRoot, dev, host: platform.host });
  if (dev) {
    const port = Number(process.env.QIBOX_PORT || 8790);
    await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
    console.log(`栖盒预览：http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  } else if (platform.host === 'ugos') {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(platform.port, '127.0.0.1', resolve); });
  } else {
    const socket = path.join(appRoot, 'app.sock');
    try { const file = await lstat(socket); if (!file.isSocket()) throw new Error('Refusing to replace a non-socket file'); await rm(socket); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await new Promise(resolve => app.server.listen(socket, resolve)); await chmod(socket, 0o666);
  }
  let closing = false;
  const close = async () => { if (closing) return; closing = true; try { await app.close(); process.exit(0); } catch (error) { console.error(error); process.exit(1); } };
  // UGOS signals the entire service group; the native entry also forwards the
  // signal. Keep handlers installed so a duplicate cannot interrupt cleanup.
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
