import {calendarFixture,selectSeptemberRange} from './ai-calendar-fixture.mjs';
import { proactiveDraftCheck } from './proactive-browser-checks.mjs';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
const output = path.join(root, process.argv[2] || 'reports/development-2026-09-16-batch3/browser'); await mkdir(output, { recursive: true });
const completed = [], report = { scope: 'Disposable local fixtures; no live model, NAS or WeChat messages.', checks: [], errors: [] };
bridge.contacts[0].label = '陈小雨'; bridge.contacts[1].label = '林一'; bridge.contacts[2].label = '周末';
bridge.contacts.push({ id: key('group'), label: '产品设计讨论', kind: 'group' });
calendarFixture(bridge);
bridge.readRange = async args => ({ account: args.account, contact: args.contact, rangeRevision: key(args.contact), messages: [{ id: key(args.contact), timestamp: args.from + 1, text: args.contact, direction: 'self' }] });
bridge.readDates = async args => ({account:args.account,contact:args.contact,dates:['2025-01-03','2026-09-01','2026-09-03']});
const learningComplete=provider.complete.bind(provider);
provider.complete = async (config, _system, input) => { if(input.material || input.conversations) return learningComplete(config,_system,input); completed.push({ config, input }); return { report: `独立报告：${input.contact}\n\n事项与约定\n双方约定继续确认周末安排。` }; };
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const space = await app.users.get('development'); await space.setConsent(true); app.library.download(); await app.library.working;
const meta = await space.add('界面验收微信'); await space.start(meta.id); const ai = space.get(meta.id).ai;
clearInterval(ai.timer); await ai.verifyProvider(modelConfig); await ai.scan(); await ai.settings({ enabled: false });

let browser;
try {
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:960}}), page=await context.newPage();
  page.setDefaultTimeout(12000);page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto('http://127.0.0.1:'+app.server.address().port+app.prefix+'/?dev='+app.devKey);
  await page.locator('[data-action=open]').first().click();
  const settled=()=>page.waitForFunction(()=>document.querySelector('#ai-panel').getAttribute('aria-busy')!=='true');
  const shot=async name=>{await page.locator('#toast').waitFor({state:'hidden'});await page.screenshot({path:path.join(output,name+'.png')});};
  await page.locator('#ai-rail [data-ai-setting=enabled]').check();await settled();assert.equal(ai.data.settings.enabled,true);
  await page.locator('#ai-open').click();assert.equal(await page.locator('[data-ai-panel-master]').count(),0);
  assert.equal(await page.locator('#desktop-takeover,#ai-manual-recovery').count(),0);
  await page.locator('[data-ai-object]').first().click();
  const tops=await page.locator('.ai-option-card').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().y));assert.ok(tops.every(y=>Math.abs(y-tops[0])<1));
  await page.locator('[data-ai-fold=strategy] summary').click();assert.equal(await page.locator('[name=maxRounds]').inputValue(),'50');
  await page.locator('[name=maxRounds]').fill('1000');await page.locator('[name=takeoverMode]').selectOption('off');await page.locator('[name=takeoverMinutes]').fill('9');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();await settled();
  const personal=ai.profiles().find(p=>p.contact===bridge.contacts[0].id);assert.equal(personal.replyStrategy.maxRounds,1000);assert.deepEqual(personal.takeover,{enabled:false,minutes:9});await shot('personal');
  await page.locator('[data-ai-nav=settings]').click();await page.locator('[data-ai-setting=acknowledgeAI]').check();await settled();
  await page.locator('#ai-takeover-form [name=minutes]').fill('2');await page.locator('#ai-takeover-form button').click();await settled();assert.equal(ai.data.settings.takeover.minutes,2);assert.equal(ai.data.settings.acknowledgeAI,true);await shot('settings');
  await page.locator('.ai-main-tabs [data-ai-nav=analysis]').click();
  await page.locator('[name=request]').fill('分别总结约定');await page.locator('#ai-analysis-form [name=contacts]').first().check();
  assert.equal(await page.locator('[name=from]').inputValue(),'');await page.getByRole('button',{name:'开始分析',exact:true}).click();await settled();
  assert.equal(completed[0].input.from,'');assert.equal(await page.locator('[data-analysis-report]').count(),1);
  await page.locator('[data-ai-date-range]').click();await page.locator('[data-mode=custom]').click();
  assert.equal(await page.locator('[data-day="2025-01-02"]').isEnabled(),false);
  await page.locator('[data-year]').selectOption('2026');await page.locator('[data-month]').selectOption('09');
  await page.locator('[data-day="2026-09-01"]').click();await page.locator('[data-day="2026-09-03"]').click();await shot('calendar');await page.locator('[data-apply]').click();
  assert.equal(await page.locator('[name=from]').inputValue(),'2026-09-01');assert.equal(await page.locator('[name=to]').inputValue(),'2026-09-03');
  await page.getByRole('button',{name:'开始分析',exact:true}).click();await settled();assert.equal(completed.at(-1).input.from,'2026-09-01');await shot('analysis');
  await page.locator('.ai-main-tabs [data-ai-nav=overview]').click();await page.locator('[data-ai-nav=learning]').click();
  await page.locator('[data-ai-contact]').nth(0).check();await page.locator('[data-ai-contact]').nth(1).check();await page.locator('#ai-learning-scope').selectOption('range');
  await page.locator('[data-ai-date-range]').click();await page.locator('[data-mode=custom]').click();await page.locator('[data-earliest]').click();await page.locator('[data-apply]').click();await shot('learning');
  await page.locator('[data-ai-action=learn-selected]').click();await settled();assert.equal(await page.locator('[data-ai-apply-result]').count(),2);assert.equal(await page.locator('#ai-reply-form').count(),0);
  const beforeOther=JSON.stringify(ai.profiles().find(p=>p.contact===bridge.contacts[1].id));
  await page.locator('[data-ai-apply-result]').first().click();await settled();assert.equal(JSON.stringify(ai.profiles().find(p=>p.contact===bridge.contacts[1].id)),beforeOther);assert.equal(ai.data.settings.enabled,true);await shot('results');
  for(const width of [768,390]) {
    await page.setViewportSize({width,height:844});await page.locator('.ai-main-tabs [data-ai-nav=overview]').click();
    if(await page.locator('.ai-object-sidebar').isVisible())await page.locator('[data-ai-object]').first().click();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const rows=await page.locator('.ai-option-card').evaluateAll(ns=>ns.map(n=>n.getBoundingClientRect().y));assert.ok(rows.every(y=>Math.abs(y-rows[0])<1));await shot('personal-'+width);
    await page.locator('.ai-main-tabs [data-ai-nav=analysis]').click();await page.locator('[data-ai-date-range]').click();await page.locator('[data-mode=custom]').click();
    assert.ok(await page.locator('.ai-calendar-dialog').evaluate(n=>n.scrollWidth<=n.clientWidth));await shot('calendar-'+width);await page.locator('[data-cancel]').click();
  }
  assert.equal(bridge.sent.length,0);assert.deepEqual(report.errors,[]);report.passed=true;
  report.checks=['Outer master persists; recovery controls removed','Three switches share one row at desktop/tablet/mobile','Global identity and takeover plus per-person override save','All-time analysis and valid-day custom calendar','Batch range learning and per-contact application','No horizontal overflow or JS errors; no real sends'];
}catch(error){report.failure=error.stack;throw error;}
finally{await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser?.close();await app.close();await peer.close();await cleanup(dataRoot);}
