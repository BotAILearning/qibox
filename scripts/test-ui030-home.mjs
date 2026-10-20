import {createRequire} from 'node:module';import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {root,playwrightPath} from './tooling.mjs';import {proactiveFixture} from './proactive-ui-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath),out=path.resolve(root,process.argv[2]||'reports/ui030-home');await fs.mkdir(out,{recursive:true});
const f=await proactiveFixture(),browser=await chromium.launch({channel:'msedge',headless:true}),report={scope:'Actual product home, existing menus/dialogs with disposable fixtures; no NAS, phone, account or delivery claim',checks:[],passed:false};
try {
 const page=await browser.newPage();await page.goto(f.url);
 const check=async(name,width,height,theme)=>{const state=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,dialogs:[...document.querySelectorAll('dialog[open]')].map(n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom};})}));assert.equal(state.overflow,false);for(const d of state.dialogs){assert.ok(d.left>=0&&d.right<=width&&d.top>=0&&d.bottom<=height,JSON.stringify(d));}await page.screenshot({path:path.join(out,`${name}-${width}-${theme}.png`)});report.checks.push({name,width,height,theme,...state});};
 for(const [width,height]of [[1280,800],[1440,900],[375,812],[320,812]])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await page.locator('html').evaluate((n,t)=>n.dataset.qiTheme=t,theme);await page.waitForTimeout(200);await check('home',width,height,theme);
  const menu=page.locator('.app-menu:visible').first();await menu.locator('summary').click();
  const menuState=await menu.locator('.qi-floating__content').evaluate(n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,background:getComputedStyle(n).backgroundColor,buttons:[...n.querySelectorAll('button')].map(b=>({label:b.textContent,color:getComputedStyle(b).color,height:b.getBoundingClientRect().height}))};});
  await fs.writeFile(path.join(out,`menu-${width}-${theme}.json`),JSON.stringify(menuState,null,2));await check('instance-menu',width,height,theme);
  assert.ok(menuState.left>=0&&menuState.right<=width,JSON.stringify({width,...menuState}));assert.equal(menuState.background,theme==='dark'?'rgb(38, 38, 38)':'rgb(255, 255, 255)');assert.ok(menuState.buttons.every(b=>b.height>=(width<640?44:32)));
  await menu.locator('summary').press('Escape');assert.equal(await menu.getAttribute('open'),null);assert.equal(await menu.locator('summary').evaluate(n=>n===document.activeElement),true);
  await page.locator('#about-qibox').click();await page.locator('#modal[open]').waitFor();
  const link=await page.locator('#modal-body a').evaluate(n=>({color:getComputedStyle(n).color,brand:getComputedStyle(n).getPropertyValue('--qi-primary').trim()}));assert.equal(link.color,theme==='dark'?'rgb(155, 188, 255)':'rgb(64, 88, 211)');await check('about',width,height,theme);await page.locator('#modal').press('Escape');
  await menu.locator('summary').click();const startup=menu.getByRole('button',{name:'启动设置',exact:true});
  if(await startup.count()){await startup.click();await page.locator('#modal[open]').waitFor();await check('startup-settings',width,height,theme);await page.locator('#modal').press('Escape');}else await menu.locator('summary').press('Escape');
 }
 report.passed=true;
}catch(e){report.failure=e.stack;throw e;}finally{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close();await f.close();}
console.log(JSON.stringify({passed:report.passed,checks:report.checks.length}));
