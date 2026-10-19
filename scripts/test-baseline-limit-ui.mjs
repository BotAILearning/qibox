import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, playwrightPath } from './tooling.mjs';
import { proactiveFixture } from './proactive-ui-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const f=await proactiveFixture(),out=path.join(root,'local/stable-baseline-20261019/legacy-limit-ui');await mkdir(out,{recursive:true});
const report={scope:'Isolated product with retained synthetic legacy value; no device config or real delivery',checks:[],passed:false};let browser,page;
try{
 await f.ai.setReplyOptions({contact:f.bridge.contacts[0].id,enabled:true});
 const profile=f.ai.profiles()[0];profile.replyStrategy={...profile.replyStrategy,maxRounds:'unlimited'};profile.rounds=13;await f.ai.save();
 const calls=f.provider.calls.length;
 browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:320,height:812}});page.setDefaultTimeout(6000);
 await page.goto(f.url);await page.locator('[data-mobile-ai-open]').click();await page.locator('[data-ai-object]').first().click();
 await page.getByText('旧上限：不限。自动回复已暂缓，请保存 1–2000 的有效上限后恢复。',{exact:true}).waitFor();
 for(const theme of ['light','dark']){await page.locator('html').evaluate((n,t)=>n.dataset.qiTheme=t,theme);await page.screenshot({path:path.join(out,`legacy-${theme}-320.png`)});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
 assert.equal(profile.replyStrategy.maxRounds,'unlimited');assert.equal(profile.rounds,13);
 await page.locator('[data-ai-reply-limit-custom]').fill('2001');await page.getByRole('button',{name:'保存设置',exact:true}).click();
 await page.getByText('回复次数上限须为 1–2000 的整数',{exact:true}).waitFor();assert.equal(profile.replyStrategy.maxRounds,'unlimited');
 await page.locator('[data-ai-reply-limit-custom]').fill('2000');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('设置已保存',{exact:true}).waitFor();
 assert.equal(profile.replyStrategy.maxRounds,2000);assert.equal(profile.rounds,13);assert.equal(f.ai.publicState().profiles[0].replyLimitNeedsReview,false);
 assert.equal(await page.getByText('旧上限：不限。自动回复已暂缓，请保存 1–2000 的有效上限后恢复。',{exact:true}).count(),0);
 await page.screenshot({path:path.join(out,'valid-save-dark-320.png')});
 assert.equal(f.provider.calls.length,calls);assert.equal(f.bridge.sent.length,0);
 report.checks=['320px light/dark legacy warning is visible without document overflow','Invalid save preserves legacy raw value and counter','Explicit valid save removes migration gate, keeps confirmed counter and makes no model/delivery request'];report.passed=true;
}catch(error){report.failure=error.stack;process.exitCode=1;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));await browser?.close();await f.close();console.log(JSON.stringify(report));}
