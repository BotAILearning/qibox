import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {root,playwrightPath} from './tooling.mjs';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath);
const out=path.resolve(root,process.argv[2]||'reports/ui030-navigation');
await fs.mkdir(out,{recursive:true});
const fixture=await proactiveFixture(), browser=await chromium.launch({channel:'msedge',headless:true});
const report={scope:'Real product UI/API, disposable fixture data; not NAS or physical phone',checks:[],errors:[],passed:false};
try {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(fixture.url);
  await page.locator('[data-action=open]').first().click();
  await page.locator('#ai-open').click();
  await page.setViewportSize({width:375,height:812});
  const menu=page.locator('.qibox-workspace-menu'), summary=menu.locator('summary');
  const wait=()=>page.waitForFunction(()=>document.querySelector('#ai-panel')?.getAttribute('aria-busy')!=='true');
  await menu.waitFor();
  assert.equal(await menu.getAttribute('open'),null);
  await summary.focus();await page.keyboard.press('Enter');
  await menu.locator('[data-ai-nav=settings]').click();await wait();
  assert.equal(await menu.getAttribute('open'),null);
  await assert.doesNotReject(()=>summary.waitFor({state:'visible'}));
  assert.equal(await summary.evaluate(n=>n===document.activeElement),true);
  await summary.click();await page.keyboard.press('Escape');
  assert.equal(await menu.getAttribute('open'),null);
  assert.equal(await page.locator('#ai-panel').isVisible(),true);
  assert.equal(await summary.evaluate(n=>n===document.activeElement),true);
  await summary.click();await page.locator('#ai-mobile-title').click({position:{x:2,y:8}});
  assert.equal(await menu.getAttribute('open'),null);
  report.keyboardEscapeAndOutsideClose=true;
  for(const key of ['overview','proactive','activity','analysis','settings']) {
    await summary.click();await menu.locator(`[data-ai-nav=${key}]`).click();await wait();
    assert.equal(await page.locator('#ai-panel').getAttribute('data-page'),key);
    assert.equal(await menu.getAttribute('open'),null);
  }
  report.allFiveDestinationsReachable=true;
  for(const [width,height]of [[1280,800],[1440,900],[375,812],[320,812],[639,812],[640,812]])for(const theme of ['light','dark']) {
    await page.setViewportSize({width,height});
    await page.locator('html').evaluate((n,t)=>n.dataset.qiTheme=t,theme);
    await page.waitForTimeout(500);
    if(width<640&&await menu.getAttribute('open')!==null)await summary.click();
    const closed=await page.evaluate(()=>{
      const panel=document.querySelector('#ai-panel'),menu=panel.querySelector('.qibox-workspace-menu'),summary=menu.querySelector('summary'),header=panel.querySelector('.ai-mobile-navigation'),title=panel.querySelector('#ai-mobile-title');
      const box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right};};
      return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,menuOpen:menu.open,summary:box(summary),header:box(header),title:box(title),bottomNav:!!panel.querySelector('.qbx-bottom-nav')};
    });
    assert.equal(closed.overflow,false);assert.equal(closed.bottomNav,false);
    const content=await page.locator('#ai-content').evaluate(n=>{const r=n.getBoundingClientRect();return{right:r.right,width:r.width,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth};});
    assert.ok(content.right<=width,JSON.stringify(content));assert.ok(content.scrollWidth<=content.clientWidth,JSON.stringify(content));
    if(width<640) {
      assert.equal(closed.menuOpen,false);assert.ok(closed.summary.height>=44&&closed.summary.width>=44);
      assert.ok(closed.title.right<=closed.summary.x);assert.ok(closed.header.height>=64);
    } else assert.equal(closed.menuOpen,true);
    await page.screenshot({path:path.join(out,`navigation-${width}-${theme}-closed.png`)});
    if(width<640) {
      await summary.click();
      await page.waitForFunction(t=>getComputedStyle(document.querySelector('.qibox-workspace-menu [aria-current=page]')).backgroundColor===(t==='dark'?'rgb(58, 58, 58)':'rgb(235, 235, 235)'),theme);
      await page.screenshot({path:path.join(out,`navigation-${width}-${theme}-open.png`)});
      const targets=await menu.locator('[data-ai-nav]').evaluateAll(ns=>ns.map(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n),t=getComputedStyle(n.querySelector('span'));return{height:r.height,width:r.width,right:r.right,text:n.textContent,color:s.color,textColor:t.color,background:s.backgroundColor};}));
      await fs.writeFile(path.join(out,`targets-${width}-${theme}.json`),JSON.stringify(targets,null,2));
      assert.equal(targets.length,5);for(const r of targets){assert.ok(r.height>=44&&r.width>=44,JSON.stringify(r));assert.ok(r.right<=width,JSON.stringify({width,...r}));}
      await page.keyboard.press('Escape');
    }
    report.checks.push({theme,height,...closed});
  }
  report.passed=report.errors.length===0;assert.ok(report.passed,JSON.stringify(report.errors));
} finally {await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close();await fixture.close();}
console.log(JSON.stringify({passed:report.passed,checks:report.checks.length}));
