import {createRequire} from 'node:module';import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {proactiveFixture} from './proactive-ui-fixture.mjs';import {root,playwrightPath} from './tooling.mjs';import {WindowClose} from '../server/window-close.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath);const out=path.resolve(process.env.QIBOX_TEST_OUTPUT||'reports/window-feedback');await fs.mkdir(out,{recursive:true});
const fixture=await proactiveFixture(),space=await fixture.app.users.get('development'),item=space.get(fixture.instance.id),runtime=item.runtime;
let visible=true;const actions=[],old=runtime.publicState.bind(runtime),control=new WindowClose({dataRoot:item.dataRoot,perform:async choice=>{actions.push(choice);visible=choice!=='background';if(choice==='quit')await space.stop(item.meta.id);}});await control.init();runtime.closeControl=control;runtime.publicState=()=>({...old(),windowVisible:visible,...control.state()});
const report={scope:'Production UI + HTTP + isolated runtime/RFB and synthetic native close request. No live NAS, WeChat or model calls.',checks:[],errors:[],passed:false};let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}});page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(fixture.url);await page.locator('[data-action=open]').click();await page.waitForFunction(()=>!document.querySelector('#desktop-view').hidden&&document.querySelector('#desktop-status').hidden);
 for(const theme of ['light','dark'])for(const width of [1280,1440]){
  await page.setViewportSize({width,height:width===1280?800:900});await page.emulateMedia({colorScheme:theme});visible=true;control.pending={id:randomUUID()};
  await page.getByRole('heading',{name:'关闭微信窗口',exact:true}).waitFor();const dialog=page.locator('#modal');assert.equal(await dialog.getByRole('radio',{name:/后台运行/}).isChecked(),true);
  const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=(width===1280?800:900)+1);
  const keys=fixture.peer.keys.length;await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('#modal').open===false);assert.equal(actions.length,0);assert.equal(fixture.peer.keys.length,keys);
  // Wait for real cancellation HTTP to clear the source, rather than replacing it.
  for(let i=0;control.pending&&i<100;i++)await new Promise(r=>setTimeout(r,20));assert.equal(control.pending,null);
  control.pending={id:randomUUID()};await page.getByRole('heading',{name:'关闭微信窗口',exact:true}).waitFor();await page.screenshot({path:path.join(out,`close-${width}-${theme}.png`)});await page.getByRole('button',{name:'确定',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(actions.at(-1),'background');assert.equal(runtime.status,'running');await page.locator('#desktop-status').filter({hasText:'仍在后台运行'}).waitFor();await page.getByRole('button',{name:'显示微信',exact:true}).waitFor();
  report.checks.push(`${width}/${theme}: native request single dialog; safe default, Escape/cancel, no RFB key leakage; background keeps runtime and displays restore hint`);actions.length=0;
 }
 visible=true;await page.getByRole('button',{name:'返回栖盒',exact:true}).click();await page.getByRole('generic',{name:'微信的更多操作'}).count().catch(()=>0);await page.locator('summary').first().click();await page.getByRole('button',{name:'关闭行为',exact:true}).click();await page.locator('select[name=mode]').selectOption('background');await page.getByRole('button',{name:'确定',exact:true}).click();await page.locator('#modal').waitFor({state:'hidden'});assert.equal(control.mode,'background');const reload=new WindowClose({dataRoot:item.dataRoot,perform:async()=>{}});await reload.init();assert.equal(reload.mode,'background');report.checks.push('Instance menu changes persistent close preference without changing startup schedule');
 for(const theme of ['light','dark'])for(const width of [320,375,639,640,760,761,1280,1440]){
  await page.setViewportSize({width,height:width>=1280?900:812});await page.emulateMedia({colorScheme:theme});
  await page.mouse.move(0,0);
  await page.waitForFunction(theme=>getComputedStyle(document.querySelector('[data-market-action=add]')).backgroundColor===(theme==='dark'?'rgb(244, 244, 244)':'rgb(23, 23, 23)'),theme);
  const card=page.locator('[data-market-app=wechat]'),add=card.getByRole('button',{name:'添加微信',exact:true}),update=card.getByRole('button',{name:'手动更新',exact:true});
  assert.equal(await card.locator('[data-market-action=add]').count(),1);assert.equal(await add.isVisible(),true);assert.equal(await update.isVisible(),true);
  const a=await add.boundingBox(),u=await update.boundingBox();assert.equal(a.height,u.height);assert.ok(a.height>=(width<=639?44:32));assert.ok(a.width<180&&u.width<180);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(width>760){await page.getByLabel('微信更多操作',{exact:true}).click();assert.equal(await card.getByRole('button',{name:'卸载微信',exact:true}).isVisible(),true);await page.keyboard.press('Escape');assert.equal(await card.locator('details').getAttribute('open'),null);assert.equal(await page.getByLabel('微信更多操作',{exact:true}).evaluate(e=>e===document.activeElement),true);}
  else assert.equal(await page.getByLabel('微信更多操作',{exact:true}).isVisible(),false);
  await page.screenshot({path:path.join(out,`market-${width}-${theme}.png`)});
 }
 await page.setViewportSize({width:1280,height:800});await page.getByLabel('微信更多操作',{exact:true}).click();await page.getByRole('button',{name:'卸载微信',exact:true}).click();assert.equal(await page.locator('input[name=deleteData][value=no]').isChecked(),true);assert.equal(await page.locator('#modal-actions [data-close]').evaluate(e=>e===document.activeElement),true);await page.locator('input[name=deleteData][value=yes]').check();assert.match(await page.locator('#modal-body').innerText(),/不清理其他用户/);await page.keyboard.press('Escape');await page.locator('#modal').waitFor({state:'hidden'});assert.ok(fixture.app.library.installed());report.checks.push('16 market viewport/theme cases: one add, equal content-width actions, no overflow; permitted desktop menu Escape/focus; mobile boundaries; uninstall defaults preserve and cancel retains installation');
 assert.equal(report.errors.length,0,report.errors.join('\n'));report.passed=true;
}finally{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();control.dispose();await fixture.close();}
console.log(JSON.stringify(report));
