import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {root,playwrightPath} from './tooling.mjs';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath), f=await proactiveFixture();
const out=path.join(root,'local/mobile-layout-20261020/navigation');await mkdir(out,{recursive:true});
const report={scope:'Production product bundle, disposable synthetic data; browser mobile emulation, no real NAS/phone/model/messages',checks:[],errors:[],passed:false};
let browser,page;
try{
 await (await f.app.users.get('development')).rename(f.instance.id,'主动聊天本地验收·长名称布局回归');
 browser=await chromium.launch({channel:'msedge',headless:true});
 page=await browser.newPage({viewport:{width:375,height:812},isMobile:true,hasTouch:true});page.setDefaultTimeout(6000);
 page.on('pageerror',e=>report.errors.push(e.message));
 const calls=f.provider.calls.length;
 await page.goto(f.url);await page.locator('[data-mobile-ai-open]').first().click();await page.locator('[data-ai-object]').first().waitFor();
 const title=page.locator('#ai-mobile-title'),back=page.locator('#ai-mobile-back');
 const snap=async name=>{
  await page.screenshot({path:path.join(out,name+'.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  const header=await page.locator('.qbx-mobile-toolbar').evaluate(n=>({h:n.clientHeight,overflow:n.scrollWidth-n.clientWidth}));
  assert.ok(header.overflow<=1);assert.ok(header.h>=64);
  assert.ok(await back.evaluate(n=>n.getBoundingClientRect().width>=44&&n.getBoundingClientRect().height>=44));
 };
 assert.match(await page.locator('#ai-mobile-context').innerText(),/主动聊天本地验收/);
 await snap('01-object-list');
 await page.locator('[data-ai-object]').first().click();assert.equal(await title.innerText(),'对象设置');
 assert.equal(await back.getAttribute('aria-label'),'返回对象列表');
 assert.equal(await page.locator('[data-ai-object-back]').isVisible(),false);
 await snap('02-object-detail');await back.click();assert.equal(await title.innerText(),'自动回复');
 const nav=async key=>page.locator(`.ai-main-tabs [data-ai-nav="${key}"]`).click();
 await nav('settings');await page.locator('[data-ai-nav="global-reply"]').click();
 assert.equal(await back.getAttribute('aria-label'),'返回系统设置');
 assert.equal(await page.locator('.ai-page-heading [data-ai-nav="settings"]').isVisible(),false);
 await page.locator('[name=replyGoal]').fill('移动端草稿：不应因返回丢失');await snap('03-global-strategy');
 await back.click();assert.equal(await title.innerText(),'系统设置');
 await page.locator('[data-ai-nav="global-reply"]').click();assert.equal(await page.locator('[name=replyGoal]').inputValue(),'移动端草稿：不应因返回丢失');
 await back.click();await page.locator('[data-ai-nav="provider"]').click();
 assert.equal(await back.getAttribute('aria-label'),'返回系统设置');await snap('04-models');await back.click();assert.equal(await title.innerText(),'系统设置');
 await page.locator('[data-ai-nav="default-style"]').click();
 assert.equal(await page.getByText('通过你的聊天素材，学习并建立默认的回复风格。',{exact:true}).isVisible(),true);
 await back.click();assert.equal(await title.innerText(),'系统设置');
 await nav('proactive');await snap('05-task-list');
 await page.locator('[data-proactive-filter-select]').selectOption('failed');
 assert.equal(await page.locator('[data-proactive-filter-select]').inputValue(),'failed');
 const layout=await page.evaluate(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return{filters:r('.ap-mobile-filter').bottom,heading:r('.ap-table-head').top,empty:r('.ap-empty').bottom,cleanup:r('.ap-task-cleanup').top};});
 assert.ok(layout.filters<=layout.heading+1);assert.ok(layout.cleanup>=layout.empty-1);
 assert.ok(await page.locator('.ap-task-cleanup').evaluate(n=>n.getBoundingClientRect().height<140),'List maintenance follows its content, not the old horizontal flex basis');
 await page.locator('[data-proactive-new]').click();assert.match(await title.innerText(),/新建/);await snap('06-task-editor');
 assert.match(await back.getAttribute('aria-label'),/返回任务列表/);await back.click();assert.equal(await title.innerText(),'主动聊天');
 for(const width of [320,375,639,640,768,860]){await page.setViewportSize({width,height:812});await nav('settings');await page.locator('[data-ai-nav="personal-info"]').click();await snap(`07-personal-${width}`);await back.click();assert.equal(await title.innerText(),'系统设置');}
 await page.setViewportSize({width:320,height:812});await nav('analysis');await page.locator('[data-ai-analysis-pick]').click();
 const picker=page.locator('.ai-contact-picker-dialog[open]');
 await picker.locator('[data-picker-all]').click();assert.match(await picker.locator('[data-picker-count]').innerText(),/3/);
 await picker.locator('[data-picker-clear]').click();assert.match(await picker.locator('[data-picker-count]').innerText(),/0/);
 await page.screenshot({path:path.join(out,'08-picker-320.png')});
 const pickerLayout=await picker.evaluate(n=>{const q=s=>n.querySelector(s).getBoundingClientRect();return{search:q('input[type=search]').width,all:q('[data-picker-all]'),clear:q('[data-picker-clear]')};});
 assert.ok(pickerLayout.search>=128);assert.ok(pickerLayout.all.height>=44&&pickerLayout.clear.height>=44);
 assert.ok(pickerLayout.all.right<=pickerLayout.clear.left,'Selection actions remain side by side with readable labels');
 await picker.press('Escape');await picker.waitFor({state:'hidden'});
 // App-bar return exits each root tab; bottom tabs perform peer navigation.
 await page.setViewportSize({width:375,height:812});
 for(const key of ['settings','proactive','activity','analysis','overview']){await nav(key);assert.equal(await back.getAttribute('aria-label'),'返回栖盒');await back.click();await page.locator('#ai-panel').waitFor({state:'hidden'});await page.locator('[data-mobile-ai-open]').first().click();await page.locator('#ai-panel').waitFor({state:'visible'});}
 await page.setViewportSize({width:1280,height:800});await nav('settings');await page.locator('[data-ai-nav="global-reply"]').click();
 assert.equal(await page.locator('.ai-mobile-navigation').isVisible(),false);assert.equal(await page.locator('.ai-page-heading [data-ai-nav="settings"]').isVisible(),true);
 assert.equal(f.provider.calls.length,calls);assert.deepEqual(report.errors,[]);
 report.checks=['single contextual return on mobile; desktop retains content return','nested parent navigation and explicit root exit','failed/unsaved draft retained across app-bar return','task filtering separated from list maintenance','44px hit target and uncropped titles at320/375/639/640/768/860','instance context visible','zero upstream generation or real delivery'];report.passed=true;
}catch(e){report.failure=e.stack;process.exitCode=1;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));await browser?.close();await f.close();console.log(JSON.stringify(report));}
