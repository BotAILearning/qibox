import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { root, playwrightPath } from './tooling.mjs';
import { createApplication } from '../server/index.mjs';
import { runtimeFactory, extractor, fetcher, temp, cleanup } from '../test/fixtures.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const webRoot = process.env.QIBOX_TEST_WEB_ROOT || path.join(root, 'public-ugos');
const transientSession = process.argv.includes('--transient-session');
const transientToken = process.argv.includes('--transient-token');
const unauthorizedSession = process.argv.includes('--unauthorized-session');
const crossOrigin = process.argv.includes('--cross-origin');
const opaqueAccount = process.argv.includes('--opaque-account');
const missingRole = process.argv.includes('--missing-role');
const arch = process.argv.includes('--arch=x64') ? 'x64' : 'arm64';
const architectureLabel = arch === 'arm64' ? 'ARM64' : 'x86_64';
const gatewayAccount = opaqueAccount ? 'b9726d36-9f52-4d2b-a212-bcb4a2d546ac' : '1000';
let sessionFailures = transientSession ? 1 : 0;
let rejectedSessions = unauthorizedSession ? 1 : 0;
const dataRoot = await temp(), requests = [], errors = [];
const app = await createApplication({ appRoot: root, dataRoot, host: 'ugos', arch, runtimeFactory, extract: extractor,
  fetcher: (url, options) => { requests.push(url); return fetcher(url, options); } });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const shell = `<!doctype html><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style>
<script>
window.sdkMessages=[]; window.tokenRequests=0;
addEventListener('message', event => {
  const msg=event.data;
  if (msg?.type!=='cloudWindow') return;
  sdkMessages.push({channel:msg.channel,event:msg.event,action:msg.message?.type,from:msg.from});
  const reply={...msg,type:'cloudWindowMgr',from:'host',to:msg.from};
  if(msg.channel==='windowAction') {
    const action=msg.message;
    reply.message={type:'actionResult',actionId:action.actionId,data:{result:action.type==='ready'?{ucVer:1741,locale:'zh-CN'}:action.type==='isFocus'?true:action.type==='getGroup'?'qibox-test':{}}};
  } else if(msg.channel==='capacity') {
    if(msg.event.startsWith('getThirdToken_') && ++window.tokenRequests === 1 && ${transientToken}) return;
    reply.message={result:msg.event.startsWith('getThirdToken_')?{third_token:'qibox-ui-test-token'}:{},capId:msg.event.split('_')[1]};
  } else return;
  event.source.postMessage(reply,event.origin);
});
</script><iframe name="qibox-test" src="/app/ui/com.bot.qibox/"></iframe>`;
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(crossOrigin ? shell.replace('src="/app/', 'src="http://localhost:' + gateway.address().port + '/app/') : shell); return; }
  if (url.pathname.startsWith('/app/ui/com.bot.qibox/')) {
    const name = url.pathname.slice('/app/ui/com.bot.qibox/'.length) || 'index.html';
    if (name.includes('..')) { res.writeHead(400); res.end(); return; }
    try {
      const file = await readFile(path.join(webRoot, name));
      res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' })[path.extname(name)] || 'application/octet-stream');
      res.end(file);
    } catch { res.writeHead(404); res.end(); }
    return;
  }
  if (req.headers['ugreen-ttk'] !== 'qibox-ui-test-token') { res.writeHead(401); res.end(); return; }
  requests.push(req.url.split('?')[0]);
  if (url.pathname.endsWith('/api/session') && sessionFailures-- > 0) { res.writeHead(503); res.end('Service starting'); return; }
  if (url.pathname.endsWith('/api/session') && rejectedSessions-- > 0) { res.writeHead(401); res.end('Token expired'); return; }
  const upstream = http.request({ host: '127.0.0.1', port: app.server.address().port, path: req.url, method: req.method,
    headers: { ...req.headers, 'ugreen-user-id': gatewayAccount, ...missingRole ? {} : { 'ugreen-user-type': 'admin' } } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
  upstream.on('error', () => res.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
});
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
const report = { note: 'Production UGOS bundle and real SDK inside a named iframe, with simulated UGOS host messages, authenticated gateway and ARM64 package/runtime. No real NAS execution.', checks: [] };
report.scenario = { transientSession, transientToken, unauthorizedSession, crossOrigin, opaqueAccount, missingRole, arch };
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${gateway.address().port}/`);
  const ui = page.frameLocator('iframe');
  await ui.getByRole('heading', { name: '欢迎使用栖盒' }).waitFor({ timeout: 35000 });
  if (transientSession) { assert.ok(requests.filter(url => url.endsWith('/api/session')).length >= 2); report.checks.push('Initial 503 recovers automatically without reloading'); }
  if (transientToken || unauthorizedSession) { assert.ok(await page.evaluate(() => window.tokenRequests >= 2)); report.checks.push('Missing/expired SDK token is reacquired automatically'); }
  await ui.locator('input[name=consent]').check(); await ui.getByRole('button', { name: '开始使用' }).click();
  await ui.locator('#modal').waitFor({ state: 'hidden' });
  assert.equal(await ui.getByRole('button', { name: '下载安装微信', exact: true }).isVisible(), true);
  assert.equal(await ui.getByRole('button', { name: '导入安装包', exact: true }).isVisible(), true);
  assert.ok((await ui.locator('#install-format').textContent()).includes(architectureLabel));
  await mkdir(path.join(root, 'reports/screenshots'), { recursive: true });
  await page.screenshot({ path: path.join(root, `reports/screenshots/ugos-${arch}-store.png`) });
  report.checks.push(`Real SDK initializes and authenticates the ${architectureLabel} store; download and import entries visible`);
  await ui.locator('#download').click(); await ui.locator('#add-instance').waitFor();
  assert.ok(requests.some(url => url.endsWith(`WeChatLinux_${arch === 'arm64' ? 'arm64' : 'x86_64'}.deb`)));
  assert.match(await ui.locator('#package-status').textContent(), /已安装/);
  await ui.locator('#add-instance').click();
  await ui.locator('input[name=name]').fill('测试微信');
  await ui.getByRole('button', { name: '确定', exact: true }).click();
  await ui.getByRole('button', { name: '打开测试微信', exact: true }).waitFor();
  await page.reload();
  await ui.getByRole('button', { name: '打开测试微信', exact: true }).waitFor();
  assert.equal(await ui.locator('#add-instance').isVisible(), true);
  await page.screenshot({ path: path.join(root, `reports/screenshots/ugos-${arch}-installed.png`) });
  report.checks.push(`${architectureLabel} official download, installed state, add-to-desktop and existing app after reload`);
  const space = [...app.users.spaces.values()][0], item = [...space.instances.values()][0];
  const homeBefore = item.home;
  await writeFile(path.join(homeBefore, 'uninstall-parity-marker'), 'retained');
  if (missingRole) {
    assert.equal(await ui.getByRole('button', { name: '卸载微信', exact: true }).isVisible(), false);
    report.checks.push('A session without an administrator role does not expose global uninstall');
  } else {
  await ui.getByRole('button', { name: '卸载微信', exact: true }).waitFor({ timeout: 3000 });
  await ui.getByRole('button', { name: '卸载微信', exact: true }).click();
  assert.equal(await ui.locator('input[name=deleteData][value=no]').isChecked(), true);
  await page.screenshot({ path: path.join(root, `reports/screenshots/ugos-${arch}-uninstall.png`) });
  await ui.getByRole('button', { name: '卸载', exact: true }).click();
  await ui.locator('#modal').waitFor({ state: 'hidden' }); await ui.locator('#download').waitFor();
  assert.equal(await readFile(path.join(homeBefore, 'uninstall-parity-marker'), 'utf8'), 'retained');
  await ui.locator('#download').click(); await ui.locator('#add-instance').waitFor();
  assert.equal(space.get(item.meta.id).home, homeBefore);
  report.checks.push('Uninstall entry, default preserve-data confirmation, real uninstall/reinstall requests and original profile retention');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await ui.locator('#launch-installed').isVisible(), true);
  await ui.locator('#launch-installed').click(); await ui.getByRole('heading', { name: '请用电脑端操作' }).waitFor();
  report.checks.push('Mobile installed entry remains visible');
  assert.deepEqual(errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack;
  report.diagnostics = { errors, requests, sdkMessages: await page?.evaluate(() => window.sdkMessages), body: await page?.frames()[1]?.locator('body').innerText() };
  process.exitCode = 1;
} finally {
  await browser?.close(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); await app.close(); await cleanup(dataRoot);
  const suffix = process.argv.slice(2).map(arg => arg.replace(/^--/, '')).join('-');
  await writeFile(path.join(root, `reports/ugos-ui-tests${suffix ? '-' + suffix : ''}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
