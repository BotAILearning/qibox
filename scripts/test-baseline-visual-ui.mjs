import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, playwrightPath } from './tooling.mjs';
import { proactiveFixture } from './proactive-ui-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const f = await proactiveFixture(), out = path.resolve(root, process.argv[2] || 'local/stable-baseline-20261019/visual');
await mkdir(out, { recursive: true });
const report = { scope: 'Production product bundle with isolated fixtures; screenshots require separate human inspection; no device/phone claim', shots: [], geometry: [], errors: [], passed: false };
let browser, page;
const widths = [[1280,800],[1440,900],[375,812],[320,812]];
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width:1280, height:800 } });
  page.setDefaultTimeout(8000); page.on('pageerror', e => report.errors.push(e.message));
  const capture = async name => {
    for (const [width,height] of widths) for (const theme of ['light','dark']) {
      await page.setViewportSize({width,height});
      await page.locator('html').evaluate((n,t) => n.dataset.qiTheme=t,theme);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(100);
      const file = `${name}-${width}-${theme}.png`;
      await page.screenshot({path:path.join(out,file)});
      const geometry = await page.evaluate(() => ({
        width:innerWidth, scrollWidth:document.documentElement.scrollWidth,
        controls:[...document.querySelectorAll('button.qi-btn,input.qi-input,input.qi-switch')].filter(n=>n.getClientRects().length).slice(0,40).map(n=>({label:n.getAttribute('aria-label')||n.textContent||n.name,w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height})),
        colors:['body','#ai-panel','.ai-page-body','.ai-analysis-request','.ai-reference-reply-main'].map(selector=>{const n=document.querySelector(selector);if(!n)return null;const s=getComputedStyle(n);return{selector,color:s.color,background:s.backgroundColor,surface:s.getPropertyValue('--qi-surface'),qbx:s.getPropertyValue('--qbx-surface'),text:s.getPropertyValue('--qi-text')};}),
        lowContrast:(()=>{
          const rgb=value=>(value.match(/[\d.]+/g)||[]).map(Number);
          const luminance=v=>v.slice(0,3).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((a,x,i)=>a+x*[.2126,.7152,.0722][i],0);
          const bad=[],seen=new Set(),scope=document.querySelector('dialog[open]')||document.querySelector('#ai-panel:not([hidden])')||document.body,walker=document.createTreeWalker(scope,NodeFilter.SHOW_TEXT);
          for(let text=walker.nextNode();text;text=walker.nextNode()){
            const n=text.parentElement;if(!text.textContent.trim()||n.closest('script,style,svg,[aria-hidden=true],:disabled,[aria-disabled=true]'))continue;
            const range=document.createRange();range.selectNodeContents(text);const r=range.getBoundingClientRect(),s=getComputedStyle(n);
            if(!n.checkVisibility()||!r.width||!r.height||r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth||s.visibility==='hidden')continue;
            const closed=n.closest('details:not([open])');if(closed&&!closed.querySelector(':scope > summary')?.contains(n))continue;
            const hit=document.elementFromPoint(Math.min(innerWidth-1,Math.max(0,r.left+r.width/2)),Math.min(innerHeight-1,Math.max(0,r.top+r.height/2)));
            if(!hit||!(n===hit||n.contains(hit)||hit.contains(n)))continue;
            let bg=null,gradient=false;
            for(let p=n;p;p=p.parentElement){const cs=getComputedStyle(p),v=rgb(cs.backgroundColor);if(cs.backgroundImage!=='none'){gradient=true;break;}if(v.length>=3&&(v.length===3||v[3]===1)){bg=v;break;}}
            if(!bg||gradient)continue;const fg=rgb(s.color);if(fg.length<3)continue;
            const a=luminance(fg),b=luminance(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05),large=parseFloat(s.fontSize)>=24||(parseFloat(s.fontSize)>=18.66&&parseFloat(s.fontWeight)>=700),glyph=/^[•⋯×＋←→]+$/.test(text.textContent.trim()),minimum=large||glyph?3:4.5;
            const key=[s.color,bg.join(','),text.textContent.trim()].join('|');if(ratio+.01<minimum&&!seen.has(key)){seen.add(key);bad.push({text:text.textContent.trim().slice(0,70),selector:n.id||n.className||n.tagName,ratio,minimum,foreground:s.color,background:bg});}
          }
          return bad;
        })(),
      }));
      report.shots.push(file); report.geometry.push({file,...geometry});
      assert.ok(geometry.scrollWidth<=width+1, `${file}: no document horizontal overflow`);
    }
    await page.setViewportSize({width:1280,height:800});
  };
  await page.goto(f.url); await page.locator('[data-instance]').first().waitFor();
  await capture('01-home');
  await page.locator('#add-instance').click(); await capture('02-instance-dialog');
  await page.locator('#modal').press('Escape');
  await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click();
  const nav = async key => page.locator(`[data-ai-nav="${key}"]`).first().click();
  await capture('03-object-list');
  await page.locator('[data-ai-object]').first().click(); await capture('04-object-detail');
  const memory=page.locator('[data-ai-object-section=memory]');
  if(await memory.count()){await memory.click();await capture('05-memory');}
  await nav('settings'); await capture('06-settings');
  await page.locator('[data-ai-optional=global-rhythm] summary').click(); await capture('07-settings-rhythm');
  for(const [key,name] of [['global-reply','08-global-strategy'],['personal-info','09-personal-information'],['default-style','10-default-style'],['provider','11-models']]) {
    await nav('settings'); await nav(key); await capture(name);
  }
  await nav('proactive'); await capture('12-proactive-list');
  const create=page.locator('[data-proactive-new]'); if(await create.count()){await create.click();await capture('13-proactive-editor');}
  await nav('activity'); await capture('14-execution-records');
  await nav('analysis'); await capture('15-analysis');
  const picker=page.locator('[data-ai-analysis-pick]'); if(await picker.count()){await picker.click();await capture('16-contact-picker');await page.locator('dialog[open]').press('Escape');}
  assert.deepEqual(report.errors,[]); report.passed=true;
} catch(error){report.failure=error.stack;process.exitCode=1;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));await browser?.close();await f.close();console.log(JSON.stringify({passed:report.passed,shots:report.shots.length,failure:report.failure}));}
