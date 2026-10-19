import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
const groupId = key('layout-test-group');
bridge.contacts[0].label = '测试对象甲：这是一个特意加长的中文联系人名称，用于检查窄屏下是否正确换行和保留语义';
bridge.contacts.push({ id: groupId, label: '测试群聊布局：这是一个较长的群聊名称，用来检查手机宽度下的中文换行效果', kind: 'group' });
bridge.messages.set(groupId, [{ id: 'initial-layout-test-group', direction: 'self', text: 'GROUP_FIXTURE_MARKER' }]);
bridge.stableMessageIds = true;
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, trustedHashes: [packageSha256], aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
const output = path.resolve(root, process.argv[2] || 'reports/ai-wait-switch-20260924/ui');
await mkdir(output, { recursive: true });
let browser;
let zoomContext, zoomTemp;
const uiScaleEvidence = { viewportEquivalent380: true, cssZoomSimulation: null, browserZoom200: { status: 'pending', note: '尚未由浏览器页面缩放证实' } };
try {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const space = await app.users.get('development'); await space.setConsent(true); app.library.download(); await app.library.working;
  const meta = await space.add('等待设置界面验收'); await space.start(meta.id); const ai = space.get(meta.id).ai; clearInterval(ai.timer);
  await ai.scan();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await page.locator('[data-action=open]').first().click({ timeout: 5000 });

  await page.locator('#ai-open').click();
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  assert.equal(await page.locator('[name=appearance]').count(),0);
  const alignment=await page.locator('.qbx-settings-page > .ai-card').evaluateAll(ns=>ns.map(n=>{const r=n.getBoundingClientRect();return{x:r.x,width:r.width};}));
  assert.equal(alignment.length,2);assert.ok(Math.abs(alignment[0].x-alignment[1].x)<=1,'settings cards must share the same left edge');assert.ok(Math.abs(alignment[0].width-alignment[1].width)<=1,'settings cards must share width');
  const rhythm=page.locator('[data-ai-optional=global-rhythm]');
  assert.equal(await rhythm.getAttribute('open'),null);
  await rhythm.locator('summary').click();
  assert.equal(await rhythm.locator('fieldset').count(),4);
  assert.equal(await rhythm.locator('[name=followUpEnabled]').isChecked(),false);
  assert.equal(await rhythm.locator('[data-followup-waits]').isVisible(),false);
  await rhythm.locator('[name=followUpEnabled]').check();
  assert.equal(await rhythm.locator('[data-followup-waits]').isVisible(),true);
  await rhythm.locator('[name=followUpDelayMin]').fill('9');
  await rhythm.locator('[name=followUpEnabled]').uncheck();
  await rhythm.locator('[name=followUpEnabled]').check();
  assert.equal(await rhythm.locator('[name=followUpDelayMin]').inputValue(),'9');
  await rhythm.locator('[name=followUpEnabled]').uncheck();
  for(const width of [1440,1280,1024,768,375,320])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height:1000});await page.locator('html').evaluate((n,t)=>{n.dataset.qiTheme=t;},theme);await page.waitForTimeout(200);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),`overflow ${width} ${theme}`);
    await page.screenshot({path:path.join(output,`global-${width}-${theme}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('[data-ai-nav="overview"]').first().click();
  await page.locator('[data-ai-object]').first().click();

  await page.locator('#ai-object-form [name=enabled]').check();
  const object=page.locator('#ai-object-form'), fold=object.locator('.ai-reply-rhythm');
  assert.equal(await fold.getAttribute('open'),null);await fold.locator('summary').click();
  assert.equal(await object.locator('[name=inheritRhythm]').count(),1);
  assert.equal(await object.locator('[name=inheritTiming],[name=inheritTakeover],[name=multiTurn]').count(),0);
  await object.locator('[name=inheritRhythm]').uncheck();await object.locator('[name=replyDelay]').fill('13');
  await object.locator('[name=inheritRhythm]').check();assert.equal(await object.locator('[name=replyDelay]').inputValue(),'20');
  await object.locator('[name=inheritRhythm]').uncheck();assert.equal(await object.locator('[name=replyDelay]').inputValue(),'13');
  await object.locator('[name=followUpEnabled]').check();await object.locator('[name=followUpDelayMin]').fill('7');
  await object.locator('[name=followUpEnabled]').uncheck();assert.equal(await object.locator('[name=followUpDelayMin]').inputValue(),'7');
  for(const width of [1440,390,320])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height:1000});await page.locator('html').evaluate((n,t)=>{n.dataset.qiTheme=t;},theme);await page.waitForTimeout(200);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),`object overflow ${width} ${theme}`);
    await fold.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`object-${width}-${theme}.png`)});
  }
  assert.equal(errors.length,0,errors.join(';'));

  zoomTemp=await mkdtemp(path.join(os.tmpdir(),'qibox-test-zoom-'));
  const extension=path.join(zoomTemp,'extension');await mkdir(extension);
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Qibox actual browser zoom evidence',version:'1.0',permissions:['tabs'],background:{service_worker:'worker.js'},content_scripts:[{matches:['http://127.0.0.1/*'],js:['probe.js'],run_at:'document_idle'}]}));
  await writeFile(path.join(extension,'worker.js'),`chrome.runtime.onMessage.addListener((m,s,r)=>{if(m.kind!=='zoom')return;(async()=>{await chrome.tabs.setZoom(s.tab.id,2);r({zoom:await chrome.tabs.getZoom(s.tab.id)})})();return true;});`);
  await writeFile(path.join(extension,'probe.js'),`window.addEventListener('qibox-zoom',()=>chrome.runtime.sendMessage({kind:'zoom'},v=>document.documentElement.dataset.zoomCheck=JSON.stringify(v)));`);
  zoomContext=await chromium.launchPersistentContext(path.join(zoomTemp,'profile'),{channel:'msedge',headless:false,viewport:{width:1440,height:1000},ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const zoomPage=zoomContext.pages()[0];
  await zoomPage.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await zoomPage.locator('[data-action=open]').first().click();await zoomPage.locator('#ai-open').click();await zoomPage.getByRole('button',{name:'系统设置',exact:true}).click();
  await zoomPage.evaluate(()=>window.dispatchEvent(new Event('qibox-zoom')));await zoomPage.waitForFunction(()=>document.documentElement.dataset.zoomCheck);
  assert.equal(await zoomPage.evaluate(()=>JSON.parse(document.documentElement.dataset.zoomCheck).zoom),2);
  const cdp=await zoomContext.newCDPSession(zoomPage);
  for(const theme of ['light','dark']){
    await zoomPage.locator('html').evaluate((n,t)=>n.dataset.qiTheme=t,theme);
    const fold=zoomPage.locator('[data-ai-optional=global-rhythm]');
    await fold.evaluate(n=>n.open=false);await zoomPage.locator('#ai-takeover-form').evaluate(n=>n.scrollIntoView());await zoomPage.waitForTimeout(300);
    await zoomPage.screenshot({path:path.join(output,`browser-200-${theme}-collapsed.png`)});
    await fold.locator('summary').click();
    for(let i=0;i<4;i++){await fold.locator('fieldset').nth(i).scrollIntoViewIfNeeded();await zoomPage.waitForTimeout(200);const shot=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});await writeFile(path.join(output,`browser-200-${theme}-stage-${i+1}.png`),Buffer.from(shot.data,'base64'));}
  }
  await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,browserZoom:2,errors,scope:'isolated real application fixture; no device claim'},null,2));
} finally { await zoomContext?.close(); if(zoomTemp) await cleanup(zoomTemp); await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot); }

