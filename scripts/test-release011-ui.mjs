import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();
const peer=await rfbFixture(path.join(root,'web/backgrounds/mist.jpg'));
const app=await createApplication({appRoot:root,dataRoot,dev:true,extract:extractor,fetcher,trustedHashes:[packageSha256],aiProvider:provider,runtimeFactory:(...args)=>({...runtimeFactory(...args),port:peer.port,aiBridge:bridge,loginStatus:'logged-in'})});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const space=await app.users.get('development');await space.setConsent(true);app.library.download();await app.library.working;
const meta=await space.add('本地隔离验收');await space.start(meta.id);const ai=space.get(meta.id).ai;clearInterval(ai.timer);await ai.configure(modelConfig);await ai.scan();
await ai.configuration({type:'personal-information',entries:[{field:'name',text:'仅测试私密姓名',allowGroup:false},{field:'addressing',text:'仅测试公开昵称',allowGroup:true},{field:'occupation',text:'测试职业内容',allowGroup:false}]});
const output=path.join(root,'local/acceptance-011/browser');await mkdir(output,{recursive:true});const report={scope:'Local isolated application browser acceptance, not NAS acceptance',errors:[],checks:[]};let browser, page;
try {
 browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>report.errors.push(e.message));page.setDefaultTimeout(15000);
 await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);await page.locator('[data-action=open]').first().click();await page.locator('#ai-open').click();
 await page.locator('[data-ai-nav=settings]').first().click();await page.locator('[data-ai-nav="personal-info"]').click();
 assert.equal(await page.locator('[data-personal-field]').count(),12);assert.equal(await page.locator('.ai-personal-more [data-personal-field]').count(),5);
 assert.ok(await page.evaluate(()=>document.documentElement.clientWidth===innerWidth),'full-screen AI owns scrolling without a second browser scrollbar');
 assert.equal(await page.getByText('聊天中的待确认信息',{exact:true}).count(),0);assert.equal(await page.getByText('我的信息历史版本',{exact:true}).count(),0);
 const city=page.locator('[data-personal-field=city]');await city.locator('summary').click();await city.locator('[data-personal-input]').fill('仅测试城市与生活区域');await page.getByRole('button',{name:'保存我的信息',exact:true}).click();
 await page.getByRole('button',{name:'返回系统设置',exact:true}).click();await page.locator('[data-ai-nav="personal-info"]').click();assert.equal(await page.locator('[name=city]').inputValue(),'仅测试城市与生活区域');
 const rows=ai.publicState().personalInformation.entries.filter(row=>row.field==='addressing');assert.equal(rows.length,2);assert.equal(rows.filter(row=>row.allowGroup).length,1);
 await page.locator('[data-personal-field=occupation] summary').click();
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'返回系统设置',exact:true}).click();
 await page.locator('[name=autoLearning]').check();await page.locator('[name=replyDelay]').fill('9');await page.locator('[name=replyMaxWait]').fill('25');await page.locator('#ai-takeover-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#ai-panel')?.getAttribute('aria-busy')==='false');
 await page.locator('[data-ai-nav="personal-info"]').click();await page.getByRole('button',{name:'返回系统设置',exact:true}).click();assert.equal(await page.locator('[name=autoLearning]').isChecked(),true);assert.equal(await page.locator('[name=replyDelay]').inputValue(),'9');
 await page.locator('[name=autoLearning]').uncheck();await page.locator('#ai-takeover-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#ai-panel')?.getAttribute('aria-busy')==='false');assert.equal(ai.data.settings.autoLearning,false);

 await page.locator('[data-ai-nav="personal-info"]').click();
 for(const width of [1440,1280,1024,768,375,320]) {
  await page.setViewportSize({width,height:1000});await page.locator('#ai-personal-information-form').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow ${width}`);
  await page.screenshot({path:path.join(output,`personal-${width}.png`),fullPage:true});
 }
 await page.getByRole('button',{name:'返回系统设置',exact:true}).click();await page.locator('[name=appearance]').selectOption('dark');await page.locator('#ai-takeover-form button[type=submit]').click();await page.waitForFunction(()=>document.documentElement.dataset.qiTheme==='dark'&&document.querySelector('#ai-panel')?.getAttribute('aria-busy')==='false');
 await page.locator('[data-ai-nav="personal-info"]').click();assert.equal(await page.locator('.ai-personal-title').evaluate(el=>getComputedStyle(el).fontSize),'32px');assert.equal(await page.locator('#ai-personal-information-form').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(32, 29, 39)');await page.screenshot({path:path.join(output,'personal-dark-320.png'),fullPage:true});
 const phone=await browser.newPage({viewport:{width:375,height:844}}),phoneRequests=[];phone.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/desktop'))phoneRequests.push(request.url());});
 await phone.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);await phone.locator('[data-mobile-ai-open]').click();await phone.locator('[data-ai-nav=settings]').click();await phone.locator('[data-ai-nav="personal-info"]').click();await phone.locator('#ai-personal-information-form').waitFor({state:'visible'});assert.equal(await phone.locator('[data-personal-field]').count(),12);assert.equal(phoneRequests.length,0,'Mobile AI settings must not open or grab the native desktop');
 await phone.locator('[data-personal-field=city] summary strong').click();await phone.locator('[name=city]').fill('手机端编辑后的测试城市');await phone.getByRole('button',{name:'保存我的信息',exact:true}).click();await phone.waitForFunction(()=>document.querySelector('#ai-panel')?.getAttribute('aria-busy')==='false');assert.equal(ai.publicState().personalInformation.entries.find(row=>row.field==='city').text,'手机端编辑后的测试城市');await phone.screenshot({path:path.join(output,'mobile-entry-edit.png'),fullPage:true});await phone.close();
 report.checks.push('12 fields / 7 common + 5 collapsed; obsolete entries removed','edit/save/reopen uses encrypted personal data directly; mixed legacy sharing retained','1440/1280/1024/768/375/320 no page overflow','automatic learning and timing save/reopen/disable');assert.deepEqual(report.errors,[]);report.passed=true;console.log('RELEASE011_UI_OK');
} catch(error){report.failure=error.stack;report.body=await page?.locator('#ai-content').innerText();await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true});throw error;}finally{await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser?.close();await app.close();await peer.close();await cleanup(dataRoot);}
