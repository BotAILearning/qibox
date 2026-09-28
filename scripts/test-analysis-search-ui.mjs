// Active browser regression for the shared analysis contact picker and queue.
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createApplication} from '../server/index.mjs';
import {root,playwrightPath} from './tooling.mjs';
import {temp,cleanup,runtimeFactory,extractor,fetcher,packageSha256} from '../test/fixtures.mjs';
import {ChatFixture,AIModelFixture,modelConfig,key} from '../test/ai-fixtures.mjs';
import {rfbFixture} from '../test/rfb-fixture.mjs';

const {chromium}=createRequire(import.meta.url)(playwrightPath);
const dataRoot=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();
const output=path.join(root,process.argv[2]||'reports/analysis-search/browser');
await mkdir(output,{recursive:true});
const completed=[],report={scope:'Disposable local fixtures; no live model, NAS or WeChat messages.',checks:[],errors:[]};
bridge.contacts[0].label='陈小雨';bridge.contacts[0].nickname='小雨同学';
bridge.contacts[1].label='林一';bridge.contacts[2].label='周末';
bridge.contacts.push({id:key('group'),label:'产品设计讨论',kind:'group'});
bridge.readDates=async({account,contact})=>({account,contact,dates:['2026-09-01','2026-09-14','2026-09-28']});
bridge.readRange=async args=>({account:args.account,contact:args.contact,rangeRevision:key(args.contact),messages:[{id:key(args.contact),timestamp:args.from+1,text:args.contact,direction:'self'}]});
provider.complete=async(config,_system,input)=>{completed.push({config,input});return{report:`独立报告：${input.contact}\n\n事项与约定\n双方约定继续确认周末安排。`,excerptIds:[]};};
const peer=await rfbFixture(path.join(root,'web/backgrounds/mist.jpg'));
const app=await createApplication({appRoot:root,dataRoot,dev:true,extract:extractor,fetcher,aiProvider:provider,trustedHashes:[packageSha256],runtimeFactory:(...args)=>({...runtimeFactory(...args),port:peer.port,aiBridge:bridge,loginStatus:'logged-in'})});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const space=await app.users.get('development');await space.setConsent(true);app.library.download();await app.library.working;
const meta=await space.add('界面验收微信');await space.start(meta.id);const ai=space.get(meta.id).ai;
clearInterval(ai.timer);await ai.verifyProvider(modelConfig);await ai.scan();await ai.settings({enabled:false});

let browser;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  const settled=()=>page.waitForFunction(()=>document.querySelector('#ai-panel').getAttribute('aria-busy')!=='true');
  await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await page.locator('[data-action=open]').first().click();
  await page.locator('#ai-open').click();
  await page.locator('.ai-main-tabs [data-ai-nav=analysis]').click();await settled();
  await page.locator('[data-ai-analysis-pick]').click();
  const dialog=page.locator('.ai-contact-picker-dialog');
  assert.equal(await dialog.locator('[data-picker-kind]').count(),0,'analysis only shows people');
  await dialog.locator('#ai-modal-contact-search').fill('小雨同学');
  assert.equal(await dialog.locator('[data-picker-id]').count(),1,'WeChat nickname is searchable');
  assert.equal(await dialog.locator('.ai-contact-nick').innerText(),'（小雨同学）');
  await dialog.locator('[data-picker-id]').check();
  await dialog.locator('#ai-modal-contact-search').fill('不存在的人');
  assert.equal(await dialog.locator('[data-picker-id]').count(),0);
  await dialog.locator('#ai-modal-contact-search').fill('周');
  await dialog.locator('[data-picker-id]').check();
  assert.match(await dialog.locator('[data-picker-count]').innerText(),/2/);
  await dialog.locator('[data-picker-confirm]').click();
  assert.equal(await page.locator('#ai-analysis-contacts [name=contacts]').count(),2);
  assert.equal(await page.locator('.ai-analysis-picked-row').count(),2);
  assert.equal(await page.locator('#ai-analysis-count').innerText(),'2');
  report.checks.push('弹窗搜索备注与微信名，过滤后保留多选，确认后左侧完整展示');

  await page.locator('[data-ai-analysis-range=week]').click();
  assert.match(await page.locator('#ai-analysis-form [name=from]').inputValue(),/^\d{4}-\d{2}-\d{2}$/);
  await page.locator('[data-ai-analysis-range=custom]').click();
  await page.locator('.ai-calendar-dialog-analysis').waitFor();
  await page.locator('.ai-calendar-dialog-analysis [data-cancel]').click();
  await page.waitForFunction(()=>document.querySelector('[data-ai-analysis-range=week]')?.getAttribute('aria-pressed')==='true');
  assert.equal(await page.locator('[data-ai-analysis-range=week]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-ai-analysis-range=all]').click();
  assert.equal(await page.locator('#ai-analysis-form [name=from]').inputValue(),'');
  assert.equal(await page.locator('#ai-analysis-contacts [name=contacts]').count(),2);
  report.checks.push('时间范围切换与取消自定义不会丢掉已选联系人');

  await page.locator('#ai-analysis-request-text').fill('分别总结约定');
  await page.locator('#ai-analysis-form button[type=submit]').click();await settled();
  assert.equal(completed.length,2,'each selected person is analyzed separately');
  assert.deepEqual(new Set(completed.map(call=>call.input.contact)),new Set(['陈小雨','周末']));
  assert.equal(await page.locator('[data-analysis-report]').count(),2);
  assert.equal(await page.locator('#ai-analysis-contacts [name=contacts]').count(),0,'completed reports clear the old selection');
  report.checks.push('逐人队列生成两份报告，完成后清除旧选择');

  await page.setViewportSize({width:390,height:844});
  await page.locator('.ai-main-tabs [data-ai-nav=analysis]').click();await settled();
  await page.locator('[data-ai-analysis-contacts-toggle]').click();
  const mobileDialog=page.locator('.ai-contact-picker-dialog');
  await mobileDialog.locator('[data-picker-id]').first().check();
  const bounds=await mobileDialog.evaluate(node=>{const d=node.getBoundingClientRect(),f=node.querySelector('footer').getBoundingClientRect();return{width:d.width,bottom:d.bottom,footerBottom:f.bottom};});
  assert.ok(bounds.width<=390&&bounds.bottom<=844&&bounds.footerBottom<=844);
  await mobileDialog.locator('[data-picker-confirm]').click();
  assert.equal(await page.locator('#ai-analysis-contacts [name=contacts]').count(),1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,'mobile-contact-selection.png')});
  report.checks.push('390px 手机弹窗和左侧选择区域无横向溢出，底部按钮可见');
  assert.equal(bridge.sent.length,0);assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure=error.stack;throw error;}
finally{await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser?.close();await app.close();await peer.close();await cleanup(dataRoot);}
